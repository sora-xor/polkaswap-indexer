import { describe, expect, it, vi } from 'vitest';
import { readConfig } from '../src/config.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { ChainIndexer } from '../src/worker/chain.js';
const SCALE = 10n ** 18n;
const XOR = '0x0200000000000000000000000000000000000000000000000000000000000000';
const VAL = '0x0200040000000000000000000000000000000000000000000000000000000000';
const worker = (repo = new MemoryRepository()): any => new ChainIndexer({ ...readConfig(), snapshotRetentionMode: 'all' }, repo);
const bookId = { dexId: 0, base: 'base', quote: 'quote' };
const level = (price: number) => [{ args: [bookId, String(BigInt(price) * SCALE)] }, '1'];
const analytics = () => ({ orderBooks: new Map(), orderBookActiveReserves: new Map(), orderBookDayOpenPrice: new Map(), orderBookDayVolumeUSD: new Map() });

describe('order book current price and snapshot projections', () => {
  it.each([
    ['empty', [], [], '0'], ['bid only', [level(2), level(1), level(3)], [], '3'],
    ['ask only', [], [level(5), level(6), level(4)], '4'],
    ['two sided', [level(2)], [level(4)], '3'],
  ])('projects the %s price without inventing the absent side', async (_name, bids, asks, expected) => {
    const w = worker(); const rows = await w.createOrderBookDocuments([[{ args: [bookId] }, {}]], bids, asks, [], new Map(), new Map(), analytics(), 42, 3600, false);
    expect(rows).toHaveLength(1); expect(rows[0].data).toMatchObject({ id: '0-base-quote', status: 'Stop', price: expected, baseAssetReserves: '0', quoteAssetReserves: '0', volumeDayUSD: '0', lastDeals: '[]' });
  });
  it('retains actual reserves and aggregate fills while computing price change from the opening quote', async () => {
    const a = analytics(); a.orderBooks.set('0-base-quote', new Map([['DAY', { price: { open: '2', high: '7', low: '1', close: '4' }, lastDeals: [{ orderId: 3 }], volumeUSD: 5n * SCALE }]]));
    a.orderBookActiveReserves.set('0-base-quote', { baseAssetReserves: 7n, quoteAssetReserves: 8n, liquidityUSD: 20n * SCALE });
    a.orderBookDayOpenPrice.set('0-base-quote', '2'); a.orderBookDayVolumeUSD.set('0-base-quote', 9n * SCALE);
    const rows = await worker().createOrderBookDocuments([[{ args: [bookId] }, { status: 'Trade' }]], [], [], [], new Map(), new Map(), a, 42, 3600, false);
    expect(rows[0].data).toMatchObject({ price: '4', priceChangeDay: '100', volumeDayUSD: '9', baseAssetReserves: '7', quoteAssetReserves: '8', lastDeals: '[{"orderId":3}]' });
  });
  it('preserves prior candle open and extremes during a refreshed snapshot', async () => {
    const repo = new MemoryRepository(), w = worker(repo), a = analytics();
    const first = await w.createOrderBookDocuments([[{ args: [bookId] }, {}]], [], [level(3)], [], new Map(), new Map(), a, 42, 3600, true);
    await repo.upsertMany(first.filter((d: any) => d.collection === 'orderBookSnapshots').map((d: any) => ({ ...d, data: { ...d.data, price: { open: '2', high: '8', low: '1', close: '3' } } })));
    const second = await w.createOrderBookDocuments([[{ args: [bookId] }, {}]], [], [level(4)], [], new Map(), new Map(), a, 42, 3600, true);
    const snapshots = second.filter((d: any) => d.collection === 'orderBookSnapshots'); expect(snapshots.length).toBeGreaterThan(1);
    for (const row of snapshots) expect(row.data).toMatchObject({ price: { open: '2', high: '8', low: '1', close: '4' }, baseAssetVolume: '0', quoteAssetVolume: '0', volumeUSD: '0', liquidityUSD: '0' });
  });
});

describe('staking validator preferences and return estimates', () => {
  it.each([
    [{ commission: { unwrap: () => '1' }, blocked: { isTrue: true } }, '1', true],
    [{ commission: { toString: (): string => '2' }, blocked: { toJSON: (): unknown => false } }, '2', false],
    [{ commission: { unwrap: () => null, toString: (): string => '3' }, blocked: { toJSON: (): unknown => null, toString: (): string => 'true' } }, '3', true],
    [{ commission: { toString: (): string => '0' }, blocked: { toString: (): string => 'false' } }, '0', false],
  ])('decodes validator preference codec %#', (prefs, commission, blocked) => {
    expect(worker().formatValidatorPrefs([[{ args: ['alice'] }, prefs]])).toEqual([{ address: 'alice', commission, blocked }]);
  });
  it.each([
    [[], {}, /address/], [['alice'], {}, /commission/],
    [['alice'], { commission: { toString: (): string => '1' } }, /blocked/],
  ])('rejects incomplete staking preference %#', (args, prefs, error) => {
    expect(() => worker().formatValidatorPrefs([[{ args }, prefs]])).toThrow(error as RegExp);
  });
  const apy = (patch: Record<string, any> = {}) => worker().calculateValidatorApy(
    patch.stake ?? 100n * SCALE, patch.reward ?? SCALE, patch.points ?? 1, patch.total ?? 10,
    patch.commission ?? '0', patch.prices ?? new Map([[XOR, SCALE], [VAL, 2n * SCALE]]), patch.assets ?? new Map());
  it.each([{ stake: 0n }, { reward: 0n }, { points: 0 }, { total: 0 }, { prices: new Map() }, { prices: new Map([[XOR, SCALE]]) }])('keeps APY unknown when required input %# is missing', patch => {
    expect(apy(patch)).toBeNull();
  });
  it.each(['1000000000', '2000000000'])('leaves no nominator return at commission %s', commission => { expect(apy({ commission })).toBe('0'); });
  it('scales equivalent stake and reward precisions to the same percentage', () => {
    const alternate = apy({ stake: 100_000_000n, reward: 100_000_000n, assets: new Map([[XOR, { decimals: 6 }], [VAL, { decimals: 8 }]]) });
    expect(alternate).toBe(apy()); expect(Number(alternate)).toBeGreaterThan(0);
    expect(Number(apy({ commission: '500000000' }))).toBe(Number(apy()) / 2);
  });
});

describe('historical bridge runtime admission', () => {
  it('requires the live API, a historical API, a hash and metadata RPC', async () => {
    const w = worker(); await expect(w.hasBridgeProxyHistoryRuntime('hash', 1)).rejects.toThrow(/initialized/);
    w.api = { rpc: {} }; await expect(w.hasBridgeProxyHistoryRuntime('hash', 1, null)).rejects.toThrow(/initialized/);
    await expect(w.hasBridgeProxyHistoryRuntime('', 1)).rejects.toThrow(/Missing block hash/);
    await expect(w.hasBridgeProxyHistoryRuntime('hash', 1)).rejects.toThrow(/getMetadata/);
  });
  it.each([
    [{ asLatest: { pallets: [{}, { name: { toString: (): string => 'assets' } }] } }, false],
    [{ asLatest: { pallets: [{ name: { toString: (): string => 'bridgeProxy' } }] } }, true],
    [{ asLatest: { pallets: [{ name: { toString: (): string => 'bridgeChannelInbound' } }] } }, true],
    [{ toJSON: (): unknown => ({ pallets: ['bridgeProxy'] }) }, true],
    [{ toJSON: (): unknown => ({ pallets: ['bridgeChannelInbound'] }) }, true],
    [{ toJSON: (): unknown => null }, false], [{}, false],
  ])('detects bridge availability from historical metadata %#', async (metadata, expected) => {
    const w = worker(), getMetadata = vi.fn(async () => metadata); w.api = { rpc: { state: { getMetadata } } };
    expect(await w.hasBridgeProxyHistoryRuntime('0x1234', 42)).toBe(expected); expect(getMetadata).toHaveBeenCalledExactlyOnceWith('0x1234');
  });
});
