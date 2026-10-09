import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readConfig } from '../src/config.js';
import { RocksRepository } from '../src/repository/rocksdb.js';
import { runPostgresToRocksdbMigration } from '../src/scripts/migrate-postgres-to-rocksdb.js';
import {
  acquireMigrationProcessLock,
  beginChangeCaptureSeal,
  capturedChangeHash,
  captureSentinelHash,
  installChangeCapture,
  readChangeCaptureDescriptor,
  recordCutoverReceipt,
  releaseMigrationProcessLock,
} from '../src/scripts/postgres-rocksdb-capture.js';
import { POSTGRES_ROCKSDB_MIGRATION_STATE_KEY } from '../src/scripts/rocksdb-migration-state.js';

import type { IndexerDocument } from '../src/repository/types.js';
import type { ChangeCaptureDescriptor, ChangeCaptureSeal } from '../src/scripts/postgres-rocksdb-capture.js';
import type { PostgresRocksdbMigrationState, ValidatedCapturedChange } from '../src/scripts/rocksdb-migration-state.js';

vi.mock('../src/scripts/postgres-rocksdb-capture.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/scripts/postgres-rocksdb-capture.js')>(),
  acquireMigrationProcessLock: vi.fn(),
  beginChangeCaptureSeal: vi.fn(),
  installChangeCapture: vi.fn(),
  readChangeCaptureDescriptor: vi.fn(),
  recordCutoverReceipt: vi.fn(),
  releaseMigrationProcessLock: vi.fn(),
}));

const SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const descriptor = (): ChangeCaptureDescriptor => ({
  version: 1, sourceId: SOURCE_ID, sourceDatabaseIdentity: 'a'.repeat(64),
  headSeq: '0', headHash: captureSentinelHash(SOURCE_ID), sealed: false,
  sealedSeq: null, sealedHash: null, cutoverRunId: null, cutoverDestinationId: null,
  cutoverSeq: null, cutoverHash: null,
});

describe('migration failure and resume with native RocksDB', () => {
  let temporary: string;
  let source: IndexerDocument[];
  let capture: ChangeCaptureDescriptor;
  let changes: ValidatedCapturedChange[];
  let failure: Error;
  let failExportAfterBatches: number | null;
  let failReplayAfterBatches: number | null;
  let exportBatches: number;
  let replayBatches: number;
  let exportCursors: Array<{ collection: string; id: string }>;
  let replayCursors: string[];

  const sourceRow = (document: IndexerDocument) => ({ collection: document.collection, id: document.id,
    blockHeight: String(document.blockHeight), timestamp: String(document.timestamp),
    dataText: JSON.stringify(document.data) });
  const result = <T>(rows: T[]) => ({ rows, rowCount: rows.length });

  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'polkaswap-migration-failure-'));
    vi.stubEnv('STORAGE_ENGINE', 'rocksdb');
    vi.stubEnv('ROCKSDB_PATH', join(temporary, 'destination.rocksdb'));
    vi.stubEnv('ROCKSDB_BLOCK_CACHE_MB', '16');
    vi.stubEnv('ROCKSDB_WRITE_BUFFER_MANAGER_MB', '16');
    vi.stubEnv('ROCKSDB_DOCUMENT_CACHE_MAX', '0');
    vi.stubEnv('ROCKSDB_DOCUMENT_CACHE_MAX_BYTES', '0');
    vi.stubEnv('ROCKSDB_MIGRATION_FOLLOW', 'false');
    vi.stubEnv('ROCKSDB_MIGRATION_BATCH_SIZE', '2');
    vi.stubEnv('ROCKSDB_CHANGE_REPLAY_BATCH_SIZE', '1');
    vi.stubEnv('DATABASE_URL', 'postgres://mock-only@127.0.0.1:1/no-connection');
    source = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => ({
      collection: 'assets', id, blockHeight: 10, timestamp: 20,
      data: { id, transactionCount: '17', volumeDayUSD: '1000000000000000000.001' },
    }));
    capture = descriptor(); changes = []; failure = new Error('simulated source read failure');
    failExportAfterBatches = null; failReplayAfterBatches = null;
    exportBatches = 0; replayBatches = 0; exportCursors = []; replayCursors = [];
    const client = {
      query: async (sql: string, arguments_: unknown[] = []) => {
        if (/^(begin|commit|rollback)/.test(sql)) return result([]);
        if (sql.includes('estimatedBytes') && sql.includes('from indexer_documents')) {
          const collection = String(arguments_[0]), id = String(arguments_[1]);
          exportCursors.push({ collection, id });
          if (failExportAfterBatches !== null && exportBatches === failExportAfterBatches) {
            failExportAfterBatches = null; throw failure;
          }
          exportBatches += 1;
          return result(source.filter(document => document.collection > collection ||
            (document.collection === collection && document.id > id))
            .slice(0, Number(arguments_[2])).map(document => ({ collection: document.collection,
              id: document.id, estimatedBytes: '5000' })));
        }
        if (sql.includes('document.data::text')) {
          const collections = arguments_[0] as string[], ids = arguments_[1] as string[];
          return result(ids.map((id, index) => sourceRow(source.find(document => document.collection === collections[index] && document.id === id)!)));
        }
        if (sql.includes('estimatedBytes') && sql.includes('rocksdb_changes')) {
          const after = String(arguments_[0]); replayCursors.push(after);
          if (failReplayAfterBatches !== null && replayBatches === failReplayAfterBatches) {
            failReplayAfterBatches = null; throw failure;
          }
          replayBatches += 1;
          return result(changes.filter(change => BigInt(change.seq) > BigInt(after) &&
            (arguments_[2] === null || BigInt(change.seq) <= BigInt(String(arguments_[2]))))
            .slice(0, Number(arguments_[1])).map(change => ({ seq: change.seq, estimatedBytes: '5000' })));
        }
        if (sql.includes('from polkaswap_indexer_migration.rocksdb_changes')) {
          return result(changes.filter(change => BigInt(change.seq) > BigInt(String(arguments_[0])) &&
            BigInt(change.seq) <= BigInt(String(arguments_[1]))).map(change => ({ ...change })));
        }
        if (sql.includes('count(*)::text')) {
          return result([{ count: String(source.filter(document => document.collection === arguments_[0]).length) }]);
        }
        if (sql.includes('data::text as "dataText"') && sql.includes('order by id collate "C"')) {
          return result(source.filter(document => document.collection === arguments_[0] &&
            (arguments_[1] === null || document.id > String(arguments_[1])))
            .slice(0, Number(arguments_[2])).map(sourceRow));
        }
        throw new Error(`Unexpected simulated PostgreSQL query: ${sql}`);
      },
      release: vi.fn(),
    } as unknown as pg.PoolClient;
    // Native storage and the actual migration orchestrator are exercised; only
    // PostgreSQL I/O/capture control are simulated, with no socket connections.
    vi.spyOn(pg.Pool.prototype, 'connect').mockImplementation(async () => client);
    vi.spyOn(pg.Pool.prototype, 'end').mockResolvedValue();
    vi.mocked(acquireMigrationProcessLock).mockResolvedValue(client);
    vi.mocked(releaseMigrationProcessLock).mockResolvedValue();
    vi.mocked(installChangeCapture).mockImplementation(async () => ({ ...capture }));
    vi.mocked(readChangeCaptureDescriptor).mockImplementation(async () => ({ ...capture }));
    vi.mocked(beginChangeCaptureSeal).mockImplementation(async () => {
      const sealed = { ...capture, sealed: true, sealedSeq: capture.headSeq, sealedHash: capture.headHash };
      return { client, descriptor: sealed,
        commit: async () => { capture = sealed; }, rollback: async () => undefined } as ChangeCaptureSeal;
    });
    vi.mocked(recordCutoverReceipt).mockImplementation(async (_client, receipt) => {
      capture = { ...capture, cutoverRunId: receipt.runId, cutoverDestinationId: receipt.destinationId,
        cutoverSeq: receipt.seq, cutoverHash: receipt.hash };
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    await rm(temporary, { recursive: true, force: true });
  });

  const inspect = async () => {
    const repository = new RocksRepository(readConfig(), { allowIncompleteMigration: true });
    try {
      await repository.prepare();
      await repository.validateCompactIndexes();
      return { state: repository.getMetadata<PostgresRocksdbMigrationState>(POSTGRES_ROCKSDB_MIGRATION_STATE_KEY)!,
        count: repository.count('assets'), documents: await repository.list('assets') };
    } finally { await repository.close(); }
  };

  it('retains two committed export batches, resumes at their cursor, and never doubles counters/counts', async () => {
    failExportAfterBatches = 2;
    await expect(runPostgresToRocksdbMigration()).rejects.toBe(failure);
    const failed = await inspect();
    expect(failed.state).toMatchObject({ status: 'failed', rows: 4, collection: 'assets', id: 'd',
      exportCompleted: false, lastError: failure.message });
    expect(failed.count).toBe(4);
    expect(failed.documents).toEqual(source.slice(0, 4));
    exportCursors = [];
    await runPostgresToRocksdbMigration();
    const resumed = await inspect();
    expect(exportCursors[0]).toEqual({ collection: 'assets', id: 'd' });
    expect(resumed.state).toMatchObject({ status: 'validated_complete', rows: 6,
      exportCompleted: true, lastError: null, runId: failed.state.runId,
      sourceId: failed.state.sourceId, destinationId: failed.state.destinationId });
    expect(resumed.count).toBe(6);
    expect(resumed.documents).toEqual(source);
  });

  it.each(['metadata', 'document'] as const)('rejects otherwise untracked business %s before installing capture', async (kind) => {
    const repository = new RocksRepository(readConfig(), { allowIncompleteMigration: true });
    try {
      await repository.prepare();
      expect(repository.formatVersion()).toBe(2);
      expect(repository.getMetadata('historySwapAssetIndex')).toEqual({ version: 1, status: 'ready' });
      if (kind === 'metadata') await repository.setMetadata('untrackedBusinessMetadata', { value: 'retained' });
      else await repository.upsert(source[0]!);
    } finally { await repository.close(); }
    vi.mocked(installChangeCapture).mockClear();
    await expect(runPostgresToRocksdbMigration()).rejects.toThrow('non-empty RocksDB destination with no matching migration state');
    expect(installChangeCapture).not.toHaveBeenCalled();
    expect(exportBatches).toBe(0);
  });

  it('retains two committed replay batches and resumes their immutable capture chain without re-export', async () => {
    let previousHash = capture.headHash;
    for (let index = 0; index < 3; index++) {
      const document = source[index]!;
      document.data.transactionCount = String(21 + index);
      const change = { sourceId: SOURCE_ID, seq: String(index + 1), previousSeq: String(index),
        previousHash, operation: 'U' as const, collection: 'assets' as const, id: document.id,
        blockHeight: '10', timestamp: '20', data: { ...document.data }, dataText: JSON.stringify(document.data) };
      const rowHash = capturedChangeHash(change);
      changes.push({ ...change, rowHash }); previousHash = rowHash;
    }
    capture.headSeq = '3'; capture.headHash = previousHash;
    // Export started at this capture head; use a seeded checkpoint whose
    // baseline began before the three source changes, as a prior live run does.
    const repository = new RocksRepository(readConfig(), { allowIncompleteMigration: true });
    await repository.prepare();
    const { createPostgresRocksdbMigrationState } = await import('../src/scripts/rocksdb-migration-state.js');
    await repository.setMetadata(POSTGRES_ROCKSDB_MIGRATION_STATE_KEY,
      createPostgresRocksdbMigrationState(descriptor()));
    await repository.close();
    const immutableChanges = structuredClone(changes);
    failReplayAfterBatches = 2;
    await expect(runPostgresToRocksdbMigration()).rejects.toBe(failure);
    const failed = await inspect();
    expect(failed.state).toMatchObject({ status: 'failed', rows: 6, exportCompleted: true,
      lastReplayedSeq: '2', lastReplayedHash: changes[1]!.rowHash, lastError: failure.message });
    expect(failed.count).toBe(6);
    exportCursors = []; replayCursors = [];
    await runPostgresToRocksdbMigration();
    const resumed = await inspect();
    expect(exportCursors).toEqual([]);
    expect(replayCursors[0]).toBe('2');
    expect(resumed.state).toMatchObject({ status: 'validated_complete', rows: 6,
      lastReplayedSeq: '3', lastReplayedHash: changes[2]!.rowHash,
      sealedSeq: '3', sealedHash: changes[2]!.rowHash, runId: failed.state.runId });
    expect(resumed.count).toBe(6);
    expect(resumed.documents).toEqual(source);
    expect(changes).toEqual(immutableChanges);
    expect(capture.sourceId).toBe(SOURCE_ID);
    expect(capture.headSeq).toBe('3'); expect(capture.headHash).toBe(previousHash);
  });
});
