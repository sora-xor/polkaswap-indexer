import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/config.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { ChainIndexer } from '../src/worker/chain.js';
const SCALE = 10n ** 18n;
const XOR = '0x0200000000000000000000000000000000000000000000000000000000000000';
const now = 10 * 86_400 + 100;
const liquidity = { liquidityUSD: '20', poolLiquidityUSD: '15', orderBookLiquidityUSD: '5', activePools: 1, activeOrderBooks: 1, listedAssets: 2 };
const asset = (id: string, decimals = 18) => ({ id, name: id, symbol: id, decimals, supply: 1000n });
const doc = (data: Record<string, unknown>, timestamp = now, id = 'row'): any => ({ id, timestamp, data });
function fixture(input: { history?: any[]; orderBookOrders?: any[]; assetDaySnapshots?: any[]; orderBookDaySnapshots?: any[] } = {}) {
  const indexer: any = new ChainIndexer(readConfig(), new MemoryRepository());
  // The loader has independent repository/pagination tests. These fixtures
  // isolate the ordered-input fold and its legacy optional-field contracts.
  indexer.loadAnalyticsInputDocuments = async () => ({ documents: { history: [], orderBookOrders: [], assetDaySnapshots: [], orderBookDaySnapshots: [], ...input }, rollingNetworkInputs: { totals: new Map() } });
  return indexer;
}

describe('ordered analytics input fold', () => {
  it('uses chronological week/day opens and falls back to current prices without snapshots', async () => {
    const indexer = fixture({ assetDaySnapshots: [
      doc({ assetId: 'base', timestamp: now - 2 * 86_400, priceUSD: { open: '1.5' } }),
      doc({ assetId: 'base', timestamp: now - 50, priceUSD: { close: '2.5' } }),
      doc({ assetId: '', priceUSD: { open: '99' } }), doc({ assetId: 'base' }),
    ], orderBookDaySnapshots: [doc({ orderBookId: '0-base-quote', price: { close: '3.5' } }), doc({ orderBookId: '' }), doc({})] });
    const value = await indexer.buildAnalytics(now, new Map([['base', asset('base')], ['other', asset('other')]]), new Map([['base', 3n * SCALE]]), [], liquidity);
    expect(value.assetWeekOpenPrice.get('base')).toBe('1.5'); expect(value.assetDayOpenPrice.get('base')).toBe('2.5');
    expect(value.assetDayOpenPrice.get('other')).toBe('0'); expect(value.orderBookDayOpenPrice.get('0-base-quote')).toBe('3.5');
    expect(value.orderBookDayOpenPrice.size).toBe(1); expect(value.network.get('DAY')).toMatchObject({ ...liquidity, transactions: 0, fees: 0n });
  });
  it('keeps mint/burn amounts distinct from traded volume and charges an extrinsic fee once', async () => {
    const indexer = fixture({ history: [
      doc({ module: 'assets', method: 'mint', data: { assetId: 'base', amount: '2' }, networkFee: '10' }),
      doc({ module: 'assets', method: 'burn', data: { assetId: 'base', amount: '0.5' }, networkFee: '0' }),
      doc({ module: 'bridgeProxy', method: 'mint', data: {}, networkFee: '10' }, now, 'incoming-mint'),
      doc({ module: 'unknown', method: 'unknown' }),
    ] });
    const value = await indexer.buildAnalytics(now, new Map([['base', asset('base')], [XOR, asset(XOR)]]), new Map([['base', 5n * SCALE]]), [], liquidity);
    expect(value.assets.get('base').get('DAY')).toMatchObject({ mint: 2n * SCALE, burn: SCALE / 2n, volumeAmount: 0n });
    expect(value.assets.get(XOR).get('DAY').burn).toBe(3n);
    expect(value.pools.size).toBe(0);
  });
  it('aggregates both traded assets and known pool volume while retaining current prices', async () => {
    const pool = { id: 'base-quote', priceUSD: '7' };
    const indexer = fixture({ history: [
      doc({ timestamp: now, data: { baseAssetId: 'base', targetAssetId: 'quote', baseAssetAmount: '2', targetAssetAmount: '6', baseAssetAmountUSD: '10', targetAssetAmountUSD: '12' } }),
      doc({ data: { baseAssetId: 'base', amount: '1', amountUSD: '5' } }),
      doc({ data: { baseAssetId: 'unknown', targetAssetId: 'quote' } }),
    ] });
    const value = await indexer.buildAnalytics(now, new Map([['base', asset('base')], ['quote', asset('quote')]]), new Map([['base', 5n * SCALE], ['quote', 2n * SCALE]]), [pool], liquidity);
    expect(value.assets.get('base').get('DAY')).toMatchObject({ volumeAmount: 3n * SCALE, volumeUSD: 15n * SCALE });
    expect(value.assets.get('quote').get('DAY')).toMatchObject({ volumeAmount: 6n * SCALE, volumeUSD: 12n * SCALE });
    expect(value.pools.get('base-quote').get('DAY')).toMatchObject({ baseAssetVolume: 2n * SCALE, targetAssetVolume: 6n * SCALE });
    expect(value.pools.size).toBe(1); expect(value.poolDayVolumeUSD.has('base-quote')).toBe(true);
  });
  it('keeps weekly trades out of daily totals', async () => {
    const quote = '0x' + '03'.repeat(32);
    const indexer = fixture({ history: [doc({ data: { baseAssetId: XOR, targetAssetId: quote, amount: '2', amountUSD: '10' } }, now - 2 * 86_400)] });
    const value = await indexer.buildAnalytics(now, new Map(), new Map(), [{ id: XOR + '-' + quote, priceUSD: '0' }], liquidity);
    expect(value.assetDayVolumeUSD.size).toBe(0); expect(value.assetWeekVolumeUSD.get(XOR)).toBe(10n * SCALE);
    expect(value.poolDayVolumeUSD.size).toBe(0); expect(value.assets.get(XOR).has('DAY')).toBe(false);
  });
  it('calculates active buy/sell liquidity at independent precisions and prefers retained USD valuation', async () => {
    const indexer = fixture({ orderBookOrders: [
      doc({ orderBookId: '0-base-quote', amount: '2', price: '3', isBuy: true, status: 'Active' }),
      doc({ orderBookId: '0-base-quote', amount: '1', price: '4', isBuy: true, status: 'Active', amountUSD: '20' }),
      doc({ orderBookId: '0-base-quote', amount: '3', price: '5', isBuy: false, status: 'Active' }),
      doc({ orderBookId: '0-base-quote', amount: '1', price: '6', isBuy: false, status: 'Active' }),
    ] });
    const value = await indexer.buildAnalytics(now, new Map([['base', asset('base', 6)], ['quote', asset('quote', 8)]]), new Map([['base', 5n * SCALE], ['quote', 2n * SCALE]]), [], liquidity);
    expect(value.orderBookActiveReserves.get('0-base-quote')).toEqual({ baseAssetReserves: 4000000n, quoteAssetReserves: 1000000000n, liquidityUSD: 52n * SCALE });
    expect(value.assetOrderBookLiquidity.get('base')).toBe(4000000n); expect(value.assetOrderBookLiquidity.get('quote')).toBe(1000000000n);
    expect(value.orderBooks.get('0-base-quote').get('DAY')).toMatchObject({ baseAssetVolume: 7n * SCALE, volumeUSD: 52n * SCALE, price: { open: '3', close: '6', high: '6', low: '3' } });
  });
  it('retains the latest twenty-five fills in reverse chronological order without active liquidity', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => doc({ orderBookId: '0-b-q', status: 'Filled', orderId: i + 1, amount: '1', price: String(i + 1), isBuy: i % 2 === 0 }, now - 30 + i));
    const value = await fixture({ orderBookOrders: rows }).buildAnalytics(now, new Map(), new Map(), [], liquidity);
    const aggregate = value.orderBooks.get('0-b-q').get('DAY');
    expect(aggregate.lastDeals.map((deal: any) => deal.orderId)).toEqual(Array.from({ length: 25 }, (_, i) => 30 - i));
    expect(value.orderBookActiveReserves.size).toBe(0); expect(aggregate.price).toEqual({ open: '1', close: '30', high: '30', low: '1' });
  });
  it('ignores incomplete order book IDs and retains zero defaults for old empty rows', async () => {
    const rows = [doc({}), doc({ orderBookId: '0--q' }), doc({ orderBookId: '0-b-' }), doc({ orderBookId: '0-b-q', status: 'Filled' })];
    const value = await fixture({ orderBookOrders: rows }).buildAnalytics(now, new Map(), new Map(), [], liquidity);
    expect(value.orderBooks.size).toBe(1); expect(value.orderBooks.get('0-b-q').get('DAY').lastDeals).toEqual([{ orderId: 0, timestamp: now, isBuy: false, amount: '0', price: '0' }]);
  });
});
