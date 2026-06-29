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

  it('matches stats page direct snapshot filters', () => {
    expect(
      matchesFilter(
        { type: 'HOUR', timestamp: 150 },
        {
          type: { equalTo: 'HOUR' },
          timestamp: { lessThanOrEqualTo: 200, greaterThanOrEqualTo: 120 },
        }
      )
    ).toBe(true);
    expect(
      matchesFilter(
        { type: 'DAY', timestamp: 150 },
        {
          type: { equalTo: 'HOUR' },
          timestamp: { lessThanOrEqualTo: 200, greaterThanOrEqualTo: 120 },
        }
      )
    ).toBe(false);
    expect(matchesFilter({ type: 'DAY', timestamp: 150 }, { timestamp: { lessThanOrEqualTo: null } })).toBe(true);
    expect(matchesFilter({ type: 'DAY', timestamp: 150 }, { timestamp: { greaterThanOrEqualTo: 'null' } })).toBe(true);
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

  it('matches SubQuery notIn filters used by the SORA mobile history query', () => {
    expect(
      matchesFilter(
        { method: 'transfer' },
        { method: { notIn: ['swap', 'rewarded'] } }
      )
    ).toBe(true);
    expect(
      matchesFilter(
        { method: 'swap' },
        { method: { notIn: ['swap', 'rewarded'] } }
      )
    ).toBe(false);
    expect(
      matchesFilter(
        { method: 'rewarded' },
        { method: { not_in: ['swap', 'rewarded'] } }
      )
    ).toBe(false);
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

  it('fails closed for malformed logical filters and non-object branches', () => {
    expect(matchesFilter({ id: 'asset-a' }, { and: { id: { equalTo: 'asset-a' } } })).toBe(false);
    expect(matchesFilter({ id: 'asset-a' }, { or: { id: { equalTo: 'asset-a' } } })).toBe(false);
    expect(matchesFilter({ id: 'asset-a' }, { and: [{ id: { equalTo: 'asset-a' } }, 'not-a-filter'] })).toBe(false);
    expect(matchesFilter({ id: 'asset-a' }, { or: ['not-a-filter', { id: { equalTo: 'asset-b' } }] })).toBe(false);
    expect(matchesFilter({ id: 'asset-a' }, 'not-a-filter' as never)).toBe(false);
  });

  it('does not match inherited or prototype-polluted paths', () => {
    Object.defineProperty(Object.prototype, 'polkaswapIndexerPolluted', {
      configurable: true,
      value: 'owned',
    });

    const metadata = Object.create({ verified: true }) as Record<string, unknown>;
    metadata.source = 'chain';

    try {
      expect(
        matchesFilter({}, { '__proto__.polkaswapIndexerPolluted': { equalTo: 'owned' } })
      ).toBe(false);
      expect(
        matchesFilter({ constructor: { prototype: { polkaswapIndexerPolluted: 'owned' } } }, {
          'constructor.prototype.polkaswapIndexerPolluted': { equalTo: 'owned' },
        })
      ).toBe(false);
      expect(matchesFilter({ metadata }, { metadata: { contains: { verified: true } } })).toBe(false);
      expect(matchesFilter({ id: 'asset-a' }, { '__proto__': { notEqualTo: 'asset-b' } })).toBe(false);
    } finally {
      delete (Object.prototype as { polkaswapIndexerPolluted?: unknown }).polkaswapIndexerPolluted;
    }
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

  it('sorts USD acronym fields numerically', () => {
    const result = sortDocuments(
      [
        { id: 'low', liquidityUSD: '7.5' },
        { id: 'high', liquidityUSD: '100' },
        { id: 'middle', liquidityUSD: '20' },
      ],
      ['LIQUIDITY_USD_DESC']
    );

    expect(result.map((item) => item.id)).toEqual(['high', 'middle', 'low']);
  });

  it('sorts DPM string metrics numerically', () => {
    const result = sortDocuments(
      [
        { id: 'low', dpmCollateral: '900' },
        { id: 'high', dpmCollateral: '10000' },
        { id: 'middle', dpmCollateral: '1200' },
      ],
      ['DPM_COLLATERAL_DESC']
    );

    expect(result.map((item) => item.id)).toEqual(['high', 'middle', 'low']);
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
