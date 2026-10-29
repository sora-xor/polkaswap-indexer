import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readConfig } from '../src/config.js';
import { metrics } from '../src/metrics.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { SORA_MAINNET_GENESIS_HASH } from '../src/soraIdentity.js';
import { ChainIndexer } from '../src/worker/chain.js';
import { assetHourlyCloseId } from '../src/worker/hourly-history.js';
import { pinnedValuationStorage } from './pinned-valuation-storage.js';

const SCALE = 10n ** 18n;
const XOR = '0x0200000000000000000000000000000000000000000000000000000000000000';
const DAI = '0x0200060000000000000000000000000000000000000000000000000000000000';
const ETH = '0x0200070000000000000000000000000000000000000000000000000000000000';
const KUSD = '0x02000c0000000000000000000000000000000000000000000000000000000000';
const TRADER = 'cnUQ2ejPSxrc6D2jsnTB5XAr8xMYzF3PLkVi3oLimwnsJaccJ';
const POOL_ACCOUNT = 'cnTQ1kbv7PBNNQrEb1tZpmK7jT6zmAjZB72t6j7HHmgtiMKgB';
const config = { ...readConfig(), priceStreamRefreshIntervalBlocks: 0 };

/** Runtime event as decoded from SORA metadata; most swap events have unnamed fields. */
const event = (section: string, method: string, values: unknown[], names: string[] = []) => ({
  phase: { isApplyExtrinsic: true, asApplyExtrinsic: { toNumber: () => 1 } },
  event: {
    section,
    method,
    data: { toArray: () => values.map((value) => ({ toJSON: () => value, toString: () => String(value ?? '') })) },
    meta: {
      fields: values.map((_value, index) => (names[index]
        ? { name: { isSome: true, unwrap: () => ({ toString: () => names[index]! }) } }
        : { name: { isSome: false } })),
    },
  },
});

/**
 * The events of SORA block 28022152's ETH -> XOR liquidityProxy.swap: transfers, one
 * technical.SwapSuccess per XYK hop and liquidityProxy.Exchange, but no poolXYK event.
 */
const swapEvents = () => [
  event('tokens', 'Transfer', [{ code: ETH }, TRADER, POOL_ACCOUNT, '0x14729f795c98a9'], ['currency_id', 'from', 'to', 'amount']),
  event('assets', 'Transfer', [TRADER, POOL_ACCOUNT, { code: ETH }, '0x14729f795c98a9']),
  event('balances', 'Transfer', [POOL_ACCOUNT, TRADER, '0x1f9fa00b2bdc1591'], ['from', 'to', 'amount']),
  event('assets', 'Transfer', [POOL_ACCOUNT, TRADER, { code: XOR }, '0x1f9fa00b2bdc1591']),
  event('technical', 'SwapSuccess', [TRADER]),
  event('liquidityProxy', 'Exchange', [
    TRADER, 0, { code: ETH }, { code: XOR }, '0x14729f795c98a9', '0x1f9fa00b2bdc1591',
    { [JSON.stringify({ code: XOR })]: '0x30ddf09d5e0b77' }, [{ dexId: 0, liquiditySourceIndex: 'XYKPool' }],
  ]),
  event('xorFee', 'FeeWithdrawn', [TRADER, '0x16358662c8e303e']),
  event('balances', 'Rescinded', ['0x9251937bc213de'], ['amount']),
];

const swapContext = (failed = false) => ({
  failed,
  module: 'liquidityProxy',
  method: 'swap',
  history: { data: { baseAssetId: ETH, targetAssetId: XOR } },
  calls: [],
});

type Pool = { baseAssetId: string; targetAssetId: string; baseAssetReserves: bigint; targetAssetReserves: bigint };
const pool = (baseAssetId: string, targetAssetId: string, base: bigint, target: bigint): Pool =>
  ({ baseAssetId, targetAssetId, baseAssetReserves: base * SCALE, targetAssetReserves: target * SCALE });
const poolMap = (...pools: Pool[]) => new Map(pools.map((item) => [`${item.baseAssetId}\0${item.targetAssetId}`, item]));
const assetMap = () => new Map([
  [XOR, { id: XOR, symbol: 'XOR', name: 'SORA', decimals: 18, supply: 0n }],
  [DAI, { id: DAI, symbol: 'DAI', name: 'Dai', decimals: 18, supply: 0n }],
  [ETH, { id: ETH, symbol: 'ETH', name: 'Ether', decimals: 18, supply: 0n }],
  [KUSD, { id: KUSD, symbol: 'KUSD', name: 'Kensetsu USD', decimals: 18, supply: 0n }],
]);

/** Valuation state whose pools are the chain's pre-swap reserves. */
function valuationState(indexer: any, blockHeight: number, pools: Map<string, Pool>) {
  const state = {
    blockHeight, assets: assetMap(), pools, prices: new Map<string, bigint>(), orderBookLiquidityComplete: true,
    networkLiquidityStats: { liquidityUSD: '0', poolLiquidityUSD: '0', orderBookLiquidityUSD: '0', activePools: 0, activeOrderBooks: 0, listedAssets: 0 },
  };
  indexer.recalculateHistoricalValuationState(state);
  return state;
}

beforeEach(() => metrics.reset());

describe('XYK swap reserve freshness', () => {
  it('dirties cached pool reserves for a swap block so the next projection reloads them', async () => {
    const reserves = vi.fn().mockResolvedValue([]);
    const properties = vi.fn().mockResolvedValue([]);
    const issuance = vi.fn().mockResolvedValue([]);
    const indexer = new ChainIndexer(config, new MemoryRepository()) as any;
    indexer.api = { query: { poolXYK: {
      properties: { entriesPaged: properties }, reserves: { entriesPaged: reserves }, totalIssuances: { entriesPaged: issuance },
    } } };

    await indexer.loadPoolStorageDomain(10);
    indexer.markDerivedStorageDomainsDirtyFromBlock([], swapEvents(), 11);
    expect(indexer.dirtyDerivedStorageDomains.has('poolReserves')).toBe(true);
    await indexer.loadPoolStorageDomain(25);

    expect(reserves).toHaveBeenCalledTimes(2);
    expect(properties).toHaveBeenCalledTimes(1);
    expect(issuance).toHaveBeenCalledTimes(1);

    // The successful swap call alone is also evidence; a failed one changed nothing.
    await indexer.loadPoolStorageDomain(50);
    indexer.markDerivedStorageDomainsDirtyFromBlock([swapContext(true)], [], 51);
    await indexer.loadPoolStorageDomain(75);
    expect(reserves).toHaveBeenCalledTimes(2);
    indexer.markDerivedStorageDomainsDirtyFromBlock([swapContext()], [], 76);
    await indexer.loadPoolStorageDomain(100);
    expect(reserves).toHaveBeenCalledTimes(3);
  });

  it('keeps a domain dirty when its refresh is pinned below a later swap block', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as any;
    // The refresh for block 100 starts after block 101 (with a swap) was indexed.
    indexer.markDerivedStorageDomainsDirty(['poolReserves'], 101);
    expect(await indexer.loadDerivedStorageDomain('poolReserves', 100, false, async () => ['state-100'])).toEqual(['state-100']);
    expect(indexer.dirtyDerivedStorageDomains.has('poolReserves')).toBe(true);

    expect(await indexer.loadDerivedStorageDomain('poolReserves', 125, false, async () => ['state-125'])).toEqual(['state-125']);
    expect(indexer.dirtyDerivedStorageDomains.has('poolReserves')).toBe(false);
    const unused = vi.fn();
    expect(await indexer.loadDerivedStorageDomain('poolReserves', 150, false, unused)).toEqual(['state-125']);
    expect(unused).not.toHaveBeenCalled();
  });

  it('revalues a swap block from one pinned reload, so later prices use the swapped reserves', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as any;
    const state = valuationState(indexer, 10, poolMap(pool(XOR, DAI, 100n, 500n), pool(XOR, ETH, 102n, 1n)));
    expect(state.prices.get(ETH)).toBe(510n * SCALE);
    // Post-swap chain state at block 11: the trader sold ETH into XOR/ETH.
    const chain = { assets: assetMap(), pools: poolMap(pool(XOR, DAI, 100n, 500n), pool(XOR, ETH, 100n, 2n)) };
    const storage = pinnedValuationStorage(() => chain);
    indexer.getHistoricalValuationQueryAt = vi.fn(async () => storage);

    // Two swaps in one block still cost one pinned reload.
    const events = [...swapEvents(), ...swapEvents()];
    const advance = await indexer.prepareHistoricalValuationAdvance(state, 11, [swapContext(), swapContext()], events);
    indexer.applyHistoricalValuationAdvance(state, advance);

    expect(indexer.getHistoricalValuationQueryAt).toHaveBeenCalledTimes(1);
    expect(indexer.getHistoricalValuationQueryAt.mock.calls[0][0]).toBe(11);
    expect(storage.poolXYK.reserves.entriesPaged).toHaveBeenCalledTimes(1);
    expect(state.blockHeight).toBe(11);
    expect(state.pools.get(`${XOR}\0${ETH}`)).toMatchObject({ baseAssetReserves: 100n * SCALE, targetAssetReserves: 2n * SCALE });
    expect(state.prices.get(ETH)).toBe(250n * SCALE);
  });

  it('reads each hourly close from the pinned before-block state and reports incremental drift', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as any;
    indexer.observedGenesisHash = SORA_MAINNET_GENESIS_HASH;
    indexer.api = { genesisHash: { toString: () => SORA_MAINNET_GENESIS_HASH } };
    // A stale incremental state (as left by an unattributed swap) at the hour's last block 9.
    const state = valuationState(indexer, 9, poolMap(pool(XOR, KUSD, 100n, 200n)));
    const chain = { assets: assetMap(), pools: poolMap(pool(XOR, KUSD, 100n, 400n)) };
    indexer.previousHourlyHistoryBlock = { height: 9, hash: `0x${'9'.padStart(64, '0')}`, timestamp: 7198 };
    indexer.getHistoricalValuationQueryAt = vi.fn(async () => ({
      ...pinnedValuationStorage(() => chain),
      denomination: { denominator: async () => ({ toString: (): string => '100000000000000000000000000000000000000' }) },
    }));
    const requestedHash = `0x${(10).toString(16).padStart(64, '0')}`;

    await indexer.indexFetchedBlock({
      requestedHash, timestamp: 7201, events: [],
      signedBlock: { block: { header: {
        number: { toNumber: () => 10 }, hash: { toString: () => requestedHash },
        parentHash: { toString: () => `0x${'9'.padStart(64, '0')}` },
      }, extrinsics: [] } },
    }, { historicalValuationState: state, refreshDerivedState: false });

    expect(indexer.getHistoricalValuationQueryAt).toHaveBeenCalledWith(9);
    expect((await repository.get('assetSnapshots', assetHourlyCloseId(KUSD, 7198)))?.data.closeEvidence).toMatchObject({
      blockHeight: 9,
      xorPool: { baseAssetReserves: (100n * SCALE).toString(), targetAssetReserves: (400n * SCALE).toString() },
    });
    expect((await repository.get('assetSnapshots', assetHourlyCloseId(XOR, 7198)))?.data.priceUSD).toMatchObject({ close: '4' });
    expect(metrics.render()).toContain('indexer_worker_hourly_close_pool_drift_total 1');
  });
});
