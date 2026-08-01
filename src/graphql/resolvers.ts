import { createHash } from 'node:crypto';

import { makeExecutableSchema } from '@graphql-tools/schema';
import { GraphQLError } from 'graphql';

import { normalizeIndexedAccountId } from '../account-activity.js';
import { estimateRetainedValueBytes } from '../cache-weight.js';
import { metrics } from '../metrics.js';
import { evaluateServiceReadiness, type WorkerReadinessThresholds } from '../readiness.js';
import {
  createRepositoryCursorScope,
  decodeRepositoryCursor,
  encodeRepositoryCursor,
  isOpaqueRepositoryCursor,
  normalizeRepositoryCursorValue,
} from '../repository/cursor.js';
import { assertValidDocumentId } from '../repository/validation.js';
import {
  parseStoredSoraChainIdentity,
  parseStoredSoraChainState,
  SORA_LEGACY_IDENTITY_ANCHOR,
  SORA_MAINNET_GENESIS_HASH,
} from '../soraIdentity.js';
import { isAfterOrderPosition, matchesFilter, sortDocuments } from './filter.js';
import { getOrderField, NUMERIC_ORDER_FIELDS } from './order.js';
import { validatePublicConnectionQuery } from './query-policy.js';
import { CursorScalar, FilterScalars, JSONScalar, OrderByScalar } from './scalars.js';
import { typeDefs } from './schema.js';

import type {
  IndexerCollection,
  IndexerDocument,
  IndexerRepository,
  RepositoryQueryArgs,
  RepositoryQueryResult,
  RepositoryWatchEvent,
  RepositoryWatchMutation,
} from '../repository/types.js';
import type { ChainIndexerStatusProvider } from '../worker/status.js';
import type { AppConfig } from '../config.js';
import type { GraphQLResolveInfo, GraphQLSchema, SelectionNode } from 'graphql';

type Context = {
  repository: IndexerRepository;
  streamingRepository?: IndexerRepository;
  workerStatusProvider?: ChainIndexerStatusProvider;
  workerReadinessThresholds?: WorkerReadinessThresholds;
  graphqlQueryMaxBytes?: number;
};

type ConnectionArgs = {
  first?: number | null;
  last?: number | null;
  offset?: number | null;
  before?: string | null;
  after?: string | null;
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
  bytes: number;
};

type CacheOptions = {
  maxEntries: number;
  maxBytes: number;
  ttlMs: number;
};

const CACHE_ENTRY_OVERHEAD_BYTES = 128;

const DEFAULT_CONNECTION_PAGE_SIZE = 100;
const MAX_CONNECTION_PAGE_SIZE = 100;
const DEFAULT_GRAPHQL_QUERY_MAX_BYTES = 64 * 1_024 * 1_024;
const MAX_CONNECTION_OFFSET = 100_000;
// Real SubQuery-compatible filters can combine and/or groups with nested JSON
// `contains` payloads. Twelve admits those shapes while the independent node,
// array, key, and string budgets keep recursive inputs bounded.
const MAX_FILTER_DEPTH = 12;
// The pinned wallet's 39-operation history filter is ~295 recursive values
// before its bounded asset/id search branches. 1,024 admits the complete
// official builder while retaining independent depth,
// per-array, string, key, page, and transport-size limits.
const MAX_FILTER_NODES = 1_024;
const MAX_FILTER_ARRAY_LENGTH = 100;
const MAX_FILTER_STRING_LENGTH = 4_096;
const FORBIDDEN_INPUT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ORDER_TOKEN_PATTERN = /^[A-Z][A-Z0-9_]{0,126}_(ASC|DESC)$/i;
const STRING_ORDER_FIELDS = new Set([
  'id',
  'updatedAt',
  'symbol',
  'name',
  'status',
  'address',
  'account',
  'accountId',
  'assetId',
  'baseAssetId',
  'targetAssetId',
  'poolId',
  'orderBookId',
  'type',
  'module',
  'method',
  'creator',
  'side',
  'outcome',
]);

const collection = (name: IndexerCollection) => name;

const badUserInput = (message: string): GraphQLError =>
  new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });

const assertPublicConnectionQuery = (
  collectionName: IndexerCollection,
  orderBy: unknown,
  filter: Record<string, unknown> | null | undefined
): void => {
  try {
    validatePublicConnectionQuery(collectionName, orderBy, filter);
  } catch (error) {
    if (error instanceof GraphQLError) throw error;
    throw badUserInput(error instanceof Error ? error.message : 'Unsupported public connection query');
  }
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

export class TtlCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private bytes = 0;

  constructor(private readonly options: CacheOptions) {}

  async getOrSet<T>(name: string, key: string, load: () => Promise<T>): Promise<T> {
    if (this.options.ttlMs <= 0 || this.options.maxEntries <= 0 || this.options.maxBytes <= 0) {
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
    this.pruneExpired();
    const keyBytes = estimateRetainedValueBytes(key, this.options.maxBytes);
    const retainedKeyBytes = keyBytes + CACHE_ENTRY_OVERHEAD_BYTES;
    if (keyBytes > this.options.maxBytes || retainedKeyBytes > this.options.maxBytes) {
      metrics.increment('indexer_cache_bypass_total', { cache: name, reason: 'oversized-key' });
      return load();
    }
    if (this.entries.size >= this.options.maxEntries) {
      metrics.increment('indexer_cache_bypass_total', { cache: name, reason: 'capacity' });
      return load();
    }
    while (this.bytes + retainedKeyBytes > this.options.maxBytes) {
      const evictable = [...this.entries].find(([, entry]) => !entry.pending)?.[0];
      if (!evictable) {
        metrics.increment('indexer_cache_bypass_total', { cache: name, reason: 'byte-capacity' });
        return load();
      }
      this.delete(evictable);
    }
    const pending = load();
    const pendingEntry: CacheEntry<T> = {
      expiresAt: now + this.options.ttlMs,
      pending,
      bytes: retainedKeyBytes,
    };
    this.entries.set(key, pendingEntry);
    this.bytes += retainedKeyBytes;
    this.updateGauges();

    try {
      const value = await pending;
      const availableValueBytes = this.options.maxBytes - retainedKeyBytes;
      const valueBytes = estimateRetainedValueBytes(value, availableValueBytes);
      if (this.entries.get(key) === pendingEntry) this.delete(key);
      if (valueBytes > availableValueBytes) {
        metrics.increment('indexer_cache_bypass_total', { cache: name, reason: 'oversized' });
        this.updateGauges();
        return value;
      }
      const bytes = retainedKeyBytes + valueBytes;
      while (this.bytes + bytes > this.options.maxBytes) {
        const evictable = [...this.entries].find(([, entry]) => !entry.pending)?.[0];
        if (!evictable) {
          metrics.increment('indexer_cache_bypass_total', { cache: name, reason: 'byte-capacity' });
          this.updateGauges();
          return value;
        }
        this.delete(evictable);
      }
      this.entries.set(key, { expiresAt: Date.now() + this.options.ttlMs, value, bytes });
      this.bytes += bytes;
      this.prune();

      return value;
    } catch (error) {
      if (this.entries.get(key) === pendingEntry) this.delete(key);
      this.updateGauges();
      throw error;
    }
  }

  size(): number {
    this.pruneExpired();
    return this.entries.size;
  }

  private prune(): void {
    this.pruneExpired();

    while (this.entries.size > this.options.maxEntries || this.bytes > this.options.maxBytes) {
      const oldestKey = [...this.entries].find(([, entry]) => !entry.pending)?.[0];
      if (!oldestKey) return;

      this.delete(oldestKey);
    }
    this.updateGauges();
  }

  private pruneExpired(): void {
    const now = Date.now();

    for (const [key, entry] of this.entries) {
      if (!entry.pending && entry.expiresAt <= now) this.delete(key);
    }
  }

  private delete(key: string): void {
    const existing = this.entries.get(key);
    if (!existing || !this.entries.delete(key)) return;
    this.bytes -= existing.bytes;
  }

  private updateGauges(): void {
    metrics.setGauge('indexer_cache_entries', { cache: 'graphql' }, this.entries.size);
    metrics.setGauge('indexer_cache_bytes', { cache: 'graphql' }, this.bytes);
  }
}

const paginationKeyset = (
  args: ConnectionArgs,
  collectionName: IndexerCollection,
  orderBy: unknown,
  filter: Record<string, unknown> | null | undefined
): RepositoryQueryArgs['keyset'] => {
  if (args.after === null || args.after === undefined || args.after === '') return null;
  if (typeof args.after !== 'string' || !isOpaqueRepositoryCursor(args.after)) {
    throw badUserInput('Pagination cursor must be an opaque cursor returned by this connection');
  }
  const keyset = decodeRepositoryCursor(args.after);
  if (!keyset) throw badUserInput('Invalid pagination cursor');

  const { field, direction } = getOrderField(orderBy);
  const numeric = NUMERIC_ORDER_FIELDS.has(field);

  if (keyset.field !== field || keyset.direction !== direction || keyset.numeric !== numeric) {
    throw badUserInput('Pagination cursor does not match the requested order');
  }
  if (keyset.scope !== createRepositoryCursorScope(collectionName, orderBy, filter)) {
    throw badUserInput('Pagination cursor does not match the requested collection or filter');
  }

  return keyset;
};

const repositoryPaginationArgs = (
  args: ConnectionArgs,
  collectionName: IndexerCollection,
  orderBy: unknown,
  filter: Record<string, unknown> | null | undefined
): Pick<RepositoryQueryArgs, 'offset' | 'after' | 'before' | 'keyset'> => {
  const keyset = paginationKeyset(args, collectionName, orderBy, filter);

  return {
    offset: args.offset ?? null,
    after: null,
    before: null,
    keyset,
  };
};

const cursorForDocument = (
  collectionName: IndexerCollection,
  document: IndexerDocument,
  orderBy: unknown,
  filter: Record<string, unknown> | null | undefined
): string => {
  const { field, direction } = getOrderField(orderBy);
  const numeric = NUMERIC_ORDER_FIELDS.has(field);
  const value =
    field === 'id'
      ? document.id
      : field === 'timestamp'
        ? document.timestamp ?? document.data.timestamp
        : field === 'blockHeight'
          ? document.blockHeight ?? document.data.blockHeight
          : document.data[field];

  return encodeRepositoryCursor({
    scope: createRepositoryCursorScope(collectionName, orderBy, filter),
    field,
    direction,
    numeric,
    value: normalizeRepositoryCursorValue(value, numeric),
    id: document.id,
  });
};

const cursorForNode = (
  collectionName: IndexerCollection,
  node: Record<string, unknown>,
  orderBy: unknown,
  filter: Record<string, unknown> | null | undefined
): string => {
  const { field, direction } = getOrderField(orderBy);
  const numeric = NUMERIC_ORDER_FIELDS.has(field);
  const id = String(node.id ?? '');

  return encodeRepositoryCursor({
    scope: createRepositoryCursorScope(collectionName, orderBy, filter),
    field,
    direction,
    numeric,
    value: normalizeRepositoryCursorValue(field === 'id' ? id : node[field], numeric),
    id,
  });
};

const paginationWindow = (args: ConnectionArgs, totalCount: number) => {
  const first = args.first ?? DEFAULT_CONNECTION_PAGE_SIZE;
  const pageStart = Math.max(args.offset ?? 0, 0);
  return { end: Math.min(pageStart + Math.max(first, 0), totalCount), pageStart };
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

const validateConnectionInputValue = (
  value: unknown,
  label: string,
  depth = 0,
  budget = { nodes: 0 }
): void => {
  budget.nodes += 1;
  if (budget.nodes > MAX_FILTER_NODES) throw badUserInput(`${label} exceeds the maximum input node count`);
  if (depth > MAX_FILTER_DEPTH) throw badUserInput(`${label} exceeds the maximum input depth`);
  if (value === null || value === undefined || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw badUserInput(`${label} contains a non-finite number`);
    return;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_FILTER_STRING_LENGTH) throw badUserInput(`${label} contains an oversized string`);
    return;
  }
  if (typeof value !== 'object') throw badUserInput(`${label} contains an unsupported value`);

  if (Array.isArray(value)) {
    if (value.length > MAX_FILTER_ARRAY_LENGTH) throw badUserInput(`${label} contains an oversized array`);
    for (const item of value) validateConnectionInputValue(item, label, depth + 1, budget);
    return;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw badUserInput(`${label} must contain plain objects`);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_INPUT_KEYS.has(key)) throw badUserInput(`${label} contains a forbidden key`);
    if (key.length > 128) throw badUserInput(`${label} contains an oversized key`);
    validateConnectionInputValue(item, label, depth + 1, budget);
  }
};

const connectionSelectionNeedsItems = (info: GraphQLResolveInfo | undefined): boolean =>
  selectionIncludesField(info, 'edges') ||
  selectionIncludesField(info, 'nodes') ||
  selectionIncludesField(info, 'pageInfo');

const normalizeConnectionArgs = (
  args: ConnectionArgs,
  info?: GraphQLResolveInfo,
  maximumPageSize = MAX_CONNECTION_PAGE_SIZE
): ConnectionArgs => {
  const raw = args as ConnectionArgs & Record<string, unknown>;
  if (args.last !== undefined && args.last !== null) {
    throw badUserInput('last pagination is not supported; use first/after keyset pagination');
  }
  if (args.before !== undefined && args.before !== null && args.before !== '') {
    throw badUserInput('before pagination is not supported; use first/after keyset pagination');
  }
  const requestedOffset = args.offset ?? null;
  if (
    requestedOffset !== null &&
    (!Number.isSafeInteger(requestedOffset) || requestedOffset < 0 || requestedOffset > MAX_CONNECTION_OFFSET)
  ) {
    throw badUserInput(`offset must be an integer between 0 and ${MAX_CONNECTION_OFFSET}`);
  }

  const requestedFirst = args.first ?? DEFAULT_CONNECTION_PAGE_SIZE;
  if (!Number.isSafeInteger(requestedFirst) || requestedFirst < 0) {
    throw badUserInput('first must be a non-negative integer');
  }
  if (requestedFirst > maximumPageSize) {
    throw badUserInput(`first must not exceed ${maximumPageSize}`);
  }
  if (args.after !== undefined && args.after !== null && typeof args.after !== 'string') {
    throw badUserInput('after must be an opaque string cursor');
  }
  if (requestedOffset !== null && args.after !== undefined && args.after !== null && args.after !== '') {
    throw badUserInput('offset and after pagination cannot be combined');
  }
  if (requestedOffset !== null && requestedOffset + requestedFirst > MAX_CONNECTION_OFFSET) {
    throw badUserInput(`offset plus first must not exceed ${MAX_CONNECTION_OFFSET}`);
  }
  const orderTokens = args.orderBy === undefined || args.orderBy === null
    ? []
    : Array.isArray(args.orderBy)
      ? args.orderBy
      : [args.orderBy];
  for (const token of orderTokens) {
    if (typeof token !== 'string' || !ORDER_TOKEN_PATTERN.test(token)) {
      throw badUserInput('orderBy must contain bounded FIELD_ASC or FIELD_DESC string tokens');
    }
    const { field } = getOrderField(token);
    if (!STRING_ORDER_FIELDS.has(field) && !NUMERIC_ORDER_FIELDS.has(field)) {
      throw badUserInput(`orderBy field ${field} is not supported`);
    }
  }
  if (Array.isArray(args.orderBy) && args.orderBy.length > 1) {
    const primary = getOrderField(args.orderBy[0]);
    const tieBreaker = getOrderField(args.orderBy[1]);
    if (
      args.orderBy.length > 2 ||
      tieBreaker.field !== 'id' ||
      tieBreaker.direction !== primary.direction
    ) {
      throw badUserInput('orderBy may contain only one field followed by a matching ID tie-breaker');
    }
  }
  validateConnectionInputValue(args.filter, 'filter');
  if ('where' in raw) validateConnectionInputValue(raw.where, 'where');

  return {
    ...args,
    first: connectionSelectionNeedsItems(info) ? requestedFirst : 0,
    offset: requestedOffset,
  };
};

const buildConnection = (
  collectionName: IndexerCollection,
  items: Record<string, unknown>[],
  args: ConnectionArgs
) => {
  const filtered = sortDocuments(
    items.filter((item) => matchesFilter(item, args.filter)),
    args.orderBy
  );
  const totalCount = filtered.length;
  const keyset = paginationKeyset(args, collectionName, args.orderBy, args.filter);
  const remaining = keyset ? filtered.filter((item) => isAfterOrderPosition(item, keyset)) : filtered;
  const end = Math.min(args.first ?? DEFAULT_CONNECTION_PAGE_SIZE, remaining.length);
  const pageItems = remaining.slice(0, end);
  const edges: Edge[] = pageItems.map((node) => ({
    cursor: cursorForNode(collectionName, node, args.orderBy, args.filter),
    node,
  }));

  return {
    nodes: pageItems,
    edges,
    totalCount,
    pageInfo: {
      hasNextPage: end < remaining.length,
      hasPreviousPage: keyset !== null,
      startCursor: edges[0]?.cursor ?? null,
      endCursor: edges[edges.length - 1]?.cursor ?? null,
    },
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
    collectionName,
    documents.map((document) => document.data),
    normalizeConnectionArgs({ ...args, first: 1 })
  );
  const node = connection.edges[0]?.node;
  if (!node) return null;

  return documents.find((document) => document.data === node || document.id === node.id) ?? null;
};

const ACCOUNT_ACTIVITY_PAGE_SIZE = 1_000;
const ACCOUNT_ACTIVITY_PAGE_MAX_BYTES = 8 * 1_024 * 1_024;
export const NETWORK_ACCOUNT_ACTIVITY_MAX_DOCUMENTS = 100_000;
export const NETWORK_ACCOUNT_ACTIVITY_MAX_RANGE_SECONDS = 366 * 24 * 60 * 60;

type RangeScanBudget = {
  remaining: number;
};

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
  visit: (document: IndexerDocument) => void,
  budget: RangeScanBudget,
  maxBytes: number
): Promise<void> => {
  const rangeStart = Math.min(from, to);
  const rangeEnd = Math.max(from, to);
  const filter = { timestamp: { greaterThanOrEqualTo: rangeStart, lessThanOrEqualTo: rangeEnd } };

  if (!repository.query) {
    const documents = await repository.list(collectionName);
    const matchingDocuments = documents.filter((document) => matchesFilter(document.data, filter));
    if (matchingDocuments.length > budget.remaining) {
      throw new Error(`networkAccountActivity exceeds its ${NETWORK_ACCOUNT_ACTIVITY_MAX_DOCUMENTS}-document scan budget`);
    }
    budget.remaining -= matchingDocuments.length;
    matchingDocuments.forEach(visit);
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
      maxBytes,
    });

    if (result.items.length > budget.remaining || (result.items.length === budget.remaining && result.hasNextPage)) {
      throw new Error(`networkAccountActivity exceeds its ${NETWORK_ACCOUNT_ACTIVITY_MAX_DOCUMENTS}-document scan budget`);
    }
    budget.remaining -= result.items.length;
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
 * timestamp range from the first-release account transaction collection.
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
  if (range.to - range.from > NETWORK_ACCOUNT_ACTIVITY_MAX_RANGE_SECONDS) {
    throw new Error(
      `networkAccountActivity range exceeds ${NETWORK_ACCOUNT_ACTIVITY_MAX_RANGE_SECONDS} seconds`
    );
  }

  const accounts = new Set<string>();
  const scanBudget: RangeScanBudget = { remaining: NETWORK_ACCOUNT_ACTIVITY_MAX_DOCUMENTS };

  await visitRangeDocuments(
    context.streamingRepository?.query ? context.streamingRepository : context.repository,
    collection('accountTransactions'),
    range.from,
    range.to,
    (document) => {
      addAccountId(accounts, document.data.accountId);
    },
    scanBudget,
    Math.min(context.graphqlQueryMaxBytes ?? DEFAULT_GRAPHQL_QUERY_MAX_BYTES, ACCOUNT_ACTIVITY_PAGE_MAX_BYTES)
  );

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

const mapWithConcurrency = async <T, R>(
  values: readonly T[],
  concurrency: number,
  map: (value: T) => Promise<R>
): Promise<R[]> => {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await map(values[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
};

const buildPolkamarktSignalAccuracy = async (
  repository: IndexerRepository,
  markets: IndexerDocument[]
): Promise<{ summary: Record<string, unknown> | null; series: Array<Record<string, unknown>> }> => {
  const resolvedMarkets = markets.filter((market) => {
    return signalStatus(market.data.status) === 'resolved' && Boolean(signalOutcome(market.data.resolutionOutcome));
  });

  if (!resolvedMarkets.length) return { summary: null, series: [] };

  const results = await mapWithConcurrency(resolvedMarkets, 8, (market) =>
    scorePolkamarktSignalMarket(repository, market)
  );
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
    queryDocuments(context.repository, collection('markets'), { first: 1_000 }, {}, ['VOLUME_USD_DESC'], {
      includeTotalCount: false,
      trustedMaxPageSize: 1_000,
      maxBytes: context.graphqlQueryMaxBytes,
    }),
    queryDocuments(
      context.repository,
      collection('historyElements'),
      { first: 1_000 },
      { module: { equalTo: 'polkamarkt' } },
      ['TIMESTAMP_DESC'],
      {
        includeTotalCount: false,
        trustedMaxPageSize: 1_000,
        maxBytes: context.graphqlQueryMaxBytes,
      }
    ),
    queryDocuments(context.repository, collection('networkSnapshots'), { first: 8 }, {}, ['TIMESTAMP_DESC'], {
      includeTotalCount: false,
      maxBytes: context.graphqlQueryMaxBytes,
    }),
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

  const requestedLimit = Math.max(Number(args.first ?? DEFAULT_CONNECTION_PAGE_SIZE), 0);

  return requestedLimit <= 100;
};

const createConnectionResolver =
  (cache: TtlCache, queryMaxBytes: number) =>
  (collectionName: IndexerCollection) =>
  async (_parent: unknown, args: ConnectionArgs, context: Context, info?: GraphQLResolveInfo) => {
    const normalizedArgs = normalizeConnectionArgs(args, info);
    assertPublicConnectionQuery(collectionName, normalizedArgs.orderBy, normalizedArgs.filter);
    const resolveConnection = async () => {
      if (context.repository.query) {
        const includeTotalCount = selectionIncludesField(info, 'totalCount');
        const result = await context.repository.query(collectionName, {
          ...normalizedArgs,
          ...repositoryPaginationArgs(
            normalizedArgs,
            collectionName,
            normalizedArgs.orderBy,
            normalizedArgs.filter
          ),
          includeTotalCount,
          maxBytes: queryMaxBytes,
        });
        const fallbackTotalCount =
          result.totalCount ?? (result.pageStart ?? 0) + result.items.length + (result.hasNextPage ? 1 : 0);
        const { end, pageStart: fallbackPageStart } = paginationWindow(normalizedArgs, fallbackTotalCount);
        const pageStart = result.pageStart ?? fallbackPageStart;
        const nodes = result.items.map((document) => toConnectionNode(collectionName, document));
        const edges: Edge[] = result.items.map((document, index) => ({
          cursor:
            result.itemCursors?.[index] ??
            cursorForDocument(
              collectionName,
              document,
              normalizedArgs.orderBy,
              normalizedArgs.filter
            ),
          node: nodes[index]!,
        }));

        return {
          nodes,
          edges,
          totalCount: result.totalCount ?? fallbackTotalCount,
          pageInfo: {
            hasNextPage: result.hasNextPage ?? end < fallbackTotalCount,
            hasPreviousPage: result.hasPreviousPage ?? Boolean(normalizedArgs.after),
            startCursor: edges[0]?.cursor ?? null,
            endCursor: edges[edges.length - 1]?.cursor ?? null,
          },
        };
      }

      const documents = await context.repository.list(collectionName);
      return buildConnection(
        collectionName,
        documents.map((document) => document.data),
        normalizedArgs
      );
    };

    if (!shouldCacheConnection(collectionName, normalizedArgs)) return resolveConnection();

    const includeTotalCount = selectionIncludesField(info, 'totalCount');
    const key = `connection:${collectionName}:${stableJson({ ...normalizedArgs, includeTotalCount })}`;

    return cache.getOrSet(`connection_${collectionName}`, key, resolveConnection);
  };

const createDocumentResolver =
  (cache: TtlCache) =>
  (collectionName: IndexerCollection) =>
  async (_parent: unknown, args: { id: string }, context: Context): Promise<Record<string, unknown> | null> => {
    try {
      assertValidDocumentId(args.id);
    } catch {
      throw badUserInput('Document id must be a non-empty bounded printable identifier');
    }
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

const normalizeAccountPositionOrder = (orderBy: unknown): unknown => {
  const normalizeToken = (token: unknown): unknown => {
    if (typeof token !== 'string') return token;
    const normalized = token.toUpperCase();
    if (normalized === 'UPDATED_AT_ASC') return 'TIMESTAMP_ASC';
    if (normalized === 'UPDATED_AT_DESC') return 'TIMESTAMP_DESC';
    return token;
  };

  return Array.isArray(orderBy) ? orderBy.map(normalizeToken) : normalizeToken(orderBy);
};

const queryDocuments = async (
  repository: IndexerRepository,
  collectionName: IndexerCollection,
  args: AccountActivityConnectionArgs,
  filter: Record<string, unknown>,
  orderBy: unknown = ['TIMESTAMP_DESC'],
  options: { includeTotalCount?: boolean; trustedMaxPageSize?: number; maxBytes?: number } = {}
) => {
  const normalizedArgs = normalizeConnectionArgs(args, undefined, options.trustedMaxPageSize ?? MAX_CONNECTION_PAGE_SIZE);
  validateConnectionInputValue(filter, 'filter');
  const queryArgs: RepositoryQueryArgs = {
    first: normalizedArgs.first,
    ...repositoryPaginationArgs(normalizedArgs, collectionName, orderBy, filter),
    orderBy,
    filter,
    includeTotalCount: options.includeTotalCount ?? true,
    maxBytes: options.maxBytes ?? DEFAULT_GRAPHQL_QUERY_MAX_BYTES,
  };

  if (repository.query) return repository.query(collectionName, queryArgs);

  const documents = await repository.list(collectionName);
  const filtered = sortDocuments(
    documents.filter((document) => matchesFilter(document.data, filter)),
    orderBy
  );
  const totalCount = filtered.length;
  const { end, pageStart } = paginationWindow(normalizedArgs, totalCount);

  return {
    items: filtered.slice(pageStart, end),
    totalCount,
    pageStart,
    hasNextPage: end < totalCount,
    hasPreviousPage: pageStart > 0,
  };
};

const connectionFromNodes = (
  collectionName: IndexerCollection,
  nodes: Record<string, unknown>[],
  result: Pick<
    RepositoryQueryResult,
    'totalCount' | 'itemCursors' | 'pageStart' | 'hasNextPage' | 'hasPreviousPage'
  >,
  args: ConnectionArgs,
  filter: Record<string, unknown> | null | undefined
) => {
  const fallbackTotalCount =
    result.totalCount ?? (result.pageStart ?? 0) + nodes.length + (result.hasNextPage ? 1 : 0);
  const { pageStart: fallbackPageStart } = paginationWindow(args, fallbackTotalCount);
  const pageStart = result.pageStart ?? fallbackPageStart;
  const edges: Edge[] = nodes.map((node, index) => ({
    cursor:
      result.itemCursors?.[index] ??
      cursorForNode(collectionName, node, args.orderBy, filter),
    node,
  }));

  return {
    edges,
    totalCount: fallbackTotalCount,
    pageInfo: {
      hasNextPage: result.hasNextPage ?? false,
      hasPreviousPage: result.hasPreviousPage ?? Boolean(args.after),
      startCursor: edges[0]?.cursor ?? null,
      endCursor: edges[edges.length - 1]?.cursor ?? null,
    },
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
    extrinsicHash:
      readString(source.historyElementId) ??
      readString(historyDocument?.id) ??
      readString(source.id),
    market: marketId === null ? null : { id: String(marketId), marketId },
  };
};

const accountPositionsResolver = async (
  _parent: unknown,
  args: AccountActivityConnectionArgs,
  context: Context
) => {
  const normalizedArgs = normalizeConnectionArgs(args);
  const filter = accountPositionFilterFromArgs(args);
  const orderBy = normalizeAccountPositionOrder(args.orderBy ?? ['UPDATED_AT_DESC']);
  assertPublicConnectionQuery('accountPositions', orderBy, filter);
  const result = await queryDocuments(
    context.repository,
    collection('accountPositions'),
    normalizedArgs,
    filter,
    orderBy,
    { maxBytes: context.graphqlQueryMaxBytes }
  );

  return connectionFromNodes(
    collection('accountPositions'),
    result.items.map((document) => document.data),
    result,
    { ...normalizedArgs, orderBy },
    filter
  );
};

const accountTradesResolver = async (
  _parent: unknown,
  args: AccountActivityConnectionArgs,
  context: Context
) => {
  const normalizedArgs = normalizeConnectionArgs(args);
  const orderBy = args.orderBy ?? ['TIMESTAMP_DESC'];
  assertPublicConnectionQuery('accountTrades', orderBy, accountPositionFilterFromArgs(args));
  const account = readAccountFromArgs(args);
  if (!account) return buildConnection(collection('accountTrades'), [], normalizedArgs);

  const transactionFilter = { accountId: { equalTo: account } };
  const accountTransactionResult = await queryDocuments(
    context.repository,
    collection('accountTransactions'),
    normalizedArgs,
    transactionFilter,
    orderBy,
    { maxBytes: context.graphqlQueryMaxBytes }
  );

  const nodes = accountTransactionResult.items.map((document) =>
    toAccountTradeNode(null, account, document)
  );
  return connectionFromNodes(
    collection('accountTransactions'),
    nodes,
    accountTransactionResult,
    { ...normalizedArgs, orderBy },
    transactionFilter
  );
};

type MutationPayload = {
  id: string;
  mutation_type: RepositoryWatchMutation;
  _entity: Record<string, unknown>;
};

type SubscriptionArgs = {
  id?: string | string[];
  mutation?: RepositoryWatchMutation[];
};

export const MAX_SUBSCRIPTION_IDS = 100;

const getSubscriptionIds = (id: unknown): string[] => {
  const candidates = Array.isArray(id) ? id : id === undefined || id === null ? [] : [id];
  if (candidates.length === 0) {
    throw badUserInput('subscription id must contain between 1 and 100 values');
  }
  if (candidates.length > MAX_SUBSCRIPTION_IDS) {
    throw badUserInput(`subscription id must contain at most ${MAX_SUBSCRIPTION_IDS} values`);
  }
  const ids: string[] = [];
  for (const candidate of candidates) {
    const value = String(candidate);
    try {
      assertValidDocumentId(value);
    } catch {
      throw badUserInput('subscription id values must be non-empty bounded printable identifiers');
    }
    if (!ids.includes(value)) ids.push(value);
  }
  return ids;
};

const getSubscriptionMutations = (mutation: unknown): Set<RepositoryWatchMutation> => {
  const candidates = Array.isArray(mutation) && mutation.length
    ? mutation
    : ['INSERT', 'UPDATE', 'DELETE'];
  const mutations = new Set<RepositoryWatchMutation>();
  for (const candidate of candidates) {
    if (candidate !== 'INSERT' && candidate !== 'UPDATE' && candidate !== 'DELETE') {
      throw badUserInput('subscription mutation contains an unsupported value');
    }
    mutations.add(candidate);
  }
  return mutations;
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

/** Fixed-size polling state avoids retaining one complete serialized document per subscription id. */
export const subscriptionDocumentFingerprint = (data: Record<string, unknown>): string =>
  createHash('sha256').update(JSON.stringify(data)).digest('base64url');

async function* pollSubscription(
  collectionName: IndexerCollection,
  args: SubscriptionArgs,
  context: Context,
  signal: AbortSignal
): AsyncGenerator<RepositoryWatchEvent, void, unknown> {
  const ids = getSubscriptionIds(args.id);
  const mutations = getSubscriptionMutations(args.mutation);
  const snapshots = new Map<string, string>();

  while (!signal.aborted) {
    const seen = new Set<string>();
    const emissions: RepositoryWatchEvent[] = [];

    // A fallback repository may not implement watch(). Read one bounded legal
    // document at a time so 100 large ids cannot coexist before transport
    // admission merely to compute their fixed-size fingerprints.
    for (const id of ids) {
      const document = await context.repository.get(collectionName, id);
      if (!document) continue;
      seen.add(document.id);

      const fingerprint = subscriptionDocumentFingerprint(document.data);
      if (snapshots.get(document.id) === fingerprint) continue;

      snapshots.set(document.id, fingerprint);
      emissions.push({
        collection: collectionName,
        id: document.id,
        mutationType: 'UPDATE',
      });
    }
    for (const id of [...snapshots.keys()]) {
      if (seen.has(id)) continue;
      snapshots.delete(id);
      emissions.push({ collection: collectionName, id, mutationType: 'DELETE' });
    }
    for (const event of emissions) {
      if (mutations.has(event.mutationType)) yield event;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(finish, 5_000);
      const abort = () => finish();
      function finish() {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        resolve();
      }
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
}

async function* watchSubscription(
  collectionName: IndexerCollection,
  args: SubscriptionArgs,
  context: Context,
  signal: AbortSignal
): AsyncGenerator<RepositoryWatchEvent, void, unknown> {
  const ids = getSubscriptionIds(args.id);
  const mutations = getSubscriptionMutations(args.mutation);
  const sourceRepository = context.streamingRepository ?? context.repository;

  if (!sourceRepository.watch) {
    yield* pollSubscription(collectionName, args, { ...context, repository: sourceRepository }, signal);
    return;
  }

  for await (const event of sourceRepository.watch(collectionName, ids, signal)) {
    if (event.collection !== collectionName || !ids.includes(event.id)) {
      throw new Error('Repository watch emitted an event outside its requested subscription scope');
    }
    if (mutations.has(event.mutationType)) yield event;
  }
}

const cancellableSubscription = (
  create: (signal: AbortSignal) => AsyncGenerator<RepositoryWatchEvent, void, unknown>
): AsyncIterableIterator<RepositoryWatchEvent> => {
  const controller = new AbortController();
  const iterator = create(controller.signal);
  const subscription: AsyncIterableIterator<RepositoryWatchEvent> = {
    next: () => iterator.next(),
    return: async () => {
      controller.abort();
      return iterator.return ? iterator.return(undefined) : { done: true, value: undefined };
    },
    throw: async (error?: unknown) => {
      controller.abort();
      if (iterator.throw) return iterator.throw(error);
      throw error;
    },
    [Symbol.asyncIterator]: () => subscription,
  };
  return subscription;
};

const pollingSubscription = (collectionName: IndexerCollection) => ({
  subscribe: (_parent: unknown, args: SubscriptionArgs, context: Context) =>
    cancellableSubscription((signal) => watchSubscription(collectionName, args, context, signal)),
  // This resolver runs after the transport has admitted and reserved the
  // emission. Only now materialize the full document under the operation's
  // aggregate repository byte budget.
  resolve: async (
    event: RepositoryWatchEvent,
    _args: SubscriptionArgs,
    context: Context
  ): Promise<MutationPayload> => {
    if (event.mutationType === 'DELETE') {
      return { id: event.id, mutation_type: 'DELETE', _entity: { id: event.id } };
    }
    const document = await context.repository.get(collectionName, event.id);
    if (!document) {
      return { id: event.id, mutation_type: 'DELETE', _entity: { id: event.id } };
    }
    return {
      id: event.id,
      mutation_type: event.mutationType,
      _entity: toMutationEntity(collectionName, document.data),
    };
  },
});

const POLKASWAP_SERVICE_ID = 'pi.soramitsu.io';
const POLKASWAP_PUBLIC_BASE_URL = 'https://pi.soramitsu.io/graphql';
const MAX_HEALTH_AGE_SECONDS = 300;
const MAX_HEALTH_FUTURE_SKEW_SECONDS = 30;

const parsedUpdateStreamData = (document: IndexerDocument | null, expectedId: string): unknown | null => {
  if (
    !document ||
    document.collection !== 'updatesStreams' ||
    document.id !== expectedId ||
    Object.keys(document.data).sort().join(',') !== 'block,data,id' ||
    document.data.id !== expectedId ||
    typeof document.data.data !== 'string'
  ) {
    return null;
  }

  try {
    return JSON.parse(document.data.data);
  } catch {
    return null;
  }
};

const healthResolver = async (_parent: unknown, _args: unknown, context: Context) => {
  const [readiness, identityDocument, stateDocument] = await Promise.all([
    evaluateServiceReadiness(
      context.repository,
      context.workerStatusProvider,
      context.workerReadinessThresholds ?? { maxLagBlocks: 25, maxStalenessSeconds: 120 }
    ),
    context.repository.get('updatesStreams', 'chainIdentity').catch(() => null),
    context.repository.get('updatesStreams', 'chainState').catch(() => null),
  ]);
  const workerStatus = readiness.worker.status;
  const identity = parseStoredSoraChainIdentity(parsedUpdateStreamData(identityDocument, 'chainIdentity'));
  const state = parseStoredSoraChainState(parsedUpdateStreamData(stateDocument, 'chainState'));
  const identityValid =
    identity !== null &&
    identityDocument !== null &&
    identityDocument.data.block === identity.verificationBlock &&
    identityDocument.blockHeight === identity.verificationBlock &&
    identityDocument.timestamp === identity.verificationBlockTimestamp &&
    (identity.migration !== 'legacy-production-anchor-v1' ||
      (identity.verificationBlock === SORA_LEGACY_IDENTITY_ANCHOR.block &&
        identity.verificationBlockHash === SORA_LEGACY_IDENTITY_ANCHOR.hash &&
        identity.verificationBlockTimestamp === SORA_LEGACY_IDENTITY_ANCHOR.timestamp));
  const stateValid =
    state !== null &&
    stateDocument !== null &&
    stateDocument.data.block === state.lastIndexedBlock &&
    stateDocument.blockHeight === state.lastIndexedBlock &&
    Number.isSafeInteger(stateDocument.timestamp) &&
    Number(stateDocument.timestamp) > 0;
  const latestIndexedBlock = stateValid ? state.lastIndexedBlock : null;
  const latestIndexedAt = stateValid ? state.blockTimestamp : null;
  const latestIndexedBlockHash = stateValid ? state.blockHash : null;
  const stateAge =
    latestIndexedAt === null
      ? Number.POSITIVE_INFINITY
      : Math.floor(Date.now() / 1_000) - latestIndexedAt;
  const checkpointCoherent =
    identityValid &&
    stateValid &&
    state.lastIndexedBlock >= identity.verificationBlock &&
    state.blockTimestamp >= identity.verificationBlockTimestamp;
  const checkpointFresh =
    stateAge >= -MAX_HEALTH_FUTURE_SKEW_SECONDS && stateAge <= MAX_HEALTH_AGE_SECONDS;

  return {
    ok: readiness.ok && checkpointCoherent && checkpointFresh,
    repositoryReady: readiness.repositoryReady,
    service: 'polkaswap-indexer',
    serviceId: POLKASWAP_SERVICE_ID,
    schemaVersion: 1,
    ecosystem: 'sora2',
    chainId: 'sora:mainnet',
    network: 'mainnet',
    publicBaseUrl: POLKASWAP_PUBLIC_BASE_URL,
    readOnly: true,
    genesisHash: identityValid ? SORA_MAINNET_GENESIS_HASH : null,
    latestIndexedBlock,
    latestIndexedBlockHash,
    latestIndexedAt,
    workerAvailable: readiness.worker.available,
    workerReady: readiness.worker.ready,
    workerReadinessReason: readiness.worker.reason,
    workerLifecycle: workerStatus?.lifecycle ?? null,
    workerStartupComplete: workerStatus?.startupComplete ?? null,
    workerLatestFinalizedBlock: workerStatus?.latestFinalizedBlock ?? null,
    workerLatestIndexedBlock: workerStatus?.latestIndexedBlock ?? null,
    workerLag: workerStatus?.lag ?? null,
    workerLastSuccessfulIndexTimestamp: workerStatus?.lastSuccessfulIndexTimestamp ?? null,
    workerLastError: workerStatus?.lastError ?? null,
    workerLastErrorTimestamp: workerStatus?.lastErrorTimestamp ?? null,
  };
};

type GraphqlResolverConfig = Pick<
  AppConfig,
  'graphqlCacheMaxEntries' | 'graphqlCacheMaxBytes' | 'graphqlCacheTtlMs'
> & Partial<Pick<AppConfig, 'graphqlMaxResultBytes'>>;

const DEFAULT_GRAPHQL_CACHE_CONFIG: GraphqlResolverConfig = {
  graphqlCacheMaxEntries: 1_000,
  graphqlCacheMaxBytes: 64 * 1_024 * 1_024,
  graphqlCacheTtlMs: 2_000,
  graphqlMaxResultBytes: DEFAULT_GRAPHQL_QUERY_MAX_BYTES,
};

export function createSchema(config: GraphqlResolverConfig = DEFAULT_GRAPHQL_CACHE_CONFIG): GraphQLSchema {
  const cache = new TtlCache({
    maxEntries: config.graphqlCacheMaxEntries,
    maxBytes: config.graphqlCacheMaxBytes,
    ttlMs: config.graphqlCacheTtlMs,
  });
  const connectionResolver = createConnectionResolver(
    cache,
    config.graphqlMaxResultBytes ?? DEFAULT_GRAPHQL_QUERY_MAX_BYTES
  );
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
