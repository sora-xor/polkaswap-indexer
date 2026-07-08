import { makeExecutableSchema } from '@graphql-tools/schema';

import {
  ACCOUNT_TRANSACTIONS_BACKFILL_STATE_ID,
  hasCompletedAccountTransactionsBackfill,
  normalizeIndexedAccountId,
} from '../account-activity.js';
import { metrics } from '../metrics.js';
import { matchesFilter, sortDocuments } from './filter.js';
import { CursorScalar, FilterScalars, JSONScalar, OrderByScalar } from './scalars.js';
import { typeDefs } from './schema.js';

import type { IndexerCollection, IndexerDocument, IndexerRepository, RepositoryQueryArgs } from '../repository/types.js';
import type { GraphQLResolveInfo, GraphQLSchema, SelectionNode } from 'graphql';

type Context = {
  repository: IndexerRepository;
};

type ConnectionArgs = {
  first?: number | null;
  last?: number | null;
  offset?: number | null;
  after?: string | number | null;
  orderBy?: unknown;
  filter?: Record<string, unknown> | null;
};

type AccountActivityConnectionArgs = ConnectionArgs & {
  where?: Record<string, unknown> | null;
};

type Edge = {
  cursor: string;
  node: Record<string, unknown>;
};

type CacheEntry<T> = {
  expiresAt: number;
  value?: T;
  pending?: Promise<T>;
};

type CacheOptions = {
  maxEntries: number;
  ttlMs: number;
};

const emptyPageInfo = {
  hasNextPage: false,
  hasPreviousPage: false,
  startCursor: null,
  endCursor: null,
};

const collection = (name: IndexerCollection) => name;

const readPositiveInteger = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);

  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
};

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }

  return JSON.stringify(value) ?? 'undefined';
};

class TtlCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();

  constructor(private readonly options: CacheOptions) {}

  async getOrSet<T>(name: string, key: string, load: () => Promise<T>): Promise<T> {
    if (this.options.ttlMs <= 0 || this.options.maxEntries <= 0) {
      metrics.increment('indexer_cache_bypass_total', { cache: name });
      return load();
    }

    const now = Date.now();
    const existing = this.entries.get(key);

    if (existing?.pending) {
      metrics.increment('indexer_cache_pending_hit_total', { cache: name });
      return existing.pending as Promise<T>;
    }

    if (existing && existing.expiresAt > now && 'value' in existing) {
      metrics.increment('indexer_cache_hit_total', { cache: name });
      return existing.value as T;
    }

    metrics.increment('indexer_cache_miss_total', { cache: name });
    const pending = load();
    this.entries.set(key, { expiresAt: now + this.options.ttlMs, pending });

    try {
      const value = await pending;
      this.entries.set(key, { expiresAt: Date.now() + this.options.ttlMs, value });
      this.prune();
      metrics.setGauge('indexer_cache_entries', { cache: 'graphql' }, this.entries.size);

      return value;
    } catch (error) {
      this.entries.delete(key);
      metrics.setGauge('indexer_cache_entries', { cache: 'graphql' }, this.entries.size);
      throw error;
    }
  }

  size(): number {
    this.pruneExpired();
    return this.entries.size;
  }

  private prune(): void {
    this.pruneExpired();

    while (this.entries.size > this.options.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) return;

      this.entries.delete(oldestKey);
    }
    metrics.setGauge('indexer_cache_entries', { cache: 'graphql' }, this.entries.size);
  }

  private pruneExpired(): void {
    const now = Date.now();

    for (const [key, entry] of this.entries) {
      if (!entry.pending && entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}

const afterToOffset = (after: ConnectionArgs['after']): number => {
  if (after === null || after === undefined || after === '') return 0;

  const parsed = Number(after);
  return Number.isFinite(parsed) ? parsed + 1 : 0;
};

const paginationWindow = (args: ConnectionArgs, totalCount: number) => {
  const baseOffset = args.offset ?? afterToOffset(args.after);
  const start = Math.max(baseOffset, 0);
  const first = args.first ?? null;
  const last = args.last ?? null;
  const end =
    first === null || first === undefined ? totalCount : Math.min(start + Math.max(first, 0), totalCount);
  const pageStart =
    last === null || last === undefined ? start : Math.max(end - Math.max(last, 0), start);

  return { end, pageStart };
};

const selectionIncludesField = (info: GraphQLResolveInfo | undefined, fieldName: string): boolean => {
  if (!info?.fieldNodes) return true;

  const visitSelections = (selections: readonly SelectionNode[] | undefined): boolean => {
    if (!selections) return false;

    return selections.some((selection) => {
      if (selection.kind === 'Field') return selection.name.value === fieldName;
      if (selection.kind === 'InlineFragment') return visitSelections(selection.selectionSet.selections);
      if (selection.kind === 'FragmentSpread') {
        return visitSelections(info.fragments[selection.name.value]?.selectionSet.selections);
      }

      return false;
    });
  };

  return info.fieldNodes.some((fieldNode) => visitSelections(fieldNode.selectionSet?.selections));
};

const buildConnection = (items: Record<string, unknown>[], args: ConnectionArgs) => {
  const filtered = sortDocuments(
    items.filter((item) => matchesFilter(item, args.filter)),
    args.orderBy
  );
  const totalCount = filtered.length;
  const { end, pageStart } = paginationWindow(args, totalCount);
  const pageItems = filtered.slice(pageStart, end);
  const edges: Edge[] = pageItems.map((node, index) => ({
    cursor: String(pageStart + index),
    node,
  }));

  return {
    nodes: pageItems,
    edges,
    totalCount,
    pageInfo: edges.length
      ? {
          hasNextPage: end < filtered.length,
          hasPreviousPage: pageStart > 0,
          startCursor: edges[0]?.cursor ?? null,
          endCursor: edges[edges.length - 1]?.cursor ?? null,
        }
      : emptyPageInfo,
  };
};

const toConnectionNode = (collectionName: IndexerCollection, document: IndexerDocument): Record<string, unknown> => {
  if (collectionName !== 'referrerRewards') return document.data;

  return {
    ...document.data,
    blockHeight:
      document.data.blockHeight === undefined && document.blockHeight !== undefined && document.blockHeight !== null
        ? String(document.blockHeight)
        : document.data.blockHeight,
    timestamp:
      document.data.timestamp === undefined && document.timestamp !== undefined && document.timestamp !== null
        ? document.timestamp
        : document.data.timestamp,
  };
};

const mobileConfigResolver = () => ({
  blockExplorerUrl: 'https://sorametrics.org/sorav2?tab=extrinsics&q={transaction}',
  substrateTypesUrl:
    'https://raw.githubusercontent.com/sora-xor/sora2-substrate-js-library/metadata14ios/packages/types/src/metadata/prod/types_scalecodec_mobile.json',
  soracard: false,
  nodes: [{ name: 'Sora', address: 'wss://mof2.sora.org' }],
});

const activeAssetFilter = {
  or: [{ liquidity: { greaterThan: '0' } }, { liquidityBooks: { greaterThan: '0' } }],
};

const activePoolFilter = {
  baseAssetReserves: { greaterThan: '0' },
  targetAssetReserves: { greaterThan: '0' },
};

const cachedConnectionCollections = new Set<IndexerCollection>([
  'assets',
  'assetSnapshots',
  'markets',
  'marketSnapshots',
  'networkSnapshots',
  'poolXYKs',
  'poolSnapshots',
  'orderBooks',
  'orderBookSnapshots',
]);

const toTimestamp = (document: IndexerDocument): number => {
  const value = Number(document.timestamp ?? document.data.timestamp ?? 0);

  return Number.isFinite(value) ? value : 0;
};

const latestByTimestamp = (documents: IndexerDocument[]): IndexerDocument | null => {
  return (
    [...documents].sort((left, right) => {
      const timestampDiff = toTimestamp(right) - toTimestamp(left);
      if (timestampDiff !== 0) return timestampDiff;

      return right.id.localeCompare(left.id);
    })[0] ?? null
  );
};

const queryCount = async (
  repository: IndexerRepository,
  collectionName: IndexerCollection,
  filter?: Record<string, unknown>
): Promise<number> => {
  if (repository.query) {
    const result = await repository.query(collectionName, {
      first: 0,
      filter,
      includeTotalCount: true,
    });

    return result.totalCount ?? 0;
  }

  const documents = await repository.list(collectionName);
  return documents.filter((document) => matchesFilter(document.data, filter)).length;
};

const queryFirst = async (
  repository: IndexerRepository,
  collectionName: IndexerCollection,
  args: ConnectionArgs
): Promise<IndexerDocument | null> => {
  if (repository.query) {
    const result = await repository.query(collectionName, {
      ...args,
      first: 1,
      includeTotalCount: false,
    });

    return result.items[0] ?? null;
  }

  const documents = await repository.list(collectionName);
  const connection = buildConnection(
    documents.map((document) => document.data),
    { ...args, first: 1 }
  );
  const node = connection.edges[0]?.node;
  if (!node) return null;

  return documents.find((document) => document.data === node || document.id === node.id) ?? null;
};

const ACCOUNT_ACTIVITY_PAGE_SIZE = 1_000;

type NetworkAccountActivityArgs = {
  from: number;
  to: number;
};

type NetworkAccountActivityRange = {
  from: number;
  to: number;
};

const normalizeNetworkAccountActivityRange = (args: NetworkAccountActivityArgs): NetworkAccountActivityRange | null => {
  const from = Number(args.from);
  const to = Number(args.to);

  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < 0) return null;

  return {
    from: Math.min(from, to),
    to: Math.max(from, to),
  };
};

const networkAccountActivityCacheKey = (args: NetworkAccountActivityArgs): string => {
  const range = normalizeNetworkAccountActivityRange(args);
  return range ? `networkAccountActivity:${range.from}:${range.to}` : 'networkAccountActivity:invalid';
};

const addAccountId = (accounts: Set<string>, value: unknown): void => {
  const accountId = normalizeIndexedAccountId(value);
  if (accountId) accounts.add(accountId);
};

const visitRangeDocuments = async (
  repository: IndexerRepository,
  collectionName: IndexerCollection,
  from: number,
  to: number,
  visit: (document: IndexerDocument) => void
): Promise<void> => {
  const rangeStart = Math.min(from, to);
  const rangeEnd = Math.max(from, to);
  const filter = { timestamp: { greaterThanOrEqualTo: rangeStart, lessThanOrEqualTo: rangeEnd } };

  if (!repository.query) {
    const documents = await repository.list(collectionName);
    documents.filter((document) => matchesFilter(document.data, filter)).forEach(visit);
    return;
  }

  let seek: RepositoryQueryArgs['seek'];

  while (true) {
    const result = await repository.query(collectionName, {
      first: ACCOUNT_ACTIVITY_PAGE_SIZE,
      includeTotalCount: false,
      orderBy: ['TIMESTAMP_ASC'],
      filter,
      seek,
    });

    result.items.forEach(visit);

    const last = result.items.at(-1);
    if (!last || !result.hasNextPage) return;

    seek = {
      field: 'timestamp',
      value: toTimestamp(last),
      id: last.id,
      direction: 'asc',
    };
  }
};

/**
 * Counts unique accounts that participated in transactions over a selected
 * timestamp range. Explicit account transaction documents are preferred, while
 * legacy history rows keep the metric useful for already-indexed data.
 */
const networkAccountActivityResolver = async (_parent: unknown, args: NetworkAccountActivityArgs, context: Context) => {
  const range = normalizeNetworkAccountActivityRange(args);
  if (!range) {
    return {
      id: 'network-account-activity-invalid',
      from: 0,
      to: 0,
      activeAccounts: 0,
    };
  }

  const accounts = new Set<string>();

  await visitRangeDocuments(context.repository, collection('accountTransactions'), range.from, range.to, (document) => {
    addAccountId(accounts, document.data.accountId);
  });

  const backfillState = await context.repository.get(collection('updatesStreams'), ACCOUNT_TRANSACTIONS_BACKFILL_STATE_ID);
  if (!hasCompletedAccountTransactionsBackfill(backfillState?.data?.data)) {
    await visitRangeDocuments(context.repository, collection('historyElements'), range.from, range.to, (document) => {
      addAccountId(accounts, document.data.address);
      addAccountId(accounts, document.data.dataFrom);
      addAccountId(accounts, document.data.dataTo);
    });
  }

  return {
    id: `network-account-activity-${range.from}-${range.to}`,
    from: range.from,
    to: range.to,
    activeAccounts: accounts.size,
  };
};

const latestNetworkSnapshot = async (repository: IndexerRepository): Promise<IndexerDocument | null> => {
  if (!repository.query) {
    const documents = await repository.list(collection('networkSnapshots'));
    const latestDay = latestByTimestamp(
      documents.filter((document) => matchesFilter(document.data, { type: { equalTo: 'DAY' } }))
    );

    if (latestDay) return latestDay;

    const latestDefault = latestByTimestamp(
      documents.filter((document) => matchesFilter(document.data, { type: { equalTo: 'DEFAULT' } }))
    );

    return latestDefault ?? latestByTimestamp(documents);
  }

  const latestDay = await queryFirst(repository, collection('networkSnapshots'), {
    orderBy: ['TIMESTAMP_DESC'],
    filter: { type: { equalTo: 'DAY' } },
  });

  if (latestDay) return latestDay;

  const latestDefault = await queryFirst(repository, collection('networkSnapshots'), {
    orderBy: ['TIMESTAMP_DESC'],
    filter: { type: { equalTo: 'DEFAULT' } },
  });

  if (latestDefault) return latestDefault;

  return queryFirst(repository, collection('networkSnapshots'), { orderBy: ['TIMESTAMP_DESC'] });
};

/**
 * Builds the compact data package used by the Explore landing header and tabs.
 * Values stay derived from existing SubQuery-compatible documents so the API
 * remains immediately usable with already indexed data.
 */
const exploreStatsResolver = async (_parent: unknown, _args: unknown, context: Context) => {
  const [tokenCount, poolCount, orderBookCount, networkSnapshot] = await Promise.all([
    queryCount(context.repository, collection('assets'), activeAssetFilter),
    queryCount(context.repository, collection('poolXYKs'), activePoolFilter),
    queryCount(context.repository, collection('orderBooks')),
    latestNetworkSnapshot(context.repository),
  ]);
  const networkData = networkSnapshot?.data ?? {};

  return {
    id: 'global',
    tokenCount,
    poolCount,
    orderBookCount,
    liquidityUSD: String(networkData.liquidityUSD ?? '0'),
    volumeDayUSD: String(networkData.volumeUSD ?? '0'),
    updatedAtTimestamp: networkSnapshot ? toTimestamp(networkSnapshot) : null,
  };
};

const signalNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const signalString = (value: unknown): string | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  return text ? text : null;
};

const signalStatus = (value: unknown): string => String(value ?? '').trim().toLowerCase();

const signalOutcome = (value: unknown): 'YES' | 'NO' | null => {
  const normalized = String(value ?? '').trim().toUpperCase();
  return normalized === 'YES' || normalized === 'NO' ? normalized : null;
};

const signalInteger = (value: unknown): number | null => {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? '').replace(/,/g, ''), 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

const signalTimestampLabel = (value: unknown): string => {
  const timestamp = signalNumber(value);
  if (!timestamp) return signalString(value) ?? 'Snapshot';
  const millis = timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1_000;

  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(millis));
};

const coerceSignalProbability = (value: unknown): number | null => {
  const parsed = readNumber(value);
  if (parsed === null) return null;
  const percentage = parsed <= 1 ? parsed * 100 : parsed;

  return Math.max(0, Math.min(100, percentage));
};

const scorePolkamarktSignalMarket = async (
  repository: IndexerRepository,
  market: IndexerDocument
): Promise<Record<string, unknown> | null> => {
  const marketId = signalInteger(market.data.marketId ?? market.id);
  const closeBlock = signalInteger(market.data.closeBlock);
  const title = signalString(market.data.title);
  const outcome = signalOutcome(market.data.resolutionOutcome);

  if (marketId === null || closeBlock === null || !title || !outcome) return null;

  const snapshot = await queryFirst(repository, collection('marketSnapshots'), {
    orderBy: ['BLOCK_HEIGHT_DESC'],
    filter: {
      marketId: { equalTo: marketId },
      type: { equalTo: 'DEFAULT' },
      blockHeight: { lessThanOrEqualTo: closeBlock },
    },
  });
  const yesProbability = coerceSignalProbability(snapshot?.data.probability ?? snapshot?.data.priceYes);
  if (yesProbability === null || yesProbability === 50) return null;

  const predictedOutcome = yesProbability > 50 ? 'YES' : 'NO';
  const confidencePercent = outcome === 'YES' ? yesProbability : 100 - yesProbability;

  return {
    marketId,
    title,
    outcome,
    predictedOutcome,
    confidencePercent,
    yesProbability,
    correct: predictedOutcome === outcome,
    label: snapshot ? signalTimestampLabel(snapshot.data.timestamp ?? snapshot.timestamp) : `Market ${marketId}`,
  };
};

const buildPolkamarktSignalAccuracy = async (
  repository: IndexerRepository,
  markets: IndexerDocument[]
): Promise<{ summary: Record<string, unknown> | null; series: Array<Record<string, unknown>> }> => {
  const resolvedMarkets = markets.filter((market) => {
    return signalStatus(market.data.status) === 'resolved' && Boolean(signalOutcome(market.data.resolutionOutcome));
  });

  if (!resolvedMarkets.length) return { summary: null, series: [] };

  const results = await Promise.all(resolvedMarkets.map((market) => scorePolkamarktSignalMarket(repository, market)));
  const scoredResults = results.filter((result): result is Record<string, unknown> => Boolean(result));

  if (!scoredResults.length) {
    return {
      summary: {
        scoredMarkets: 0,
        resolvedMarkets: resolvedMarkets.length,
        correctMarkets: 0,
        accuracyPercent: 0,
        averageConfidencePercent: 0,
      },
      series: [],
    };
  }

  let correctMarkets = 0;
  let confidenceTotal = 0;
  const series = scoredResults.map((result, index) => {
    if (result.correct === true) correctMarkets += 1;
    confidenceTotal += signalNumber(result.confidencePercent);

    return {
      label: String(result.label ?? `Market ${result.marketId ?? index + 1}`),
      value: (correctMarkets / (index + 1)) * 100,
      correctMarkets,
      scoredMarkets: index + 1,
    };
  });

  return {
    summary: {
      scoredMarkets: scoredResults.length,
      resolvedMarkets: resolvedMarkets.length,
      correctMarkets,
      accuracyPercent: (correctMarkets / scoredResults.length) * 100,
      averageConfidencePercent: confidenceTotal / scoredResults.length,
      latest: scoredResults.at(-1) ?? null,
    },
    series,
  };
};

const addSignalAccount = (accounts: Set<string>, value: unknown): void => {
  const account = signalString(value);
  if (account) accounts.add(account);
};

const polkamarktSignalsResolver = async (_parent: unknown, _args: unknown, context: Context) => {
  const [marketResult, activityResult, snapshotResult] = await Promise.all([
    queryDocuments(context.repository, collection('markets'), { first: 1_000 }, {}, ['VOLUME_USD_DESC']),
    queryDocuments(
      context.repository,
      collection('historyElements'),
      { first: 1_000 },
      { module: { equalTo: 'polkamarkt' } },
      ['TIMESTAMP_DESC']
    ),
    queryDocuments(context.repository, collection('networkSnapshots'), { first: 8 }, {}, ['TIMESTAMP_DESC']),
  ]);
  const markets = marketResult.items;
  const snapshots = snapshotResult.items
    .map((document) => ({
      timestamp: toTimestamp(document),
      accounts: signalNumber(document.data.accounts),
      liquidityUsd: signalNumber(document.data.liquidityUSD),
      volumeUsd: signalNumber(document.data.volumeUSD),
    }))
    .sort((left, right) => left.timestamp - right.timestamp);
  const latestSnapshot = snapshots.at(-1);
  const statuses = markets.map((market) => signalStatus(market.data.status)).filter(Boolean);
  const openMarketCount = statuses.length ? statuses.filter((status) => status === 'open').length : null;
  const accounts = new Set<string>();

  for (const market of markets) addSignalAccount(accounts, market.data.creator);
  for (const event of activityResult.items) {
    addSignalAccount(accounts, event.data.address);
    addSignalAccount(accounts, event.data.dataFrom);
  }

  const accuracy = await buildPolkamarktSignalAccuracy(context.repository, markets);

  return {
    totalVolumeUsd: markets.length
      ? markets.reduce((total, market) => total + signalNumber(market.data.volumeUSD), 0)
      : latestSnapshot?.volumeUsd ?? 0,
    activeMarkets: openMarketCount ?? marketResult.totalCount ?? markets.length,
    activeAccounts: accounts.size || latestSnapshot?.accounts || 0,
    liquidityUsd: markets.length
      ? markets.reduce((total, market) => total + signalNumber(market.data.liquidityUSD), 0)
      : latestSnapshot?.liquidityUsd ?? 0,
    liquiditySeries: snapshots.map((snapshot) => ({
      label: signalTimestampLabel(snapshot.timestamp),
      value: snapshot.liquidityUsd,
    })),
    answerBreakdown: [],
    accuracySummary: accuracy.summary,
    accuracySeries: accuracy.series,
  };
};

const shouldCacheConnection = (collectionName: IndexerCollection, args: ConnectionArgs): boolean => {
  if (!cachedConnectionCollections.has(collectionName)) return false;

  const first = args.first ?? null;
  const last = args.last ?? null;
  const requestedLimit = Math.max(Number(first ?? last ?? 50), 0);

  return requestedLimit <= 100;
};

const createConnectionResolver =
  (cache: TtlCache) =>
  (collectionName: IndexerCollection) =>
  async (_parent: unknown, args: ConnectionArgs, context: Context, info?: GraphQLResolveInfo) => {
    const resolveConnection = async () => {
      if (context.repository.query) {
        const includeTotalCount = selectionIncludesField(info, 'totalCount');
        const result = await context.repository.query(collectionName, { ...args, includeTotalCount });
        const fallbackTotalCount =
          result.totalCount ?? (result.pageStart ?? 0) + result.items.length + (result.hasNextPage ? 1 : 0);
        const { end, pageStart: fallbackPageStart } = paginationWindow(args, fallbackTotalCount);
        const pageStart = result.pageStart ?? fallbackPageStart;
        const nodes = result.items.map((document) => toConnectionNode(collectionName, document));
        const edges: Edge[] = result.items.map((document, index) => ({
          cursor: String(pageStart + index),
          node: toConnectionNode(collectionName, document),
        }));

        return {
          nodes,
          edges,
          totalCount: result.totalCount ?? fallbackTotalCount,
          pageInfo: edges.length
            ? {
                hasNextPage: result.hasNextPage ?? end < fallbackTotalCount,
                hasPreviousPage: result.hasPreviousPage ?? pageStart > 0,
                startCursor: edges[0]?.cursor ?? null,
                endCursor: edges[edges.length - 1]?.cursor ?? null,
              }
            : emptyPageInfo,
        };
      }

      const documents = await context.repository.list(collectionName);
      return buildConnection(
        documents.map((document) => document.data),
        args
      );
    };

    if (!shouldCacheConnection(collectionName, args)) return resolveConnection();

    const includeTotalCount = selectionIncludesField(info, 'totalCount');
    const key = `connection:${collectionName}:${stableJson({ ...args, includeTotalCount })}`;

    return cache.getOrSet(`connection_${collectionName}`, key, resolveConnection);
  };

const createDocumentResolver =
  (cache: TtlCache) =>
  (collectionName: IndexerCollection) =>
  async (_parent: unknown, args: { id: string }, context: Context): Promise<Record<string, unknown> | null> => {
    const key = `${collectionName}:${args.id}`;

    return cache.getOrSet(`document_${collectionName}`, key, async () => {
      return (await context.repository.get(collectionName, args.id))?.data ?? null;
    });
  };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const readString = (value: unknown): string | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  return text.length ? text : null;
};

const readNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const readEqualFilterValue = (value: unknown): string | null => {
  const direct = readString(value);
  if (direct) return direct;

  if (!isRecord(value)) return null;

  return readString(value.equalTo) ?? readString(value.eq) ?? readString(value._eq) ?? null;
};

const readAccountFromFilter = (filter: unknown): string | null => {
  if (!isRecord(filter)) return null;

  for (const [key, value] of Object.entries(filter)) {
    if ((key === 'and' || key === 'or') && Array.isArray(value)) {
      const nested = value.map(readAccountFromFilter).find((account): account is string => Boolean(account));
      if (nested) return nested;
      continue;
    }

    if (key === 'account_eq' || key === 'accountId_eq' || key === 'account_id_eq') {
      const account = readString(value);
      if (account) return account;
    }

    if (key === 'account' || key === 'accountId' || key === 'account_id') {
      const account = readEqualFilterValue(value);
      if (account) return account;
    }
  }

  return null;
};

const readAccountFromArgs = (args: AccountActivityConnectionArgs): string | null =>
  readAccountFromFilter(args.where) ?? readAccountFromFilter(args.filter);

const addFilterField = (filter: Record<string, unknown>, field: string, condition: unknown): void => {
  const existing = filter[field];
  if (existing === undefined) {
    filter[field] = condition;
    return;
  }

  delete filter[field];
  const existingAnd = filter.and;
  const andFilters = Array.isArray(existingAnd) ? existingAnd : existingAnd === undefined ? [] : [existingAnd];
  filter.and = [...andFilters, { [field]: existing }, { [field]: condition }];
};

const normalizeAccountPositionFilter = (filter: unknown): Record<string, unknown> | null => {
  if (!isRecord(filter)) return null;

  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(filter)) {
    if ((key === 'and' || key === 'or') && Array.isArray(value)) {
      normalized[key] = value.map((entry) => normalizeAccountPositionFilter(entry) ?? entry);
      continue;
    }

    if (key === 'account_eq' || key === 'accountId_eq' || key === 'account_id_eq') {
      addFilterField(normalized, 'account', { equalTo: value });
      continue;
    }

    if (key === 'accountId' || key === 'account_id') {
      addFilterField(normalized, 'account', value);
      continue;
    }

    addFilterField(normalized, key, value);
  }

  return normalized;
};

const accountPositionFilterFromArgs = (args: AccountActivityConnectionArgs): Record<string, unknown> => {
  const filters = [normalizeAccountPositionFilter(args.where), normalizeAccountPositionFilter(args.filter)].filter(
    (filter): filter is Record<string, unknown> => Boolean(filter && Object.keys(filter).length)
  );

  if (filters.length === 0) return {};
  if (filters.length === 1) return filters[0]!;
  return { and: filters };
};

const accountHistoryFilter = (account: string): Record<string, unknown> => ({
  or: [
    { address: { equalTo: account } },
    { dataFrom: { equalTo: account } },
    { dataTo: { equalTo: account } },
  ],
});

const queryDocuments = async (
  repository: IndexerRepository,
  collectionName: IndexerCollection,
  args: AccountActivityConnectionArgs,
  filter: Record<string, unknown>,
  orderBy: unknown = ['TIMESTAMP_DESC']
) => {
  const queryArgs: RepositoryQueryArgs = {
    first: args.first,
    last: args.last,
    offset: args.offset,
    after: args.after,
    orderBy,
    filter,
    includeTotalCount: true,
  };

  if (repository.query) return repository.query(collectionName, queryArgs);

  const documents = await repository.list(collectionName);
  const filtered = sortDocuments(
    documents.filter((document) => matchesFilter(document.data, filter)),
    orderBy
  );
  const totalCount = filtered.length;
  const { end, pageStart } = paginationWindow(args, totalCount);

  return {
    items: filtered.slice(pageStart, end),
    totalCount,
    pageStart,
    hasNextPage: end < totalCount,
    hasPreviousPage: pageStart > 0,
  };
};

const connectionFromNodes = (
  nodes: Record<string, unknown>[],
  result: { totalCount: number | null; pageStart?: number; hasNextPage?: boolean; hasPreviousPage?: boolean },
  args: ConnectionArgs
) => {
  const fallbackTotalCount =
    result.totalCount ?? (result.pageStart ?? 0) + nodes.length + (result.hasNextPage ? 1 : 0);
  const { pageStart: fallbackPageStart } = paginationWindow(args, fallbackTotalCount);
  const pageStart = result.pageStart ?? fallbackPageStart;
  const edges: Edge[] = nodes.map((node, index) => ({
    cursor: String(pageStart + index),
    node,
  }));

  return {
    edges,
    totalCount: fallbackTotalCount,
    pageInfo: edges.length
      ? {
          hasNextPage: result.hasNextPage ?? false,
          hasPreviousPage: result.hasPreviousPage ?? pageStart > 0,
          startCursor: edges[0]?.cursor ?? null,
          endCursor: edges[edges.length - 1]?.cursor ?? null,
        }
      : emptyPageInfo,
  };
};

const firstValue = (records: Array<Record<string, unknown>>, keys: string[]): unknown => {
  for (const record of records) {
    for (const key of keys) {
      if (record[key] !== undefined && record[key] !== null) return record[key];
    }
  }

  return undefined;
};

const normalizeSide = (value: unknown): string | null => {
  const method = readString(value)?.toLowerCase();
  if (!method) return null;
  if (method.includes('flip')) return 'flip';
  if (method.includes('claim')) return 'claim';
  if (method.includes('order')) return 'order';
  if (method.includes('sell')) return 'sell';
  if (method.includes('buy')) return 'buy';
  return method;
};

const timestampIso = (value: unknown): string | null => {
  const timestamp = readNumber(value);
  if (timestamp === null || timestamp <= 0) return readString(value);

  const milliseconds = timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000;
  return new Date(milliseconds).toISOString();
};

const toAccountTradeNode = (
  historyDocument: IndexerDocument | null | undefined,
  account: string,
  accountTransaction?: IndexerDocument
): Record<string, unknown> => {
  const source = historyDocument?.data ?? accountTransaction?.data ?? {};
  const payload = isRecord(source.data) ? source.data : {};
  const calls = Array.isArray(source.calls) ? source.calls.filter(isRecord) : [];
  const firstCall = calls[0] ?? {};
  const firstCallData = isRecord(firstCall.data) ? firstCall.data : {};
  const records = [source, payload, firstCall, firstCallData];
  const marketId = readNumber(firstValue(records, ['marketId', 'market_id', 'conditionId', 'condition_id']));
  const timestamp = firstValue(records, ['timestamp']) ?? historyDocument?.timestamp ?? accountTransaction?.timestamp;
  const blockNumber = readNumber(
    firstValue(records, ['blockNumber', 'block', 'blockHeight']) ??
      historyDocument?.blockHeight ??
      accountTransaction?.blockHeight
  );
  const id =
    readString(accountTransaction?.data.id) ??
    readString(source.id) ??
    readString(accountTransaction?.id) ??
    readString(historyDocument?.id) ??
    `${account}-${String(timestamp ?? 'activity')}`;

  return {
    id,
    account,
    marketId,
    side: normalizeSide(firstValue(records, ['side', 'action', 'method'])),
    outcome: readString(firstValue(records, ['outcome', 'direction'])),
    fromOutcome: readString(firstValue(records, ['fromOutcome', 'from_outcome', 'outcomeIn', 'outcome_in'])),
    toOutcome: readString(firstValue(records, ['toOutcome', 'to_outcome', 'outcomeOut', 'outcome_out', 'outcome', 'direction'])),
    collateralUsd: readString(firstValue(records, ['collateralUsd', 'collateralUSD', 'collateralAmountUsd', 'amountUsd'])),
    collateralAmountUsd: readString(firstValue(records, ['collateralAmountUsd', 'collateralUsd', 'amountUsd'])),
    shares: readString(firstValue(records, ['shares', 'sharesAmount', 'shareAmount'])),
    sharesAmount: readString(firstValue(records, ['sharesAmount', 'shares', 'shareAmount'])),
    sharesIn: readString(firstValue(records, ['sharesIn', 'shares_in', 'sharesAmountIn', 'sharesAmount', 'shares', 'shareAmount'])),
    sharesOut: readString(firstValue(records, ['sharesOut', 'shares_out', 'sharesAmountOut'])),
    price: readString(firstValue(records, ['price', 'executionPrice', 'avgPrice'])),
    executionPrice: readString(firstValue(records, ['executionPrice', 'price', 'avgPrice'])),
    feeUsd: readString(firstValue(records, ['feeUsd', 'feeUSD', 'feeAmountUsd'])),
    feeAmountUsd: readString(firstValue(records, ['feeAmountUsd', 'feeUsd', 'feeUSD'])),
    realizedPnlUsd: readString(firstValue(records, ['realizedPnlUsd', 'realizedPnlUSD', 'pnlUsd'])),
    timestamp: timestampIso(timestamp),
    blockNumber,
    blockHash: readString(source.blockHash),
    extrinsicHash: readString(source.id) ?? readString(historyDocument?.id),
    market: marketId === null ? null : { id: String(marketId), marketId },
  };
};

const accountPositionsResolver = async (
  _parent: unknown,
  args: AccountActivityConnectionArgs,
  context: Context
) => {
  const result = await queryDocuments(
    context.repository,
    collection('accountPositions'),
    args,
    accountPositionFilterFromArgs(args),
    args.orderBy ?? ['UPDATED_AT_DESC']
  );

  return connectionFromNodes(
    result.items.map((document) => document.data),
    result,
    args
  );
};

const accountTradesResolver = async (
  _parent: unknown,
  args: AccountActivityConnectionArgs,
  context: Context
) => {
  const account = readAccountFromArgs(args);
  if (!account) return buildConnection([], args);

  const accountTransactionResult = await queryDocuments(
    context.repository,
    collection('accountTransactions'),
    args,
    { accountId: { equalTo: account } },
    args.orderBy ?? ['TIMESTAMP_DESC']
  );

  if (accountTransactionResult.items.length || (accountTransactionResult.totalCount ?? 0) > 0) {
    const historyIds = accountTransactionResult.items
      .map((document) => readString(document.data.historyElementId))
      .filter((id): id is string => Boolean(id));
    const historyDocuments = await context.repository.getMany(collection('historyElements'), historyIds);
    const nodes = accountTransactionResult.items.map((document) => {
      const historyElementId = readString(document.data.historyElementId);
      return toAccountTradeNode(historyElementId ? historyDocuments.get(historyElementId) : null, account, document);
    });

    return connectionFromNodes(nodes, accountTransactionResult, args);
  }

  const historyResult = await queryDocuments(
    context.repository,
    collection('historyElements'),
    args,
    accountHistoryFilter(account),
    args.orderBy ?? ['TIMESTAMP_DESC']
  );

  return connectionFromNodes(
    historyResult.items.map((document) => toAccountTradeNode(document, account)),
    historyResult,
    args
  );
};

type MutationPayload = {
  id: string;
  mutation_type: 'INSERT' | 'UPDATE';
  _entity: Record<string, unknown>;
};

const getSubscriptionIds = (id: unknown): string[] => {
  if (Array.isArray(id)) return id.map(String);
  if (id === undefined || id === null) return [];
  return [String(id)];
};

const snakeCase = (value: string): string => value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

const toMutationEntity = (collectionName: IndexerCollection, data: Record<string, unknown>): Record<string, unknown> => {
  if (collectionName === 'accounts') {
    return Object.fromEntries(Object.entries(data).map(([key, value]) => [snakeCase(key), value]));
  }

  if (collectionName === 'orderBooks') {
    return {
      price: data.price ?? null,
      price_change_day: data.priceChangeDay ?? null,
      volume_day_u_s_d: data.volumeDayUSD ?? null,
      status: data.status ?? null,
      last_deals: data.lastDeals ?? null,
    };
  }

  return data;
};

async function* pollSubscription(
  collectionName: IndexerCollection,
  args: { id?: string | string[] },
  context: Context
): AsyncGenerator<MutationPayload, void, unknown> {
  const ids = getSubscriptionIds(args.id);
  const snapshots = new Map<string, string>();

  while (true) {
    let candidates: Array<IndexerDocument | null>;
    if (ids.length) {
      const documents = await context.repository.getMany(collectionName, ids);
      candidates = ids.map((id) => documents.get(id) ?? null);
    } else {
      candidates = await context.repository.list(collectionName);
    }

    for (const document of candidates) {
      if (!document) continue;

      const serialized = JSON.stringify(document.data);
      if (snapshots.get(document.id) === serialized) continue;

      snapshots.set(document.id, serialized);

      yield {
        id: document.id,
        mutation_type: 'UPDATE',
        _entity: toMutationEntity(collectionName, document.data),
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

async function* watchSubscription(
  collectionName: IndexerCollection,
  args: { id?: string | string[] },
  context: Context
): AsyncGenerator<MutationPayload, void, unknown> {
  const ids = getSubscriptionIds(args.id);

  if (!context.repository.watch) {
    yield* pollSubscription(collectionName, args, context);
    return;
  }

  for await (const document of context.repository.watch(collectionName, ids)) {
    yield {
      id: document.id,
      mutation_type: 'UPDATE',
      _entity: toMutationEntity(collectionName, document.data),
    };
  }
}

const pollingSubscription = (collectionName: IndexerCollection) => ({
  subscribe: (_parent: unknown, args: { id?: string | string[] }, context: Context) =>
    watchSubscription(collectionName, args, context),
});

const POLKASWAP_SERVICE_ID = 'pi.soramitsu.io';
const POLKASWAP_PUBLIC_BASE_URL = 'https://pi.soramitsu.io/graphql';

const healthResolver = async (_parent: unknown, _args: unknown, context: Context) => {
  const ok = context.repository.healthCheck ? await context.repository.healthCheck().catch(() => false) : true;

  return {
    ok,
    service: 'polkaswap-indexer',
    serviceId: POLKASWAP_SERVICE_ID,
    schemaVersion: 1,
    ecosystem: 'sora2',
    chainId: 'sora:mainnet',
    network: 'mainnet',
    publicBaseUrl: POLKASWAP_PUBLIC_BASE_URL,
    readOnly: true,
  };
};

export function createSchema(): GraphQLSchema {
  const cache = new TtlCache({
    maxEntries: readPositiveInteger('GRAPHQL_CACHE_MAX_ENTRIES', 1_000),
    ttlMs: readPositiveInteger('GRAPHQL_CACHE_TTL_MS', 2_000),
  });
  const connectionResolver = createConnectionResolver(cache);
  const documentResolver = createDocumentResolver(cache);
  const cachedExploreStatsResolver = (
    parent: unknown,
    args: unknown,
    context: Context
  ): Promise<Awaited<ReturnType<typeof exploreStatsResolver>>> =>
    cache.getOrSet('exploreStats', 'exploreStats', () => exploreStatsResolver(parent, args, context));
  const cachedPolkamarktSignalsResolver = (
    parent: unknown,
    args: unknown,
    context: Context
  ): Promise<Awaited<ReturnType<typeof polkamarktSignalsResolver>>> =>
    cache.getOrSet('polkamarktSignals', 'polkamarktSignals', () => polkamarktSignalsResolver(parent, args, context));
  const cachedNetworkAccountActivityResolver = (
    parent: unknown,
    args: NetworkAccountActivityArgs,
    context: Context
  ): Promise<Awaited<ReturnType<typeof networkAccountActivityResolver>>> =>
    cache.getOrSet('networkAccountActivity', networkAccountActivityCacheKey(args), () =>
      networkAccountActivityResolver(parent, args, context)
    );

  return makeExecutableSchema({
    typeDefs,
    resolvers: {
      JSON: JSONScalar,
      Cursor: CursorScalar,
      OrderBy: OrderByScalar,
      ...FilterScalars,
      Query: {
        _health: healthResolver,
        mobileConfig: mobileConfigResolver,
        account: documentResolver(collection('accounts')),
        assets: connectionResolver(collection('assets')),
        assetSnapshots: connectionResolver(collection('assetSnapshots')),
        accountLiquiditySnapshots: connectionResolver(collection('accountLiquiditySnapshots')),
        market: documentResolver(collection('markets')),
        markets: connectionResolver(collection('markets')),
        marketSnapshots: connectionResolver(collection('marketSnapshots')),
        networkSnapshots: connectionResolver(collection('networkSnapshots')),
        poolXYKs: connectionResolver(collection('poolXYKs')),
        poolSnapshots: connectionResolver(collection('poolSnapshots')),
        orderBook: documentResolver(collection('orderBooks')),
        orderBooks: connectionResolver(collection('orderBooks')),
        orderBookOrders: connectionResolver(collection('orderBookOrders')),
        orderBookSnapshots: connectionResolver(collection('orderBookSnapshots')),
        historyElements: connectionResolver(collection('historyElements')),
        xorBurns: connectionResolver(collection('xorBurns')),
        referrerRewards: connectionResolver(collection('referrerRewards')),
        stakingStakers: connectionResolver(collection('stakingStakers')),
        stakingValidators: connectionResolver(collection('stakingValidators')),
        vaults: connectionResolver(collection('vaults')),
        vaultEvents: connectionResolver(collection('vaultEvents')),
        updatesStream: documentResolver(collection('updatesStreams')),
        accountMeta: documentResolver(collection('accountMeta')),
        accountPointSystems: connectionResolver(collection('accountPointSystems')),
        accountPositions: accountPositionsResolver,
        accountTrades: accountTradesResolver,
        exploreStats: cachedExploreStatsResolver,
        polkamarktSignals: cachedPolkamarktSignalsResolver,
        networkAccountActivity: cachedNetworkAccountActivityResolver,
      },
      HistoryElement: {
        calls: (parent: Record<string, unknown>) => ({
          nodes: Array.isArray(parent.calls) ? parent.calls : [],
        }),
      },
      Subscription: {
        updatesStreams: pollingSubscription(collection('updatesStreams')),
        accounts: pollingSubscription(collection('accounts')),
        orderBooks: pollingSubscription(collection('orderBooks')),
      },
    },
  });
}
