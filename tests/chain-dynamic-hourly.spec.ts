import { describe, expect, it, vi } from 'vitest';
import { readConfig } from '../src/config.js';
import { MemoryRepository } from '../src/repository/memory.js';
import type { IndexerDocument } from '../src/repository/types.js';
import { ChainIndexer } from '../src/worker/chain.js';
import {
  assetHourlyCloseId, buildAssetHourlyCloseDocumentsAtBoundary,
  HOURLY_HISTORY_ASSETS, HOURLY_HISTORY_GENESIS,
  type HourlyHistoryTarget,
} from '../src/worker/hourly-history.js';

const SCALE = 10n ** 18n;
const XOR = HOURLY_HISTORY_ASSETS[0]!.id;
const EXTRA = { id: `0x${'a'.repeat(64)}`, symbol: 'EXTRA' };
const ADDED = { id: `0x${'b'.repeat(64)}`, symbol: 'ADDED' };
const CATALOGUE = 'hourlyHistoryTargets-v1';
const before = { height: 100, hash: `0x${'1'.repeat(64)}`, timestamp: 7199 };
const after = { height: 101, hash: `0x${'2'.repeat(64)}`, timestamp: 7201 };
const denominator = '100000000000000000000000000000000000000';

function registry(targets: readonly HourlyHistoryTarget[], blockHeight = 99): IndexerDocument {
  return { collection: 'updatesStreams', id: CATALOGUE, blockHeight, timestamp: 7199,
    data: { id: CATALOGUE, targets: [...targets] } };
}

/** Actual finalized-boundary worker path with only chain I/O replaced. */
function worker() {
  const repository = new MemoryRepository();
  const instance = new ChainIndexer({ ...readConfig(), snapshotRetentionMode: 'rolling', priceStreamRefreshIntervalBlocks: 0 }, repository);
  const internal = instance as unknown as {
    api: unknown; observedGenesisHash: string;
    previousHourlyHistoryBlock: typeof before | null; hourlyHistoryTargets: HourlyHistoryTarget[];
    getHistoricalValuationQueryAt: (height: number) => Promise<unknown>;
    prepareHistoricalValuationAdvance: (...args: unknown[]) => Promise<unknown>;
    indexFetchedBlock: (block: unknown, options: unknown) => Promise<void>;
    createAssetDocuments: (...args: unknown[]) => Promise<IndexerDocument[]>;
    cleanupAssetSnapshotPriceOutliers: () => Promise<boolean>;
    deleteExpiredSnapshotPages: (collection: 'assetSnapshots', type: 'HOUR' | 'DEFAULT', cutoff: number, maximumPages: number) => Promise<{ documents: number; pages: number; exhausted: boolean }>;
  };
  internal.api = { genesisHash: { toString: () => HOURLY_HISTORY_GENESIS } };
  internal.observedGenesisHash = HOURLY_HISTORY_GENESIS;
  internal.previousHourlyHistoryBlock = { ...before };
  internal.getHistoricalValuationQueryAt = vi.fn(async () => ({ denomination: { denominator: async () => ({ toString: (): string => denominator }) } }));
  internal.prepareHistoricalValuationAdvance = vi.fn(async () => ({ blockHeight: after.height, assets: [], pools: [] }));
  const assets = new Map([...HOURLY_HISTORY_ASSETS, EXTRA, ADDED].map((asset) => [asset.id, { ...asset, decimals: 18, name: asset.symbol, supply: SCALE }]));
  const pool = { id: 'extra-pool', baseAssetId: XOR, targetAssetId: EXTRA.id, baseAssetReserves: 2n * SCALE, targetAssetReserves: SCALE };
  const state = { blockHeight: before.height, assets, prices: new Map(), pools: new Map([[pool.id, pool]]), orderBookLiquidityComplete: true,
    networkLiquidityStats: { liquidityUSD: '0', poolLiquidityUSD: '0', orderBookLiquidityUSD: '0', activePools: 1, activeOrderBooks: 0, listedAssets: assets.size } };
  const block = { requestedHash: after.hash, timestamp: after.timestamp, events: [],
    signedBlock: { block: { header: { number: { toNumber: () => after.height }, hash: { toString: () => after.hash }, parentHash: { toString: () => before.hash } }, extrinsics: [] } } };
  const index = () => internal.indexFetchedBlock(block, { historicalValuationState: state, refreshDerivedState: false });
  return { repository, instance, internal, state, block, index };
}

function close(timestamp = before.timestamp, price = '1'): IndexerDocument {
  return buildAssetHourlyCloseDocumentsAtBoundary({
    before: { ...before, timestamp }, after: { ...after, timestamp: (Math.floor(timestamp / 3600) + 1) * 3600 + 1 },
    genesisHash: HOURLY_HISTORY_GENESIS, denominator,
    assets: new Map([HOURLY_HISTORY_ASSETS[0]!, EXTRA].map((asset) => [asset.id, { ...asset, decimals: 18 }])),
    prices: new Map([[EXTRA.id, BigInt(price) * SCALE]]), pools: [], xorPoolsComplete: true, targets: [EXTRA],
  })[0]!;
}

describe('dynamic hourly worker catalogue and finalized proof protection', () => {
  it('commits a newly eligible non-seven close, catalogue and checkpoint in one batch', async () => {
    const test = worker();
    const writes = vi.spyOn(test.repository, 'upsertMany');
    const previous = vi.spyOn(test.repository, 'getMany');
    await test.index();
    const batch = writes.mock.calls.at(-1)![0];
    expect(batch.map(({ id }) => id)).toEqual(expect.arrayContaining([CATALOGUE, 'chainState', assetHourlyCloseId(EXTRA.id, before.timestamp)]));
    expect(previous).toHaveBeenCalledWith('assetSnapshots', expect.arrayContaining([assetHourlyCloseId(EXTRA.id, before.timestamp)]));
    const targets = (await test.repository.get('updatesStreams', CATALOGUE))!.data.targets;
    expect(targets).toHaveLength(8);
    expect(targets).toContainEqual(EXTRA);
    expect(test.internal.hourlyHistoryTargets).toEqual(targets);
    expect((await test.repository.get('assetSnapshots', assetHourlyCloseId(EXTRA.id, before.timestamp)))!.data.closeEvidence).toMatchObject({ kind: 'finalized-hour-close', requestedSymbol: EXTRA.symbol,
      xorPool: { baseAssetReserves: (2n * SCALE).toString(), targetAssetReserves: SCALE.toString() } });
  });

  it('never advances the catalogue, historical state or checkpoint when the atomic write fails', async () => {
    const test = worker();
    const initial = structuredClone(test.internal.hourlyHistoryTargets);
    vi.spyOn(test.repository, 'upsertMany').mockRejectedValueOnce(new Error('atomic disk failure'));
    await expect(test.index()).rejects.toThrow('atomic disk failure');
    expect(test.internal.hourlyHistoryTargets).toEqual(initial);
    expect(test.internal.previousHourlyHistoryBlock).toEqual(before);
    expect(test.state.blockHeight).toBe(before.height);
    expect(await test.repository.get('updatesStreams', CATALOGUE)).toBeNull();
    expect(await test.repository.get('updatesStreams', 'chainState')).toBeNull();
    expect(await test.repository.list('assetSnapshots')).toEqual([]);
    await test.index();
    expect(test.internal.hourlyHistoryTargets).toContainEqual(EXTRA);
    expect(await test.repository.list('assetSnapshots')).toHaveLength(8);
  });

  it('reloads imported targets and preserves their higher catalogue write version during catchup', async () => {
    const test = worker();
    await test.repository.upsert(registry([...HOURLY_HISTORY_ASSETS, EXTRA], 500));
    test.state.pools.clear();
    test.state.pools.set('added-pool', { id: 'added-pool', baseAssetId: XOR, targetAssetId: ADDED.id, baseAssetReserves: 3n * SCALE, targetAssetReserves: SCALE });
    await test.index();
    const stored = (await test.repository.get('updatesStreams', CATALOGUE))!;
    expect(stored.blockHeight).toBe(500);
    expect(stored.data.targets).toContainEqual(EXTRA);
    expect(stored.data.targets).toContainEqual(ADDED);
    expect(await test.repository.list('assetSnapshots')).toHaveLength(9);
    expect((await test.repository.get('assetSnapshots', assetHourlyCloseId(EXTRA.id, before.timestamp)))!.data.closeEvidence).toHaveProperty('xorPool', null);
    expect(test.internal.hourlyHistoryTargets).toEqual(stored.data.targets);
  });

  it.each([
    { id: 'wrong-id', targets: [...HOURLY_HISTORY_ASSETS] },
    { id: CATALOGUE, targets: [EXTRA, EXTRA] },
    { id: CATALOGUE, targets: [{ ...HOURLY_HISTORY_ASSETS[0]!, symbol: 'WRONG' }] },
    { id: CATALOGUE, targets: [] },
  ])('fails closed before a checkpoint or destructive cleanup for malformed persisted catalogue %j', async (data) => {
    const test = worker();
    const original = test.repository.get.bind(test.repository);
    vi.spyOn(test.repository, 'get').mockImplementation(async (collection, id) =>
      collection === 'updatesStreams' && id === CATALOGUE
        ? { ...registry([]), data }
        : original(collection, id));
    await expect(test.index()).rejects.toThrow(/hourly history target/);
    expect(await test.repository.get('updatesStreams', 'chainState')).toBeNull();
    const remove = vi.spyOn(test.repository, 'deleteMany');
    await expect(test.internal.deleteExpiredSnapshotPages('assetSnapshots', 'HOUR', 10_000_000, 1)).rejects.toThrow(/hourly history target/);
    expect(remove).not.toHaveBeenCalled();
  });

  it.each([null, undefined, -1, Number.NaN])('rejects malformed catalogue write version %s before indexing or retention', async (blockHeight) => {
    const test = worker();
    const original = test.repository.get.bind(test.repository);
    vi.spyOn(test.repository, 'get').mockImplementation(async (collection, id) =>
      collection === 'updatesStreams' && id === CATALOGUE
        ? { ...registry([...HOURLY_HISTORY_ASSETS]), blockHeight }
        : original(collection, id));
    const writes = vi.spyOn(test.repository, 'upsertMany');
    const remove = vi.spyOn(test.repository, 'deleteMany');
    await expect(test.index()).rejects.toThrow('Malformed persisted hourly history target catalogue');
    await expect(test.internal.deleteExpiredSnapshotPages('assetSnapshots', 'HOUR', 10_000_000, 1)).rejects.toThrow('Malformed persisted hourly history target catalogue');
    expect(writes).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(await test.repository.get('updatesStreams', 'chainState')).toBeNull();
  });

  it('protects a non-seven finalized close from later projections while retaining ordinary chart samples', async () => {
    const test = worker();
    const proof = close();
    await test.repository.upsert(proof);
    const analytics = { assets: new Map(), assetDayVolumeUSD: new Map(), assetWeekVolumeUSD: new Map(), assetDayOpenPrice: new Map(), assetWeekOpenPrice: new Map(), assetOrderBookLiquidity: new Map() };
    const documents = await test.internal.createAssetDocuments(new Map([[EXTRA.id, test.state.assets.get(EXTRA.id)!]]), new Map([[EXTRA.id, 9n * SCALE]]), new Map(), analytics,
      after.height + 10, before.timestamp, true, denominator);
    expect(documents.some(({ id }) => id === proof.id)).toBe(false);
    expect(documents.some((row) => row.collection === 'assetSnapshots' && row.data.type === 'DEFAULT')).toBe(true);
    await test.repository.upsertMany(documents);
    expect(await test.repository.get('assetSnapshots', proof.id)).toEqual(proof);
  });

  it('preserves finalized non-seven outlier evidence and still removes equivalent legacy zero-volume outliers', async () => {
    const test = worker();
    const proof = close(7199, '1000');
    proof.data.priceUSD = { open: '1000', high: '1000', low: '1000', close: '1000' };
    const legacy: IndexerDocument = { ...proof, id: 'legacy-outlier', timestamp: 7200, data: { ...proof.data, id: 'legacy-outlier', timestamp: 7200 } };
    delete legacy.data.closeEvidence;
    const neighbors: IndexerDocument[] = Array.from({ length: 5 }, (_, index) => ({ collection: 'assetSnapshots', id: `neighbor-${index}`, timestamp: 7100 + index,
      data: { id: `neighbor-${index}`, assetId: EXTRA.id, type: 'HOUR', timestamp: 7100 + index, priceUSD: { open: '1', high: '1', low: '1', close: '1' } } }));
    await test.repository.upsertMany([proof, legacy, ...neighbors]);
    expect(await test.internal.cleanupAssetSnapshotPriceOutliers()).toBe(true);
    expect(await test.repository.get('assetSnapshots', proof.id)).toEqual(proof);
    expect(await test.repository.get('assetSnapshots', legacy.id)).toBeNull();
  });

  it('retains imported and dropped target hours plus unregistered proof provenance while expiring legacy buckets', async () => {
    const test = worker();
    await test.repository.upsert(registry([...HOURLY_HISTORY_ASSETS, ADDED]));
    const proof = close();
    const rows: IndexerDocument[] = [proof,
      { collection: 'assetSnapshots', id: 'imported-hour', timestamp: 1, data: { id: 'imported-hour', assetId: ADDED.id, type: 'HOUR', timestamp: 1 } },
      { collection: 'assetSnapshots', id: 'ordinary-hour', timestamp: 2, data: { id: 'ordinary-hour', assetId: 'ordinary', type: 'HOUR', timestamp: 2 } },
      { collection: 'assetSnapshots', id: 'imported-default', timestamp: 3, data: { id: 'imported-default', assetId: ADDED.id, type: 'DEFAULT', timestamp: 3 } }];
    await test.repository.upsertMany(rows);
    await test.internal.deleteExpiredSnapshotPages('assetSnapshots', 'HOUR', 10_000_000, 4);
    await test.internal.deleteExpiredSnapshotPages('assetSnapshots', 'DEFAULT', 10_000_000, 4);
    expect((await test.repository.list('assetSnapshots')).map(({ id }) => id).sort()).toEqual([proof.id, 'imported-hour'].sort());
  });

  it('advances a bounded retention cursor beyond a fully protected page across refreshes', async () => {
    const test = worker();
    const protectedRows = Array.from({ length: 1000 }, (_, index) => close(index * 3600 + 3599));
    const legacy: IndexerDocument = { collection: 'assetSnapshots', id: 'late-legacy', timestamp: 4_000_000, data: { id: 'late-legacy', type: 'HOUR', assetId: 'ordinary', timestamp: 4_000_000 } };
    await test.repository.upsertMany([...protectedRows, legacy]);
    const first = await test.internal.deleteExpiredSnapshotPages('assetSnapshots', 'HOUR', 10_000_000, 1);
    expect(first).toEqual({ documents: 0, pages: 1, exhausted: false });
    expect(await test.repository.get('assetSnapshots', legacy.id)).not.toBeNull();
    const next = await test.internal.deleteExpiredSnapshotPages('assetSnapshots', 'HOUR', 10_000_000, 1);
    expect(next).toEqual({ documents: 1, pages: 1, exhausted: true });
    expect(await test.repository.get('assetSnapshots', legacy.id)).toBeNull();
    expect(await test.repository.list('assetSnapshots')).toHaveLength(1000);
  });
});
