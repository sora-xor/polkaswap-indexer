import { describe, expect, it, vi } from 'vitest';
import { readConfig } from '../src/config.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { ChainIndexer } from '../src/worker/chain.js';

const XOR = '0x0200000000000000000000000000000000000000000000000000000000000000';
const KUSD = '0x02000c0000000000000000000000000000000000000000000000000000000000';
const SCALE = 10n ** 18n;
const entry = (args: unknown[], value: unknown) => [{ args }, value];
const storage = (rows: unknown[] = []) => ({ entriesPaged: vi.fn(async () => rows) });

function fixture() {
  const repository = new MemoryRepository();
  // Exercise the complete projection against a recording chain storage boundary
  // and the real repository; no worker loops or external RPC are started.
  const indexer: any = new ChainIndexer({ ...readConfig(), snapshotRetentionMode: 'all', fullReconciliationIntervalBlocks: 10 }, repository);
  const query: any = {
    assets: { assetInfosV2: storage([
      entry([XOR], { symbol: 'XOR', name: 'SORA', precision: 18 }),
      entry([KUSD], { symbol: 'KUSD', name: 'Kensetsu USD', precision: 18 }),
    ]) },
    tokens: { totalIssuance: storage([entry([KUSD], String(1000n * SCALE))]) },
    balances: { totalIssuance: vi.fn(async () => String(2000n * SCALE)) },
    poolXYK: {
      properties: storage([entry([XOR, KUSD], ['pool-account', 'fees-account'])]),
      reserves: storage([entry([XOR, KUSD], [String(100n * SCALE), String(200n * SCALE)])]),
      totalIssuances: storage([entry(['pool-account'], String(10n * SCALE))]), poolProviders: storage(),
    },
    orderBook: { orderBooks: storage(), bids: storage(), asks: storage(), limitOrders: storage() },
    staking: { nominators: storage(), validators: storage(), currentEra: vi.fn(async () => 0), erasValidatorReward: storage() },
    referrals: { referrers: storage() }, kensetsu: { cdpDepository: storage() }, farming: { poolFarmers: storage() },
    polkamarkt: Object.fromEntries(['conditions', 'conditionDetails', 'markets', 'marketDpmCollateral', 'marketVolume', 'marketPositionTotals', 'marketResolution', 'marketResolutionEvidence', 'marketCancellationEvidence', 'marketPositions', 'dpmCostBasis', 'dpmCostBasisTotals', 'marketCreatorFees'].map(name => [name, storage()])),
  };
  indexer.api = { query, consts: { staking: { maxNominatorRewardedPerValidator: { toNumber: () => 256 } } } };
  return { indexer, repository, query };
}

describe('complete chain projection refresh', () => {
  it('publishes authoritative asset supplies, pool reserves, and live valuation together', async () => {
    const { indexer, repository, query } = fixture();
    await indexer.refreshDerivedStateInternal(query, 100, 1_700_000_000, false);
    expect((await repository.get('assets', XOR))?.data).toMatchObject({ supply: String(2000n * SCALE), priceUSD: '2', liquidity: String(100n * SCALE) });
    expect(indexer.assetInfos.get(XOR)).toMatchObject({ symbol: 'XOR', name: 'SORA' });
    expect(indexer.assetInfos.get(XOR).supply).toBe(2000n * SCALE);
    expect(indexer.assetInfos.get(KUSD).supply).toBe(1000n * SCALE);
    const pool = await repository.get('poolXYKs', `${XOR}-${KUSD}`);
    expect(pool?.blockHeight).toBe(100);
    expect(pool?.data).toMatchObject({ baseAssetId: XOR, targetAssetId: KUSD });
    expect(indexer.liveValuationState.blockHeight).toBe(100);
    expect([...indexer.liveValuationState.pools.values()]).toEqual([{ baseAssetId: XOR, targetAssetId: KUSD, baseAssetReserves: 100n * SCALE, targetAssetReserves: 200n * SCALE }]);
    expect(indexer.lastDerivedStorageReconciliationBlock).toBe(100);
    expect(await repository.list('assetSnapshots')).toEqual([]);
  });

  it('emits snapshots only when requested and reuses clean cached storage', async () => {
    const { indexer, repository, query } = fixture();
    await indexer.refreshDerivedStateInternal(query, 100, 1_700_000_000, true);
    expect((await repository.list('assetSnapshots')).length).toBeGreaterThan(0);
    expect((await repository.list('poolSnapshots')).length).toBeGreaterThan(0);
    expect((await repository.list('networkSnapshots')).length).toBeGreaterThan(0);
    await indexer.refreshDerivedStateInternal(query, 101, 1_700_000_006, false);
    expect(query.assets.assetInfosV2.entriesPaged).toHaveBeenCalledOnce();
    expect(query.poolXYK.poolProviders.entriesPaged).toHaveBeenCalledOnce();
    expect(indexer.liveValuationState.blockHeight).toBe(101);
  });

  it('removes stale authoritative rows but retains newer rows', async () => {
    const { indexer, repository, query } = fixture();
    await repository.upsertMany([
      { collection: 'assets', id: 'stale', blockHeight: 10, timestamp: 20, data: { id: 'stale' } },
      { collection: 'assets', id: 'newer', blockHeight: 101, timestamp: 20, data: { id: 'newer' } },
    ]);
    await indexer.refreshDerivedStateInternal(query, 100, 1_700_000_000, false, true);
    expect(await repository.get('assets', 'stale')).toBeNull();
    expect(await repository.get('assets', 'newer')).not.toBeNull();
  });

  it('fails before publication when a required storage domain is unavailable', async () => {
    const { indexer, repository, query } = fixture();
    query.poolXYK.reserves.entriesPaged.mockRejectedValue(new Error('RPC failed'));
    await expect(indexer.refreshDerivedStateInternal(query, 100, 1_700_000_000, false)).rejects.toThrow('RPC failed');
    expect(await repository.list('assets')).toEqual([]);
    expect(indexer.lastDerivedStorageReconciliationBlock).toBeNull();
  });

  it.each(['refreshDerivedStateInternal', 'refreshPolkamarktStateInternal', 'refreshPriceStreamInternal'])('rejects %s before API initialization', async method => {
    const { indexer, query } = fixture(); indexer.api = null;
    await expect(indexer[method](query, 100, 1_700_000_000, false)).rejects.toThrow('before the chain API is initialized');
  });

  it('refreshes price streams from pool reserves and never lets an older block overwrite them', async () => {
    const { indexer, query, repository } = fixture();
    await indexer.refreshPriceStreamInternal(query, 100, 1_700_000_000);
    const first = await repository.list('updatesStreams');
    expect(first).toHaveLength(1); expect(first[0]?.blockHeight).toBe(100);
    expect(indexer.prices.get(XOR)).toBe(2n * SCALE);
    await indexer.refreshPriceStreamInternal(query, 99, 1_699_999_999);
    expect(await repository.list('updatesStreams')).toEqual(first);
    expect(query.poolXYK.reserves.entriesPaged).toHaveBeenCalledOnce();
  });

  it('reconciles empty authoritative Polkamarkt collections and retains later publications', async () => {
    const { indexer, query, repository } = fixture();
    await repository.upsertMany([
      { collection: 'markets', id: 'old', blockHeight: 10, timestamp: 20, data: { id: 'old' } },
      { collection: 'accountPositions', id: 'new', blockHeight: 101, timestamp: 20, data: { id: 'new' } },
    ]);
    await indexer.refreshPolkamarktStateInternal(query, 100, 1_700_000_000, true);
    expect(await repository.get('markets', 'old')).toBeNull();
    expect(await repository.get('accountPositions', 'new')).not.toBeNull();
    expect(indexer.assetInfos.get(XOR).supply).toBe(2000n * SCALE);
  });

  it('preserves Polkamarkt collections when the runtime lacks their storage APIs', async () => {
    const { indexer, query, repository } = fixture(); delete query.polkamarkt;
    const document = { collection: 'markets' as const, id: 'retained', blockHeight: 10, timestamp: 20, data: { id: 'retained' } };
    await repository.upsert(document);
    await indexer.refreshPolkamarktStateInternal(query, 100, 1_700_000_000, false);
    expect(await repository.get('markets', 'retained')).toEqual(document);
  });

  it('refreshes metadata only when reconciliation is due or its domain becomes dirty', async () => {
    const { indexer, query } = fixture();
    await indexer.refreshDerivedStateInternal(query, 100, 1_700_000_000, false);
    await indexer.refreshDerivedStateInternal(query, 101, 1_700_000_006, false);
    indexer.markDerivedStorageDomainsDirty(['assetMetadata']);
    await indexer.refreshDerivedStateInternal(query, 102, 1_700_000_012, false);
    expect(query.assets.assetInfosV2.entriesPaged).toHaveBeenCalledTimes(2);
    expect(query.poolXYK.reserves.entriesPaged).toHaveBeenCalledOnce();
    await indexer.refreshDerivedStateInternal(query, 110, 1_700_000_060, false);
    expect(query.assets.assetInfosV2.entriesPaged).toHaveBeenCalledTimes(3);
    expect(query.poolXYK.reserves.entriesPaged).toHaveBeenCalledTimes(2);
  });

  it('copies live valuation containers and refuses to replace newer or more complete state', () => {
    const { indexer } = fixture();
    const assets = new Map([[XOR, { id: XOR, decimals: 18 }]]); const prices = new Map([[XOR, SCALE]]);
    const pools = [{ baseAssetId: XOR, targetAssetId: KUSD, baseAssetReserves: 10n, targetAssetReserves: 20n }];
    const stats = { poolLiquidityUSD: '12', orderBookLiquidityUSD: '0', activePools: 1 };
    expect(indexer.publishLiveValuationState(100, assets, pools, prices, stats)).toBe(true);
    assets.clear(); prices.clear(); pools[0]!.baseAssetReserves = 0n; stats.poolLiquidityUSD = '999';
    expect(indexer.liveValuationState.assets.size).toBe(1); expect(indexer.liveValuationState.prices.get(XOR)).toBe(SCALE);
    expect([...indexer.liveValuationState.pools.values()]).toEqual([{ baseAssetId: XOR, targetAssetId: KUSD, baseAssetReserves: 10n, targetAssetReserves: 20n }]);
    expect(indexer.liveValuationState.networkLiquidityStats.poolLiquidityUSD).toBe('12');
    expect(indexer.publishLiveValuationState(99, assets, [], prices, stats)).toBe(false);
    const saved = indexer.liveValuationState;
    indexer.promoteLiveValuationState({ ...saved, blockHeight: 99 }); expect(indexer.liveValuationState).toBe(saved);
    indexer.promoteLiveValuationState({ ...saved, orderBookLiquidityComplete: false }); expect(indexer.liveValuationState).toBe(saved);
  });

  it('loads the exact preceding valuation block once and clamps genesis to zero', async () => {
    const { indexer } = fixture();
    indexer.loadHistoricalValuationBaseline = vi.fn(async (blockHeight: number) => ({ blockHeight }));
    expect((await indexer.ensureLiveValuationState(101)).blockHeight).toBe(100);
    expect((await indexer.ensureLiveValuationState(101)).blockHeight).toBe(100);
    expect(indexer.loadHistoricalValuationBaseline).toHaveBeenCalledExactlyOnceWith(100, 'live-resume');
    await indexer.ensureLiveValuationState(0);
    expect(indexer.loadHistoricalValuationBaseline).toHaveBeenLastCalledWith(0, 'live-resume');
  });
});
