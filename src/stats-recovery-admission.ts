import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { parseStoredSoraChainState } from './soraIdentity.js';
import { INDEXER_COLLECTIONS, type IndexerDocument, type IndexerRepository } from './repository/types.js';
import { STATS_ADMISSION_ID, STATS_CURSOR_ID, STATS_RECONCILIATION_ID, requireStatsVolumeRepair,
  statsEvidenceDigest, statsReconciliationPending, validateStatsRecoveryAdmission, type StatsRecoveryAdmission } from './stats-recovery.js';

/** Exact separately retained executor outputs; this function does not copy or open a database. */
export type StatsQualificationBytes = { databaseFiles: Uint8Array; nativeAudit: Uint8Array; executorReceipt: Uint8Array };
const SHA = /^[a-f0-9]{64}$/;
const SOURCE = {
  databaseFilesSha256: '987715ca7ca04e77f4dd78d87aacf70a5c762d745e293f953deb5cbadb9ac8c6',
  nativeAuditSha256: '786455fba448810322010a84badc80e4f1a122da3b683cbcee397ec09db96c1f',
  completionReceiptSha256: '6d0618532b04d9cfa4f3e2a0687d3798b7955ace84e553125200e561f43315a4',
};
function need(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Stats clone qualification: ${message}`);
}
function object(value: unknown): Record<string, unknown> {
  need(value && typeof value === 'object' && !Array.isArray(value), 'expected an object');
  return value as Record<string, unknown>;
}
function pinned(bytes: Uint8Array, sha256: string): Record<string, unknown> {
  need(bytes.byteLength > 0 && bytes.byteLength <= 16 * 1024 * 1024 &&
    createHash('sha256').update(bytes).digest('hex') === sha256, 'evidence byte pin/bound mismatch');
  return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
}

/** Validate the actual offline executor's copy/native proof before any initializer obtains a writer. */
export function validateStatsCloneQualification(admissionInput: StatsRecoveryAdmission, bytes: StatsQualificationBytes) {
  const admission = validateStatsRecoveryAdmission(admissionInput);
  const files = pinned(bytes.databaseFiles, admission.qualification.databaseFilesSha256);
  const native = pinned(bytes.nativeAudit, admission.qualification.nativeAuditSha256);
  const receipt = pinned(bytes.executorReceipt, admission.qualification.executorReceiptSha256);
  const checkpoint = { lastIndexedBlock: admission.prefix.block, blockHash: admission.prefix.hash,
    blockTimestamp: admission.prefix.timestamp, genesisHash: admission.prefix.genesisHash };
  need(receipt.schema === 'sora-nexus-stats-history-clone-qualification-v1' &&
    receipt.sourceDatabasePath === admission.sourceDatabasePath && receipt.databasePath === admission.databasePath &&
    isDeepStrictEqual(receipt.prefix, admission.prefix) && isDeepStrictEqual(receipt.sourceQualification, SOURCE) &&
    receipt.databaseFilesSha256 === admission.qualification.databaseFilesSha256 &&
    receipt.nativeAuditSha256 === admission.qualification.nativeAuditSha256 &&
    receipt.volumeRepairMarkerSha256 === admission.qualification.volumeRepairMarkerSha256 &&
    receipt.nativeValidationMode === 'inherited-exact-source-bytes' &&
    receipt.exhaustiveNativeExecutedOnClone === false && receipt.normalizedScanExecutedOnClone === true &&
    receipt.nativeExitCode === 0 && receipt.entitlementsReady === false && receipt.productionChanged === false,
  'executor target, source, scope or evidence binding differs');
  for (const key of ['sourceStopped', 'sourceLockHeldDuringCopy', 'sourceFilesUnchanged', 'targetFilesMatchSource',
    'targetIndependentInodes', 'nativeReadOnly', 'nativeBeforeAfterFilesUnchanged', 'nativeOutputMatchesSource']) {
    need(receipt[key] === true, `missing ${key} proof`);
  }
  let logicalBytes = 0;
  for (const [name, raw] of Object.entries(files)) {
    need(name !== '.' && name !== '..' && /^[A-Za-z0-9_.-]+$/.test(name), 'unsafe database filename');
    const row = object(raw);
    need(Object.keys(row).sort().join(',') === 'sha256,size' && Number.isSafeInteger(row.size) && Number(row.size) >= 0 &&
      typeof row.sha256 === 'string' && SHA.test(row.sha256), 'invalid database file manifest');
    logicalBytes += Number(row.size);
    need(Number.isSafeInteger(logicalBytes), 'database byte total overflow');
  }
  need(Object.keys(files).length === 499 && receipt.files === 499 && logicalBytes === 18_786_660_488 &&
    receipt.logicalBytes === logicalBytes && admission.qualification.databaseFilesSha256 === SOURCE.databaseFilesSha256,
  'complete retained source file set is required');
  const collections = object(native.collections);
  need(Object.entries(collections).every(([name, count]) => INDEXER_COLLECTIONS.includes(name as never) &&
    Number.isSafeInteger(count) && Number(count) >= 0) &&
    Object.values(collections).reduce<number>((sum, count) => sum + Number(count), 0) === native.documents &&
    native.documents === 27_428_271 && native.blocks === 2_133_341 && native.replayBlocks === 165_073 &&
    native.replayTransactions === '2225' && native.replayVolumeUsdScale8 === '2721075196855' &&
    native.readOnly === true && native.indexValidationPassed === true && native.maxBlock === admission.prefix.block &&
    native.maxBlockSnapshot === admission.prefix.block && isDeepStrictEqual(native.checkpoint, checkpoint) &&
    admission.qualification.nativeAuditSha256 === SOURCE.nativeAuditSha256,
  'native prefix identity, counters or exact source output differs');
  return { admission, files, native, receipt, checkpoint };
}

/**
 * Prepare only three seed rows after the executor has verified the private clone.
 * The caller owns exclusive writable admission and commits this entire list once.
 * No existing classification, recovery journal or checkpoint is modified.
 */
export async function prepareStatsRecoverySeed(repository: Pick<IndexerRepository, 'get'>,
  admission: StatsRecoveryAdmission, bytes: StatsQualificationBytes): Promise<IndexerDocument[]> {
  const proof = validateStatsCloneQualification(admission, bytes);
  for (const id of [STATS_ADMISSION_ID, STATS_CURSOR_ID, STATS_RECONCILIATION_ID,
    'burnRecoveryIdentity-v1', 'soratopiaRecoveryContinuity-v1', 'soratopiaRecoveryProjection-v1']) {
    need(!(await repository.get('updatesStreams', id)), 'candidate already carries recovery classification');
  }
  await requireStatsVolumeRepair(repository, admission);
  const stateRow = await repository.get('updatesStreams', 'chainState');
  const state = parseStoredSoraChainState(typeof stateRow?.data.data === 'string' ? JSON.parse(stateRow.data.data) : null);
  const identityRow = await repository.get('updatesStreams', 'chainIdentity');
  need(isDeepStrictEqual(state, proof.checkpoint) && stateRow?.blockHeight === admission.prefix.block &&
    stateRow.data.id === 'chainState' && stateRow.data.block === admission.prefix.block &&
    isDeepStrictEqual(identityRow?.data, proof.native.identity), 'candidate checkpoint/identity differs from native qualification');
  const block = await repository.get('networkSnapshots', `block-${admission.prefix.block}`);
  need(block?.blockHeight === admission.prefix.block && block.timestamp === admission.prefix.timestamp &&
    block.data.id === block.id && block.data.type === 'BLOCK' && block.data.timestamp === admission.prefix.timestamp,
  'candidate canonical BLOCK row is missing');
  return buildStatsRecoverySeedRows(admission);
}

/** Construct only the three seed rows; callers must first verify their exact host qualification and state. */
export function buildStatsRecoverySeedRows(admissionInput: StatsRecoveryAdmission): IndexerDocument[] {
  const admission = validateStatsRecoveryAdmission(admissionInput);
  return [
    { collection: 'updatesStreams', id: STATS_ADMISSION_ID, blockHeight: admission.prefix.block, timestamp: null,
      data: { id: STATS_ADMISSION_ID, admission, admissionDigest: statsEvidenceDigest(admission) } },
    { collection: 'updatesStreams', id: STATS_CURSOR_ID, blockHeight: admission.prefix.block, timestamp: null,
      data: { id: STATS_CURSOR_ID, admissionDigest: statsEvidenceDigest(admission), block: admission.prefix.block,
        hash: admission.prefix.hash, blockTimestamp: admission.prefix.timestamp, entitlementsReady: false } },
    statsReconciliationPending(admission, admission.prefix.block, admission.prefix.hash),
  ];
}
