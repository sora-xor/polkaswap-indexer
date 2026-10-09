import { GraphQLError, type GraphQLResolveInfo, type SelectionNode } from 'graphql';

import type { IndexerDocument, IndexerRepository, RepositoryQueryArgs } from '../repository/types.js';

/** Flow fields are additive; liquidity and other stock fields must never be summed. */
export const NETWORK_FLOW_FIELDS = ['accounts', 'transactions', 'fees', 'volumeUSD', 'swaps',
  'bridgeIncomingTransactions', 'bridgeOutgoingTransactions'] as const;
type FlowField = typeof NETWORK_FLOW_FIELDS[number];
type Totals = Record<FlowField, bigint>;
const WINDOWS: Record<string, number> = { DEFAULT: 300, HOUR: 3_600, DAY: 86_400, MONTH: 30 * 86_400 };
const SCALE = 100_000_000n;
const MAX_BOUNDARY_ROWS = 500_000;
const PAGE_SIZE = 1_000;
const CACHE_LIMIT = 512;
const cache = new WeakMap<IndexerRepository, Map<string, { until: number; value: Promise<Record<string, unknown>> }>>();
const unavailable = (reason: string) => new GraphQLError(`Network flow coverage unavailable: ${reason}`, {
  extensions: { code: 'NETWORK_FLOW_COVERAGE_UNAVAILABLE' },
});
class RetiredCoverage extends Error {}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A repair marker records that the stored rolling window cannot support numeric correction. */
function hasUnverifiedRollingFlows(data: Record<string, unknown>): boolean {
  return record(data.networkFlowRepair) && data.networkFlowRepair.version === 2 &&
    data.networkFlowRepair.status === 'LEGACY_UNVERIFIED';
}

/** Shares the durable calendar envelope check between query membership and flow projection. */
function calendarFlows(data: Record<string, unknown>, bucketStart: number, bucketEnd: number): Record<string, unknown> | null {
  const persisted = record(data.calendarFlows) ? data.calendarFlows : null;
  return persisted?.version === 1 && persisted.bucketStart === bucketStart && persisted.bucketEnd === bucketEnd &&
    typeof persisted.complete === 'boolean' && Number.isSafeInteger(persisted.throughBlock) && Number.isSafeInteger(persisted.throughTimestamp)
    ? persisted : null;
}

/** Includes fragment and alias selections without making stock-only chart queries read history. */
export function requestsNetworkFlows(info?: GraphQLResolveInfo): boolean {
  if (!info?.fieldNodes) return true;
  const seen = new Set<string>();
  const walk = (selections: readonly SelectionNode[]): boolean => selections.some((selection) => {
    if (selection.kind === 'Field') return NETWORK_FLOW_FIELDS.includes(selection.name.value as FlowField) ||
      selection.name.value.startsWith('flow') || walk(selection.selectionSet?.selections ?? []);
    if (selection.kind === 'InlineFragment') return walk(selection.selectionSet.selections);
    if (seen.has(selection.name.value)) return false;
    seen.add(selection.name.value);
    return walk(info.fragments[selection.name.value]?.selectionSet.selections ?? []);
  });
  return info.fieldNodes.some((node) => walk(node.selectionSet?.selections ?? []));
}

/** Aggregate flow predicates cannot be applied to stored rolling values before projection/pagination. */
export function assertNetworkFlowQuery(filter: unknown, orderBy: unknown): void {
  const blockOnly = (value: unknown): boolean => record(value) && (
    (record(value.type) && (value.type.equalTo === 'BLOCK' || value.type.eq === 'BLOCK')) ||
    (Array.isArray(value.and) && value.and.some(blockOnly))
  );
  const metricPredicate = (value: unknown): boolean => record(value) && Object.entries(value).some(([key, child]) =>
    NETWORK_FLOW_FIELDS.includes(key as FlowField) || (Array.isArray(child) && child.some(metricPredicate)));
  const metricOrder = (Array.isArray(orderBy) ? orderBy : [orderBy]).some((value) =>
    typeof value === 'string' && /^(FEES|VOLUME_USD|ACCOUNTS|TRANSACTIONS|SWAPS|BRIDGE_.*TRANSACTIONS)_/.test(value));
  if (!blockOnly(filter) && (metricPredicate(filter) || metricOrder)) throw new GraphQLError(
    'Network flow filters and ordering require type BLOCK; aggregate rows are calendar projections',
    { extensions: { code: 'BAD_USER_INPUT' } }
  );
}

/** Reads conjunctive time bounds; adjacent comparison ranges own their lower boundary exclusively. */
function timeBounds(filter: unknown): { lower: number; upper: number } {
  let lower = -1;
  let upper = Number.MAX_SAFE_INTEGER - 1;
  const visit = (value: unknown): void => {
    if (!record(value)) return;
    if (Array.isArray(value.and)) value.and.forEach(visit);
    if (!record(value.timestamp)) return;
    for (const [key, raw] of Object.entries(value.timestamp)) {
      const amount = Number(raw);
      if (!Number.isSafeInteger(amount)) continue;
      if (key === 'greaterThanOrEqualTo' || key === 'gte' || key === 'greaterThan' || key === 'gt') lower = Math.max(lower, amount);
      if (key === 'lessThanOrEqualTo' || key === 'lte') upper = Math.min(upper, amount);
      if (key === 'lessThan' || key === 'lt') upper = Math.min(upper, amount - 1);
    }
  };
  visit(filter);
  return { lower, upper };
}

/** Includes the stored end-of-bucket row needed to reconstruct a historical partial upper bucket. */
export async function networkFlowRepositoryFilter(
  repository: IndexerRepository,
  filter: Record<string, unknown> | null | undefined
): Promise<typeof filter> {
  const findType = (value: unknown): string | null => {
    if (!record(value) || value.or !== undefined) return null;
    if (record(value.type)) {
      const type = value.type.equalTo ?? value.type.eq;
      if (typeof type === 'string' && WINDOWS[type]) return type;
    }
    return Array.isArray(value.and) ? value.and.map(findType).find((value) => value !== null) ?? null : null;
  };
  const type = findType(filter);
  const { lower, upper } = timeBounds(filter);
  if (!type || !repository.query || (upper > 2_147_483_647 && lower < 0)) return filter;
  const oldest = (await repository.query('networkSnapshots', { first: 1, orderBy: ['TIMESTAMP_ASC'],
    filter: { type: { equalTo: 'BLOCK' } }, includeTotalCount: false, maxBytes: 4096 })).items[0];
  if (!oldest) return filter;
  const oldestTime = blockPosition(oldest).timestamp;
  const window = WINDOWS[type]!;
  const lowerBucket = Math.floor(lower / window) * window;
  const upperBucket = Math.floor(upper / window) * window;
  // Do not add out-of-range legacy rows whose boundary evidence was pruned.
  const canWiden = async (bucket: number): Promise<boolean> => {
    const source = await repository.get('networkSnapshots', `network-all-${type}-${bucket}`);
    if (!source) return false;
    const timestamp = Number(source.timestamp ?? source.data.timestamp);
    const height = Number(source.blockHeight ?? source.data.blockHeight);
    const durable = calendarFlows(source.data, bucket, bucket + window);
    if (hasUnverifiedRollingFlows(source.data) && !durable?.complete) return false;
    return Number.isSafeInteger(timestamp) && Number.isSafeInteger(height) &&
      height >= blockPosition(oldest).height && (durable ? bucket : timestamp - window) >= oldestTime;
  };
  const [widenLower, widenUpper] = await Promise.all([
    lower >= 0 ? canWiden(lowerBucket) : false,
    upper <= 2_147_483_647 ? canWiden(upperBucket) : false,
  ]);
  if (!widenLower && !widenUpper) return filter;
  const expandedUpper = upperBucket + window - 1;
  const replace = (value: unknown): unknown => {
    if (!record(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => {
      if (key === 'and' && Array.isArray(child)) return [key, child.map(replace)];
      if (key === 'timestamp' && record(child)) return [key, Object.fromEntries(Object.entries(child).map(([operator, amount]) =>
        widenUpper && ['lessThanOrEqualTo', 'lte'].includes(operator) ? [operator, expandedUpper] :
          widenUpper && ['lessThan', 'lt'].includes(operator) ? [operator, expandedUpper + 1] :
            widenLower && ['greaterThanOrEqualTo', 'gte'].includes(operator) ? [operator, lowerBucket] :
              widenLower && ['greaterThan', 'gt'].includes(operator) ? [operator, lowerBucket - 1] : [operator, amount]))];
      return [key, child];
    }));
  };
  return replace(filter) as typeof filter;
}

function readTotals(data: Record<string, unknown>): Totals {
  return Object.fromEntries(NETWORK_FLOW_FIELDS.map((field) => {
    const raw = String(data[field] ?? '0');
    if (field === 'volumeUSD') {
      if (!/^\d{1,100}(?:\.\d{1,8})?$/.test(raw)) throw unavailable('invalid indexed USD flow');
      const [whole, fraction = ''] = raw.split('.');
      return [field, BigInt(whole!) * SCALE + BigInt(fraction.padEnd(8, '0'))];
    }
    if (!/^\d{1,120}$/.test(raw)) throw unavailable(`invalid indexed ${field}`);
    return [field, BigInt(raw)];
  })) as Totals;
}

function encodeTotals(totals: Totals): Record<string, unknown> {
  return Object.fromEntries(NETWORK_FLOW_FIELDS.map((field) => {
    const value = totals[field];
    if (value < 0n) throw unavailable(`negative corrected ${field}`);
    if (field === 'fees') return [field, value.toString()];
    if (field === 'volumeUSD') return [field, `${value / SCALE}.${(value % SCALE).toString().padStart(8, '0')}`.replace(/\.?0+$/, '') || '0'];
    if (value > 2_147_483_647n) throw unavailable(`overflow in corrected ${field}`);
    return [field, Number(value)];
  }));
}

function blockPosition(document: IndexerDocument): { height: number; timestamp: number } {
  const height = Number(document.blockHeight ?? document.data.blockHeight);
  const timestamp = Number(document.timestamp ?? document.data.timestamp);
  if (!Number.isSafeInteger(height) || height < 0 || !Number.isSafeInteger(timestamp) || timestamp < 0 ||
      document.id !== `block-${height}` || document.data.type !== 'BLOCK') throw unavailable('noncanonical BLOCK input');
  return { height, timestamp };
}

/** Corrects only bucket boundaries; a year of DAY rows does not scan a year of BLOCK data. */
export async function projectNetworkSnapshotFlows(
  repository: IndexerRepository,
  documents: IndexerDocument[],
  filter?: Record<string, unknown> | null
): Promise<IndexerDocument[]> {
  if (!documents.some((document) => WINDOWS[String(document.data.type)])) return documents.map((document) => ({
    ...document, data: { ...document.data, flowAggregation: document.data.type === 'BLOCK' ? 'BLOCK' : null },
  }));
  if (!repository.query) throw unavailable('bounded repository queries are required');
  const query = (args: RepositoryQueryArgs) => repository.query!('networkSnapshots', {
    includeTotalCount: false, maxBytes: 4 * 1_024 * 1_024, ...args,
  });
  const endpoint = async (direction: 'ASC' | 'DESC', condition: Record<string, unknown> = {}, through?: number) => {
    const result = await query({ first: 1, orderBy: [`TIMESTAMP_${direction}`], filter: {
      type: { equalTo: 'BLOCK' }, ...condition,
      ...(through === undefined ? {} : { blockHeight: { lessThanOrEqualTo: through } }),
    } });
    return result.items[0] ?? null;
  };
  const latestDocument = await endpoint('DESC');
  const oldestDocument = await endpoint('ASC');
  if (!latestDocument || !oldestDocument) return documents.map((document) => ({
    ...document, data: { ...document.data, flowAggregation: 'LEGACY_ROLLING' },
  }));
  const latest = blockPosition(latestDocument);
  const oldest = blockPosition(oldestDocument);
  const bounds = timeBounds(filter);
  let rowsRead = 0;
  const memo = cache.get(repository) ?? new Map();
  cache.set(repository, memo);

  /** Validates every intervening canonical height while retaining at most one bounded page. */
  const sumSpan = async (from: number, to: number, totals: Totals, sign: bigint, accept: (timestamp: number) => boolean) => {
    if (from > to) return;
    if (from < oldest.height) throw new RetiredCoverage();
    if (to > latest.height || rowsRead + to - from + 1 > MAX_BOUNDARY_ROWS) throw unavailable('boundary scan budget exceeded');
    let expected = from;
    let previousTimestamp = -1;
    while (expected <= to) {
      const page = await query({ first: Math.min(PAGE_SIZE, to - expected + 1), orderBy: ['BLOCK_HEIGHT_ASC'], filter: {
        type: { equalTo: 'BLOCK' }, blockHeight: { greaterThanOrEqualTo: expected, lessThanOrEqualTo: to },
      } });
      if (!page.items.length) throw unavailable(`missing BLOCK ${expected}`);
      for (const document of page.items) {
        const position = blockPosition(document);
        if (position.height !== expected || position.timestamp < previousTimestamp) throw unavailable(`noncontiguous BLOCK coverage at ${expected}`);
        expected += 1;
        previousTimestamp = position.timestamp;
        rowsRead += 1;
        if (accept(position.timestamp)) {
          const delta = readTotals(document.data);
          for (const field of NETWORK_FLOW_FIELDS) totals[field] += sign * delta[field];
        }
      }
    }
  };
  const adjustInterval = async (start: number, end: number, through: number, totals: Totals, sign: bigint) => {
    if (start >= end) return;
    if (start < oldest.timestamp) throw new RetiredCoverage();
    const before = await endpoint('DESC', { timestamp: { lessThan: start } }, through);
    const after = await endpoint('ASC', { timestamp: { greaterThanOrEqualTo: end } }, through);
    // Anchor both ends, including quiet intervals; one surviving row is not proof of completeness.
    const from = before ? blockPosition(before).height : oldest.height;
    const to = after ? blockPosition(after).height : through;
    await sumSpan(from, to, totals, sign, (timestamp) => timestamp >= start && timestamp < end);
  };

  const output: IndexerDocument[] = [];
  for (const document of documents) {
    const window = WINDOWS[String(document.data.type)];
    if (!window) { output.push({ ...document, data: { ...document.data, flowAggregation: 'BLOCK' } }); continue; }
    const timestamp = Number(document.timestamp ?? document.data.timestamp);
    const height = Number(document.blockHeight ?? document.data.blockHeight);
    if (!Number.isSafeInteger(timestamp) || timestamp < 0 || !Number.isSafeInteger(height) || height < 0) {
      output.push({ ...document, data: { ...document.data, flowAggregation: 'LEGACY_ROLLING' } });
      continue;
    }
    const bucketStart = Math.floor(timestamp / window) * window;
    const bucketEnd = bucketStart + window;
    const start = Math.max(bucketStart, bounds.lower + 1);
    const end = Math.min(bucketEnd, bounds.upper + 1, latest.timestamp + 1);
    const durable = calendarFlows(document.data, bucketStart, bucketEnd);
    if (hasUnverifiedRollingFlows(document.data) && !durable?.complete) {
      output.push({ ...document, data: { ...document.data, flowAggregation: 'LEGACY_ROLLING',
        flowBucketStart: null, flowBucketEnd: null, flowThroughBlock: height } });
      continue;
    }
    const key = JSON.stringify([document.id, height, timestamp, start, end,
      end === latest.timestamp + 1 ? latest.height : null, NETWORK_FLOW_FIELDS.map((field) => document.data[field]), durable]);
    let hit = memo.get(key);
    if (!hit || hit.until <= Date.now()) {
      const value = (async () => {
        try {
          if (end <= start) return { ...encodeTotals(readTotals({})), flowAggregation: 'CALENDAR', flowBucketStart: end,
            flowBucketEnd: end, flowThroughBlock: Math.min(height, latest.height) };
          const through = durable ? Number(durable.throughBlock) : height;
          const sourceTimestamp = durable ? Number(durable.throughTimestamp) : timestamp;
          const baseStart = durable ? bucketStart : timestamp - window;
          const totals = readTotals(durable ?? document.data);
          if (!durable?.complete) {
            if (through < oldest.height) throw new RetiredCoverage();
            const source = await repository.get('networkSnapshots', `block-${through}`);
            if (!source || blockPosition(source).timestamp !== sourceTimestamp || through > latest.height) throw unavailable('snapshot source block is missing');
          }
          // The stored rolling prefix belongs to the previous calendar bucket.
          await adjustInterval(baseStart, start, through, totals, -1n);
          if (durable?.complete) {
            await adjustInterval(end, bucketEnd, through, totals, -1n);
          } else {
            await adjustInterval(end, sourceTimestamp + 1, through, totals, -1n);
            // Height ownership also handles several blocks sharing the exact source timestamp.
            const last = await endpoint('DESC', { timestamp: { lessThan: end } }, latest.height);
            const lastHeight = last ? blockPosition(last).height : through;
            await sumSpan(through + 1, lastHeight, totals, 1n, (time) => time >= start && time < end);
          }
          return { ...encodeTotals(totals), flowAggregation: 'CALENDAR', flowBucketStart: start,
            flowBucketEnd: end, flowThroughBlock: durable?.complete ? through : latest.height };
        } catch (error) {
          if (error instanceof RetiredCoverage) return { flowAggregation: 'LEGACY_ROLLING',
            flowBucketStart: null, flowBucketEnd: null, flowThroughBlock: height };
          throw error;
        }
      })();
      hit = { until: Date.now() + 10_000, value };
      memo.set(key, hit);
      while (memo.size > CACHE_LIMIT) memo.delete(memo.keys().next().value!);
      value.catch(() => { if (memo.get(key)?.value === value) memo.delete(key); });
    }
    const projected = await hit.value;
    output.push({ ...document, data: { ...document.data, ...projected,
      ...(projected.flowAggregation === 'CALENDAR' ? { timestamp: Math.min(Math.max(timestamp, bounds.lower + 1), bounds.upper) } : {}),
    } });
  }
  return output;
}
