import { describe, expect, it, vi } from 'vitest';
import { readConfig } from '../src/config.js';
import { MemoryRepository } from '../src/repository/memory.js';
import type { IndexerDocument } from '../src/repository/types.js';
import { ChainIndexer } from '../src/worker/chain.js';
import {
  assetHourlyCloseId, buildAssetHourlyCloseDocumentsAtBoundary, deriveAssetPrices,
  HOURLY_HISTORY_ASSETS, HOURLY_HISTORY_GENESIS,
  type AssetHourlyCloseInput, type HourlyBoundaryBlock,
} from '../src/worker/hourly-history.js';

const SCALE = 10n ** 18n;
const XOR = HOURLY_HISTORY_ASSETS[0]!.id;
const KUSD = HOURLY_HISTORY_ASSETS[4]!.id;
const LLD = HOURLY_HISTORY_ASSETS[5]!.id;
const before = { height: 100, hash: `0x${'1'.repeat(64)}`, timestamp: 7199 };
const after = { height: 101, hash: `0x${'2'.repeat(64)}`, timestamp: 7201 };

/** Complete immutable public state fixture, without account or wallet data. */
function input(): AssetHourlyCloseInput {
  return {
    before: { ...before }, after: { ...after }, genesisHash: HOURLY_HISTORY_GENESIS,
    denominator: '100000000000000000000000000000000000000',
    assets: new Map(HOURLY_HISTORY_ASSETS.map((asset) => [asset.id, { ...asset, decimals: 18 }])),
    prices: new Map(HOURLY_HISTORY_ASSETS.map((asset) => [asset.id, SCALE])),
  };
}

describe('durable hourly close evidence', () => {
  it('builds all seven canonical observations with exact fractional prices and adjacent finalized proof', () => {
    const source = input();
    source.prices.set(XOR, 1234567890123456789n);
    source.prices.set(LLD, 19n);
    const rows = buildAssetHourlyCloseDocumentsAtBoundary(source);
    expect(rows).toHaveLength(7);
    expect(rows[0]).toMatchObject({
      id: assetHourlyCloseId(XOR, before.timestamp), blockHeight: 101, timestamp: 7199,
      data: { denominator: source.denominator, priceUSD: { close: '1.234567890123456789' },
        closeEvidence: { availability: 'priced', completedAt: 7200, blockHash: before.hash, nextBlockHash: after.hash } },
    });
    expect(rows.find((row) => row.data.assetId === LLD)?.data.priceUSD).toEqual({ close: '0.000000000000000019' });
    expect(rows[0]?.data.supply).toBeUndefined();
    expect(rows[0]?.data.volume).toBeUndefined();
  });

  it('preserves prior flow and OHLC observations while correcting only the verified CLOSE', () => {
    const source = input();
    const id = assetHourlyCloseId(XOR, before.timestamp);
    const previous: IndexerDocument = {
      collection: 'assetSnapshots', id, blockHeight: 102, timestamp: 7150,
      data: { id, assetId: XOR, type: 'HOUR', timestamp: 7150, supply: '987654321',
        mint: '5', burn: '2', volume: { amount: '9', amountUSD: '18' },
        priceUSD: { open: '3', high: '4', low: '2', close: '3.5' } },
    };
    source.previous = new Map([[id, previous]]);
    const saved = buildAssetHourlyCloseDocumentsAtBoundary(source)[0]!;
    expect(saved.blockHeight).toBe(102);
    expect(saved.data).toMatchObject({ supply: '987654321', mint: '5', burn: '2', volume: previous.data.volume,
      priceUSD: { open: '3', high: '4', low: '2', close: '1' }, closeEvidence: { blockHeight: 100 } });
    expect(previous.data.priceUSD).toEqual({ open: '3', high: '4', low: '2', close: '3.5' });
  });

  it('records unavailable metadata and unpriceable pools without fabricating a price', () => {
    const source = input();
    source.assets.delete(LLD);
    source.prices.delete(KUSD);
    source.pools = [{ baseAssetId: XOR, targetAssetId: KUSD, baseAssetReserves: 1n, targetAssetReserves: 2n }];
    const rows = buildAssetHourlyCloseDocumentsAtBoundary(source);
    expect(rows).toHaveLength(7);
    expect(rows.find((row) => row.data.assetId === LLD)?.data).toMatchObject({ priceUSD: { close: null }, closeEvidence: { availability: 'metadata-unavailable', symbol: null, decimals: null } });
    expect(rows.find((row) => row.data.assetId === KUSD)?.data).toMatchObject({ priceUSD: { close: null }, closeEvidence: { availability: 'price-unavailable', marketStatus: 'liquidity-gate-or-route-unavailable', pools: [{ baseAssetReserves: '1', targetAssetReserves: '2' }] } });
    source.pools = [];
    expect(buildAssetHourlyCloseDocumentsAtBoundary(source).find((row) => row.data.assetId === KUSD)?.data.closeEvidence).toMatchObject({ marketStatus: 'no-observed-pool' });
  });

  it('does not manufacture intervening observations after a multi-hour chain halt', () => {
    const source = input();
    source.after.timestamp = 18000;
    const rows = buildAssetHourlyCloseDocumentsAtBoundary(source);
    expect(rows).toHaveLength(7);
    expect(rows.every((row) => row.timestamp === 7199)).toBe(true);
    expect(rows.every((row) => row.id.endsWith('-HOUR-3600'))).toBe(true);
  });

  it.each([
    { genesisHash: `0x${'f'.repeat(64)}` },
    { denominator: '0' },
    { after: { ...after, height: 102 } },
    { after: { ...after, timestamp: 7199 } },
    { before: { ...before, hash: 'not-a-hash' } },
  ])('rejects unsupported or malformed boundary evidence: %o', (change) => {
    expect(() => buildAssetHourlyCloseDocumentsAtBoundary({ ...input(), ...change })).toThrow();
  });

  it('rejects mismatched historical symbols instead of labelling another asset as a major token', () => {
    const source = input();
    source.assets.set(XOR, { id: XOR, symbol: 'OTHER', decimals: 18 });
    expect(() => buildAssetHourlyCloseDocumentsAtBoundary(source)).toThrow('metadata mismatch');
  });

  it('shares the production stable-anchored pricing formula and refuses shallow discovery pools', () => {
    const source = input();
    const pools = [
      { baseAssetId: XOR, targetAssetId: KUSD, baseAssetReserves: 100n * SCALE, targetAssetReserves: 500n * SCALE },
      { baseAssetId: XOR, targetAssetId: LLD, baseAssetReserves: SCALE / 10n, targetAssetReserves: 1000n * SCALE },
    ];
    const evidence = new Map();
    const prices = deriveAssetPrices(source.assets, pools, evidence);
    expect(prices.get(KUSD)).toBe(SCALE);
    expect(prices.get(XOR)).toBe(5n * SCALE);
    expect(prices.has(LLD)).toBe(false);
    expect(evidence.get(KUSD)).toEqual([]);
    expect(evidence.get(XOR)).toEqual([pools[0]]);
    expect(evidence.has(LLD)).toBe(false);
  });
});

/** Exercise the real finalization path with RPC/storage only replaced at their I/O boundaries. */
function collector() {
  const repository = new MemoryRepository();
  const worker = new ChainIndexer({ ...readConfig(), priceStreamRefreshIntervalBlocks: 0 }, repository);
  const internal = worker as unknown as {
    api: unknown;
    previousHourlyHistoryBlock: HourlyBoundaryBlock | null;
    getHistoricalValuationQueryAt: (height: number) => Promise<unknown>;
    prepareHistoricalValuationAdvance: (...args: unknown[]) => Promise<unknown>;
    indexFetchedBlock: (block: unknown, options: unknown) => Promise<void>;
    createAssetDocuments: (...args: unknown[]) => Promise<IndexerDocument[]>;
    retireExpiredChartSnapshotBuckets: (groups: unknown[], height: number, timestamp: number) => Promise<void>;
  };
  internal.api = { genesisHash: { toString: () => HOURLY_HISTORY_GENESIS } };
  internal.previousHourlyHistoryBlock = { ...before };
  internal.getHistoricalValuationQueryAt = vi.fn(async () => ({ denomination: { denominator: async () => ({ toString: () => input().denominator }) } }));
  internal.prepareHistoricalValuationAdvance = vi.fn(async () => ({ blockHeight: after.height, assets: [], pools: [] }));
  const source = input();
  const state = {
    blockHeight: before.height, assets: source.assets, prices: source.prices, pools: new Map(),
    orderBookLiquidityComplete: true,
    networkLiquidityStats: { liquidityUSD: '0', poolLiquidityUSD: '0', orderBookLiquidityUSD: '0', activePools: 0, activeOrderBooks: 0, listedAssets: 7 },
  };
  const block = {
    timestamp: after.timestamp, events: [],
    signedBlock: { block: { header: { number: { toNumber: () => after.height }, hash: { toString: () => after.hash }, parentHash: { toString: () => before.hash } }, extrinsics: [] } },
  };
  return { repository, internal, state, block };
}

describe('finalized-block hourly collection', () => {
  it.each([true, false])('persists a slow-chain hour with its checkpoint when refreshDerivedState is %s', async (refreshDerivedState) => {
    const test = collector();
    await test.internal.indexFetchedBlock(test.block, { historicalValuationState: test.state, refreshDerivedState });
    const snapshots = await test.repository.list('assetSnapshots');
    expect(snapshots).toHaveLength(7);
    expect(snapshots.every((row) => row.timestamp === before.timestamp)).toBe(true);
    expect(test.internal.getHistoricalValuationQueryAt).toHaveBeenCalledWith(before.height);
    expect((await test.repository.get('updatesStreams', 'chainState'))?.blockHeight).toBe(after.height);
    expect(test.internal.previousHourlyHistoryBlock).toEqual(after);
  });

  it('retains actual chart samples and rejects a coalesced projection written after finalization', async () => {
    const test = collector();
    const assets = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'SORA', decimals: 18, supply: 1000n * SCALE }]]);
    const analytics = {
      assets: new Map(), assetDayVolumeUSD: new Map(), assetWeekVolumeUSD: new Map(),
      assetDayOpenPrice: new Map(), assetWeekOpenPrice: new Map(), assetOrderBookLiquidity: new Map(),
    };
    const project = () => test.internal.createAssetDocuments(
      assets, new Map([[XOR, 5n * SCALE]]), new Map(), analytics,
      before.height, before.timestamp, true, input().denominator
    );
    const sampled = await project();
    const id = assetHourlyCloseId(XOR, before.timestamp);
    expect(sampled.find((row) => row.id === id)?.data).toMatchObject({
      priceUSD: { open: '5', high: '5', low: '5', close: '5' }, supply: (1000n * SCALE).toString(),
    });
    await test.repository.upsertMany(sampled);
    const delayed = await project();
    await test.internal.indexFetchedBlock(test.block, { historicalValuationState: test.state });
    const canonical = await test.repository.get('assetSnapshots', id);
    expect(canonical).toMatchObject({ blockHeight: after.height, data: {
      priceUSD: { open: '5', high: '5', low: '5', close: null },
      closeEvidence: { blockHeight: before.height, nextBlockHeight: after.height },
    } });
    await test.repository.upsertMany(delayed);
    expect(await test.repository.get('assetSnapshots', id)).toEqual(canonical);
    expect((await project()).some((row) => row.id === id)).toBe(false);
  });

  it('retains the prior hour and retries without advancing state after an atomic write failure', async () => {
    const test = collector();
    vi.spyOn(test.repository, 'upsertMany').mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(test.internal.indexFetchedBlock(test.block, { historicalValuationState: test.state })).rejects.toThrow('disk unavailable');
    expect(test.internal.previousHourlyHistoryBlock).toEqual(before);
    expect(test.state.blockHeight).toBe(before.height);
    expect(await test.repository.get('updatesStreams', 'chainState')).toBeNull();
    await test.internal.indexFetchedBlock(test.block, { historicalValuationState: test.state });
    expect(await test.repository.list('assetSnapshots')).toHaveLength(7);
  });

  it('does not issue denomination reads or record closes while still inside the same hour', async () => {
    const test = collector();
    test.block.timestamp = 7199;
    await test.internal.indexFetchedBlock(test.block, { historicalValuationState: test.state });
    expect(test.internal.getHistoricalValuationQueryAt).not.toHaveBeenCalled();
    expect(await test.repository.list('assetSnapshots')).toEqual([]);
  });

  it('recovers the prior block timestamp from committed block evidence after restart', async () => {
    const test = collector();
    test.internal.previousHourlyHistoryBlock = null;
    await test.repository.upsert({ collection: 'networkSnapshots', id: 'block-100', blockHeight: 100, timestamp: 7199, data: { type: 'BLOCK', timestamp: 7199 } });
    await test.internal.indexFetchedBlock(test.block, { historicalValuationState: test.state });
    expect(await test.repository.list('assetSnapshots')).toHaveLength(7);
    expect(test.internal.previousHourlyHistoryBlock).toEqual(after);
  });

  it('does not checkpoint past an hour whose exact denomination could not be read', async () => {
    const test = collector();
    test.internal.getHistoricalValuationQueryAt = vi.fn(async () => ({ denomination: { denominator: async () => { throw new Error('archive unavailable'); } } }));
    await expect(test.internal.indexFetchedBlock(test.block, { historicalValuationState: test.state })).rejects.toThrow('exact historical denomination');
    expect(await test.repository.get('updatesStreams', 'chainState')).toBeNull();
    expect(test.internal.previousHourlyHistoryBlock).toEqual(before);
  });

  it('retains major-token HOUR observations while expiring old ordinary chart buckets', async () => {
    const test = collector();
    const rows: IndexerDocument[] = [
      { collection: 'assetSnapshots', id: 'major-hour', timestamp: 1, data: { type: 'HOUR', assetId: XOR, timestamp: 1 } },
      { collection: 'assetSnapshots', id: 'other-hour', timestamp: 1, data: { type: 'HOUR', assetId: 'other', timestamp: 1 } },
      { collection: 'assetSnapshots', id: 'major-default', timestamp: 1, data: { type: 'DEFAULT', assetId: XOR, timestamp: 1 } },
    ];
    await test.repository.upsertMany(rows);
    await test.internal.retireExpiredChartSnapshotBuckets([{ collection: 'assetSnapshots' }], 101, 10_000_000);
    expect((await test.repository.list('assetSnapshots')).map((row) => row.id)).toEqual(['major-hour']);
  });
});
