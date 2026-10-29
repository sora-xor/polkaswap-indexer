import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { graphql } from 'graphql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RocksDatabase } from '@harperfast/rocksdb-js';
import { readConfig } from '../src/config.js';
import { createSchema } from '../src/graphql/resolvers.js';
import { validatePublicConnectionQuery } from '../src/graphql/query-policy.js';
import { metrics } from '../src/metrics.js';
import { RocksRepository, rocksCompactIndexKeysForDocument } from '../src/repository/rocksdb.js';
import type { IndexerDocument } from '../src/repository/types.js';

const old = `0x${'1'.repeat(64)}`;
const replacement = `0x${'2'.repeat(64)}`;
const other = `0x${'3'.repeat(64)}`;
const config = (path: string, limit = 100_000) => ({
  ...readConfig(), rocksdbPath: path, rocksdbBlockCacheMb: 4,
  rocksdbWriteBufferManagerMb: 2, rocksdbParallelism: 1,
  rocksdbDocumentCacheMax: 0, rocksdbQueryMaxScannedRows: limit,
});
const receipt = (id: string, claimOwner = replacement): IndexerDocument => ({
  collection: 'xorBurns', id, blockHeight: 28_191_817, timestamp: 100,
  data: { id, address: old, originalAddress: old, claimOwner, amount: '1',
    claimStatus: 'recipient-confirmation-required', blockHeight: 28_191_817, timestamp: 100 },
});
const internal = (repository: RocksRepository) => repository as unknown as { db: RocksDatabase };
const ownerFilter = { claimOwner: { equalTo: replacement } };
const query = `query($filter: XorBurnFilter, $after: Cursor) {
  xorBurns(first: 1, orderBy: [ID_ASC], filter: $filter, after: $after) {
    nodes { id address originalAddress claimOwner claimStatus }
    totalCount pageInfo { endCursor hasNextPage }
  }
}`;

describe('replacement burn-owner queries', () => {
  let directory: string;
  let path: string;
  let repository: RocksRepository;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'polkaswap-burn-owner-'));
    path = join(directory, 'indexer.rocksdb');
    repository = new RocksRepository(config(path));
    await repository.prepare();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await repository.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });

  it('returns replacement-owned receipts through GraphQL without changing original provenance', async () => {
    await repository.upsertMany([receipt('a'), receipt('b'), receipt('unrelated', other)]);
    const schema = createSchema();
    const first = await graphql({ schema, source: query, contextValue: { repository }, variableValues: { filter: ownerFilter } });
    expect(first.errors).toBeUndefined();
    expect(first.data?.xorBurns).toMatchObject({ nodes: [{ id: 'a', address: old, originalAddress: old,
      claimOwner: replacement, claimStatus: 'recipient-confirmation-required' }], totalCount: 2,
      pageInfo: { hasNextPage: true } });
    const after = (first.data?.xorBurns as { pageInfo: { endCursor: string } }).pageInfo.endCursor;
    const second = await graphql({ schema, source: query, contextValue: { repository }, variableValues: { filter: ownerFilter, after } });
    expect(second.errors).toBeUndefined();
    expect(second.data?.xorBurns).toMatchObject({ nodes: [{ id: 'b', claimOwner: replacement }], totalCount: 2,
      pageInfo: { hasNextPage: false } });
    const retired = await graphql({ schema, source: query, contextValue: { repository },
      variableValues: { filter: { claimOwner: { equalTo: old } } } });
    expect(retired.errors).toBeUndefined();
    expect(retired.data?.xorBurns).toMatchObject({ nodes: [], totalCount: 0 });
  });

  it('uses the compact owner index, updates/deletes it and merges bounded IN selectors', async () => {
    await repository.upsertMany([receipt('a'), receipt('b'), receipt('c', other),
      ...Array.from({ length: 300 }, (_, i) => receipt(`unrelated-${i}`, old))]);
    metrics.reset();
    const first = await repository.query('xorBurns', { filter: ownerFilter, orderBy: ['ID_ASC'], first: 10, includeTotalCount: false });
    expect(first.items.map((item) => item.id)).toEqual(['a', 'b']);
    expect(metrics.render()).toContain('indexer_rocksdb_query_scanned_rows_total{collection="xorBurns",source="x:c-i"} 2');
    await repository.upsert(receipt('a', other));
    await repository.deleteMany('xorBurns', ['b']);
    expect((await repository.query('xorBurns', { filter: ownerFilter, orderBy: ['ID_ASC'] })).items).toEqual([]);
    const filter = { claimOwner: { in: [replacement, other] } };
    validatePublicConnectionQuery('xorBurns', ['ID_DESC'], filter);
    expect((await repository.query('xorBurns', { filter, orderBy: ['ID_DESC'] })).items.map((item) => item.id)).toEqual(['c', 'a']);
  });

  it('rebuilds missing and stale old-writer keys in bounded pages before serving, preserving receipts', async () => {
    const documents = Array.from({ length: 300 }, (_, i) => receipt(`receipt-${String(i).padStart(3, '0')}`));
    await repository.upsertMany(documents);
    await repository.close();
    const raw = RocksDatabase.open(path);
    for (const document of documents) for (const key of rocksCompactIndexKeysForDocument(document)) await raw.remove(key);
    await raw.put(['x', 'xorBurns', 'c-i', old, 'stale'], 1);
    raw.close();
    repository = RocksRepository.openReadOnly(config(path));
    await expect(repository.prepare()).rejects.toThrow('burn-owner index is incomplete');
    await repository.close();
    repository = new RocksRepository(config(path));
    const native = internal(repository).db;
    const original = native.transaction.bind(native);
    let pages = 0;
    const writes = vi.spyOn(native, 'transaction').mockImplementation(async (callback) => {
      pages += 1;
      return original(callback);
    });
    await repository.prepare();
    expect(pages).toBeGreaterThanOrEqual(5);
    writes.mockRestore();
    expect(native.getSync(['x', 'xorBurns', 'c-i', old, 'stale'])).toBeUndefined();
    expect((await repository.query('xorBurns', { filter: ownerFilter, orderBy: ['ID_ASC'], first: 1 })).totalCount).toBe(300);
    expect(await repository.get('xorBurns', documents[0].id)).toEqual(documents[0]);
    await repository.close();
    repository = RocksRepository.openReadOnly(config(path));
    await expect(repository.prepare()).resolves.toBeUndefined();
    expect((await repository.query('xorBurns', { filter: ownerFilter, orderBy: ['ID_ASC'], first: 1 })).totalCount).toBe(300);
  });

  it('restarts an interrupted owner-index rebuild without exposing a partial result', async () => {
    await repository.upsertMany(Array.from({ length: 300 }, (_, i) => receipt(`receipt-${i}`)));
    await repository.close();
    repository = new RocksRepository(config(path));
    const native = internal(repository).db;
    const original = native.transaction.bind(native);
    let calls = 0;
    const interruption = vi.spyOn(native, 'transaction').mockImplementation(async (callback) => {
      if (++calls === 5) throw new Error('simulated prepare interruption');
      return original(callback);
    });
    await expect(repository.prepare()).rejects.toThrow('simulated prepare interruption');
    await expect(repository.query('xorBurns', { filter: ownerFilter })).rejects.toThrow('prepare() first');
    interruption.mockRestore();
    await repository.close();
    repository = new RocksRepository(config(path));
    await repository.prepare();
    expect((await repository.query('xorBurns', { filter: ownerFilter, orderBy: ['ID_ASC'], first: 1 })).totalCount).toBe(300);
  });

  it('retains the scan budget for owner-selected residual misses and total counts', async () => {
    await repository.upsertMany([receipt('a'), receipt('b'), receipt('c')]);
    await repository.close();
    repository = new RocksRepository(config(path, 2));
    await repository.prepare();
    const filter = { ...ownerFilter, amount: { greaterThan: '100' } };
    validatePublicConnectionQuery('xorBurns', ['ID_ASC'], filter);
    await expect(repository.query('xorBurns', { filter, orderBy: ['ID_ASC'], first: 1 })).rejects.toThrow('2 row scan limit');
  });

  it.each([
    { claimOwner: { includes: replacement } },
    { claimOwner: { in: [] } },
    { claimOwner: { equalTo: null } },
    { address: { equalTo: old } },
    { blockHeight: { greaterThan: 1 } },
    { or: [ownerFilter, { amount: { greaterThan: 0 } }] },
    { ...ownerFilter, nexusRecipient: { equalTo: 'untrusted' } },
  ])('rejects unsupported or unanchored filters %j', (filter) => {
    expect(() => validatePublicConnectionQuery('xorBurns', ['ID_ASC'], filter)).toThrow();
  });

  it('rejects owner queries with unsupported ordering', () => {
    expect(() => validatePublicConnectionQuery('xorBurns', ['TIMESTAMP_ASC'], ownerFilter)).toThrow();
  });
});
