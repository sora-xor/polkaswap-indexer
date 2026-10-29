import { describe, expect, it } from 'vitest';

import { readConfig } from '../src/config.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { ChainIndexer } from '../src/worker/chain.js';
import {
  buildAssetHourlyCloseDocumentsAtBoundary,
  deriveAssetPrices,
  HOURLY_HISTORY_GENESIS,
  type HourlyAssetMetadata,
  type HourlyPoolReserves,
} from '../src/worker/hourly-history.js';

const SCALE = 10n ** 18n;
const XOR = '0x0200000000000000000000000000000000000000000000000000000000000000';
const DAI = '0x0200060000000000000000000000000000000000000000000000000000000000';
const ETH = '0x0200070000000000000000000000000000000000000000000000000000000000';
const XSTUSD = '0x0200080000000000000000000000000000000000000000000000000000000000';
const XST = '0x0200090000000000000000000000000000000000000000000000000000000000';
const TBCD = '0x02000a0000000000000000000000000000000000000000000000000000000000';
const KUSD = '0x02000c0000000000000000000000000000000000000000000000000000000000';
const VAL = '0x0200040000000000000000000000000000000000000000000000000000000000';
const VXOR = '0x006a271832f44c93bd8692584d85415f0f3dccef9748fecd129442c8edcb4361';
const DEO = '0x00f2f4fda40a4bf1fc3769d156fa695532eec31e265d75068524462c0b80f674';
const CERES = '0x008bcfd2387d3fc453333557eecb0efe59fcba128769b2feefdd306e98e66440';
const TOKEN = `0x${'c'.repeat(64)}`;

/** Exact natural amount in 18-decimal base units, e.g. units(103_860n, 3) is 103.860. */
const units = (value: bigint, fractionDigits = 0): bigint => (value * SCALE) / 10n ** BigInt(fractionDigits);
/** The discovery formula for an 18-decimal pair: anchored USD divided by the priced reserve. */
const quote = (anchorReserve: bigint, anchorPrice: bigint, pricedReserve: bigint): bigint =>
  (((anchorReserve * anchorPrice) / SCALE) * SCALE) / pricedReserve;
const pool = (baseAssetId: string, baseAssetReserves: bigint, targetAssetId: string, targetAssetReserves: bigint): HourlyPoolReserves =>
  ({ baseAssetId, targetAssetId, baseAssetReserves, targetAssetReserves });
const metadata = (entries: Array<[string, string]>): Map<string, HourlyAssetMetadata> =>
  new Map(entries.map(([id, symbol]) => [id, { id, symbol, decimals: 18 }]));
const routeKeys = (route: readonly HourlyPoolReserves[] | undefined): string[] | undefined =>
  route?.map((item) => `${item.baseAssetId}:${item.targetAssetId}`);

const assets = metadata([
  [XOR, 'XOR'], [DAI, 'DAI'], [KUSD, 'KUSD'], [XSTUSD, 'XSTUSD'], [ETH, 'ETH'], [VXOR, 'VXOR'],
  [VAL, 'VAL'], [TBCD, 'TBCD'], [DEO, 'DEO'], [XST, 'XST'], [CERES, 'CERES'], [TOKEN, 'TOKEN'],
]);

// Finalized SORA mainnet reserves on 2026-10-13: XOR is anchored by DAI, and ETH has pools on
// all four DEXes, each holding less than half an ETH.
const XOR_DAI = pool(XOR, units(143_150n, 3), DAI, units(809n));
const XOR_KUSD = pool(XOR, units(39_500n, 3), KUSD, units(448_200n, 3));
const XOR_ETH = pool(XOR, units(103_860n, 3), ETH, units(246_340n, 6));
const KUSD_ETH = pool(KUSD, units(996_400n, 3), ETH, units(232_820n, 6));
const XSTUSD_ETH = pool(XSTUSD, units(1_656_900n, 3), ETH, units(17_940n, 6));
const VXOR_ETH = pool(VXOR, units(926_004n), ETH, units(438n, 6));
const mainnetPools = [XOR_DAI, XOR_KUSD, KUSD_ETH, XSTUSD_ETH, VXOR_ETH, XOR_ETH];
const XOR_PRICE = quote(XOR_DAI.targetAssetReserves, SCALE, XOR_DAI.baseAssetReserves);

/** The live projection path must keep using the same discovery as hourly closes. */
function livePrices(pools: HourlyPoolReserves[]): Map<string, bigint> {
  const indexer = new ChainIndexer({ ...readConfig(), priceStreamRefreshIntervalBlocks: 0 }, new MemoryRepository()) as unknown as {
    derivePrices: (assets: Map<string, HourlyAssetMetadata>, pools: HourlyPoolReserves[]) => Map<string, bigint>;
  };
  return indexer.derivePrices(assets, pools);
}

describe('price discovery route selection', () => {
  it('prices ETH from its direct XOR pair although every ETH pool holds under half an ETH', () => {
    const routes = new Map<string, HourlyPoolReserves[]>();
    const prices = deriveAssetPrices(assets, mainnetPools, routes);

    expect(prices.get(XOR)).toBe(XOR_PRICE);
    expect(prices.get(ETH)).toBe(quote(XOR_ETH.baseAssetReserves, XOR_PRICE, XOR_ETH.targetAssetReserves));
    expect(prices.get(ETH)).toBeGreaterThan(2_382n * SCALE);
    expect(prices.get(ETH)).toBeLessThan(2_383n * SCALE);
    expect(routeKeys(routes.get(ETH))).toEqual([`${XOR}:${DAI}`, `${XOR}:${ETH}`]);
    expect(livePrices(mainnetPools)).toEqual(prices);
  });

  it('keeps the XOR/ETH quote when a 0.014 ETH purchase leaves it less ETH than KUSD/ETH', () => {
    // Constant-product state after buying 0.014 ETH from XOR/ETH (fees ignored). Ranking by ETH
    // depth alone would now pick KUSD/ETH and publish ~$4,280 from the $1-assumed KUSD.
    const bought = pool(XOR, units(110_118n, 3), ETH, units(232_340n, 6));
    expect(bought.targetAssetReserves).toBeLessThan(KUSD_ETH.targetAssetReserves);
    const pools = [...mainnetPools.filter((item) => item !== XOR_ETH), bought];
    const routes = new Map<string, HourlyPoolReserves[]>();
    const prices = deriveAssetPrices(assets, pools, routes);

    expect(prices.get(ETH)).toBe(quote(bought.baseAssetReserves, XOR_PRICE, bought.targetAssetReserves));
    expect(prices.get(ETH)).toBeLessThan(2_700n * SCALE);
    expect(routeKeys(routes.get(ETH))).toEqual([`${XOR}:${DAI}`, `${XOR}:${ETH}`]);

    // Route quality, not depth, separates the tiers: even a ten times deeper KUSD pool does not win.
    const deepKusd = pool(KUSD, units(9_964n), ETH, units(2_328_200n, 6));
    expect(deriveAssetPrices(assets, [XOR_DAI, deepKusd, bought]).get(ETH)).toBe(prices.get(ETH));
  });

  it('re-routes an asset from a deeper KUSD quote to its gated direct XOR pair', () => {
    // VAL on 2026-10-13: KUSD/VAL held 4.5% more VAL, so VAL used the $1-assumed KUSD quote.
    const xorVal = pool(XOR, units(44_382n, 3), VAL, units(34_709n));
    const kusdVal = pool(KUSD, units(438_358n, 3), VAL, units(36_282n));
    const prices = deriveAssetPrices(assets, [XOR_DAI, kusdVal, xorVal]);

    expect(prices.get(VAL)).toBe(quote(xorVal.baseAssetReserves, XOR_PRICE, xorVal.targetAssetReserves));
    expect(prices.get(VAL)).not.toBe(quote(kusdVal.baseAssetReserves, SCALE, kusdVal.targetAssetReserves));
  });

  it('rejects dust direct XOR pairs and keeps the legacy floor on other routes', () => {
    // A pool holding under 1/100 of the asset's deepest reserve cannot outrank that market...
    const dustXor = pool(XOR, units(50n), TOKEN, units(1n, 4));
    const deepKusd = pool(KUSD, units(2_000n), TOKEN, units(1_000n));
    const routes = new Map<string, HourlyPoolReserves[]>();
    expect(deriveAssetPrices(assets, [XOR_DAI, dustXor, deepKusd], routes).get(TOKEN)).toBe(2n * SCALE);
    expect(routeKeys(routes.get(TOKEN))).toEqual([`${KUSD}:${TOKEN}`]);
    // ...and does not price the asset when that market is too shallow to be an oracle.
    expect(deriveAssetPrices(assets, [XOR_DAI, dustXor, pool(KUSD, units(50n), TOKEN, units(1_000n))]).has(TOKEN)).toBe(false);
    // At exactly 1/100 of the deepest reserve it is no longer dust.
    const edge = pool(XOR, units(50n), TOKEN, units(10n));
    expect(deriveAssetPrices(assets, [XOR_DAI, edge, deepKusd]).get(TOKEN)).toBe(quote(edge.baseAssetReserves, XOR_PRICE, units(10n)));

    // Non-XOR routes keep requiring half a token, so no XSTUSD-only fraction becomes a price.
    expect(deriveAssetPrices(assets, [pool(XSTUSD, units(161_462n, 3), CERES, units(311_506n, 6))]).has(CERES)).toBe(false);
    expect(deriveAssetPrices(assets, [XOR_DAI, KUSD_ETH, XSTUSD_ETH, VXOR_ETH]).has(ETH)).toBe(false);
  });

  it('still rejects shallow direct XOR pairs and shallow XOR anchors', () => {
    // 15 XOR is about $85, below the $100 anchored-liquidity gate.
    expect(deriveAssetPrices(assets, [XOR_DAI, pool(XOR, units(15n), ETH, units(35n, 3))]).has(ETH)).toBe(false);
    // XOR itself is unpriced when its only stable pool holds $90, so no XOR pair can price ETH.
    const prices = deriveAssetPrices(assets, [pool(XOR, units(16n), DAI, units(90n)), XOR_ETH]);
    expect(prices.has(XOR)).toBe(false);
    expect(prices.has(ETH)).toBe(false);
  });

  it('leaves assets with a single route type unchanged', () => {
    const pools = [
      pool(XOR, units(100n), DAI, units(500n)),
      pool(XOR, units(40n), TBCD, units(8n)),
      pool(KUSD, units(200n), DEO, units(50_000n)),
      pool(XSTUSD, units(1_000n), XST, units(1_000_000_000n)),
    ];
    const routes = new Map<string, HourlyPoolReserves[]>();
    const prices = deriveAssetPrices(assets, pools, routes);

    expect(Object.fromEntries(prices)).toEqual({
      [DAI]: SCALE, [KUSD]: SCALE, [XSTUSD]: SCALE,
      [XOR]: 5n * SCALE, [TBCD]: 25n * SCALE, [DEO]: 4n * 10n ** 15n, [XST]: 10n ** 12n,
    });
    expect(routeKeys(routes.get(TBCD))).toEqual([`${XOR}:${DAI}`, `${XOR}:${TBCD}`]);
    expect(routeKeys(routes.get(DEO))).toEqual([`${KUSD}:${DEO}`]);
    expect(routeKeys(routes.get(XST))).toEqual([`${XSTUSD}:${XST}`]);
    expect(livePrices(pools)).toEqual(prices);
  });

  it('turns an ETH hourly close from price-unavailable into a priced close with its route', () => {
    const routes = new Map<string, HourlyPoolReserves[]>();
    const prices = deriveAssetPrices(assets, mainnetPools, routes);
    const [row] = buildAssetHourlyCloseDocumentsAtBoundary({
      before: { height: 100, hash: `0x${'1'.repeat(64)}`, timestamp: 7199 },
      after: { height: 101, hash: `0x${'2'.repeat(64)}`, timestamp: 7201 },
      genesisHash: HOURLY_HISTORY_GENESIS,
      denominator: '100000000000000000000000000000000000000',
      assets, prices, pools: mainnetPools, priceRoutes: routes, xorPoolsComplete: true,
      targets: [{ id: ETH, symbol: 'ETH' }],
    });

    expect(row?.data.priceUSD).toEqual({ close: expect.stringMatching(/^2382\.\d+$/) });
    expect(row?.data.closeEvidence).toMatchObject({
      availability: 'priced', marketStatus: 'priced', symbol: 'ETH',
      pools: [
        { baseAssetId: XOR, targetAssetId: DAI },
        { baseAssetId: XOR, targetAssetId: ETH, targetAssetReserves: XOR_ETH.targetAssetReserves.toString() },
      ],
      xorPool: { baseAssetId: XOR, targetAssetId: ETH, targetAssetReserves: XOR_ETH.targetAssetReserves.toString() },
    });
  });
});

const STABLES = new Set([DAI, XSTUSD, KUSD]);
const HMX = `0x${'d'.repeat(64)}`;
const LEFT = `0x${'e'.repeat(64)}`;
const RIGHT = `0x${'f'.repeat(64)}`;
const layeredAssets = new Map([
  ...assets, ...metadata([[HMX, 'HMX'], [LEFT, 'LEFT'], [RIGHT, 'RIGHT']]),
]);

function* permutations<T>(items: readonly T[]): Generator<T[]> {
  if (items.length <= 1) {
    yield [...items];
    return;
  }
  for (let index = 0; index < items.length; index += 1) {
    for (const tail of permutations([...items.slice(0, index), ...items.slice(index + 1)])) yield [items[index]!, ...tail];
  }
}

/** Prices and routes in a pool-order-independent form. */
function discover(pools: HourlyPoolReserves[]): { prices: Map<string, bigint>; routes: Map<string, HourlyPoolReserves[]>; snapshot: string } {
  const routes = new Map<string, HourlyPoolReserves[]>();
  const prices = deriveAssetPrices(layeredAssets, pools, routes);
  const snapshot = JSON.stringify([...prices].sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([id, price]) => [id, price.toString(), routeKeys(routes.get(id))]));
  return { prices, routes, snapshot };
}

/** Each route walks from a fixed stable to its asset, visits every asset once and reproduces the price. */
function expectReplayableRoutes(prices: Map<string, bigint>, routes: Map<string, HourlyPoolReserves[]>): void {
  for (const [assetId, price] of prices) {
    const route = routes.get(assetId)!;
    if (STABLES.has(assetId)) {
      expect(route).toEqual([]);
      continue;
    }
    let current = STABLES.has(route[0]!.baseAssetId) ? route[0]!.baseAssetId : route[0]!.targetAssetId;
    const visited = [current];
    let value = SCALE;
    for (const hop of route) {
      const forward = hop.baseAssetId === current;
      expect(forward || hop.targetAssetId === current).toBe(true);
      value = quote(forward ? hop.baseAssetReserves : hop.targetAssetReserves, value, forward ? hop.targetAssetReserves : hop.baseAssetReserves);
      current = forward ? hop.targetAssetId : hop.baseAssetId;
      visited.push(current);
    }
    expect(STABLES.has(visited[0]!)).toBe(true);
    expect(current).toBe(assetId);
    expect(new Set(visited).size).toBe(visited.length);
    expect(value).toBe(price);
  }
}

describe('layered, order-independent price discovery', () => {
  it('freezes XOR from its stable pools before quoting direct XOR pairs, in any pool order', () => {
    // A provisional KUSD quote ($20) seen first used to leave ETH at $4,000 instead of $1,000.
    const xorDai = pool(XOR, units(100n), DAI, units(500n));
    const xorEth = pool(XOR, units(20n), ETH, units(1n, 1));
    for (const order of permutations([pool(XOR, units(50n), KUSD, units(1_000n)), xorEth, xorDai])) {
      const { prices, routes } = discover(order);
      expect(prices.get(XOR)).toBe(5n * SCALE);
      expect(prices.get(ETH)).toBe(1_000n * SCALE);
      expect(routeKeys(routes.get(ETH))).toEqual([`${XOR}:${DAI}`, `${XOR}:${ETH}`]);
      expectReplayableRoutes(prices, routes);
    }
  });

  it('never lets a derived token reprice XOR through a deeper XOR pool', () => {
    // KUSD/ETH implies $1,000 per ETH; XOR/ETH then implied XOR = $50 although XOR/DAI says $5.
    const pools = [pool(KUSD, units(1_000n), ETH, units(1n)), pool(XOR, units(200n), ETH, units(10n)), pool(XOR, units(100n), DAI, units(500n))];
    for (const order of permutations(pools)) {
      const { prices, routes } = discover(order);
      expect(prices.get(XOR)).toBe(5n * SCALE);
      expect(routeKeys(routes.get(XOR))).toEqual([`${XOR}:${DAI}`]);
      expect(prices.get(ETH)).toBe(100n * SCALE);
      expect(routeKeys(routes.get(ETH))).toEqual([`${XOR}:${DAI}`, `${XOR}:${ETH}`]);
    }
  });

  it('does not route an asset through a market that it prices itself', () => {
    // LEFT and RIGHT are each other's deepest market; each keeps its own stable quote.
    const pools = [pool(KUSD, units(200n), LEFT, units(100n)), pool(KUSD, units(300n), RIGHT, units(100n)), pool(LEFT, units(10_000n), RIGHT, units(10_000n))];
    for (const order of permutations(pools)) {
      const { prices, routes } = discover(order);
      expect(prices.get(LEFT)).toBe(2n * SCALE);
      expect(prices.get(RIGHT)).toBe(3n * SCALE);
      expectReplayableRoutes(prices, routes);
    }
  });

  it('publishes identical prices and replayable routes for every order of a multi-hop pool set', () => {
    const pools = [
      XOR_KUSD, XOR_DAI, XOR_ETH,
      pool(KUSD, units(2_000n), ETH, units(6n, 1)),
      pool(VXOR, units(50_000n), ETH, units(2n, 1)),
      pool(VXOR, units(1_000_000n), HMX, units(70_000n)),
      pool(KUSD, units(14n), HMX, units(29_000n)),
    ];
    const reference = discover(pools);
    expect(routeKeys(reference.routes.get(XOR))).toEqual([`${XOR}:${DAI}`]);
    expect(routeKeys(reference.routes.get(ETH))).toEqual([`${XOR}:${DAI}`, `${XOR}:${ETH}`]);
    expect(routeKeys(reference.routes.get(VXOR))).toEqual([`${XOR}:${DAI}`, `${XOR}:${ETH}`, `${VXOR}:${ETH}`]);
    expect(routeKeys(reference.routes.get(HMX))).toEqual([`${XOR}:${DAI}`, `${XOR}:${ETH}`, `${VXOR}:${ETH}`, `${VXOR}:${HMX}`]);
    expectReplayableRoutes(reference.prices, reference.routes);
    let orders = 0;
    for (const order of permutations(pools)) {
      expect(discover(order).snapshot).toBe(reference.snapshot);
      orders += 1;
    }
    expect(orders).toBe(5_040);
  });

  it('replays every route on the 2026-10-13 mainnet fixture', () => {
    const { prices, routes } = discover(mainnetPools);
    expectReplayableRoutes(prices, routes);
  });
});
