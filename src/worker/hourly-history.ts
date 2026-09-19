import type { IndexerDocument } from '../repository/types.js';

/** Canonical SORA assets whose completed hourly evidence is retained durably. */
export const HOURLY_HISTORY_ASSETS = Object.freeze([
  { id: '0x0200000000000000000000000000000000000000000000000000000000000000', symbol: 'XOR' },
  { id: '0x0200040000000000000000000000000000000000000000000000000000000000', symbol: 'VAL' },
  { id: '0x0200050000000000000000000000000000000000000000000000000000000000', symbol: 'PSWAP' },
  { id: '0x0200060000000000000000000000000000000000000000000000000000000000', symbol: 'DAI' },
  { id: '0x02000c0000000000000000000000000000000000000000000000000000000000', symbol: 'KUSD' },
  { id: '0x00513be65493a7fc3e2128d4230061a530acf40478a4affa20bbba27a310673e', symbol: 'LLD' },
  { id: '0x00073edd278e1bd6a7f9d0b27d4f3e93b73c8f0832b58a4df13c69611a99f156', symbol: 'LLM' },
]);
export const HOURLY_HISTORY_ASSET_IDS = new Set(HOURLY_HISTORY_ASSETS.map(({ id }) => id));
export const HOURLY_HISTORY_GENESIS = '0x7e4e32d0feafd4f9c9414b0be86373f9a1efa904809b683453a9af6856d38ad5';
export const HOUR_SECONDS = 3600;
const SCALE = 10n ** 18n;
const STABLE_ASSET_IDS = new Set([
  '0x0200060000000000000000000000000000000000000000000000000000000000',
  '0x0200080000000000000000000000000000000000000000000000000000000000',
  '0x02000c0000000000000000000000000000000000000000000000000000000000',
]);
// Preserve the existing global-price policy: shallow pools cannot become oracles.
const MIN_PRICE_DISCOVERY_LIQUIDITY_USD = 100n * SCALE;
const MIN_PRICE_DISCOVERY_AMOUNT = SCALE / 2n;
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
  /** Exact scaled USD prices derived from the same state as metadata and denominator. */
  prices: Map<string, bigint>;
  /** Optional same-state reserve evidence; only pools touching the requested asset are retained. */
  pools?: readonly HourlyPoolReserves[];
  /** Winning discovery path, including stable-anchor legs, for each eligible USD price. */
  priceRoutes?: Map<string, readonly HourlyPoolReserves[]>;
  previous?: Map<string, IndexerDocument>;
}

/** Shared existing stable-anchored, liquidity-gated pool valuation; no latest-state inputs. */
export function deriveAssetPrices(
  assets: Map<string, Pick<HourlyAssetMetadata, 'id' | 'decimals'>>,
  pools: HourlyPoolReserves[],
  evidence?: Map<string, HourlyPoolReserves[]>
): Map<string, bigint> {
    evidence?.clear();
    const prices = new Map<string, bigint>();
    const confidence = new Map<string, bigint>();
    const depth = new Map<string, bigint>();
    const fixedAssets = new Set<string>();

    for (const asset of assets.values()) {
      if (STABLE_ASSET_IDS.has(asset.id)) {
        prices.set(asset.id, SCALE);
        evidence?.set(asset.id, []);
        fixedAssets.add(asset.id);
      }
    }

    for (let round = 0; round < 12; round += 1) {
      let changed = false;

      for (const pool of pools) {
        if (pool.baseAssetReserves === 0n || pool.targetAssetReserves === 0n) continue;

        const baseInfo = assets.get(pool.baseAssetId);
        const targetInfo = assets.get(pool.targetAssetId);
        if (!baseInfo || !targetInfo) continue;

        const baseNatural = reserveToNaturalScaled(pool.baseAssetReserves, baseInfo.decimals);
        const targetNatural = reserveToNaturalScaled(pool.targetAssetReserves, targetInfo.decimals);
        if (baseNatural === 0n || targetNatural === 0n) continue;

        const basePrice = prices.get(pool.baseAssetId);
        const targetPrice = prices.get(pool.targetAssetId);
        const baseRoute = evidence?.get(pool.baseAssetId) ?? [];
        const targetRoute = evidence?.get(pool.targetAssetId) ?? [];

        const applyCandidate = (assetId: string, price: bigint, candidateConfidence: bigint, candidateDepth: bigint, parentRoute: HourlyPoolReserves[]) => {
          if (
            fixedAssets.has(assetId) ||
            price <= 0n ||
            candidateConfidence < MIN_PRICE_DISCOVERY_LIQUIDITY_USD ||
            candidateDepth < MIN_PRICE_DISCOVERY_AMOUNT
          ) {
            return;
          }

          const currentDepth = depth.get(assetId) ?? 0n;
          const currentConfidence = confidence.get(assetId) ?? 0n;

          if (candidateDepth > currentDepth || (candidateDepth === currentDepth && candidateConfidence > currentConfidence)) {
            prices.set(assetId, price);
            confidence.set(assetId, candidateConfidence);
            depth.set(assetId, candidateDepth);
            evidence?.set(assetId, [...new Map([...parentRoute, pool].map((item) => [`${item.baseAssetId}:${item.targetAssetId}`, { ...item }])).values()]);
            changed = true;
          }
        };

        if (basePrice && basePrice > 0n) {
          const baseLiquidityUSD = scaledMul(baseNatural, basePrice);
          const baseConfidence = confidence.get(pool.baseAssetId);
          applyCandidate(
            pool.targetAssetId,
            scaledDiv(baseLiquidityUSD, targetNatural),
            baseConfidence ? baseConfidence < baseLiquidityUSD ? baseConfidence : baseLiquidityUSD : baseLiquidityUSD,
            targetNatural,
            baseRoute
          );
        }

        if (targetPrice && targetPrice > 0n) {
          const targetLiquidityUSD = scaledMul(targetNatural, targetPrice);
          const targetConfidence = confidence.get(pool.targetAssetId);
          applyCandidate(
            pool.baseAssetId,
            scaledDiv(targetLiquidityUSD, baseNatural),
            targetConfidence ? targetConfidence < targetLiquidityUSD ? targetConfidence : targetLiquidityUSD : targetLiquidityUSD,
            baseNatural,
            targetRoute
          );
        }
      }

      if (!changed) {
        break;
      }
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
  for (const required of HOURLY_HISTORY_ASSETS) {
    const metadata = assets.get(required.id), price = prices.get(required.id);
    if (metadata && (metadata.id !== required.id || metadata.symbol !== required.symbol || !Number.isSafeInteger(metadata.decimals) || metadata.decimals < 0 || metadata.decimals > 36)) throw new Error(`Hourly history metadata mismatch: ${required.symbol}`);
    const availability = !metadata ? 'metadata-unavailable' : price === undefined || price <= 0n ? 'price-unavailable' : 'priced';
    const observedPools = input.pools?.filter((pool) => pool.baseAssetId === required.id || pool.targetAssetId === required.id);
    const evidencePools = availability === 'priced' ? input.priceRoutes?.get(required.id) ?? observedPools : observedPools;
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
