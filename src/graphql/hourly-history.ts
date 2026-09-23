import { GraphQLError } from 'graphql';
import { estimateRetainedValueBytes } from '../cache-weight.js';
import type { IndexerDocument, IndexerRepository, RepositoryQueryArgs } from '../repository/types.js';
import {
  assetHourlyCloseId, directXorPoolEvidence, HOURLY_HISTORY_ASSETS, HOURLY_HISTORY_GENESIS, HOUR_SECONDS,
} from '../worker/hourly-history.js';
import { validatePublicConnectionQuery } from './query-policy.js';

export const HOURLY_COVERAGE_MAX_HOURS = 2160;
const MAX_DOCUMENTS = HOURLY_COVERAGE_MAX_HOURS * 2;
const MAX_BYTES = 32 * 1024 * 1024;
const PAGE_BYTES = 512 * 1024;
const HASH = /^0x[0-9a-f]{64}$/;
const XOR = HOURLY_HISTORY_ASSETS[0]!;
type ProofStatus = 'MISSING' | 'LEGACY' | 'INVALID' | 'VERIFIED';
type PoolStatus = 'UNKNOWN' | 'ABSENT' | 'ZERO_RESERVE' | 'USABLE' | 'XOR_SELF';
type GapStatus = Exclude<ProofStatus, 'VERIFIED'> | 'UNKNOWN_POOL' | 'ABSENT_POOL' | 'ZERO_RESERVE';

/** Public provenance only. No price, reserve, ratio or performance field is retained. */
export interface HourlyCloseMetadata {
  hour: number;
  proofStatus: ProofStatus;
  poolStatus: PoolStatus;
  completedAt?: number;
  timestamp?: number;
  blockHeight?: number;
  blockHash?: string;
  nextTimestamp?: number;
  nextBlockHeight?: number;
  nextBlockHash?: string;
  denominator?: string;
  decimals?: number;
}

const inputError = (message: string) => new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });
const budgetError = () => new GraphQLError('Hourly coverage exceeds its bounded repository scan.', {
  extensions: { code: 'GRAPHQL_EXECUTION_MEMORY_LIMIT_EXCEEDED' },
});

/** Reject non-data objects before inspecting stored provenance. */
function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || !('value' in descriptors[key]))) return;
  return value as Record<string, unknown>;
}

/** Canonical u128 strings are checked as integers, never floating-point token values. */
function unsigned(value: unknown, positive: boolean): bigint | undefined {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,38})$/.test(value)) return;
  const result = BigInt(value);
  if (result >= (1n << 128n) || (positive && result === 0n)) return;
  return result;
}

/**
 * Validate the same boundary/identity contract consumed by the frontend pool decoder.
 * Direct pool amounts are checked with the collector's shared normalizer, then discarded.
 * USD price availability never substitutes for a missing direct XOR pool.
 */
export function hourlyCloseMetadata(document: IndexerDocument, assetId: string, hour: number): HourlyCloseMetadata {
  const invalid: HourlyCloseMetadata = { hour, proofStatus: 'INVALID', poolStatus: 'UNKNOWN' };
  try {
    const asset = HOURLY_HISTORY_ASSETS.find((item) => item.id === assetId);
    const data = record(document.data);
    if (!asset || !data || document.collection !== 'assetSnapshots' || document.id !== assetHourlyCloseId(assetId, hour) ||
        data.id !== document.id || data.assetId !== assetId || data.type !== 'HOUR' ||
        !Number.isSafeInteger(document.timestamp) || document.timestamp !== data.timestamp ||
        (document.timestamp as number) < hour || (document.timestamp as number) >= hour + HOUR_SECONDS) return invalid;
    if (data.closeEvidence === undefined || data.closeEvidence === null)
      return { hour, proofStatus: 'LEGACY', poolStatus: 'UNKNOWN' };
    const proof = record(data.closeEvidence);
    const completedAt = hour + HOUR_SECONDS;
    if (!proof || proof.kind !== 'finalized-hour-close' || proof.genesisHash !== HOURLY_HISTORY_GENESIS ||
        proof.requestedSymbol !== asset.symbol || proof.completedAt !== completedAt || proof.timestamp !== data.timestamp ||
        !Number.isSafeInteger(proof.blockHeight) || (proof.blockHeight as number) < 1 ||
        !Number.isSafeInteger(proof.nextBlockHeight) || (proof.nextBlockHeight as number) > 2_147_483_647 ||
        proof.nextBlockHeight !== (proof.blockHeight as number) + 1 ||
        typeof proof.blockHash !== 'string' || !HASH.test(proof.blockHash) ||
        typeof proof.nextBlockHash !== 'string' || !HASH.test(proof.nextBlockHash) || proof.blockHash === proof.nextBlockHash ||
        !Number.isSafeInteger(proof.nextTimestamp) || (proof.nextTimestamp as number) < completedAt ||
        (proof.nextTimestamp as number) >= completedAt + HOUR_SECONDS || unsigned(data.denominator, true) === undefined ||
        !['priced', 'price-unavailable', 'metadata-unavailable'].includes(proof.availability as string)) return invalid;
    const missingMetadata = proof.availability === 'metadata-unavailable';
    if (missingMetadata ? proof.symbol !== null || proof.decimals !== null || Object.hasOwn(proof, 'xorPool') :
        proof.symbol !== asset.symbol || !Number.isSafeInteger(proof.decimals) || (proof.decimals as number) < 0 ||
        (proof.decimals as number) > 36 || (assetId === XOR.id && proof.decimals !== 18)) return invalid;
    let poolStatus: PoolStatus = 'UNKNOWN';
    if (Object.hasOwn(proof, 'xorPool')) {
      if (proof.xorPool === null) poolStatus = assetId === XOR.id ? 'XOR_SELF' : 'ABSENT';
      else {
        const pool = record(proof.xorPool);
        if (assetId === XOR.id || !pool || pool.baseAssetId !== XOR.id || pool.targetAssetId !== assetId ||
            pool.baseDecimals !== 18 || pool.targetDecimals !== proof.decimals) return invalid;
        const base = unsigned(pool.baseAssetReserves, false), target = unsigned(pool.targetAssetReserves, false);
        if (base === undefined || target === undefined) return invalid;
        const normalized = directXorPoolEvidence(assetId, {
          assets: new Map([
            [XOR.id, { ...XOR, decimals: 18 }], [assetId, { ...asset, decimals: proof.decimals as number }],
          ]),
          pools: [{ baseAssetId: XOR.id, targetAssetId: assetId, baseAssetReserves: base, targetAssetReserves: target }],
          xorPoolsComplete: true,
        });
        if (!normalized) return invalid;
        poolStatus = base === 0n || target === 0n ? 'ZERO_RESERVE' : 'USABLE';
      }
    }
    return {
      hour, proofStatus: 'VERIFIED', poolStatus, completedAt, timestamp: proof.timestamp as number,
      blockHeight: proof.blockHeight as number, blockHash: proof.blockHash,
      nextTimestamp: proof.nextTimestamp as number, nextBlockHeight: proof.nextBlockHeight as number,
      nextBlockHash: proof.nextBlockHash, denominator: data.denominator as string,
      ...(missingMetadata ? {} : { decimals: proof.decimals as number }),
    };
  } catch {
    return invalid;
  }
}

/** Non-usable hour classification; adjacent equal causes are compressed without losing their bounds. */
function gapStatus(hour: HourlyCloseMetadata): GapStatus | undefined {
  if (hour.proofStatus !== 'VERIFIED') return hour.proofStatus;
  if (hour.poolStatus === 'UNKNOWN') return 'UNKNOWN_POOL';
  if (hour.poolStatus === 'ABSENT') return 'ABSENT_POOL';
  if (hour.poolStatus === 'ZERO_RESERVE') return 'ZERO_RESERVE';
}

/**
 * Read one asset's bounded indexed window without caching or consulting chain/market APIs.
 * Each page is discarded after projecting metadata; duplicate buckets stay invalid.
 */
export async function assetHourlyCoverage(
  repository: IndexerRepository,
  args: { assetId: string; start: number; end: number },
  now = Date.now()
) {
  const { assetId, start, end } = args;
  const asset = HOURLY_HISTORY_ASSETS.find((item) => item.id === assetId);
  const asOf = Math.floor(now / 1000);
  if (!asset || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start % HOUR_SECONDS ||
      end % HOUR_SECONDS || end <= start || end - start > HOURLY_COVERAGE_MAX_HOURS * HOUR_SECONDS ||
      end > Math.floor(asOf / HOUR_SECONDS) * HOUR_SECONDS) throw inputError('Use one supported asset and 1–2160 completed UTC hours.');
  if (!repository.query) throw new GraphQLError('Hourly coverage requires indexed repository queries.');
  const filter = { assetId: { equalTo: assetId }, type: { equalTo: 'HOUR' }, timestamp: { greaterThanOrEqualTo: start, lessThan: end } };
  validatePublicConnectionQuery('assetSnapshots', ['TIMESTAMP_ASC'], filter);
  const hours: HourlyCloseMetadata[] = Array.from({ length: (end - start) / HOUR_SECONDS }, (_, index) => ({
    hour: start + index * HOUR_SECONDS, proofStatus: 'MISSING', poolStatus: 'UNKNOWN',
  }));
  let seek: RepositoryQueryArgs['seek'];
  let documents = 0, retainedBytes = 0;
  while (true) {
    const page = await repository.query('assetSnapshots', {
      first: 100, includeTotalCount: false, orderBy: ['TIMESTAMP_ASC'], filter, seek,
      maxBytes: Math.min(PAGE_BYTES, MAX_BYTES - retainedBytes),
    });
    documents += page.items.length;
    retainedBytes += estimateRetainedValueBytes(page.items, MAX_BYTES - retainedBytes);
    if (documents > MAX_DOCUMENTS || retainedBytes > MAX_BYTES || (!page.items.length && page.hasNextPage)) throw budgetError();
    for (const document of page.items) {
      const timestamp = document.timestamp;
      if (!Number.isSafeInteger(timestamp) || (timestamp as number) < start || (timestamp as number) >= end)
        throw new GraphQLError('Hourly coverage received an out-of-range repository row.');
      const index = Math.floor(((timestamp as number) - start) / HOUR_SECONDS);
      hours[index] = hours[index]!.proofStatus === 'MISSING'
        ? hourlyCloseMetadata(document, assetId, start + index * HOUR_SECONDS)
        : { hour: start + index * HOUR_SECONDS, proofStatus: 'INVALID', poolStatus: 'UNKNOWN' };
    }
    if (!page.hasNextPage) break;
    if (documents >= MAX_DOCUMENTS || retainedBytes >= MAX_BYTES) throw budgetError();
    const last = page.items.at(-1)!;
    if (seek && ((last.timestamp as number) < seek.value || (last.timestamp === seek.value && last.id <= seek.id))) throw budgetError();
    seek = { field: 'timestamp', value: last.timestamp as number, id: last.id, direction: 'asc' };
  }
  const gaps: Array<{ start: number; end: number; hours: number; status: GapStatus }> = [];
  for (const hour of hours) {
    const status = gapStatus(hour);
    if (!status) continue;
    const prior = gaps.at(-1);
    if (prior?.status === status && prior.end === hour.hour) { prior.end += HOUR_SECONDS; prior.hours++; }
    else gaps.push({ start: hour.hour, end: hour.hour + HOUR_SECONDS, hours: 1, status });
  }
  const count = (test: (hour: HourlyCloseMetadata) => boolean) => hours.filter(test).length;
  let lastVerified: HourlyCloseMetadata | undefined;
  let lastObserved: HourlyCloseMetadata | undefined;
  let lastUsable: HourlyCloseMetadata | undefined;
  for (const hour of hours) {
    if (hour.proofStatus === 'VERIFIED') lastVerified = hour;
    if (hour.proofStatus !== 'MISSING') lastObserved = hour;
    if (!gapStatus(hour)) lastUsable = hour;
  }
  return {
    assetId, symbol: asset.symbol, start, end, asOf, expectedHours: hours.length,
    observedHours: count((hour) => hour.proofStatus !== 'MISSING'),
    verifiedHours: count((hour) => hour.proofStatus === 'VERIFIED'),
    poolUsableHours: count((hour) => !gapStatus(hour)),
    missingHours: count((hour) => hour.proofStatus === 'MISSING'),
    legacyHours: count((hour) => hour.proofStatus === 'LEGACY'),
    invalidHours: count((hour) => hour.proofStatus === 'INVALID'),
    absentPoolHours: count((hour) => hour.proofStatus === 'VERIFIED' && hour.poolStatus === 'ABSENT'),
    zeroReserveHours: count((hour) => hour.proofStatus === 'VERIFIED' && hour.poolStatus === 'ZERO_RESERVE'),
    unknownPoolHours: count((hour) => hour.proofStatus === 'VERIFIED' && hour.poolStatus === 'UNKNOWN'),
    latestCompletedAt: lastVerified?.completedAt ?? null,
    latestObservedCompletedAt: lastObserved ? lastObserved.hour + HOUR_SECONDS : null,
    latestUsableCompletedAt: lastUsable?.completedAt ?? null,
    hours, gaps,
  };
}
