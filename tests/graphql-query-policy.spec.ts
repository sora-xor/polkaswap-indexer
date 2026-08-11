import { describe, expect, it } from 'vitest';

import { validatePublicConnectionQuery } from '../src/graphql/query-policy.js';
import { createPinnedWalletHistoryFilter } from './pinned-wallet-history-fixture.js';

describe('public GraphQL repository query policy', () => {
  it('admits the indexed UI query shapes', () => {
    expect(() =>
      validatePublicConnectionQuery('assetSnapshots', ['TIMESTAMP_DESC'], {
        assetId: { equalTo: 'xor' },
        type: { equalTo: 'DAY' },
        timestamp: { greaterThanOrEqualTo: 100 },
      })
    ).not.toThrow();
    expect(() =>
      validatePublicConnectionQuery('historyElements', ['TIMESTAMP_DESC'], {
        and: [
          { address: { equalTo: 'alice' } },
          { method: { notIn: ['swap', 'rewarded'] } },
        ],
      })
    ).not.toThrow();
    expect(() =>
      validatePublicConnectionQuery('accountPositions', ['TIMESTAMP_DESC'], {
        account: { equalTo: 'alice' },
        status: { equalTo: 'Open' },
      })
    ).not.toThrow();
  });

  it('admits every production UI ID-ordered eligibility shape', () => {
    // polkaswap-exchange-web/src/indexer/queries/asset/assets.ts
    expect(() =>
      validatePublicConnectionQuery('assets', ['ID_ASC'], {
        or: [{ liquidity: { greaterThan: '0' } }, { liquidityBooks: { greaterThan: '0' } }],
        id: { in: ['xor', 'val'] },
      })
    ).not.toThrow();
    // soraneo-wallet-web@1.46.3/src/services/indexer/subquery/queries/fiatPrice.ts
    expect(() =>
      validatePublicConnectionQuery('assets', ['ID_ASC'], { priceUSD: { greaterThan: '0' } })
    ).not.toThrow();
    // polkaswap-exchange-web/src/indexer/queries/pool/pools.ts + pool/apy.ts
    expect(() =>
      validatePublicConnectionQuery('poolXYKs', ['ID_ASC'], {
        baseAssetReserves: { greaterThan: '0' },
        targetAssetReserves: { greaterThan: '0' },
        targetAssetId: { in: ['xor', 'val'] },
      })
    ).not.toThrow();
    expect(() =>
      validatePublicConnectionQuery('poolXYKs', ['ID_ASC'], {
        strategicBonusApy: { greaterThan: '0' },
      })
    ).not.toThrow();
  });

  it('admits production UI time/range shapes with bounded residual filters', () => {
    // polkaswap-exchange-web/src/indexer/queries/vault/vaults.ts
    expect(() =>
      validatePublicConnectionQuery('vaults', ['UPDATED_AT_BLOCK_DESC'], {
        ownerId: { equalTo: 'alice' },
        status: { in: ['Closed', 'Liquidated'] },
      })
    ).not.toThrow();
    // polkaswap-exchange-web/src/indexer/queries/network/tvl.ts
    expect(() =>
      validatePublicConnectionQuery('networkSnapshots', ['TIMESTAMP_DESC'], {
        and: [
          { type: { equalTo: 'DAY' } },
          { timestamp: { greaterThanOrEqualTo: 1, lessThanOrEqualTo: 2 } },
          { liquidityUSD: { greaterThan: '0' } },
        ],
      })
    ).not.toThrow();
    // polkaswap-exchange-web burnXor.ts / pointSystem.ts
    expect(() =>
      validatePublicConnectionQuery('historyElements', ['ID_ASC'], {
        and: [
          { blockHeight: { greaterThanOrEqualTo: 1, lessThanOrEqualTo: 100 } },
          { module: { equalTo: 'assets' } },
          { method: { equalTo: 'burn' } },
          { data: { contains: { assetId: 'xor' } } },
        ],
      })
    ).not.toThrow();
  });

  it('admits pinned wallet history filters while rejecting an unanchored first page', () => {
    expect(() => validatePublicConnectionQuery('historyElements', ['TIMESTAMP_DESC', 'ID_DESC'], { and: [] })).toThrow(
      'requires an indexed public filter'
    );
    expect(() =>
      validatePublicConnectionQuery('historyElements', ['TIMESTAMP_DESC', 'ID_DESC'], {
        and: [
          { address: { equalTo: 'alice' } },
          {
            or: [
              { module: { includesInsensitive: 'poolXYK' }, method: { equalTo: 'depositLiquidity' } },
              { method: { equalToInsensitive: 'transfer' } },
              { blockHash: { includesInsensitive: '0xabc' } },
              { dataAssets: { contains: 'xor' } },
              { callNames: { contains: ['poolXYK.initializePool'] } },
            ],
          },
        ],
      })
    ).not.toThrow();
    expect(() =>
      validatePublicConnectionQuery('historyElements', ['TIMESTAMP_DESC', 'ID_DESC'], {
        id: { equalTo: 'history-a' },
      })
    ).not.toThrow();
    expect(() =>
      validatePublicConnectionQuery('historyElements', ['TIMESTAMP_DESC'], {
        module: { includesInsensitive: 'pool' },
      })
    ).toThrow();
  });

  it('allows otherwise unsupported output orders only for bounded conjunctive ID reads', () => {
    expect(() =>
      validatePublicConnectionQuery('historyElements', ['BLOCK_HEIGHT_ASC'], {
        id: { in: ['history-a', 'history-b'] },
      })
    ).not.toThrow();
    expect(() =>
      validatePublicConnectionQuery('historyElements', ['BLOCK_HEIGHT_DESC'], {
        id: { equalTo: 'history-a' },
      })
    ).not.toThrow();

    expect(() =>
      validatePublicConnectionQuery('historyElements', ['BLOCK_HEIGHT_ASC'], {
        or: [
          { id: { equalTo: 'history-a' } },
          { id: { equalTo: 'history-b' } },
        ],
      })
    ).toThrow('orderBy field blockHeight');
    expect(() =>
      validatePublicConnectionQuery('historyElements', ['BLOCK_HEIGHT_ASC'], {
        id: { in: Array.from({ length: 101 }, (_, index) => `history-${index}`) },
      })
    ).toThrow('at most 100 values');
  });

  it('admits the exact pinned wallet 1.46.3 operation and search filter shapes', () => {
    for (const filter of [
      createPinnedWalletHistoryFilter({ address: 'alice' }),
      createPinnedWalletHistoryFilter({ address: 'alice', assetAddress: 'xor' }),
      createPinnedWalletHistoryFilter({ address: 'alice', accountSearch: 'bob' }),
      createPinnedWalletHistoryFilter({ address: 'alice', hexSearch: `0x${'a'.repeat(64)}` }),
      createPinnedWalletHistoryFilter({ address: 'alice', assetSearch: ['xor', 'val'] }),
    ]) {
      expect(() =>
        validatePublicConnectionQuery('historyElements', ['TIMESTAMP_DESC', 'ID_DESC'], filter)
      ).not.toThrow();
    }
  });

  it.each([
    ['assets', ['TIMESTAMP_DESC'], undefined, 'orderBy field timestamp'],
    ['assetSnapshots', ['LIQUIDITY_DESC'], undefined, 'orderBy field liquidity'],
    ['assets', ['ID_ASC'], { marketId: { equalTo: 7 } }, 'filter field marketId'],
    ['historyElements', ['TIMESTAMP_DESC'], { liquidity: { greaterThan: 0 } }, 'filter field liquidity'],
    ['markets', ['MARGINAL_YES_PRICE_BPS_DESC'], undefined, 'orderBy field marginalYesPriceBps'],
    ['assets', ['LIQUIDITY_USD_DESC'], undefined, 'orderBy field liquidityUSD'],
    ['markets', ['VOLUME_USD_DESC'], undefined, 'orderBy field volumeUSD'],
    ['orderBookOrders', ['AMOUNT_DESC'], undefined, 'orderBy field amount'],
  ] as const)('rejects cross-collection or unplanned query %#', (collection, orderBy, filter, message) => {
    expect(() => validatePublicConnectionQuery(collection, orderBy, filter)).toThrow(message);
  });

  it('rejects operators and vacuous set filters that would force broad scans', () => {
    expect(() =>
      validatePublicConnectionQuery('assets', ['ID_ASC'], {
        liquidity: { includesInsensitive: '1' },
      })
    ).toThrow('operator liquidity.includesInsensitive');
    expect(() =>
      validatePublicConnectionQuery('assets', ['ID_ASC'], {
        id: { in: [] },
      })
    ).toThrow('non-null value');
    expect(() =>
      validatePublicConnectionQuery('assets', ['ID_ASC'], {
        id: { in: [null, 'null'] },
      })
    ).toThrow('non-null value');
    expect(() => validatePublicConnectionQuery('assets', ['ID_ASC'], { or: [] })).toThrow('non-empty array');
    expect(() =>
      validatePublicConnectionQuery('assets', ['ID_ASC'], {
        id: { in: Array.from({ length: 101 }, (_, index) => `asset-${index}`) },
      })
    ).toThrow('at most 100 values');
  });

  it('rejects valid fields combined into an unindexed storage shape', () => {
    expect(() =>
      validatePublicConnectionQuery('assets', ['LIQUIDITY_DESC'], {
        priceUSD: { greaterThan: '1' },
      })
    ).toThrow();
    expect(() =>
      validatePublicConnectionQuery('poolSnapshots', ['TIMESTAMP_DESC'], {
        poolId: { equalTo: 'pool-a' },
      })
    ).toThrow();
    expect(() => validatePublicConnectionQuery('vaultEvents', ['TIMESTAMP_DESC'], undefined)).toThrow(
      'requires an indexed public filter'
    );
    expect(() =>
      validatePublicConnectionQuery('historyElements', ['ID_ASC'], {
        blockHeight: { greaterThanOrEqualTo: 1 },
      })
    ).toThrow();
    expect(() =>
      validatePublicConnectionQuery('historyElements', ['TIMESTAMP_ASC'], {
        timestamp: { lessThanOrEqualTo: 1_000 },
      })
    ).toThrow();
  });

  it('requires exact module and method anchors in every bounded history branch', () => {
    expect(() =>
      validatePublicConnectionQuery('historyElements', ['ID_ASC'], {
        blockHeight: { greaterThanOrEqualTo: 1, lessThanOrEqualTo: 100 },
        module: { equalTo: 'assets' },
        method: { includesInsensitive: 'burn' },
        data: { contains: { assetId: 'xor' } },
      })
    ).toThrow();

    expect(() =>
      validatePublicConnectionQuery('historyElements', ['ID_ASC'], {
        and: [
          { blockHeight: { greaterThanOrEqualTo: 1, lessThanOrEqualTo: 100 } },
          {
            or: [
              { module: { equalTo: 'assets' }, method: { equalTo: 'burn' } },
              { module: { equalTo: 'ethBridge' }, address: { equalTo: 'alice' } },
            ],
          },
        ],
      })
    ).toThrow();
  });

  it('bounds public decimal syntax and precision', () => {
    const validate = (value: unknown) =>
      validatePublicConnectionQuery('assets', ['ID_ASC'], { liquidity: { greaterThan: value } });

    expect(() => validate(`${'9'.repeat(80)}.${'1'.repeat(40)}`)).not.toThrow();
    for (const value of ['9'.repeat(81), `0.${'1'.repeat(41)}`, '1e3', ' 1', '1 ']) {
      expect(() => validate(value)).toThrow('finite decimal value');
    }
  });

  it('restricts native timestamp and block-height filters to non-negative safe integers', () => {
    const validateTimestamp = (value: unknown) =>
      validatePublicConnectionQuery('assetSnapshots', ['TIMESTAMP_ASC'], {
        assetId: { equalTo: 'xor' },
        type: { equalTo: 'DAY' },
        timestamp: { greaterThanOrEqualTo: value },
      });
    const validateBlockHeight = (value: unknown) =>
      validatePublicConnectionQuery('assetSnapshots', ['BLOCK_HEIGHT_ASC'], {
        assetId: { equalTo: 'xor' },
        blockHeight: { lessThanOrEqualTo: value },
      });

    expect(() => validateTimestamp(Number.MAX_SAFE_INTEGER)).not.toThrow();
    expect(() => validateTimestamp(String(Number.MAX_SAFE_INTEGER))).not.toThrow();
    for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '9007199254740992', '9'.repeat(80)]) {
      expect(() => validateTimestamp(invalid)).toThrow('non-negative safe integer');
      expect(() => validateBlockHeight(invalid)).toThrow('non-negative safe integer');
    }
    expect(() =>
      validatePublicConnectionQuery('assetSnapshots', ['TIMESTAMP_ASC'], {
        assetId: { equalTo: 'xor' },
        type: { equalTo: 'DAY' },
        timestamp: { in: [1, '9007199254740992'] },
      })
    ).toThrow('non-negative safe integer');
  });

  it('restricts public JSON containment to bounded history string values', () => {
    const validate = (contains: unknown) =>
      validatePublicConnectionQuery('historyElements', ['TIMESTAMP_ASC'], {
        address: { equalTo: 'alice' },
        timestamp: { greaterThan: 0, lessThanOrEqualTo: 10 },
        dataAssets: { contains },
      });

    expect(() => validate('xor')).not.toThrow();
    expect(() => validate(['xor', 'val'])).not.toThrow();
    for (const malformed of [{ nested: 'xor' }, [['xor']], [], '', Array.from({ length: 101 }, () => 'xor')]) {
      expect(() => validate(malformed)).toThrow('non-empty string or bounded array');
    }
  });

  it('restricts legacy history data containment to exact supported scalar keys', () => {
    const validate = (contains: unknown, module = 'assets', method = 'burn') =>
      validatePublicConnectionQuery('historyElements', ['ID_ASC'], {
        blockHeight: { greaterThanOrEqualTo: 1, lessThanOrEqualTo: 2 },
        module: { equalTo: module },
        method: { equalTo: method },
        data: { contains },
      });
    expect(() => validate({ assetId: 'xor' })).not.toThrow();
    expect(() => validate({ to: 'alice' }, 'bridgeMultisig', 'asMulti')).not.toThrow();
    for (const malformed of [{ nested: { assetId: 'xor' } }, { amount: '1' }, { assetId: 'xor', to: 'alice' }, []]) {
      expect(() => validate(malformed)).toThrow(/assetId or to|one supported scalar key/);
    }
  });
});
