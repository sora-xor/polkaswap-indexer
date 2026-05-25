import { describe, expect, it, vi } from 'vitest';

import { ApiPromise } from '@polkadot/api';
import { ChainIndexer } from '../src/worker/chain.js';
import { MemoryRepository } from '../src/repository/memory.js';

import type { IndexerDocument } from '../src/repository/types.js';

const SCALE = 10n ** 18n;
const XOR = '0x0200000000000000000000000000000000000000000000000000000000000000';
const VAL = '0x0200040000000000000000000000000000000000000000000000000000000000';
const PSWAP = '0x0200050000000000000000000000000000000000000000000000000000000000';
const DUST_DAI = '0x00a0e746a66b290bd29cbffecc710aefacb98840937229e1e847590006fa0696';
const ETH = '0x0200070000000000000000000000000000000000000000000000000000000000';
const XSTUSD = '0x0200080000000000000000000000000000000000000000000000000000000000';
const KUSD = '0x02000c0000000000000000000000000000000000000000000000000000000000';
const LIBERLAND_ACCOUNT = '5GrwvaEF5zXb26Fz9rcQpDWSxZ9zC7d4L4sUx8m6RRnF9jqw';

const eventRecord = (section: string, method: string, data: Record<string, unknown>, extrinsicIndex = 0) => ({
  phase: {
    isApplyExtrinsic: true,
    asApplyExtrinsic: { toNumber: () => extrinsicIndex },
  },
  event: {
    section,
    method,
    data: {
      toArray: () =>
        Object.values(data).map((value) => ({
          toJSON: () => value,
          toString: () => String(value ?? ''),
        })),
    },
    meta: {
      fields: Object.keys(data).map((name) => ({
        name: {
          isSome: true,
          unwrap: () => ({ toString: () => name }),
        },
      })),
    },
  },
});

const config = {
  host: '0.0.0.0',
  port: 4350,
  graphqlPath: '/graphql',
  databaseUrl: '',
  soraWsEndpoint: 'wss://mof2.sora.org',
  chainStartBlock: 0,
  chainBatchSize: 25,
  stateRefreshIntervalBlocks: 250,
  snapshotIntervalBlocks: 250,
};

const createBlockNetworkSnapshot = (
  blockHeight: number,
  timestamp: number,
  data: Partial<Record<string, unknown>>
) => ({
  collection: 'networkSnapshots' as const,
  id: `block-${blockHeight}`,
  blockHeight,
  timestamp,
  data: {
    id: `block-${blockHeight}`,
    type: 'BLOCK',
    timestamp,
    accounts: 0,
    transactions: 0,
    fees: '0',
    liquidityUSD: '0',
    poolLiquidityUSD: '0',
    orderBookLiquidityUSD: '0',
    volumeUSD: '0',
    swaps: 0,
    activePools: 0,
    activeOrderBooks: 0,
    listedAssets: 0,
    bridgeIncomingTransactions: 0,
    bridgeOutgoingTransactions: 0,
    ...data,
  },
});

const createAssetSnapshot = (
  id: string,
  timestamp: number,
  priceUSD: { open: string; high: string; low: string; close: string },
  volumeUSD = '0'
) => ({
  collection: 'assetSnapshots' as const,
  id,
  blockHeight: 1,
  timestamp,
  data: {
    id,
    assetId: XOR,
    timestamp,
    type: 'DEFAULT',
    supply: '0',
    mint: '0',
    burn: '0',
    priceUSD,
    volume: {
      amount: '0',
      amountUSD: volumeUSD,
    },
  },
});

const expectNoBackfilledNetworkStockMetrics = (document: { data: Record<string, unknown> } | null | undefined) => {
  expect(document?.data).not.toHaveProperty('liquidityUSD');
  expect(document?.data).not.toHaveProperty('poolLiquidityUSD');
  expect(document?.data).not.toHaveProperty('orderBookLiquidityUSD');
  expect(document?.data).not.toHaveProperty('activePools');
  expect(document?.data).not.toHaveProperty('activeOrderBooks');
  expect(document?.data).not.toHaveProperty('listedAssets');
};

describe('ChainIndexer price derivation', () => {
  it('prefers liquid stable pools over dust pools for derived asset prices', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      derivePrices: (
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>,
        pools: Array<{ baseAssetId: string; targetAssetId: string; baseAssetReserves: bigint; targetAssetReserves: bigint }>
      ) => Map<string, bigint>;
    };

    const prices = indexer.derivePrices(
      new Map([
        [XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }],
        [DUST_DAI, { id: DUST_DAI, symbol: 'DAI', name: 'Dust DAI', decimals: 18, supply: 0n }],
        [KUSD, { id: KUSD, symbol: 'KUSD', name: 'Kensetsu USD', decimals: 18, supply: 0n }],
      ]),
      [
        {
          baseAssetId: XOR,
          targetAssetId: DUST_DAI,
          baseAssetReserves: 707_000_000_000_000n,
          targetAssetReserves: 701n,
        },
        {
          baseAssetId: XOR,
          targetAssetId: KUSD,
          baseAssetReserves: 40_668_701_790_400_544_319n,
          targetAssetReserves: 243_698_436_474_125_931_406n,
        },
      ]
    );

    expect(prices.get(XOR)).toBeGreaterThan(5n * SCALE);
    expect(prices.get(XOR)).toBeLessThan(7n * SCALE);
  });

  it('does not derive global prices from dust or low-liquidity pools', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      derivePrices: (
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>,
        pools: Array<{ baseAssetId: string; targetAssetId: string; baseAssetReserves: bigint; targetAssetReserves: bigint }>
      ) => Map<string, bigint>;
    };
    const dustAsset = '0x0300000000000000000000000000000000000000000000000000000000000000';
    const lowLiquidityAsset = '0x0400000000000000000000000000000000000000000000000000000000000000';

    const prices = indexer.derivePrices(
      new Map([
        [KUSD, { id: KUSD, symbol: 'KUSD', name: 'Kensetsu USD', decimals: 18, supply: 0n }],
        [XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }],
        [dustAsset, { id: dustAsset, symbol: 'DUST', name: 'Dust token', decimals: 18, supply: 0n }],
        [lowLiquidityAsset, { id: lowLiquidityAsset, symbol: 'LOW', name: 'Low liquidity token', decimals: 18, supply: 0n }],
      ]),
      [
        {
          baseAssetId: KUSD,
          targetAssetId: XOR,
          baseAssetReserves: 200n * SCALE,
          targetAssetReserves: 100n * SCALE,
        },
        {
          baseAssetId: XOR,
          targetAssetId: dustAsset,
          baseAssetReserves: 10n * SCALE,
          targetAssetReserves: 1n,
        },
        {
          baseAssetId: XOR,
          targetAssetId: lowLiquidityAsset,
          baseAssetReserves: 10n * SCALE,
          targetAssetReserves: SCALE,
        },
      ]
    );

    expect(prices.get(XOR)).toBe(2n * SCALE);
    expect(prices.has(dustAsset)).toBe(false);
    expect(prices.has(lowLiquidityAsset)).toBe(false);
  });

  it('rejects shallow stable pools with enough stable-side liquidity to imply bad asset prices', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      derivePrices: (
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>,
        pools: Array<{ baseAssetId: string; targetAssetId: string; baseAssetReserves: bigint; targetAssetReserves: bigint }>
      ) => Map<string, bigint>;
    };

    const prices = indexer.derivePrices(
      new Map([
        [XOR, { id: XOR, symbol: 'XOR', name: 'SORA', decimals: 18, supply: 0n }],
        [XSTUSD, { id: XSTUSD, symbol: 'XSTUSD', name: 'SORA Synthetic USD', decimals: 18, supply: 0n }],
      ]),
      [
        {
          baseAssetId: XOR,
          targetAssetId: XSTUSD,
          baseAssetReserves: 267_093_660_969_057_671n,
          targetAssetReserves: 122_541_250_000_000_000_000n,
        },
      ]
    );

    expect(prices.has(XOR)).toBe(false);
  });

  it('still derives XOR from a current-depth stable pool', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      derivePrices: (
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>,
        pools: Array<{ baseAssetId: string; targetAssetId: string; baseAssetReserves: bigint; targetAssetReserves: bigint }>
      ) => Map<string, bigint>;
    };

    const prices = indexer.derivePrices(
      new Map([
        [XOR, { id: XOR, symbol: 'XOR', name: 'SORA', decimals: 18, supply: 0n }],
        [KUSD, { id: KUSD, symbol: 'KUSD', name: 'Kensetsu USD', decimals: 18, supply: 0n }],
      ]),
      [
        {
          baseAssetId: XOR,
          targetAssetId: KUSD,
          baseAssetReserves: 54_108_391_503_195_511_939n,
          targetAssetReserves: 284_137_450_352_029_888_903n,
        },
      ]
    );

    expect(prices.get(XOR)).toBeGreaterThan(5n * SCALE);
    expect(prices.get(XOR)).toBeLessThan(6n * SCALE);
  });

  it('cleans zero-volume asset snapshot price outliers while preserving isolated historical highs', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      cleanupAssetSnapshotPriceOutliers: () => Promise<boolean>;
    };
    const normalPrice = (price: string) => ({ open: price, high: price, low: price, close: price });
    const documents = [
      createAssetSnapshot('asset-xor-DEFAULT-legacy-high', 1_619_543_754, normalPrice('362.29477681')),
      createAssetSnapshot('asset-xor-DEFAULT-bad-1', 1_778_368_470, normalPrice('362.29477681')),
      createAssetSnapshot('asset-xor-DEFAULT-bad-2', 1_778_457_186, {
        open: '588.29698412',
        high: '588.29698412',
        low: '458.83773967',
        close: '458.83773967',
      }),
      createAssetSnapshot('asset-xor-DEFAULT-bad-3', 1_778_542_932, {
        open: '458.83773967',
        high: '458.83773967',
        low: '5.72015908',
        close: '5.81993769',
      }),
      createAssetSnapshot('asset-xor-DEFAULT-good-1', 1_778_630_016, normalPrice('5.81522438')),
      createAssetSnapshot('asset-xor-DEFAULT-good-2', 1_778_715_546, normalPrice('5.20150076')),
      createAssetSnapshot('asset-xor-DEFAULT-good-3', 1_778_802_738, normalPrice('5.41743442')),
      createAssetSnapshot('asset-xor-DEFAULT-good-4', 1_778_888_436, normalPrice('5.62856663')),
      createAssetSnapshot('asset-xor-DEFAULT-volume-spike', 1_778_930_000, normalPrice('362.29477681'), '1'),
    ];
    await repository.upsertMany(documents);

    await expect(indexer.cleanupAssetSnapshotPriceOutliers()).resolves.toBe(true);

    const remainingIds = new Set((await repository.list('assetSnapshots')).map((document) => document.id));
    expect(remainingIds.has('asset-xor-DEFAULT-bad-1')).toBe(false);
    expect(remainingIds.has('asset-xor-DEFAULT-bad-2')).toBe(false);
    expect(remainingIds.has('asset-xor-DEFAULT-bad-3')).toBe(false);
    expect(remainingIds.has('asset-xor-DEFAULT-legacy-high')).toBe(true);
    expect(remainingIds.has('asset-xor-DEFAULT-volume-spike')).toBe(true);
    expect(await repository.get('updatesStreams', 'assetSnapshotPriceOutlierCleanup-v1')).not.toBeNull();
  });

  it('does not re-run asset snapshot outlier cleanup once the cleanup state exists', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      cleanupAssetSnapshotPriceOutliers: () => Promise<boolean>;
    };
    await repository.upsert({
      collection: 'updatesStreams',
      id: 'assetSnapshotPriceOutlierCleanup-v1',
      data: { id: 'assetSnapshotPriceOutlierCleanup-v1', data: JSON.stringify({ deletedCount: 0 }) },
    });
    await repository.upsert(createAssetSnapshot('asset-xor-DEFAULT-bad-state-kept', 1_778_368_470, {
      open: '362.29477681',
      high: '362.29477681',
      low: '362.29477681',
      close: '362.29477681',
    }));

    await expect(indexer.cleanupAssetSnapshotPriceOutliers()).resolves.toBe(false);

    expect(await repository.get('assetSnapshots', 'asset-xor-DEFAULT-bad-state-kept')).not.toBeNull();
  });

  it('prefers deeper target reserves over a shallow pool with more stable-side liquidity', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      derivePrices: (
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>,
        pools: Array<{ baseAssetId: string; targetAssetId: string; baseAssetReserves: bigint; targetAssetReserves: bigint }>
      ) => Map<string, bigint>;
    };

    const prices = indexer.derivePrices(
      new Map([
        [ETH, { id: ETH, symbol: 'ETH', name: 'Ether', decimals: 18, supply: 0n }],
        [XSTUSD, { id: XSTUSD, symbol: 'XSTUSD', name: 'SORA Synthetic USD', decimals: 18, supply: 0n }],
        [KUSD, { id: KUSD, symbol: 'KUSD', name: 'Kensetsu USD', decimals: 18, supply: 0n }],
      ]),
      [
        {
          baseAssetId: XSTUSD,
          targetAssetId: ETH,
          baseAssetReserves: 5_000n * SCALE,
          targetAssetReserves: SCALE / 50n,
        },
        {
          baseAssetId: KUSD,
          targetAssetId: ETH,
          baseAssetReserves: 2_000n * SCALE,
          targetAssetReserves: SCALE,
        },
      ]
    );

    expect(prices.get(ETH)).toBe(2_000n * SCALE);
  });

  it('uses the largest USD leg for transaction volume', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      extractVolumeUSD: (data: unknown) => bigint;
    };

    const volume = indexer.extractVolumeUSD({
      baseAssetAmountUSD: '10',
      targetAssetAmountUSD: '9.95',
      amountUSD: '1',
    });

    expect(volume).toBe(10n * SCALE);
  });

  it('sums xor fee withdrawal events as network fees', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      extractNetworkFee: (events: unknown[]) => bigint;
    };

    const fee = indexer.extractNetworkFee([
      eventRecord('xorFee', 'FeeWithdrawn', { amount: '100' }),
      eventRecord('xorFee', 'FeeWithdrawn', { fee: '23' }),
      eventRecord('balances', 'Transfer', { amount: '999' }),
    ]);

    expect(fee).toBe(123n);
  });

  it('mirrors the runtime XOR fee split when deriving direct fee burns', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      extractXorFeeBurn: (networkFee: unknown) => bigint;
    };

    expect(indexer.extractXorFeeBurn(85n * SCALE)).toBe(20n * SCALE);
    expect(indexer.extractXorFeeBurn('123')).toBe(30n);
    expect(indexer.extractXorFeeBurn('0')).toBe(0n);
  });

  it('normalizes native balances issuance for XOR asset supply snapshots', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      createSupplyByAsset: (
        tokenIssuances: Array<[{ args: unknown[] }, unknown]>,
        nativeXorIssuance: unknown
      ) => Map<string, bigint>;
    };

    const legacyNativeXorIssuance = (999n * SCALE * 1_000_000n + 123n).toString();
    const supplyByAsset = indexer.createSupplyByAsset([[{ args: [KUSD] }, '123']], legacyNativeXorIssuance);

    expect(supplyByAsset.get(XOR)).toBe(999n * SCALE);
    expect(supplyByAsset.get(KUSD)).toBe(123n);
  });

  it('requires native balances issuance when refreshing XOR supply', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      api: unknown;
      fetchNativeXorIssuance: () => Promise<unknown>;
    };

    indexer.api = { query: { balances: {} } };

    await expect(indexer.fetchNativeXorIssuance()).rejects.toThrow(
      'balances.totalIssuance is required to refresh native XOR supply'
    );
  });

  it('propagates native balances issuance query failures', async () => {
    const failure = new Error('RPC unavailable');
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      api: unknown;
      fetchNativeXorIssuance: () => Promise<unknown>;
    };

    indexer.api = {
      query: {
        balances: {
          totalIssuance: vi.fn().mockRejectedValue(failure),
        },
      },
    };

    await expect(indexer.fetchNativeXorIssuance()).rejects.toBe(failure);
  });

  it('requires storage entry queries instead of using empty collection fallbacks', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      fetchStorageEntries: (storage: unknown, label: string) => Promise<unknown[]>;
    };

    await expect(indexer.fetchStorageEntries({}, 'orderBook.bids')).rejects.toThrow(
      'orderBook.bids.entries is required to refresh derived state'
    );
  });

  it('propagates block timestamp query failures', async () => {
    const failure = new Error('timestamp RPC unavailable');
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      api: unknown;
      fetchBlockTimestamp: (hash: string) => Promise<number>;
    };

    indexer.api = {
      query: {
        timestamp: {
          now: {
            at: vi.fn().mockRejectedValue(failure),
          },
        },
      },
    };

    await expect(indexer.fetchBlockTimestamp('0xblock')).rejects.toBe(failure);
  });

  it('propagates validator identity query failures', async () => {
    const failure = new Error('identity RPC unavailable');
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      api: unknown;
      readValidatorIdentity: (address: string) => Promise<Record<string, unknown> | null>;
    };

    indexer.api = {
      query: {
        identity: {
          identityOf: vi.fn().mockRejectedValue(failure),
        },
      },
    };

    await expect(indexer.readValidatorIdentity('validator-1')).rejects.toBe(failure);
  });

  it('requires staking validator storage instead of returning an empty validator stream', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      api: unknown;
      createStakingValidatorDocuments: (
        blockHeight: number,
        timestamp: number,
        prices: Map<string, bigint>,
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>
      ) => Promise<unknown[]>;
    };

    indexer.api = { query: { staking: {} } };

    await expect(indexer.createStakingValidatorDocuments(1, 1, new Map(), new Map())).rejects.toThrow(
      'staking.validators.entries is required to refresh staking validators'
    );
  });

  it('reads paged staking exposure storage from the current SORA runtime shape', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      api: unknown;
      getEraExposures: (era: number) => Promise<Map<string, { total: bigint; own: string; others: unknown[] }>>;
    };

    indexer.api = {
      query: {
        staking: {
          erasStakersOverview: {
            entries: async () => [
              [
                { args: [10, 'validator-1'] },
                { toHuman: () => ({ total: '100', own: '25', pageCount: '1' }) },
              ],
            ],
          },
          erasStakersPaged: {
            entries: async () => [
              [
                { args: [10, 'validator-1', { toString: () => '0' }] },
                { toHuman: () => ({ pageTotal: '75', others: [{ who: 'nominator-1', value: '75' }] }) },
              ],
            ],
          },
        },
      },
    };

    const exposures = await indexer.getEraExposures(10);

    expect(exposures.get('validator-1')).toEqual({
      total: 100n,
      own: '25',
      others: [{ who: 'nominator-1', value: '75' }],
    });
  });

  it('reads legacy staking exposure storage for eras that predate paged exposure entries', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      api: unknown;
      getEraExposures: (era: number) => Promise<Map<string, { total: bigint; own: string; others: unknown[] }>>;
    };

    indexer.api = {
      query: {
        staking: {
          erasStakersOverview: { entries: async () => [] },
          erasStakersPaged: { entries: async () => [] },
          erasStakers: {
            entries: async () => [
              [
                { args: [9, 'validator-1'] },
                {
                  total: '100',
                  own: '25',
                  others: [{ who: 'nominator-1', value: '75' }],
                },
              ],
            ],
          },
        },
      },
    };

    const exposures = await indexer.getEraExposures(9);

    expect(exposures.get('validator-1')).toEqual({
      total: 100n,
      own: '25',
      others: [{ who: 'nominator-1', value: '75' }],
    });
  });

  it('adds direct XOR fee burns to asset snapshot burn aggregates', async () => {
    const repository = new MemoryRepository();
    await repository.upsert({
      collection: 'historyElements',
      id: 'fee-history',
      blockHeight: 10,
      timestamp: 1_700_000_000,
      data: {
        id: 'fee-history',
        timestamp: 1_700_000_000,
        module: 'liquidityProxy',
        method: 'swap',
        networkFee: (85n * SCALE).toString(),
        data: {},
      },
    });
    await repository.upsert({
      collection: 'historyElements',
      id: '0xrequest-mint',
      blockHeight: 10,
      timestamp: 1_700_000_000,
      data: {
        id: '0xrequest-mint',
        timestamp: 1_700_000_000,
        module: 'bridgeProxy',
        method: 'mint',
        networkFee: (85n * SCALE).toString(),
        data: { requestHash: '0xrequest' },
      },
    });

    const indexer = new ChainIndexer(config, repository) as unknown as {
      buildAnalytics: (
        timestamp: number,
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>,
        prices: Map<string, bigint>,
        pools: unknown[],
        liquidityStats: {
          liquidityUSD: string;
          poolLiquidityUSD: string;
          orderBookLiquidityUSD: string;
          activePools: number;
          activeOrderBooks: number;
          listedAssets: number;
        }
      ) => Promise<{ assets: Map<string, Map<string, { burn: bigint }>> }>;
    };
    const analytics = await indexer.buildAnalytics(
      1_700_000_000,
      new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]),
      new Map([[XOR, SCALE]]),
      [],
      {
        liquidityUSD: '0',
        poolLiquidityUSD: '0',
        orderBookLiquidityUSD: '0',
        activePools: 0,
        activeOrderBooks: 0,
        listedAssets: 1,
      }
    );

    expect(analytics.assets.get(XOR)?.get('HOUR')?.burn).toBe(20n * SCALE);
    expect(analytics.assets.get(XOR)?.get('DAY')?.burn).toBe(20n * SCALE);
  });

  it('calculates validator APY from latest era reward points, prices, stake, and commission', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      calculateValidatorApy: (
        validatorTotalStake: bigint,
        eraValidatorReward: bigint,
        rewardPoints: number,
        totalRewardPoints: number,
        commission: string,
        prices: Map<string, bigint>,
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>
      ) => string;
    };

    expect(
      indexer.calculateValidatorApy(
        1_000n * SCALE,
        1n * SCALE,
        25,
        100,
        '100000000',
        new Map([
          [XOR, SCALE],
          [VAL, 2n * SCALE],
        ]),
        new Map([
          [XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }],
          [VAL, { id: VAL, symbol: 'VAL', name: 'VAL', decimals: 18, supply: 0n }],
        ])
      )
    ).toBe('65.7');
  });

  it('creates indexed validator return documents and a compact stream payload', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      api: unknown;
      createStakingValidatorDocuments: (
        blockHeight: number,
        timestamp: number,
        prices: Map<string, bigint>,
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>
      ) => Promise<Array<{ collection: string; id: string; data: Record<string, any> }>>;
      createStakingValidatorsStream: (
        validatorDocuments: Array<{ collection: string; id: string; data: Record<string, any> }>,
        blockHeight: number,
        timestamp: number
      ) => { collection: string; id: string; data: Record<string, string> };
    };
    const account = { toString: () => 'validator-1' };
    const point = { toString: () => '25' };
    const reward = { unwrap: () => ({ toString: () => (1n * SCALE).toString() }) };
    const identity = {
      isEmpty: false,
      isNone: false,
      unwrap: () => ({
        toHuman: () => ({
          judgements: [[0, 'KnownGood']],
          info: { display: { Raw: 'Validator One' }, image: 'None' },
        }),
      }),
    };

    indexer.api = {
      consts: {
        staking: {
          maxNominatorRewardedPerValidator: { toNumber: () => 1 },
        },
      },
      query: {
        identity: {
          identityOf: async () => identity,
        },
        staking: {
          validators: {
            entries: async () => [
              [
                { args: ['validator-1'] },
                {
                  commission: { unwrap: () => ({ toString: () => '100000000' }) },
                  blocked: { isTrue: false },
                },
              ],
            ],
          },
          currentEra: async () => ({ toString: () => '10' }),
          erasValidatorReward: {
            entries: async () => [[{ args: [{ toString: () => '9' }] }, reward]],
          },
          erasRewardPoints: async () => ({
            total: { toString: () => '100' },
            individual: new Map([[account, point]]),
          }),
          erasStakers: {
            entries: async (era: number) => [
              [
                { args: [era, 'validator-1'] },
                {
                  total: (1_000n * SCALE).toString(),
                  own: (100n * SCALE).toString(),
                  others: [
                    { who: { toString: () => 'nominator-1' }, value: '1' },
                    { who: { toString: () => 'nominator-2' }, value: '2' },
                  ],
                },
              ],
            ],
          },
        },
      },
    };

    const documents = await indexer.createStakingValidatorDocuments(
      12,
      1_700_000_000,
      new Map([
        [XOR, SCALE],
        [VAL, 2n * SCALE],
      ]),
      new Map([
        [XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }],
        [VAL, { id: VAL, symbol: 'VAL', name: 'VAL', decimals: 18, supply: 0n }],
      ])
    );
    const stream = indexer.createStakingValidatorsStream(documents, 12, 1_700_000_000);

    expect(documents).toHaveLength(1);
    expect(documents[0]).toEqual(
      expect.objectContaining({
        collection: 'stakingValidators',
        id: 'validator-1',
        data: expect.objectContaining({
          address: 'validator-1',
          apy: '65.7',
          commission: '100000000',
          identity: expect.objectContaining({ info: { display: 'Validator One', image: '' } }),
          isKnownGood: true,
          isOversubscribed: true,
          rewardPoints: 25,
        }),
      })
    );
    expect(JSON.parse(stream.data.data)[0].apy).toBe('65.7');
  });

  it('leaves validator APY null when the reward era has no validator exposure or reward points', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      api: unknown;
      createStakingValidatorDocuments: (
        blockHeight: number,
        timestamp: number,
        prices: Map<string, bigint>,
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>
      ) => Promise<Array<{ data: Record<string, any> }>>;
    };
    const rewardPoints = new Map<object, object>();

    indexer.api = {
      consts: { staking: { maxNominatorRewardedPerValidator: { toNumber: () => 64 } } },
      query: {
        identity: { identityOf: async () => ({ isEmpty: true }) },
        staking: {
          validators: {
            entries: async () => [
              [{ args: ['validator-1'] }, { commission: { unwrap: () => ({ toString: () => '0' }) }, blocked: { isTrue: false } }],
            ],
          },
          currentEra: async () => ({ toString: () => '10' }),
          erasValidatorReward: {
            entries: async () => [[{ args: [{ toString: () => '9' }] }, { unwrap: () => ({ toString: () => '100' }) }]],
          },
          erasRewardPoints: async () => ({
            total: { toString: () => '100' },
            individual: rewardPoints,
          }),
          erasStakers: {
            entries: async (era: number) =>
              era === 10
                ? [
                    [
                      { args: [era, 'validator-1'] },
                      {
                        total: '100',
                        own: '25',
                        others: [{ who: 'nominator-1', value: '75' }],
                      },
                    ],
                  ]
                : [
                    [
                      { args: [era, 'validator-2'] },
                      {
                        total: '200',
                        own: '50',
                        others: [{ who: 'nominator-2', value: '150' }],
                      },
                    ],
                  ],
          },
        },
      },
    };

    const documents = await indexer.createStakingValidatorDocuments(
      12,
      1_700_000_000,
      new Map([
        [XOR, SCALE],
        [VAL, SCALE],
      ]),
      new Map([
        [XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }],
        [VAL, { id: VAL, symbol: 'VAL', name: 'VAL', decimals: 18, supply: 0n }],
      ])
    );

    expect(documents[0]?.data.apy).toBeNull();

    rewardPoints.set({ toString: () => 'validator-1' }, { toString: () => '1' });
    await expect(
      indexer.createStakingValidatorDocuments(
        12,
        1_700_000_000,
        new Map([
          [XOR, SCALE],
          [VAL, SCALE],
        ]),
        new Map([
          [XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }],
          [VAL, { id: VAL, symbol: 'VAL', name: 'VAL', decimals: 18, supply: 0n }],
        ])
      )
    ).rejects.toThrow('has reward points but is missing APY exposure');
  });

  it('derives pool APY from farming reward weights and liquidity', () => {
    const poolId = `${XOR}-${KUSD}`;
    const otherPoolId = `${KUSD}-${PSWAP}`;
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      derivePoolApy: (
        pools: Array<{
          id: string;
          baseAssetId: string;
          targetAssetId: string;
          baseAssetReserves: bigint;
          targetAssetReserves: bigint;
          poolAccount: string;
          poolTokenSupply: bigint;
          liquidityUSD: string;
          priceUSD: string;
        }>,
        farmingPoolFarmers: unknown[],
        currentBlock: number,
        prices: Map<string, bigint>
      ) => Map<string, string>;
    };

    const apy = indexer.derivePoolApy(
      [
        {
          id: poolId,
          baseAssetId: XOR,
          targetAssetId: KUSD,
          baseAssetReserves: 0n,
          targetAssetReserves: 0n,
          poolAccount: '',
          poolTokenSupply: 0n,
          liquidityUSD: '9125000000',
          priceUSD: '1',
        },
        {
          id: otherPoolId,
          baseAssetId: KUSD,
          targetAssetId: PSWAP,
          baseAssetReserves: 0n,
          targetAssetReserves: 0n,
          poolAccount: 'pool-2',
          poolTokenSupply: 0n,
          liquidityUSD: '9125000000',
          priceUSD: '2',
        },
      ],
      [
        [
          { args: [''] },
          {
            toJSON: () => [{ account: 'alice', block: 100, weight: (1_000n * SCALE).toString() }],
          },
        ],
        [
          { args: ['pool-2'] },
          {
            toJSON: () => [{ account: 'bob', block: 100, weight: (1_000n * SCALE).toString() }],
          },
        ],
      ],
      100,
      new Map([[PSWAP, 2n * SCALE]])
    );

    expect(Number(apy.get(poolId))).toBeCloseTo(0.1, 8);
    expect(Number(apy.get(otherPoolId))).toBeCloseTo(0.1, 8);
  });

  it('accumulates account point metadata from indexed activity', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      prices: Map<string, bigint>;
      createAccountDocuments: (
        accounts: string[],
        latestHistoryElementId: string,
        blockHeight: number,
        timestamp: number,
        pendingPointData: Map<string, Record<string, unknown>>,
        update: { module: string; method: string; data: unknown; fee: bigint }
      ) => Promise<Array<{ collection: string; id: string; data: Record<string, unknown> }>>;
    };
    indexer.prices = new Map([[XOR, 5n * SCALE]]);

    const documents = await indexer.createAccountDocuments(['alice'], 'history-1', 10, 1000, new Map(), {
      module: 'assets',
      method: 'burn',
      data: { assetId: XOR, amount: '2', amountUSD: '10' },
      fee: SCALE,
    });
    const meta = documents.find((document) => document.collection === 'accountMeta')?.data;

    expect(meta?.xorFees).toEqual({ amount: '1', amountUSD: '5' });
    expect(meta?.xorBurned).toEqual({ amount: '2', amountUSD: '10' });
  });

  it('counts only newly indexed accounts in block network snapshots', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    await repository.upsert({
      collection: 'accountMeta',
      id: 'alice',
      blockHeight: 1,
      timestamp: 100,
      data: { id: 'alice', accountId: 'alice', createdAtBlock: 1, createdAtTimestamp: 100 },
    });

    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 42 },
                hash: { toString: () => '0xblock' },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'alice' },
                  hash: { toString: () => '0xtransfer' },
                  method: {
                    section: 'assets',
                    method: 'transfer',
                    args: [XOR, 'bob', SCALE.toString()],
                    meta: { args: [{ name: 'assetId' }, { name: 'to' }, { name: 'amount' }] },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [eventRecord('xorFee', 'FeeWithdrawn', { amount: SCALE.toString() }, 0)],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000000000' }),
          },
        },
      },
    };

    await indexer.indexBlockByHash('0xblock');

    const snapshot = await repository.get('networkSnapshots', 'block-42');
    const aliceActivity = await repository.get('accountTransactions', '0xtransfer-alice');
    const bobActivity = await repository.get('accountTransactions', '0xtransfer-bob');

    expect(snapshot?.data.accounts).toBe(1);
    expect(snapshot?.data.transactions).toBe(1);
    expect(aliceActivity?.data).toMatchObject({
      accountId: 'alice',
      historyElementId: '0xtransfer',
      blockHeight: 42,
      timestamp: 1_700_000_000,
    });
    expect(bobActivity?.data).toMatchObject({
      accountId: 'bob',
      historyElementId: '0xtransfer',
      blockHeight: 42,
      timestamp: 1_700_000_000,
    });
  });

  it('indexes Polkamarkt atomic flips as one account activity with combined fees', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      indexBlockByHash: (hash: string) => Promise<void>;
    };
    const sharesIn = (12n * SCALE).toString();
    const collateralReinvested = (5n * SCALE).toString();
    const sharesOut = (10n * SCALE).toString();

    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 44 },
                hash: { toString: () => '0xpolkamarkt-flip-block' },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'alice' },
                  hash: { toString: () => '0xpolkamarkt-flip' },
                  method: {
                    section: 'polkamarkt',
                    method: 'flip_position',
                    args: [7, 'Yes', sharesIn, 0, 0],
                    meta: {
                      args: [
                        { name: 'marketId' },
                        { name: 'fromOutcome' },
                        { name: 'sharesIn' },
                        { name: 'minCollateralOut' },
                        { name: 'minSharesOut' },
                      ],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord(
                'polkamarkt',
                'TradeExecuted',
                {
                  marketId: 7,
                  trader: 'alice',
                  side: 'Sell',
                  outcome: 'Yes',
                  collateralAmount: collateralReinvested,
                  shareAmount: sharesIn,
                  feeAmount: (1n * 10n ** 16n).toString(),
                },
                0
              ),
              eventRecord(
                'polkamarkt',
                'TradeExecuted',
                {
                  marketId: 7,
                  trader: 'alice',
                  side: 'Buy',
                  outcome: 'No',
                  collateralAmount: collateralReinvested,
                  shareAmount: sharesOut,
                  feeAmount: (2n * 10n ** 16n).toString(),
                },
                0
              ),
              eventRecord(
                'polkamarkt',
                'PositionFlipped',
                {
                  marketId: 7,
                  trader: 'alice',
                  fromOutcome: 'YES',
                  toOutcome: 'NO',
                  sharesIn,
                  collateralReinvested,
                  sharesOut,
                },
                0
              ),
              eventRecord('xorFee', 'FeeWithdrawn', { amount: SCALE.toString() }, 0),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000000000' }),
          },
        },
      },
    };

    await indexer.indexBlockByHash('0xpolkamarkt-flip-block');

    const history = await repository.get('historyElements', '0xpolkamarkt-flip');
    const accountActivity = await repository.get('accountTransactions', '0xpolkamarkt-flip-alice');
    const snapshot = await repository.get('networkSnapshots', 'block-44');

    expect(history?.data).toMatchObject({
      module: 'polkamarkt',
      method: 'flip_position',
      dataFrom: 'alice',
      data: {
        marketId: 7,
        side: 'flip',
        fromOutcome: 'YES',
        toOutcome: 'NO',
        collateralReinvestedUsd: '5',
        sharesIn: '12',
        sharesOut: '10',
        sellFeeUsd: '0.01',
        buyFeeUsd: '0.02',
        feeUsd: '0.03',
        price: '0.5',
      },
    });
    expect(accountActivity?.data).toMatchObject({
      accountId: 'alice',
      historyElementId: '0xpolkamarkt-flip',
      blockHeight: 44,
    });
    expect(snapshot?.data.transactions).toBe(1);
    expect(snapshot?.data.volumeUSD).toBe('5');
  });

  it('does not fabricate flip activity when PositionFlipped is absent', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 45 },
                hash: { toString: () => '0xpolkamarkt-missing-flip-event-block' },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'mallory' },
                  hash: { toString: () => '0xpolkamarkt-missing-flip-event' },
                  method: {
                    section: 'polkamarkt',
                    method: 'flip_position',
                    args: [7, 'Yes', (12n * SCALE).toString(), 0, 0],
                    meta: {
                      args: [
                        { name: 'marketId' },
                        { name: 'fromOutcome' },
                        { name: 'sharesIn' },
                        { name: 'minCollateralOut' },
                        { name: 'minSharesOut' },
                      ],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('xorFee', 'FeeWithdrawn', { amount: SCALE.toString() }, 0),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000001000' }),
          },
        },
      },
    };

    await indexer.indexBlockByHash('0xpolkamarkt-missing-flip-event-block');

    const history = await repository.get('historyElements', '0xpolkamarkt-missing-flip-event');
    expect(history?.data.data).toMatchObject({
      marketId: 7,
      fromOutcome: 'Yes',
      sharesIn: (12n * SCALE).toString(),
    });
    expect(history?.data.data).not.toMatchObject({ side: 'flip' });
    expect(history?.data.data).not.toHaveProperty('collateralReinvestedUsd');
  });

  it('does not attach PositionFlipped events from another extrinsic', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 46 },
                hash: { toString: () => '0xpolkamarkt-wrong-phase-flip-block' },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'mallory' },
                  hash: { toString: () => '0xpolkamarkt-wrong-phase-flip' },
                  method: {
                    section: 'polkamarkt',
                    method: 'flip_position',
                    args: [7, 'Yes', (12n * SCALE).toString(), 0, 0],
                    meta: {
                      args: [
                        { name: 'marketId' },
                        { name: 'fromOutcome' },
                        { name: 'sharesIn' },
                        { name: 'minCollateralOut' },
                        { name: 'minSharesOut' },
                      ],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord(
                'polkamarkt',
                'PositionFlipped',
                {
                  marketId: 7,
                  trader: 'mallory',
                  fromOutcome: 'YES',
                  toOutcome: 'NO',
                  sharesIn: (12n * SCALE).toString(),
                  collateralReinvested: (5n * SCALE).toString(),
                  sharesOut: (10n * SCALE).toString(),
                },
                1
              ),
              eventRecord('xorFee', 'FeeWithdrawn', { amount: SCALE.toString() }, 0),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000001500' }),
          },
        },
      },
    };

    await indexer.indexBlockByHash('0xpolkamarkt-wrong-phase-flip-block');

    const history = await repository.get('historyElements', '0xpolkamarkt-wrong-phase-flip');
    expect(history?.data.data).toMatchObject({
      marketId: 7,
      fromOutcome: 'Yes',
      sharesIn: (12n * SCALE).toString(),
    });
    expect(history?.data.data).not.toMatchObject({ side: 'flip' });
    expect(history?.data.data).not.toHaveProperty('collateralReinvestedUsd');
  });

  it('aggregates Polkamarkt batch claims without inventing payouts for skipped markets', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 46 },
                hash: { toString: () => '0xpolkamarkt-claims-block' },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'alice' },
                  hash: { toString: () => '0xpolkamarkt-claims' },
                  method: {
                    section: 'polkamarkt',
                    method: 'claim_markets',
                    args: [[1, 2, 3]],
                    meta: { args: [{ name: 'marketIds' }] },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('polkamarkt', 'MarketClaimed', { marketId: 1, trader: 'alice', payout: (2n * SCALE).toString() }, 0),
              eventRecord('polkamarkt', 'MarketClaimed', { marketId: 3, trader: 'alice', payout: (3n * SCALE).toString() }, 0),
              eventRecord('polkamarkt', 'MarketClaimsBatched', { trader: 'alice', requested: 3, claimed: 2 }, 0),
              eventRecord('xorFee', 'FeeWithdrawn', { amount: SCALE.toString() }, 0),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000002000' }),
          },
        },
      },
    };

    await indexer.indexBlockByHash('0xpolkamarkt-claims-block');

    const history = await repository.get('historyElements', '0xpolkamarkt-claims');
    expect(history?.data).toMatchObject({
      module: 'polkamarkt',
      method: 'claim_markets',
      dataFrom: 'alice',
      data: {
        marketId: 1,
        side: 'claim',
        claimedMarkets: 2,
        requestedMarkets: 3,
        collateralUsd: '5',
        collateralAmountUsd: '5',
      },
    });
  });

  it('indexes zero-payout Polkamarkt batch claims without inventing collateral', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 47 },
                hash: { toString: () => '0xpolkamarkt-zero-claim-block' },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'alice' },
                  hash: { toString: () => '0xpolkamarkt-zero-claim' },
                  method: {
                    section: 'polkamarkt',
                    method: 'claim_markets',
                    args: [[1, 1, 1]],
                    meta: { args: [{ name: 'marketIds' }] },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('polkamarkt', 'MarketClaimed', { marketId: 1, trader: 'alice', payout: '0' }, 0),
              eventRecord('polkamarkt', 'MarketClaimsBatched', { trader: 'alice', requested: 3, claimed: 1 }, 0),
              eventRecord('xorFee', 'FeeWithdrawn', { amount: SCALE.toString() }, 0),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000002250' }),
          },
        },
      },
    };

    await indexer.indexBlockByHash('0xpolkamarkt-zero-claim-block');

    const history = await repository.get('historyElements', '0xpolkamarkt-zero-claim');
    const snapshot = await repository.get('networkSnapshots', 'block-47');
    expect(history?.data).toMatchObject({
      module: 'polkamarkt',
      method: 'claim_markets',
      dataFrom: 'alice',
      data: {
        marketId: 1,
        side: 'claim',
        claimedMarkets: 1,
        requestedMarkets: 3,
        collateralUsd: '0',
        collateralAmountUsd: '0',
      },
    });
    expect(snapshot?.data.volumeUSD).toBe('0');
  });

  it('does not synthesize batch claim activity from a bare batch summary event', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 47 },
                hash: { toString: () => '0xpolkamarkt-bare-claims-block' },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'mallory' },
                  hash: { toString: () => '0xpolkamarkt-bare-claims' },
                  method: {
                    section: 'polkamarkt',
                    method: 'claim_markets',
                    args: [[1, 2]],
                    meta: { args: [{ name: 'marketIds' }] },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('polkamarkt', 'MarketClaimsBatched', { trader: 'mallory', requested: 2, claimed: 0 }, 0),
              eventRecord('xorFee', 'FeeWithdrawn', { amount: SCALE.toString() }, 0),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000002500' }),
          },
        },
      },
    };

    await indexer.indexBlockByHash('0xpolkamarkt-bare-claims-block');

    const history = await repository.get('historyElements', '0xpolkamarkt-bare-claims');
    expect(history?.data.data).toMatchObject({ marketIds: [1, 2] });
    expect(history?.data.data).not.toMatchObject({ side: 'claim' });
    expect(history?.data.data).not.toHaveProperty('claimedMarkets');
    expect(history?.data.data).not.toHaveProperty('collateralUsd');
  });

  it('does not attribute batch claim payouts when claim and batch traders disagree', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 49 },
                hash: { toString: () => '0xpolkamarkt-mismatched-claims-block' },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'alice' },
                  hash: { toString: () => '0xpolkamarkt-mismatched-claims' },
                  method: {
                    section: 'polkamarkt',
                    method: 'claim_markets',
                    args: [[1, 2]],
                    meta: { args: [{ name: 'marketIds' }] },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('polkamarkt', 'MarketClaimed', { marketId: 1, trader: 'bob', payout: (2n * SCALE).toString() }, 0),
              eventRecord('polkamarkt', 'MarketClaimsBatched', { trader: 'alice', requested: 2, claimed: 1 }, 0),
              eventRecord('xorFee', 'FeeWithdrawn', { amount: SCALE.toString() }, 0),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000002600' }),
          },
        },
      },
    };

    await indexer.indexBlockByHash('0xpolkamarkt-mismatched-claims-block');

    const history = await repository.get('historyElements', '0xpolkamarkt-mismatched-claims');
    const bobActivity = await repository.get('accountTransactions', '0xpolkamarkt-mismatched-claims-bob');
    expect(history?.data.data).toMatchObject({ marketIds: [1, 2] });
    expect(history?.data.data).not.toMatchObject({ side: 'claim' });
    expect(history?.data.data).not.toHaveProperty('claimedMarkets');
    expect(history?.data.data).not.toHaveProperty('collateralUsd');
    expect(bobActivity).toBeNull();
  });

  it('does not trust Polkamarkt pallet events attached to failed extrinsics', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 48 },
                hash: { toString: () => '0xpolkamarkt-failed-flip-block' },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'alice' },
                  hash: { toString: () => '0xpolkamarkt-failed-flip' },
                  method: {
                    section: 'polkamarkt',
                    method: 'flip_position',
                    args: [7, 'Yes', (12n * SCALE).toString(), 0, 0],
                    meta: {
                      args: [
                        { name: 'marketId' },
                        { name: 'fromOutcome' },
                        { name: 'sharesIn' },
                        { name: 'minCollateralOut' },
                        { name: 'minSharesOut' },
                      ],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord(
                'polkamarkt',
                'TradeExecuted',
                {
                  marketId: 7,
                  trader: 'alice',
                  side: 'Sell',
                  outcome: 'Yes',
                  collateralAmount: (5n * SCALE).toString(),
                  shareAmount: (12n * SCALE).toString(),
                  feeAmount: (1n * 10n ** 16n).toString(),
                },
                0
              ),
              eventRecord(
                'polkamarkt',
                'PositionFlipped',
                {
                  marketId: 7,
                  trader: 'alice',
                  fromOutcome: 'YES',
                  toOutcome: 'NO',
                  sharesIn: (12n * SCALE).toString(),
                  collateralReinvested: (5n * SCALE).toString(),
                  sharesOut: (10n * SCALE).toString(),
                },
                0
              ),
              eventRecord('xorFee', 'FeeWithdrawn', { amount: SCALE.toString() }, 0),
              eventRecord('system', 'ExtrinsicFailed', {}, 0),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000002750' }),
          },
        },
      },
    };

    await indexer.indexBlockByHash('0xpolkamarkt-failed-flip-block');

    const history = await repository.get('historyElements', '0xpolkamarkt-failed-flip');
    const snapshot = await repository.get('networkSnapshots', 'block-48');
    expect(history?.data.execution).toMatchObject({ success: false });
    expect(history?.data.data).toMatchObject({
      marketId: 7,
      fromOutcome: 'Yes',
      sharesIn: (12n * SCALE).toString(),
    });
    expect(history?.data.data).not.toMatchObject({ side: 'flip' });
    expect(history?.data.data).not.toHaveProperty('collateralReinvestedUsd');
    expect(snapshot?.data.transactions).toBe(1);
    expect(snapshot?.data.volumeUSD).toBe('0');
  });

  it('counts only signed fee-paying extrinsics as block network transactions', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 43 },
                hash: { toString: () => '0xblock-transactions' },
              },
              extrinsics: [
                {
                  isSigned: false,
                  hash: { toString: () => '0xtimestamp' },
                  method: {
                    section: 'timestamp',
                    method: 'set',
                    args: ['1700000000000'],
                    meta: { args: [{ name: 'now' }] },
                  },
                },
                {
                  isSigned: true,
                  signer: { toString: () => 'alice' },
                  hash: { toString: () => '0xfee-transfer' },
                  method: {
                    section: 'assets',
                    method: 'transfer',
                    args: [XOR, 'bob', SCALE.toString()],
                    meta: { args: [{ name: 'assetId' }, { name: 'to' }, { name: 'amount' }] },
                  },
                },
                {
                  isSigned: true,
                  signer: { toString: () => 'carol' },
                  hash: { toString: () => '0xfree-remark' },
                  method: {
                    section: 'system',
                    method: 'remark',
                    args: ['0x00'],
                    meta: { args: [{ name: 'remark' }] },
                  },
                },
                {
                  isSigned: false,
                  hash: { toString: () => '0xunsigned-fee-event' },
                  method: {
                    section: 'system',
                    method: 'remark',
                    args: ['0x01'],
                    meta: { args: [{ name: 'remark' }] },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('xorFee', 'FeeWithdrawn', { amount: SCALE.toString() }, 1),
              eventRecord('xorFee', 'FeeWithdrawn', { amount: SCALE.toString() }, 3),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000000000' }),
          },
        },
      },
    };

    await indexer.indexBlockByHash('0xblock-transactions');

    const snapshot = await repository.get('networkSnapshots', 'block-43');

    expect(snapshot?.data.transactions).toBe(1);
    expect(snapshot?.data.fees).toBe((2n * SCALE).toString());
  });

  it('does not count failed swaps as business volume while still counting the paid transaction fee', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 60 },
                hash: { toString: () => '0xfailed-swap-block' },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'alice' },
                  hash: { toString: () => '0xfailed-swap' },
                  method: {
                    section: 'liquidityProxy',
                    method: 'swap',
                    args: [
                      0,
                      XOR,
                      KUSD,
                      { WithDesiredInput: { desiredAmountIn: (5n * SCALE).toString(), minAmountOut: '0' } },
                      'PoolXYK',
                      'Disabled',
                    ],
                    meta: {
                      args: [
                        { name: 'dexId' },
                        { name: 'inputAssetId' },
                        { name: 'outputAssetId' },
                        { name: 'swapAmount' },
                        { name: 'selectedSourceType' },
                        { name: 'filterMode' },
                      ],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('xorFee', 'FeeWithdrawn', { amount: SCALE.toString() }),
              eventRecord('system', 'ExtrinsicFailed', {}),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000000000' }),
          },
        },
      },
    };

    await indexer.indexBlockByHash('0xfailed-swap-block');

    const snapshot = await repository.get('networkSnapshots', 'block-60');
    const accountMeta = await repository.get('accountMeta', 'alice');

    expect(snapshot?.data.transactions).toBe(1);
    expect(snapshot?.data.swaps).toBe(0);
    expect(snapshot?.data.volumeUSD).toBe('0');
    expect(snapshot?.data.fees).toBe(SCALE.toString());
    expect(accountMeta?.data.xorFees).toEqual({ amount: '1', amountUSD: '2' });
  });

  it('does not count failed bridge burns as outgoing bridge volume or deposits', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 61 },
                hash: { toString: () => '0xfailed-bridge-block' },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'alice' },
                  hash: { toString: () => '0xfailed-bridge-burn' },
                  method: {
                    section: 'bridgeProxy',
                    method: 'burn',
                    args: [{ EVM: '0x6f' }, XOR, { EVM: '0xrecipient' }, (5n * SCALE).toString()],
                    meta: {
                      args: [{ name: 'networkId' }, { name: 'assetId' }, { name: 'recipient' }, { name: 'amount' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('xorFee', 'FeeWithdrawn', { amount: SCALE.toString() }),
              eventRecord('system', 'ExtrinsicFailed', {}),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000000000' }),
          },
        },
      },
    };

    await indexer.indexBlockByHash('0xfailed-bridge-block');

    const snapshot = await repository.get('networkSnapshots', 'block-61');
    const accountMeta = await repository.get('accountMeta', 'alice');

    expect(snapshot?.data.transactions).toBe(1);
    expect(snapshot?.data.bridgeOutgoingTransactions).toBe(0);
    expect(snapshot?.data.volumeUSD).toBe('0');
    expect(accountMeta?.data.deposit).toEqual({ incomingUSD: '0', outgoingUSD: '0' });
    expect(accountMeta?.data.xorFees).toEqual({ amount: '1', amountUSD: '2' });
  });

  it('indexes utility batch burn calls for burn page stats', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      indexBlockByHash: (hash: string) => Promise<void>;
    };
    const blockTimestampMs = 1_700_000_000_000;
    const burnCall = {
      section: 'assets',
      method: 'burn',
      args: [XOR, '10000000000000000000'],
      meta: { args: [{ name: 'assetId' }, { name: 'amount' }] },
    };
    const remarkCall = {
      section: 'system',
      method: 'remark',
      args: ['0x7b7d'],
      meta: { args: [{ name: 'remark' }] },
    };

    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 25_900_001 },
                hash: { toString: () => '0xblock' },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'alice' },
                  hash: { toString: () => '0xbatchburn' },
                  method: {
                    section: 'utility',
                    method: 'batchAll',
                    args: [[burnCall, remarkCall]],
                    meta: { args: [{ name: 'calls' }] },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => String(blockTimestampMs) }),
          },
        },
      },
    };

    await indexer.indexBlockByHash('0xblock');

    const history = await repository.get('historyElements', '0xbatchburn');
    const xorBurn = await repository.get('xorBurns', '0xbatchburn');
    const chainState = await repository.get('updatesStreams', 'chainState');

    expect(history?.data).toMatchObject({
      module: 'utility',
      method: 'batchAll',
      address: 'alice',
      blockHeight: 25_900_001,
      timestamp: 1_700_000_000,
      callNames: ['assets.burn', 'system.remark'],
      calls: [
        {
          module: 'assets',
          method: 'burn',
          data: { args: { assetId: XOR, amount: '10000000000000000000' } },
        },
        {
          module: 'system',
          method: 'remark',
          data: { args: { remark: '0x7b7d' } },
        },
      ],
    });
    expect(xorBurn?.data).toMatchObject({
      id: '0xbatchburn',
      address: 'alice',
      amount: '10',
      assetId: XOR,
      blockHeight: 25_900_001,
      timestamp: 1_700_000_000,
      txHash: '0xbatchburn',
    });
    expect(chainState?.data).toMatchObject({
      id: 'chainState',
      block: 25_900_001,
      data: JSON.stringify({ lastIndexedBlock: 25_900_001 }),
    });
  });

  it('indexes bridgeProxy burn history with request metadata for EVM outgoing restores', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 42 },
                hash: { toString: () => '0xbridgeblock' },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'alice' },
                  hash: { toString: () => '0xevmburn' },
                  method: {
                    section: 'bridgeProxy',
                    method: 'burn',
                    args: [{ EVM: '0x6f' }, XOR, { EVM: '0xrecipient' }, (5n * SCALE).toString()],
                    meta: {
                      args: [{ name: 'networkId' }, { name: 'assetId' }, { name: 'recipient' }, { name: 'amount' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xrequest', status: 'Done' })],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000000000' }),
          },
        },
      },
    };

    await indexer.indexBlockByHash('0xbridgeblock');

    const history = await repository.get('historyElements', '0xevmburn');
    const snapshot = await repository.get('networkSnapshots', 'block-42');
    const accountMeta = await repository.get('accountMeta', 'alice');
    const aliceActivity = await repository.get('accountTransactions', '0xevmburn-alice');
    const externalActivity = await repository.get('accountTransactions', '0xevmburn-0xrecipient');

    expect(history?.data).toMatchObject({
      module: 'bridgeProxy',
      method: 'burn',
      address: 'alice',
      dataFrom: 'alice',
      dataTo: '0xrecipient',
      data: {
        assetId: XOR,
        amount: '5',
        amountUSD: '10',
        networkId: '0x6f',
        recipient: '0xrecipient',
        requestHash: '0xrequest',
        status: 'Done',
      },
    });
    expect(snapshot?.data.bridgeOutgoingTransactions).toBe(1);
    expect(accountMeta?.data.deposit).toEqual({ incomingUSD: '0', outgoingUSD: '10' });
    expect(aliceActivity?.data).toMatchObject({ accountId: 'alice', historyElementId: '0xevmburn' });
    expect(externalActivity).toBeNull();
  });

  it('indexes bridgeProxy burn history for outgoing Liberland bridge transfers without treating the external account as local', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 45 },
                hash: { toString: () => '0xliberlandoutblock' },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'alice' },
                  hash: { toString: () => '0xliberlandout' },
                  method: {
                    section: 'bridgeProxy',
                    method: 'burn',
                    args: [{ Sub: 'Liberland' }, XOR, { Liberland: LIBERLAND_ACCOUNT }, (7n * SCALE).toString()],
                    meta: {
                      args: [{ name: 'networkId' }, { name: 'assetId' }, { name: 'recipient' }, { name: 'amount' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xliberlandrequest', status: 'Done' }),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000002000' }),
          },
        },
      },
    };

    await indexer.indexBlockByHash('0xliberlandoutblock');

    const history = await repository.get('historyElements', '0xliberlandout');
    const snapshot = await repository.get('networkSnapshots', 'block-45');
    const accountMeta = await repository.get('accountMeta', 'alice');
    const aliceActivity = await repository.get('accountTransactions', '0xliberlandout-alice');
    const externalActivity = await repository.get('accountTransactions', `0xliberlandout-${LIBERLAND_ACCOUNT}`);

    expect(history?.data).toMatchObject({
      module: 'bridgeProxy',
      method: 'burn',
      address: 'alice',
      dataFrom: 'alice',
      dataTo: LIBERLAND_ACCOUNT,
      data: {
        assetId: XOR,
        amount: '7',
        amountUSD: '14',
        networkId: 'Liberland',
        externalNetwork: 'Liberland',
        externalNetworkType: 'Sub',
        recipient: LIBERLAND_ACCOUNT,
        requestHash: '0xliberlandrequest',
        status: 'Done',
      },
    });
    expect(snapshot?.data.bridgeOutgoingTransactions).toBe(1);
    expect(accountMeta?.data.deposit).toEqual({ incomingUSD: '0', outgoingUSD: '14' });
    expect(aliceActivity?.data).toMatchObject({ accountId: 'alice', historyElementId: '0xliberlandout' });
    expect(externalActivity).toBeNull();
  });

  it('indexes liquidityProxy swap history from the actual Exchange event amounts', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([
      [XOR, 3n * SCALE],
      [KUSD, SCALE],
    ]);
    indexer.assetInfos = new Map([
      [XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }],
      [KUSD, { id: KUSD, symbol: 'KUSD', name: 'Kensetsu USD', decimals: 18, supply: 0n }],
    ]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 44 },
                hash: { toString: () => '0xswapblock' },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'alice' },
                  hash: { toString: () => '0xswap' },
                  method: {
                    section: 'liquidityProxy',
                    method: 'swap',
                    args: [
                      0,
                      XOR,
                      KUSD,
                      {
                        WithDesiredInput: {
                          desiredAmountIn: '0',
                          minAmountOut: '0',
                        },
                      },
                      'PoolXYK',
                      'Disabled',
                    ],
                    meta: {
                      args: [
                        { name: 'dexId' },
                        { name: 'inputAssetId' },
                        { name: 'outputAssetId' },
                        { name: 'swapAmount' },
                        { name: 'selectedSourceType' },
                        { name: 'filterMode' },
                      ],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('liquidityProxy', 'Exchange', {
                arg0: 'alice',
                arg1: 0,
                arg2: XOR,
                arg3: KUSD,
                arg4: (5n * SCALE).toString(),
                arg5: ((499n * SCALE) / 100n).toString(),
                arg6: '0',
              }),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000000000' }),
          },
        },
      },
    };

    await indexer.indexBlockByHash('0xswapblock');

    const history = await repository.get('historyElements', '0xswap');
    const snapshot = await repository.get('networkSnapshots', 'block-44');

    expect(history?.data).toMatchObject({
      module: 'liquidityProxy',
      method: 'swap',
      address: 'alice',
      dataFrom: 'alice',
      data: {
        baseAssetId: XOR,
        targetAssetId: KUSD,
        selectedMarket: 'PoolXYK',
        baseAssetAmount: '5',
        targetAssetAmount: '4.99',
        baseAssetAmountUSD: '15',
        targetAssetAmountUSD: '4.99',
      },
    });
    expect(snapshot?.data.swaps).toBe(1);
    expect(snapshot?.data.volumeUSD).toBe('15');
  });

  it('indexes bridgeMultisig asset movements by recipient for ETH incoming restores', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 43 },
                hash: { toString: () => '0xethincomingblock' },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'bridge-peer' },
                  hash: { toString: () => '0xethincoming' },
                  method: {
                    section: 'bridgeMultisig',
                    method: 'asMulti',
                    args: [{ toHex: () => '0ximportincomingrequest', toJSON: () => ({ call: 'expanded' }) }],
                    meta: { args: [{ name: 'call' }] },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('assets', 'Issued', { assetId: XOR, owner: 'alice', amount: (4n * SCALE).toString() }),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000000500' }),
          },
        },
      },
    };

    await indexer.indexBlockByHash('0xethincomingblock');

    const history = await repository.get('historyElements', '0xethincoming');
    const accountMeta = await repository.get('accountMeta', 'alice');
    const aliceActivity = await repository.get('accountTransactions', '0xethincoming-alice');
    const bridgeSignerActivity = await repository.get('accountTransactions', '0xethincoming-bridge-peer');

    expect(history?.data).toMatchObject({
      module: 'bridgeMultisig',
      method: 'asMulti',
      address: 'bridge-peer',
      dataFrom: 'bridge-peer',
      dataTo: 'alice',
      dataAssets: [XOR],
      data: {
        amount: '4',
        amountUSD: '8',
        assetId: XOR,
        call: '0ximportincomingrequest',
        to: 'alice',
      },
    });
    expect(accountMeta?.data.deposit).toEqual({ incomingUSD: '8', outgoingUSD: '0' });
    expect(aliceActivity?.data).toMatchObject({ accountId: 'alice', historyElementId: '0xethincoming' });
    expect(bridgeSignerActivity).toBeNull();
  });

  it('indexes bridgeProxy request events as mint history for EVM incoming restores', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 43 },
                hash: { toString: () => '0xinboundblock' },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'relayer' },
                  hash: { toString: () => '0xinboundsubmit' },
                  method: {
                    section: 'bridgeChannelInbound',
                    method: 'submit',
                    args: [
                      { EVM: '0x6f' },
                      {
                        source: { EVM: '0xsender' },
                        dest: { Sora: 'alice' },
                      },
                    ],
                    meta: {
                      args: [{ name: 'networkId' }, { name: 'message' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xinboundrequest', status: 'Done' }),
              eventRecord('assets', 'Issued', { assetId: XOR, owner: 'alice', amount: (3n * SCALE).toString() }),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000001000' }),
          },
        },
      },
    };

    await indexer.indexBlockByHash('0xinboundblock');

    const original = await repository.get('historyElements', '0xinboundsubmit');
    const history = await repository.get('historyElements', '0xinboundrequest-mint');
    const snapshot = await repository.get('networkSnapshots', 'block-43');
    const accountMeta = await repository.get('accountMeta', 'alice');

    expect(original?.data).toMatchObject({
      module: 'bridgeChannelInbound',
      method: 'submit',
      address: 'relayer',
    });
    expect(history?.data).toMatchObject({
      module: 'bridgeProxy',
      method: 'mint',
      address: 'relayer',
      dataFrom: 'alice',
      dataTo: '0xsender',
      data: {
        assetId: XOR,
        amount: '3',
        amountUSD: '6',
        networkId: '0x6f',
        recipient: 'alice',
        sender: '0xsender',
        requestHash: '0xinboundrequest',
        status: 'Done',
      },
    });
    expect(snapshot?.data.bridgeIncomingTransactions).toBe(1);
    expect(accountMeta?.data.deposit).toEqual({ incomingUSD: '6', outgoingUSD: '0' });
  });

  it('indexes bridgeProxy request events as mint history for incoming Liberland bridge transfers', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 46 },
                hash: { toString: () => '0xliberlandinblock' },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'relayer' },
                  hash: { toString: () => '0xliberlandinboundsubmit' },
                  method: {
                    section: 'bridgeChannelInbound',
                    method: 'submit',
                    args: [
                      { Sub: 'Liberland' },
                      {
                        source: { Liberland: LIBERLAND_ACCOUNT },
                        dest: { Sora: 'alice' },
                        assetId: XOR,
                      },
                    ],
                    meta: {
                      args: [{ name: 'networkId' }, { name: 'message' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xliberlandinrequest', status: 'Done' }),
              eventRecord('assets', 'Issued', { assetId: XOR, owner: 'alice', amount: (4n * SCALE).toString() }),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000003000' }),
          },
        },
      },
    };

    await indexer.indexBlockByHash('0xliberlandinblock');

    const original = await repository.get('historyElements', '0xliberlandinboundsubmit');
    const history = await repository.get('historyElements', '0xliberlandinrequest-mint');
    const snapshot = await repository.get('networkSnapshots', 'block-46');
    const accountMeta = await repository.get('accountMeta', 'alice');
    const aliceActivity = await repository.get('accountTransactions', '0xliberlandinrequest-mint-alice');
    const externalActivity = await repository.get('accountTransactions', `0xliberlandinrequest-mint-${LIBERLAND_ACCOUNT}`);

    expect(original?.data).toMatchObject({
      module: 'bridgeChannelInbound',
      method: 'submit',
      address: 'relayer',
    });
    expect(history?.data).toMatchObject({
      module: 'bridgeProxy',
      method: 'mint',
      address: 'relayer',
      dataFrom: 'alice',
      dataTo: LIBERLAND_ACCOUNT,
      data: {
        assetId: XOR,
        amount: '4',
        amountUSD: '8',
        networkId: 'Liberland',
        externalNetwork: 'Liberland',
        externalNetworkType: 'Sub',
        recipient: 'alice',
        sender: LIBERLAND_ACCOUNT,
        requestHash: '0xliberlandinrequest',
        status: 'Done',
      },
    });
    expect(snapshot?.data.bridgeIncomingTransactions).toBe(1);
    expect(accountMeta?.data.deposit).toEqual({ incomingUSD: '8', outgoingUSD: '0' });
    expect(aliceActivity?.data).toMatchObject({ accountId: 'alice', historyElementId: '0xliberlandinrequest-mint' });
    expect(externalActivity).toBeNull();
  });

  it('does not synthesize EVM incoming bridge history without a request hash event', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 44 },
                hash: { toString: () => '0xinbound-no-request-block' },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'relayer' },
                  hash: { toString: () => '0xinbound-no-request' },
                  method: {
                    section: 'bridgeChannelInbound',
                    method: 'submit',
                    args: [
                      { EVM: '0x6f' },
                      {
                        source: { EVM: '0xsender' },
                        dest: { Sora: 'alice' },
                      },
                    ],
                    meta: {
                      args: [{ name: 'networkId' }, { name: 'message' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [eventRecord('assets', 'Issued', { assetId: XOR, owner: 'alice', amount: SCALE.toString() })],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000002000' }),
          },
        },
      },
    };

    await indexer.indexBlockByHash('0xinbound-no-request-block');

    const original = await repository.get('historyElements', '0xinbound-no-request');
    const accidentalSynthetic = await repository.get('historyElements', '-mint');
    const snapshot = await repository.get('networkSnapshots', 'block-44');
    const accountMeta = await repository.get('accountMeta', 'alice');

    expect(original?.data).toMatchObject({
      module: 'bridgeChannelInbound',
      method: 'submit',
      address: 'relayer',
    });
    expect(accidentalSynthetic).toBeNull();
    expect(snapshot?.data.bridgeIncomingTransactions).toBe(0);
    expect(accountMeta).toBeNull();
  });

  it('does not synthesize EVM incoming bridge history when the request has no asset movement', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 45 },
                hash: { toString: () => '0xinbound-no-asset-block' },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'relayer' },
                  hash: { toString: () => '0xinbound-no-asset' },
                  method: {
                    section: 'bridgeChannelInbound',
                    method: 'submit',
                    args: [
                      { EVM: '0x6f' },
                      {
                        source: { EVM: '0xsender' },
                        dest: { Sora: 'alice' },
                      },
                    ],
                    meta: {
                      args: [{ name: 'networkId' }, { name: 'message' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xrequest-no-asset', status: 'Done' }),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000003000' }),
          },
        },
      },
    };

    await indexer.indexBlockByHash('0xinbound-no-asset-block');

    const synthetic = await repository.get('historyElements', '0xrequest-no-asset-mint');
    const snapshot = await repository.get('networkSnapshots', 'block-45');
    const accountMeta = await repository.get('accountMeta', 'alice');

    expect(synthetic).toBeNull();
    expect(snapshot?.data.bridgeIncomingTransactions).toBe(0);
    expect(accountMeta).toBeNull();
  });

  it('does not synthesize EVM incoming bridge history for invalid asset movement amounts', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 46 },
                hash: { toString: () => '0xinbound-invalid-amount-block' },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'relayer' },
                  hash: { toString: () => '0xinbound-invalid-amount' },
                  method: {
                    section: 'bridgeChannelInbound',
                    method: 'submit',
                    args: [
                      { EVM: '0x6f' },
                      {
                        source: { EVM: '0xsender' },
                        dest: { Sora: 'alice' },
                      },
                    ],
                    meta: {
                      args: [{ name: 'networkId' }, { name: 'message' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xrequest-invalid-amount', status: 'Done' }),
              eventRecord('assets', 'Issued', { assetId: XOR, owner: 'alice', amount: 'not-a-number' }),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000003500' }),
          },
        },
      },
    };

    await indexer.indexBlockByHash('0xinbound-invalid-amount-block');

    const synthetic = await repository.get('historyElements', '0xrequest-invalid-amount-mint');
    const snapshot = await repository.get('networkSnapshots', 'block-46');
    const accountMeta = await repository.get('accountMeta', 'alice');

    expect(synthetic).toBeNull();
    expect(snapshot?.data.bridgeIncomingTransactions).toBe(0);
    expect(accountMeta).toBeNull();
  });

  it('does not synthesize EVM incoming bridge history for zero asset movement amounts', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 47 },
                hash: { toString: () => '0xinbound-zero-amount-block' },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'relayer' },
                  hash: { toString: () => '0xinbound-zero-amount' },
                  method: {
                    section: 'bridgeChannelInbound',
                    method: 'submit',
                    args: [
                      { EVM: '0x6f' },
                      {
                        source: { EVM: '0xsender' },
                        dest: { Sora: 'alice' },
                      },
                    ],
                    meta: {
                      args: [{ name: 'networkId' }, { name: 'message' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xrequest-zero-amount', status: 'Done' }),
              eventRecord('assets', 'Issued', { assetId: XOR, owner: 'alice', amount: '0' }),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000003600' }),
          },
        },
      },
    };

    await indexer.indexBlockByHash('0xinbound-zero-amount-block');

    const synthetic = await repository.get('historyElements', '0xrequest-zero-amount-mint');
    const snapshot = await repository.get('networkSnapshots', 'block-47');
    const accountMeta = await repository.get('accountMeta', 'alice');

    expect(synthetic).toBeNull();
    expect(snapshot?.data.bridgeIncomingTransactions).toBe(0);
    expect(accountMeta).toBeNull();
  });

  it('does not synthesize EVM incoming bridge history for failed inbound extrinsics', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 48 },
                hash: { toString: () => '0xinbound-failed-block' },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'relayer' },
                  hash: { toString: () => '0xinbound-failed' },
                  method: {
                    section: 'bridgeChannelInbound',
                    method: 'submit',
                    args: [
                      { EVM: '0x6f' },
                      {
                        source: { EVM: '0xsender' },
                        dest: { Sora: 'alice' },
                      },
                    ],
                    meta: {
                      args: [{ name: 'networkId' }, { name: 'message' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('system', 'ExtrinsicFailed', { dispatchError: { module: { index: 1, error: '0x00' } } }),
              eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xrequest-failed', status: 'Done' }),
              eventRecord('assets', 'Issued', { assetId: XOR, owner: 'alice', amount: SCALE.toString() }),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000003700' }),
          },
        },
      },
    };

    await indexer.indexBlockByHash('0xinbound-failed-block');

    const original = await repository.get('historyElements', '0xinbound-failed');
    const synthetic = await repository.get('historyElements', '0xrequest-failed-mint');
    const snapshot = await repository.get('networkSnapshots', 'block-48');
    const accountMeta = await repository.get('accountMeta', 'alice');

    expect((original?.data.execution as { success: boolean }).success).toBe(false);
    expect(synthetic).toBeNull();
    expect(snapshot?.data.bridgeIncomingTransactions).toBe(0);
    expect(accountMeta).toBeNull();
  });

  it('does not synthesize EVM incoming bridge history without an inbound recipient', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 53 },
                hash: { toString: () => '0xinbound-missing-recipient-block' },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'relayer' },
                  hash: { toString: () => '0xinbound-missing-recipient' },
                  method: {
                    section: 'bridgeChannelInbound',
                    method: 'submit',
                    args: [
                      { EVM: '0x6f' },
                      {
                        source: { EVM: '0xsender' },
                      },
                    ],
                    meta: {
                      args: [{ name: 'networkId' }, { name: 'message' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xrequest-missing-recipient', status: 'Done' }),
              eventRecord('assets', 'Issued', { assetId: XOR, owner: 'alice', amount: SCALE.toString() }),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000004100' }),
          },
        },
      },
    };

    await indexer.indexBlockByHash('0xinbound-missing-recipient-block');

    const synthetic = await repository.get('historyElements', '0xrequest-missing-recipient-mint');
    const snapshot = await repository.get('networkSnapshots', 'block-53');
    const accountMeta = await repository.get('accountMeta', 'alice');

    expect(synthetic).toBeNull();
    expect(snapshot?.data.bridgeIncomingTransactions).toBe(0);
    expect(accountMeta).toBeNull();
  });

  it('does not synthesize EVM incoming bridge history without an external sender', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 54 },
                hash: { toString: () => '0xinbound-missing-sender-block' },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'relayer' },
                  hash: { toString: () => '0xinbound-missing-sender' },
                  method: {
                    section: 'bridgeChannelInbound',
                    method: 'submit',
                    args: [
                      { EVM: '0x6f' },
                      {
                        dest: { Sora: 'alice' },
                      },
                    ],
                    meta: {
                      args: [{ name: 'networkId' }, { name: 'message' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xrequest-missing-sender', status: 'Done' }),
              eventRecord('assets', 'Issued', { assetId: XOR, owner: 'alice', amount: SCALE.toString() }),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000004200' }),
          },
        },
      },
    };

    await indexer.indexBlockByHash('0xinbound-missing-sender-block');

    const synthetic = await repository.get('historyElements', '0xrequest-missing-sender-mint');
    const snapshot = await repository.get('networkSnapshots', 'block-54');
    const accountMeta = await repository.get('accountMeta', 'alice');

    expect(synthetic).toBeNull();
    expect(snapshot?.data.bridgeIncomingTransactions).toBe(0);
    expect(accountMeta).toBeNull();
  });

  it('does not synthesize EVM incoming bridge history without a network id', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 55 },
                hash: { toString: () => '0xinbound-missing-network-block' },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'relayer' },
                  hash: { toString: () => '0xinbound-missing-network' },
                  method: {
                    section: 'bridgeChannelInbound',
                    method: 'submit',
                    args: [
                      {
                        source: { EVM: '0xsender' },
                        dest: { Sora: 'alice' },
                      },
                    ],
                    meta: {
                      args: [{ name: 'message' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xrequest-missing-network', status: 'Done' }),
              eventRecord('assets', 'Issued', { assetId: XOR, owner: 'alice', amount: SCALE.toString() }),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000004300' }),
          },
        },
      },
    };

    await indexer.indexBlockByHash('0xinbound-missing-network-block');

    const synthetic = await repository.get('historyElements', '0xrequest-missing-network-mint');
    const snapshot = await repository.get('networkSnapshots', 'block-55');
    const accountMeta = await repository.get('accountMeta', 'alice');

    expect(synthetic).toBeNull();
    expect(snapshot?.data.bridgeIncomingTransactions).toBe(0);
    expect(accountMeta).toBeNull();
  });

  it('does not synthesize EVM incoming bridge history with a malformed network id', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 56 },
                hash: { toString: () => '0xinbound-malformed-network-block' },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'relayer' },
                  hash: { toString: () => '0xinbound-malformed-network' },
                  method: {
                    section: 'bridgeChannelInbound',
                    method: 'submit',
                    args: [
                      { EVM: '0xnot-hex' },
                      {
                        source: { EVM: '0xsender' },
                        dest: { Sora: 'alice' },
                      },
                    ],
                    meta: {
                      args: [{ name: 'networkId' }, { name: 'message' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xrequest-malformed-network', status: 'Done' }),
              eventRecord('assets', 'Issued', { assetId: XOR, owner: 'alice', amount: SCALE.toString() }),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000004400' }),
          },
        },
      },
    };

    await indexer.indexBlockByHash('0xinbound-malformed-network-block');

    const synthetic = await repository.get('historyElements', '0xrequest-malformed-network-mint');
    const snapshot = await repository.get('networkSnapshots', 'block-56');
    const accountMeta = await repository.get('accountMeta', 'alice');

    expect(synthetic).toBeNull();
    expect(snapshot?.data.bridgeIncomingTransactions).toBe(0);
    expect(accountMeta).toBeNull();
  });

  it('does not synthesize EVM incoming bridge history for non-completed request statuses', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 57 },
                hash: { toString: () => '0xinbound-pending-status-block' },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'relayer' },
                  hash: { toString: () => '0xinbound-pending-status' },
                  method: {
                    section: 'bridgeChannelInbound',
                    method: 'submit',
                    args: [
                      { EVM: '0x6f' },
                      {
                        source: { EVM: '0xsender' },
                        dest: { Sora: 'alice' },
                      },
                    ],
                    meta: {
                      args: [{ name: 'networkId' }, { name: 'message' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xrequest-pending-status', status: 'Pending' }),
              eventRecord('assets', 'Issued', { assetId: XOR, owner: 'alice', amount: SCALE.toString() }),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000004500' }),
          },
        },
      },
    };

    await indexer.indexBlockByHash('0xinbound-pending-status-block');

    const synthetic = await repository.get('historyElements', '0xrequest-pending-status-mint');
    const snapshot = await repository.get('networkSnapshots', 'block-57');
    const accountMeta = await repository.get('accountMeta', 'alice');

    expect(synthetic).toBeNull();
    expect(snapshot?.data.bridgeIncomingTransactions).toBe(0);
    expect(accountMeta).toBeNull();
  });

  it('ignores asset movement events for a different recipient when synthesizing incoming bridge history', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 50 },
                hash: { toString: () => '0xinbound-recipient-filter-block' },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'relayer' },
                  hash: { toString: () => '0xinbound-recipient-filter' },
                  method: {
                    section: 'bridgeChannelInbound',
                    method: 'submit',
                    args: [
                      { EVM: '0x6f' },
                      {
                        source: { EVM: '0xsender' },
                        dest: { Sora: 'alice' },
                      },
                    ],
                    meta: {
                      args: [{ name: 'networkId' }, { name: 'message' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xrequest-recipient-filter', status: 'Done' }),
              eventRecord('assets', 'Transfer', {
                assetId: XOR,
                from: 'bob',
                to: 'mallory',
                amount: (5n * SCALE).toString(),
              }),
              eventRecord('assets', 'Issued', { assetId: XOR, owner: 'alice', amount: (3n * SCALE).toString() }),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000003800' }),
          },
        },
      },
    };

    await indexer.indexBlockByHash('0xinbound-recipient-filter-block');

    const synthetic = await repository.get('historyElements', '0xrequest-recipient-filter-mint');
    const snapshot = await repository.get('networkSnapshots', 'block-50');
    const aliceMeta = await repository.get('accountMeta', 'alice');
    const malloryMeta = await repository.get('accountMeta', 'mallory');

    expect(synthetic?.data).toMatchObject({
      module: 'bridgeProxy',
      method: 'mint',
      dataFrom: 'alice',
      dataTo: '0xsender',
      data: {
        amount: '3',
        amountUSD: '6',
        recipient: 'alice',
      },
    });
    expect(snapshot?.data.bridgeIncomingTransactions).toBe(1);
    expect(aliceMeta?.data.deposit).toEqual({ incomingUSD: '6', outgoingUSD: '0' });
    expect(malloryMeta).toBeNull();
  });

  it('does not synthesize EVM incoming bridge history when message asset and movement asset differ', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([
      [XOR, 2n * SCALE],
      [PSWAP, SCALE],
    ]);
    indexer.assetInfos = new Map([
      [XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }],
      [PSWAP, { id: PSWAP, symbol: 'PSWAP', name: 'PSWAP', decimals: 18, supply: 0n }],
    ]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 58 },
                hash: { toString: () => '0xinbound-asset-mismatch-block' },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'relayer' },
                  hash: { toString: () => '0xinbound-asset-mismatch' },
                  method: {
                    section: 'bridgeChannelInbound',
                    method: 'submit',
                    args: [
                      { EVM: '0x6f' },
                      {
                        source: { EVM: '0xsender' },
                        dest: { Sora: 'alice' },
                        assetId: XOR,
                      },
                    ],
                    meta: {
                      args: [{ name: 'networkId' }, { name: 'message' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xrequest-asset-mismatch', status: 'Done' }),
              eventRecord('assets', 'Issued', { assetId: PSWAP, owner: 'alice', amount: (5n * SCALE).toString() }),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000004600' }),
          },
        },
      },
    };

    await indexer.indexBlockByHash('0xinbound-asset-mismatch-block');

    const synthetic = await repository.get('historyElements', '0xrequest-asset-mismatch-mint');
    const snapshot = await repository.get('networkSnapshots', 'block-58');
    const accountMeta = await repository.get('accountMeta', 'alice');

    expect(synthetic).toBeNull();
    expect(snapshot?.data.bridgeIncomingTransactions).toBe(0);
    expect(accountMeta).toBeNull();
  });

  it('ignores wrong asset movement and uses the later matching asset for incoming bridge history', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([
      [XOR, 2n * SCALE],
      [PSWAP, SCALE],
    ]);
    indexer.assetInfos = new Map([
      [XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }],
      [PSWAP, { id: PSWAP, symbol: 'PSWAP', name: 'PSWAP', decimals: 18, supply: 0n }],
    ]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 59 },
                hash: { toString: () => '0xinbound-asset-filter-block' },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'relayer' },
                  hash: { toString: () => '0xinbound-asset-filter' },
                  method: {
                    section: 'bridgeChannelInbound',
                    method: 'submit',
                    args: [
                      { EVM: '0x6f' },
                      {
                        source: { EVM: '0xsender' },
                        dest: { Sora: 'alice' },
                        assetId: XOR,
                      },
                    ],
                    meta: {
                      args: [{ name: 'networkId' }, { name: 'message' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xrequest-asset-filter', status: 'Done' }),
              eventRecord('assets', 'Issued', { assetId: PSWAP, owner: 'alice', amount: (5n * SCALE).toString() }),
              eventRecord('assets', 'Issued', { assetId: XOR, owner: 'alice', amount: (3n * SCALE).toString() }),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000004700' }),
          },
        },
      },
    };

    await indexer.indexBlockByHash('0xinbound-asset-filter-block');

    const synthetic = await repository.get('historyElements', '0xrequest-asset-filter-mint');
    const snapshot = await repository.get('networkSnapshots', 'block-59');
    const accountMeta = await repository.get('accountMeta', 'alice');

    expect(synthetic?.data).toMatchObject({
      module: 'bridgeProxy',
      method: 'mint',
      dataFrom: 'alice',
      dataTo: '0xsender',
      data: {
        assetId: XOR,
        amount: '3',
        amountUSD: '6',
        recipient: 'alice',
      },
    });
    expect(snapshot?.data.bridgeIncomingTransactions).toBe(1);
    expect(accountMeta?.data.deposit).toEqual({ incomingUSD: '6', outgoingUSD: '0' });
  });

  it('does not synthesize EVM incoming bridge history for failed bridge request statuses', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 51 },
                hash: { toString: () => '0xinbound-failed-status-block' },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'relayer' },
                  hash: { toString: () => '0xinbound-failed-status' },
                  method: {
                    section: 'bridgeChannelInbound',
                    method: 'submit',
                    args: [
                      { EVM: '0x6f' },
                      {
                        source: { EVM: '0xsender' },
                        dest: { Sora: 'alice' },
                      },
                    ],
                    meta: {
                      args: [{ name: 'networkId' }, { name: 'message' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xrequest-failed-status', status: 'Failed' }),
              eventRecord('assets', 'Issued', { assetId: XOR, owner: 'alice', amount: SCALE.toString() }),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000003900' }),
          },
        },
      },
    };

    await indexer.indexBlockByHash('0xinbound-failed-status-block');

    const synthetic = await repository.get('historyElements', '0xrequest-failed-status-mint');
    const snapshot = await repository.get('networkSnapshots', 'block-51');
    const accountMeta = await repository.get('accountMeta', 'alice');

    expect(synthetic).toBeNull();
    expect(snapshot?.data.bridgeIncomingTransactions).toBe(0);
    expect(accountMeta).toBeNull();
  });

  it('does not synthesize EVM incoming bridge history from events attached to another extrinsic', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 52 },
                hash: { toString: () => '0xinbound-wrong-phase-block' },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'relayer' },
                  hash: { toString: () => '0xinbound-wrong-phase' },
                  method: {
                    section: 'bridgeChannelInbound',
                    method: 'submit',
                    args: [
                      { EVM: '0x6f' },
                      {
                        source: { EVM: '0xsender' },
                        dest: { Sora: 'alice' },
                      },
                    ],
                    meta: {
                      args: [{ name: 'networkId' }, { name: 'message' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xrequest-wrong-phase', status: 'Done' }, 1),
              eventRecord('assets', 'Issued', { assetId: XOR, owner: 'alice', amount: SCALE.toString() }, 1),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000004000' }),
          },
        },
      },
    };

    await indexer.indexBlockByHash('0xinbound-wrong-phase-block');

    const original = await repository.get('historyElements', '0xinbound-wrong-phase');
    const synthetic = await repository.get('historyElements', '0xrequest-wrong-phase-mint');
    const snapshot = await repository.get('networkSnapshots', 'block-52');
    const accountMeta = await repository.get('accountMeta', 'alice');

    expect(original?.data).toMatchObject({
      module: 'bridgeChannelInbound',
      method: 'submit',
    });
    expect(synthetic).toBeNull();
    expect(snapshot?.data.bridgeIncomingTransactions).toBe(0);
    expect(accountMeta).toBeNull();
  });

  it('does not duplicate outgoing bridgeProxy burns as synthetic incoming history', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 49 },
                hash: { toString: () => '0xevmburn-no-duplicate-block' },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'alice' },
                  hash: { toString: () => '0xevmburn-no-duplicate' },
                  method: {
                    section: 'bridgeProxy',
                    method: 'burn',
                    args: [{ EVM: '0x6f' }, XOR, { EVM: '0xrecipient' }, (2n * SCALE).toString()],
                    meta: {
                      args: [{ name: 'networkId' }, { name: 'assetId' }, { name: 'recipient' }, { name: 'amount' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xburn-request', status: 'Done' }),
              eventRecord('assets', 'Transfer', {
                assetId: XOR,
                from: 'alice',
                to: 'bridge-account',
                amount: (2n * SCALE).toString(),
              }),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000004000' }),
          },
        },
      },
    };

    await indexer.indexBlockByHash('0xevmburn-no-duplicate-block');

    const outgoing = await repository.get('historyElements', '0xevmburn-no-duplicate');
    const synthetic = await repository.get('historyElements', '0xburn-request-mint');
    const snapshot = await repository.get('networkSnapshots', 'block-49');
    const accountMeta = await repository.get('accountMeta', 'alice');

    expect(outgoing?.data).toMatchObject({
      module: 'bridgeProxy',
      method: 'burn',
      data: {
        requestHash: '0xburn-request',
      },
    });
    expect(synthetic).toBeNull();
    expect(snapshot?.data.bridgeOutgoingTransactions).toBe(1);
    expect(snapshot?.data.bridgeIncomingTransactions).toBe(0);
    expect(accountMeta?.data.deposit).toEqual({ incomingUSD: '0', outgoingUSD: '4' });
  });

  it('backfills account transaction rows from legacy history without external hex addresses', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      backfillAccountTransactions: () => Promise<boolean>;
    };

    await repository.upsertMany([
      {
        collection: 'historyElements',
        id: 'legacy-a',
        blockHeight: 1,
        timestamp: 100,
        data: {
          id: 'legacy-a',
          blockHeight: 1,
          timestamp: 100,
          address: 'alice',
          dataFrom: 'alice',
          dataTo: '0xrecipient',
        },
      },
      {
        collection: 'historyElements',
        id: 'legacy-b',
        blockHeight: 2,
        timestamp: 200,
        data: {
          id: 'legacy-b',
          blockHeight: 2,
          timestamp: 200,
          address: '0xbridgepeer',
          dataFrom: '0xsender',
          dataTo: 'bob',
        },
      },
      {
        collection: 'historyElements',
        id: 'legacy-c',
        blockHeight: 'not-a-number' as never,
        timestamp: 'not-a-number' as never,
        data: {
          id: 'legacy-c',
          blockHeight: 'not-a-number',
          timestamp: 'not-a-number',
          address: ' alice ',
          dataFrom: 'not an account',
          dataTo: { toString: () => 'carol' },
        },
      },
    ]);

    await expect(indexer.backfillAccountTransactions()).resolves.toBe(true);

    const aliceActivity = await repository.get('accountTransactions', 'legacy-a-alice');
    const bobActivity = await repository.get('accountTransactions', 'legacy-b-bob');
    const duplicateAliceActivity = await repository.get('accountTransactions', 'legacy-c-alice');
    const externalRecipient = await repository.get('accountTransactions', 'legacy-a-0xrecipient');
    const externalSender = await repository.get('accountTransactions', 'legacy-b-0xsender');
    const malformedText = await repository.get('accountTransactions', 'legacy-c-not an account');
    const objectCoercion = await repository.get('accountTransactions', 'legacy-c-carol');
    const backfillState = await repository.get('updatesStreams', 'accountTransactionsBackfill-v1');

    expect(aliceActivity?.data).toMatchObject({ accountId: 'alice', historyElementId: 'legacy-a', timestamp: 100 });
    expect(bobActivity?.data).toMatchObject({ accountId: 'bob', historyElementId: 'legacy-b', timestamp: 200 });
    expect(duplicateAliceActivity?.data).toMatchObject({ accountId: 'alice', historyElementId: 'legacy-c', timestamp: 0 });
    expect(externalRecipient).toBeNull();
    expect(externalSender).toBeNull();
    expect(malformedText).toBeNull();
    expect(objectCoercion).toBeNull();
    expect(backfillState?.data).toMatchObject({
      id: 'accountTransactionsBackfill-v1',
      block: 2,
      data: JSON.stringify({ processedDocuments: 3, writtenDocuments: 3, lastIndexedBlock: 2, lastTimestamp: 200 }),
    });
    await expect(indexer.backfillAccountTransactions()).resolves.toBe(false);
    await expect(repository.list('accountTransactions')).resolves.toHaveLength(3);
  });

  it('does not trust a corrupt account transaction backfill marker', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      backfillAccountTransactions: () => Promise<boolean>;
    };

    await repository.upsertMany([
      {
        collection: 'updatesStreams',
        id: 'accountTransactionsBackfill-v1',
        data: { id: 'accountTransactionsBackfill-v1', data: 'not-json' },
      },
      {
        collection: 'historyElements',
        id: 'legacy-corrupt-state',
        blockHeight: 9,
        timestamp: 900,
        data: { id: 'legacy-corrupt-state', blockHeight: 9, timestamp: 900, address: 'bob' },
      },
    ]);

    await expect(indexer.backfillAccountTransactions()).resolves.toBe(true);

    expect(await repository.get('accountTransactions', 'legacy-corrupt-state-bob')).not.toBeNull();
    expect((await repository.get('updatesStreams', 'accountTransactionsBackfill-v1'))?.data.data).toBe(
      JSON.stringify({ processedDocuments: 1, writtenDocuments: 1, lastIndexedBlock: 9, lastTimestamp: 900 })
    );
  });

  it('does not trust structurally invalid account transaction backfill markers', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      backfillAccountTransactions: () => Promise<boolean>;
    };

    await repository.upsertMany([
      {
        collection: 'updatesStreams',
        id: 'accountTransactionsBackfill-v1',
        data: {
          id: 'accountTransactionsBackfill-v1',
          data: JSON.stringify({
            processedDocuments: '1',
            writtenDocuments: 1,
            lastIndexedBlock: -1,
            lastTimestamp: 900,
          }),
        },
      },
      {
        collection: 'historyElements',
        id: 'legacy-invalid-state-shape',
        blockHeight: 10,
        timestamp: 1_000,
        data: { id: 'legacy-invalid-state-shape', blockHeight: 10, timestamp: 1_000, address: 'carol' },
      },
    ]);

    await expect(indexer.backfillAccountTransactions()).resolves.toBe(true);

    expect(await repository.get('accountTransactions', 'legacy-invalid-state-shape-carol')).not.toBeNull();
    expect((await repository.get('updatesStreams', 'accountTransactionsBackfill-v1'))?.data.data).toBe(
      JSON.stringify({ processedDocuments: 1, writtenDocuments: 1, lastIndexedBlock: 10, lastTimestamp: 1_000 })
    );
  });

  it('backfills compact XOR burn documents without rewinding chain state', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      backfillXorBurns: (finalizedBlock: number) => Promise<void>;
      drainFinalizedHeads: () => Promise<void>;
    };
    const burnBlock = 25_043_003;
    const chainStateBlock = 26_000_000;
    const nexusRecipient = 'sora-nexus-account';
    const burnCall = {
      section: 'assets',
      method: 'burn',
      args: [XOR, '10000000000000000000'],
      meta: { args: [{ name: 'assetId' }, { name: 'amount' }] },
    };
    const remarkCall = {
      section: 'system',
      method: 'remark',
      args: [
        `0x${Buffer.from(
          JSON.stringify({ type: 'soraNexusXorClaim', version: 1, recipient: nexusRecipient }),
          'utf8'
        ).toString('hex')}`,
      ],
      meta: { args: [{ name: 'remark' }] },
    };

    await repository.upsert({
      collection: 'updatesStreams',
      id: 'chainState',
      blockHeight: chainStateBlock,
      timestamp: 1,
      data: {
        id: 'chainState',
        block: chainStateBlock,
        data: JSON.stringify({ lastIndexedBlock: chainStateBlock }),
      },
    });

    indexer.api = {
      rpc: {
        chain: {
          getBlockHash: async (block: number) => `hash-${block}`,
          getBlock: async () => ({
            block: {
              extrinsics: [
                {
                  hash: { toString: () => '0xbackfilledburn' },
                  method: {
                    section: 'utility',
                    method: 'batchAll',
                    args: [[burnCall, remarkCall]],
                    meta: { args: [{ name: 'calls' }] },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async (hash: string) =>
              hash === `hash-${burnBlock}`
                ? [eventRecord('assets', 'Burn', { address: 'alice', assetId: XOR, amount: '10000000000000000000' })]
                : [],
          },
        },
      },
    };
    indexer.drainFinalizedHeads = vi.fn(async () => undefined);

    await indexer.backfillXorBurns(burnBlock + 1);

    const xorBurn = await repository.get('xorBurns', '0xbackfilledburn');
    const chainState = await repository.get('updatesStreams', 'chainState');
    const backfillState = await repository.get('updatesStreams', 'xorBurnsBackfill');

    expect(xorBurn?.data).toMatchObject({
      id: '0xbackfilledburn',
      address: 'alice',
      amount: '10',
      assetId: XOR,
      blockHeight: burnBlock,
      txHash: '0xbackfilledburn',
      nexusRecipient,
    });
    expect(chainState?.data).toMatchObject({
      id: 'chainState',
      block: chainStateBlock,
      data: JSON.stringify({ lastIndexedBlock: chainStateBlock }),
    });
    expect(backfillState?.data).toMatchObject({
      id: 'xorBurnsBackfill',
      block: burnBlock + 1,
      data: JSON.stringify({ lastIndexedBlock: burnBlock + 1 }),
    });
    expect(indexer.drainFinalizedHeads).toHaveBeenCalled();
  });

  it('backfills bridgeProxy burn history from the first block without rewinding live chain state', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer({ ...config, chainStartBlock: 123 }, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      backfillBridgeProxyHistory: (finalizedBlock: number) => Promise<void>;
      drainFinalizedHeads: () => Promise<void>;
    };
    const chainStateBlock = 26_000_000;
    const bridgeBlock = 5;
    const blockHashCalls: number[] = [];

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    await repository.upsert({
      collection: 'updatesStreams',
      id: 'chainState',
      blockHeight: chainStateBlock,
      timestamp: 1,
      data: {
        id: 'chainState',
        block: chainStateBlock,
        data: JSON.stringify({ lastIndexedBlock: chainStateBlock }),
      },
    });
    await repository.upsert({
      collection: 'accountTransactions',
      id: `0xbridgebackfill-${LIBERLAND_ACCOUNT}`,
      blockHeight: bridgeBlock,
      timestamp: 1,
      data: {
        id: `0xbridgebackfill-${LIBERLAND_ACCOUNT}`,
        accountId: LIBERLAND_ACCOUNT,
        historyElementId: '0xbridgebackfill',
        blockHeight: bridgeBlock,
        timestamp: 1,
      },
    });

    indexer.api = {
      rpc: {
        chain: {
          getBlockHash: async (block: number) => {
            blockHashCalls.push(block);
            return `hash-${block}`;
          },
          getBlock: async (hash: string) => {
            const block = Number(hash.replace('hash-', ''));
            return {
              block: {
                header: {
                  number: { toNumber: () => block },
                  hash: { toString: () => `0xblock-${block}` },
                },
                extrinsics:
                  block === bridgeBlock
                    ? [
                        {
                          isSigned: true,
                          signer: { toString: () => 'alice' },
                          hash: { toString: () => '0xbridgebackfill' },
                          method: {
                            section: 'bridgeProxy',
                            method: 'burn',
                            args: [{ Sub: 'Liberland' }, XOR, { Liberland: LIBERLAND_ACCOUNT }, (7n * SCALE).toString()],
                            meta: {
                              args: [{ name: 'networkId' }, { name: 'assetId' }, { name: 'recipient' }, { name: 'amount' }],
                            },
                          },
                        },
                      ]
                    : [],
              },
            };
          },
        },
        state: {
          getMetadata: async () => ({
            asLatest: {
              pallets: [{ name: { toString: () => 'bridgeProxy' } }],
            },
          }),
        },
      },
      at: async (hash: string) => ({
        query: {
          system: {
            events: async () =>
              hash === `hash-${bridgeBlock}`
                ? [eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xbridgebackfillrequest', status: 'Done' })]
                : [],
          },
          timestamp: {
            now: async () => ({ toString: () => '1700000002000' }),
          },
        },
      }),
      query: {
        system: {
          events: {
            at: async (hash: string) =>
              hash === `hash-${bridgeBlock}`
                ? [eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xbridgebackfillrequest', status: 'Done' })]
                : [],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000002000' }),
          },
        },
      },
    };
    indexer.drainFinalizedHeads = vi.fn(async () => undefined);

    await indexer.backfillBridgeProxyHistory(bridgeBlock + 1);

    const history = await repository.get('historyElements', '0xbridgebackfill');
    const aliceActivity = await repository.get('accountTransactions', '0xbridgebackfill-alice');
    const externalActivity = await repository.get('accountTransactions', `0xbridgebackfill-${LIBERLAND_ACCOUNT}`);
    const chainState = await repository.get('updatesStreams', 'chainState');
    const backfillState = await repository.get('updatesStreams', 'bridgeProxyHistoryBackfill-v1');

    expect(blockHashCalls).toContain(0);
    expect(history?.data).toMatchObject({
      module: 'bridgeProxy',
      method: 'burn',
      address: 'alice',
      dataFrom: 'alice',
      dataTo: LIBERLAND_ACCOUNT,
      data: {
        assetId: XOR,
        amount: '7',
        amountUSD: '14',
        networkId: 'Liberland',
        externalNetwork: 'Liberland',
        externalNetworkType: 'Sub',
        recipient: LIBERLAND_ACCOUNT,
        requestHash: '0xbridgebackfillrequest',
        status: 'Done',
      },
    });
    expect(aliceActivity?.data).toMatchObject({ accountId: 'alice', historyElementId: '0xbridgebackfill' });
    expect(externalActivity).toBeNull();
    await expect(repository.list('accounts')).resolves.toHaveLength(0);
    await expect(repository.list('accountMeta')).resolves.toHaveLength(0);
    await expect(repository.list('networkSnapshots')).resolves.toHaveLength(0);
    expect(chainState?.data).toMatchObject({
      id: 'chainState',
      block: chainStateBlock,
      data: JSON.stringify({ lastIndexedBlock: chainStateBlock }),
    });
    expect(backfillState?.data).toMatchObject({
      id: 'bridgeProxyHistoryBackfill-v1',
      block: bridgeBlock + 1,
      data: JSON.stringify({ lastIndexedBlock: bridgeBlock + 1 }),
    });
    expect(indexer.drainFinalizedHeads).toHaveBeenCalled();
  });

  it('backfills completed incoming bridgeProxy mint history without indexing the external Liberland account', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      backfillBridgeProxyHistory: (finalizedBlock: number) => Promise<void>;
      drainFinalizedHeads: () => Promise<void>;
    };
    const bridgeBlock = 7;

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    await repository.upsert({
      collection: 'accountTransactions',
      id: `0xincomingbackfillrequest-mint-${LIBERLAND_ACCOUNT}`,
      blockHeight: bridgeBlock,
      timestamp: 1,
      data: {
        id: `0xincomingbackfillrequest-mint-${LIBERLAND_ACCOUNT}`,
        accountId: LIBERLAND_ACCOUNT,
        historyElementId: '0xincomingbackfillrequest-mint',
        blockHeight: bridgeBlock,
        timestamp: 1,
      },
    });

    indexer.api = {
      rpc: {
        chain: {
          getBlockHash: async (block: number) => `hash-${block}`,
          getBlock: async (hash: string) => {
            const block = Number(hash.replace('hash-', ''));
            return {
              block: {
                header: {
                  number: { toNumber: () => block },
                  hash: { toString: () => `0xblock-${block}` },
                },
                extrinsics:
                  block === bridgeBlock
                    ? [
                        {
                          isSigned: true,
                          signer: { toString: () => 'relayer' },
                          hash: { toString: () => '0xincomingbackfillsubmit' },
                          method: {
                            section: 'bridgeChannelInbound',
                            method: 'submit',
                            args: [
                              { Sub: 'Liberland' },
                              {
                                source: { Liberland: LIBERLAND_ACCOUNT },
                                dest: { Sora: 'alice' },
                                assetId: XOR,
                              },
                            ],
                            meta: {
                              args: [{ name: 'networkId' }, { name: 'message' }],
                            },
                          },
                        },
                      ]
                    : [],
              },
            };
          },
        },
        state: {
          getMetadata: async () => ({
            asLatest: {
              pallets: [{ name: { toString: () => 'bridgeChannelInbound' } }],
            },
          }),
        },
      },
      at: async (hash: string) => ({
        query: {
          system: {
            events: async () =>
              hash === `hash-${bridgeBlock}`
                ? [
                    eventRecord('bridgeProxy', 'RequestStatusUpdate', {
                      requestHash: '0xincomingbackfillrequest',
                      status: 'Done',
                    }),
                    eventRecord('assets', 'Issued', { assetId: XOR, owner: 'alice', amount: (4n * SCALE).toString() }),
                  ]
                : [],
          },
          timestamp: {
            now: async () => ({ toString: () => '1700000003000' }),
          },
        },
      }),
      query: {
        system: {
          events: {
            at: async (hash: string) =>
              hash === `hash-${bridgeBlock}`
                ? [
                    eventRecord('bridgeProxy', 'RequestStatusUpdate', {
                      requestHash: '0xincomingbackfillrequest',
                      status: 'Done',
                    }),
                    eventRecord('assets', 'Issued', { assetId: XOR, owner: 'alice', amount: (4n * SCALE).toString() }),
                  ]
                : [],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000003000' }),
          },
        },
      },
    };
    indexer.drainFinalizedHeads = vi.fn(async () => undefined);

    await indexer.backfillBridgeProxyHistory(bridgeBlock);

    const original = await repository.get('historyElements', '0xincomingbackfillsubmit');
    const history = await repository.get('historyElements', '0xincomingbackfillrequest-mint');
    const aliceActivity = await repository.get('accountTransactions', '0xincomingbackfillrequest-mint-alice');
    const externalActivity = await repository.get('accountTransactions', `0xincomingbackfillrequest-mint-${LIBERLAND_ACCOUNT}`);

    expect(original).toBeNull();
    expect(history?.data).toMatchObject({
      module: 'bridgeProxy',
      method: 'mint',
      address: 'relayer',
      dataFrom: 'alice',
      dataTo: LIBERLAND_ACCOUNT,
      data: {
        assetId: XOR,
        amount: '4',
        amountUSD: '8',
        networkId: 'Liberland',
        externalNetwork: 'Liberland',
        externalNetworkType: 'Sub',
        recipient: 'alice',
        sender: LIBERLAND_ACCOUNT,
        requestHash: '0xincomingbackfillrequest',
        status: 'Done',
      },
    });
    expect(aliceActivity?.data).toMatchObject({ accountId: 'alice', historyElementId: '0xincomingbackfillrequest-mint' });
    expect(externalActivity).toBeNull();
  });

  it('subscribes to finalized heads before running startup maintenance backfills', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      start: () => Promise<void>;
      refreshIndexingState: () => Promise<void>;
      refreshDerivedState: (blockHeight: number, timestamp: number, includeSnapshots: boolean) => Promise<void>;
      backfillXorBurns: (finalizedBlock: number) => Promise<void>;
      backfillBridgeProxyHistory: (finalizedBlock: number) => Promise<void>;
      backfill: () => Promise<boolean>;
      backfillAccountTransactions: () => Promise<boolean>;
      backfillNetworkAggregateSnapshots: () => Promise<boolean>;
      cleanupAssetSnapshotPriceOutliers: () => Promise<boolean>;
      repairNetworkTransactionCounters: () => Promise<boolean>;
      subscribeFinalizedHeads: () => Promise<void>;
    };
    const order: string[] = [];
    let finishBackfill: (() => void) | undefined;
    const apiCreate = vi.spyOn(ApiPromise, 'create').mockResolvedValue({
      rpc: {
        chain: {
          getFinalizedHead: async () => '0xfinal',
          getHeader: async () => ({ number: { toNumber: () => 25_900_000 } }),
        },
      },
    } as never);

    indexer.refreshIndexingState = async () => {
      order.push('indexing-state-refresh');
    };
    indexer.cleanupAssetSnapshotPriceOutliers = async () => {
      order.push('cleanup');
      return false;
    };
    indexer.backfillXorBurns = async () => {
      order.push('xor-burn-backfill');
    };
    indexer.backfillBridgeProxyHistory = async () => {
      order.push('bridge-history-backfill');
    };
    indexer.backfill = async () => {
      order.push('normal-backfill-start');
      await new Promise<void>((resolve) => {
        finishBackfill = resolve;
      });
      order.push('normal-backfill-end');
      return false;
    };
    indexer.backfillAccountTransactions = async () => {
      order.push('account-backfill');
      return false;
    };
    indexer.repairNetworkTransactionCounters = async () => {
      order.push('repair-network-counters');
      return false;
    };
    indexer.backfillNetworkAggregateSnapshots = async () => {
      order.push('network-aggregate-backfill');
      return false;
    };
    indexer.subscribeFinalizedHeads = async () => {
      order.push('subscribe');
    };

    const startPromise = indexer.start();

    await vi.waitFor(() => {
      expect(order).toEqual(['indexing-state-refresh', 'normal-backfill-start']);
    });

    finishBackfill?.();
    await startPromise;

    await vi.waitFor(() => {
      expect(order).toEqual([
        'indexing-state-refresh',
        'normal-backfill-start',
        'normal-backfill-end',
        'subscribe',
        'cleanup',
        'account-backfill',
        'repair-network-counters',
        'network-aggregate-backfill',
        'xor-burn-backfill',
        'bridge-history-backfill',
      ]);
    });
    apiCreate.mockRestore();
  });

  it('logs compact XOR burn backfill failures after finalized-head subscription is established', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      start: () => Promise<void>;
      refreshIndexingState: () => Promise<void>;
      refreshDerivedState: (blockHeight: number, timestamp: number, includeSnapshots: boolean) => Promise<void>;
      backfillXorBurns: (finalizedBlock: number) => Promise<void>;
      backfill: () => Promise<boolean>;
      backfillAccountTransactions: () => Promise<boolean>;
      backfillNetworkAggregateSnapshots: () => Promise<boolean>;
      cleanupAssetSnapshotPriceOutliers: () => Promise<boolean>;
      repairNetworkTransactionCounters: () => Promise<boolean>;
      subscribeFinalizedHeads: () => Promise<void>;
    };
    const failure = new Error('xor burn backfill failed');
    const subscribeFinalizedHeads = vi.fn();
    const apiCreate = vi.spyOn(ApiPromise, 'create').mockResolvedValue({
      rpc: {
        chain: {
          getFinalizedHead: async () => '0xfinal',
          getHeader: async () => ({ number: { toNumber: () => 25_900_000 } }),
        },
      },
    } as never);

    indexer.refreshIndexingState = async () => undefined;
    indexer.cleanupAssetSnapshotPriceOutliers = async () => false;
    indexer.backfillXorBurns = async () => {
      throw failure;
    };
    indexer.backfill = async () => false;
    indexer.backfillAccountTransactions = async () => false;
    indexer.repairNetworkTransactionCounters = async () => false;
    indexer.backfillNetworkAggregateSnapshots = async () => false;
    indexer.subscribeFinalizedHeads = subscribeFinalizedHeads;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await expect(indexer.start()).resolves.toBeUndefined();
      expect(subscribeFinalizedHeads).toHaveBeenCalledOnce();
      await vi.waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith('Startup maintenance failed', failure);
      });
    } finally {
      consoleError.mockRestore();
      apiCreate.mockRestore();
    }
  });

  it('skips expensive derived-state refreshes while backfilling historical blocks', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(
      { ...config, stateRefreshIntervalBlocks: 1, snapshotIntervalBlocks: 1 },
      repository
    ) as unknown as {
      api: unknown;
      backfill: () => Promise<boolean>;
      indexBlockByNumber: (block: number, options?: { refreshDerivedState?: boolean }) => Promise<void>;
      refreshDerivedState: (blockHeight: number, timestamp: number, includeSnapshots: boolean) => Promise<void>;
    };
    const indexedBlocks: Array<{ block: number; refreshDerivedState?: boolean }> = [];
    const refreshes: Array<{ blockHeight: number; includeSnapshots: boolean }> = [];

    indexer.api = {
      rpc: {
        chain: {
          getFinalizedHead: async () => '0xfinal',
          getHeader: async () => ({ number: { toNumber: () => 3 } }),
        },
      },
    };
    indexer.indexBlockByNumber = async (block, options) => {
      indexedBlocks.push({ block, refreshDerivedState: options?.refreshDerivedState });
    };
    indexer.refreshDerivedState = async (blockHeight, _timestamp, includeSnapshots) => {
      refreshes.push({ blockHeight, includeSnapshots });
    };

    await indexer.backfill();

    expect(indexedBlocks).toEqual([
      { block: 1, refreshDerivedState: false },
      { block: 2, refreshDerivedState: false },
      { block: 3, refreshDerivedState: false },
    ]);
    expect(refreshes).toEqual([]);
  });

  it('keeps finalized block indexing committed when a scheduled derived-state refresh fails', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(
      { ...config, stateRefreshIntervalBlocks: 1, snapshotIntervalBlocks: 1 },
      repository
    ) as unknown as {
      api: unknown;
      indexBlockByNumber: (block: number) => Promise<void>;
      refreshDerivedState: (blockHeight: number, timestamp: number, includeSnapshots: boolean) => Promise<void>;
    };
    const failure = new Error('refresh query timeout');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    indexer.api = {
      rpc: {
        chain: {
          getBlockHash: async () => ({ toString: () => '0xblock' }),
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 10 },
                hash: { toString: () => '0xblock' },
              },
              extrinsics: [],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1000000' }),
          },
        },
      },
    };
    indexer.refreshDerivedState = async () => {
      throw failure;
    };

    try {
      await indexer.indexBlockByNumber(10);

      expect((await repository.get('updatesStreams', 'chainState'))?.data.block).toBe(10);
      await vi.waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith('Failed to refresh derived state at SORA block 10', failure);
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  it('retries missed finalized blocks before indexing later heads', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      subscribeFinalizedHeads: () => Promise<void>;
      indexBlockByNumber: (block: number) => Promise<void>;
    };
    const indexedBlocks: number[] = [];
    let finalizedHeadCallback: ((header: { number: { toNumber: () => number } }) => Promise<void>) | undefined;

    await repository.upsert({
      collection: 'updatesStreams',
      id: 'chainState',
      blockHeight: 9,
      timestamp: 1,
      data: {
        id: 'chainState',
        block: 9,
        data: JSON.stringify({ lastIndexedBlock: 9 }),
      },
    });

    indexer.api = {
      rpc: {
        chain: {
          subscribeFinalizedHeads: async (callback: typeof finalizedHeadCallback) => {
            finalizedHeadCallback = callback;
          },
          getFinalizedHead: async () => '0xfinal',
          getHeader: async () => ({ number: { toNumber: () => 9 } }),
        },
      },
    };
    indexer.indexBlockByNumber = async (block) => {
      indexedBlocks.push(block);
      if (block === 10 && indexedBlocks.length === 1) {
        throw new Error('transient database failure');
      }

      await repository.upsert({
        collection: 'updatesStreams',
        id: 'chainState',
        blockHeight: block,
        timestamp: 1,
        data: {
          id: 'chainState',
          block,
          data: JSON.stringify({ lastIndexedBlock: block }),
        },
      });
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await indexer.subscribeFinalizedHeads();
      await finalizedHeadCallback?.({ number: { toNumber: () => 10 } });
      await vi.waitFor(() => {
        expect(indexedBlocks).toEqual([10]);
      });
      expect((await repository.get('updatesStreams', 'chainState'))?.data.block).toBe(9);
      expect(consoleError).toHaveBeenCalledWith('Failed to index finalized block 10', expect.any(Error));

      await finalizedHeadCallback?.({ number: { toNumber: () => 12 } });
      await vi.waitFor(() => {
        expect(indexedBlocks).toEqual([10, 10, 11, 12]);
      });
      expect((await repository.get('updatesStreams', 'chainState'))?.data.block).toBe(12);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('drains to the latest finalized block immediately after subscribing', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      subscribeFinalizedHeads: () => Promise<void>;
      indexBlockByNumber: (block: number) => Promise<void>;
    };
    const indexedBlocks: number[] = [];

    await repository.upsert({
      collection: 'updatesStreams',
      id: 'chainState',
      blockHeight: 9,
      timestamp: 1,
      data: {
        id: 'chainState',
        block: 9,
        data: JSON.stringify({ lastIndexedBlock: 9 }),
      },
    });

    indexer.api = {
      rpc: {
        chain: {
          subscribeFinalizedHeads: async () => undefined,
          getFinalizedHead: async () => '0xfinal',
          getHeader: async () => ({ number: { toNumber: () => 12 } }),
        },
      },
    };
    indexer.indexBlockByNumber = async (block) => {
      indexedBlocks.push(block);
      await repository.upsert({
        collection: 'updatesStreams',
        id: 'chainState',
        blockHeight: block,
        timestamp: 1,
        data: {
          id: 'chainState',
          block,
          data: JSON.stringify({ lastIndexedBlock: block }),
        },
      });
    };

    await indexer.subscribeFinalizedHeads();

    expect(indexedBlocks).toEqual([10, 11, 12]);
    expect((await repository.get('updatesStreams', 'chainState'))?.data.block).toBe(12);
  });

  it('continues existing account point metadata from the repository', async () => {
    const repository = new MemoryRepository();
    await repository.upsert({
      collection: 'accountMeta',
      id: 'alice',
      blockHeight: 1,
      timestamp: 100,
      data: {
        id: 'alice',
        accountId: 'alice',
        createdAtTimestamp: 100,
        createdAtBlock: 1,
        orderBook: { created: 1, closed: 0, amountUSD: '10' },
      },
    });
    const indexer = new ChainIndexer(config, repository) as unknown as {
      createAccountDocuments: (
        accounts: string[],
        latestHistoryElementId: string,
        blockHeight: number,
        timestamp: number,
        pendingPointData: Map<string, Record<string, unknown>>,
        update: { module: string; method: string; data: unknown; fee: bigint }
      ) => Promise<Array<{ collection: string; id: string; data: Record<string, unknown> }>>;
    };

    const documents = await indexer.createAccountDocuments(['alice'], 'history-2', 20, 2000, new Map(), {
      module: 'orderBook',
      method: 'placeLimitOrder',
      data: { amountUSD: '12.5' },
      fee: 0n,
    });
    const meta = documents.find((document) => document.collection === 'accountMeta')?.data;
    const pointSystem = documents.find((document) => document.collection === 'accountPointSystems')?.data;

    expect(meta).toMatchObject({
      createdAtBlock: 1,
      createdAtTimestamp: 100,
      orderBook: { created: 2, closed: 0, amountUSD: '22.5' },
      xorFees: { amount: '0', amountUSD: '0' },
    });
    expect(pointSystem).toMatchObject({
      accountId: 'alice',
      startedAtBlock: 1,
      orderBook: { created: 2, closed: 0, amountUSD: '22.5' },
    });
  });

  it('keeps pending account point updates across multiple same-block activities', async () => {
    const repository = new MemoryRepository();
    const pendingPointData = new Map<string, Record<string, unknown>>();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      createAccountDocuments: (
        accounts: string[],
        latestHistoryElementId: string,
        blockHeight: number,
        timestamp: number,
        pendingPointData: Map<string, Record<string, unknown>>,
        update: { module: string; method: string; data: unknown; fee: bigint }
      ) => Promise<Array<{ collection: string; id: string; data: Record<string, unknown> }>>;
    };

    await indexer.createAccountDocuments(['alice'], 'history-1', 10, 1000, pendingPointData, {
      module: 'ethBridge',
      method: 'transferToSidechain',
      data: { amountUSD: '3.25' },
      fee: 0n,
    });
    const documents = await indexer.createAccountDocuments(['alice'], 'history-2', 10, 1000, pendingPointData, {
      module: 'bridgeMultisig',
      method: 'approveRequest',
      data: { amountUSD: '4.75' },
      fee: 0n,
    });
    const meta = documents.find((document) => document.collection === 'accountMeta')?.data;

    expect(meta?.deposit).toEqual({ incomingUSD: '4.75', outgoingUSD: '3.25' });
  });

  it('tracks order book cancels, vault closes, and governance votes in account points', async () => {
    const repository = new MemoryRepository();
    const pendingPointData = new Map<string, Record<string, unknown>>();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      createAccountDocuments: (
        accounts: string[],
        latestHistoryElementId: string,
        blockHeight: number,
        timestamp: number,
        pendingPointData: Map<string, Record<string, unknown>>,
        update: { module: string; method: string; data: unknown; fee: bigint }
      ) => Promise<Array<{ collection: string; id: string; data: Record<string, unknown> }>>;
    };

    await indexer.createAccountDocuments(['alice'], 'history-1', 10, 1000, pendingPointData, {
      module: 'orderBook',
      method: 'cancelLimitOrdersBatch',
      data: [{ orderId: 1 }, { orderId: 2 }, { orderId: 3 }],
      fee: 0n,
    });
    await indexer.createAccountDocuments(['alice'], 'history-2', 10, 1000, pendingPointData, {
      module: 'kensetsu',
      method: 'closeCdp',
      data: { debtAmountUSD: '8.5' },
      fee: 0n,
    });
    const documents = await indexer.createAccountDocuments(['alice'], 'history-3', 10, 1000, pendingPointData, {
      module: 'democracy',
      method: 'vote',
      data: { amount: '7', amountUSD: '14' },
      fee: 0n,
    });
    const meta = documents.find((document) => document.collection === 'accountMeta')?.data;

    expect(meta).toMatchObject({
      orderBook: { created: 0, closed: 3, amountUSD: '0' },
      vault: { created: 0, closed: 1, amountUSD: '8.5' },
      governance: { votes: 1, amount: '7', amountUSD: '14' },
    });
  });

  it('creates indexed documents from order book, vault, and referrer events', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      createEventDocuments: (
        events: unknown[],
        blockHeight: number,
        timestamp: number,
        signer: string
      ) => Array<{ collection: string; id: string; data: Record<string, unknown> }>;
    };

    const documents = indexer.createEventDocuments(
      [
        eventRecord('orderBook', 'LimitOrderPlaced', {
          orderBookId: `0-${XOR}-${KUSD}`,
          orderId: 42,
          side: 'Sell',
          amount: (3n * SCALE).toString(),
          price: (2n * SCALE).toString(),
          owner: 'alice',
        }),
        eventRecord('kensetsu', 'CDPClosed', {
          cdpId: 'vault-1',
          collateralAssetId: XOR,
          stablecoinAssetId: KUSD,
          amount: (5n * SCALE).toString(),
          owner: 'bob',
        }),
        eventRecord('xorFee', 'ReferrerRewarded', {
          referral: 'charlie',
          referrer: 'dave',
          amount: '123',
        }),
      ],
      99,
      1_700_000_000,
      'fallback-signer'
    );

    expect(documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          collection: 'orderBookOrders',
          id: `0-${XOR}-${KUSD}-42`,
          data: expect.objectContaining({
            accountId: 'alice',
            amount: '3',
            isBuy: false,
            orderBookId: `0-${XOR}-${KUSD}`,
            price: '2',
            status: 'Active',
          }),
        }),
        expect.objectContaining({
          collection: 'vaultEvents',
          id: 'vault-1-99-CDPClosed',
          data: expect.objectContaining({
            amount: '5',
            type: 'Closed',
            vaultId: 'vault-1',
          }),
        }),
        expect.objectContaining({
          collection: 'vaults',
          id: 'vault-1',
          data: expect.objectContaining({
            collateralAmountReturned: '5',
            ownerId: 'bob',
            status: 'Closed',
          }),
        }),
        expect.objectContaining({
          collection: 'referrerRewards',
          id: 'dave-charlie',
          data: expect.objectContaining({
            amount: '123',
            referral: 'charlie',
            referrer: 'dave',
          }),
        }),
      ])
    );
  });

  it('creates storage-derived staking and referral documents', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      createStakingDocuments: (nominators: unknown[], blockHeight: number, timestamp: number) => unknown[];
      createReferralDocuments: (referrers: unknown[], blockHeight: number, timestamp: number) => unknown[];
    };

    const staking = indexer.createStakingDocuments([[{ args: ['alice'] }]], 12, 1_700_000_000);
    const referrals = indexer.createReferralDocuments(
      [[{ args: ['charlie'] }, { toJSON: () => 'dave' }]],
      12,
      1_700_000_000
    );

    expect(staking).toEqual([
      {
        collection: 'stakingStakers',
        id: 'alice',
        blockHeight: 12,
        timestamp: 1_700_000_000,
        data: { id: 'alice' },
      },
    ]);
    expect(referrals).toEqual([
      {
        collection: 'referrerRewards',
        id: 'dave-charlie',
        blockHeight: 12,
        timestamp: 1_700_000_000,
        data: {
          id: 'dave-charlie',
          referral: 'charlie',
          referrer: 'dave',
          blockHeight: '12',
          timestamp: 1_700_000_000,
          updated: 1_700_000_000,
          amount: '0',
        },
      },
    ]);
  });

  it('preserves accumulated referral rewards when storage refreshes referral relationships', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      createEventDocuments: (
        events: unknown[],
        blockHeight: number,
        timestamp: number,
        signer: string
      ) => Array<{ collection: string; id: string; data: Record<string, unknown> }>;
      createReferralDocuments: (referrers: unknown[], blockHeight: number, timestamp: number) => unknown[];
      prepareReferrerRewardDocuments: (documents: unknown[]) => Promise<any[]>;
    };

    await repository.upsert({
      collection: 'referrerRewards',
      id: 'dave-charlie',
      blockHeight: 11,
      timestamp: 1_700_000_000,
      data: {
        id: 'dave-charlie',
        referral: 'charlie',
        referrer: 'dave',
        updated: 1_700_000_000,
        amount: '100',
      },
    });

    const rewardDocuments = indexer.createEventDocuments(
      [eventRecord('xorFee', 'ReferrerRewarded', { referral: 'charlie', referrer: 'dave', amount: '23' })],
      12,
      1_700_000_010,
      'fallback-signer'
    );
    const storageDocuments = indexer.createReferralDocuments(
      [[{ args: ['charlie'] }, { toJSON: () => 'dave' }]],
      12,
      1_700_000_010
    );

    await repository.upsertMany(await indexer.prepareReferrerRewardDocuments([...rewardDocuments, ...storageDocuments]));

    await expect(repository.get('referrerRewards', 'dave-charlie')).resolves.toMatchObject({
      data: {
        amount: '123',
        referral: 'charlie',
        referrer: 'dave',
      },
    });
  });

  it('preserves vault creation blocks while refreshing storage-derived vaults', async () => {
    const repository = new MemoryRepository();
    await repository.upsert({
      collection: 'vaults',
      id: 'vault-1',
      blockHeight: 50,
      timestamp: 1_600_000_000,
      data: {
        id: 'vault-1',
        createdAtBlock: 50,
      },
    });
    const indexer = new ChainIndexer(config, repository) as unknown as {
      createVaultDocuments: (cdpEntries: unknown[], blockHeight: number, timestamp: number) => Promise<unknown[]>;
    };

    const documents = await indexer.createVaultDocuments(
      [
        [
          { args: ['vault-1'] },
          {
            toJSON: () => ({
              owner: 'alice',
              collateral_asset_id: XOR,
              stablecoin_asset_id: KUSD,
            }),
          },
        ],
      ],
      99,
      1_700_000_000
    );

    expect(documents).toEqual([
      {
        collection: 'vaults',
        id: 'vault-1',
        blockHeight: 99,
        timestamp: 1_700_000_000,
        data: {
          id: 'vault-1',
          type: 'Type2',
          status: 'Opened',
          ownerId: 'alice',
          collateralAssetId: XOR,
          debtAssetId: KUSD,
          collateralAmountReturned: '0',
          createdAtBlock: 50,
          updatedAtBlock: 99,
        },
      },
    ]);
  });

  it('creates account liquidity snapshots from pool provider shares', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      createAccountLiquidityDocuments: (
        poolProviders: unknown[],
        pools: unknown[],
        assets: Map<string, unknown>,
        prices: Map<string, bigint>,
        blockHeight: number,
        timestamp: number
      ) => unknown[];
    };

    const documents = indexer.createAccountLiquidityDocuments(
      [[{ args: ['pool-account', 'alice'] }, (250n * SCALE).toString()]],
      [
        {
          id: `${XOR}-${KUSD}`,
          poolAccount: 'pool-account',
          poolTokenSupply: 1_000n * SCALE,
          liquidityUSD: '1000',
        },
      ],
      new Map(),
      new Map(),
      77,
      1_700_000_000
    );

    expect(documents).toEqual([
      expect.objectContaining({
        collection: 'accountLiquiditySnapshots',
        blockHeight: 77,
        timestamp: 1_700_000_000,
        data: expect.objectContaining({
          accountLiquidityId: `alice-${XOR}-${KUSD}`,
          poolTokens: (250n * SCALE).toString(),
          liquidityUSD: '250',
          type: 'DEFAULT',
        }),
      }),
    ]);
  });

  it('buckets default asset snapshots into five-minute chart windows', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      createAssetDocuments: (
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>,
        prices: Map<string, bigint>,
        liquidity: Map<string, bigint>,
        analytics: {
          assets: Map<string, Map<string, unknown>>;
          assetDayVolumeUSD: Map<string, bigint>;
          assetWeekVolumeUSD: Map<string, bigint>;
          assetDayOpenPrice: Map<string, string>;
          assetWeekOpenPrice: Map<string, string>;
          assetOrderBookLiquidity: Map<string, bigint>;
        },
        blockHeight: number,
        timestamp: number,
        includeSnapshots: boolean
      ) => Promise<Array<{ collection: string; id: string; data: Record<string, unknown> }>>;
    };
    const timestamp = 1_700_000_349;
    const assets = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'SORA', decimals: 18, supply: 1_000n * SCALE }]]);
    const analytics = {
      assets: new Map(),
      assetDayVolumeUSD: new Map(),
      assetWeekVolumeUSD: new Map(),
      assetDayOpenPrice: new Map(),
      assetWeekOpenPrice: new Map(),
      assetOrderBookLiquidity: new Map(),
    };

    const documents = await indexer.createAssetDocuments(
      assets,
      new Map([[XOR, 5n * SCALE]]),
      new Map(),
      analytics,
      77,
      timestamp,
      true
    );

    const defaultSnapshot = documents.find((document) => document.collection === 'assetSnapshots' && document.data.type === 'DEFAULT');
    const daySnapshot = documents.find((document) => document.collection === 'assetSnapshots' && document.data.type === 'DAY');

    expect(defaultSnapshot?.id).toBe(`asset-${XOR}-DEFAULT-1700000100`);
    expect(defaultSnapshot?.data.timestamp).toBe(timestamp);
    expect(daySnapshot?.id).toBe(`asset-${XOR}-DAY-1699920000`);
  });

  it('does not roll default asset snapshots into the next five-minute window early', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      createAssetDocuments: (
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>,
        prices: Map<string, bigint>,
        liquidity: Map<string, bigint>,
        analytics: {
          assets: Map<string, Map<string, unknown>>;
          assetDayVolumeUSD: Map<string, bigint>;
          assetWeekVolumeUSD: Map<string, bigint>;
          assetDayOpenPrice: Map<string, string>;
          assetWeekOpenPrice: Map<string, string>;
          assetOrderBookLiquidity: Map<string, bigint>;
        },
        blockHeight: number,
        timestamp: number,
        includeSnapshots: boolean
      ) => Promise<Array<{ collection: string; id: string; data: Record<string, unknown> }>>;
    };
    const assets = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'SORA', decimals: 18, supply: 1_000n * SCALE }]]);
    const analytics = {
      assets: new Map(),
      assetDayVolumeUSD: new Map(),
      assetWeekVolumeUSD: new Map(),
      assetDayOpenPrice: new Map(),
      assetWeekOpenPrice: new Map(),
      assetOrderBookLiquidity: new Map(),
    };
    const defaultSnapshotId = async (timestamp: number): Promise<string | undefined> => {
      const documents = await indexer.createAssetDocuments(
        assets,
        new Map([[XOR, 5n * SCALE]]),
        new Map(),
        analytics,
        77,
        timestamp,
        true
      );

      return documents.find((document) => document.collection === 'assetSnapshots' && document.data.type === 'DEFAULT')?.id;
    };

    await expect(defaultSnapshotId(1_700_000_399)).resolves.toBe(`asset-${XOR}-DEFAULT-1700000100`);
    await expect(defaultSnapshotId(1_700_000_400)).resolves.toBe(`asset-${XOR}-DEFAULT-1700000400`);
  });

  it('does not let block height change default asset snapshot buckets', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      createAssetDocuments: (
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>,
        prices: Map<string, bigint>,
        liquidity: Map<string, bigint>,
        analytics: {
          assets: Map<string, Map<string, unknown>>;
          assetDayVolumeUSD: Map<string, bigint>;
          assetWeekVolumeUSD: Map<string, bigint>;
          assetDayOpenPrice: Map<string, string>;
          assetWeekOpenPrice: Map<string, string>;
          assetOrderBookLiquidity: Map<string, bigint>;
        },
        blockHeight: number,
        timestamp: number,
        includeSnapshots: boolean
      ) => Promise<Array<{ collection: string; id: string; data: Record<string, unknown> }>>;
    };
    const timestamp = 1_700_000_349;
    const assets = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'SORA', decimals: 18, supply: 1_000n * SCALE }]]);
    const analytics = {
      assets: new Map(),
      assetDayVolumeUSD: new Map(),
      assetWeekVolumeUSD: new Map(),
      assetDayOpenPrice: new Map(),
      assetWeekOpenPrice: new Map(),
      assetOrderBookLiquidity: new Map(),
    };
    const assetDocuments = async (blockHeight: number) =>
      await indexer.createAssetDocuments(
        assets,
        new Map([[XOR, 5n * SCALE]]),
        new Map(),
        analytics,
        blockHeight,
        timestamp,
        true
      );

    const firstBlockDocuments = await assetDocuments(77);
    const secondBlockDocuments = await assetDocuments(78);
    const firstDefault = firstBlockDocuments.find(
      (document) => document.collection === 'assetSnapshots' && document.data.type === 'DEFAULT'
    );
    const secondDefault = secondBlockDocuments.find(
      (document) => document.collection === 'assetSnapshots' && document.data.type === 'DEFAULT'
    );
    const firstBlock = firstBlockDocuments.find(
      (document) => document.collection === 'assetSnapshots' && document.data.type === 'BLOCK'
    );
    const secondBlock = secondBlockDocuments.find(
      (document) => document.collection === 'assetSnapshots' && document.data.type === 'BLOCK'
    );

    expect(firstDefault?.id).toBe(secondDefault?.id);
    expect(firstDefault?.id).toBe(`asset-${XOR}-DEFAULT-1700000100`);
    expect(firstBlock?.id).toBe(`asset-${XOR}-BLOCK-77`);
    expect(secondBlock?.id).toBe(`asset-${XOR}-BLOCK-78`);
  });

  it('buckets default pool snapshots into five-minute chart windows', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      createPoolDocuments: (
        pools: Array<{
          id: string;
          baseAssetId: string;
          targetAssetId: string;
          baseAssetReserves: bigint;
          targetAssetReserves: bigint;
          poolAccount: string;
          poolTokenSupply: bigint;
          liquidityUSD: string;
          priceUSD: string;
        }>,
        analytics: {
          pools: Map<string, Map<string, unknown>>;
        },
        apyByPool: Map<string, string>,
        blockHeight: number,
        timestamp: number,
        includeSnapshots: boolean
      ) => Promise<Array<{ collection: string; id: string; data: Record<string, unknown> }>>;
    };
    const timestamp = 1_700_000_349;
    const poolId = `${XOR}-${KUSD}`;
    const analytics = {
      pools: new Map(),
    };

    const documents = await indexer.createPoolDocuments(
      [
        {
          id: poolId,
          baseAssetId: XOR,
          targetAssetId: KUSD,
          baseAssetReserves: 100n * SCALE,
          targetAssetReserves: 500n * SCALE,
          poolAccount: 'pool-account',
          poolTokenSupply: 1_000n * SCALE,
          liquidityUSD: '1000',
          priceUSD: '5',
        },
      ],
      analytics,
      new Map(),
      77,
      timestamp,
      true
    );

    const defaultSnapshot = documents.find((document) => document.collection === 'poolSnapshots' && document.data.type === 'DEFAULT');
    const daySnapshot = documents.find((document) => document.collection === 'poolSnapshots' && document.data.type === 'DAY');

    expect(defaultSnapshot?.id).toBe(`pool-${poolId}-DEFAULT-1700000100`);
    expect(defaultSnapshot?.data.timestamp).toBe(timestamp);
    expect(daySnapshot?.id).toBe(`pool-${poolId}-DAY-1699920000`);
  });

  it('buckets default order book snapshots into five-minute chart windows', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      createOrderBookDocuments: (
        orderBooks: unknown[],
        bids: unknown[],
        asks: unknown[],
        limitOrders: unknown[],
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>,
        prices: Map<string, bigint>,
        analytics: {
          orderBooks: Map<string, Map<string, unknown>>;
          orderBookActiveReserves: Map<string, { baseAssetReserves: bigint; quoteAssetReserves: bigint; liquidityUSD: bigint }>;
          orderBookDayVolumeUSD: Map<string, bigint>;
          orderBookDayOpenPrice: Map<string, string>;
        },
        blockHeight: number,
        timestamp: number,
        includeSnapshots: boolean
      ) => Promise<Array<{ collection: string; id: string; data: Record<string, unknown> }>>;
    };
    const timestamp = 1_700_000_349;
    const orderBookId = `0-${XOR}-${KUSD}`;
    const assets = new Map([
      [XOR, { id: XOR, symbol: 'XOR', name: 'SORA', decimals: 18, supply: 1_000n * SCALE }],
      [KUSD, { id: KUSD, symbol: 'KUSD', name: 'Kensetsu USD', decimals: 18, supply: 1_000n * SCALE }],
    ]);
    const analytics = {
      orderBooks: new Map(),
      orderBookActiveReserves: new Map(),
      orderBookDayVolumeUSD: new Map(),
      orderBookDayOpenPrice: new Map(),
    };

    const documents = await indexer.createOrderBookDocuments(
      [[{ args: [{ dexId: 0, base: XOR, quote: KUSD }] }, { status: 'Trade' }]],
      [],
      [],
      [],
      assets,
      new Map([
        [XOR, 5n * SCALE],
        [KUSD, SCALE],
      ]),
      analytics,
      77,
      timestamp,
      true
    );

    const defaultSnapshot = documents.find(
      (document) => document.collection === 'orderBookSnapshots' && document.data.type === 'DEFAULT'
    );
    const daySnapshot = documents.find(
      (document) => document.collection === 'orderBookSnapshots' && document.data.type === 'DAY'
    );

    expect(defaultSnapshot?.id).toBe(`orderBook-${orderBookId}-DEFAULT-1700000100`);
    expect(defaultSnapshot?.data.timestamp).toBe(timestamp);
    expect(daySnapshot?.id).toBe(`orderBook-${orderBookId}-DAY-1699920000`);
  });

  it('projects Polkamarkt runtime storage into production market documents', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      createPolkamarktMarketDocuments: (
        conditions: unknown[],
        conditionDetails: unknown[],
        markets: unknown[],
        pools: unknown[],
        volumes: unknown[],
        totals: unknown[],
        resolutions: unknown[],
        resolutionEvidence: unknown[],
        cancellationEvidence: unknown[],
        liquidityTotals: unknown[],
        creatorFees: unknown[],
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>,
        blockHeight: number,
        timestamp: number
      ) => Array<{ collection: string; id: string; data: Record<string, unknown> }>;
      createPolkamarktPositionDocuments: (
        positions: unknown[],
        liquidityPositions: unknown[],
        markets: unknown[],
        pools: unknown[],
        totals: unknown[],
        resolutions: unknown[],
        liquidityTotals: unknown[],
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>,
        blockHeight: number,
        timestamp: number
      ) => Array<{ collection: string; id: string; data: Record<string, unknown> }>;
    };
    const bytes = (value: string) => [...Buffer.from(value)];
    const assets = new Map([[KUSD, { id: KUSD, symbol: 'KUSD', name: 'Kensetsu USD', decimals: 18, supply: 0n }]]);

    const documents = indexer.createPolkamarktMarketDocuments(
      [[{ args: [7] }, { question: bytes('Will KUSD stay at peg?'), oracle: bytes('SORA Democracy'), resolutionSource: bytes('sora:governance:democracy:referendum:124') }]],
      [[{ args: [7] }, { category: bytes('Crypto'), tags: bytes('KUSD,peg'), metadataUri: bytes('ipfs://metadata'), metadataHash: new Array(32).fill(1), rulesUri: bytes('ipfs://rules') }]],
      [[{ args: [3] }, { creator: 'alice', conditionId: 7, closeBlock: 123_456, collateralAsset: KUSD, seedLiquidity: (1_000n * SCALE).toString(), status: 'Open' }]],
      [[{ args: [3] }, { collateral: (1_200n * SCALE).toString(), yes: (40n * SCALE).toString(), no: (60n * SCALE).toString() }]],
      [[{ args: [3] }, (250n * SCALE).toString()]],
      [],
      [],
      [[{ args: [3] }, { uri: bytes('ipfs://resolution'), hash: new Array(32).fill(2), atBlock: 99 }]],
      [],
      [[{ args: [3] }, { totalShares: (1_000n * SCALE).toString(), totalCollateralContributed: (1_000n * SCALE).toString() }]],
      [[{ args: [3] }, (5n * SCALE).toString()]],
      assets,
      77,
      1_700_000_349
    );

    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      collection: 'markets',
      id: '3',
      data: {
        id: '3',
        marketId: 3,
        conditionId: 7,
        title: 'Will KUSD stay at peg?',
        category: 'Crypto',
        tags: 'KUSD,peg',
        metadataUri: 'ipfs://metadata',
        metadataHash: `0x${'01'.repeat(32)}`,
        rulesUri: 'ipfs://rules',
        oracle: 'SORA Democracy',
        resolutionSource: 'sora:governance:democracy:referendum:124',
        closeBlock: 123_456,
        status: 'Open',
        creatorFees: '5',
        liquidityUSD: '1200',
        liquidityShares: '1000',
        liquidityCollateralContributed: '1000',
        volumeUSD: '250',
        probability: 60,
        priceYes: 0.6,
        resolutionEvidenceUri: 'ipfs://resolution',
        resolutionEvidenceHash: `0x${'02'.repeat(32)}`,
        resolutionEvidenceBlock: 99,
        governancePallet: 'democracy',
        governanceBody: 'Democracy',
        governanceKind: 'Referendum',
        governanceReferendumIndex: 124,
      },
    });

    const positions = indexer.createPolkamarktPositionDocuments(
      [[{ args: [3, 'bob'] }, { yesShares: (12n * SCALE).toString(), noShares: 0, netCollateralPaid: (6n * SCALE).toString() }]],
      [[{ args: [3, 'bob'] }, { shares: (25n * SCALE).toString(), collateralContributed: (25n * SCALE).toString() }]],
      [[{ args: [3] }, { creator: 'alice', conditionId: 7, closeBlock: 123_456, collateralAsset: KUSD, seedLiquidity: (1_000n * SCALE).toString(), status: 'Resolved' }]],
      [[{ args: [3] }, { collateral: (1_200n * SCALE).toString() }]],
      [[{ args: [3] }, { totalYesShares: (12n * SCALE).toString(), totalNoShares: 0, totalNetCollateralPaid: (6n * SCALE).toString() }]],
      [[{ args: [3] }, 'Yes']],
      [[{ args: [3] }, { totalShares: (100n * SCALE).toString(), totalCollateralContributed: (100n * SCALE).toString() }]],
      assets,
      77,
      1_700_000_349
    );

    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({
      collection: 'accountPositions',
      id: '3-bob',
      data: {
        account: 'bob',
        marketId: 3,
        outcome: 'Yes',
        shares: '12',
        yesShares: '12',
        noShares: '0',
        netCollateralPaid: '6',
        lpShares: '25',
        lpCollateralContributed: '25',
        claimablePayoutUsd: '12',
        lpClaimablePayoutUsd: '297',
        isCreator: false,
        status: 'Resolved',
        market: { id: '3', marketId: 3 },
      },
    });
  });

  it('hardens Polkamarkt market projection against malformed storage and partial upgrades', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      createPolkamarktMarketDocuments: (
        conditions: unknown[],
        conditionDetails: unknown[],
        markets: unknown[],
        pools: unknown[],
        volumes: unknown[],
        totals: unknown[],
        resolutions: unknown[],
        resolutionEvidence: unknown[],
        cancellationEvidence: unknown[],
        liquidityTotals: unknown[],
        creatorFees: unknown[],
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>,
        blockHeight: number,
        timestamp: number
      ) => Array<{ collection: string; id: string; data: Record<string, unknown> }>;
    };
    const bytes = (value: string) => [...Buffer.from(value)];
    const invalidUtf8 = [0xff, 0xfe, 0xfd];
    const assets = new Map([[KUSD, { id: KUSD, symbol: 'KUSD', name: 'Kensetsu USD', decimals: 18, supply: 0n }]]);

    const documents = indexer.createPolkamarktMarketDocuments(
      [
        [{ args: [7] }, { question: invalidUtf8, oracle: bytes('bad oracle'), resolutionSource: bytes('bad source') }],
        [{ args: [8] }, { question: bytes('Will malformed metadata be ignored?'), oracle: bytes('SORA Council'), resolutionSource: bytes('sora:governance:council:motion:not-a-number') }],
      ],
      [[{ args: [8] }, { category: invalidUtf8, tags: bytes('safe,metadata'), metadataUri: invalidUtf8, metadataHash: [1, 256], rulesUri: bytes('ipfs://rules') }]],
      [
        [{ args: ['not-a-number'] }, { creator: 'mallory', conditionId: 8, closeBlock: 111, collateralAsset: KUSD, seedLiquidity: (1_000n * SCALE).toString(), status: 'Open' }],
        [{ args: [3] }, { creator: 'alice', conditionId: 7, closeBlock: 111, collateralAsset: KUSD, seedLiquidity: (1_000n * SCALE).toString(), status: 'Open' }],
        [{ args: [4] }, { creator: 'alice', conditionId: 8, closeBlock: 222, collateralAsset: KUSD, seedLiquidity: (1_000n * SCALE).toString(), status: { open: null } }],
      ],
      [],
      [[{ args: [4] }, 'not-a-balance']],
      [],
      [[{ args: [4] }, { no: null }]],
      [[{ args: [4] }, { uri: invalidUtf8, hash: '0xzz', atBlock: 'bad-block' }]],
      [[{ args: [4] }, { uri: invalidUtf8, hash: [2, -1], atBlock: 0 }]],
      [],
      [[{ args: [4] }, 'bad-fee']],
      assets,
      88,
      1_700_000_555
    );

    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      collection: 'markets',
      id: '4',
      data: {
        marketId: 4,
        conditionId: 8,
        title: 'Will malformed metadata be ignored?',
        category: 'Other',
        tags: 'safe,metadata',
        metadataUri: null,
        metadataHash: null,
        rulesUri: 'ipfs://rules',
        status: 'Open',
        seedLiquidity: '1000',
        liquidityUSD: '1000',
        liquidityShares: '0',
        volumeUSD: '0',
        creatorFees: '0',
        resolutionOutcome: 'No',
        resolutionEvidenceUri: null,
        resolutionEvidenceHash: null,
        resolutionEvidenceBlock: null,
        cancellationEvidenceUri: null,
        cancellationEvidenceHash: null,
        cancellationEvidenceBlock: null,
      },
    });
    expect(documents[0].data.governancePallet).toBeUndefined();
    expect(documents[0].data.governanceKind).toBeUndefined();
  });

  it('hardens Polkamarkt position projection against orphaned, zero, and malformed entries', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      createPolkamarktPositionDocuments: (
        positions: unknown[],
        liquidityPositions: unknown[],
        markets: unknown[],
        pools: unknown[],
        totals: unknown[],
        resolutions: unknown[],
        liquidityTotals: unknown[],
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>,
        blockHeight: number,
        timestamp: number
      ) => Array<{ collection: string; id: string; data: Record<string, unknown> }>;
    };
    const assets = new Map([[KUSD, { id: KUSD, symbol: 'KUSD', name: 'Kensetsu USD', decimals: 18, supply: 0n }]]);

    const documents = indexer.createPolkamarktPositionDocuments(
      [
        [{ args: ['bad-market', 'mallory'] }, { yesShares: (1n * SCALE).toString(), noShares: 0, netCollateralPaid: 0 }],
        [{ args: [3, ''] }, { yesShares: (1n * SCALE).toString(), noShares: 0, netCollateralPaid: 0 }],
        [{ args: [99, 'orphan'] }, { yesShares: (1n * SCALE).toString(), noShares: 0, netCollateralPaid: 0 }],
        [{ args: [3, 'zero'] }, { yesShares: 0, noShares: 0, netCollateralPaid: 0 }],
        [{ args: [3, 'bob'] }, { yesShares: (5n * SCALE).toString(), noShares: 0, netCollateralPaid: (2n * SCALE).toString() }],
      ],
      [
        [{ args: [99, 'orphan-lp'] }, { shares: (10n * SCALE).toString(), collateralContributed: (10n * SCALE).toString() }],
        [{ args: [3, 'zero-lp'] }, { shares: 0, collateralContributed: 0 }],
        [{ args: [3, 'lp-only'] }, { shares: (10n * SCALE).toString(), collateralContributed: (10n * SCALE).toString() }],
      ],
      [[{ args: [3] }, { creator: 'alice', conditionId: 8, closeBlock: 222, collateralAsset: KUSD, seedLiquidity: (1_000n * SCALE).toString(), status: 'Cancelled' }]],
      [[{ args: [3] }, { collateral: (1_000n * SCALE).toString() }]],
      [[{ args: [3] }, { totalYesShares: 0, totalNoShares: 0, totalNetCollateralPaid: (100n * SCALE).toString() }]],
      [],
      [[{ args: [3] }, { totalShares: (100n * SCALE).toString(), totalCollateralContributed: (100n * SCALE).toString() }]],
      assets,
      88,
      1_700_000_555
    );

    expect(documents.map((document) => document.id).sort()).toEqual(['3-bob', '3-lp-only']);
    expect(documents.find((document) => document.id === '3-bob')).toMatchObject({
      data: {
        account: 'bob',
        marketId: 3,
        yesShares: '5',
        noShares: '0',
        netCollateralPaid: '2',
        claimablePayoutUsd: '2',
        lpShares: '0',
        lpClaimablePayoutUsd: '0',
        marketValueUsd: '2',
      },
    });
    expect(documents.find((document) => document.id === '3-lp-only')).toMatchObject({
      data: {
        account: 'lp-only',
        marketId: 3,
        outcome: null,
        shares: '0',
        lpShares: '10',
        lpCollateralContributed: '10',
        claimablePayoutUsd: '0',
        lpClaimablePayoutUsd: '90',
        marketValueUsd: '90',
      },
    });
  });

  it('deletes stale Polkamarkt account positions after zero or removed storage entries', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([
      {
        collection: 'accountPositions',
        id: '3-bob',
        blockHeight: 70,
        timestamp: 1_700_000_000,
        data: { id: '3-bob', account: 'bob', marketId: 3, yesShares: '1' },
      },
      {
        collection: 'accountPositions',
        id: '3-zero',
        blockHeight: 70,
        timestamp: 1_700_000_000,
        data: { id: '3-zero', account: 'zero', marketId: 3, yesShares: '9' },
      },
      {
        collection: 'accountPositions',
        id: '4-absent',
        blockHeight: 70,
        timestamp: 1_700_000_000,
        data: { id: '4-absent', account: 'absent', marketId: 4, yesShares: '7' },
      },
    ]);
    const indexer = new ChainIndexer(config, repository) as unknown as {
      createPolkamarktPositionDocuments: (
        positions: unknown[],
        liquidityPositions: unknown[],
        markets: unknown[],
        pools: unknown[],
        totals: unknown[],
        resolutions: unknown[],
        liquidityTotals: unknown[],
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>,
        blockHeight: number,
        timestamp: number
      ) => IndexerDocument[];
      deleteStaleAccountPositionDocuments: (activeDocuments: IndexerDocument[]) => Promise<void>;
    };
    const assets = new Map([[KUSD, { id: KUSD, symbol: 'KUSD', name: 'Kensetsu USD', decimals: 18, supply: 0n }]]);
    const activeDocuments = indexer.createPolkamarktPositionDocuments(
      [
        [{ args: [3, 'bob'] }, { yesShares: (5n * SCALE).toString(), noShares: 0, netCollateralPaid: (2n * SCALE).toString() }],
        [{ args: [3, 'zero'] }, { yesShares: 0, noShares: 0, netCollateralPaid: 0 }],
      ],
      [[{ args: [3, 'zero'] }, { shares: 0, collateralContributed: 0 }]],
      [[{ args: [3] }, { creator: 'alice', conditionId: 8, closeBlock: 222, collateralAsset: KUSD, seedLiquidity: (1_000n * SCALE).toString(), status: 'Open' }]],
      [[{ args: [3] }, { collateral: (1_000n * SCALE).toString() }]],
      [[{ args: [3] }, { totalYesShares: 0, totalNoShares: 0, totalNetCollateralPaid: 0 }]],
      [],
      [],
      assets,
      88,
      1_700_000_555
    );

    expect(activeDocuments.map((document) => document.id)).toEqual(['3-bob']);

    await repository.upsertMany(activeDocuments);
    await indexer.deleteStaleAccountPositionDocuments(activeDocuments);

    expect((await repository.get('accountPositions', '3-bob'))?.data.yesShares).toBe('5');
    await expect(repository.get('accountPositions', '3-zero')).resolves.toBeNull();
    await expect(repository.get('accountPositions', '4-absent')).resolves.toBeNull();
  });

  it('does not emit price chart snapshots when snapshots are disabled', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      createAssetDocuments: (
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>,
        prices: Map<string, bigint>,
        liquidity: Map<string, bigint>,
        analytics: {
          assets: Map<string, Map<string, unknown>>;
          assetDayVolumeUSD: Map<string, bigint>;
          assetWeekVolumeUSD: Map<string, bigint>;
          assetDayOpenPrice: Map<string, string>;
          assetWeekOpenPrice: Map<string, string>;
          assetOrderBookLiquidity: Map<string, bigint>;
        },
        blockHeight: number,
        timestamp: number,
        includeSnapshots: boolean
      ) => Promise<Array<{ collection: string; id: string; data: Record<string, unknown> }>>;
      createPoolDocuments: (
        pools: Array<{
          id: string;
          baseAssetId: string;
          targetAssetId: string;
          baseAssetReserves: bigint;
          targetAssetReserves: bigint;
          poolAccount: string;
          poolTokenSupply: bigint;
          liquidityUSD: string;
          priceUSD: string;
        }>,
        analytics: {
          pools: Map<string, Map<string, unknown>>;
        },
        apyByPool: Map<string, string>,
        blockHeight: number,
        timestamp: number,
        includeSnapshots: boolean
      ) => Promise<Array<{ collection: string; id: string; data: Record<string, unknown> }>>;
      createOrderBookDocuments: (
        orderBooks: unknown[],
        bids: unknown[],
        asks: unknown[],
        limitOrders: unknown[],
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>,
        prices: Map<string, bigint>,
        analytics: {
          orderBooks: Map<string, Map<string, unknown>>;
          orderBookActiveReserves: Map<string, { baseAssetReserves: bigint; quoteAssetReserves: bigint; liquidityUSD: bigint }>;
          orderBookDayVolumeUSD: Map<string, bigint>;
          orderBookDayOpenPrice: Map<string, string>;
        },
        blockHeight: number,
        timestamp: number,
        includeSnapshots: boolean
      ) => Promise<Array<{ collection: string; id: string; data: Record<string, unknown> }>>;
    };
    const timestamp = 1_700_000_349;
    const assets = new Map([
      [XOR, { id: XOR, symbol: 'XOR', name: 'SORA', decimals: 18, supply: 1_000n * SCALE }],
      [KUSD, { id: KUSD, symbol: 'KUSD', name: 'Kensetsu USD', decimals: 18, supply: 1_000n * SCALE }],
    ]);
    const poolId = `${XOR}-${KUSD}`;
    const assetAnalytics = {
      assets: new Map(),
      assetDayVolumeUSD: new Map(),
      assetWeekVolumeUSD: new Map(),
      assetDayOpenPrice: new Map(),
      assetWeekOpenPrice: new Map(),
      assetOrderBookLiquidity: new Map(),
    };
    const poolAnalytics = {
      pools: new Map(),
    };
    const orderBookAnalytics = {
      orderBooks: new Map(),
      orderBookActiveReserves: new Map(),
      orderBookDayVolumeUSD: new Map(),
      orderBookDayOpenPrice: new Map(),
    };

    const assetDocuments = await indexer.createAssetDocuments(
      assets,
      new Map([[XOR, 5n * SCALE]]),
      new Map(),
      assetAnalytics,
      77,
      timestamp,
      false
    );
    const poolDocuments = await indexer.createPoolDocuments(
      [
        {
          id: poolId,
          baseAssetId: XOR,
          targetAssetId: KUSD,
          baseAssetReserves: 100n * SCALE,
          targetAssetReserves: 500n * SCALE,
          poolAccount: 'pool-account',
          poolTokenSupply: 1_000n * SCALE,
          liquidityUSD: '1000',
          priceUSD: '5',
        },
      ],
      poolAnalytics,
      new Map(),
      77,
      timestamp,
      false
    );
    const orderBookDocuments = await indexer.createOrderBookDocuments(
      [[{ args: [{ dexId: 0, base: XOR, quote: KUSD }] }, { status: 'Trade' }]],
      [],
      [],
      [],
      assets,
      new Map([
        [XOR, 5n * SCALE],
        [KUSD, SCALE],
      ]),
      orderBookAnalytics,
      77,
      timestamp,
      false
    );

    expect(assetDocuments.map((document) => document.collection)).toEqual(['assets', 'assets']);
    expect(poolDocuments.map((document) => document.collection)).toEqual(['poolXYKs']);
    expect(orderBookDocuments.map((document) => document.collection)).toEqual(['orderBooks']);
  });

  it('creates network snapshots only for aggregate windows', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      createNetworkSnapshotDocuments: (
        analytics: unknown,
        blockHeight: number,
        timestamp: number,
        includeSnapshots: boolean
      ) => Array<{ collection: string; id: string; data: Record<string, unknown> }>;
    };
    const analytics = {
      network: new Map([
        [
          'DEFAULT',
          {
            accounts: 10,
            transactions: 3,
            fees: 123n,
            liquidityUSD: '456.5',
            poolLiquidityUSD: '400.25',
            orderBookLiquidityUSD: '56.25',
            volumeUSD: 789n * SCALE,
            swaps: 2,
            activePools: 7,
            activeOrderBooks: 4,
            listedAssets: 21,
            bridgeIncomingTransactions: 1,
            bridgeOutgoingTransactions: 2,
          },
        ],
      ]),
    };

    expect(indexer.createNetworkSnapshotDocuments(analytics, 10, 1_700_000_000, false)).toEqual([]);
    const documents = indexer.createNetworkSnapshotDocuments(analytics, 10, 1_700_000_000, true);

    expect(documents.map((document) => document.data.type)).toEqual(['DEFAULT', 'HOUR', 'DAY', 'MONTH']);
    expect(documents[0].id).toBe('network-all-DEFAULT-1699999800');
    expect(documents[0]).toMatchObject({
      collection: 'networkSnapshots',
      data: {
        accounts: 10,
        transactions: 3,
        fees: '123',
        liquidityUSD: '456.5',
        poolLiquidityUSD: '400.25',
        orderBookLiquidityUSD: '56.25',
        volumeUSD: '789',
        swaps: 2,
        activePools: 7,
        activeOrderBooks: 4,
        listedAssets: 21,
        bridgeIncomingTransactions: 1,
        bridgeOutgoingTransactions: 2,
      },
    });
  });

  it('does not let block height change default network aggregate buckets', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      createNetworkSnapshotDocuments: (
        analytics: unknown,
        blockHeight: number,
        timestamp: number,
        includeSnapshots: boolean
      ) => Array<{ collection: string; id: string; data: Record<string, unknown> }>;
    };
    const analytics = {
      network: new Map(),
    };
    const timestamp = 1_700_000_349;

    const firstBlockDocuments = indexer.createNetworkSnapshotDocuments(analytics, 77, timestamp, true);
    const secondBlockDocuments = indexer.createNetworkSnapshotDocuments(analytics, 78, timestamp, true);
    const firstDefault = firstBlockDocuments.find((document) => document.data.type === 'DEFAULT');
    const secondDefault = secondBlockDocuments.find((document) => document.data.type === 'DEFAULT');

    expect(firstBlockDocuments.some((document) => document.data.type === 'BLOCK')).toBe(false);
    expect(firstDefault?.id).toBe(secondDefault?.id);
    expect(firstDefault?.id).toBe('network-all-DEFAULT-1700000100');
  });

  it('does not roll default network aggregates into the next five-minute window early', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      createNetworkSnapshotDocuments: (
        analytics: unknown,
        blockHeight: number,
        timestamp: number,
        includeSnapshots: boolean
      ) => Array<{ collection: string; id: string; data: Record<string, unknown> }>;
    };
    const analytics = {
      network: new Map(),
    };
    const defaultSnapshotId = (timestamp: number): string | undefined => {
      const documents = indexer.createNetworkSnapshotDocuments(analytics, 77, timestamp, true);
      return documents.find((document) => document.data.type === 'DEFAULT')?.id;
    };

    expect(defaultSnapshotId(1_700_000_399)).toBe('network-all-DEFAULT-1700000100');
    expect(defaultSnapshotId(1_700_000_400)).toBe('network-all-DEFAULT-1700000400');
  });

  it('aggregates network account counts from account creation timestamps', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      buildAnalytics: (
        timestamp: number,
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>,
        prices: Map<string, bigint>,
        pools: unknown[],
        liquidityStats: {
          liquidityUSD: string;
          poolLiquidityUSD: string;
          orderBookLiquidityUSD: string;
          activePools: number;
          activeOrderBooks: number;
          listedAssets: number;
        }
      ) => Promise<{ network: Map<string, { accounts: number; transactions: number }> }>;
    };

    await repository.upsertMany([
      createBlockNetworkSnapshot(1, 100, { accounts: 99, transactions: 1 }),
      createBlockNetworkSnapshot(2, 4_000, { accounts: 99, transactions: 2 }),
      createBlockNetworkSnapshot(3, 7_000, { accounts: 99, transactions: 3 }),
      {
        collection: 'accountMeta',
        id: 'old-account',
        blockHeight: 1,
        timestamp: 100,
        data: { id: 'old-account', accountId: 'old-account', createdAtTimestamp: 100 },
      },
      {
        collection: 'accountMeta',
        id: 'hour-account',
        blockHeight: 2,
        timestamp: 4_000,
        data: { id: 'hour-account', accountId: 'hour-account', createdAtTimestamp: 4_000 },
      },
      {
        collection: 'accountMeta',
        id: 'default-account',
        blockHeight: 3,
        timestamp: 7_000,
        data: { id: 'default-account', accountId: 'default-account', createdAtTimestamp: 7_000 },
      },
    ]);

    const analytics = await indexer.buildAnalytics(
      7_300,
      new Map(),
      new Map(),
      [],
      {
        liquidityUSD: '0',
        poolLiquidityUSD: '0',
        orderBookLiquidityUSD: '0',
        activePools: 0,
        activeOrderBooks: 0,
        listedAssets: 0,
      }
    );

    expect(analytics.network.get('DEFAULT')).toMatchObject({ accounts: 1, transactions: 3 });
    expect(analytics.network.get('HOUR')).toMatchObject({ accounts: 2, transactions: 5 });
    expect(analytics.network.get('DAY')).toMatchObject({ accounts: 3, transactions: 6 });
  });

  it('repairs legacy network transaction counters from history rows and updates existing aggregates', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      repairNetworkTransactionCounters: () => Promise<boolean>;
    };

    await repository.upsertMany([
      createBlockNetworkSnapshot(1, 100, { transactions: 2, swaps: 0, bridgeIncomingTransactions: 0 }),
      createBlockNetworkSnapshot(2, 200, { transactions: 1, swaps: 0, bridgeIncomingTransactions: 0 }),
      createBlockNetworkSnapshot(3, 300, { transactions: 4, swaps: 0, bridgeIncomingTransactions: 0 }),
      {
        collection: 'networkSnapshots',
        id: 'network-all-DAY-0',
        blockHeight: 3,
        timestamp: 300,
        data: {
          id: 'network-all-DAY-0',
          type: 'DAY',
          timestamp: 300,
          transactions: 99,
          swaps: 99,
          bridgeIncomingTransactions: 99,
          bridgeOutgoingTransactions: 99,
          liquidityUSD: '123',
        },
      },
      {
        collection: 'historyElements',
        id: '0xpaid-transfer',
        blockHeight: 1,
        timestamp: 100,
        data: {
          id: '0xpaid-transfer',
          blockHeight: 1,
          timestamp: 100,
          module: 'assets',
          method: 'transfer',
          networkFee: SCALE.toString(),
          execution: { success: true },
        },
      },
      {
        collection: 'historyElements',
        id: '0xinbound-mint',
        blockHeight: 1,
        timestamp: 100,
        data: {
          id: '0xinbound-mint',
          blockHeight: 1,
          timestamp: 100,
          module: 'bridgeProxy',
          method: 'mint',
          networkFee: SCALE.toString(),
          execution: { success: true },
        },
      },
      {
        collection: 'historyElements',
        id: '0xpaid-swap',
        blockHeight: 3,
        timestamp: 300,
        data: {
          id: '0xpaid-swap',
          blockHeight: 3,
          timestamp: 300,
          module: 'liquidityProxy',
          method: 'swap',
          networkFee: SCALE.toString(),
          execution: { success: true },
        },
      },
      {
        collection: 'historyElements',
        id: '0xfailed-bridge',
        blockHeight: 3,
        timestamp: 300,
        data: {
          id: '0xfailed-bridge',
          blockHeight: 3,
          timestamp: 300,
          module: 'bridgeProxy',
          method: 'burn',
          networkFee: SCALE.toString(),
          execution: { success: false },
        },
      },
    ]);

    await expect(indexer.repairNetworkTransactionCounters()).resolves.toBe(true);

    await expect(repository.get('networkSnapshots', 'block-1')).resolves.toMatchObject({
      data: { transactions: 1, swaps: 0, bridgeIncomingTransactions: 1, bridgeOutgoingTransactions: 0 },
    });
    await expect(repository.get('networkSnapshots', 'block-2')).resolves.toMatchObject({
      data: { transactions: 0, swaps: 0, bridgeIncomingTransactions: 0, bridgeOutgoingTransactions: 0 },
    });
    await expect(repository.get('networkSnapshots', 'block-3')).resolves.toMatchObject({
      data: { transactions: 2, swaps: 1, bridgeIncomingTransactions: 0, bridgeOutgoingTransactions: 0 },
    });
    await expect(repository.get('networkSnapshots', 'network-all-DAY-0')).resolves.toMatchObject({
      data: {
        transactions: 3,
        swaps: 1,
        bridgeIncomingTransactions: 1,
        bridgeOutgoingTransactions: 0,
        liquidityUSD: '123',
      },
    });
    await expect(repository.get('updatesStreams', 'networkTransactionCounterRepair-v1')).resolves.not.toBeNull();
  });

  it('backfills aggregate network snapshots from indexed block snapshots', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      backfillNetworkAggregateSnapshots: () => Promise<boolean>;
    };

    await repository.upsertMany([
      createBlockNetworkSnapshot(1, 100, {
        accounts: 2,
        transactions: 1,
        fees: '10',
        liquidityUSD: '100',
        poolLiquidityUSD: '80',
        orderBookLiquidityUSD: '20',
        volumeUSD: '1.25',
        swaps: 1,
      }),
      createBlockNetworkSnapshot(2, 86_500, {
        accounts: 3,
        transactions: 2,
        fees: '20',
        liquidityUSD: '110',
        poolLiquidityUSD: '85',
        orderBookLiquidityUSD: '25',
        volumeUSD: '2.5',
        bridgeIncomingTransactions: 1,
      }),
      createBlockNetworkSnapshot(3, 172_900, {
        accounts: 5,
        transactions: 3,
        fees: '30',
        liquidityUSD: '120',
        poolLiquidityUSD: '90',
        orderBookLiquidityUSD: '30',
        volumeUSD: '3.5',
        bridgeOutgoingTransactions: 2,
      }),
    ]);

    await expect(indexer.backfillNetworkAggregateSnapshots()).resolves.toBe(true);

    const firstDay = await repository.get('networkSnapshots', 'network-all-DAY-0');
    const secondDay = await repository.get('networkSnapshots', 'network-all-DAY-86400');
    const thirdDay = await repository.get('networkSnapshots', 'network-all-DAY-172800');
    const month = await repository.get('networkSnapshots', 'network-all-MONTH-0');
    const state = await repository.get('updatesStreams', 'networkAggregateSnapshotsBackfill');

    expect(firstDay?.timestamp).toBe(100);
    expect(firstDay?.blockHeight).toBe(1);
    expect(firstDay?.data).toMatchObject({
      type: 'DAY',
      timestamp: 100,
      accounts: 2,
      transactions: 1,
      fees: '10',
      volumeUSD: '1.25',
      swaps: 1,
      bridgeIncomingTransactions: 0,
      bridgeOutgoingTransactions: 0,
    });
    expect(secondDay?.timestamp).toBe(86_500);
    expect(secondDay?.blockHeight).toBe(2);
    expect(secondDay?.data).toMatchObject({
      type: 'DAY',
      timestamp: 86_500,
      accounts: 5,
      transactions: 3,
      fees: '30',
      volumeUSD: '3.75',
      swaps: 1,
      bridgeIncomingTransactions: 1,
      bridgeOutgoingTransactions: 0,
    });
    expect(thirdDay?.timestamp).toBe(172_900);
    expect(thirdDay?.blockHeight).toBe(3);
    expect(thirdDay?.data).toMatchObject({
      type: 'DAY',
      timestamp: 172_900,
      accounts: 8,
      transactions: 5,
      fees: '50',
      volumeUSD: '6',
      bridgeIncomingTransactions: 1,
      bridgeOutgoingTransactions: 2,
    });
    expect(month?.data).toMatchObject({
      type: 'MONTH',
      timestamp: 172_900,
      accounts: 10,
      transactions: 6,
      fees: '60',
      volumeUSD: '7.25',
      bridgeIncomingTransactions: 1,
      bridgeOutgoingTransactions: 2,
    });
    for (const document of [firstDay, secondDay, thirdDay, month]) {
      expectNoBackfilledNetworkStockMetrics(document);
    }
    expect(state?.data.data).toBe(JSON.stringify({ lastIndexedBlock: 3, lastTimestamp: 172_900 }));
  });

  it('keeps existing aggregate network snapshots during backfill', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      backfillNetworkAggregateSnapshots: () => Promise<boolean>;
    };

    await repository.upsertMany([
      createBlockNetworkSnapshot(1, 100, {
        transactions: 1,
        fees: '10',
        volumeUSD: '1',
      }),
      createBlockNetworkSnapshot(2, 86_500, {
        transactions: 2,
        fees: '20',
        volumeUSD: '2',
      }),
      {
        collection: 'networkSnapshots',
        id: 'network-all-DAY-86400',
        blockHeight: 99,
        timestamp: 86_600,
        data: {
          id: 'network-all-DAY-86400',
          type: 'DAY',
          timestamp: 86_600,
          accounts: 42,
          transactions: 99,
          fees: '999',
          liquidityUSD: '999',
          poolLiquidityUSD: '999',
          orderBookLiquidityUSD: '0',
          volumeUSD: '999',
          swaps: 0,
          activePools: 0,
          activeOrderBooks: 0,
          listedAssets: 0,
          bridgeIncomingTransactions: 0,
          bridgeOutgoingTransactions: 0,
        },
      },
    ]);

    await expect(indexer.backfillNetworkAggregateSnapshots()).resolves.toBe(true);

    expect(await repository.get('networkSnapshots', 'network-all-DAY-86400')).toMatchObject({
      blockHeight: 99,
      timestamp: 86_600,
      data: {
        transactions: 99,
        fees: '999',
        volumeUSD: '999',
      },
    });
  });

  it('creates update stream JSON payloads for prices, APY, and asset registration', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      createUpdateStreams: (
        pools: unknown[],
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number }>,
        prices: Map<string, bigint>,
        apyByPool: Map<string, string>,
        blockHeight: number,
        timestamp: number
      ) => Array<{ id: string; blockHeight: number; timestamp: number; data: { data: string; block: number } }>;
    };
    const poolId = `${XOR}-${KUSD}`;
    const documents = indexer.createUpdateStreams(
      [{ id: poolId }],
      new Map([
        [XOR, { id: XOR, symbol: 'XOR', name: 'SORA', decimals: 18 }],
        [KUSD, { id: KUSD, symbol: 'KUSD', name: 'Kensetsu USD', decimals: 18 }],
      ]),
      new Map([
        [XOR, 5n * SCALE],
        [KUSD, SCALE],
      ]),
      new Map([[poolId, '0.125']]),
      88,
      1_700_000_000
    );
    const byId = new Map(documents.map((document) => [document.id, document]));

    expect(JSON.parse(byId.get('price')?.data.data ?? '{}')).toEqual({
      [XOR]: '5',
      [KUSD]: '1',
    });
    expect(JSON.parse(byId.get('apy')?.data.data ?? '{}')).toEqual({
      [poolId]: '0.125',
    });
    expect(JSON.parse(JSON.parse(byId.get('assetRegistration')?.data.data ?? '{}')[XOR])).toEqual({
      address: XOR,
      name: 'SORA',
      symbol: 'XOR',
      decimals: 18,
    });
    expect([...byId.values()].map((document) => [document.blockHeight, document.timestamp, document.data.block])).toEqual([
      [88, 1_700_000_000, 88],
      [88, 1_700_000_000, 88],
      [88, 1_700_000_000, 88],
    ]);
  });
});

describe('MemoryRepository subscriptions', () => {
  it('emits watched document updates without polling', async () => {
    const repository = new MemoryRepository();
    const watcher = repository.watch?.('assets');
    if (!watcher) throw new Error('watch is not implemented');

    const next = watcher.next();
    await repository.upsert({
      collection: 'assets',
      id: XOR,
      blockHeight: 1,
      timestamp: 1,
      data: { id: XOR, priceUSD: '1' },
    });

    await expect(next).resolves.toMatchObject({ value: { id: XOR } });
    await watcher.return(undefined);
  });
});
