import { describe, expect, it } from 'vitest';

import { matchesFilter, sortDocuments } from '../src/graphql/filter.js';

describe('GraphQL filter compatibility', () => {
  it('matches SubQuery-style boolean filters', () => {
    const item = {
      id: 'asset-a',
      liquidity: '10',
      liquidityBooks: '0',
      dataAssets: ['0xabc'],
      module: 'assets',
    };

    expect(
      matchesFilter(item, {
        and: [
          { id: { equalTo: 'asset-a' } },
          {
            or: [{ liquidity: { greaterThan: '0' } }, { liquidityBooks: { greaterThan: '0' } }],
          },
          { dataAssets: { contains: '0xabc' } },
        ],
      })
    ).toBe(true);
  });

  it('rejects mismatched comparison filters', () => {
    expect(
      matchesFilter(
        { timestamp: 100, status: 'Active' },
        { timestamp: { greaterThanOrEqualTo: 101 }, status: { notEqualTo: 'Active' } }
      )
    ).toBe(false);
  });

  it('matches direct equality and abbreviated comparison operators', () => {
    expect(
      matchesFilter(
        { id: 'asset-a', liquidity: '10', volumeDayUSD: '25', status: 'Trading' },
        {
          id: 'asset-a',
          liquidity: { gt: '9', lte: '10' },
          volumeDayUSD: { gte: '25', lt: '26' },
          status: { not_eq: 'Stopped' },
        }
      )
    ).toBe(true);
  });

  it('requires every requested value for array contains filters', () => {
    expect(
      matchesFilter(
        { callNames: ['poolXYK.initializePool', 'poolXYK.depositLiquidity'] },
        { callNames: { contains: ['poolXYK.initializePool', 'poolXYK.depositLiquidity'] } }
      )
    ).toBe(true);
    expect(
      matchesFilter(
        { callNames: ['poolXYK.initializePool'] },
        { callNames: { contains: ['poolXYK.initializePool', 'poolXYK.depositLiquidity'] } }
      )
    ).toBe(false);
  });

  it('matches case-insensitive, membership, and object containment filters', () => {
    expect(
      matchesFilter(
        {
          symbol: 'xor',
          status: 'Trading',
          metadata: { source: 'chain', verified: true },
        },
        {
          symbol: { equalToInsensitive: 'XOR' },
          status: { in: ['Trading', 'Stopped'] },
          metadata: { contains: { verified: true } },
        }
      )
    ).toBe(true);
  });

  it('matches nested path and substring filters', () => {
    expect(
      matchesFilter(
        {
          execution: { success: true },
          data: { sidechainAddress: '0xABCDEF' },
        },
        {
          'execution.success': { equalTo: true },
          'data.sidechainAddress': { includesInsensitive: 'bcde' },
        }
      )
    ).toBe(true);
  });

  it('treats non-numeric comparison values as zero', () => {
    expect(matchesFilter({ liquidity: 'not-a-number' }, { liquidity: { greaterThanOrEqualTo: 0 } })).toBe(true);
    expect(matchesFilter({ liquidity: 'not-a-number' }, { liquidity: { greaterThan: 0 } })).toBe(false);
  });

  it('rejects unsupported comparison operators', () => {
    expect(matchesFilter({ id: 'asset-a' }, { id: { startsWith: 'asset' } })).toBe(false);
  });

  it('sorts SubQuery order tokens by camel-cased document fields', () => {
    const result = sortDocuments(
      [
        { id: 'a', updatedAtBlock: 1 },
        { id: 'b', updatedAtBlock: 3 },
        { id: 'c', updatedAtBlock: 2 },
      ],
      ['UPDATED_AT_BLOCK_DESC']
    );

    expect(result.map((item) => item.id)).toEqual(['b', 'c', 'a']);
  });

  it('defaults to id ordering without mutating the input array', () => {
    const items = [{ id: 'b' }, { id: 'a' }, { id: 'c' }];
    const result = sortDocuments(items, undefined);

    expect(result.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(items.map((item) => item.id)).toEqual(['b', 'a', 'c']);
  });

  it('sorts nullish values last for ascending order and first for descending order', () => {
    const items = [
      { id: 'missing' },
      { id: 'one', timestamp: 1 },
      { id: 'two', timestamp: 2 },
      { id: 'null', timestamp: null },
    ];

    expect(sortDocuments(items, ['TIMESTAMP_ASC']).map((item) => item.id)).toEqual(['one', 'two', 'missing', 'null']);
    expect(sortDocuments(items, ['TIMESTAMP_DESC']).map((item) => item.id)).toEqual(['missing', 'null', 'two', 'one']);
  });
});
