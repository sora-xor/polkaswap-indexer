/** Exact Pi COW qualification; never coerces it into the MOF2 ordinary-copy proof. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseStoredSoraChainState } from './soraIdentity.js';
import { INDEXER_COLLECTIONS, type IndexerDocument, type IndexerRepository } from './repository/types.js';
import { buildStatsRecoverySeedRows } from './stats-recovery-admission.js';
import { STATS_ADMISSION_ID, STATS_CURSOR_ID, STATS_RECONCILIATION_ID, requireStatsVolumeRepair,
  statsEvidenceDigest, validateStatsRecoveryAdmission, type StatsRecoveryAdmission } from './stats-recovery.js';

const BASE = '/Users/administrator/apps/pi-indexer-recovery-20261009';
export const PI_STATS_SOURCE_DATABASE = `${BASE}/restores/pi-canonical-prefix-20261101-return-01`;
export const PI_STATS_DATABASE = `${BASE}/restores/pi-stats-history-private-20261101`;
export const PI_STATS_PINS = Object.freeze({
  databaseFiles: '987715ca7ca04e77f4dd78d87aacf70a5c762d745e293f953deb5cbadb9ac8c6',
  nativeAudit: '786455fba448810322010a84badc80e4f1a122da3b683cbcee397ec09db96c1f',
  sourceCompletion: '6d0618532b04d9cfa4f3e2a0687d3798b7955ace84e553125200e561f43315a4',
  piCow: 'eef09d60a40d43b6fad725ab702a0c2942ead1503800845c7ac554b55db00482',
  piNativeExecutor: '650d350b22371d2795f0cb43b08f175d269feb39d625cec2743ce4d2910c35a6',
  piReady: '41c72841be3c8fb12cbc5cd2df151998792c1308ead4c469265b94cd70c348d3',
  mofNormalizedExecutor: 'c9b959cfd6361814780d135edf2584cdf14e6879f3424a240eb8016d038597f9',
  normalizedBefore: '388270a3ab2f31ec0113116264761eb86b52ff1965a02fa078010bd82e314ada',
  normalizedDocuments: '1497ab33d6e532a458d4c825ecf5401ea703a75f363606f8d9905cfbd3286c7e',
  volumeRepair: '28ddafd9e177edb13f9b588e293ba7913f6509ab787a4a1d5ddcc4a145e8e169',
});

/** Raw immutable proof bytes retain their original host/path and scan claims. */
export type PiStatsQualificationBytes = {
  databaseFiles: Uint8Array; nativeAudit: Uint8Array; executorReceipt: Uint8Array;
  piCow: Uint8Array; piNativeExecutor: Uint8Array; piReady: Uint8Array;
  mofNormalizedExecutor: Uint8Array; normalizedBefore: Uint8Array;
};
function need(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Pi stats qualification: ${message}`);
}
function object(value: unknown): Record<string, unknown> {
  need(value && typeof value === 'object' && !Array.isArray(value), 'expected object');
  return value as Record<string, unknown>;
}
function pinned(bytes: Uint8Array, pin: string, canonical = false): Record<string, unknown> {
  need(bytes.byteLength > 0 && bytes.byteLength <= 16 * 1024 * 1024 &&
    createHash('sha256').update(bytes).digest('hex') === pin, 'evidence byte pin/bound mismatch');
  const value = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  need(!canonical || Buffer.from(JSON.stringify(value)).equals(Buffer.from(bytes)), 'noncanonical qualification receipt');
  return value;
}

/** Build only a provenance document; this performs no scan, initialization or approval. */
export function piStatsQualificationDocument(admissionInput: StatsRecoveryAdmission) {
  const admission = validateStatsRecoveryAdmission(admissionInput);
  need(admission.databasePath === PI_STATS_DATABASE && admission.sourceDatabasePath === PI_STATS_SOURCE_DATABASE,
    'unreviewed Pi source/candidate paths');
  return { schema: 'sora-nexus-pi-stats-initialization-qualification-v1',
    sourceDatabasePath: PI_STATS_SOURCE_DATABASE, databasePath: PI_STATS_DATABASE, prefix: admission.prefix,
    sourceQualification: { databaseFilesSha256: PI_STATS_PINS.databaseFiles, nativeAuditSha256: PI_STATS_PINS.nativeAudit,
      completionReceiptSha256: PI_STATS_PINS.sourceCompletion },
    piCowReceiptSha256: PI_STATS_PINS.piCow, piSourceNativeExecutorSha256: PI_STATS_PINS.piNativeExecutor,
    piSourceReadySha256: PI_STATS_PINS.piReady, mofNormalizedExecutorSha256: PI_STATS_PINS.mofNormalizedExecutor,
    normalizedBeforeSha256: PI_STATS_PINS.normalizedBefore, normalizedDocumentsSha256: PI_STATS_PINS.normalizedDocuments,
    volumeRepairMarkerSha256: PI_STATS_PINS.volumeRepair, files: 499, logicalBytes: 18_786_660_488,
    copyMechanism: 'apfs-fclonefileat-cow', sourceAccessMode: 'active-qualified-readonly-api-plus-parent-posix-lock',
    nativeValidationMode: 'inherited-pi-source-audit-via-exact-bytes',
    normalizedValidationMode: 'inherited-mof2-scan-via-exact-bytes',
    normalizedScanExecutedOnPi: false, sourceServiceStopped: false, entitlementsReady: false, productionChanged: false };
}

/** Validate every exact Pi/MOF2 proof without manufacturing a Pi pre-scan or stopped source. */
export function validatePiStatsQualification(admissionInput: StatsRecoveryAdmission, bytes: PiStatsQualificationBytes) {
  const admission = validateStatsRecoveryAdmission(admissionInput);
  const expected = piStatsQualificationDocument(admission);
  need(admission.qualification.databaseFilesSha256 === PI_STATS_PINS.databaseFiles &&
    admission.qualification.nativeAuditSha256 === PI_STATS_PINS.nativeAudit &&
    admission.qualification.volumeRepairMarkerSha256 === PI_STATS_PINS.volumeRepair, 'qualified source pins differ');
  const receipt = pinned(bytes.executorReceipt, admission.qualification.executorReceiptSha256, true);
  need(isDeepStrictEqual(receipt, expected), 'Pi qualification scope/provenance differs');
  const files = pinned(bytes.databaseFiles, PI_STATS_PINS.databaseFiles);
  const native = pinned(bytes.nativeAudit, PI_STATS_PINS.nativeAudit);
  const cow = pinned(bytes.piCow, PI_STATS_PINS.piCow);
  const piNative = pinned(bytes.piNativeExecutor, PI_STATS_PINS.piNativeExecutor);
  pinned(bytes.piReady, PI_STATS_PINS.piReady);
  const mof = pinned(bytes.mofNormalizedExecutor, PI_STATS_PINS.mofNormalizedExecutor);
  const before = pinned(bytes.normalizedBefore, PI_STATS_PINS.normalizedBefore);
  need(cow.schema === 'sora-nexus-pi-stats-cow-byte-clone-v1' && cow.sourceDatabasePath === PI_STATS_SOURCE_DATABASE &&
    cow.databasePath === PI_STATS_DATABASE && cow.sourceFilesSha256 === PI_STATS_PINS.databaseFiles &&
    cow.sourceNativeAuditSha256 === PI_STATS_PINS.nativeAudit && cow.sourceNativeExecutorSha256 === PI_STATS_PINS.piNativeExecutor &&
    cow.piSourceReadySha256 === PI_STATS_PINS.piReady && cow.copyMechanism === expected.copyMechanism &&
    cow.sourceAccessMode === expected.sourceAccessMode && cow.files === 499 && cow.logicalBytes === 18_786_660_488,
  'actual Pi COW source/scope differs');
  for (const key of ['sourceLockHeldThroughout', 'allSourceBytesAndPosixMetadataUnchanged', 'allTargetBytesMatch',
    'allTargetInodesIndependent', 'allTargetNlinkOne', 'sourceReadOnlyApiUnchanged', 'workerReaped', 'workerParentVerifiedEveryTick']) {
    need(cow[key] === true, `missing actual Pi ${key}`);
  }
  for (const key of ['copyFallbackUsed', 'nativeDbOpened', 'normalizedScanPerformed', 'initializerRun',
    'servicesChanged', 'candidatePromotionReady', 'entitlementsReady', 'suffixWorkingBudgetProved']) {
    need(cow[key] === false, `incorrect Pi ${key} claim`);
  }
  need(piNative.database === PI_STATS_SOURCE_DATABASE && piNative.nativeOutputSha256 === PI_STATS_PINS.nativeAudit &&
    piNative.beforeManifestSha256 === piNative.afterManifestSha256 && piNative.exitCode === 0 &&
    piNative.readOnly === true && piNative.allNativeFieldsMatchSource === true && piNative.heldPosixLockDuringAudit === true &&
    piNative.servicesChanged === false, 'actual Pi source-native proof differs');
  need(mof.schema === 'sora-nexus-stats-history-clone-qualification-v1' &&
    mof.sourceDatabasePath === '/data/polkaswap-indexer-recovery-20261101/legacy-db' &&
    mof.databasePath === '/data/pi-indexer-stats-history-trial-20261101/candidate.rocksdb' &&
    mof.databaseFilesSha256 === PI_STATS_PINS.databaseFiles && mof.nativeAuditSha256 === PI_STATS_PINS.nativeAudit &&
    mof.normalizedBeforeSha256 === PI_STATS_PINS.normalizedBefore && mof.normalizedScanExecutedOnClone === true &&
    before.database === mof.databasePath && before.readOnly === true && before.normalizedScanExecutedOnClone === true &&
    before.schema === 'sora-nexus-normalized-prefix-v1' && before.phase === 'before' && before.sourceDocuments === 27_428_271 &&
    before.normalizedDocumentsSha256 === PI_STATS_PINS.normalizedDocuments &&
    before.volumeRepairMarkerSha256 === PI_STATS_PINS.volumeRepair &&
    statsEvidenceDigest(before.volumeRepairMarker) === PI_STATS_PINS.volumeRepair &&
    isDeepStrictEqual(before.seedRows, {}), 'genuine inherited MOF2 normalized proof differs');
  let logicalBytes = 0;
  for (const [name, raw] of Object.entries(files)) {
    const row = object(raw);
    need(/^[A-Za-z0-9_.-]+$/.test(name) && name !== '.' && name !== '..' &&
      Object.keys(row).sort().join(',') === 'sha256,size' && Number.isSafeInteger(row.size) && Number(row.size) >= 0 &&
      typeof row.sha256 === 'string' && /^[a-f0-9]{64}$/.test(row.sha256), 'invalid exact file map');
    logicalBytes += Number(row.size); need(Number.isSafeInteger(logicalBytes), 'file size overflow');
  }
  need(Object.keys(files).length === 499 && logicalBytes === 18_786_660_488, 'incomplete exact file map');
  const checkpoint = { lastIndexedBlock: admission.prefix.block, blockHash: admission.prefix.hash,
    blockTimestamp: admission.prefix.timestamp, genesisHash: admission.prefix.genesisHash };
  const collections = object(native.collections);
  need(Object.entries(collections).every(([name, count]) => INDEXER_COLLECTIONS.includes(name as never) &&
    Number.isSafeInteger(count) && Number(count) >= 0) &&
    Object.values(collections).reduce<number>((sum, count) => sum + Number(count), 0) === 27_428_271 &&
    isDeepStrictEqual(collections, before.sourceCollections) && native.documents === 27_428_271 &&
    native.blocks === 2_133_341 && native.replayBlocks === 165_073 && native.replayTransactions === '2225' &&
    native.replayVolumeUsdScale8 === '2721075196855' && native.readOnly === true && native.indexValidationPassed === true &&
    native.maxBlock === admission.prefix.block && native.maxBlockSnapshot === admission.prefix.block &&
    isDeepStrictEqual(native.checkpoint, checkpoint), 'native identity/counters or inherited normalized counts differ');
  return { admission, files, native, receipt, checkpoint, normalizedBefore: before };
}

/** Verify actual candidate state before deriving the same three shared seed rows. */
export async function preparePiStatsRecoverySeed(repository: Pick<IndexerRepository, 'get'>,
  admission: StatsRecoveryAdmission, bytes: PiStatsQualificationBytes): Promise<IndexerDocument[]> {
  const proof = validatePiStatsQualification(admission, bytes);
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
