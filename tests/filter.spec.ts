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
});
