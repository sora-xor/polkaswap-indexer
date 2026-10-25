import { graphql } from 'graphql';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readConfig } from '../src/config.js';
import { createSchema } from '../src/graphql/resolvers.js';
import { validatePublicConnectionQuery } from '../src/graphql/query-policy.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { RocksRepository } from '../src/repository/rocksdb.js';
import { metrics } from '../src/metrics.js';

import type { IndexerDocument, IndexerRepository } from '../src/repository/types.js';

const assets: IndexerDocument[] = [
  { collection: 'assets', id: 'a', data: { id: 'a', priceUSD: '1', supply: '100', liquidity: '10', liquidityBooks: '0', priceChangeDay: -2.5, priceChangeWeek: 1, volumeDayUSD: '10', volumeWeekUSD: '100', velocity: 0.1 } },
  { collection: 'assets', id: 'b', data: { id: 'b', priceUSD: '2', supply: '200', liquidity: '20', liquidityBooks: '5', priceChangeDay: 3.5, priceChangeWeek: -2, volumeDayUSD: '20', volumeWeekUSD: '200', velocity: 0.2 } },
  { collection: 'assets', id: 'c', data: { id: 'c', priceUSD: '2', supply: '300', liquidity: '0', liquidityBooks: '10', priceChangeDay: -1, priceChangeWeek: 0, volumeDayUSD: '0', volumeWeekUSD: '50', velocity: 0.3 } },
  { collection: 'assets', id: 'd', data: { id: 'd', priceUSD: '10', supply: '400', liquidity: '5', liquidityBooks: '0', priceChangeDay: 0, priceChangeWeek: 2, volumeDayUSD: '30', volumeWeekUSD: '300', velocity: 0.4 } },
  { collection: 'assets', id: 'e', data: { id: 'e', priceUSD: null, supply: '500', liquidity: '1', liquidityBooks: '0', priceChangeDay: -9, priceChangeWeek: -3, volumeDayUSD: '5', volumeWeekUSD: '20', velocity: 0.5 } },
  { collection: 'assets', id: 'f', data: { id: 'f', supply: '600', volumeDayUSD: '40', volumeWeekUSD: '400', priceChangeDay: 1, priceChangeWeek: 4, velocity: 0.6 } },
];

const query = `query($first: Int, $after: Cursor, $orderBy: [OrderBy!], $filter: AssetFilter) {
  assets(first: $first, after: $after, orderBy: $orderBy, filter: $filter) {
    nodes { id } totalCount pageInfo { endCursor hasNextPage hasPreviousPage }
  }
}`;

const execute = (repository: IndexerRepository, variables: Record<string, unknown>) =>
  graphql({ schema: createSchema(), source: query, variableValues: variables, contextValue: { repository } });

const connection = (data: unknown) => (data as {
  assets: { nodes: Array<{ id: string }>; totalCount: number; pageInfo: { endCursor: string | null; hasNextPage: boolean; hasPreviousPage: boolean } };
}).assets;

describe('bounded declared Asset public query features', () => {
  let directory: string;
  let memory: MemoryRepository;
  let native: RocksRepository;
  const config = (path: string, budget = 100_000) => ({
    ...readConfig(), storageEngine: 'rocksdb' as const, rocksdbPath: path,
    rocksdbBlockCacheMb: 2, rocksdbWriteBufferManagerMb: 2, rocksdbParallelism: 1,
    rocksdbDocumentCacheMax: 0, rocksdbQueryMaxScannedRows: budget,
  });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'polkaswap-asset-query-'));
    memory = new MemoryRepository();
    native = new RocksRepository(config(join(directory, 'assets.rocksdb')));
    await native.prepare();
    await memory.upsertMany(assets);
    await native.upsertMany(assets);
  });

  afterEach(async () => {
    await native.close();
    await memory.close();
    await rm(directory, { recursive: true, force: true });
  });

  it.each([
    ['PRICE_USD_ASC', ['a', 'b', 'c', 'd', 'e', 'f']],
    ['PRICE_USD_DESC', ['f', 'e', 'd', 'c', 'b', 'a']],
    ['LIQUIDITY_DESC', ['f', 'b', 'a', 'd', 'e', 'c']],
    ['LIQUIDITY_BOOKS_DESC', ['f', 'c', 'b', 'e', 'd', 'a']],
    ['VOLUME_DAY_USD_DESC', ['f', 'd', 'b', 'a', 'e', 'c']],
    ['VOLUME_WEEK_USD_ASC', ['e', 'c', 'a', 'b', 'd', 'f']],
    ['PRICE_CHANGE_DAY_ASC', ['e', 'a', 'c', 'd', 'f', 'b']],
    ['PRICE_CHANGE_WEEK_ASC', ['e', 'b', 'c', 'a', 'd', 'f']],
    ['SUPPLY_DESC', ['f', 'e', 'd', 'c', 'b', 'a']],
    ['VELOCITY_ASC', ['a', 'b', 'c', 'd', 'e', 'f']],
  ])('preserves complete order/count across opaque pages for %s', async (orderBy, expected) => {
    for (const repository of [memory, native]) {
      const ids: string[] = [];
      let after: string | null = null;
      do {
        const result = await execute(repository, { first: 2, orderBy: [orderBy], after });
        expect(result.errors).toBeUndefined();
        const page = connection(result.data);
        expect(page.totalCount).toBe(6);
        expect(page.pageInfo.hasPreviousPage).toBe(after !== null);
        ids.push(...page.nodes.map((node) => node.id));
        if (!page.pageInfo.hasNextPage) break;
        expect(page.nodes).toHaveLength(2);
        expect(page.pageInfo.endCursor).not.toBe(after);
        after = page.pageInfo.endCursor;
        expect(ids.length).toBeLessThan(7);
      } while (true);
      expect(ids).toEqual(expected);
    }
  });

  it.each([
    [{ volumeDayUSD: { greaterThan: '0' } }, ['a', 'b', 'd', 'e', 'f']],
    [{ priceChangeDay: { lessThan: '-1' } }, ['a', 'e']],
    [{ supply: { greaterThanOrEqualTo: '300' }, velocity: { lessThan: '0.5' } }, ['c', 'd']],
    [{ volumeDayUSD: { notEqualTo: '0' }, volumeWeekUSD: { notIn: ['100', '300'] } }, ['b', 'e', 'f']],
    [{ id: { notEqualTo: 'a', notIn: ['c', 'e'] } }, ['b', 'd', 'f']],
    [{ or: [{ priceChangeWeek: { lessThan: '0' } }, { volumeDayUSD: { gt: '30' } }] }, ['b', 'e', 'f']],
  ])('executes typed residual filters with exact data/count on both repositories: %j', async (filter, expected) => {
    for (const repository of [memory, native]) {
      const result = await execute(repository, { first: 10, orderBy: ['ID_ASC'], filter });
      expect(result.errors).toBeUndefined();
      expect(connection(result.data).nodes.map((node) => node.id)).toEqual(expected);
      expect(connection(result.data).totalCount).toBe(expected.length);
      expect(connection(result.data).pageInfo.hasNextPage).toBe(false);
    }
  });

  it('retains native indexed price sorting and active-asset eligibility sources', async () => {
    const price = await execute(native, { first: 10, orderBy: ['PRICE_USD_DESC'], filter: { volumeDayUSD: { gt: '0' } } });
    expect(price.errors).toBeUndefined();
    expect(connection(price.data).nodes.map((node) => node.id)).toEqual(['f', 'e', 'd', 'b', 'a']);
    expect(metrics.render()).toContain('collection="assets",source="x:num"');
    const active = await execute(native, { first: 10, orderBy: ['ID_ASC'], filter: { or: [{ liquidity: { gt: '0' } }, { liquidityBooks: { gt: '0' } }] } });
    expect(active.errors).toBeUndefined();
    expect(connection(active.data).nodes.map((node) => node.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(metrics.render()).toContain('collection="assets",source="x:assets-active-id"');
  });

  it('fails closed at the existing configured native scan cap for fallback and indexed residual count scans', async () => {
    await native.close();
    native = new RocksRepository(config(join(directory, 'capped.rocksdb'), 2));
    await native.prepare();
    await native.upsertMany(assets.slice(0, 3));
    for (const orderBy of ['ID_ASC', 'VOLUME_DAY_USD_DESC', 'PRICE_USD_DESC']) {
      const result = await execute(native, { first: 1, orderBy: [orderBy], filter: { volumeDayUSD: { gte: '0' } } });
      expect(result.errors?.some((error) => /2 row scan limit/.test(error.message))).toBe(true);
      expect(result.data).toBeNull();
    }
  });

  it('refuses malformed or undocumented Asset queries before repository work', async () => {
    const work = vi.spyOn(memory, 'query');
    for (const variables of [
      { filter: { volumeDayUSD: { gt: true } } },
      { filter: { priceChangeDay: { lessThan: 'NaN' } } },
      { filter: { volumeDayUSD: { includesInsensitive: '1' } } },
      { filter: { volumeDayUSD: { notIn: ['1', false] } } },
      { filter: { id: { notIn: [] } } },
      { filter: { unknown: { equalTo: 'x' } } },
      { filter: { or: [] } },
      { orderBy: ['TIMESTAMP_DESC'] },
      { orderBy: ['LABEL_ASC'], filter: { id: { equalTo: 'a' } } },
      { orderBy: ['LIQUIDITY_USD_DESC'] },
      { first: -1 },
    ]) {
      const result = await execute(memory, { first: 2, orderBy: ['ID_ASC'], ...variables });
      expect(result.errors?.length).toBeGreaterThan(0);
      expect(result.errors?.[0]?.extensions.code).toBe('BAD_USER_INPUT');
    }
    expect(work).not.toHaveBeenCalled();
  });

  it('retains cursor scope, response-byte bounds and high-volume collection policy', async () => {
    const first = await execute(native, { first: 2, orderBy: ['VOLUME_DAY_USD_DESC'], filter: { volumeDayUSD: { gt: '0' } } });
    const next = await execute(native, { first: 2, orderBy: ['VOLUME_DAY_USD_DESC'], filter: { volumeDayUSD: { gt: '10' } }, after: connection(first.data).pageInfo.endCursor });
    expect(next.errors?.[0]?.extensions.code).toBe('BAD_USER_INPUT');
    const limited = await graphql({ schema: createSchema({ ...readConfig(), graphqlMaxResultBytes: 1 }), source: query, variableValues: { first: 6, orderBy: ['VOLUME_DAY_USD_DESC'] }, contextValue: { repository: native } });
    expect(limited.errors).toBeUndefined();
    expect(connection(limited.data).nodes).toHaveLength(1);
    expect(connection(limited.data).totalCount).toBe(6);
    expect(connection(limited.data).pageInfo.hasNextPage).toBe(true);
    expect(() => validatePublicConnectionQuery('historyElements', ['TIMESTAMP_DESC'], undefined)).toThrow();
    expect(() => validatePublicConnectionQuery('assetSnapshots', ['PRICE_USD_DESC'], undefined)).toThrow();
    expect(() => validatePublicConnectionQuery('historyElements', ['TIMESTAMP_DESC'], { id: { notEqualTo: 'x' } })).toThrow();
    expect(() => validatePublicConnectionQuery('markets', ['ID_ASC'], { volumeUSD: { notIn: ['0'] } })).toThrow();
  });
});
