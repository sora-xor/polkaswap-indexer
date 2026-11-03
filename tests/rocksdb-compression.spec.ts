import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RocksDatabase } from '@harperfast/rocksdb-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readConfig } from '../src/config.js';
import { RocksRepository, rocksCompactIndexKeysForDocument, ROCKSDB_FORMAT_METADATA_KEY } from '../src/repository/rocksdb.js';
import { encodeRocksDocument } from '../src/repository/rocksdb-document.js';
import { INDEXER_COLLECTIONS } from '../src/repository/types.js';
import { createRocksdbBackup } from '../src/scripts/backup-rocksdb.js';
import { createRocksdbCheckpoint } from '../src/scripts/checkpoint-rocksdb.js';
import { restoreRocksdbBackup } from '../src/scripts/restore-rocksdb.js';
import { createRocksdbRestorePlan } from '../src/scripts/env.js';
import { assertCurrentRocksdbArtifactSource } from '../src/scripts/rocksdb-artifact-source.js';
import { buildRocksAuditReport } from '../src/scripts/audit-rocksdb.js';
import { openReadOnly } from '../src/scripts/export-points-recovery.js';
import { verifyPostgresRocksdbLogicalEquality } from '../src/scripts/verify-postgres-rocksdb-logical.js';
import { runPostgresToRocksdbMigration } from '../src/scripts/migrate-postgres-to-rocksdb.js';
import { initializePointsRecovery, admitPointBlock, pointBlockDocuments, pointValuation,
  exportPointJournalRange, pointsDigest } from '../src/points-recovery.js';
import { RECOVERY_CHECKPOINT, ATTACKER_ACCOUNT, type BurnRecoveryPolicy } from '../src/burn-recovery.js';
import { SORA_MAINNET_GENESIS_HASH } from '../src/soraIdentity.js';
import type { AppConfig } from '../src/config.js';
import type { IndexerDocument } from '../src/repository/types.js';
import type pg from 'pg';

// Several native reopen/backup/index passes share one fixture; allow bounded I/O time.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });
let root: string;
const handles: RocksRepository[] = [];
const config = (path: string, compression: 'none' | 'brotli' = 'none'): AppConfig => ({ ...readConfig(),
  storageEngine: 'rocksdb', rocksdbPath: path, rocksdbDocumentCompression: compression,
  rocksdbBlockCacheMb: 16, rocksdbWriteBufferManagerMb: 16, rocksdbParallelism: 1,
  rocksdbDocumentCacheMax: 0, rocksdbDocumentCacheMaxBytes: 0 });
const open = async (name: string, compression: 'none' | 'brotli' = 'brotli') => {
  const repo = new RocksRepository(config(join(root, name), compression)); handles.push(repo); await repo.prepare(); return repo;
};
const snapshot = (id: string, block = 4): IndexerDocument => ({ collection: 'assetSnapshots', id, blockHeight: block, timestamp: 12,
  data: { id, timestamp: 12, blockHeight: block, assetId: 'XOR', type: 'DAY', priceUSD: '1.000000000000000001', memo: '界😀'.repeat(2048) } });
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'polkaswap-format3-')); });
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(handles.splice(0).map(repo => repo.close())); await rm(root, { recursive: true, force: true }); });

describe('fresh native RocksDB format-3 admission and query parity', () => {
  it('preserves decoded records, optional positions, indexes, counts, update rules and reads after restart', async () => {
    const repo = await open('compressed');
    const rows: IndexerDocument[] = [snapshot('a'), snapshot('b'), { collection: 'assets', id: 'optional', blockHeight: undefined,
      timestamp: null, data: { id: 'optional', memo: 'x'.repeat(4096), amount: '9007199254740993' } }];
    await repo.upsertMany(rows);
    expect(repo.formatVersion()).toBe(3);
    repo.inspectCurrentSnapshot(db => {
      const value = db.getSync(['d', 'assets', 'optional']) as unknown[];
      expect(value[0]).toBe(3); expect(value[1]).toBeUndefined(); expect(value[2]).toBeNull(); expect(Buffer.isBuffer(value[6])).toBe(true);
      assertCurrentRocksdbArtifactSource(db, join(root, 'compressed'));
    });
    await expect(repo.validateCompactIndexes()).resolves.toBeUndefined();
    const query = await repo.query('assetSnapshots', { first: 1, filter: { assetId: { equalTo: 'XOR' } }, orderBy: ['TIMESTAMP_DESC'], includeTotalCount: true });
    expect(query.items).toHaveLength(1); expect(query.totalCount).toBe(2);
    await expect(repo.getMany('assetSnapshots', ['a', 'b'])).resolves.toEqual(new Map(rows.slice(0, 2).map(row => [row.id, row])));
    await repo.upsert({ ...snapshot('a', 3), data: { ...snapshot('a', 3).data, memo: 'stale' } });
    expect((await repo.get('assetSnapshots', 'a'))?.blockHeight).toBe(4);
    await expect(repo.upsertMany([snapshot('uncommitted'), { collection: 'assets', id: 'invalid', data: { bad: NaN } }])).rejects.toThrow();
    expect(await repo.get('assetSnapshots', 'uncommitted')).toBeNull();
    await repo.upsert(snapshot('a', 5)); await repo.validateCompactIndexes();
    await repo.close();
    const reader = RocksRepository.openReadOnly(config(join(root, 'compressed'))); handles.push(reader);
    await reader.prepare(); expect(reader.formatVersion()).toBe(3);
    expect(await reader.get('assets', 'optional')).toStrictEqual(rows[2]);
    expect((await reader.list('assetSnapshots')).map(row => row.id)).toEqual(['a', 'b']);
    await expect(reader.upsert(snapshot('forbidden'))).rejects.toThrow(/read-only/);
    await reader.validateCompactIndexes(); await reader.close();
    const resume = await open('compressed'); expect(await resume.get('assetSnapshots', 'a')).toEqual(snapshot('a', 5));
  });

  it.each([false, true])('rejects opt-in on every existing format-2 DB (documents=%s) before metadata/index mutation', async (withDocuments) => {
    const repo = await open('existing', 'none'); if (withDocuments) await repo.upsert(snapshot('a'));
    const before = repo.inspectCurrentSnapshot(db => [...db.getRange()].map(({ key, value }) => [key, value]));
    await repo.close();
    const attempted = new RocksRepository(config(join(root, 'existing'), 'brotli')); handles.push(attempted);
    await expect(attempted.prepare()).rejects.toThrow(/fresh format-3/); await attempted.close();
    const reader = RocksDatabase.open(join(root, 'existing'), { readOnly: true });
    try { expect([...reader.getRange()].map(({ key, value }) => [key, value])).toEqual(before); } finally { reader.close(); }
  });

  it('rejects nonempty unversioned DBs, unsupported formats and writable format-3 resumes without opt-in', async () => {
    for (const [name, version] of [['unversioned', undefined], ['future', 99], ['legacy', 1]] as const) {
      const raw = RocksDatabase.open(join(root, name)); await raw.put(['d', 'assets', 'sentinel'], [2, null, null, 0, {}]);
      if (version !== undefined) await raw.put(['m', 'metadata', ROCKSDB_FORMAT_METADATA_KEY], version);
      raw.close();
      const repo = new RocksRepository(config(join(root, name), 'brotli')); handles.push(repo);
      await expect(repo.prepare()).rejects.toThrow(/Unsupported/); await repo.close();
    }
    const repo = await open('needs-option'); await repo.upsert(snapshot('a')); await repo.close();
    const omitted = new RocksRepository(config(join(root, 'needs-option'))); handles.push(omitted);
    await expect(omitted.prepare()).rejects.toThrow(/explicitly opted-in/);
  });

  it('rejects a compressed document behind a format-2 marker', async () => {
    const repo = await open('wrong-marker', 'none'); await repo.upsert(snapshot('a')); await repo.close();
    const raw = RocksDatabase.open(join(root, 'wrong-marker')); await raw.put(['d', 'assetSnapshots', 'a'], encodeRocksDocument(snapshot('a'), 'brotli')); raw.close();
    const reader = RocksRepository.openReadOnly(config(join(root, 'wrong-marker'))); handles.push(reader); await reader.prepare();
    await expect(reader.get('assetSnapshots', 'a')).rejects.toThrow(/Unsupported or corrupt/);
    await expect(reader.validateCompactIndexes()).rejects.toThrow(/Unsupported or corrupt/);
    expect(() => reader.inspectCurrentSnapshot(db => buildRocksAuditReport(db))).toThrow(/Unsupported or corrupt/);
  });

  it('checks missing indexes for format 3 instead of silently disabling its audit', async () => {
    const repo = await open('audit'); const row = snapshot('a'); await repo.upsert(row); await repo.close();
    const raw = RocksDatabase.open(join(root, 'audit'));
    try {
      await raw.remove(rocksCompactIndexKeysForDocument(row)[0]!);
      const report = buildRocksAuditReport(raw);
      expect(report.format).toMatchObject({ version: 3, ready: true, supportedVersions: [2, 3] });
      expect(report.compactIndexIntegrity.missingCheckEnabled).toBe(true);
      expect(report.compactIndexIntegrity.missingCompactIndexes).toBeGreaterThan(0);
      expect(report.releaseGate.healthy).toBe(false);
    } finally { raw.close(); }
  });

  it('preserves decoded verification, backup/checkpoint/restore and export-reader behavior', async () => {
    const repo = await open('artifacts'); const row = snapshot('a'); await repo.upsert(row); await repo.validateCompactIndexes();
    const pgClient = { query: async (sql: string, args: [string, string | null, number]) => {
      if (sql.includes('count(*)')) return { rows: [{ count: args[0] === row.collection ? '1' : '0' }] };
      return { rows: args[0] === row.collection && args[1] === null ? [{ ...row, dataText: JSON.stringify(row.data) }] : [] };
    } } as unknown as pg.PoolClient;
    await expect(verifyPostgresRocksdbLogicalEquality(pgClient, repo, 10)).resolves.toBe(1);
    await repo.close();
    const source = join(root, 'artifacts'), backupDir = join(root, 'backups'), checkpoint = join(root, 'checkpoint');
    await createRocksdbCheckpoint(source, checkpoint);
    const backupId = await createRocksdbBackup(source, backupDir);
    const plan = createRocksdbRestorePlan({ ROCKSDB_BACKUP_DIR: backupDir, ROCKSDB_RESTORE_PARENT_PATH: join(root, 'restore-staging'),
      ROCKSDB_RESTORE_BACKUP_ID: String(backupId) }, root, randomUUID());
    await restoreRocksdbBackup(config(source), plan);
    for (const path of [checkpoint, plan.targetPath]) {
      const reader = RocksRepository.openReadOnly(config(path)); handles.push(reader); await reader.prepare(); await reader.validateCompactIndexes();
      expect(reader.formatVersion()).toBe(3); expect(await reader.get(row.collection, row.id)).toEqual(row); await reader.close();
    }
    const exporter = await openReadOnly(plan.targetPath);
    try { await exporter.prepare?.(); expect(await exporter.get(row.collection, row.id)).toEqual(row); } finally { await exporter.close(); }
  }, 20_000);

  it('rejects the compression option in the legacy PostgreSQL migration before connecting or creating a target', async () => {
    vi.stubEnv('ROCKSDB_DOCUMENT_COMPRESSION', 'brotli');
    await expect(runPostgresToRocksdbMigration()).rejects.toThrow(/migration supports only format 2/);
  });
});

const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const policy: BurnRecoveryPolicy = { version: 1, policyHash: h(1), releaseManifestHash: h(2), genesisHash: SORA_MAINNET_GENESIS_HASH,
  checkpoint: RECOVERY_CHECKPOINT, postForkAnchor: { block: RECOVERY_CHECKPOINT.block + 2, hash: h(10) },
  substitutions: [{ old: h(3), new: h(4) }], attackerAccounts: [ATTACKER_ACCOUNT],
  metadata: [{ firstBlock: RECOVERY_CHECKPOINT.block + 1, lastBlock: RECOVERY_CHECKPOINT.block + 2, executionCodeHash: h(7), metadataHash: h(8) }] };
describe('native format-3 recovery receipt parity', () => {
  it('keeps exact journal exports, valuation commitments, logical rows and indexes equal to format 2', async () => {
    const repositories = [await open('plain', 'none'), await open('compressed')];
    const exports: unknown[] = [];
    for (const repo of repositories) {
      await initializePointsRecovery(repo, policy, 1);
      for (let block = 1; block <= 3; block++) {
        const parentHash = block === 1 ? policy.genesisHash : h(100 + block - 1), hash = h(100 + block);
        const previous = await admitPointBlock(repo, policy, block, hash, parentHash);
        const assets = new Map(Array.from({ length: 100 }, (_, i) => [h(i + 1000), { id: h(i + 1000), symbol: 'TOKEN', name: 'Historical token', decimals: 18, supply: 1000000000000000000n }]));
        const valuation = pointValuation({ blockHeight: block - 1, blockHash: parentHash, assets, pools: new Map(), prices: new Map() }, block, parentHash);
        const rows = pointBlockDocuments(policy, previous, block, hash, '0x' + '01'.repeat(4096), [], [], valuation);
        await repo.upsertMany([...rows, { collection: 'updatesStreams', id: 'chainState', blockHeight: block, timestamp: 1,
          data: { id: 'chainState', data: JSON.stringify({ lastIndexedBlock: block, blockHash: hash }) } }]);
      }
      await repo.validateCompactIndexes();
      const entries: unknown[] = [];
      const receipt = await exportPointJournalRange(repo, policy, 1, 3, async entry => { entries.push(entry); });
      exports.push({ entries, receipt, rows: await Promise.all(INDEXER_COLLECTIONS.map(collection => repo.list(collection))) });
    }
    expect(exports[1]).toStrictEqual(exports[0]); expect(pointsDigest(exports[1])).toBe(pointsDigest(exports[0]));
    expect(repositories[1]!.inspectCurrentSnapshot(db => [...db.getRange({ start: ['d'], end: ['d', Buffer.from([255])] })]
      .filter(({ value }) => Array.isArray(value) && value[0] === 3).length)).toBeGreaterThan(3);
  });
});
