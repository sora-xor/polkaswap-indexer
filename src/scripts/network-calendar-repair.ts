import type { IndexerDocument } from '../repository/types.js';

const WINDOWS: Readonly<Record<string, number>> = { DEFAULT: 300, HOUR: 3_600, DAY: 86_400, MONTH: 2_592_000 };
const SCALE = 10n ** 18n;
const PERSISTED_USD_UNIT = 10n ** 10n;
const COUNTERS = ['accounts', 'transactions', 'swaps', 'bridgeIncomingTransactions', 'bridgeOutgoingTransactions'] as const;
type Counter = (typeof COUNTERS)[number];

/** Compact canonical input; USD amounts use 18 fixed-point decimal places. */
export type CalendarRepairBlock = Record<Counter, number> & {
  id: string;
  timestamp: number;
  fees: bigint;
  volumeUSD: bigint;
};

/** Additive evidence consumed by the calendar-flow API without replacing stock observations. */
export type NetworkCalendarRepairFlows = Record<Counter, number> & {
  version: 1;
  bucketStart: number;
  bucketEnd: number;
  throughBlock: number;
  throughTimestamp: number;
  complete: boolean;
  fees: string;
  volumeUSD: string;
};

type Totals = Record<Counter | 'fees' | 'volumeUSD', bigint>;
type Bucket = { start: number; end: number; totals: Totals; first: number; last: number; count: number };

/** Fixed-point output matches the precision of repaired, persisted BLOCK records. */
function usdString(amount: bigint): string {
  const fraction = (amount % SCALE).toString().padStart(18, '0').slice(0, 8).replace(/0+$/, '');
  return `${amount / SCALE}${fraction ? `.${fraction}` : ''}`;
}

/** Reject malformed inputs instead of creating apparently authoritative repair evidence. */
function validateBlock(height: number, block: CalendarRepairBlock): void {
  if (!Number.isSafeInteger(height) || height < 0 || block.id !== `block-${height}` ||
      !Number.isSafeInteger(block.timestamp) || block.timestamp < 0) {
    throw new Error(`Invalid canonical BLOCK input at height ${height}`);
  }
  for (const field of COUNTERS) {
    if (!Number.isSafeInteger(block[field]) || block[field] < 0) {
      throw new Error(`Invalid ${field} on BLOCK ${height}`);
    }
  }
  for (const field of ['fees', 'volumeUSD'] as const) {
    if (typeof block[field] !== 'bigint' || block[field] < 0n) {
      throw new Error(`Invalid ${field} on BLOCK ${height}`);
    }
  }
}

/**
 * Reconstruct exact calendar evidence from independently reconciled BLOCK inputs.
 * Only compact references and requested bucket totals are retained. A missing
 * predecessor, interior block, or successor withholds that bucket's metadata;
 * the callback records why. A current bucket is valid only through the fixed
 * canonical repair head. Aggregate timestamps select buckets, while historical
 * stock values and stale rolling counters are never used as evidence or changed.
 */
export function buildNetworkCalendarRepairMetadata(
  blocks: ReadonlyMap<number, CalendarRepairBlock>,
  aggregates: readonly IndexerDocument[],
  throughBlock: number,
  onUnprovable?: (entry: { id: string; reason: string }) => void
): Map<string, NetworkCalendarRepairFlows> {
  if (!Number.isSafeInteger(throughBlock) || throughBlock < 0 || !blocks.has(throughBlock)) {
    throw new Error('Calendar repair requires an existing canonical repair-head BLOCK');
  }
  const heights = [...blocks.keys()].filter((height) => height <= throughBlock).sort((left, right) => left - right);
  const buckets = new Map<string, Bucket>();
  const requested = new Map<string, string>();
  const activeTypes = new Set<string>();
  for (const document of aggregates) {
    const type = String(document.data.type ?? '');
    const window = WINDOWS[type];
    const timestamp = Number(document.timestamp ?? document.data.timestamp);
    if (!window || !Number.isSafeInteger(timestamp) || timestamp < 0) {
      onUnprovable?.({ id: document.id, reason: 'invalid aggregate type or timestamp' });
      continue;
    }
    const start = Math.floor(timestamp / window) * window;
    const key = `${type}-${start}`;
    requested.set(document.id, key);
    activeTypes.add(type);
    if (!buckets.has(key)) buckets.set(key, { start, end: start + window, first: -1, last: -1, count: 0,
      totals: { accounts: 0n, transactions: 0n, swaps: 0n, bridgeIncomingTransactions: 0n,
        bridgeOutgoingTransactions: 0n, fees: 0n, volumeUSD: 0n } });
  }
  let priorTimestamp = -1;
  for (const height of heights) {
    const block = blocks.get(height)!;
    validateBlock(height, block);
    if (block.timestamp < priorTimestamp) throw new Error(`Regressing canonical BLOCK timestamp at ${height}`);
    priorTimestamp = block.timestamp;
    for (const type of activeTypes) {
      const window = WINDOWS[type]!;
      const bucket = buckets.get(`${type}-${Math.floor(block.timestamp / window) * window}`);
      if (!bucket) continue;
      if (!bucket.count) bucket.first = height;
      bucket.last = height;
      bucket.count += 1;
      for (const field of COUNTERS) bucket.totals[field] += BigInt(block[field]);
      bucket.totals.fees += block.fees;
      // Match truncation on each persisted BLOCK, rather than only after summing.
      bucket.totals.volumeUSD += block.volumeUSD / PERSISTED_USD_UNIT * PERSISTED_USD_UNIT;
    }
  }
  const lowerBound = (timestamp: number): number => {
    let low = 0;
    let high = heights.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (blocks.get(heights[middle]!)!.timestamp < timestamp) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const metadata = new Map<string, NetworkCalendarRepairFlows>();
  const computed = new Map<string, NetworkCalendarRepairFlows | string>();
  for (const [id, key] of requested) {
    let result = computed.get(key);
    if (result === undefined) {
      const bucket = buckets.get(key)!;
      const beforeHeight = heights[lowerBound(bucket.start) - 1];
      const afterHeight = heights[lowerBound(bucket.end)];
      const lastHeight = bucket.count ? bucket.last : beforeHeight;
      const complete = afterHeight !== undefined;
      if (beforeHeight === undefined) result = 'missing predecessor before calendar bucket';
      else if (bucket.count && (bucket.first !== beforeHeight + 1 || bucket.count !== bucket.last - bucket.first + 1)) {
        result = 'noncontiguous BLOCK coverage inside calendar bucket';
      } else if (complete && afterHeight !== lastHeight! + 1) result = 'missing successor at calendar bucket boundary';
      else if (!complete && (lastHeight !== throughBlock || blocks.get(throughBlock)!.timestamp < bucket.start)) {
        result = 'calendar bucket is beyond the fixed repair head';
      } else {
        const counters = {} as Record<Counter, number>;
        for (const field of COUNTERS) {
          if (bucket.totals[field] > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`Calendar ${field} overflows safe integer range`);
          counters[field] = Number(bucket.totals[field]);
        }
        result = { version: 1, bucketStart: bucket.start, bucketEnd: bucket.end,
          throughBlock: lastHeight!, throughTimestamp: blocks.get(lastHeight!)!.timestamp, complete,
          ...counters, fees: bucket.totals.fees.toString(), volumeUSD: usdString(bucket.totals.volumeUSD) };
      }
      computed.set(key, result);
    }
    if (typeof result === 'string') onUnprovable?.({ id, reason: result });
    else metadata.set(id, result);
  }
  return metadata;
}
