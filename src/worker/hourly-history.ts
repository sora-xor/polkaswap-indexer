import type { IndexerDocument } from '../repository/types.js';

/** Provenance descriptor for an explicitly requested hourly-history asset. */
export type HourlyHistoryTarget = { id: string; symbol: string };
export const MAX_HOURLY_HISTORY_TARGETS = 512;

/** Immutable seven-asset defaults retained by the original v1 archive contract. */
export const HOURLY_HISTORY_ASSETS = Object.freeze([
  { id: '0x0200000000000000000000000000000000000000000000000000000000000000', symbol: 'XOR' },
  { id: '0x0200040000000000000000000000000000000000000000000000000000000000', symbol: 'VAL' },
  { id: '0x0200050000000000000000000000000000000000000000000000000000000000', symbol: 'PSWAP' },
  { id: '0x0200060000000000000000000000000000000000000000000000000000000000', symbol: 'DAI' },
  { id: '0x02000c0000000000000000000000000000000000000000000000000000000000', symbol: 'KUSD' },
  { id: '0x00513be65493a7fc3e2128d4230061a530acf40478a4affa20bbba27a310673e', symbol: 'LLD' },
  { id: '0x00073edd278e1bd6a7f9d0b27d4f3e93b73c8f0832b58a4df13c69611a99f156', symbol: 'LLM' },
].map((asset) => Object.freeze(asset)));
export const HOURLY_HISTORY_ASSET_IDS: ReadonlySet<string> = new Set(HOURLY_HISTORY_ASSETS.map(({ id }) => id));
export const HOURLY_HISTORY_GENESIS = '0x7e4e32d0feafd4f9c9414b0be86373f9a1efa904809b683453a9af6856d38ad5';
export const HOUR_SECONDS = 3600;
const SCALE = 10n ** 18n;
const CANONICAL_ASSET_ID = /^0x[0-9a-f]{64}$/;
const KNOWN_ASSET_SYMBOLS = new Map(HOURLY_HISTORY_ASSETS.map(({ id, symbol }) => [id, symbol]));
const validSymbol = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
const STABLE_ASSET_IDS = new Set([
  '0x0200060000000000000000000000000000000000000000000000000000000000',
  '0x0200080000000000000000000000000000000000000000000000000000000000',
  '0x02000c0000000000000000000000000000000000000000000000000000000000',
]);
// Preserve the existing global-price policy: shallow pools cannot become oracles.
const MIN_PRICE_DISCOVERY_LIQUIDITY_USD = 100n * SCALE;
// Legacy absolute floor (0.5 natural tokens), kept for every candidate except a non-dust
// direct XOR pair. The other routes are anchored on the $1-assumed KUSD/XSTUSD DEX bases or
// on derived tokens, so their USD gate cannot vouch for a shallow pool. Dropping it would newly
// price XSTUSD-only tokens from pools holding a fraction of a token (CERES at ~$518 and XSTBTC
// at ~$134,668 on 2026-10-13 mainnet state).
const MIN_PRICE_DISCOVERY_AMOUNT = SCALE / 2n;
// A direct XOR quote is dust when its pool holds less than 1/100 of the asset's deepest
// reserve in any pool. The ratio has no unit, so it suits high-value tokens and any precision.
const DIRECT_XOR_DUST_DIVISOR = 100n;
const XOR_ASSET_ID = HOURLY_HISTORY_ASSETS[0]!.id;
const scaledMul = (left: bigint, right: bigint): bigint => (left * right) / SCALE;
const scaledDiv = (left: bigint, right: bigint): bigint => right === 0n ? 0n : (left * SCALE) / right;
const reserveToNaturalScaled = (reserve: bigint, decimals: number): bigint => scaledDiv(reserve, 10n ** BigInt(decimals));

export interface HourlyAssetMetadata { id: string; symbol: string; decimals: number }
export interface HourlyPoolReserves { baseAssetId: string; targetAssetId: string; baseAssetReserves: bigint; targetAssetReserves: bigint }
/** Immutable finalized block evidence, using chain timestamp seconds. */
export interface HourlyBoundaryBlock { height: number; hash: string; timestamp: number }
export interface AssetHourlyCloseInput {
  before: HourlyBoundaryBlock;
  after: HourlyBoundaryBlock;
  genesisHash: string;
  denominator: string;
  assets: Map<string, HourlyAssetMetadata>;
  /** Explicit scope; omitting it preserves v1's seven assets. Price-route assets never enlarge this scope. */
  targets?: readonly HourlyHistoryTarget[];
  /** Exact scaled USD prices derived from the same state as metadata and denominator. */
  prices: Map<string, bigint>;
  /** Optional same-state reserve evidence; only pools touching the requested asset are retained. */
  pools?: readonly HourlyPoolReserves[];
  /** True only when every direct XOR pool was observed at this same historical state. Legacy pruned lists omit it. */
  xorPoolsComplete?: true;
  /** Winning discovery path, including stable-anchor legs, for each eligible USD price. */
  priceRoutes?: Map<string, readonly HourlyPoolReserves[]>;
  previous?: Map<string, IndexerDocument>;
}

export interface DirectXorPoolEvidence {
  baseAssetId: string;
  targetAssetId: string;
  baseAssetReserves: string;
  targetAssetReserves: string;
  baseDecimals: number;
  targetDecimals: number;
}

/** Validate and clone a bounded catalogue without replacing its requested symbols with current metadata. */
export function validateHourlyHistoryTargets(targets: unknown): HourlyHistoryTarget[] {
  if (!Array.isArray(targets) || targets.length === 0 || targets.length > MAX_HOURLY_HISTORY_TARGETS) {
    throw new Error('Invalid hourly history target count');
  }
  const seen = new Set<string>();
  return Array.from(targets, (target: unknown) => {
    if (!target || typeof target !== 'object' || Object.getPrototypeOf(target) !== Object.prototype) {
      throw new Error('Invalid hourly history target');
    }
    const fields = Reflect.ownKeys(target);
    const idField = Object.getOwnPropertyDescriptor(target, 'id');
    const symbolField = Object.getOwnPropertyDescriptor(target, 'symbol');
    if (fields.length !== 2 || !fields.includes('id') || !fields.includes('symbol') ||
        !idField || !symbolField || !('value' in idField) || !('value' in symbolField) ||
        !idField.enumerable || !symbolField.enumerable) {
      throw new Error('Invalid hourly history target fields');
    }
    const id: unknown = idField.value, symbol: unknown = symbolField.value;
    if (typeof id !== 'string' || !CANONICAL_ASSET_ID.test(id) || !validSymbol(symbol) || seen.has(id) ||
        (KNOWN_ASSET_SYMBOLS.has(id) && KNOWN_ASSET_SYMBOLS.get(id) !== symbol)) {
      throw new Error('Invalid or duplicate hourly history target identity');
    }
    seen.add(id);
    return { id, symbol };
  });
}

function validateMetadata(id: string, metadata: HourlyAssetMetadata, message: string): void {
  if (!CANONICAL_ASSET_ID.test(id) || !metadata || metadata.id !== id || !validSymbol(metadata.symbol) ||
      !Number.isSafeInteger(metadata.decimals) || metadata.decimals < 0 || metadata.decimals > 36 ||
      (KNOWN_ASSET_SYMBOLS.has(id) && KNOWN_ASSET_SYMBOLS.get(id) !== metadata.symbol)) {
    throw new Error(message);
  }
}

function validateReserves(pool: HourlyPoolReserves): void {
  for (const value of [pool.baseAssetReserves, pool.targetAssetReserves]) {
    if (typeof value !== 'bigint' || value < 0n || value >= (1n << 128n)) throw new Error('Invalid direct XOR pool reserves');
  }
}

/**
 * Select from complete same-state metadata and pools supplied by the historical worker.
 * Union prior provenance with actual positive direct XOR pools above one canonical XOR18;
 * retain dropped/absent targets so later hours can record their truthful unavailability.
 * This catalogue does not supply USD prices or turn incidental pricing-route assets into targets.
 */
export function selectHourlyHistoryTargets(
  assets: Map<string, HourlyAssetMetadata>,
  pools: readonly HourlyPoolReserves[],
  previousTargets: readonly HourlyHistoryTarget[] = HOURLY_HISTORY_ASSETS,
): HourlyHistoryTarget[] {
  const targets = new Map(validateHourlyHistoryTargets(previousTargets).map((target) => [target.id, target]));
  if (!(assets instanceof Map) || !Array.isArray(pools)) throw new Error('Complete historical hourly state required');
  const xorId = HOURLY_HISTORY_ASSETS[0]!.id;
  const xor = assets.get(xorId);
  if (!xor) throw new Error('Canonical XOR18 metadata required for hourly target selection');
  validateMetadata(xorId, xor, 'Hourly target metadata mismatch');
  if (xor.decimals !== 18) throw new Error('Canonical XOR18 metadata required for hourly target selection');
  for (const id of targets.keys()) {
    const metadata = assets.get(id);
    if (metadata) validateMetadata(id, metadata, 'Hourly target metadata mismatch');
  }
  const direct = new Set<string>();
  for (const pool of pools) {
    // Incidental pricing-route pools and metadata do not enlarge or invalidate the requested catalogue.
    if (!pool || (pool.baseAssetId !== xorId && pool.targetAssetId !== xorId)) continue;
    if (!CANONICAL_ASSET_ID.test(pool.baseAssetId) || !CANONICAL_ASSET_ID.test(pool.targetAssetId) ||
        pool.baseAssetId === pool.targetAssetId) throw new Error('Invalid hourly target pool identity');
    validateReserves(pool);
    const forward = pool.baseAssetId === xorId;
    const id = forward ? pool.targetAssetId : pool.baseAssetId;
    if (direct.has(id)) throw new Error('Ambiguous direct XOR pool evidence');
    direct.add(id);
    const metadata = assets.get(id);
    const xorReserve = forward ? pool.baseAssetReserves : pool.targetAssetReserves;
    const targetReserve = forward ? pool.targetAssetReserves : pool.baseAssetReserves;
    if (!metadata || xorReserve <= SCALE || targetReserve === 0n) continue;
    validateMetadata(id, metadata, 'Hourly target metadata mismatch');
    // A historical rename is observed in closeEvidence; its prior requestedSymbol remains provenance.
    if (!targets.has(id)) targets.set(id, { id, symbol: metadata.symbol });
    if (!targets.has(xorId)) targets.set(xorId, { id: xorId, symbol: xor.symbol });
    if (targets.size > MAX_HOURLY_HISTORY_TARGETS) throw new Error('Hourly history target limit exceeded');
  }
  return validateHourlyHistoryTargets([...targets.values()].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/** Preserve an actual direct-pair mark independently of the stable-anchored USD discovery route. */
export function directXorPoolEvidence(
  assetId: string,
  input: Pick<AssetHourlyCloseInput, 'assets' | 'pools' | 'xorPoolsComplete'>
): DirectXorPoolEvidence | null | undefined {
  if (!CANONICAL_ASSET_ID.test(assetId)) throw new Error('Direct XOR pool metadata mismatch');
  if (!input.xorPoolsComplete || !input.pools) return undefined;
  const xorId = HOURLY_HISTORY_ASSETS[0]!.id;
  const xor = input.assets.get(xorId), asset = input.assets.get(assetId);
  if (!xor || !asset) return undefined;
  validateMetadata(xorId, xor, 'Direct XOR pool metadata mismatch');
  if (xor.decimals !== 18) throw new Error('Canonical XOR18 metadata required for direct XOR pool evidence');
  validateMetadata(assetId, asset, 'Direct XOR pool metadata mismatch');
  if (assetId === xorId) return null;
  const matches = input.pools.filter((pool) =>
    (pool.baseAssetId === xorId && pool.targetAssetId === assetId) ||
    (pool.baseAssetId === assetId && pool.targetAssetId === xorId));
  if (matches.length > 1) throw new Error('Ambiguous direct XOR pool evidence');
  const pool = matches[0];
  if (!pool) return null;
  validateReserves(pool);
  const forward = pool.baseAssetId === xorId;
  return {
    baseAssetId: xorId, targetAssetId: assetId,
    baseAssetReserves: (forward ? pool.baseAssetReserves : pool.targetAssetReserves).toString(),
    targetAssetReserves: (forward ? pool.targetAssetReserves : pool.baseAssetReserves).toString(),
    baseDecimals: xor.decimals, targetDecimals: asset.decimals,
  };
}

/**
 * Shared stable-anchored, liquidity-gated pool valuation; no latest-state inputs. The worker's
 * current projections, price stream, historical valuation and hourly closes all use it.
 *
 * Prices are assigned once, in layers, so neither pool order nor a cycle can change them:
 * 1. DAI, XSTUSD and KUSD are fixed at $1.
 * 2. XOR is quoted only from pools pairing it with one of those stables: deepest XOR reserve,
 *    then the larger stable side. No derived token can reprice it afterwards.
 * 3. Every other asset is quoted from anchors priced in an earlier layer: first the stables and
 *    XOR, then the assets priced in that layer, and so on. A quote is final once published, so
 *    an asset reachable in fewer hops is never requoted through a deeper multi-hop pool. Within
 *    a layer a non-dust direct XOR pair outranks other anchors, then the deeper reserve of the
 *    priced asset wins, then the larger anchored liquidity, then the pool key. A route never
 *    revisits an asset, and its pools reproduce the published price exactly.
 *
 * Direct XOR pairs outrank the other DEX bases because KUSD and XSTUSD are fixed at $1 here
 * but trade well below it on-chain, and VXOR or multi-hop anchors are derived. Token depth alone
 * is not comparable across those anchors: ranking by it would let a 0.014 ETH trade move ETH
 * between its XOR/ETH and KUSD/ETH quotes, which differ by almost 2x. Re-ranking every asset
 * from the previous round's prices instead of using layers is not safe: two assets that are each
 * other's deepest market alternate between routes through each other and their own anchors.
 *
 * Every candidate needs $100 of anchored liquidity, the minimum along its route. A direct XOR
 * pair must also hold at least 1/100 of the asset's deepest pool reserve, instead of 0.5 tokens,
 * which excluded high-value assets such as ETH. A pair that fails this check, and every other
 * route, keeps the 0.5-token floor.
 */
export function deriveAssetPrices(
  assets: Map<string, Pick<HourlyAssetMetadata, 'id' | 'decimals'>>,
  pools: HourlyPoolReserves[],
  evidence?: Map<string, HourlyPoolReserves[]>
): Map<string, bigint> {
  evidence?.clear();
  // Positive reserves in natural units. The deepest reserve per asset does not depend on prices.
  const legs: Array<{ pool: HourlyPoolReserves; key: string; base: bigint; target: bigint }> = [];
  const deepestReserve = new Map<string, bigint>();
  for (const pool of pools) {
    const baseInfo = assets.get(pool.baseAssetId);
    const targetInfo = assets.get(pool.targetAssetId);
    if (!baseInfo || !targetInfo || pool.baseAssetReserves === 0n || pool.targetAssetReserves === 0n) continue;
    const base = reserveToNaturalScaled(pool.baseAssetReserves, baseInfo.decimals);
    const target = reserveToNaturalScaled(pool.targetAssetReserves, targetInfo.decimals);
    if (base === 0n || target === 0n) continue;
    legs.push({ pool, key: `${pool.baseAssetId}:${pool.targetAssetId}`, base, target });
    if (base > (deepestReserve.get(pool.baseAssetId) ?? 0n)) deepestReserve.set(pool.baseAssetId, base);
    if (target > (deepestReserve.get(pool.targetAssetId) ?? 0n)) deepestReserve.set(pool.targetAssetId, target);
  }

  // Final quotes. A fixed stable has no liquidity bound of its own.
  type Quote = { price: bigint; confidence: bigint | null; route: HourlyPoolReserves[] };
  type Candidate = Quote & { confidence: bigint; tier: number; depth: bigint; key: string };
  const quotes = new Map<string, Quote>();
  for (const asset of assets.values()) {
    if (STABLE_ASSET_IDS.has(asset.id)) quotes.set(asset.id, { price: SCALE, confidence: null, route: [] });
  }
  const outranks = (next: Candidate, current: Candidate | undefined): boolean => {
    if (!current) return true;
    if (next.tier !== current.tier) return next.tier > current.tier;
    if (next.depth !== current.depth) return next.depth > current.depth;
    if (next.confidence !== current.confidence) return next.confidence > current.confidence;
    return next.key < current.key;
  };

  /** Quotes each eligible unpriced asset from anchors priced before this layer; returns the count. */
  const priceLayer = (eligible: (assetId: string) => boolean, isAnchor: (assetId: string) => boolean): number => {
    const best = new Map<string, Candidate>();
    for (const leg of legs) {
      const sides = [
        [leg.pool.targetAssetId, leg.target, leg.pool.baseAssetId, leg.base],
        [leg.pool.baseAssetId, leg.base, leg.pool.targetAssetId, leg.target],
      ] as const;
      for (const [assetId, depth, anchorId, anchorNatural] of sides) {
        const anchor = quotes.get(anchorId);
        if (!anchor || quotes.has(assetId) || !eligible(assetId) || !isAnchor(anchorId)) continue;
        const anchoredUSD = scaledMul(anchorNatural, anchor.price);
        const confidence = anchor.confidence !== null && anchor.confidence < anchoredUSD ? anchor.confidence : anchoredUSD;
        const price = scaledDiv(anchoredUSD, depth);
        if (price <= 0n || confidence < MIN_PRICE_DISCOVERY_LIQUIDITY_USD) continue;
        const tier = anchorId === XOR_ASSET_ID && depth * DIRECT_XOR_DUST_DIVISOR >= (deepestReserve.get(assetId) ?? 0n) ? 1 : 0;
        if (tier === 0 && depth < MIN_PRICE_DISCOVERY_AMOUNT) continue;
        const candidate = { price, confidence, route: [...anchor.route, leg.pool], tier, depth, key: leg.key };
        if (outranks(candidate, best.get(assetId))) best.set(assetId, candidate);
      }
    }
    for (const [assetId, { price, confidence, route }] of best) quotes.set(assetId, { price, confidence, route });
    return best.size;
  };

  priceLayer((assetId) => assetId === XOR_ASSET_ID, (assetId) => STABLE_ASSET_IDS.has(assetId));
  for (let layer = 0; layer < 12; layer += 1) {
    if (!priceLayer((assetId) => assetId !== XOR_ASSET_ID, () => true)) break;
  }

  const prices = new Map<string, bigint>();
  for (const [assetId, quote] of quotes) {
    prices.set(assetId, quote.price);
    evidence?.set(assetId, quote.route.map((pool) => ({ ...pool })));
  }
  return prices;
}

/** Format a nonnegative scaled price exactly without float conversion or artificial precision. */
function priceString(value: bigint): string {
  const whole = value / SCALE;
  const fraction = (value % SCALE).toString().padStart(18, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** Stable existing collection id; source timestamps remain the actual last block of that hour. */
export function assetHourlyCloseId(assetId: string, timestamp: number): string {
  return `asset-${assetId}-HOUR-${Math.floor(timestamp / HOUR_SECONDS) * HOUR_SECONDS}`;
}

/**
 * Materialize a completed close only when adjacent finalized blocks bracket its hour.
 * No intervening halted hours, missing assets, OHLC extrema, or flow totals are invented.
 * Existing open/high/low and volume evidence is retained exactly, even when a corrected
 * CLOSE differs from legacy chart samples; closeEvidence identifies the corrected field.
 */
export function buildAssetHourlyCloseDocumentsAtBoundary(input: AssetHourlyCloseInput): IndexerDocument[] {
  const { before, after, assets, prices, denominator, genesisHash } = input;
  if (genesisHash !== HOURLY_HISTORY_GENESIS || !/^[1-9]\d{0,119}$/.test(denominator)) throw new Error('Unverified hourly history identity');
  for (const block of [before, after]) {
    if (!Number.isSafeInteger(block.height) || block.height < 1 || !Number.isSafeInteger(block.timestamp) || block.timestamp <= 0 || !/^0x[0-9a-f]{64}$/.test(block.hash)) throw new Error('Invalid hourly boundary block');
  }
  const completedAt = (Math.floor(before.timestamp / HOUR_SECONDS) + 1) * HOUR_SECONDS;
  if (after.height !== before.height + 1 || before.timestamp >= after.timestamp || after.timestamp < completedAt) throw new Error('Unproven completed hourly close');
  const documents: IndexerDocument[] = [];
  for (const required of validateHourlyHistoryTargets(input.targets === undefined ? HOURLY_HISTORY_ASSETS : input.targets)) {
    const metadata = assets.get(required.id), price = prices.get(required.id);
    if (metadata) validateMetadata(required.id, metadata, `Hourly history metadata mismatch: ${required.symbol}`);
    const availability = !metadata ? 'metadata-unavailable' : price === undefined || price <= 0n ? 'price-unavailable' : 'priced';
    const observedPools = input.pools?.filter((pool) => pool.baseAssetId === required.id || pool.targetAssetId === required.id);
    const evidencePools = availability === 'priced' ? input.priceRoutes?.get(required.id) ?? observedPools : observedPools;
    const xorPool = directXorPoolEvidence(required.id, input);
    const marketStatus = availability === 'priced' ? 'priced' : !observedPools ? 'unknown' : observedPools.some((pool) => pool.baseAssetReserves > 0n && pool.targetAssetReserves > 0n) ? 'liquidity-gate-or-route-unavailable' : 'no-observed-pool';
    const id = assetHourlyCloseId(required.id, before.timestamp);
    const previous = input.previous?.get(id);
    if (previous && (previous.collection !== 'assetSnapshots' || previous.data.assetId !== required.id || previous.data.type !== 'HOUR')) throw new Error('Hourly history row identity mismatch');
    const previousPrice = previous?.data.priceUSD;
    const priceUSD = previousPrice && typeof previousPrice === 'object' && !Array.isArray(previousPrice) ? { ...previousPrice } : {};
    documents.push({
      collection: 'assetSnapshots', id,
      // A chart projection for this hour can be at most before.height. Using the
      // observed successor as the write version also rejects already-built late
      // projections, while source height remains explicit in closeEvidence.
      blockHeight: Math.max(after.height, previous?.blockHeight ?? 0),
      timestamp: before.timestamp,
      data: {
        ...previous?.data, id, assetId: required.id, type: 'HOUR', timestamp: before.timestamp,
        denominator, priceUSD: { ...priceUSD, close: availability === 'priced' ? priceString(price!) : null },
        closeEvidence: {
          kind: 'finalized-hour-close', availability, marketStatus, genesisHash, completedAt,
          blockHeight: before.height, blockHash: before.hash, timestamp: before.timestamp,
          nextBlockHeight: after.height, nextBlockHash: after.hash, nextTimestamp: after.timestamp,
          requestedSymbol: required.symbol, symbol: metadata?.symbol ?? null, decimals: metadata?.decimals ?? null,
          ...(xorPool === undefined ? {} : { xorPool }),
          ...(evidencePools ? { poolObservationCount: evidencePools.length, poolObservationsTruncated: evidencePools.length > 16, pools: evidencePools.slice(0, 16).map((pool) => ({
            baseAssetId: pool.baseAssetId, targetAssetId: pool.targetAssetId,
            baseAssetReserves: pool.baseAssetReserves.toString(), targetAssetReserves: pool.targetAssetReserves.toString(),
          })) } : {}),
        },
      },
    });
  }
  return documents;
}
