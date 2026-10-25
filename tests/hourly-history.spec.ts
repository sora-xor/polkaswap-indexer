import { describe, expect, it, vi } from 'vitest';
import { readConfig } from '../src/config.js';
import { MemoryRepository } from '../src/repository/memory.js';
import type { IndexerDocument } from '../src/repository/types.js';
import { ChainIndexer } from '../src/worker/chain.js';
import {
  assetHourlyCloseId, buildAssetHourlyCloseDocumentsAtBoundary, deriveAssetPrices, directXorPoolEvidence,
  HOURLY_HISTORY_ASSETS, HOURLY_HISTORY_ASSET_IDS, HOURLY_HISTORY_GENESIS, MAX_HOURLY_HISTORY_TARGETS,
  selectHourlyHistoryTargets, validateHourlyHistoryTargets,
  type AssetHourlyCloseInput, type HourlyBoundaryBlock, type HourlyHistoryTarget,
} from '../src/worker/hourly-history.js';

const SCALE = 10n ** 18n;
const XOR = HOURLY_HISTORY_ASSETS[0]!.id;
const KUSD = HOURLY_HISTORY_ASSETS[4]!.id;
const LLD = HOURLY_HISTORY_ASSETS[5]!.id;
const CUSTOM = `0x${'a'.repeat(64)}`;
const ROUTE_ONLY = `0x${'b'.repeat(64)}`;
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

describe('explicit bounded hourly-history targets', () => {
  it('clones provenance descriptors and keeps the original immutable seven defaults', () => {
    const targets = [{ id: CUSTOM, symbol: 'ORIGINAL' }];
    const validated = validateHourlyHistoryTargets(targets);
    targets[0]!.symbol = 'CHANGED';
    expect(validated).toEqual([{ id: CUSTOM, symbol: 'ORIGINAL' }]);
    expect(validated).not.toBe(targets);
    expect(Object.isFrozen(HOURLY_HISTORY_ASSETS)).toBe(true);
    expect(HOURLY_HISTORY_ASSETS.every(Object.isFrozen)).toBe(true);
    expect(HOURLY_HISTORY_ASSETS).toHaveLength(7);
    expect([...HOURLY_HISTORY_ASSET_IDS]).toEqual(HOURLY_HISTORY_ASSETS.map((asset) => asset.id));
    const source = input();
    source.assets.set(CUSTOM, { id: CUSTOM, symbol: 'ACTUAL', decimals: 6 });
    source.prices.set(CUSTOM, SCALE);
    expect(buildAssetHourlyCloseDocumentsAtBoundary(source).map((row) => row.data.assetId)).toEqual(HOURLY_HISTORY_ASSETS.map((asset) => asset.id));
  });

  it.each([
    undefined, null, {}, [], [{ id: 'not-an-id', symbol: 'TOKEN' }],
    [{ id: `0x${'A'.repeat(64)}`, symbol: 'TOKEN' }], [{ id: CUSTOM, symbol: '' }],
    [{ id: CUSTOM, symbol: ' ' }], [{ id: CUSTOM, symbol: 'x'.repeat(129) }],
    [{ id: CUSTOM, symbol: 'A' }, { id: CUSTOM, symbol: 'B' }], [{ id: XOR, symbol: 'OTHER' }],
  ])('rejects malformed, duplicate or renamed known catalogue identities (%o)', (targets) => {
    expect(() => validateHourlyHistoryTargets(targets)).toThrow('hourly history target');
  });

  it('rejects hidden/extra fields, accessors, nonplain descriptors and sparse entries without invoking getters', () => {
    const getter = vi.fn(() => CUSTOM);
    const accessor = { get id() { return getter(); }, symbol: 'TOKEN' };
    const hidden = Object.defineProperty({ id: CUSTOM, symbol: 'TOKEN' }, 'extra', { value: true });
    const concealedId = Object.defineProperty({ symbol: 'TOKEN' }, 'id', { value: CUSTOM });
    const symbolField = { id: CUSTOM, symbol: 'TOKEN', [Symbol('extra')]: true };
    class Descriptor { id = CUSTOM; symbol = 'TOKEN'; }
    const inherited = Object.assign(Object.create({ inherited: true }), { id: CUSTOM, symbol: 'TOKEN' });
    for (const descriptor of [{ id: CUSTOM, symbol: 'TOKEN', extra: true }, hidden, concealedId, symbolField,
      accessor, new Descriptor(), inherited, Object.assign(Object.create(null), { id: CUSTOM, symbol: 'TOKEN' })]) {
      expect(() => validateHourlyHistoryTargets([descriptor])).toThrow('hourly history target');
    }
    expect(getter).not.toHaveBeenCalled();
    expect(() => validateHourlyHistoryTargets(new Array(1))).toThrow('hourly history target');
  });

  it('accepts exactly the target bound and rejects one additional descriptor', () => {
    const targets = Array.from({ length: MAX_HOURLY_HISTORY_TARGETS }, (_, index) => ({
      id: `0x${BigInt(index + 1).toString(16).padStart(64, '0')}`, symbol: `T${index}`,
    }));
    expect(validateHourlyHistoryTargets(targets)).toHaveLength(512);
    expect(() => validateHourlyHistoryTargets([...targets, { id: CUSTOM, symbol: 'EXTRA' }])).toThrow('count');
  });

  it('records non-seven metadata/precision and historical rename separately from requested provenance', () => {
    const source = input();
    source.targets = [{ id: CUSTOM, symbol: 'CATALOGUE_NAME' }];
    source.assets.set(CUSTOM, { id: CUSTOM, symbol: 'HISTORICAL_NAME', decimals: 6 });
    source.prices.set(CUSTOM, 1234567890123456789n);
    source.xorPoolsComplete = true;
    source.pools = [{ baseAssetId: CUSTOM, targetAssetId: XOR, baseAssetReserves: 1234567n, targetAssetReserves: 2n * SCALE }];
    const rows = buildAssetHourlyCloseDocumentsAtBoundary(source);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data).toMatchObject({ assetId: CUSTOM, priceUSD: { close: '1.234567890123456789' }, closeEvidence: {
      requestedSymbol: 'CATALOGUE_NAME', symbol: 'HISTORICAL_NAME', decimals: 6, xorPool: {
        baseAssetId: XOR, targetAssetId: CUSTOM, baseAssetReserves: (2n * SCALE).toString(), targetAssetReserves: '1234567',
        baseDecimals: 18, targetDecimals: 6,
      },
    } });
  });

  it('keeps builder scope explicit even when a price route includes another canonical asset', () => {
    const source = input();
    source.targets = [{ id: CUSTOM, symbol: 'CUSTOM' }];
    source.assets.set(CUSTOM, { id: CUSTOM, symbol: 'CUSTOM', decimals: 8 });
    source.assets.set(ROUTE_ONLY, { id: ROUTE_ONLY, symbol: 'ROUTE', decimals: 12 });
    source.prices.set(CUSTOM, SCALE); source.prices.set(ROUTE_ONLY, SCALE);
    const route = { baseAssetId: ROUTE_ONLY, targetAssetId: CUSTOM, baseAssetReserves: 500n, targetAssetReserves: 100n };
    source.pools = [route]; source.priceRoutes = new Map([[CUSTOM, [route]]]);
    const rows = buildAssetHourlyCloseDocumentsAtBoundary(source);
    expect(rows.map((row) => row.data.assetId)).toEqual([CUSTOM]);
    expect(rows[0]?.data.closeEvidence).toMatchObject({ symbol: 'CUSTOM', decimals: 8, pools: [{ baseAssetId: ROUTE_ONLY }] });
  });

  it.each([
    { id: ROUTE_ONLY, symbol: 'ACTUAL', decimals: 6 }, { id: CUSTOM, symbol: '', decimals: 6 },
    { id: CUSTOM, symbol: 'x'.repeat(129), decimals: 6 }, { id: CUSTOM, symbol: 'ACTUAL', decimals: -1 },
    { id: CUSTOM, symbol: 'ACTUAL', decimals: 37 }, { id: CUSTOM, symbol: 'ACTUAL', decimals: 6.5 },
  ])('rejects invalid actual non-seven metadata rather than inventing a descriptor (%o)', (metadata) => {
    const source = input(); source.targets = [{ id: CUSTOM, symbol: 'REQUESTED' }];
    source.assets.set(CUSTOM, metadata);
    expect(() => buildAssetHourlyCloseDocumentsAtBoundary(source)).toThrow('metadata mismatch');
    source.xorPoolsComplete = true; source.pools = [];
    expect(() => directXorPoolEvidence(CUSTOM, source)).toThrow('metadata mismatch');
    const eligible = { baseAssetId: XOR, targetAssetId: CUSTOM, baseAssetReserves: SCALE + 1n, targetAssetReserves: 2n };
    expect(() => selectHourlyHistoryTargets(source.assets, [eligible])).toThrow('metadata mismatch');
  });

  it('retains missing/zero/unknown semantics for an explicit non-seven target', () => {
    const source = input(); source.targets = [{ id: CUSTOM, symbol: 'REQUESTED' }];
    source.prices.set(CUSTOM, SCALE); source.pools = []; source.xorPoolsComplete = true;
    let row = buildAssetHourlyCloseDocumentsAtBoundary(source)[0]!;
    expect(row.data.closeEvidence).toMatchObject({ availability: 'metadata-unavailable', symbol: null, decimals: null });
    expect(row.data.closeEvidence).not.toHaveProperty('xorPool');
    source.assets.set(CUSTOM, { id: CUSTOM, symbol: 'ACTUAL', decimals: 8 }); source.prices.delete(CUSTOM);
    row = buildAssetHourlyCloseDocumentsAtBoundary(source)[0]!;
    expect(row.data.closeEvidence).toMatchObject({ availability: 'price-unavailable', xorPool: null, marketStatus: 'no-observed-pool' });
    source.pools = [{ baseAssetId: XOR, targetAssetId: CUSTOM, baseAssetReserves: 0n, targetAssetReserves: 19n }];
    row = buildAssetHourlyCloseDocumentsAtBoundary(source)[0]!;
    expect(row.data.closeEvidence).toMatchObject({ xorPool: { baseAssetReserves: '0', targetAssetReserves: '19', targetDecimals: 8 } });
    source.xorPoolsComplete = undefined;
    expect(buildAssetHourlyCloseDocumentsAtBoundary(source)[0]?.data.closeEvidence).not.toHaveProperty('xorPool');
    source.targets = null as unknown as HourlyHistoryTarget[];
    expect(() => buildAssetHourlyCloseDocumentsAtBoundary(source)).toThrow('target count');
  });

  it('unions positive complete direct pools with prior tracking, preserves descriptor rename and sorts IDs', () => {
    const source = input();
    source.assets.set(CUSTOM, { id: CUSTOM, symbol: 'CURRENT_NAME', decimals: 6 });
    source.assets.set(ROUTE_ONLY, { id: ROUTE_ONLY, symbol: 'NEW_TARGET', decimals: 12 });
    const prior = [...HOURLY_HISTORY_ASSETS, { id: CUSTOM, symbol: 'ORIGINAL_NAME' }];
    const pools = [
      { baseAssetId: CUSTOM, targetAssetId: XOR, baseAssetReserves: 5n, targetAssetReserves: SCALE + 1n },
      { baseAssetId: XOR, targetAssetId: ROUTE_ONLY, baseAssetReserves: SCALE + 1n, targetAssetReserves: 7n },
    ];
    const targets = selectHourlyHistoryTargets(source.assets, pools, prior);
    expect(targets).toHaveLength(9);
    expect(targets.find((target) => target.id === CUSTOM)?.symbol).toBe('ORIGINAL_NAME');
    expect(targets.find((target) => target.id === ROUTE_ONLY)?.symbol).toBe('NEW_TARGET');
    expect(targets.map((target) => target.id)).toEqual(targets.map((target) => target.id).sort());
    expect(selectHourlyHistoryTargets(source.assets, [...pools].reverse(), prior)).toEqual(targets);
    expect(selectHourlyHistoryTargets(source.assets, pools, [...prior].reverse())).toEqual(targets);
    source.assets.delete(CUSTOM);
    const retained = selectHourlyHistoryTargets(source.assets, [], targets);
    expect(retained).toEqual(targets);
    source.targets = retained; source.pools = []; source.xorPoolsComplete = true;
    expect(buildAssetHourlyCloseDocumentsAtBoundary(source).find((row) => row.data.assetId === CUSTOM)?.data.closeEvidence)
      .toMatchObject({ requestedSymbol: 'ORIGINAL_NAME', availability: 'metadata-unavailable', symbol: null });
  });

  it('applies the raw one-XOR18 threshold without changing USD oracle eligibility or default count', () => {
    const source = input(); source.assets.set(CUSTOM, { id: CUSTOM, symbol: 'CUSTOM', decimals: 6 });
    const pool = { baseAssetId: XOR, targetAssetId: CUSTOM, baseAssetReserves: SCALE, targetAssetReserves: 1n };
    expect(selectHourlyHistoryTargets(source.assets, [pool])).toHaveLength(7);
    expect(selectHourlyHistoryTargets(source.assets, [{ ...pool, baseAssetReserves: SCALE + 1n, targetAssetReserves: 0n }])).toHaveLength(7);
    expect(selectHourlyHistoryTargets(source.assets, [{ ...pool, baseAssetReserves: SCALE + 1n }])).toHaveLength(8);
    expect(selectHourlyHistoryTargets(source.assets, [{ ...pool, baseAssetReserves: SCALE + 1n }]).find((target) => target.id === CUSTOM))
      .toEqual({ id: CUSTOM, symbol: 'CUSTOM' });
    expect(deriveAssetPrices(source.assets, [{ ...pool, baseAssetReserves: SCALE + 1n }]).has(CUSTOM)).toBe(false);
    source.assets.get(XOR)!.decimals = 6;
    expect(() => selectHourlyHistoryTargets(source.assets, [pool])).toThrow('XOR18');
  });

  it('rejects ambiguous direct pairs, malformed reserves/state, invalid prior descriptors and target overflow', () => {
    const source = input(); source.assets.set(CUSTOM, { id: CUSTOM, symbol: 'CUSTOM', decimals: 6 });
    const pool = { baseAssetId: XOR, targetAssetId: CUSTOM, baseAssetReserves: SCALE + 1n, targetAssetReserves: 2n };
    expect(() => selectHourlyHistoryTargets(source.assets, [pool, { ...pool }])).toThrow('Ambiguous');
    expect(() => selectHourlyHistoryTargets(source.assets, [pool, { ...pool, baseAssetId: CUSTOM, targetAssetId: XOR }])).toThrow('Ambiguous');
    for (const value of [-1n, 1n << 128n]) expect(() => selectHourlyHistoryTargets(source.assets, [{ ...pool, targetAssetReserves: value }])).toThrow('reserves');
    expect(() => selectHourlyHistoryTargets(source.assets, [{ ...pool, targetAssetId: 'invalid' }])).toThrow('pool identity');
    expect(() => selectHourlyHistoryTargets(source.assets, [], [{ id: XOR, symbol: 'NOT_XOR' }])).toThrow('target identity');
    source.assets.set(KUSD, { id: KUSD, symbol: 'NOT_KUSD', decimals: 18 });
    expect(() => selectHourlyHistoryTargets(source.assets, [pool])).toThrow('metadata mismatch');
    source.assets.get(KUSD)!.symbol = 'KUSD';
    const full = Array.from({ length: MAX_HOURLY_HISTORY_TARGETS }, (_, index) => ({
      id: `0x${BigInt(index + 1).toString(16).padStart(64, '0')}`, symbol: `T${index}`,
    }));
    expect(() => selectHourlyHistoryTargets(source.assets, [pool], full)).toThrow('target limit');
    expect(() => directXorPoolEvidence('not-an-id', source)).toThrow('metadata mismatch');
  });

  it('tolerates unrelated route metadata/pools while fully validating all direct XOR ambiguity and reserves', () => {
    const source = input(); source.assets.set(CUSTOM, { id: CUSTOM, symbol: 'CUSTOM', decimals: 6 });
    source.assets.set(ROUTE_ONLY, { id: 'malformed-incidental-id', symbol: '', decimals: 99 });
    source.assets.set('unrelated-map-key', { id: 'unrelated-map-key', symbol: '', decimals: -1 });
    const direct = { baseAssetId: XOR, targetAssetId: CUSTOM, baseAssetReserves: SCALE + 1n, targetAssetReserves: 2n };
    const incidental = { baseAssetId: 'noncanonical-route', targetAssetId: 'noncanonical-route', baseAssetReserves: -1n, targetAssetReserves: 1n << 128n };
    expect(selectHourlyHistoryTargets(source.assets, [incidental, direct])).toHaveLength(8);
    source.assets.get(CUSTOM)!.symbol = '';
    const shallow = { ...direct, baseAssetReserves: SCALE };
    expect(selectHourlyHistoryTargets(source.assets, [incidental, shallow])).toHaveLength(7);
    expect(() => selectHourlyHistoryTargets(source.assets, [shallow, { ...shallow }])).toThrow('Ambiguous');
    expect(() => selectHourlyHistoryTargets(source.assets, [{ ...shallow, targetAssetReserves: -1n }])).toThrow('reserves');
    source.assets.delete(CUSTOM);
    expect(() => selectHourlyHistoryTargets(source.assets, [shallow, { ...shallow }])).toThrow('Ambiguous');
    expect(() => selectHourlyHistoryTargets(source.assets, [{ ...shallow, targetAssetReserves: 1n << 128n }])).toThrow('reserves');
    expect(() => selectHourlyHistoryTargets(source.assets, [{ ...shallow, targetAssetId: XOR }])).toThrow('pool identity');
  });

  it('requires canonical XOR18 precision before emitting direct-pair or XOR-self evidence', () => {
    const source = input(); source.assets.get(XOR)!.decimals = 6;
    source.xorPoolsComplete = true; source.pools = [];
    expect(() => directXorPoolEvidence(KUSD, source)).toThrow('XOR18');
    expect(() => directXorPoolEvidence(XOR, source)).toThrow('XOR18');
  });
});

describe('durable hourly close evidence', () => {
  it.each([undefined, null, '', '1e1', false])('never infers historical asset precision (%s)', (precision) => {
    const worker = new ChainIndexer(readConfig(), new MemoryRepository()) as unknown as {
      parseHistoricalAssetInfo(id: string, value: unknown): { decimals: number };
    };
    expect(() => worker.parseHistoricalAssetInfo(KUSD, { toHuman: () => ({ symbol: 'KUSD', precision }) })).toThrow('precision');
    expect(worker.parseHistoricalAssetInfo(KUSD, { toHuman: () => ({ symbol: 'KUSD', precision: 6 }) }).decimals).toBe(6);
  });

  it('retains exact direct KUSD/XOR evidence even when stable USD price uses no pool', () => {
    const source = input();
    source.xorPoolsComplete = true;
    source.assets.get(KUSD)!.decimals = 6;
    source.pools = [{ baseAssetId: XOR, targetAssetId: KUSD, baseAssetReserves: 12345678901234567890n, targetAssetReserves: 456789012n }];
    source.priceRoutes = new Map([[KUSD, []], [XOR, []]]);
    const row = buildAssetHourlyCloseDocumentsAtBoundary(source).find((item) => item.data.assetId === KUSD)!;
    expect(row.data.priceUSD).toEqual({ close: '1' });
    expect(row.data.closeEvidence).toMatchObject({ pools: [], xorPool: {
      baseAssetId: XOR, targetAssetId: KUSD, baseAssetReserves: '12345678901234567890', targetAssetReserves: '456789012',
      baseDecimals: 18, targetDecimals: 6,
    } });
  });

  it('distinguishes unknown legacy pool coverage from an observed missing direct pair', () => {
    const source = input();
    source.pools = [];
    expect(directXorPoolEvidence(KUSD, source)).toBeUndefined();
    source.xorPoolsComplete = true;
    expect(directXorPoolEvidence(KUSD, source)).toBeNull();
    expect(directXorPoolEvidence(XOR, source)).toBeNull();
    source.pools = undefined;
    expect(directXorPoolEvidence(KUSD, source)).toBeUndefined();
  });

  it('normalizes one reversed pool without replacing observed zero reserves', () => {
    const source = input();
    source.xorPoolsComplete = true;
    source.pools = [{ baseAssetId: KUSD, targetAssetId: XOR, baseAssetReserves: 17n, targetAssetReserves: 0n }];
    expect(directXorPoolEvidence(KUSD, source)).toEqual({
      baseAssetId: XOR, targetAssetId: KUSD, baseAssetReserves: '0', targetAssetReserves: '17', baseDecimals: 18, targetDecimals: 18,
    });
  });

  it.each([false, true])('rejects duplicate or ambiguous reversed direct pairs (reversed=%s)', (reversed) => {
    const source = input();
    source.xorPoolsComplete = true;
    const pool = { baseAssetId: XOR, targetAssetId: KUSD, baseAssetReserves: 1n, targetAssetReserves: 2n };
    source.pools = [pool, reversed ? { ...pool, baseAssetId: KUSD, targetAssetId: XOR } : { ...pool }];
    expect(() => directXorPoolEvidence(KUSD, source)).toThrow('Ambiguous');
  });

  it.each([-1n, 1n << 128n])('rejects direct reserves outside u128 (%s)', (value) => {
    const source = input();
    source.xorPoolsComplete = true;
    source.pools = [{ baseAssetId: XOR, targetAssetId: KUSD, baseAssetReserves: value, targetAssetReserves: 2n }];
    expect(() => directXorPoolEvidence(KUSD, source)).toThrow('reserves');
  });

  it('requires exact same-state metadata for both pool legs', () => {
    const source = input();
    source.xorPoolsComplete = true;
    source.pools = [{ baseAssetId: XOR, targetAssetId: KUSD, baseAssetReserves: 1n, targetAssetReserves: 2n }];
    source.assets.delete(XOR);
    expect(directXorPoolEvidence(KUSD, source)).toBeUndefined();
    source.assets.set(XOR, { id: KUSD, symbol: 'KUSD', decimals: 18 });
    expect(() => directXorPoolEvidence(KUSD, source)).toThrow('metadata');
    source.assets.set(XOR, { id: XOR, symbol: 'XOR', decimals: 37 });
    expect(() => directXorPoolEvidence(KUSD, source)).toThrow('metadata');
  });

  it('does not carry previous direct-pair evidence into an unavailable observation', () => {
    const source = input();
    const id = assetHourlyCloseId(KUSD, before.timestamp);
    source.previous = new Map([[id, { collection: 'assetSnapshots', id, blockHeight: 99, timestamp: 7000,
      data: { assetId: KUSD, type: 'HOUR', closeEvidence: { xorPool: { baseAssetReserves: '1' } } } }]]);
    const row = buildAssetHourlyCloseDocumentsAtBoundary(source).find((item) => item.data.assetId === KUSD)!;
    expect(row.data.closeEvidence).not.toHaveProperty('xorPool');
  });

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
function collector(snapshotRetentionMode: 'all' | 'rolling' = 'all') {
  const repository = new MemoryRepository();
  const worker = new ChainIndexer({ ...readConfig(), priceStreamRefreshIntervalBlocks: 0, snapshotRetentionMode }, repository);
  const internal = worker as unknown as {
    api: unknown;
    observedGenesisHash: string;
    previousHourlyHistoryBlock: HourlyBoundaryBlock | null;
    getHistoricalValuationQueryAt: (height: number) => Promise<unknown>;
    prepareHistoricalValuationAdvance: (...args: unknown[]) => Promise<unknown>;
    indexFetchedBlock: (block: unknown, options: unknown) => Promise<void>;
    createAssetDocuments: (...args: unknown[]) => Promise<IndexerDocument[]>;
    retireExpiredChartSnapshotBuckets: (groups: unknown[], height: number, timestamp: number) => Promise<void>;
  };
  internal.observedGenesisHash = HOURLY_HISTORY_GENESIS;
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
    requestedHash: after.hash, timestamp: after.timestamp, events: [],
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
    expect(snapshots.find((row) => row.data.assetId === KUSD)?.data.closeEvidence).toHaveProperty('xorPool', null);
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
    const test = collector('rolling');
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
