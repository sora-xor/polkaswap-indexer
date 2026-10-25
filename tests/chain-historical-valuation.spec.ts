import { describe, expect, it, vi } from 'vitest';

import { readConfig } from '../src/config.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { SORA_MAINNET_GENESIS_HASH } from '../src/soraIdentity.js';
import { ChainIndexer, summarizeExactPoolLiquidity } from '../src/worker/chain.js';
import { assetHourlyCloseId, directXorPoolEvidence, HOURLY_HISTORY_ASSETS, selectHourlyHistoryTargets } from '../src/worker/hourly-history.js';

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
) => {
  const requestedHash = `0x${height.toString(16).padStart(64, '0')}`;

  return {
    requestedHash,
    signedBlock: {
      block: {
        header: {
          number: { toNumber: () => height },
          hash: { toString: () => requestedHash },
          parentHash: { toString: () => `0x${(height - 1).toString(16).padStart(64, '0')}` },
        },
        extrinsics,
      },
    },
    events,
    timestamp,
  };
};

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

/** Models ValueQuery: missing storage decodes to zero, but its pinned size is zero. */
const poolStorage = (stored: Map<string, string[]>) => Object.assign(
  vi.fn(async (base: string, target: string) => stored.get(`${base}\0${target}`) ?? ['0', '0']),
  { size: vi.fn(async (base: string, target: string) => ({ toString: (): string => stored.has(`${base}\0${target}`) ? '32' : '0' })) },
);

const prepareState = (indexer: ChainIndexer, blockHeight = 9) => {
  (indexer as unknown as { observedGenesisHash: string }).observedGenesisHash =
    SORA_MAINNET_GENESIS_HASH;
  const state = historicalState(blockHeight);
  (indexer as any).observedGenesisHash = SORA_MAINNET_GENESIS_HASH;
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
      volumeUSD: '0',
      swaps: 0,
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
      poolXYK: { reserves: Object.assign(reserves, { size: async (base: string, target: string) => base === XOR && target === KUSD ? 32 : 0 }) },
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
    expect(reserves).toHaveBeenCalledTimes(1);

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
        reserves: poolStorage(new Map([[`${XOR}\0${KUSD}`, [(100n * SCALE).toString(), (400n * SCALE).toString()]]])),
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

  it('removes absent ValueQuery reverse keys without creating duplicate hourly evidence', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as any;
    const state = prepareState(indexer);
    const reserves = poolStorage(new Map([[`${XOR}\0${KUSD}`, ['100', '200']]]));
    indexer.getHistoricalValuationQueryAt = vi.fn(async () => ({ poolXYK: { reserves } }));
    const advance = await indexer.prepareHistoricalValuationAdvance(state, 10, [], [
      eventRecord('poolXYK', 'ReservesChanged', { baseAssetId: XOR, targetAssetId: KUSD }),
    ]);
    expect(reserves.size).toHaveBeenCalledWith(XOR, KUSD);
    expect(reserves.size).toHaveBeenCalledWith(KUSD, XOR);
    expect(reserves).not.toHaveBeenCalledWith(KUSD, XOR);
    expect(advance.pools).toContainEqual({ id: `${KUSD}\0${XOR}`, value: null });
    indexer.applyHistoricalValuationAdvance(state, advance);
    expect(state.pools.size).toBe(1);
    expect(() => selectHourlyHistoryTargets(state.assets, [...state.pools.values()], HOURLY_HISTORY_ASSETS)).not.toThrow();
  });

  it('retains an explicitly stored zero-reserve pool as real direct XOR evidence', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as any;
    const state = prepareState(indexer);
    const reserves = poolStorage(new Map([[`${XOR}\0${KUSD}`, ['0', '0']]]));
    indexer.getHistoricalValuationQueryAt = vi.fn(async () => ({ poolXYK: { reserves } }));
    const advance = await indexer.prepareHistoricalValuationAdvance(state, 10, [], [
      eventRecord('poolXYK', 'ReservesChanged', { baseAssetId: XOR, targetAssetId: KUSD }),
    ]);
    indexer.applyHistoricalValuationAdvance(state, advance);
    expect(state.pools.size).toBe(1);
    expect(directXorPoolEvidence(KUSD, { assets: state.assets, pools: [...state.pools.values()], xorPoolsComplete: true }))
      .toMatchObject({ baseAssetReserves: '0', targetAssetReserves: '0' });
  });

  it('represents reversed remove/recreate and later removal from the same pinned storage presence', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as any;
    const state = prepareState(indexer);
    const stored = new Map([[`${KUSD}\0${XOR}`, ['200', '100']]]);
    const reserves = poolStorage(stored);
    indexer.getHistoricalValuationQueryAt = vi.fn(async () => ({ poolXYK: { reserves } }));
    const events = [eventRecord('poolXYK', 'ReservesChanged', { baseAssetId: XOR, targetAssetId: KUSD })];
    indexer.applyHistoricalValuationAdvance(state, await indexer.prepareHistoricalValuationAdvance(state, 10, [], events));
    expect([...state.pools.keys()]).toEqual([`${KUSD}\0${XOR}`]);
    stored.clear();
    indexer.applyHistoricalValuationAdvance(state, await indexer.prepareHistoricalValuationAdvance(state, 11, [], events));
    expect(state.pools.size).toBe(0);
    stored.set(`${XOR}\0${KUSD}`, ['0', '0']);
    indexer.applyHistoricalValuationAdvance(state, await indexer.prepareHistoricalValuationAdvance(state, 12, [], events));
    expect([...state.pools.keys()]).toEqual([`${XOR}\0${KUSD}`]);
  });

  it.each(['size', 'value'])('fails atomically on a %s query error and retries the same block', async (failure) => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as any;
    const state = prepareState(indexer);
    const original = structuredClone(state);
    const reserves = poolStorage(new Map([[`${XOR}\0${KUSD}`, ['100', '400']]]));
    if (failure === 'size') reserves.size.mockRejectedValueOnce(new Error('pinned size unavailable'));
    else reserves.mockRejectedValueOnce(new Error('pinned value unavailable'));
    indexer.getHistoricalValuationQueryAt = vi.fn(async () => ({ poolXYK: { reserves } }));
    const block = fetchedBlock(10, [], [eventRecord('poolXYK', 'ReservesChanged', { baseAssetId: XOR, targetAssetId: KUSD })]);
    const writes = vi.spyOn(repository, 'upsertMany');
    await expect(indexer.indexFetchedBlock(block, { historicalValuationState: state })).rejects.toThrow(/pinned .* unavailable/);
    expect(state).toEqual(original);
    expect(writes).not.toHaveBeenCalled();
    expect(await repository.get('updatesStreams', 'chainState')).toBeNull();
    await indexer.indexFetchedBlock(block, { historicalValuationState: state });
    expect(state.blockHeight).toBe(10);
    expect(state.pools.size).toBe(1);
    expect((await repository.get('updatesStreams', 'chainState'))?.blockHeight).toBe(10);
  });

  it('requires a pinned presence capability instead of falling back to decoded reserve amounts', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as any;
    const state = prepareState(indexer);
    const reserves = vi.fn(async () => ['0', '0']);
    indexer.getHistoricalValuationQueryAt = vi.fn(async () => ({ poolXYK: { reserves } }));
    await expect(indexer.prepareHistoricalValuationAdvance(state, 10, [], [
      eventRecord('poolXYK', 'ReservesChanged', { baseAssetId: XOR, targetAssetId: KUSD }),
    ])).rejects.toThrow('point and size reads are required');
    expect(reserves).not.toHaveBeenCalled();
    expect(state.blockHeight).toBe(9);
  });

  it.each(['-1', 'NaN', '9007199254740992', ''])('rejects malformed pinned size %j without treating it as absence', async (size) => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as any;
    const state = prepareState(indexer);
    const reserves = poolStorage(new Map());
    reserves.size.mockResolvedValue({ toString: () => size });
    indexer.getHistoricalValuationQueryAt = vi.fn(async () => ({ poolXYK: { reserves } }));
    await expect(indexer.prepareHistoricalValuationAdvance(state, 10, [], [
      eventRecord('poolXYK', 'ReservesChanged', { baseAssetId: XOR, targetAssetId: KUSD }),
    ])).rejects.toThrow('invalid storage size');
    expect(reserves).not.toHaveBeenCalled();
    expect(state.blockHeight).toBe(9);
  });

  it('still rejects genuinely stored duplicate XOR orientations at an hourly boundary', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as any;
    const state = prepareState(indexer);
    const reserves = poolStorage(new Map([[`${XOR}\0${KUSD}`, ['0', '0']], [`${KUSD}\0${XOR}`, ['0', '0']]]));
    indexer.getHistoricalValuationQueryAt = vi.fn(async () => ({ poolXYK: { reserves } }));
    const advance = await indexer.prepareHistoricalValuationAdvance(state, 10, [], [
      eventRecord('poolXYK', 'ReservesChanged', { baseAssetId: XOR, targetAssetId: KUSD }),
    ]);
    indexer.applyHistoricalValuationAdvance(state, advance);
    expect(state.pools.size).toBe(2);
    expect(() => selectHourlyHistoryTargets(state.assets, [...state.pools.values()], HOURLY_HISTORY_ASSETS)).toThrow('Ambiguous direct XOR pool evidence');
  });

  it('retries a failed hour-boundary read and commits the close and checkpoint exactly once', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as any;
    const state = prepareState(indexer);
    indexer.api = { genesisHash: { toString: () => SORA_MAINNET_GENESIS_HASH } };
    indexer.previousHourlyHistoryBlock = { height: 9, hash: `0x${'9'.padStart(64, '0')}`, timestamp: 7198 };
    const reserves = poolStorage(new Map([[`${XOR}\0${KUSD}`, [(100n * SCALE).toString(), (400n * SCALE).toString()]]]));
    indexer.getHistoricalValuationQueryAt = vi.fn(async () => ({
      poolXYK: { reserves }, denomination: { denominator: async () => ({ toString: (): string => '100000000000000000000000000000000000000' }) },
    }));
    const events = [eventRecord('poolXYK', 'ReservesChanged', { baseAssetId: XOR, targetAssetId: KUSD })];
    await indexer.indexFetchedBlock(fetchedBlock(10, [], events, 7199), { historicalValuationState: state, refreshDerivedState: false });
    expect(state.pools.size).toBe(1);
    const closeId = assetHourlyCloseId(KUSD, 7199);
    const block = fetchedBlock(11, [], events, 7201);
    reserves.size.mockRejectedValueOnce(new Error('boundary size unavailable'));
    await expect(indexer.indexFetchedBlock(block, { historicalValuationState: state, refreshDerivedState: false })).rejects.toThrow('boundary size unavailable');
    expect(state.blockHeight).toBe(10);
    expect(indexer.previousHourlyHistoryBlock.height).toBe(10);
    expect((await repository.get('updatesStreams', 'chainState'))?.blockHeight).toBe(10);
    expect(await repository.get('assetSnapshots', closeId)).toBeNull();
    const writes = vi.spyOn(repository, 'upsertMany');
    await indexer.indexFetchedBlock(block, { historicalValuationState: state, refreshDerivedState: false });
    const commits = writes.mock.calls.filter(([documents]) => documents.some(({ id }) => id === 'chainState'));
    expect(commits).toHaveLength(1);
    expect(commits[0]![0].map(({ id }) => id)).toContain(closeId);
    expect((await repository.get('assetSnapshots', closeId))?.data.closeEvidence).toMatchObject({
      xorPool: { baseAssetReserves: (100n * SCALE).toString(), targetAssetReserves: (400n * SCALE).toString() },
    });
    expect((await repository.get('updatesStreams', 'chainState'))?.blockHeight).toBe(11);
    expect(state.pools.size).toBe(1);
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
