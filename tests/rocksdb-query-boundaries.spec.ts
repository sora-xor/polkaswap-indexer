import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readConfig } from '../src/config.js';
import { RocksRepository, rocksCompactIndexKeysForDocument } from '../src/repository/rocksdb.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { createRepositoryCursorScope } from '../src/repository/cursor.js';
import type { IndexerCollection, IndexerDocument } from '../src/repository/types.js';
let directory: string, rocks: RocksRepository, memory: MemoryRepository;
const documents: IndexerDocument[] = Array.from({ length: 5 }, (_, i) => i + 1).flatMap(i => [
  { collection: 'assets', id: `a${i}`, timestamp: i, blockHeight: i, data: { id: `a${i}`, liquidity: String(i), priceChangeDay: String(i - 3), symbol: i % 2 ? 'ODD' : 'EVEN' } },
  { collection: 'assetSnapshots', id: `a${i}`, timestamp: i, blockHeight: i, data: { id: `a${i}`, assetId: 'XOR', type: 'DAY' } },
]);
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'rocks-query-boundary-'));
  rocks = new RocksRepository({ ...readConfig(), rocksdbPath: directory, rocksdbBlockCacheMb: 16, rocksdbWriteBufferManagerMb: 16, rocksdbParallelism: 1 });
  memory = new MemoryRepository(); await rocks.prepare(); await rocks.upsertMany(documents); await memory.upsertMany(documents);
});
afterEach(async () => { await rocks.close(); await memory.close(); await rm(directory, { recursive: true, force: true }); });
const compare = async (collection: IndexerCollection, field: string, filter: any, expected: string[]) => {
  const orderBy = [`${field.replace(/[A-Z]/g, value => '_' + value).toUpperCase()}_ASC`];
  const args = { orderBy, filter, first: 20, includeTotalCount: true };
  const [actual, reference] = await Promise.all([rocks.query(collection, args), memory.query(collection, args)]);
  expect(actual.items.map(row => row.id)).toEqual(expected); expect(actual.items).toEqual(reference.items); expect(actual.totalCount).toBe(reference.totalCount);
};

describe('RocksDB intersecting compact numeric bounds', () => {
  for (const [collection, field] of [['assets', 'liquidity'], ['assetSnapshots', 'timestamp'], ['assetSnapshots', 'blockHeight']] as const) {
    const bounded = (conditions: any[]) => ({ and: [...(collection === 'assetSnapshots' ? [{ assetId: { equalTo: 'XOR' }, type: { equalTo: 'DAY' } }] : []), ...conditions.map(condition => ({ [field]: condition }))] });
    it.each([
      [[{ gte: 1 }, { gte: 3 }], ['a3', 'a4', 'a5']], [[{ gte: 3 }, { gte: 1 }], ['a3', 'a4', 'a5']],
      [[{ gte: 3 }, { gt: 3 }], ['a4', 'a5']], [[{ gt: 3 }, { gte: 3 }], ['a4', 'a5']],
      [[{ lte: 5 }, { lte: 3 }], ['a1', 'a2', 'a3']], [[{ lte: 3 }, { lte: 5 }], ['a1', 'a2', 'a3']],
      [[{ lte: 3 }, { lt: 3 }], ['a1', 'a2']], [[{ lt: 3 }, { lte: 3 }], ['a1', 'a2']],
      [[{ eq: 3 }, { gte: 2 }], ['a3']], [[3, { lte: 4 }], ['a3']], [[{ gte: 4 }, { lte: 2 }], []],
    ])(`${collection} ${field} intersects %# in either bound order`, async (conditions, expected) => {
      await compare(collection, field, bounded(conditions as any[]), expected as string[]);
    });
    it(`${collection} ${field} recurses through a singleton OR without widening its range`, async () => {
      await compare(collection, field, { or: [bounded([{ gt: 2 }, { lt: 5 }])] }, ['a3', 'a4']);
    });
  }
  it('keeps exact negative bounds distinct from zero', async () => {
    await compare('assets', 'priceChangeDay', { and: [{ priceChangeDay: { gte: '-2' } }, { priceChangeDay: { gt: '-1' } }, { priceChangeDay: { lte: '0' } }] }, ['a3']);
  });
  it('preserves last-window pagination with an inclusive upper range', async () => {
    const args = { last: 2, filter: { assetId: { equalTo: 'XOR' }, type: { equalTo: 'DAY' }, timestamp: { lte: 4 } }, orderBy: ['TIMESTAMP_ASC'], includeTotalCount: true };
    const result = await rocks.query('assetSnapshots', args);
    expect(result.items.map(row => row.id)).toEqual(['a3', 'a4']); expect(result.totalCount).toBe(4);
  });
  it('preserves tail pagination across a union of compact equality sources', async () => {
    const args = { last: 2, filter: { or: [{ assetId: { equalTo: 'XOR' } }, { type: { equalTo: 'DAY' } }] }, orderBy: ['TIMESTAMP_ASC'], includeTotalCount: true };
    const [actual, expected] = await Promise.all([rocks.query('assetSnapshots', args), memory.query('assetSnapshots', args)]);
    expect(actual.items).toEqual(expected.items); expect(actual.items.map(row => row.id)).toEqual(['a4', 'a5']);
  });
});

describe('RocksDB lifecycle and metadata rejection', () => {
  it.each([-1, 1.5, 'invalid'])('rejects corrupt prefix count %s before emitting a counted query', async value => {
    const document = documents.find(d => d.collection === 'assetSnapshots')!;
    for (const key of rocksCompactIndexKeysForDocument(document).filter(key => key[0] === 'x')) {
      await (rocks as any).db.put(['m', 'indexCount', ...key.slice(1, -2)], value);
    }
    await expect(rocks.query('assetSnapshots', { first: 1, orderBy: ['TIMESTAMP_ASC'], filter: { assetId: { equalTo: 'XOR' }, type: { equalTo: 'DAY' } } })).rejects.toThrow(/corrupt.*prefix count/);
  });
  it.each([0, -1, 1.5, 'invalid'])('rolls back deletion when a prefix count %s is unusable', async value => {
    const document = documents.find(d => d.collection === 'assetSnapshots')!;
    for (const key of rocksCompactIndexKeysForDocument(document).filter(key => key[0] === 'x')) {
      await (rocks as any).db.put(['m', 'indexCount', ...key.slice(1, -2)], value);
    }
    await expect(rocks.deleteMany('assetSnapshots', [document.id])).rejects.toThrow(/underflow/);
    expect(await rocks.get('assetSnapshots', document.id)).toEqual(document);
  });
  it('rejects a corrupt live prefix count during validation', async () => {
    const document = documents.find(d => d.collection === 'assetSnapshots')!;
    for (const key of rocksCompactIndexKeysForDocument(document).filter(key => key[0] === 'x')) {
      await (rocks as any).db.put(['m', 'indexCount', ...key.slice(1, -2)], 999);
    }
    await expect(rocks.validateCompactIndexes()).rejects.toThrow(/prefix count/);
  });
  it('reports health only while the prepared native database is open', async () => {
    expect(await rocks.healthCheck()).toBe(true); await rocks.close(); expect(await rocks.healthCheck()).toBe(false);
    await expect(rocks.prepare()).rejects.toThrow(/closing/); await expect(rocks.validateCompactIndexes()).rejects.toThrow(/closing/);
  });
  it('coalesces simultaneous preparation and exhaustive index validation', async () => {
    await Promise.all([rocks.prepare(), rocks.prepare()]); await Promise.all([rocks.validateCompactIndexes(), rocks.validateCompactIndexes()]);
    expect(await rocks.get('assets', 'a1')).toMatchObject({ id: 'a1' });
  });
  it('treats empty batch operations as no-ops', async () => {
    expect(await rocks.getMany('assets', [])).toEqual(new Map()); await rocks.upsertMany([]); await rocks.deleteMany('assets', []);
    expect((await rocks.query('assets', { first: 0 })).totalCount).toBe(5);
  });
  it('returns no watch events for an already aborted observer', async () => {
    const controller = new AbortController(); controller.abort(); const iterator = rocks.watch('assets', ['a1'], controller.signal)[Symbol.asyncIterator]();
    expect(await iterator.next()).toMatchObject({ done: true });
  });
  it.each([0, -1, 1.5, 'bad'])('rejects corrupt collection counts %s during exhaustive validation', async value => {
    await (rocks as any).db.put(['m', 'count', 'assets'], value);
    await expect(rocks.validateCompactIndexes()).rejects.toThrow(/count metadata/);
    expect(await rocks.get('assets', 'a1')).toMatchObject({ id: 'a1' });
  });
  it('rejects an index prefix count underflow without replacing the source document', async () => {
    const document = documents.find(d => d.collection === 'assetSnapshots' && d.id === 'a1')!;
    const keys = rocksCompactIndexKeysForDocument(document).filter(key => key[0] === 'x');
    for (const key of keys) await (rocks as any).db.put(['m', 'indexCount', ...key.slice(1, -2)], 0);
    await expect(rocks.upsert({ ...document, timestamp: 6, blockHeight: 6, data: { ...document.data, assetId: 'VAL' } })).rejects.toThrow(/underflow/);
    expect(await rocks.get('assetSnapshots', 'a1')).toEqual(document);
  });
  it('rejects mismatched collection counts during exhaustive validation', async () => {
    await (rocks as any).db.put(['m', 'count', 'assets'], 100); await expect(rocks.validateCompactIndexes()).rejects.toThrow(/count metadata/);
  });
  it('rejects malformed primary keys during exhaustive validation', async () => {
    await (rocks as any).db.put(['d', 'assets', 7], [2, null, null, 0, {}]); await expect(rocks.validateCompactIndexes()).rejects.toThrow(/malformed document key/);
  });
  it.each([['m', 'indexCount', 'invalid', 't'], ['m', 'indexCount', 'assets', 3]].map(key => [key]))('rejects malformed prefix count keys %#', async key => {
    await (rocks as any).db.put(key, 1); await expect(rocks.validateCompactIndexes()).rejects.toThrow(/malformed prefix count/);
  });
  it('rejects stale extra prefix counters after validating all live indexes', async () => {
    await (rocks as any).db.put(['m', 'indexCount', 'assets', 'phantom'], 1); await expect(rocks.validateCompactIndexes()).rejects.toThrow(/prefix counts but found/);
  });
});

describe('RocksDB pagination fallback parity', () => {
  it.each([
    { last: 2, orderBy: ['ID_ASC'] },
    { last: 2, orderBy: ['SYMBOL_ASC'] },
    { last: 2, orderBy: ['LIQUIDITY_ASC'], filter: { symbol: { equalTo: 'ODD' } } },
    { first: 4, last: 2, orderBy: ['SYMBOL_DESC'] },
    { first: 2, orderBy: ['SYMBOL_ASC'], seek: { field: 'timestamp', value: 2, id: 'a2' } },
    { first: 2, orderBy: ['TIMESTAMP_ASC'], filter: { or: [{ assetId: { equalTo: 'XOR' } }, { type: { equalTo: 'DAY' } }] }, seek: { field: 'timestamp', value: 2, id: 'a2' } },
    { last: 2, orderBy: ['BLOCK_HEIGHT_DESC'], filter: { or: [{ assetId: { equalTo: 'XOR' } }, { type: { equalTo: 'DAY' } }] } },
  ])('matches reference rows for bounded page %#', async args => {
    const collection = args.filter && 'or' in args.filter ? 'assetSnapshots' : 'assets';
    const [actual, expected] = await Promise.all([rocks.query(collection, args as any), memory.query(collection, args as any)]);
    expect(actual.items.map(d => d.id)).toEqual(expected.items.map(d => d.id));
  });
  it.each([true, false, 7, 'Trade'])('round-trips a compact equality value %s through the persistent index', async status => {
    const rows: IndexerDocument[] = [{ collection: 'orderBooks', id: 'book', timestamp: 1, blockHeight: 1, data: { baseAssetId: 'base', status } }];
    await rocks.upsertMany(rows); await memory.upsertMany(rows);
    const args = { first: 10, orderBy: ['ID_ASC'], filter: { baseAssetId: { equalTo: 'base' }, status: { equalTo: status } } };
    const [actual, expected] = await Promise.all([rocks.query('orderBooks', args), memory.query('orderBooks', args)]);
    expect(actual.items).toEqual(expected.items); expect(actual.items).toHaveLength(1);
  });
  it('continues a signed fractional numeric order without rounding its cursor value', async () => {
    const extra: IndexerDocument = { collection: 'assets', id: 'fraction', timestamp: 6, blockHeight: 6, data: { priceChangeDay: '-0.125' } };
    await rocks.upsert(extra); await memory.upsert(extra);
    const args = { first: 10, orderBy: ['PRICE_CHANGE_DAY_ASC'], keyset: { scope: createRepositoryCursorScope('assets', ['PRICE_CHANGE_DAY_ASC'], undefined), field: 'priceChangeDay', direction: 'asc', numeric: true, value: '-0.5', id: 'cursor' } } as const;
    const [actual, expected] = await Promise.all([rocks.query('assets', { ...args, orderBy: [...args.orderBy] }), memory.query('assets', { ...args, orderBy: [...args.orderBy] })]);
    expect(actual.items).toEqual(expected.items); expect(actual.items[0]?.id).toBe('fraction');
  });
});
