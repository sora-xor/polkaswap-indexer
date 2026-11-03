import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ATTACKER_ACCOUNT, RECOVERY_CHECKPOINT } from '../src/burn-recovery.js';
import { PRE_FORK_HISTORY_HOLD_CHECKPOINT } from '../src/recovery-hold.js';
import { MemoryRepository } from '../src/repository/memory.js';
import type { IndexerDocument } from '../src/repository/types.js';
import { SORA_MAINNET_GENESIS_HASH } from '../src/soraIdentity.js';
import { buildStatsRecoverySeedRows, validateStatsCloneQualification } from '../src/stats-recovery-admission.js';
import { STATS_ADMISSION_ID, STATS_CURSOR_ID, STATS_RECONCILIATION_ID, requireStatsRecoveryState,
  type StatsRecoveryAdmission } from '../src/stats-recovery.js';
import { PI_STATS_DATABASE, PI_STATS_SOURCE_DATABASE, PI_STATS_PINS, piStatsQualificationDocument,
  preparePiStatsRecoverySeed, validatePiStatsQualification, type PiStatsQualificationBytes } from '../src/pi-stats-recovery-admission.js';
import { initializeStatsRecovery } from '../src/scripts/initialize-stats-recovery.js';
import { initializePiStatsRecovery } from '../src/scripts/initialize-pi-stats-recovery.js';

const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const sha = (raw: Uint8Array) => createHash('sha256').update(raw).digest('hex');
const file = (name: string) => readFile(new URL(`./fixtures/pi-stats-qualification/${name}`, import.meta.url));
const retained = { databaseFiles: await file('database-files.json'), nativeAudit: await file('source-native.json'),
  piCow: await file('pi-cow.json'), piNativeExecutor: await file('pi-source-native-executor.json'), piReady: await file('pi-source-ready.json'),
  mofNormalizedExecutor: await file('mof-normalized-executor.json'), normalizedBefore: await file('mof-normalized-before.json') };
function qualified() {
  const admission: StatsRecoveryAdmission = { schema: 'sora-nexus-canonical-stats-history-v1', approvedForStatsHistory: true,
    entitlementsReady: false, sourceDatabasePath: PI_STATS_SOURCE_DATABASE, databasePath: PI_STATS_DATABASE,
    prefix: { ...PRE_FORK_HISTORY_HOLD_CHECKPOINT, genesisHash: SORA_MAINNET_GENESIS_HASH },
    qualification: { databaseFilesSha256: PI_STATS_PINS.databaseFiles, nativeAuditSha256: PI_STATS_PINS.nativeAudit,
      executorReceiptSha256: 'a'.repeat(64), volumeRepairMarkerSha256: PI_STATS_PINS.volumeRepair },
    policy: { version: 1, policyHash: hash(1), releaseManifestHash: hash(2), genesisHash: SORA_MAINNET_GENESIS_HASH,
      checkpoint: RECOVERY_CHECKPOINT, postForkAnchor: { block: RECOVERY_CHECKPOINT.block + 2, hash: hash(5) },
      substitutions: [{ old: hash(3), new: hash(4) }], attackerAccounts: [ATTACKER_ACCOUNT],
      metadata: [{ firstBlock: RECOVERY_CHECKPOINT.block, lastBlock: RECOVERY_CHECKPOINT.block + 100,
        executionCodeHash: hash(6), metadataHash: hash(7) }] } };
  const receipt = piStatsQualificationDocument(admission), executorReceipt = Buffer.from(JSON.stringify(receipt));
  admission.qualification.executorReceiptSha256 = sha(executorReceipt);
  return { admission, receipt, bytes: { ...retained, executorReceipt } satisfies PiStatsQualificationBytes };
}
async function stateFixture() {
  const f = qualified(), proof = validatePiStatsQualification(f.admission, f.bytes), repository = new MemoryRepository();
  const block = f.admission.prefix.block, timestamp = f.admission.prefix.timestamp;
  await repository.upsertMany([
    proof.normalizedBefore.volumeRepairMarker as IndexerDocument,
    { collection: 'updatesStreams', id: 'chainIdentity', blockHeight: block, timestamp, data: proof.native.identity as Record<string, unknown> },
    { collection: 'updatesStreams', id: 'chainState', blockHeight: block, timestamp,
      data: { id: 'chainState', block, data: JSON.stringify(proof.checkpoint) } },
    { collection: 'networkSnapshots', id: `block-${block}`, blockHeight: block, timestamp,
      data: { id: `block-${block}`, type: 'BLOCK', timestamp } },
  ]);
  return { ...f, repository };
}
afterEach(() => vi.restoreAllMocks());

describe('strict Pi COW qualification', () => {
  it('inherits the genuine MOF2 scan while keeping its original path and claims', () => {
    const f = qualified(), proof = validatePiStatsQualification(f.admission, f.bytes);
    expect(proof.receipt.normalizedScanExecutedOnPi).toBe(false);
    expect(proof.receipt.sourceServiceStopped).toBe(false);
    expect(proof.normalizedBefore.database).toBe('/data/pi-indexer-stats-history-trial-20261101/candidate.rocksdb');
    expect(proof.normalizedBefore.normalizedScanExecutedOnClone).toBe(true);
    expect(proof.normalizedBefore.normalizedDocumentsSha256).toBe(PI_STATS_PINS.normalizedDocuments);
    expect(Object.keys(proof.files)).toHaveLength(499);
    expect(() => validateStatsCloneQualification(f.admission, f.bytes)).toThrow('binding differs');
  });
  it.each([
    { normalizedScanExecutedOnPi: true }, { sourceServiceStopped: true }, { productionChanged: true },
    { entitlementsReady: true }, { nativeValidationMode: 'native-executed-on-pi-candidate' },
    { normalizedValidationMode: 'local-scan' }, { copyMechanism: 'ordinary-copy' },
    { sourceAccessMode: 'arbitrary-writer' }, { files: 498 }, { logicalBytes: 1 }, { extra: true },
    { piCowReceiptSha256: 'a'.repeat(64) }, { normalizedBeforeSha256: 'a'.repeat(64) },
  ])('rejects repinned incorrect provenance %j', change => {
    const f = qualified(), executorReceipt = Buffer.from(JSON.stringify({ ...f.receipt, ...change }));
    f.admission.qualification.executorReceiptSha256 = sha(executorReceipt);
    expect(() => validatePiStatsQualification(f.admission, { ...f.bytes, executorReceipt })).toThrow('scope/provenance');
  });
  it.each(Object.keys(retained) as (keyof typeof retained)[])('rejects modified raw %s bytes', key => {
    const f = qualified(); expect(() => validatePiStatsQualification(f.admission, { ...f.bytes, [key]: Buffer.from('{}') })).toThrow('pin');
  });
  it.each(['sourceDatabasePath', 'databasePath'] as const)('rejects another %s', field => {
    const f = qualified(); expect(() => validatePiStatsQualification({ ...f.admission, [field]: '/unreviewed/target' }, f.bytes)).toThrow('paths');
  });
  it('rejects duplicate-key qualification encodings despite an explicitly changed pin', () => {
    const f = qualified(); const raw = Buffer.from(JSON.stringify(f.receipt).replace('{', '{"schema":"shadow",'));
    f.admission.qualification.executorReceiptSha256 = sha(raw);
    expect(() => validatePiStatsQualification(f.admission, { ...f.bytes, executorReceipt: raw })).toThrow('noncanonical');
  });
  it('preserves the existing MOF2 CLI target guard before native open', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-admission-test-'));
    try {
      const f = qualified(), raw = Buffer.from(JSON.stringify(f.admission)), path = join(dir, 'admission.json');
      await writeFile(path, raw);
      await expect(initializeStatsRecovery([path, sha(raw), 'unused', 'unused', 'unused', '--apply-private-stats-copy']))
        .rejects.toThrow('unreviewed initializer target');
      await expect(initializePiStatsRecovery([])).rejects.toThrow('explicit');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('Pi seed state and shared pure construction', () => {
  it('derives exactly three rows without modifying the original state, then admits their atomic commit', async () => {
    const f = await stateFixture(), before = await f.repository.list('updatesStreams');
    const seed = await preparePiStatsRecoverySeed(f.repository, f.admission, f.bytes);
    expect(seed.map(row => row.id)).toEqual([STATS_ADMISSION_ID, STATS_CURSOR_ID, STATS_RECONCILIATION_ID]);
    expect(await f.repository.list('updatesStreams')).toEqual(before);
    const pure = buildStatsRecoverySeedRows(f.admission);
    expect(seed.slice(0, 2)).toEqual(pure.slice(0, 2));
    expect(seed[2]!.data).toEqual({ ...pure[2]!.data, generation: seed[2]!.data.generation });
    await f.repository.upsertMany(seed);
    expect((await requireStatsRecoveryState(f.repository, f.admission)).lastIndexedBlock).toBe(f.admission.prefix.block);
    await expect(preparePiStatsRecoverySeed(f.repository, f.admission, f.bytes)).rejects.toThrow('already carries');
  });
  it.each(['networkVolumeRepair-v2', 'chainState', 'chainIdentity', 'block'] as const)('rejects missing original %s state', async id => {
    const f = await stateFixture();
    await f.repository.deleteMany(id === 'block' ? 'networkSnapshots' : 'updatesStreams',
      [id === 'block' ? `block-${f.admission.prefix.block}` : id]);
    await expect(preparePiStatsRecoverySeed(f.repository, f.admission, f.bytes)).rejects.toThrow();
  });
  it.each([STATS_ADMISSION_ID, STATS_CURSOR_ID, STATS_RECONCILIATION_ID, 'burnRecoveryIdentity-v1',
    'soratopiaRecoveryContinuity-v1', 'soratopiaRecoveryProjection-v1'])('rejects preexisting %s classification', async id => {
    const f = await stateFixture(); await f.repository.upsert({ collection: 'updatesStreams', id,
      blockHeight: f.admission.prefix.block, timestamp: null, data: { id } });
    await expect(preparePiStatsRecoverySeed(f.repository, f.admission, f.bytes)).rejects.toThrow('already carries');
  });
});
