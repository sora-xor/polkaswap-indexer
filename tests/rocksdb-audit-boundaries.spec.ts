import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readConfig } from '../src/config.js';
import { RocksRepository, rocksCompactIndexKeysForDocument, ROCKSDB_FORMAT_METADATA_KEY } from '../src/repository/rocksdb.js';
import { buildRocksAuditReport, readFinalizedBlock, type ChainAuditApiModule } from '../src/scripts/audit-rocksdb.js';
import type { RocksDatabase } from '@harperfast/rocksdb-js';
let directory: string, repository: RocksRepository, db: RocksDatabase;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'rocks-audit-boundary-'));
  repository = new RocksRepository({ ...readConfig(), rocksdbPath: directory, rocksdbBlockCacheMb: 16, rocksdbWriteBufferManagerMb: 16, rocksdbParallelism: 1 });
  await repository.prepare(); db = (repository as any).db;
});
afterEach(async () => { vi.useRealTimers(); await repository.close(); await rm(directory, { recursive: true, force: true }); });
const report = (options = {}) => buildRocksAuditReport(db, { sampleSize: 1000, ...options });
const state = async (data: Record<string, unknown>, timestamp?: number) => repository.upsert({ collection: 'updatesStreams', id: 'chainState', ...(timestamp === undefined ? {} : { timestamp }), data: { id: 'chainState', ...data } });

describe('RocksDB audit corruption and chain evidence', () => {
  it('does not divide by zero for an empty database', () => {
    const value = report(); expect(value.documents).toBe(0); expect(value.keysPerDocument).toBe(0);
  });
  it.each(['bad', null, 1.5])('marks malformed format metadata %s unready', async version => {
    await db.put(['m', 'metadata', ROCKSDB_FORMAT_METADATA_KEY], version);
    expect(report().format).toMatchObject({ version: null, ready: false });
  });
  it.each(['[]', 'null', '1', '"text"', '{'])('falls back to the stored block header for payload %s', async data => {
    await state({ block: 4, data }, 10);
    expect(report({ finalizedBlock: 5, nowMs: 20_000 }).chainState).toMatchObject({ indexedBlock: 4, updatedAt: 10, lagBlocks: 1 });
  });
  it.each(['01', '-1', 'bad', -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects noncanonical checkpoint block %s', async lastIndexedBlock => {
    await state({ data: JSON.stringify({ lastIndexedBlock }) });
    expect(report().chainState.validationErrors).toContain('invalid indexed block');
    expect(report().chainState.validationErrors).toContain('invalid worker timestamp');
  });
  it('accepts a canonical string block number without losing precision', async () => {
    await state({ data: JSON.stringify({ lastIndexedBlock: '9007199254740991' }) }, 1);
    expect(report().chainState.indexedBlock).toBe(Number.MAX_SAFE_INTEGER);
  });
  it('rejects invalid finalized height and audit clock values independently', async () => {
    await state({ block: 1 }, 1);
    expect(report({ finalizedBlock: -1, nowMs: NaN }).chainState.validationErrors).toEqual(expect.arrayContaining(['invalid finalized block', 'invalid audit clock']));
  });
  it('limits sampled error examples while retaining the complete error count', async () => {
    const documents = Array.from({ length: 15 }, (_, i) => ({ collection: 'assetSnapshots' as const, id: `row-${i}`, timestamp: i, data: { id: `row-${i}`, assetId: 'XOR', type: 'DAY' } }));
    await repository.upsertMany(documents);
    for (const document of documents) for (const key of rocksCompactIndexKeysForDocument(document)) await db.remove(key);
    for (let i = 0; i < 15; i++) await db.put(['x', 'assetSnapshots', 't', i, `ghost-${i}`], 1);
    const value = report({ sampleSize: 2000 });
    expect(value.compactIndexIntegrity.missingCompactIndexes).toBeGreaterThan(10); expect(value.compactIndexIntegrity.missingExamples).toHaveLength(10);
    expect(value.compactIndexIntegrity.danglingCompactIndexes).toBe(15); expect(value.compactIndexIntegrity.danglingExamples).toHaveLength(10);
  });
  it('reports stale indexes separately from documents that do not exist', async () => {
    await repository.upsert({ collection: 'assets', id: 'a', data: { id: 'a' } });
    await db.put(['x', 'assets', 't', 999, 'a'], 1);
    expect(report().compactIndexIntegrity.danglingExamples).toContainEqual({ key: ['x', 'assets', 't', 999, 'a'], reason: 'stale_index' });
  });
  it('reports malformed index identifiers without opening unrelated documents', async () => {
    await db.put(['x', 'assets', 't', 1, 7], 1);
    expect(report().compactIndexIntegrity.danglingExamples).toContainEqual({ key: ['x', 'assets', 't', 1, 7], reason: 'malformed_key' });
  });
  it('deduplicates overlapping forward and reverse samples', async () => {
    await repository.upsert({ collection: 'assets', id: 'a', data: { id: 'a' } });
    expect(report().compactIndexIntegrity.sampledDocuments).toBe(1);
  });
  it('fails required chain evidence for old timestamps even with an in-range finalized height', async () => {
    await state({ block: 10 }, 1);
    expect(report({ requireChain: true, finalizedBlock: 10, nowMs: 1_000_000, maxStateAgeSeconds: 1 }).releaseGate.healthy).toBe(false);
  });
});

describe('audit chain connection cleanup', () => {
  it('skips chain loading when explicitly disabled', async () => {
    const load = vi.fn(); expect(await readFinalizedBlock('offline', 10, true, load)).toEqual({ finalizedBlock: null, error: 'chain check skipped' }); expect(load).not.toHaveBeenCalled();
  });
  it('preserves a non-Error module loading failure without allocating transports', async () => {
    expect(await readFinalizedBlock('offline', 10, false, async () => { throw 'offline'; })).toEqual({ finalizedBlock: null, error: 'offline' });
  });
  it('disconnects a transport that finishes connecting after the deadline', async () => {
    vi.useFakeTimers(); let complete!: (value: any) => void; const disconnect = vi.fn(async () => undefined), providerDisconnect = vi.fn(async () => undefined);
    const module = { WsProvider: class { disconnect = providerDisconnect; }, ApiPromise: { create: () => new Promise(resolve => { complete = resolve; }) } } as unknown as ChainAuditApiModule;
    const pending = readFinalizedBlock('offline', 10, false, async () => module);
    await vi.advanceTimersByTimeAsync(10); expect(await pending).toMatchObject({ finalizedBlock: null, error: 'chain check timed out after 10ms' });
    complete({ disconnect }); await vi.advanceTimersByTimeAsync(0);
    expect(disconnect).toHaveBeenCalledOnce(); expect(providerDisconnect).toHaveBeenCalledOnce();
  });
});
