import { describe, expect, it, vi } from 'vitest';

import { readConfig } from '../src/config.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { ChainIndexer, summarizeExactPoolLiquidity } from '../src/worker/chain.js';

const SCALE = 10n ** 18n;
const XOR = '0x0200000000000000000000000000000000000000000000000000000000000000';
const VAL = '0x0200040000000000000000000000000000000000000000000000000000000000';
const KUSD = '0x02000c0000000000000000000000000000000000000000000000000000000000';

const config = readConfig();

const eventRecord = (
  section: string,
  method: string,
  data: Record<string, unknown>,
  extrinsicIndex = 0
) => ({
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

const transferExtrinsic = (hash: string, amount = SCALE) => ({
  isSigned: true,
  signer: { toString: () => 'alice' },
  hash: { toString: () => hash },
  method: {
    section: 'assets',
    method: 'transfer',
    args: [XOR, 'bob', amount.toString()],
    meta: {
      args: [{ name: 'assetId' }, { name: 'to' }, { name: 'amount' }],
    },
  },
});

const depositExtrinsic = (hash: string) => ({
  isSigned: true,
  signer: { toString: () => 'alice' },
  hash: { toString: () => hash },
  method: {
    section: 'poolXYK',
    method: 'depositLiquidity',
    args: [XOR, KUSD, SCALE.toString(), (2n * SCALE).toString()],
    meta: {
      args: [
        { name: 'baseAssetId' },
        { name: 'targetAssetId' },
        { name: 'baseAssetDesired' },
        { name: 'targetAssetDesired' },
      ],
    },
  },
});

const fetchedBlock = (
  height: number,
  extrinsics: unknown[],
  events: unknown[],
  timestamp = 1_700_000_000 + height
) => ({
  signedBlock: {
    block: {
      header: {
        number: { toNumber: () => height },
        hash: { toString: () => `0xblock-${height}` },
      },
      extrinsics,
    },
  },
  events,
  timestamp,
});

const historicalState = (blockHeight = 9) => ({
  blockHeight,
  assets: new Map([
    [XOR, { id: XOR, symbol: 'XOR', name: 'SORA', decimals: 18, supply: 0n }],
    [VAL, { id: VAL, symbol: 'VAL', name: 'Validator', decimals: 18, supply: 0n }],
    [KUSD, { id: KUSD, symbol: 'KUSD', name: 'Kensetsu USD', decimals: 18, supply: 0n }],
  ]),
  pools: new Map([
    [
      `${XOR}\0${KUSD}`,
      {
        baseAssetId: XOR,
        targetAssetId: KUSD,
        baseAssetReserves: 100n * SCALE,
        targetAssetReserves: 200n * SCALE,
      },
    ],
  ]),
  prices: new Map<string, bigint>(),
  networkLiquidityStats: {
    liquidityUSD: '0',
    poolLiquidityUSD: '0',
    orderBookLiquidityUSD: '0',
    activePools: 0,
    activeOrderBooks: 0,
    listedAssets: 0,
  },
  orderBookLiquidityComplete: false,
});

const prepareState = (indexer: ChainIndexer, blockHeight = 9) => {
  const state = historicalState(blockHeight);
  (indexer as any).recalculateHistoricalValuationState(state);
  return state;
};

describe('historical valuation state', () => {
  it('sums exact pool liquidity before display rounding and counts positive dust pools', () => {
    expect(summarizeExactPoolLiquidity([5_000_000_000n, 5_000_000_000n, 5_000_000_000n, 5_000_000_000n])).toEqual({
      poolLiquidityUSD: '0.00000002',
      activePools: 4,
    });
  });

  it('values history, network flow, and account fees from the N-1 state without mutating globals', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as any;
    const state = prepareState(indexer);
    indexer.prices = new Map([[XOR, 99n * SCALE]]);
    indexer.assetInfos = state.assets;

    await indexer.indexFetchedBlock(
      fetchedBlock(
        10,
        [transferExtrinsic('0xhistorical-transfer')],
        [
          eventRecord('assets', 'Transfer', { assetId: XOR, from: 'alice', to: 'bob', amount: SCALE.toString() }),
          eventRecord('xorFee', 'FeeWithdrawn', { amount: SCALE.toString() }),
        ]
      ),
      { historicalValuationState: state }
    );

    const history = await repository.get('historyElements', '0xhistorical-transfer');
    const network = await repository.get('networkSnapshots', 'block-10');
    const account = await repository.get('accountMeta', 'alice');
    expect(history?.data.data).toMatchObject({ amountUSD: '2' });
    expect(network?.data).toMatchObject({
      volumeUSD: '2',
      poolLiquidityUSD: '400',
      liquidityUSD: null,
      orderBookLiquidityUSD: null,
      activeOrderBooks: null,
    });
    expect(account?.data.xorFees).toEqual({ amount: '1', amountUSD: '2' });
    expect(indexer.prices.get(XOR)).toBe(99n * SCALE);
    expect(state.blockHeight).toBe(10);
  });

  it('uses pre-state for a price-changing block, advances after commit, and uses post-state next', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as any;
    const state = prepareState(indexer);
    let activeReads = 0;
    let maximumActiveReads = 0;
    const reserves = vi.fn(async (base: string, target: string) => {
      activeReads += 1;
      maximumActiveReads = Math.max(maximumActiveReads, activeReads);
      await Promise.resolve();
      activeReads -= 1;
      return base === XOR && target === KUSD
        ? [(100n * SCALE).toString(), (400n * SCALE).toString()]
        : { isNone: true };
    });
    indexer.getHistoricalValuationQueryAt = vi.fn(async () => ({
      assets: {},
      poolXYK: { reserves },
    }));

    await indexer.indexFetchedBlock(
      fetchedBlock(
        10,
        [depositExtrinsic('0xprice-change')],
        [eventRecord('poolXYK', 'ReservesChanged', { baseAssetId: XOR, targetAssetId: KUSD })]
      ),
      { historicalValuationState: state }
    );

    expect((await repository.get('historyElements', '0xprice-change'))?.data.data).toMatchObject({
      baseAssetAmountUSD: '2',
    });
    expect((await repository.get('networkSnapshots', 'block-10'))?.data.poolLiquidityUSD).toBe('400');
    expect(state.blockHeight).toBe(10);
    expect(state.prices.get(XOR)).toBe(4n * SCALE);
    expect(maximumActiveReads).toBe(1);
    expect(reserves).toHaveBeenCalledTimes(2);

    await indexer.indexFetchedBlock(
      fetchedBlock(
        11,
        [transferExtrinsic('0xpost-price-transfer')],
        [eventRecord('assets', 'Transfer', { assetId: XOR, from: 'alice', to: 'bob', amount: SCALE.toString() })]
      ),
      { historicalValuationState: state }
    );

    expect((await repository.get('historyElements', '0xpost-price-transfer'))?.data.data).toMatchObject({
      amountUSD: '4',
    });
    expect((await repository.get('networkSnapshots', 'block-11'))?.data).toMatchObject({
      poolLiquidityUSD: '800',
      liquidityUSD: null,
      orderBookLiquidityUSD: null,
    });
    expect(indexer.getHistoricalValuationQueryAt).toHaveBeenCalledTimes(1);
  });

  it('does not advance state or checkpoint when the atomic block write fails', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as any;
    const state = prepareState(indexer);
    indexer.getHistoricalValuationQueryAt = vi.fn(async () => ({
      assets: {},
      poolXYK: {
        reserves: async (base: string, target: string) =>
          base === XOR && target === KUSD
            ? [(100n * SCALE).toString(), (400n * SCALE).toString()]
            : { isNone: true },
      },
    }));
    vi.spyOn(repository, 'upsertMany').mockRejectedValueOnce(new Error('atomic write failed'));

    await expect(
      indexer.indexFetchedBlock(
        fetchedBlock(
          10,
          [depositExtrinsic('0xfailed-price-change')],
          [eventRecord('poolXYK', 'ReservesChanged', { baseAssetId: XOR, targetAssetId: KUSD })]
        ),
        { historicalValuationState: state }
      )
    ).rejects.toThrow('atomic write failed');

    expect(state.blockHeight).toBe(9);
    expect(state.prices.get(XOR)).toBe(2n * SCALE);
    expect(await repository.get('updatesStreams', 'chainState')).toBeNull();
  });

  it('collects every event and nested-call pool touch, probes reverse keys, and invalidates ambiguity', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as any;
    const state = prepareState(indexer);
    state.pools.set(`${VAL}\0${KUSD}`, {
      baseAssetId: VAL,
      targetAssetId: KUSD,
      baseAssetReserves: 100n * SCALE,
      targetAssetReserves: 100n * SCALE,
    });
    const contexts = [
      {
        failed: false,
        module: 'utility',
        method: 'batch',
        history: { data: {} },
        calls: [
          { module: 'poolXYK', method: 'exchange', data: { args: { arg1: VAL, arg2: KUSD } } },
        ],
      },
    ];
    const touches = indexer.collectHistoricalValuationTouches(
      state,
      contexts,
      [eventRecord('poolXYK', 'ReservesChanged', { baseAssetId: XOR, targetAssetId: KUSD })]
    );

    expect([...touches.pools.keys()].sort()).toEqual(
      [
        `${XOR}\0${KUSD}`,
        `${KUSD}\0${XOR}`,
        `${VAL}\0${KUSD}`,
        `${KUSD}\0${VAL}`,
      ].sort()
    );
    expect(touches.invalidated).toBe(false);

    const ambiguous = indexer.collectHistoricalValuationTouches(
      state,
      [
        {
          failed: false,
          module: 'poolXYK',
          method: 'exchange',
          history: { data: { arg1: (100n * SCALE).toString(), arg2: KUSD } },
          calls: [],
        },
      ],
      []
    );
    expect(ambiguous.invalidated).toBe(true);
    expect(ambiguous.pools.size).toBe(0);
  });

  it('uses the archive API for historical state and fails closed on missing archive capabilities', async () => {
    const primaryGetBlockHash = vi.fn();
    const archiveGetBlockHash = vi.fn(async (): Promise<{ toString(): string }> => ({
      toString: (): string => '0xarchive-9',
    }));
    const archiveAt = vi.fn(async () => ({ query: { archive: true } }));
    const indexer = new ChainIndexer(
      { ...config, archiveSoraWsEndpoint: 'wss://archive.example' },
      new MemoryRepository()
    ) as any;
    indexer.api = { rpc: { chain: { getBlockHash: primaryGetBlockHash } } };
    indexer.legacyBlockApi = {
      rpc: { chain: { getBlockHash: archiveGetBlockHash } },
      at: archiveAt,
    };

    await expect(indexer.getHistoricalValuationQueryAt(9)).resolves.toEqual({ archive: true });
    expect(primaryGetBlockHash).not.toHaveBeenCalled();
    expect(archiveGetBlockHash).toHaveBeenCalledWith(9);
    expect(archiveAt).toHaveBeenCalledWith('0xarchive-9');

    indexer.legacyBlockApi = { rpc: { chain: { getBlockHash: archiveGetBlockHash } } };
    await expect(indexer.getHistoricalValuationQueryAt(9)).rejects.toThrow('api.at is required');
    indexer.legacyBlockApi = { rpc: { chain: {} }, at: archiveAt };
    await expect(indexer.getHistoricalValuationQueryAt(9)).rejects.toThrow(
      'chain.getBlockHash is required'
    );
  });

  it('requires paged historical storage and enforces one combined retained-byte ceiling', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(
      { ...config, derivedStorageLoadMaxBytes: 512 },
      repository
    ) as any;
    indexer.api = {
      rpc: { chain: { getBlockHash: async () => ({ toString: () => '0xhistorical-9' }) } },
      at: async () => ({
        query: {
          assets: {
            assetInfosV2: {
              entriesPaged: async () => [
                [
                  { args: [XOR] },
                  {
                    toHuman: () => ({ symbol: 'X'.repeat(2_000), name: 'SORA', precision: 18 }),
                  },
                ],
              ],
            },
          },
          poolXYK: { reserves: { entriesPaged: async () => [] } },
        },
      }),
    };

    await expect(indexer.initializeHistoricalValuationState(10)).rejects.toThrow(/retained-load limit/);
    expect(await repository.get('updatesStreams', 'chainState')).toBeNull();

    indexer.api.at = async () => ({
      query: {
        assets: { assetInfosV2: {} },
        poolXYK: { reserves: { entriesPaged: async () => [] } },
      },
    });
    await expect(indexer.initializeHistoricalValuationState(10)).rejects.toThrow(
      'assets.assetInfosV2.entriesPaged is required'
    );
  });

  it('applies prefetched blocks in height order through one sequential valuation state', async () => {
    const indexer = new ChainIndexer(
      { ...config, chainStartBlock: 1, backfillPrefetchConcurrency: 3 },
      new MemoryRepository()
    ) as any;
    const state = historicalState(0);
    indexer.api = {};
    indexer.getIndexableFinalizedBlock = vi.fn(async () => 3);
    indexer.getLastIndexedBlock = vi.fn(async () => 0);
    indexer.initializeNetworkBackfillWindows = vi.fn(async () => []);
    indexer.initializeHistoricalValuationState = vi.fn(async () => state);
    indexer.fetchBlockByNumber = vi.fn(async (height: number) =>
      fetchedBlock(height, [], [], 1_700_000_000 + height)
    );
    const preStateHeights: number[] = [];
    indexer.indexFetchedBlock = vi.fn(async (block: any, options: any) => {
      const height = block.signedBlock.block.header.number.toNumber();
      preStateHeights.push(options.historicalValuationState.blockHeight);
      expect(options.historicalValuationState).toBe(state);
      expect(options.historicalValuationState.blockHeight).toBe(height - 1);
      options.historicalValuationState.blockHeight = height;
    });

    await expect(indexer.backfill()).resolves.toBe(true);
    expect(preStateHeights).toEqual([0, 1, 2]);
    expect(state.blockHeight).toBe(3);
  });
});
