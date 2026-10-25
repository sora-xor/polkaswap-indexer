import { graphql } from 'graphql';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readConfig } from '../src/config.js';
import { finiteNumberToPlainDecimal } from '../src/decimal-number.js';
import { compareDecimalValues, compareOrderValues, normalizeDecimal } from '../src/graphql/filter.js';
import { validatePublicConnectionQuery } from '../src/graphql/query-policy.js';
import { createSchema } from '../src/graphql/resolvers.js';
import { metrics } from '../src/metrics.js';
import {
  createRepositoryCursorScope,
  decodeRepositoryCursor,
  encodeRepositoryCursor,
  normalizeRepositoryCursorValue,
} from '../src/repository/cursor.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { RocksRepository } from '../src/repository/rocksdb.js';
import { assertValidIndexedDecimal } from '../src/repository/validation.js';

import type { IndexerDocument, IndexerRepository } from '../src/repository/types.js';

describe('finite Number decimal read representation', () => {
  it.each([
    [1e-7, '0.0000001'], [-1.25e-7, '-0.000000125'],
    [1.234e21, '1234000000000000000000'], [-1e21, '-1000000000000000000000'],
    [0, '0'], [-0, '0'], [12.5, '12.5'],
  ])('preserves the Number representation of %s in comparisons and cursors', (value, plain) => {
    expect(finiteNumberToPlainDecimal(value)).toBe(plain);
    expect(compareDecimalValues(value, plain) === 0).toBe(true);
    expect(normalizeRepositoryCursorValue(value, true)).toBe(plain);
    const keyset = {
      scope: createRepositoryCursorScope('assets', ['VELOCITY_ASC'], null),
      field: 'velocity', direction: 'asc' as const, numeric: true, value: plain, id: 'a',
    };
    expect(decodeRepositoryCursor(encodeRepositoryCursor(keyset))).toEqual(keyset);
  });

  it('bounds expansion to IEEE Number exponents and keeps the existing cursor digit cap', () => {
    const minimum = `0.${'0'.repeat(323)}5`;
    expect(finiteNumberToPlainDecimal(Number.MIN_VALUE)).toBe(minimum);
    expect(Number(minimum)).toBe(Number.MIN_VALUE);
    const maximum = finiteNumberToPlainDecimal(Number.MAX_VALUE)!;
    expect(maximum).toMatch(/^[0-9]{309}$/);
    expect(Number(maximum)).toBe(Number.MAX_VALUE);
    for (const value of [minimum, maximum]) {
      expect(() => encodeRepositoryCursor({
        scope: createRepositoryCursorScope('assets', ['VELOCITY_ASC'], null),
        field: 'velocity', direction: 'asc', numeric: true, value, id: 'a',
      })).toThrow();
    }
  });

  it.each(['1e-7', '-1e21', true, false, Number.NaN, Infinity, -Infinity])(
    'does not reinterpret scientific strings, booleans or nonfinite values: %s', (value) => {
      expect(finiteNumberToPlainDecimal(value)).toBeNull();
      expect(normalizeDecimal(value)).toBeNull();
      expect(normalizeRepositoryCursorValue(value, true)).toBeNull();
    }
  );

  it('uses signed exact decimal and NULL order semantics for Number comparisons', () => {
    expect(compareDecimalValues(-2e-7, -1e-7)).toBe(-1);
    expect(compareDecimalValues(2e-7, 1e-7)).toBe(1);
    expect(compareOrderValues(1e-7, null, 'velocity', 'asc')).toBe(-1);
    expect(compareOrderValues(1e-7, '1e-7', 'velocity', 'desc')).toBe(1);
    expect(normalizeRepositoryCursorValue('1e-7', false)).toBe('1e-7');
  });

  it('expands only Asset numeric-set inputs within the existing decimal limits', () => {
    expect(() => validatePublicConnectionQuery('assets', ['VELOCITY_ASC'], {
      velocity: { gte: 1e-7, notIn: [2e-7] }, priceChangeDay: { lt: -1e-7 },
    })).not.toThrow();
    expect(() => validatePublicConnectionQuery('assets', ['ID_ASC'], { velocity: 1e-7 })).not.toThrow();
    for (const value of ['1e-7', true, Number.NaN, Infinity, Number.MIN_VALUE, Number.MAX_VALUE]) {
      expect(() => validatePublicConnectionQuery('assets', ['ID_ASC'], { velocity: { gt: value } })).toThrow();
    }
    expect(() => validatePublicConnectionQuery('assets', ['ID_ASC'], { velocity: { notIn: [1e-7, '2e-7'] } })).toThrow();
    expect(() => validatePublicConnectionQuery('assets', ['ID_ASC'], { velocity: { gt: `0.${'0'.repeat(40)}1` } })).toThrow();
    expect(() => validatePublicConnectionQuery('assets', ['ID_ASC'], { velocity: { gt: '1'.repeat(81) } })).toThrow();
    expect(() => validatePublicConnectionQuery('markets', ['ID_ASC'], { id: { equalTo: '1' }, volumeUSD: { gt: 1e-7 } })).toThrow();
    expect(() => assertValidIndexedDecimal(1e-7)).toThrow();
  });
});

const assets: IndexerDocument[] = [
  { collection: 'assets', id: 'a', data: { id: 'a', velocity: 1e-7, priceChangeDay: '-0.0000001', priceUSD: '0.0000001', liquidity: '0.0000001' } },
  { collection: 'assets', id: 'b', data: { id: 'b', velocity: 1e-7, priceChangeDay: '-0.0000001', priceUSD: '0.0000002', liquidity: '0.0000002' } },
  { collection: 'assets', id: 'c', data: { id: 'c', velocity: 2e-7, priceChangeDay: '0.0000002', priceUSD: '0.00000001', liquidity: '0.00000001' } },
  { collection: 'assets', id: 'd', data: { id: 'd', velocity: -2e-7, priceChangeDay: '-0.0000002', priceUSD: '1', liquidity: '1' } },
  { collection: 'assets', id: 'e', data: { id: 'e', velocity: 1e-8, priceChangeDay: '0.00000001', priceUSD: '2', liquidity: '2' } },
  { collection: 'assets', id: 'f', data: { id: 'f', velocity: null, priceChangeDay: null, priceUSD: '3', liquidity: '3' } },
  { collection: 'assets', id: 'g', data: { id: 'g', priceUSD: '4', liquidity: '4' } },
  { collection: 'assets', id: 'h', data: { id: 'h', velocity: '1000000000000000000000', priceChangeDay: 0, priceUSD: '5', liquidity: '5' } },
];

const query = `query($after: Cursor, $orderBy: [OrderBy!], $filter: AssetFilter) {
  assets(first: 1, after: $after, orderBy: $orderBy, filter: $filter) {
    nodes { id velocity priceChangeDay } totalCount pageInfo { endCursor hasNextPage }
  }
}`;
const execute = (repository: IndexerRepository, variables: Record<string, unknown>) =>
  graphql({ schema: createSchema(), source: query, variableValues: variables, contextValue: { repository } });
type Connection = {
  nodes: Array<{ id: string; velocity: number | null; priceChangeDay: number | null }>;
  totalCount: number; pageInfo: { endCursor: string | null; hasNextPage: boolean };
};

describe('finite Number Asset GraphQL filtering, native ranges and keyset walks', () => {
  let directory: string;
  let memory: MemoryRepository;
  let native: RocksRepository;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'polkaswap-finite-number-'));
    memory = new MemoryRepository();
    native = new RocksRepository({
      ...readConfig(), storageEngine: 'rocksdb', rocksdbPath: join(directory, 'assets.rocksdb'),
      rocksdbBlockCacheMb: 2, rocksdbWriteBufferManagerMb: 2, rocksdbParallelism: 1,
      rocksdbDocumentCacheMax: 0,
    });
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
    ['VELOCITY_ASC', undefined, ['d', 'e', 'a', 'b', 'c', 'h', 'f', 'g']],
    ['VELOCITY_DESC', undefined, ['g', 'f', 'h', 'c', 'b', 'a', 'e', 'd']],
    ['VELOCITY_ASC', { velocity: { gte: 1e-7 } }, ['a', 'b', 'c', 'h']],
    ['VELOCITY_DESC', { velocity: { gte: 1e-7 } }, ['h', 'c', 'b', 'a']],
    ['VELOCITY_ASC', { velocity: { notEqualTo: 1e-7, notIn: [2e-7] } }, ['d', 'e', 'h']],
    ['PRICE_CHANGE_DAY_ASC', { priceChangeDay: { lt: 1e-7 } }, ['d', 'a', 'b', 'h', 'e']],
    ['PRICE_CHANGE_DAY_DESC', { priceChangeDay: { lt: 1e-7 } }, ['e', 'h', 'b', 'a', 'd']],
  ])('preserves wire values, typed cursor values, ties and all pages for %s/%j', async (orderBy, filter, expected) => {
    const field = orderBy.startsWith('VELOCITY') ? 'velocity' : 'priceChangeDay';
    for (const repository of [memory, native]) {
      const ids: string[] = [];
      let after: string | null = null;
      do {
        const result = await execute(repository, { orderBy: [orderBy], filter, after });
        expect(result.errors).toBeUndefined();
        const page = (result.data as { assets: Connection }).assets;
        expect(page.totalCount).toBe(expected.length);
        expect(page.nodes).toHaveLength(1);
        const node = page.nodes[0]!;
        ids.push(node.id);
        const stored = assets.find((asset) => asset.id === node.id)!.data[field];
        expect(node[field as 'velocity' | 'priceChangeDay']).toBe(stored == null ? null : Number(stored));
        const cursor = decodeRepositoryCursor(page.pageInfo.endCursor)!;
        expect(cursor.value).toBe(stored == null ? null : typeof stored === 'number' ? finiteNumberToPlainDecimal(stored) : stored);
        expect(cursor.numeric).toBe(true);
        expect(cursor.id).toBe(node.id);
        if (!page.pageInfo.hasNextPage) break;
        expect(page.pageInfo.endCursor).not.toBe(after);
        after = page.pageInfo.endCursor;
        expect(ids.length).toBeLessThan(assets.length + 1);
      } while (true);
      expect(ids).toEqual(expected);
      const preserved = await repository.get('assets', 'a');
      expect(preserved!.data.velocity).toBe(1e-7);
      expect(preserved!.data.priceChangeDay).toBe('-0.0000001');
      expect(preserved!.data.priceUSD).toBe('0.0000001');
    }
  });

  it.each(['priceUSD', 'liquidity'] as const)('uses exact native %s bounds for Float input expressed with an exponent', async (field) => {
    const orderBy = field === 'priceUSD' ? 'PRICE_USD_ASC' : 'LIQUIDITY_ASC';
    const filter = { [field]: { gte: 1e-7, lt: 1 } };
    const results: string[][] = [];
    for (const repository of [memory, native]) {
      const ids: string[] = [];
      let after: string | null = null;
      do {
        const result = await execute(repository, { orderBy: [orderBy], filter, after });
        expect(result.errors).toBeUndefined();
        const page = (result.data as { assets: Connection }).assets;
        expect(page.totalCount).toBe(2);
        ids.push(...page.nodes.map((node) => node.id));
        if (!page.pageInfo.hasNextPage) break;
        after = page.pageInfo.endCursor;
        expect(ids.length).toBeLessThan(3);
      } while (true);
      results.push(ids);
    }
    expect(results).toEqual([['a', 'b'], ['a', 'b']]);
    expect(metrics.render()).toContain('collection="assets",source="x:num"');
    const result = await execute(native, { orderBy: [orderBy], filter: { [field]: { gt: 1e-7, lt: 1 } } });
    expect(result.errors).toBeUndefined();
    expect((result.data as { assets: Connection }).assets.nodes.map((node) => node.id)).toEqual(['b']);
    for (const value of [1e-7, '1e-7']) {
      await expect(native.upsert({ collection: 'assets', id: 'invalid', data: { [field]: value } })).rejects.toThrow(/indexed decimal/);
      expect(await native.get('assets', 'invalid')).toBeNull();
    }
  });

  it('compares native fallback keysets against stored tiny Numbers without decimal-key errors', async () => {
    const orderBy = ['VELOCITY_ASC'];
    const keyset = {
      scope: createRepositoryCursorScope('assets', orderBy, null), field: 'velocity',
      direction: 'asc' as const, numeric: true, value: '0.0000001', id: 'a',
    };
    for (const repository of [native, memory]) {
      const result = await repository.query('assets', { first: 10, orderBy, keyset });
      expect(result.items.map((item) => item.id)).toEqual(['b', 'c', 'h', 'f', 'g']);
      expect(result.totalCount).toBe(8);
      expect(result.itemCursors!.map((cursor) => decodeRepositoryCursor(cursor)?.value)).toEqual([
        '0.0000001', '0.0000002', '1000000000000000000000', null, null,
      ]);
    }
  });

  it('refuses scientific-string, Boolean and nonfinite public filter values', async () => {
    for (const repository of [memory, native]) {
      for (const value of ['1e-7', true, Number.NaN, Infinity]) {
        const result = await execute(repository, { orderBy: ['VELOCITY_ASC'], filter: { velocity: { gt: value } } });
        expect(result.errors?.[0]?.extensions.code).toBe('BAD_USER_INPUT');
      }
    }
  });
});
