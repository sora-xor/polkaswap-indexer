import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { graphql } from 'graphql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RocksDatabase } from '@harperfast/rocksdb-js';

import { readConfig } from '../src/config.js';
import { createSchema } from '../src/graphql/resolvers.js';
import { decodeRepositoryCursor } from '../src/repository/cursor.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { ROCKSDB_SWAP_ASSET_INDEX_METADATA_KEY, RocksRepository, rocksCompactIndexKeysForDocument, rocksSwapAssetIndexIsReady } from '../src/repository/rocksdb.js';
import { assertCurrentRocksdbArtifactSource } from '../src/scripts/rocksdb-artifact-source.js';
import { buildRocksAuditReport } from '../src/scripts/audit-rocksdb.js';
import { metrics } from '../src/metrics.js';
import { PINNED_SWAP_HISTORY_QUERY, PINNED_SWAP_HISTORY_QUERY_SHA256 } from './pinned-swap-history-fixture.js';

import type { IndexerDocument, RepositoryQueryArgs } from '../src/repository/types.js';

const xor = '0x0200000000000000000000000000000000000000000000000000000000000000';
const floor = 1790175600;
const range = (prefix: Array<string | Buffer>) => ({ start: prefix, end: [...prefix, Buffer.from([255])], inclusiveEnd: true });
const config = (path: string, limit = 100_000) => ({
  ...readConfig(), storageEngine: 'rocksdb' as const, rocksdbPath: path,
  rocksdbBlockCacheMb: 2, rocksdbWriteBufferManagerMb: 2, rocksdbParallelism: 1,
  rocksdbDocumentCacheMax: 0, rocksdbQueryMaxScannedRows: limit,
});
const history = (id: string, timestamp: number | null, assets: unknown = [xor, 'val'], module = 'liquidityProxy', method = 'swap'): IndexerDocument => ({
  collection: 'historyElements', id, timestamp, data: { id, timestamp, module, method, dataAssets: assets },
});
const filter = { and: [
  { or: [{ method: { equalTo: 'swap' }, module: { equalTo: 'liquidityProxy' } }] },
  { dataAssets: { contains: xor } }, { timestamp: { greaterThan: floor } },
] };
const args: RepositoryQueryArgs = { first: 100, offset: 0, orderBy: ['TIMESTAMP_DESC', 'ID_DESC'], filter, includeTotalCount: true };
const internal = (repository: RocksRepository) => repository as unknown as { db: RocksDatabase };

describe('compact swap-asset timestamp index', () => {
  let directory: string;
  let path: string;
  let repository: RocksRepository;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'polkaswap-swap-history-index-'));
    path = join(directory, 'indexer.rocksdb');
    repository = new RocksRepository(config(path));
    await repository.prepare();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await repository.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });

  it('serves the exact published operation above the old 100000-row residual scan failure', async () => {
    expect(createHash('sha256').update(PINNED_SWAP_HISTORY_QUERY).digest('hex')).toBe(PINNED_SWAP_HISTORY_QUERY_SHA256);
    for (let start = 0; start < 100_001; start += 1_000) {
      await repository.upsertMany(Array.from({ length: Math.min(1_000, 100_001 - start) }, (_, offset) =>
        history(`event-${String(start + offset).padStart(6, '0')}`, floor + 20, [xor], 'assets', 'transfer')));
    }
    await repository.upsertMany([
      history('trade-a', floor + 1), history('trade-b', floor + 1), history('trade-c', floor + 2),
      history('old-trade', floor), history('other-asset', floor + 5, ['dai']), history('null-trade', null),
    ]);
    metrics.reset();
    const result = await graphql({
      schema: createSchema(), source: PINNED_SWAP_HISTORY_QUERY, contextValue: { repository },
      variableValues: { first: 100, last: null, offset: 0, before: '', after: '', orderBy: args.orderBy, filter },
    });
    expect(result.errors).toBeUndefined();
    expect(result.data?.data).toMatchObject({ totalCount: 3, edges: [
      { node: { id: 'trade-c' } }, { node: { id: 'trade-b' } }, { node: { id: 'trade-a' } },
    ], pageInfo: { hasNextPage: false, hasPreviousPage: false } });
    expect(metrics.render()).toContain('indexer_rocksdb_query_scanned_rows_total{collection="historyElements",source="x:s-a-t"} 3');
    expect(metrics.render()).not.toContain('indexer_rocksdb_query_scan_limit_total');
    expect(repository.count('historyElements')).toBe(100_007);
  }, 120_000);

  it('preserves all asset memberships, exact counts, offsets, cursors, and timestamp-null semantics across updates/delete/reopen', async () => {
    const memory = new MemoryRepository();
    const documents = [history('a', floor + 1), history('z', floor + 1), history('b', floor + 2, ['dai', xor, xor]),
      history('scalar', floor + 3, xor), history('null', null), history('non-swap', floor + 4, [xor], 'assets')];
    const compare = async (queryArgs: RepositoryQueryArgs) => {
      const expected = await memory.query('historyElements', queryArgs);
      const actual = await repository.query('historyElements', queryArgs);
      expect(actual.items).toEqual(expected.items);
      expect(actual.totalCount).toEqual(expected.totalCount);
      expect(actual.hasNextPage).toEqual(expected.hasNextPage);
      expect(actual.hasPreviousPage).toEqual(expected.hasPreviousPage);
      return actual;
    };
    try {
      await memory.upsertMany(documents);
      await repository.upsertMany(documents);
      await compare(args);
      await compare({ ...args, first: 1, offset: 2 });
      await compare({ ...args, first: null, last: 2, offset: 1 });
      const first = await compare({ ...args, first: 1, offset: undefined, includeTotalCount: false });
      await compare({ ...args, first: 1, offset: undefined, keyset: decodeRepositoryCursor(first.itemCursors?.[0]) });
      await compare({ ...args, orderBy: ['TIMESTAMP_ASC', 'ID_ASC'] });
      await compare({ ...args, filter: { module: { eq: 'liquidityProxy' }, method: { eq: 'swap' }, dataAssets: { contains: xor } } });
      await compare({ ...args, filter: { module: { eq: 'liquidityProxy' }, method: { eq: 'swap' }, dataAssets: { contains: ['dai', xor] }, timestamp: { gt: floor } } });
      await compare({ ...args, filter: { module: { eq: 'liquidityProxy' }, method: { eq: 'swap' }, dataAssets: { contains: 'val' }, timestamp: { gt: floor } } });
      const changed = [history('a', floor + 10, ['dai']), history('z', floor + 9, [xor], 'assets'), history('non-swap', floor + 8)];
      await memory.upsertMany(changed);
      await repository.upsertMany(changed);
      await repository.upsertMany(changed); // Atomic idempotent replay adds no duplicate keys/counts.
      await memory.deleteMany('historyElements', ['b']);
      await repository.deleteMany('historyElements', ['b']);
      await compare(args);
      await repository.validateCompactIndexes();
      await repository.close();
      repository = new RocksRepository(config(path));
      await repository.prepare();
      await compare(args);
      await repository.validateCompactIndexes();
    } finally { await memory.close(); }
  });

  it('never extracts a membership/operation from one multi-OR branch or ignored null condition', async () => {
    const documents = [history('swap', floor + 1), history('assets', floor + 2, [xor], 'assets'), history('dai', floor + 3, ['dai'])];
    const memory = new MemoryRepository();
    try {
      await memory.upsertMany(documents);
      await repository.upsertMany(documents);
      for (const queryFilter of [
        { or: [{ module: { eq: 'liquidityProxy' }, method: { eq: 'swap' }, dataAssets: { contains: xor } }, { module: { eq: 'assets' } }] },
        { module: { eq: 'liquidityProxy' }, method: { eq: 'swap' }, or: [{ dataAssets: { contains: xor } }, { dataAssets: { contains: 'dai' } }] },
        { module: { eq: 'liquidityProxy' }, method: { eq: 'swap' }, dataAssets: { contains: 'null' } },
      ]) {
        const queryArgs = { ...args, filter: queryFilter };
        metrics.reset();
        const actual = await repository.query('historyElements', queryArgs);
        expect(actual.items).toEqual((await memory.query('historyElements', queryArgs)).items);
        expect(metrics.render()).not.toContain('source="x:s-a-t"');
      }
    } finally { await memory.close(); }
  });

  it('keeps remaining asset-intersection misses and exact totals inside the unchanged scan budget', async () => {
    await repository.close();
    repository = new RocksRepository(config(path, 2));
    await repository.prepare();
    await repository.upsertMany([history('match', floor + 1), history('miss-a', floor + 3, [xor]), history('miss-b', floor + 2, [xor])]);
    const queryArgs = { ...args, filter: { ...filter, and: [...filter.and, { dataAssets: { contains: 'val' } }] } };
    for (const includeTotalCount of [true, false]) {
      await expect(repository.query('historyElements', { ...queryArgs, includeTotalCount })).rejects.toThrow('2 row scan limit');
    }
  });

  it.each(['address', 'address-OR'] as const)('preserves the existing selective %s plan under the unchanged row cap', async (mode) => {
    await repository.close();
    repository = new RocksRepository(config(path, 2));
    await repository.prepare();
    const documents = [history('target-a', floor + 1), history('target-z', floor + 1),
      history('unrelated-a', floor + 2), history('unrelated-z', floor + 3)];
    documents[0]!.data.address = 'mine';
    documents[1]!.data.address = mode === 'address' ? 'mine' : 'mine-alt';
    documents[2]!.data.address = 'other';
    documents[3]!.data.address = 'other';
    const anchor = mode === 'address' ? { address: { eq: 'mine' } }
      : { or: [{ address: { eq: 'mine' } }, { address: { eq: 'mine-alt' } }] };
    const memory = new MemoryRepository();
    try {
      await memory.upsertMany(documents);
      await repository.upsertMany(documents);
      for (const includeTotalCount of [true, false]) {
        const queryArgs = { ...args, first: 2, includeTotalCount, filter: { and: [...filter.and, anchor] } };
        const expected = await memory.query('historyElements', queryArgs);
        metrics.reset();
        const actual = await repository.query('historyElements', queryArgs);
        expect(actual.items).toEqual(expected.items);
        expect(actual.items.map(document => document.id)).toEqual(['target-z', 'target-a']);
        expect(actual.totalCount).toEqual(expected.totalCount);
        expect(actual.hasNextPage).toBe(false);
        expect(metrics.render()).toContain(`indexer_rocksdb_query_scanned_rows_total{collection="historyElements",source="${mode === 'address' ? 'x:a-t' : 'x:or-t'}"} 2`);
        expect(metrics.render()).not.toContain('source="x:s-a-t"');
      }
    } finally { await memory.close(); }
  });

  it('indexes oversized assets and preserves existing native Unicode membership with fixed-size keys', async () => {
    await repository.close();
    repository = new RocksRepository(config(path, 1));
    await repository.prepare();
    const largeAsset = 'a'.repeat(2 * 1024 * 1024);
    const loneA = '\ud800';
    const loneB = '\ud801';
    const replacement = '\ufffd';
    const boundaryPair = `${'x'.repeat(65_535)}😀`;
    const documents = [history('large-asset', floor + 1, [largeAsset]), history('lone-a', floor + 2, [loneA]),
      history('lone-b', floor + 3, [loneB]), history('replacement', floor + 4, [replacement]),
      history('astral', floor + 5, ['😀', '資産']), history('composed', floor + 6, ['é']),
      history('decomposed', floor + 7, ['é']), history('boundary-pair', floor + 8, [boundaryPair])];
    const memory = new MemoryRepository();
    try {
      await repository.upsertMany(documents);
      // Oversized ordinary assets remain selective even at the one-row cap.
      expect((await repository.query('historyElements', { ...args, filter: { module: { eq: 'liquidityProxy' }, method: { eq: 'swap' }, dataAssets: { contains: largeAsset } } })).totalCount).toBe(1);
      const stored = await repository.list('historyElements');
      expect(stored.find(document => document.id === 'lone-a')?.data.dataAssets).toEqual(['\ufffd\ufffd\ufffd']);
      expect(stored.find(document => document.id === 'lone-b')?.data.dataAssets).toEqual(['\ufffd\ufffd\ufffd']);
      // This is the established native codec behavior, authenticated against V3;
      // compare residual semantics against persisted rows, not pre-codec input.
      await memory.upsertMany(stored);
      await removeDerivedIndex();
      repository = new RocksRepository(config(path, 3));
      await repository.prepare();
      const entries = [...internal(repository).db.getRange(range(['x', 'historyElements', 's-a-t']))];
      expect(entries).toHaveLength(9);
      for (const { key } of entries) {
        expect(Array.isArray(key)).toBe(true);
        expect(typeof (key as unknown[])[3]).toBe('string');
        expect((key as unknown[])[3] === '!native-unicode-replacement-alias' || /^[A-Za-z0-9_-]{43}$/.test(String((key as unknown[])[3]))).toBe(true);
      }
      const aliasKeys = entries.filter(({ key }) => Array.isArray(key) && ['lone-a', 'lone-b', 'replacement'].includes(String(key.at(-1))));
      expect(new Set(aliasKeys.map(({ key }) => (key as unknown[])[3])).size).toBe(1);
      const boundaryKey = entries.find(({ key }) => Array.isArray(key) && key.at(-1) === 'boundary-pair')!.key as unknown[];
      expect(boundaryKey[3]).toBe(createHash('sha256').update(boundaryPair, 'utf16le').digest('base64url'));
      for (const asset of [largeAsset, loneA, loneB, replacement, '\ufffd\ufffd\ufffd', '😀', '資産', 'é', 'é', boundaryPair]) {
        const queryArgs = { ...args, filter: { module: { eq: 'liquidityProxy' }, method: { eq: 'swap' }, dataAssets: { contains: asset }, timestamp: { gt: floor } } };
        const expected = await memory.query('historyElements', queryArgs);
        const actual = await repository.query('historyElements', queryArgs);
        expect(actual.items).toEqual(expected.items);
        expect(actual.totalCount).toBe(expected.totalCount);
      }
      await repository.validateCompactIndexes();
      await repository.upsert(history('lone-a', floor + 20, ['normalized-replacement']));
      await repository.deleteMany('historyElements', ['lone-b']);
      await repository.validateCompactIndexes();
      await repository.close();
      repository = new RocksRepository(config(path, 3));
      await repository.prepare();
      for (const [asset, totalCount] of [[largeAsset, 1], ['\ufffd\ufffd\ufffd', 0], [replacement, 1]] as const) {
        expect((await repository.query('historyElements', { ...args, filter: { module: { eq: 'liquidityProxy' }, method: { eq: 'swap' }, dataAssets: { contains: asset } } })).totalCount).toBe(totalCount);
      }
      await repository.validateCompactIndexes();
    } finally { await memory.close(); }
  });

  const removeDerivedIndex = async () => {
    const db = internal(repository).db;
    await db.transaction(async (transaction) => {
      for (const entry of transaction.getRange(range(['x', 'historyElements', 's-a-t']))) await transaction.remove(entry.key);
      await transaction.remove(['m', 'metadata', ROCKSDB_SWAP_ASSET_INDEX_METADATA_KEY]);
      await transaction.put(['m', 'metadata', 'rocksdbFormatVersion'], 1);
    });
    await repository.close();
  };

  it('deduplicates native Unicode aliases while preserving cached reads, persisted membership, and update/delete keys', async () => {
    await repository.close();
    repository = new RocksRepository({ ...config(path, 1), rocksdbDocumentCacheMax: 10 });
    await repository.prepare();
    const longLone = `${'x'.repeat(80)}\ud800`;
    const document = history('aliases', floor + 1, ['\ud800', '\ud801', '\ufffd', longLone]);
    expect(rocksCompactIndexKeysForDocument(document).filter(key => key[2] === 's-a-t')).toHaveLength(1);
    await repository.upsert(document);
    expect([...internal(repository).db.getRange(range(['x', 'historyElements', 's-a-t']))]).toHaveLength(1);
    const query = (asset: string) => repository.query('historyElements', { ...args, filter: { module: { eq: 'liquidityProxy' }, method: { eq: 'swap' }, dataAssets: { contains: asset } } });
    expect((await repository.get('historyElements', 'aliases'))?.data.dataAssets).toEqual(document.data.dataAssets);
    // Existing query iteration decodes persisted rows rather than using get's cache.
    expect((await query('\ud800')).totalCount).toBe(0);
    expect((await query(longLone)).totalCount).toBe(0);
    expect((await query('\ufffd')).totalCount).toBe(1);
    await removeDerivedIndex();
    repository = new RocksRepository(config(path, 1));
    await repository.prepare();
    const stored = await repository.get('historyElements', 'aliases');
    expect(stored?.data.dataAssets).toEqual(['\ufffd\ufffd\ufffd', '\ufffd\ufffd\ufffd', '\ufffd', `${'x'.repeat(80)}\ufffd`]);
    expect([...internal(repository).db.getRange(range(['x', 'historyElements', 's-a-t']))]).toHaveLength(1);
    expect((await query('\ud800')).totalCount).toBe(0);
    expect((await query('\ufffd\ufffd\ufffd')).totalCount).toBe(1);
    expect((await query(`${'x'.repeat(80)}\ufffd`)).totalCount).toBe(1);
    await repository.validateCompactIndexes();
    await repository.upsert(history('aliases', floor + 2, ['\ufffd'], 'assets'));
    expect([...internal(repository).db.getRange(range(['x', 'historyElements', 's-a-t']))]).toHaveLength(0);
    expect((await query('\ufffd')).totalCount).toBe(0);
    await repository.upsert(history('aliases', floor + 3, ['\ufffd']));
    expect([...internal(repository).db.getRange(range(['x', 'historyElements', 's-a-t']))]).toHaveLength(1);
    await repository.deleteMany('historyElements', ['aliases']);
    expect([...internal(repository).db.getRange(range(['x', 'historyElements', 's-a-t']))]).toHaveLength(0);
    await repository.validateCompactIndexes();
    await repository.close();
    repository = new RocksRepository(config(path, 1));
    await repository.prepare();
    expect((await query('\ufffd')).totalCount).toBe(0);
  });

  it('bootstraps existing documents without changing business/checkpoint rows and resumes only committed batches after interruption', async () => {
    const documents = Array.from({ length: 300 }, (_, index) => history(`h-${String(index).padStart(4, '0')}`, floor + index));
    const checkpoint: IndexerDocument = { collection: 'updatesStreams', id: 'chainState', blockHeight: 100, timestamp: 100, data: { id: 'chainState', blockHeight: 100 } };
    await repository.upsertMany([...documents, checkpoint]);
    await removeDerivedIndex();
    repository = new RocksRepository(config(path));
    const db = internal(repository).db;
    const original = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementationOnce((callback, options) => original(callback, options))
      .mockImplementationOnce((callback, options) => original(callback, options))
      .mockImplementationOnce((callback, options) => original(async (transaction, attempt) => {
        await callback(transaction, attempt);
        throw new Error('injected interruption before second native commit');
      }, options));
    await expect(repository.prepare()).rejects.toThrow('injected interruption');
    expect(repository.formatVersion()).toBe(2);
    expect(repository.getMetadata(ROCKSDB_SWAP_ASSET_INDEX_METADATA_KEY)).toEqual({ version: 1, status: 'building', afterId: 'h-0255' });
    expect([...db.getRange(range(['x', 'historyElements', 's-a-t']))]).toHaveLength(512);
    await expect(repository.query('historyElements', args)).rejects.toThrow('prepare() first');
    await expect(repository.upsert(history('blocked', floor + 1))).rejects.toThrow('prepare() first');
    vi.restoreAllMocks();
    await repository.close();
    repository = RocksRepository.openReadOnly(config(path));
    await expect(repository.prepare()).rejects.toThrow('index is incomplete');
    await repository.close();
    repository = new RocksRepository(config(path));
    await repository.prepare();
    expect(repository.getMetadata(ROCKSDB_SWAP_ASSET_INDEX_METADATA_KEY)).toEqual({ version: 1, status: 'ready' });
    expect([...internal(repository).db.getRange(range(['x', 'historyElements', 's-a-t']))]).toHaveLength(600);
    expect(await repository.get('updatesStreams', 'chainState')).toEqual(checkpoint);
    expect(await repository.list('historyElements')).toEqual(documents);
    await repository.validateCompactIndexes();
    await repository.close();
    repository = RocksRepository.openReadOnly(config(path));
    await repository.prepare();
    expect((await repository.query('historyElements', args)).totalCount).toBe(299);
  });

  it.each([null, {}, { version: 2, status: 'ready' }, { version: 1, status: 'ready', afterId: null },
    { version: 1, status: 'building', afterId: '' }, { version: 1, status: 'building', afterId: 1 }])('fails closed on malformed progress %j', async (marker) => {
    await repository.setMetadata(ROCKSDB_SWAP_ASSET_INDEX_METADATA_KEY, marker);
    await repository.close();
    repository = new RocksRepository(config(path));
    await expect(repository.prepare()).rejects.toThrow('Malformed RocksDB swap-asset index progress marker');
  });

  it('keeps one oversized existing document atomic and stops its bootstrap batch at the retained-byte bound', async () => {
    const large = history('a-large', floor + 1);
    large.data.memo = 'x'.repeat(5 * 1024 * 1024);
    await repository.upsertMany([large, history('b-next', floor + 2)]);
    await removeDerivedIndex();
    repository = new RocksRepository(config(path));
    const db = internal(repository).db;
    const original = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementationOnce((callback, options) => original(callback, options))
      .mockImplementationOnce((callback, options) => original(callback, options))
      .mockImplementationOnce((callback, options) => original(async (transaction, attempt) => {
        await callback(transaction, attempt);
        throw new Error('injected stop after oversized document batch');
      }, options));
    await expect(repository.prepare()).rejects.toThrow('injected stop');
    expect(repository.getMetadata(ROCKSDB_SWAP_ASSET_INDEX_METADATA_KEY)).toEqual({ version: 1, status: 'building', afterId: 'a-large' });
    expect([...db.getRange(range(['x', 'historyElements', 's-a-t']))]).toHaveLength(2);
    vi.restoreAllMocks();
    await repository.close();
    repository = new RocksRepository(config(path));
    await repository.prepare();
    expect(await repository.get('historyElements', 'a-large')).toEqual(large);
    expect((await repository.query('historyElements', args)).totalCount).toBe(2);
    await repository.validateCompactIndexes();
  });

  it('fails closed when a durable resume position has no authoritative document', async () => {
    await repository.setMetadata(ROCKSDB_SWAP_ASSET_INDEX_METADATA_KEY, { version: 1, status: 'building', afterId: 'missing' });
    await repository.close();
    repository = new RocksRepository(config(path));
    await expect(repository.prepare()).rejects.toThrow('resume document is missing');
  });

  it('refuses read-only initialization and unaccounted derived keys', async () => {
    await repository.upsert(history('existing', floor + 1));
    await removeDerivedIndex();
    repository = RocksRepository.openReadOnly(config(path));
    await expect(repository.prepare()).rejects.toThrow('complete writable prepare()');
    await repository.close();
    repository = new RocksRepository(config(path));
    await internal(repository).db.put(['x', 'historyElements', 's-a-t', xor, 'orphan'], 1);
    await expect(repository.prepare()).rejects.toThrow('format 1 has unexpected');
  });

  it('atomically fences format-1 writers and refuses a missing format-2 or misplaced ready marker', async () => {
    await repository.upsert(history('existing', floor + 1));
    await removeDerivedIndex();
    repository = new RocksRepository(config(path));
    const db = internal(repository).db;
    const original = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementationOnce((callback, options) => original(async (transaction, attempt) => {
      await callback(transaction, attempt);
      throw new Error('injected interruption before atomic format transition');
    }, options));
    await expect(repository.prepare()).rejects.toThrow('injected interruption');
    expect(repository.formatVersion()).toBe(1);
    expect(repository.getMetadata(ROCKSDB_SWAP_ASSET_INDEX_METADATA_KEY)).toBeUndefined();
    expect([...db.getRange(range(['x', 'historyElements', 's-a-t']))]).toHaveLength(0);
    vi.restoreAllMocks();
    await db.put(['m', 'metadata', ROCKSDB_SWAP_ASSET_INDEX_METADATA_KEY], { version: 1, status: 'ready' });
    await expect(repository.prepare()).rejects.toThrow('format 1 has unexpected');
    await db.remove(['m', 'metadata', ROCKSDB_SWAP_ASSET_INDEX_METADATA_KEY]);
    await db.put(['m', 'metadata', 'rocksdbFormatVersion'], 2);
    await expect(repository.prepare()).rejects.toThrow('format 2 is missing');
  });

  it.each([undefined, null, {}, { version: 1, status: 'building', afterId: null },
    { version: 1, status: 'ready', afterId: null }, { version: 2, status: 'ready' }])('refuses raw artifact/audit readiness for incomplete marker %j', async (marker) => {
    await repository.upsert(history('existing', floor + 1));
    const db = internal(repository).db;
    if (marker === undefined) await db.remove(['m', 'metadata', ROCKSDB_SWAP_ASSET_INDEX_METADATA_KEY]);
    else await db.put(['m', 'metadata', ROCKSDB_SWAP_ASSET_INDEX_METADATA_KEY], marker);
    expect(rocksSwapAssetIndexIsReady(marker)).toBe(false);
    expect(() => assertCurrentRocksdbArtifactSource(db, path)).toThrow('incomplete or malformed swap-asset index');
    expect(buildRocksAuditReport(db).format).toMatchObject({ version: 2, ready: false, swapAssetIndexReady: false });
  });
});
