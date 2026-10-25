import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { graphql } from 'graphql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSchema } from '../src/graphql/resolvers.js';
import { decodeRepositoryCursor } from '../src/repository/cursor.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { RocksRepository } from '../src/repository/rocksdb.js';
import type { AppConfig } from '../src/config.js';
import type { IndexerDocument } from '../src/repository/types.js';

const config = (rocksdbPath: string, rocksdbQueryMaxScannedRows = 10_000): AppConfig => ({
  rocksdbPath, rocksdbQueryMaxScannedRows, rocksdbBlockCacheMb: 8,
  rocksdbWriteBufferManagerMb: 8, rocksdbParallelism: 1, rocksdbEnableStats: false,
  rocksdbDocumentCacheMax: 0, rocksdbDocumentCacheMaxBytes: 0, rocksdbWatchQueueMax: 100,
} as AppConfig);

const asset = (index: number, payload = ''): IndexerDocument => {
  const id = `asset-${String(index).padStart(3, '0')}`;
  return { collection: 'assets', id, data: { id, priceUSD: '1', liquidity: '1', liquidityBooks: '0', payload } };
};
const snapshot = (index: number, payload = ''): IndexerDocument => {
  const id = `snapshot-${String(index).padStart(3, '0')}`;
  const timestamp = Math.floor(index / 2);
  return { collection: 'assetSnapshots', id, timestamp, blockHeight: index, data: { id, timestamp, assetId: 'xor', type: 'DAY', payload } };
};

describe('deployed legacy pagination compatibility', () => {
  const schema = createSchema();
  let repository: MemoryRepository;
  beforeEach(async () => {
    repository = new MemoryRepository();
    await repository.upsertMany(Array.from({ length: 150 }, (_, index) => asset(index)));
  });
  const execute = (args: string, variables?: Record<string, unknown>) => graphql({
    schema, source: `query($after: Cursor) { assets(${args}, orderBy: [ID_ASC]) { nodes { id } edges { cursor } totalCount pageInfo { hasNextPage hasPreviousPage } } }`,
    variableValues: variables, contextValue: { repository },
  });

  it('restores connection arguments without narrowing newer types', () => {
    for (const field of ['assets', 'assetSnapshots', 'accountLiquiditySnapshots', 'markets', 'marketSnapshots', 'networkSnapshots', 'poolXYKs', 'poolSnapshots', 'orderBooks', 'orderBookOrders', 'orderBookSnapshots', 'historyElements', 'xorBurns', 'referrerRewards', 'stakingStakers', 'stakingValidators', 'vaults', 'vaultEvents', 'accountPointSystems', 'accountPositions', 'accountTrades']) {
      expect(schema.getQueryType()!.getFields()[field]!.args.map(({ name }) => name)).toEqual(expect.arrayContaining(['first', 'last', 'offset', 'after', 'before']));
    }
    expect(schema.getType('UInt32')).toBeDefined();
  });

  it('takes last alone from the whole connection rather than the first default page', async () => {
    const result = await execute('last: 2, after: $after', { after: '' });
    expect(result.errors).toBeUndefined();
    expect(result.data?.assets).toMatchObject({ nodes: [{ id: 'asset-148' }, { id: 'asset-149' }], totalCount: 150, pageInfo: { hasNextPage: false, hasPreviousPage: true } });
  });

  it('applies last to the first window after an explicit offset', async () => {
    const result = await execute('first: 5, last: 2, offset: 1, after: $after', { after: '' });
    expect(result.errors).toBeUndefined();
    expect(result.data?.assets).toMatchObject({ nodes: [{ id: 'asset-004' }, { id: 'asset-005' }], pageInfo: { hasNextPage: true, hasPreviousPage: true } });
  });

  it.each(['2', 2])('accepts the old safe numeric after variable %s and returns opaque cursors', async (after) => {
    const result = await execute('first: 2, after: $after', { after });
    expect(result.errors).toBeUndefined();
    expect(result.data?.assets).toMatchObject({ nodes: [{ id: 'asset-003' }, { id: 'asset-004' }], edges: [{ cursor: expect.stringMatching(/^psc2\./) }, { cursor: expect.stringMatching(/^psc2\./) }] });
  });

  it('accepts numeric literals and keeps before as the original no-op', async () => {
    const result = await graphql({ schema, source: '{ assets(first: 1, after: 2, before: "ignored-baseline-value", orderBy: [ID_ASC]) { nodes { id } } }', contextValue: { repository } });
    expect(result.errors).toBeUndefined();
    expect(result.data?.assets).toMatchObject({ nodes: [{ id: 'asset-003' }] });
  });

  it('keeps explicit offset precedence over a valid legacy numeric after', async () => {
    const result = await execute('first: 1, offset: 5, after: $after', { after: '2' });
    expect(result.errors).toBeUndefined();
    expect(result.data?.assets).toMatchObject({ nodes: [{ id: 'asset-005' }] });
  });

  it.each(['-1', '+1', '01', '1.5', '1e2', ' 1', '100000', '9007199254740992', 'not-a-cursor'])('rejects malformed or unbounded numeric cursor %s before repository execution', async (after) => {
    const query = vi.spyOn(repository, 'query');
    const result = await execute('first: 1, after: $after', { after });
    expect(result.errors).toBeDefined();
    expect(query).not.toHaveBeenCalled();
  });

  it.each(['first: 101', 'last: 101', 'last: -1', 'offset: 100001, first: 0', 'offset: 99999, first: 2'])('retains page and offset limits for %s', async (args) => {
    const result = await execute(`${args}, after: $after`, { after: '' });
    expect(result.errors).toBeDefined();
  });

  it('still rejects opaque cursor replay across order and filter scopes', async () => {
    const page = await execute('first: 1, after: $after', { after: '' });
    const after = (page.data?.assets as { edges: Array<{ cursor: string }> }).edges[0]!.cursor;
    for (const args of ['orderBy: [ID_DESC]', 'orderBy: [ID_ASC], filter: { id: { equalTo: "asset-001" } }']) {
      const result = await graphql({ schema, source: `query($after: Cursor) { assets(first: 1, after: $after, ${args}) { nodes { id } } }`, variableValues: { after }, contextValue: { repository } });
      expect(result.errors?.[0]?.message).toMatch(/cursor does not match/);
    }
  });
});

describe('bounded RocksDB tails on existing indexes', () => {
  let directory: string;
  let repository: RocksRepository;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'legacy-pagination-'));
    repository = new RocksRepository(config(join(directory, 'indexer')));
    await repository.prepare();
  });
  afterEach(async () => {
    await repository.close();
    await rm(directory, { recursive: true, force: true });
  });

  it.each(['ASC', 'DESC'])('preserves indexed timestamp ties and output order for last-only %s', async (direction) => {
    await repository.upsertMany(Array.from({ length: 8 }, (_, index) => snapshot(index)));
    const expected = direction === 'ASC' ? ['snapshot-006', 'snapshot-007'] : ['snapshot-001', 'snapshot-000'];
    const page = await repository.query('assetSnapshots', { last: 2, orderBy: [`TIMESTAMP_${direction}`], filter: { assetId: { equalTo: 'xor' }, type: { equalTo: 'DAY' } }, includeTotalCount: true });
    expect(page.items.map(({ id }) => id)).toEqual(expected);
    expect(page).toMatchObject({ totalCount: 8, pageStart: 6, hasNextPage: false, hasPreviousPage: true });
    expect(decodeRepositoryCursor(page.itemCursors![0])?.direction).toBe(direction.toLowerCase());
  });

  it('uses a bounded reverse index walk for a large last-only connection', async () => {
    await repository.close();
    repository = new RocksRepository(config(join(directory, 'bounded'), 5));
    await repository.prepare();
    await repository.upsertMany(Array.from({ length: 300 }, (_, index) => asset(index)));
    const page = await repository.query('assets', { last: 3, orderBy: ['ID_ASC'], includeTotalCount: false });
    expect(page.items.map(({ id }) => id)).toEqual(['asset-297', 'asset-298', 'asset-299']);
    expect(page.hasNextPage).toBe(false);
  });

  it.each([[], undefined])('uses the effective default ID order for an empty or omitted native order (%j)', async (orderBy) => {
    await repository.upsertMany(Array.from({ length: 150 }, (_, index) => asset(index)));
    const tail = await repository.query('assets', { last: 2, orderBy, includeTotalCount: false });
    expect(tail.items.map(({ id }) => id)).toEqual(['asset-148', 'asset-149']);
    expect(decodeRepositoryCursor(tail.itemCursors![0])?.direction).toBe('asc');
    for (const window of [{ last: 0 }, { first: 0, last: 2 }]) {
      expect((await repository.query('assets', { ...window, orderBy })).items).toEqual([]);
    }
  });

  it.each(['orderBy: [],', ''])('executes GraphQL last-only in the effective default order (%s)', async (order) => {
    await repository.upsertMany(Array.from({ length: 150 }, (_, index) => asset(index)));
    const schema = createSchema();
    const tail = await graphql({ schema, source: `{ assets(${order} last: 2) { nodes { id } pageInfo { endCursor } } }`, contextValue: { repository } });
    expect(tail.errors).toBeUndefined();
    expect(tail.data?.assets).toMatchObject({ nodes: [{ id: 'asset-148' }, { id: 'asset-149' }] });
    const empty = await graphql({ schema, source: `{ assets(${order} last: 0) { nodes { id } pageInfo { endCursor } } }`, contextValue: { repository } });
    expect(empty.errors).toBeUndefined();
    expect(empty.data?.assets).toMatchObject({ nodes: [], pageInfo: { endCursor: null } });
  });

  it.each([['ID_ASC', null], ['PRICE_USD_ASC', { id: { in: ['asset-000', 'asset-001', 'asset-002', 'asset-003'] } }]] as const)('does not charge discarded leading payloads to first+last (%s)', async (orderBy, filter) => {
    await repository.upsertMany([asset(0, 'x'.repeat(20_000)), asset(1, 'x'.repeat(20_000)), asset(2), asset(3)]);
    const page = await repository.query('assets', { first: 4, last: 2, orderBy: [orderBy], filter, maxBytes: 4_096 });
    expect(page.items.map(({ id }) => id)).toEqual(['asset-002', 'asset-003']);
    expect(page).toMatchObject({ totalCount: 4, hasNextPage: false, hasPreviousPage: true });
  });

  it('applies the byte budget to the selected tail while retaining one oversized row for progress', async () => {
    await repository.upsertMany([asset(0), asset(1, 'x'.repeat(2_000)), asset(2)]);
    const page = await repository.query('assets', { last: 2, orderBy: ['ID_ASC'], maxBytes: 1_024 });
    expect(page.items.map(({ id }) => id)).toEqual(['asset-001']);
    expect(page).toMatchObject({ totalCount: 3, hasNextPage: true, hasPreviousPage: true });
  });

  it.each(['ASC', 'DESC'])('preserves numeric positions, explicit offsets and short first+last windows in %s', async (direction) => {
    await repository.upsertMany(Array.from({ length: 7 }, (_, index) => asset(index)));
    const ids = Array.from({ length: 7 }, (_, index) => asset(index).id);
    if (direction === 'DESC') ids.reverse();
    for (const position of [{ after: '2' }, { offset: 3 }]) {
      const page = await repository.query('assets', { ...position, first: 5, last: 2, orderBy: [`ID_${direction}`] });
      expect(page.items.map(({ id }) => id)).toEqual(ids.slice(5));
      expect(page).toMatchObject({ pageStart: 5, hasNextPage: false, hasPreviousPage: true });
      const tail = await repository.query('assets', { ...position, last: 100, orderBy: [`ID_${direction}`], includeTotalCount: false });
      expect(tail.items.map(({ id }) => id)).toEqual(ids.slice(3));
    }
  });

  it('keeps a scoped opaque anchor in last-only reverse traversal', async () => {
    await repository.upsertMany(Array.from({ length: 6 }, (_, index) => asset(index)));
    const first = await repository.query('assets', { first: 4, orderBy: ['ID_ASC'], includeTotalCount: false });
    const tail = await repository.query('assets', { last: 3, keyset: decodeRepositoryCursor(first.itemCursors![3]), orderBy: ['ID_ASC'], includeTotalCount: false });
    expect(tail.items.map(({ id }) => id)).toEqual(['asset-004', 'asset-005']);
    expect(tail).toMatchObject({ hasNextPage: false, hasPreviousPage: true });
  });

  it('keeps fallback tails bounded and exact for null values and tied IDs', async () => {
    await repository.upsertMany(['a', 'b', 'c', 'd'].map((id, index) => ({ collection: 'assets', id, data: { id, label: index < 2 ? 'same' : null, payload: 'x'.repeat(2_000) } })));
    const page = await repository.query('assets', { last: 2, orderBy: ['LABEL_ASC'], maxBytes: 1_024 });
    expect(page.items.map(({ id }) => id)).toEqual(['c']);
    expect(page).toMatchObject({ totalCount: 4, hasNextPage: true, hasPreviousPage: true });
  });
});
