import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { RocksDatabase } from '@harperfast/rocksdb-js';

import { matchesFilter } from '../graphql/filter.js';
import { getOrderField, NUMERIC_ORDER_FIELDS } from '../graphql/order.js';
import { metrics } from '../metrics.js';
import { estimateRetainedValueBytes } from '../cache-weight.js';
import {
  assertServeablePostgresRocksdbMigrationState,
  POSTGRES_ROCKSDB_MIGRATION_STATE_KEY,
} from '../scripts/rocksdb-migration-state.js';
import {
  createRepositoryCursorScope,
  encodeRepositoryCursor,
  normalizeRepositoryCursorValue,
} from './cursor.js';
import { decodeRocksDocument, encodeRocksDocument } from './rocksdb-document.js';
import { INDEXER_COLLECTIONS } from './types.js';
import { LatestDocumentWatchQueue } from './watch-queue.js';
import {
  assertValidDocumentId,
  assertValidIndexedDecimal,
  assertValidIndexerCollection,
  assertValidRepositoryQueryPositions,
  iterateIndexerDocumentJsonPayloads,
  normalizeIndexerDocumentWriteCall,
} from './validation.js';

import type { AppConfig } from '../config.js';
import type {
  IndexerCollection,
  IndexerDocument,
  IndexerRepository,
  RepositoryMetricsSnapshot,
  RepositoryQueryArgs,
  RepositoryQueryResult,
  RepositoryWatchEvent,
} from './types.js';

type RocksKeyPart = string | number | boolean | Buffer | null;
type RocksKey = RocksKeyPart[];
type IndexRange = {
  keyKind: 'document' | 'index';
  options: Record<string, unknown>;
};
type QuerySource = {
  ranges: IndexRange[];
  preservesOrder: boolean;
  reason: string;
  /** A compact, query-selective source that still needs an in-memory sort. */
  boundedSort?: boolean;
  /** Transactionally maintained exact counts for complete unbounded prefixes. */
  exactCountKeys?: RocksKey[];
  mergeOrder?: {
    field: 'timestamp' | 'blockHeight';
    direction: 'asc' | 'desc';
  };
};
type CompactIndexOrderField = 'timestamp' | 'blockHeight' | 'updatedAtBlock';
type CompactIndexDefinition = {
  code: string;
  equalityFields: readonly string[];
  orderField: CompactIndexOrderField;
  when?: Readonly<Record<string, string>>;
};
type CompactIdEqualityIndexDefinition = {
  code: string;
  field: string;
};
type NumericRangeBound = {
  value: number;
  inclusive: boolean;
};
type NumericRangeBounds = {
  lower?: NumericRangeBound;
  upper?: NumericRangeBound;
};
type ExactNumericRangeBound = {
  value: string;
  inclusive: boolean;
};
type ExactNumericRangeBounds = {
  lower?: ExactNumericRangeBound;
  upper?: ExactNumericRangeBound;
};
type OrderedRangeBounds = {
  lower?: { value: number | string; inclusive: boolean };
  upper?: { value: number | string; inclusive: boolean };
};
type OrderedPosition = {
  value: string | number | null;
  id: string;
};
type WatchSubscriber = {
  id: number;
  collection: IndexerCollection;
  ids: Set<string>;
  queue: LatestDocumentWatchQueue;
  notify: (() => void) | null;
};

export type RocksRepositoryOptions = {
  /** Opens an existing database without creating directories or permitting writes/maintenance. */
  readOnly?: boolean;
  /** Allows only the migration command to resume an incomplete destination. */
  allowIncompleteMigration?: boolean;
};

export type RocksReadView = Pick<
  RocksDatabase,
  'getSync' | 'getRange' | 'getKeysCount' | 'getEstimatedKeyCount' | 'getStats'
>;

const HIGH_KEY = Buffer.from([0xff]);
const WATCH_IDLE_WAKE_INTERVAL_MS = 30_000;
const FALLBACK_CURSOR_VALUE_PREFIX = '\u0000rkv1.';
export const ROCKSDB_FORMAT_METADATA_KEY = 'rocksdbFormatVersion';
export const ROCKSDB_FORMAT_VERSION = 1;
const NUMERIC_LENGTH_WIDTH = 4;
const MAX_NUMERIC_INTEGER_LENGTH = 10 ** NUMERIC_LENGTH_WIDTH - 1;
const NUMERIC_EQUALITY_FIELDS = new Set(['marketId']);
const NUMERIC_NEGATIVE_DIGIT_MAP: Record<string, string> = {
  '0': '9',
  '1': '8',
  '2': '7',
  '3': '6',
  '4': '5',
  '5': '4',
  '6': '3',
  '7': '2',
  '8': '1',
  '9': '0',
};

const NUMERIC_INDEX_COLLECTIONS = {
  liquidity: ['assets'],
  liquidityBooks: ['assets'],
  priceUSD: ['assets'],
  baseAssetReserves: ['poolXYKs'],
  strategicBonusApy: ['poolXYKs'],
} satisfies Record<string, string[]>;

/**
 * Compact indexes deliberately mirror high-volume query shapes instead of
 * multiplying every equality field by timestamp and block height. Codes are
 * short because they are stored in every key.
 */
const COMPACT_INDEX_MANIFEST: Partial<Record<IndexerCollection, readonly CompactIndexDefinition[]>> = {
  accountLiquiditySnapshots: [
    { code: 'a-t', equalityFields: ['accountLiquidityId'], orderField: 'timestamp' },
    { code: 'y-t', equalityFields: ['type'], orderField: 'timestamp' },
  ],
  accountMeta: [{ code: 't', equalityFields: [], orderField: 'timestamp' }],
  accountPositions: [{ code: 'a-t', equalityFields: ['account'], orderField: 'timestamp' }],
  accountTransactions: [
    { code: 't', equalityFields: [], orderField: 'timestamp' },
    { code: 'a-t', equalityFields: ['accountId'], orderField: 'timestamp' },
  ],
  assetSnapshots: [
    { code: 't', equalityFields: [], orderField: 'timestamp' },
    { code: 'y-t', equalityFields: ['type'], orderField: 'timestamp' },
    { code: 'a-t', equalityFields: ['assetId', 'type'], orderField: 'timestamp' },
    { code: 'a-b', equalityFields: ['assetId'], orderField: 'blockHeight' },
  ],
  historyElements: [
    // Worker analytics replays the rolling history window without an account
    // or module anchor and paginates it by timestamp.
    { code: 't', equalityFields: [], orderField: 'timestamp' },
    { code: 'ab-b', equalityFields: ['address'], orderField: 'blockHeight', when: { module: 'assets', method: 'burn' } },
    { code: 'bo-b', equalityFields: ['address'], orderField: 'blockHeight', when: { module: 'ethBridge', method: 'transferToSidechain' } },
    { code: 'bi-b', equalityFields: ['payloadTo'], orderField: 'blockHeight', when: { module: 'bridgeMultisig', method: 'asMulti' } },
    { code: 'as-b', equalityFields: ['address'], orderField: 'blockHeight', when: { module: 'liquidityProxy', method: 'swap' } },
    { code: 'ad-b', equalityFields: ['address'], orderField: 'blockHeight', when: { module: 'poolXYK', method: 'depositLiquidity' } },
    { code: 'aw-b', equalityFields: ['address'], orderField: 'blockHeight', when: { module: 'poolXYK', method: 'withdrawLiquidity' } },
    { code: 'xb-b', equalityFields: ['payloadAssetId'], orderField: 'blockHeight', when: { module: 'assets', method: 'burn' } },
    { code: 'a-t', equalityFields: ['address'], orderField: 'timestamp' },
    { code: 'p-t', equalityFields: [], orderField: 'timestamp', when: { module: 'polkamarkt' } },
  ],
  marketSnapshots: [
    { code: 'y-t', equalityFields: ['type'], orderField: 'timestamp' },
    { code: 'mt-t', equalityFields: ['marketId', 'type'], orderField: 'timestamp' },
    { code: 'mt-b', equalityFields: ['marketId', 'type'], orderField: 'blockHeight' },
  ],
  networkSnapshots: [
    { code: 't', equalityFields: [], orderField: 'timestamp' },
    { code: 'y-t', equalityFields: ['type'], orderField: 'timestamp' },
    { code: 'y-b', equalityFields: ['type'], orderField: 'blockHeight' },
  ],
  orderBookOrders: [
    { code: 't', equalityFields: [], orderField: 'timestamp' },
    { code: 'a-t', equalityFields: ['accountId'], orderField: 'timestamp' },
    { code: 'o-t', equalityFields: ['orderBookId'], orderField: 'timestamp' },
  ],
  orderBookSnapshots: [
    { code: 't', equalityFields: [], orderField: 'timestamp' },
    { code: 'y-t', equalityFields: ['type'], orderField: 'timestamp' },
    { code: 'o-t', equalityFields: ['orderBookId', 'type'], orderField: 'timestamp' },
  ],
  poolSnapshots: [
    { code: 'y-t', equalityFields: ['type'], orderField: 'timestamp' },
    { code: 'p-t', equalityFields: ['poolId', 'type'], orderField: 'timestamp' },
  ],
  vaultEvents: [{ code: 'v-t', equalityFields: ['vaultId'], orderField: 'timestamp' }],
  vaults: [{ code: 'o-u', equalityFields: ['ownerId'], orderField: 'updatedAtBlock' }],
};

const COMPACT_ID_EQUALITY_INDEX_MANIFEST: Partial<
  Record<IndexerCollection, readonly CompactIdEqualityIndexDefinition[]>
> = {
  accountPointSystems: [{ code: 'a-i', field: 'accountId' }],
  orderBooks: [
    { code: 'b-i', field: 'baseAssetId' },
    { code: 'q-i', field: 'quoteAssetId' },
  ],
  poolXYKs: [
    { code: 'b-i', field: 'baseAssetId' },
    { code: 't-i', field: 'targetAssetId' },
  ],
  referrerRewards: [{ code: 'r-i', field: 'referrer' }],
  stakingValidators: [{ code: 'a-i', field: 'address' }],
  vaults: [{ code: 'o-i', field: 'ownerId' }],
};

const COMPACT_EQUALITY_FIELDS = new Set(
  Object.values(COMPACT_INDEX_MANIFEST).flatMap((definitions) =>
    (definitions ?? []).flatMap((definition) => definition.equalityFields)
  )
);

const COMPACT_NUMERIC_INDEX_COLLECTIONS = new Set<IndexerCollection>(
  Object.values(NUMERIC_INDEX_COLLECTIONS).flat() as IndexerCollection[]
);

const secondsSince = (startedAt: number): number => (Date.now() - startedAt) / 1000;
const afterToOffset = (after: RepositoryQueryArgs['after']): number => {
  if (after === null || after === undefined || after === '') return 0;

  const parsed = Number(after);
  return Number.isFinite(parsed) ? parsed + 1 : 0;
};

const rangeForPrefix = (prefix: RocksKey, options: Record<string, unknown> = {}): Record<string, unknown> => {
  const reverse = options.reverse === true;

  return {
    start: reverse ? [...prefix, HIGH_KEY] : prefix,
    end: reverse ? prefix : [...prefix, HIGH_KEY],
    inclusiveEnd: true,
    ...options,
  };
};

const documentKey = (collection: IndexerCollection, id: string): RocksKey => ['d', collection, id];
const countKey = (collection: IndexerCollection): RocksKey => ['m', 'count', collection];
const indexCountKey = (collection: IndexerCollection, code: string, equalityValues: RocksKeyPart[] = []): RocksKey => [
  'm',
  'indexCount',
  collection,
  code,
  ...equalityValues,
];
const metadataKey = (name: string): RocksKey => ['m', 'metadata', name];

const readDocumentPosition = (
  document: IndexerDocument,
  field: 'timestamp' | 'blockHeight'
): number | null => {
  const value = field === 'timestamp' ? document.timestamp : document.blockHeight;

  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
};

const readCompactOrderValue = (
  document: IndexerDocument,
  field: CompactIndexOrderField
): string | number | null => {
  if (field === 'updatedAtBlock') {
    const value = document.data.updatedAtBlock;
    return typeof value === 'string' || typeof value === 'number' ? value : null;
  }

  return readDocumentPosition(document, field);
};

const isScalarIndexValue = (value: unknown): value is string | number | boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

const indexValue = (value: unknown): string | number | boolean | null => {
  if (!isScalarIndexValue(value)) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;

  return value;
};

const normalizeDecimal = (value: unknown): { sign: -1 | 0 | 1; integer: string; fraction: string } => {
  assertValidIndexedDecimal(value);
  const text = String(value ?? '0').trim();

  const negative = text.startsWith('-');
  const [integerRaw = '0', fractionRaw = ''] = (negative ? text.slice(1) : text).split('.');
  const integer = integerRaw.replace(/^0+/, '') || '0';
  const fraction = fractionRaw.replace(/0+$/, '');
  const sign = integer === '0' && !fraction ? 0 : negative ? -1 : 1;

  return { sign, integer, fraction };
};

const invertDigits = (value: string): string =>
  value
    .split('')
    .map((digit) => NUMERIC_NEGATIVE_DIGIT_MAP[digit] ?? digit)
    .join('');

const numericSortKey = (value: unknown): string => {
  // Missing numeric values are NULL-like: last in ascending order and first
  // when the same index is traversed in reverse for descending order.
  if (value === null || value === undefined) return '3';
  const normalized = normalizeDecimal(value);
  if (normalized.integer.length > MAX_NUMERIC_INTEGER_LENGTH) {
    throw new Error(`Invalid indexed decimal: integer precision exceeds ${MAX_NUMERIC_INTEGER_LENGTH} digits`);
  }
  if (normalized.sign === 0) return '1';

  const length = normalized.integer.length.toString().padStart(NUMERIC_LENGTH_WIDTH, '0');
  if (normalized.sign > 0) return `2:${length}:${normalized.integer}:${normalized.fraction}`;

  const inverseLength = (MAX_NUMERIC_INTEGER_LENGTH - normalized.integer.length)
    .toString()
    .padStart(NUMERIC_LENGTH_WIDTH, '0');
  return `0:${inverseLength}:${invertDigits(normalized.integer)}:${invertDigits(normalized.fraction)}:`;
};

const compactEqualityValue = (field: string, value: unknown): string | number | boolean | null => {
  const scalar = indexValue(value);
  if (scalar === null || !NUMERIC_EQUALITY_FIELDS.has(field)) return scalar;
  const normalized = normalizeDecimal(scalar);
  if (normalized.sign === 0) return '0';
  return `${normalized.sign < 0 ? '-' : ''}${normalized.integer}${normalized.fraction ? `.${normalized.fraction}` : ''}`;
};

const compactDocumentEqualityValue = (document: IndexerDocument, field: string): unknown => {
  if (field !== 'payloadTo' && field !== 'payloadAssetId') return document.data[field];
  const payload = document.data.data;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  return (payload as Record<string, unknown>)[field === 'payloadTo' ? 'to' : 'assetId'];
};

const compactDefinitionMatchesDocument = (
  definition: CompactIndexDefinition,
  document: IndexerDocument
): boolean =>
  Object.entries(definition.when ?? {}).every(([field, value]) => document.data[field] === value);

const numericFieldIndexedForCollection = (field: string, collection: IndexerCollection): boolean =>
  (NUMERIC_INDEX_COLLECTIONS as Record<string, string[] | undefined>)[field]?.includes(collection) ?? false;

const queryableData = (document: IndexerDocument): Record<string, unknown> => ({
  ...document.data,
  id: document.id,
  timestamp: document.timestamp ?? document.data.timestamp,
  blockHeight: document.blockHeight ?? document.data.blockHeight,
});

const documentsEqual = (left: IndexerDocument | null | undefined, right: IndexerDocument): boolean =>
  Boolean(
    left &&
      left.collection === right.collection &&
      left.id === right.id &&
      (left.blockHeight ?? null) === (right.blockHeight ?? null) &&
      (left.timestamp ?? null) === (right.timestamp ?? null) &&
      isDeepStrictEqual(left.data, right.data)
  );

const canReplaceDocumentAtBlock = (current: IndexerDocument, candidate: IndexerDocument): boolean => {
  const currentHeight = current.blockHeight;
  const candidateHeight = candidate.blockHeight;
  if (currentHeight !== null && currentHeight !== undefined) {
    if (candidateHeight === null || candidateHeight === undefined) return false;
    if (candidateHeight < currentHeight) return false;
  }

  return true;
};

const dedupeDocuments = (documents: IndexerDocument[]): IndexerDocument[] => {
  const byPrimaryKey = new Map<string, IndexerDocument>();

  for (const document of documents) {
    const key = `${document.collection}\0${document.id}`;
    const current = byPrimaryKey.get(key);
    if (!current || canReplaceDocumentAtBlock(current, document)) byPrimaryKey.set(key, document);
  }

  return [...byPrimaryKey.values()];
};

const cloneIndexerDocument = (document: IndexerDocument): IndexerDocument => structuredClone(document);

type FallbackOrderValue = string | number | boolean | null | undefined;

const encodeFallbackCursorValue = (value: unknown): string => {
  let encoded: readonly [string, string?];
  if (value === undefined) encoded = ['u'];
  else if (value === null) encoded = ['n'];
  else if (typeof value === 'number') encoded = ['d', String(value)];
  else if (typeof value === 'boolean') encoded = ['b', value ? '1' : '0'];
  else encoded = ['s', String(value)];

  return `${FALLBACK_CURSOR_VALUE_PREFIX}${Buffer.from(JSON.stringify(encoded)).toString('base64url')}`;
};

const decodeFallbackCursorValue = (value: string | null): FallbackOrderValue => {
  if (value === null || !value.startsWith(FALLBACK_CURSOR_VALUE_PREFIX)) return value;

  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(value.slice(FALLBACK_CURSOR_VALUE_PREFIX.length), 'base64url').toString('utf8')
    );
    if (!Array.isArray(decoded) || typeof decoded[0] !== 'string') return value;
    const payload = typeof decoded[1] === 'string' ? decoded[1] : '';

    if (decoded[0] === 'u') return undefined;
    if (decoded[0] === 'n') return null;
    if (decoded[0] === 'd') {
      const number = Number(payload);
      return Number.isFinite(number) ? number : value;
    }
    if (decoded[0] === 'b') return payload === '1';
    if (decoded[0] === 's') return payload;
  } catch {
    // Backward-compatible cursors contain the raw string value.
  }

  return value;
};

/** Mirrors sortDocuments, with the document id used as the stable final tie-breaker. */
const compareDocumentOrderValues = (
  left: unknown,
  right: unknown,
  field: string,
  direction: 'asc' | 'desc'
): number => {
  const factor = direction === 'desc' ? -1 : 1;
  const leftNullish = left === undefined || left === null;
  const rightNullish = right === undefined || right === null;

  if (left === right || (leftNullish && rightNullish)) return 0;
  if (leftNullish) return factor;
  if (rightNullish) return -factor;

  if (NUMERIC_ORDER_FIELDS.has(field)) {
    const leftKey = numericSortKey(left);
    const rightKey = numericSortKey(right);
    return leftKey === rightKey ? 0 : (leftKey < rightKey ? -1 : 1) * factor;
  }

  if (typeof left === 'number' && typeof right === 'number') return left > right ? factor : -factor;

  const leftText = String(left);
  const rightText = String(right);
  return (leftText === rightText ? 0 : leftText < rightText ? -1 : 1) * factor;
};

const indexedNumericFieldsForCollection = (collection: IndexerCollection): string[] =>
  Object.entries(NUMERIC_INDEX_COLLECTIONS)
    .filter(([, collections]) => collections.includes(collection))
    .map(([field]) => field);

const compactNumericFieldsForCollection = (collection: IndexerCollection): string[] =>
  COMPACT_NUMERIC_INDEX_COLLECTIONS.has(collection) ? indexedNumericFieldsForCollection(collection) : [];

const compactIndexPrefix = (collection: IndexerCollection, code: string, equalityValues: RocksKeyPart[] = []): RocksKey => [
  'x',
  collection,
  code,
  ...equalityValues,
];

const compactDocumentIndexKeys = (document: IndexerDocument): RocksKey[] => {
  const keys: RocksKey[] = [];

  for (const definition of COMPACT_INDEX_MANIFEST[document.collection] ?? []) {
    if (!compactDefinitionMatchesDocument(definition, document)) continue;
    const equalityValues = definition.equalityFields.map((field) =>
      compactEqualityValue(field, compactDocumentEqualityValue(document, field))
    );
    if (equalityValues.some((value) => value === null)) continue;

    const orderedValue = numericSortKey(readCompactOrderValue(document, definition.orderField));

    keys.push([
      ...compactIndexPrefix(document.collection, definition.code, equalityValues as RocksKeyPart[]),
      orderedValue,
      document.id,
    ]);
  }

  for (const definition of COMPACT_ID_EQUALITY_INDEX_MANIFEST[document.collection] ?? []) {
    const value = indexValue(document.data[definition.field]);
    if (value !== null) keys.push([...compactIndexPrefix(document.collection, definition.code, [value]), document.id]);
  }

  if (document.collection === 'accountMeta') {
    const createdAtTimestamp = finiteFilterNumber(document.data.createdAtTimestamp);
    if (createdAtTimestamp !== null) {
      keys.push([...compactIndexPrefix(document.collection, 'c'), createdAtTimestamp, document.id]);
    }
  }

  for (const field of compactNumericFieldsForCollection(document.collection)) {
    const value = document.data[field];
    keys.push([...compactIndexPrefix(document.collection, `n:${field}`), numericSortKey(value), document.id]);
  }

  return keys;
};

const compactDocumentIndexCountKeys = (document: IndexerDocument): RocksKey[] => {
  const keys: RocksKey[] = [];
  for (const definition of COMPACT_INDEX_MANIFEST[document.collection] ?? []) {
    if (!definition.equalityFields.length) continue;
    if (!compactDefinitionMatchesDocument(definition, document)) continue;
    const equalityValues = definition.equalityFields.map((field) =>
      compactEqualityValue(field, compactDocumentEqualityValue(document, field))
    );
    if (equalityValues.some((value) => value === null)) continue;
    keys.push(indexCountKey(document.collection, definition.code, equalityValues as RocksKeyPart[]));
  }
  return keys;
};

const indexCountKeyForCompactIndex = (key: unknown): RocksKey | null => {
  if (!Array.isArray(key) || key[0] !== 'x' || typeof key[1] !== 'string' || typeof key[2] !== 'string') return null;
  const collection = key[1] as IndexerCollection;
  const definition = (COMPACT_INDEX_MANIFEST[collection] ?? []).find((candidate) => candidate.code === key[2]);
  if (!definition?.equalityFields.length || key.length !== 5 + definition.equalityFields.length) return null;
  return indexCountKey(collection, definition.code, key.slice(3, 3 + definition.equalityFields.length) as RocksKeyPart[]);
};

/** Shared with the read-only audit command to verify sampled index coverage. */
export const rocksCompactIndexKeysForDocument = (document: IndexerDocument): RocksKey[] =>
  compactDocumentIndexKeys(document);

const matchesDocumentFilter = (document: IndexerDocument, filter: RepositoryQueryArgs['filter']): boolean =>
  matchesFilter(queryableData(document), filter);

const documentOrderValue = (document: IndexerDocument, field: string): unknown => {
  if (field === 'id') return document.id;
  if (field === 'timestamp') return document.timestamp ?? document.data.timestamp;
  if (field === 'blockHeight') return document.blockHeight ?? document.data.blockHeight;

  return document.data[field];
};

const sortIndexerDocuments = (documents: IndexerDocument[], orderBy: RepositoryQueryArgs['orderBy']): IndexerDocument[] => {
  const { field, direction } = getOrderField(orderBy);
  const factor = direction === 'desc' ? -1 : 1;

  return [...documents].sort((left, right) => {
    const comparison = compareDocumentOrderValues(
      documentOrderValue(left, field),
      documentOrderValue(right, field),
      field,
      direction
    );
    if (comparison !== 0) return comparison;
    if (left.id === right.id) return 0;

    return (left.id < right.id ? -1 : 1) * factor;
  });
};

const isFilterRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isEmptyFilter = (filter: RepositoryQueryArgs['filter']): boolean => {
  if (!filter) return true;
  if (!isFilterRecord(filter)) return false;
  const entries = Object.entries(filter);
  if (!entries.length) return true;
  return entries.every(
    ([field, condition]) =>
      field === 'and' && Array.isArray(condition) && condition.every((nested) => isEmptyFilter(nested as RepositoryQueryArgs['filter']))
  );
};

const readEqualValue = (_field: string, condition: unknown): unknown => {
  if (!isFilterRecord(condition)) return condition;

  return condition.equalTo ?? condition.eq;
};

const collectEqualities = (filter: RepositoryQueryArgs['filter']): Array<{ field: string; value: string | number | boolean }> => {
  if (!filter || !isFilterRecord(filter)) return [];

  const equalities: Array<{ field: string; value: string | number | boolean }> = [];

  for (const [field, condition] of Object.entries(filter)) {
    if (field === 'and' && Array.isArray(condition)) {
      for (const item of condition) equalities.push(...collectEqualities(item as RepositoryQueryArgs['filter']));
      continue;
    }

    if (field === 'or') continue;

    if (field === 'data' && isFilterRecord(condition) && isFilterRecord(condition.contains)) {
      const entries = Object.entries(condition.contains);
      if (entries.length === 1) {
        const [payloadField, payloadValue] = entries[0]!;
        const pseudoField = payloadField === 'to' ? 'payloadTo' : payloadField === 'assetId' ? 'payloadAssetId' : null;
        const value = pseudoField ? compactEqualityValue(pseudoField, payloadValue) : null;
        if (pseudoField && value !== null) equalities.push({ field: pseudoField, value });
      }
      continue;
    }

    const value = compactEqualityValue(field, readEqualValue(field, condition));
    if (value !== null) equalities.push({ field, value });
  }

  return equalities;
};

const findOrItems = (filter: RepositoryQueryArgs['filter']): unknown[] | null => {
  if (!filter || !isFilterRecord(filter)) return null;
  if (Array.isArray(filter.or) && filter.or.length) return filter.or;

  if (Array.isArray(filter.and)) {
    for (const item of filter.and) {
      const nested = findOrItems(item as RepositoryQueryArgs['filter']);
      if (nested) return nested;
    }
  }

  return null;
};

const collectOrEqualities = (filter: RepositoryQueryArgs['filter']): Array<{ field: string; value: string | number | boolean }> | null => {
  const orItems = findOrItems(filter);
  if (!orItems) return null;

  const branches = orItems
    .map((item) =>
      collectEqualities(item as RepositoryQueryArgs['filter']).find((entry) => COMPACT_EQUALITY_FIELDS.has(entry.field))
    )
    .filter((entry): entry is { field: string; value: string | number | boolean } => Boolean(entry));

  return branches.length === orItems.length ? branches : null;
};

const finiteFilterNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === 'null') return null;
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;
};

const exactFilterDecimal = (value: unknown): string | null => {
  if (value === null || value === undefined || value === 'null' || typeof value === 'boolean') return null;

  try {
    const normalized = normalizeDecimal(value);
    if (normalized.sign === 0) return '0';
    return `${normalized.sign < 0 ? '-' : ''}${normalized.integer}${
      normalized.fraction ? `.${normalized.fraction}` : ''
    }`;
  } catch {
    return null;
  }
};

const mergeLowerBound = (current: NumericRangeBound | undefined, next: NumericRangeBound): NumericRangeBound => {
  if (!current || next.value > current.value) return next;
  if (next.value < current.value) return current;

  return { value: current.value, inclusive: current.inclusive && next.inclusive };
};

const mergeUpperBound = (current: NumericRangeBound | undefined, next: NumericRangeBound): NumericRangeBound => {
  if (!current || next.value < current.value) return next;
  if (next.value > current.value) return current;

  return { value: current.value, inclusive: current.inclusive && next.inclusive };
};

const mergeExactLowerBound = (
  current: ExactNumericRangeBound | undefined,
  next: ExactNumericRangeBound
): ExactNumericRangeBound => {
  if (!current) return next;
  const currentKey = numericSortKey(current.value);
  const nextKey = numericSortKey(next.value);
  if (nextKey > currentKey) return next;
  if (nextKey < currentKey) return current;

  return { value: current.value, inclusive: current.inclusive && next.inclusive };
};

const mergeExactUpperBound = (
  current: ExactNumericRangeBound | undefined,
  next: ExactNumericRangeBound
): ExactNumericRangeBound => {
  if (!current) return next;
  const currentKey = numericSortKey(current.value);
  const nextKey = numericSortKey(next.value);
  if (nextKey < currentKey) return next;
  if (nextKey > currentKey) return current;

  return { value: current.value, inclusive: current.inclusive && next.inclusive };
};

const collectNumericRangeBounds = (
  filter: RepositoryQueryArgs['filter'],
  field: string,
  bounds: NumericRangeBounds = {}
): NumericRangeBounds => {
  if (!filter || !isFilterRecord(filter)) return bounds;

  for (const [filterField, condition] of Object.entries(filter)) {
    if (filterField === 'and' && Array.isArray(condition)) {
      for (const item of condition) collectNumericRangeBounds(item as RepositoryQueryArgs['filter'], field, bounds);
      continue;
    }
    if (filterField === 'or' || filterField !== field) continue;

    if (!isFilterRecord(condition)) {
      const value = finiteFilterNumber(condition);
      if (value !== null) {
        bounds.lower = mergeLowerBound(bounds.lower, { value, inclusive: true });
        bounds.upper = mergeUpperBound(bounds.upper, { value, inclusive: true });
      }
      continue;
    }

    for (const [operator, expected] of Object.entries(condition)) {
      const value = finiteFilterNumber(expected);
      if (value === null) continue;

      if (operator === 'equalTo' || operator === 'eq') {
        bounds.lower = mergeLowerBound(bounds.lower, { value, inclusive: true });
        bounds.upper = mergeUpperBound(bounds.upper, { value, inclusive: true });
      } else if (operator === 'greaterThan' || operator === 'gt') {
        bounds.lower = mergeLowerBound(bounds.lower, { value, inclusive: false });
      } else if (operator === 'greaterThanOrEqualTo' || operator === 'gte') {
        bounds.lower = mergeLowerBound(bounds.lower, { value, inclusive: true });
      } else if (operator === 'lessThan' || operator === 'lt') {
        bounds.upper = mergeUpperBound(bounds.upper, { value, inclusive: false });
      } else if (operator === 'lessThanOrEqualTo' || operator === 'lte') {
        bounds.upper = mergeUpperBound(bounds.upper, { value, inclusive: true });
      }
    }
  }

  return bounds;
};

/**
 * Collects JSON-decimal range bounds without passing token amounts through a
 * binary floating-point number. Public filters permit values wider than the
 * JavaScript safe-integer range, so their RocksDB boundary must use the same
 * canonical decimal representation as the index key itself.
 */
const collectExactNumericRangeBounds = (
  filter: RepositoryQueryArgs['filter'],
  field: string,
  bounds: ExactNumericRangeBounds = {}
): ExactNumericRangeBounds => {
  if (!filter || !isFilterRecord(filter)) return bounds;

  for (const [filterField, condition] of Object.entries(filter)) {
    if (filterField === 'and' && Array.isArray(condition)) {
      for (const item of condition) {
        collectExactNumericRangeBounds(item as RepositoryQueryArgs['filter'], field, bounds);
      }
      continue;
    }
    if (filterField === 'or' || filterField !== field) continue;

    if (!isFilterRecord(condition)) {
      const value = exactFilterDecimal(condition);
      if (value !== null) {
        bounds.lower = mergeExactLowerBound(bounds.lower, { value, inclusive: true });
        bounds.upper = mergeExactUpperBound(bounds.upper, { value, inclusive: true });
      }
      continue;
    }

    for (const [operator, expected] of Object.entries(condition)) {
      const value = exactFilterDecimal(expected);
      if (value === null) continue;

      if (operator === 'equalTo' || operator === 'eq') {
        bounds.lower = mergeExactLowerBound(bounds.lower, { value, inclusive: true });
        bounds.upper = mergeExactUpperBound(bounds.upper, { value, inclusive: true });
      } else if (operator === 'greaterThan' || operator === 'gt') {
        bounds.lower = mergeExactLowerBound(bounds.lower, { value, inclusive: false });
      } else if (operator === 'greaterThanOrEqualTo' || operator === 'gte') {
        bounds.lower = mergeExactLowerBound(bounds.lower, { value, inclusive: true });
      } else if (operator === 'lessThan' || operator === 'lt') {
        bounds.upper = mergeExactUpperBound(bounds.upper, { value, inclusive: false });
      } else if (operator === 'lessThanOrEqualTo' || operator === 'lte') {
        bounds.upper = mergeExactUpperBound(bounds.upper, { value, inclusive: true });
      }
    }
  }

  return bounds;
};

const isNullishFilterValue = (value: unknown): boolean =>
  value === null || value === undefined || value === 'null';

const compactFilterCoveredByIndex = (
  filter: RepositoryQueryArgs['filter'],
  equalityFields: readonly string[],
  equalityValues: readonly RocksKeyPart[],
  rangeField: string,
  predicateEqualities: Readonly<Record<string, string>> = {}
): boolean => {
  const expectedEqualities = new Map<string, RocksKeyPart>([
    ...Object.entries(predicateEqualities),
    ...equalityFields.map((field, index) => [field, equalityValues[index]] as const),
  ]);
  const seenEqualities = new Set<string>();
  const visit = (value: RepositoryQueryArgs['filter']): boolean => {
    if (!value) return true;
    if (!isFilterRecord(value)) return false;

    for (const [field, condition] of Object.entries(value)) {
      if (field === 'and') {
        if (!Array.isArray(condition) || !condition.every((entry) => visit(entry as RepositoryQueryArgs['filter']))) {
          return false;
        }
        continue;
      }
      if (field === 'or') return false;

      if (expectedEqualities.has(field)) {
        const expected = expectedEqualities.get(field);
        if (!isFilterRecord(condition)) {
          const actual = compactEqualityValue(field, condition);
          if (actual === null || actual !== expected) return false;
          seenEqualities.add(field);
          continue;
        }

        let constrained = false;
        for (const [operator, candidate] of Object.entries(condition)) {
          if (isNullishFilterValue(candidate)) continue;
          if (operator !== 'equalTo' && operator !== 'eq') return false;
          const actual = compactEqualityValue(field, candidate);
          if (actual === null || actual !== expected) return false;
          constrained = true;
        }
        if (constrained) seenEqualities.add(field);
        continue;
      }

      if (field !== rangeField) return false;
      if (!isFilterRecord(condition)) {
        if (typeof condition !== 'number' || finiteFilterNumber(condition) === null) return false;
        continue;
      }

      for (const [operator, candidate] of Object.entries(condition)) {
        if (isNullishFilterValue(candidate)) continue;
        if (!['equalTo', 'eq', 'greaterThan', 'gt', 'greaterThanOrEqualTo', 'gte', 'lessThan', 'lt', 'lessThanOrEqualTo', 'lte'].includes(operator)) {
          return false;
        }
        if ((operator === 'equalTo' || operator === 'eq') && typeof candidate !== 'number') return false;
        if (finiteFilterNumber(candidate) === null) return false;
      }
    }

    return true;
  };

  return visit(filter) && [...expectedEqualities.keys()].every((field) => seenEqualities.has(field));
};

const orderedPositionForArgs = (
  args: RepositoryQueryArgs,
  field: string,
  direction: 'asc' | 'desc',
  transform: (value: string | number | null) => string | number | null = (value) => value
): OrderedPosition | null => {
  const keyset = args.offset === null || args.offset === undefined ? args.keyset ?? null : null;
  if (keyset) {
    const numeric = NUMERIC_ORDER_FIELDS.has(field);
    if (keyset.field !== field || keyset.direction !== direction || keyset.numeric !== numeric) {
      throw new Error('Pagination cursor does not match the requested order');
    }
    return { value: transform(keyset.value), id: keyset.id };
  }

  if (args.seek?.field !== field || (args.seek.direction ?? 'asc') !== direction) return null;

  return { value: transform(args.seek.value), id: args.seek.id };
};

const rangeForOrderedPrefix = (
  prefix: RocksKey,
  direction: 'asc' | 'desc',
  bounds: OrderedRangeBounds = {},
  position: OrderedPosition | null = null,
  transformBound: (value: number | string) => RocksKeyPart = (value) => value,
  trailingNullKey: RocksKeyPart | null = null
): Record<string, unknown> => {
  const lowerKey: RocksKey = bounds.lower
    ? bounds.lower.inclusive
      ? [...prefix, transformBound(bounds.lower.value)]
      : [...prefix, transformBound(bounds.lower.value), HIGH_KEY]
    : prefix;
  const upperKey: RocksKey = bounds.upper
    ? bounds.upper.inclusive
      ? [...prefix, transformBound(bounds.upper.value), HIGH_KEY]
      : [...prefix, transformBound(bounds.upper.value)]
    : trailingNullKey !== null && (bounds.lower || bounds.upper)
      ? [...prefix, trailingNullKey]
      : [...prefix, HIGH_KEY];
  let start = direction === 'desc' ? upperKey : lowerKey;
  const end = direction === 'desc' ? lowerKey : upperKey;
  let exclusiveStart = false;

  if (position) {
    start = [...prefix, position.value, position.id];
    exclusiveStart = true;
  }

  return {
    start,
    end,
    inclusiveEnd: true,
    reverse: direction === 'desc',
    values: false,
    ...(exclusiveStart ? { exclusiveStart: true } : {}),
  };
};

const rangeForDocumentOrder = (
  collection: IndexerCollection,
  direction: 'asc' | 'desc',
  position: OrderedPosition | null
): Record<string, unknown> => {
  const prefix: RocksKey = ['d', collection];
  const options = rangeForPrefix(prefix, { reverse: direction === 'desc' });
  if (position) {
    options.start = documentKey(collection, String(position.value));
    options.exclusiveStart = true;
  }

  return options;
};

const keyId = (key: unknown): string | null => {
  if (!Array.isArray(key)) return null;
  const id = key[key.length - 1];

  return typeof id === 'string' ? id : null;
};

const documentIdentityFromKey = (key: unknown): { collection: IndexerCollection; id: string } | null => {
  if (
    !Array.isArray(key) ||
    key.length !== 3 ||
    key[0] !== 'd' ||
    typeof key[1] !== 'string' ||
    !INDEXER_COLLECTIONS.includes(key[1] as IndexerCollection) ||
    typeof key[2] !== 'string'
  ) {
    return null;
  }

  return { collection: key[1] as IndexerCollection, id: key[2] };
};

const decodeStoredDocument = (
  collection: IndexerCollection,
  id: string,
  stored: unknown
): IndexerDocument | undefined => decodeRocksDocument(collection, id, stored) ?? undefined;

const selectCompactDefinition = (
  collection: IndexerCollection,
  field: CompactIndexOrderField,
  equalities: Array<{ field: string; value: string | number | boolean }>
): { definition: CompactIndexDefinition; values: RocksKeyPart[] } | null => {
  const candidates: Array<{ definition: CompactIndexDefinition; values: RocksKeyPart[] }> = [];
  for (const definition of COMPACT_INDEX_MANIFEST[collection] ?? []) {
    if (definition.orderField !== field) continue;
    if (
      !Object.entries(definition.when ?? {}).every(([whenField, whenValue]) =>
        equalities.some((entry) => entry.field === whenField && entry.value === whenValue)
      )
    ) continue;

    const values = definition.equalityFields.map(
      (equalityField) => equalities.find((entry) => entry.field === equalityField)?.value ?? null
    );
    if (values.some((value) => value === null)) continue;
    candidates.push({ definition, values });
  }
  candidates.sort(
    (left, right) =>
      right.definition.equalityFields.length - left.definition.equalityFields.length ||
      Object.keys(right.definition.when ?? {}).length - Object.keys(left.definition.when ?? {}).length
  );

  return candidates[0] ?? null;
};

const compactFilterValues = (
  filter: RepositoryQueryArgs['filter'],
  field: string
): Array<string | number | boolean> | null => {
  if (!filter || !isFilterRecord(filter)) return null;
  const condition = filter[field];
  if (condition !== undefined) {
    if (!isFilterRecord(condition)) {
      const scalar = indexValue(condition);
      return scalar === null ? null : [scalar];
    }
    const equal = indexValue(condition.equalTo ?? condition.eq);
    if (equal !== null) return [equal];
    if (Array.isArray(condition.in)) {
      const values = condition.in.map(indexValue).filter((value): value is string | number | boolean => value !== null);
      return values.length === condition.in.length ? [...new Set(values)] : null;
    }
  }

  if (Array.isArray(filter.and)) {
    for (const nested of filter.and) {
      const values = compactFilterValues(nested as RepositoryQueryArgs['filter'], field);
      if (values) return values;
    }
  }
  return null;
};

const sourceForCompactIdEquality = (
  collection: IndexerCollection,
  filter: RepositoryQueryArgs['filter'],
  direction: 'asc' | 'desc'
): QuerySource | null => {
  const definitions = COMPACT_ID_EQUALITY_INDEX_MANIFEST[collection] ?? [];
  const orItems = findOrItems(filter);
  if (orItems) {
    const selected = orItems.map((item) => {
      for (const definition of definitions) {
        const values = compactFilterValues(item as RepositoryQueryArgs['filter'], definition.field);
        if (values?.length) return { definition, values };
      }
      return null;
    });
    if (selected.every((entry): entry is NonNullable<typeof entry> => entry !== null)) {
      return {
        ranges: selected.flatMap(({ definition, values }) =>
          values.map((value) => ({
            keyKind: 'index' as const,
            options: rangeForPrefix(compactIndexPrefix(collection, definition.code, [value]), {
              values: false,
              reverse: direction === 'desc',
            }),
          }))
        ),
        preservesOrder: false,
        boundedSort: true,
        reason: 'x:or-id-equality',
      };
    }
  }

  for (const definition of definitions) {
    const values = compactFilterValues(filter, definition.field);
    if (!values?.length) continue;
    return {
      ranges: values.map((value) => ({
        keyKind: 'index' as const,
        options: rangeForPrefix(compactIndexPrefix(collection, definition.code, [value]), {
          values: false,
          reverse: direction === 'desc',
        }),
      })),
      preservesOrder: values.length === 1,
      boundedSort: values.length > 1,
      reason: `x:${definition.code}`,
    };
  }
  return null;
};

const sourceForDirectIdSet = (
  collection: IndexerCollection,
  filter: RepositoryQueryArgs['filter']
): QuerySource | null => {
  const values = compactFilterValues(filter, 'id');
  if (!values?.length) return null;
  const ids = [...new Set(values.map(String))];
  return {
    ranges: ids.map((id) => ({ keyKind: 'document' as const, options: { key: documentKey(collection, id) } })),
    preservesOrder: ids.length === 1,
    boundedSort: ids.length > 1,
    reason: 'x:id-set',
  };
};

const exactNumericFilterOccurrences = (
  filter: RepositoryQueryArgs['filter'],
  field: string
): ExactNumericRangeBounds[] => {
  if (!filter || !isFilterRecord(filter)) return [];
  const results: ExactNumericRangeBounds[] = [];
  if (field in filter) {
    const bounds = collectExactNumericRangeBounds({ [field]: filter[field] }, field);
    if (bounds.lower || bounds.upper) results.push(bounds);
  }
  for (const logical of ['and', 'or'] as const) {
    const nested = filter[logical];
    if (!Array.isArray(nested)) continue;
    for (const item of nested) {
      results.push(...exactNumericFilterOccurrences(item as RepositoryQueryArgs['filter'], field));
    }
  }
  return results;
};

const sourceForNumericIdProjection = (
  collection: IndexerCollection,
  filter: RepositoryQueryArgs['filter'],
  fields: readonly string[],
  reason: string
): QuerySource | null => {
  const ranges = fields.flatMap((field) =>
    exactNumericFilterOccurrences(filter, field).map((bounds) => ({
      keyKind: 'index' as const,
      options: rangeForOrderedPrefix(
        compactIndexPrefix(collection, `n:${field}`),
        'asc',
        bounds,
        null,
        numericSortKey,
        '3'
      ),
    }))
  );
  if (!ranges.length) return null;
  return { ranges, preservesOrder: false, boundedSort: true, reason };
};

const sourceForHistoryIdSignatureBlockRange = (
  filter: RepositoryQueryArgs['filter']
): QuerySource | null => {
  const bounds = collectNumericRangeBounds(filter, 'blockHeight');
  if (!bounds.lower && !bounds.upper) return null;
  const common = collectEqualities(filter);
  const branches = findOrItems(filter);
  const candidates = branches?.length
    ? branches.map((branch) => [...common, ...collectEqualities(branch as RepositoryQueryArgs['filter'])])
    : [common];
  const selected = candidates.map((equalities) =>
    selectCompactDefinition('historyElements', 'blockHeight', equalities)
  );
  if (selected.some((entry) => !entry || entry.definition.equalityFields.length === 0)) return null;

  return {
    ranges: selected.map((entry) => {
      if (!entry) throw new Error('History signature source selection became inconsistent');
      return {
        keyKind: 'index' as const,
        options: rangeForOrderedPrefix(
          compactIndexPrefix('historyElements', entry.definition.code, entry.values),
          'asc',
          bounds,
          null,
          numericSortKey,
          '3'
        ),
      };
    }),
    preservesOrder: false,
    boundedSort: true,
    reason: 'x:history-signature-block-id',
  };
};

const sourceForCompactOrderedRange = (
  collection: IndexerCollection,
  selected: { definition: CompactIndexDefinition; values: RocksKeyPart[] },
  direction: 'asc' | 'desc',
  args: RepositoryQueryArgs
): QuerySource => {
  const { definition, values } = selected;
  const prefix = compactIndexPrefix(collection, definition.code, values);
  const bounds = collectNumericRangeBounds(args.filter, definition.orderField);
  const position = orderedPositionForArgs(args, definition.orderField, direction, numericSortKey);
  const exactlyCovered = compactFilterCoveredByIndex(
    args.filter,
    definition.equalityFields,
    values,
    definition.orderField,
    definition.when
  );
  const unbounded = !bounds.lower && !bounds.upper;
  const exactCountKeys =
    exactlyCovered && unbounded
      ? definition.equalityFields.length
        ? [indexCountKey(collection, definition.code, values)]
        : Object.keys(definition.when ?? {}).length === 0
          ? [countKey(collection)]
          : undefined
      : undefined;

  return {
    ranges: [
      {
        keyKind: 'index',
        options: rangeForOrderedPrefix(prefix, direction, bounds, position, numericSortKey, '3'),
      },
    ],
    preservesOrder: true,
    reason: `x:${definition.code}`,
    exactCountKeys,
  };
};

const isAfterQueryPosition = (document: IndexerDocument, args: RepositoryQueryArgs): boolean => {
  const keyset = args.offset === null || args.offset === undefined ? args.keyset ?? null : null;
  if (keyset) {
    const actual = documentOrderValue(document, keyset.field);
    const cursorValue = keyset.numeric ? keyset.value : decodeFallbackCursorValue(keyset.value);
    const comparison = compareDocumentOrderValues(actual, cursorValue, keyset.field, keyset.direction);
    if (comparison === 0) {
      return keyset.direction === 'desc' ? document.id < keyset.id : document.id > keyset.id;
    }

    return comparison > 0;
  }

  const seek = args.seek;
  if (!seek) return true;

  const value = readDocumentPosition(document, seek.field);
  const direction = seek.direction ?? 'asc';
  const comparison = compareDocumentOrderValues(value, seek.value, seek.field, direction);
  if (comparison === 0) return direction === 'desc' ? document.id < seek.id : document.id > seek.id;

  return comparison > 0;
};

const cursorForIndexerDocument = (
  collection: IndexerCollection,
  document: IndexerDocument,
  args: RepositoryQueryArgs
): string => {
  const { field, direction } = getOrderField(args.orderBy);
  const numeric = NUMERIC_ORDER_FIELDS.has(field);

  return encodeRepositoryCursor({
    scope: createRepositoryCursorScope(collection, args.orderBy, args.filter),
    field,
    direction,
    numeric,
    value:
      !numeric && field !== 'id'
        ? encodeFallbackCursorValue(documentOrderValue(document, field))
        : normalizeRepositoryCursorValue(documentOrderValue(document, field), numeric),
    id: document.id,
  });
};

export class RocksRepository implements IndexerRepository {
  private readonly db: RocksDatabase;
  private readonly config: AppConfig;
  private readonly readOnly: boolean;
  private readonly allowIncompleteMigration: boolean;
  private readonly events = new EventEmitter();
  private readonly watchQueueMax: number;
  private readonly queryMaxScannedRows: number;
  private readonly documentCacheMax: number;
  private readonly documentCacheMaxBytes: number;
  private readonly documentCache = new Map<string, { document: IndexerDocument; bytes: number }>();
  private readonly watchSubscribers = new Map<number, WatchSubscriber>();
  private documentCacheBytes = 0;
  private watchQueueDrops = 0;
  private nextWatchSubscriberId = 1;
  private writeQueue = Promise.resolve();
  private preparePromise: Promise<void> | null = null;
  private compactIndexValidationPromise: Promise<void> | null = null;
  private prepared = false;
  private closing = false;
  private closePromise: Promise<void> | null = null;

  constructor(config: AppConfig, options: RocksRepositoryOptions = {}) {
    this.config = config;
    this.readOnly = options.readOnly === true;
    this.allowIncompleteMigration = options.allowIncompleteMigration === true;
    this.watchQueueMax = config.rocksdbWatchQueueMax;
    this.queryMaxScannedRows = config.rocksdbQueryMaxScannedRows;
    if (!this.readOnly) mkdirSync(dirname(config.rocksdbPath), { recursive: true });
    RocksDatabase.config({
      blockCacheSize: Math.max(config.rocksdbBlockCacheMb, 0) * 1024 * 1024,
      writeBufferManagerSize: Math.max(config.rocksdbWriteBufferManagerMb, 0) * 1024 * 1024,
      writeBufferManagerAllowStall: false,
      writeBufferManagerCostToCache: false,
    });
    this.db = RocksDatabase.open(config.rocksdbPath, {
      enableStats: config.rocksdbEnableStats,
      parallelismThreads: Math.max(Math.trunc(config.rocksdbParallelism), 1),
      verificationTable: true,
      readOnly: this.readOnly,
    });
    this.documentCacheMax = config.rocksdbDocumentCacheMax;
    this.documentCacheMaxBytes = config.rocksdbDocumentCacheMaxBytes;
    metrics.setGauge('indexer_rocksdb_document_cache_entries', {}, 0);
    metrics.setGauge('indexer_rocksdb_document_cache_bytes', {}, 0);
  }

  static openReadOnly(config: AppConfig): RocksRepository {
    return new RocksRepository(config, { readOnly: true });
  }

  async prepare(): Promise<void> {
    if (this.closing) throw new Error('Cannot prepare: RocksDB repository is closing');
    if (this.prepared) return;
    if (this.preparePromise) return this.preparePromise;

    const preparing = this.prepareCurrentFormat().finally(() => {
      if (this.preparePromise === preparing) this.preparePromise = null;
    });
    this.preparePromise = preparing;
    return preparing;
  }

  formatVersion(): number | null {
    const version = this.getMetadata<unknown>(ROCKSDB_FORMAT_METADATA_KEY);
    return Number.isSafeInteger(version) ? (version as number) : null;
  }

  /** Runs synchronous offline inspection while this repository holds RocksDB's exclusive lock. */
  inspectCurrentSnapshot<T>(inspect: (database: RocksReadView) => T): T {
    this.assertPrepared('inspect RocksDB');
    return inspect(this.db);
  }

  private async prepareCurrentFormat(): Promise<void> {
    const storedVersion = this.getMetadata<unknown>(ROCKSDB_FORMAT_METADATA_KEY);
    if (storedVersion === undefined) {
      if (this.readOnly) {
        throw new Error('RocksDB is empty or unversioned; a read-only repository cannot initialize it');
      }
      if (this.hasAnyStoredKey()) {
        throw new Error(
          `Unsupported unversioned RocksDB at ${this.config.rocksdbPath}; first-release storage must be rebuilt from an empty destination`
        );
      }
      await this.db.put(metadataKey(ROCKSDB_FORMAT_METADATA_KEY), ROCKSDB_FORMAT_VERSION);
    } else if (storedVersion !== ROCKSDB_FORMAT_VERSION) {
      throw new Error(
        `Unsupported RocksDB format ${String(storedVersion)} at ${this.config.rocksdbPath}; expected ${ROCKSDB_FORMAT_VERSION}`
      );
    }

    if (this.hasStoredKeyWithPrefix(['i'])) {
      throw new Error(
        'Unsupported RocksDB index namespace keys detected; rebuild the first-release database from an empty destination'
      );
    }
    const migrationState = this.getMetadata<unknown>(POSTGRES_ROCKSDB_MIGRATION_STATE_KEY);
    if (migrationState !== undefined && !this.allowIncompleteMigration) {
      try {
        assertServeablePostgresRocksdbMigrationState(migrationState);
      } catch (error) {
        if (error instanceof Error && /incomplete or failed PostgreSQL migration artifact/.test(error.message)) {
          throw error;
        }
        throw new Error(
          'RocksDB contains a malformed PostgreSQL migration artifact; resume or rebuild the migration before serving it',
          { cause: error }
        );
      }
    }
    this.prepared = true;
  }

  private hasAnyStoredKey(): boolean {
    for (const _entry of this.db.getRange({ limit: 1, values: false })) return true;
    return false;
  }

  private hasStoredKeyWithPrefix(prefix: RocksKey): boolean {
    for (const _entry of this.db.getRange(rangeForPrefix(prefix, { limit: 1, values: false }))) return true;
    return false;
  }

  async list(collection: IndexerCollection): Promise<IndexerDocument[]> {
    assertValidIndexerCollection(collection);
    this.assertPrepared('list documents');
    return this.recordOperation('list', collection, async () => {
      const documents: IndexerDocument[] = [];

      for (const entry of this.db.getRange(rangeForPrefix(['d', collection]))) {
        const id = keyId(entry?.key);
        if (!id) continue;
        const document = decodeStoredDocument(collection, id, entry?.value);
        if (document) documents.push(document);
      }

      return documents;
    });
  }

  async query(collection: IndexerCollection, args: RepositoryQueryArgs): Promise<RepositoryQueryResult> {
    assertValidIndexerCollection(collection);
    assertValidRepositoryQueryPositions(args);
    this.assertPrepared('query documents');
    return this.recordOperation('query', collection, async () => {
      const source = this.selectQuerySource(collection, args);
      if (!source.preservesOrder && !source.boundedSort) {
        metrics.increment('indexer_rocksdb_query_fallback_total', { collection, reason: source.reason });
      }

      if (args.keyset && args.includeTotalCount !== false) {
        const countArgs: RepositoryQueryArgs = {
          ...args,
          first: 0,
          last: null,
          offset: null,
          after: null,
          keyset: null,
          includeTotalCount: true,
        };
        const countSource = this.selectQuerySource(collection, countArgs);
        const countResult = countSource.preservesOrder
          ? await this.queryOrderedSource(collection, countSource, countArgs)
          : await this.queryFallbackSource(collection, countSource, countArgs);
        const pageArgs = { ...args, includeTotalCount: false };
        const pageResult = source.preservesOrder
          ? await this.queryOrderedSource(collection, source, pageArgs)
          : await this.queryFallbackSource(collection, source, pageArgs);

        return { ...pageResult, totalCount: countResult.totalCount };
      }

      return source.preservesOrder
        ? this.queryOrderedSource(collection, source, args)
        : this.queryFallbackSource(collection, source, args);
    });
  }

  async get(collection: IndexerCollection, id: string): Promise<IndexerDocument | null> {
    assertValidIndexerCollection(collection);
    assertValidDocumentId(id);
    this.assertPrepared('get documents');
    return this.recordOperation('get', collection, async () => {
      return this.readDocument(collection, id, true) ?? null;
    });
  }

  count(collection: IndexerCollection): number {
    this.assertPrepared('count documents');
    const value = this.db.getSync(countKey(collection));

    return typeof value === 'number' ? value : 0;
  }

  async getMany(collection: IndexerCollection, ids: string[]): Promise<Map<string, IndexerDocument>> {
    assertValidIndexerCollection(collection);
    for (const id of ids) assertValidDocumentId(id);
    this.assertPrepared('get documents');
    if (!ids.length) return new Map();

    return this.recordOperation('getMany', collection, async () => {
      const result = new Map<string, IndexerDocument>();

      for (const id of new Set(ids)) {
        const document = this.readDocument(collection, id, true);
        if (document) result.set(id, document);
      }

      return result;
    });
  }

  async upsert(document: IndexerDocument): Promise<void> {
    await this.upsertMany([document]);
  }

  async upsertMany(documents: IndexerDocument[]): Promise<void> {
    this.assertWritable('upsert documents');
    this.assertPrepared('upsert documents');
    if (!documents.length) return;

    const normalized = normalizeIndexerDocumentWriteCall(documents);
    const deduped = dedupeDocuments(normalized);

    await this.recordOperation('upsertMany', 'all', () => this.runWrite(async () => {
      let changedDocuments: Array<{ document: IndexerDocument; previous: IndexerDocument | undefined }> = [];

      await this.db.transaction(async (transaction) => {
        const transactionChanges: Array<{ document: IndexerDocument; previous: IndexerDocument | undefined }> = [];
        const insertedByCollection = new Map<IndexerCollection, number>();
        const updateIndexCount = async (key: RocksKey, delta: -1 | 1): Promise<void> => {
          const stored = transaction.getSync(key);
          const current = typeof stored === 'number' && Number.isSafeInteger(stored) && stored >= 0 ? stored : 0;
          if (delta < 0 && current === 0) {
            throw new Error(`RocksDB compact prefix count underflow for ${JSON.stringify(key)}`);
          }
          const next = current + delta;
          if (next === 0) await transaction.remove(key);
          else await transaction.put(key, next);
        };

        // Payload iteration keeps transient serialization bounded, but the
        // native transaction spans the complete validated call. A later
        // batch failure must never expose an earlier batch or split chain
        // state from its cumulative documents.
        for (const { documents: batch } of iterateIndexerDocumentJsonPayloads(deduped)) {
          for (const candidate of batch) {
            const document = candidate;
            const key = documentKey(document.collection, document.id);
            const previous = decodeStoredDocument(document.collection, document.id, transaction.getSync(key));
            if (previous && !canReplaceDocumentAtBlock(previous, document)) continue;
            if (documentsEqual(previous, document)) continue;

            if (previous) {
              for (const indexKey of compactDocumentIndexKeys(previous)) {
                await transaction.remove(indexKey);
              }
            }

            const previousCountKeys = new Map(
              (previous ? compactDocumentIndexCountKeys(previous) : []).map((countKeyValue) => [
                JSON.stringify(countKeyValue),
                countKeyValue,
              ])
            );
            const nextCountKeys = new Map(
              compactDocumentIndexCountKeys(document).map((countKeyValue) => [JSON.stringify(countKeyValue), countKeyValue])
            );
            for (const [identity, countKeyValue] of previousCountKeys) {
              if (!nextCountKeys.has(identity)) await updateIndexCount(countKeyValue, -1);
            }
            for (const [identity, countKeyValue] of nextCountKeys) {
              if (!previousCountKeys.has(identity)) await updateIndexCount(countKeyValue, 1);
            }

            await transaction.put(key, encodeRocksDocument(document));
            for (const indexKey of compactDocumentIndexKeys(document)) {
              await transaction.put(indexKey, 1);
            }
            transactionChanges.push({ document, previous });
            if (!previous) {
              insertedByCollection.set(document.collection, (insertedByCollection.get(document.collection) ?? 0) + 1);
            }
          }
        }

        for (const [collection, inserted] of insertedByCollection) {
          const storedCount = transaction.getSync(countKey(collection));
          const currentCount = typeof storedCount === 'number' ? storedCount : 0;
          await transaction.put(countKey(collection), currentCount + inserted);
        }
        changedDocuments = transactionChanges;
      });

      for (const { document } of changedDocuments) this.cacheDocument(document);
      for (const { document, previous } of changedDocuments) {
        this.events.emit('document', {
          collection: document.collection,
          id: document.id,
          mutationType: previous ? 'UPDATE' : 'INSERT',
        } satisfies RepositoryWatchEvent);
      }
    }));
  }

  async deleteMany(collection: IndexerCollection, ids: string[]): Promise<void> {
    this.assertWritable('delete documents');
    this.assertPrepared('delete documents');
    assertValidIndexerCollection(collection);
    for (const id of ids) assertValidDocumentId(id);
    const uniqueIds = [...new Set(ids)];
    if (!uniqueIds.length) return;

    await this.recordOperation('deleteMany', collection, () => this.runWrite(async () => {
      const previousDocuments = uniqueIds
        .map((id) => this.readDocument(collection, id, false))
        .filter((document): document is IndexerDocument => Boolean(document));

      if (!previousDocuments.length) return;

      const nextCount = Math.max(this.count(collection) - previousDocuments.length, 0);

      await this.db.transaction(async (transaction) => {
        const updateIndexCount = async (key: RocksKey): Promise<void> => {
          const stored = transaction.getSync(key);
          if (typeof stored !== 'number' || !Number.isSafeInteger(stored) || stored <= 0) {
            throw new Error(`RocksDB compact prefix count underflow for ${JSON.stringify(key)}`);
          }
          if (stored === 1) await transaction.remove(key);
          else await transaction.put(key, stored - 1);
        };
        for (const previous of previousDocuments) {
          for (const indexKey of compactDocumentIndexKeys(previous)) {
            await transaction.remove(indexKey);
          }
          for (const countKeyValue of compactDocumentIndexCountKeys(previous)) await updateIndexCount(countKeyValue);
          await transaction.remove(documentKey(collection, previous.id));
        }

        await transaction.put(countKey(collection), nextCount);
      });
      for (const previous of previousDocuments) this.evictCachedDocument(collection, previous.id);
      for (const previous of previousDocuments) {
        this.events.emit('document', {
          collection,
          id: previous.id,
          mutationType: 'DELETE',
        } satisfies RepositoryWatchEvent);
      }
    }));
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    for (const subscriber of this.watchSubscribers.values()) {
      subscriber.queue.clear();
      subscriber.notify?.();
      subscriber.notify = null;
    }
    this.events.removeAllListeners();

    this.closePromise = (async () => {
      await Promise.allSettled([
        this.preparePromise ?? Promise.resolve(),
        this.compactIndexValidationPromise ?? Promise.resolve(),
        this.writeQueue,
      ]);
      this.documentCache.clear();
      this.documentCacheBytes = 0;
      metrics.setGauge('indexer_rocksdb_document_cache_entries', {}, 0);
      metrics.setGauge('indexer_rocksdb_document_cache_bytes', {}, 0);
      this.db.close();
    })();

    return this.closePromise;
  }

  async healthCheck(): Promise<boolean> {
    try {
      return this.prepared && this.db.isOpen();
    } catch {
      return false;
    }
  }

  async *watch(
    collection: IndexerCollection,
    ids: string[] = [],
    signal?: AbortSignal
  ): AsyncGenerator<RepositoryWatchEvent, void, unknown> {
    assertValidIndexerCollection(collection);
    this.assertPrepared('watch documents');
    for (const id of ids) assertValidDocumentId(id);
    if (signal?.aborted) return;
    const subscriber: WatchSubscriber = {
      id: this.nextWatchSubscriberId++,
      collection,
      ids: new Set(ids),
      queue: new LatestDocumentWatchQueue(this.watchQueueMax),
      notify: null,
    };
    this.watchSubscribers.set(subscriber.id, subscriber);
    const listener = (event: RepositoryWatchEvent) => {
      if (event.collection !== subscriber.collection) return;
      if (subscriber.ids.size && !subscriber.ids.has(event.id)) return;

      if (subscriber.queue.push(event)) {
        this.watchQueueDrops += 1;
        metrics.increment('indexer_rocksdb_watch_queue_drops_total', { collection: event.collection });
      }
      subscriber.notify?.();
      subscriber.notify = null;
    };

    this.events.on('document', listener);
    const abort = () => {
      subscriber.notify?.();
      subscriber.notify = null;
    };
    signal?.addEventListener('abort', abort, { once: true });

    try {
      while (!signal?.aborted && !this.closing) {
        if (!subscriber.queue.length) {
          await this.waitForWatchDocument(subscriber);
        }

        if (signal?.aborted || this.closing) break;

        const event = subscriber.queue.shift();
        if (event) yield { ...event };
      }
    } finally {
      signal?.removeEventListener('abort', abort);
      this.watchSubscribers.delete(subscriber.id);
      subscriber.queue.clear();
      this.events.off('document', listener);
      subscriber.notify?.();
      subscriber.notify = null;
    }
  }

  metricsSnapshot(): RepositoryMetricsSnapshot {
    const snapshot: RepositoryMetricsSnapshot = {
      rocksdb_estimated_keys: this.db.getEstimatedKeyCount(),
      rocksdb_open: this.db.isOpen() ? 1 : 0,
      rocksdb_format_version: this.formatVersion() ?? 0,
      rocksdb_document_cache_entries: this.documentCache.size,
      rocksdb_document_cache_max: this.documentCacheMax,
      rocksdb_document_cache_bytes: this.documentCacheBytes,
      rocksdb_document_cache_max_bytes: this.documentCacheMaxBytes,
      rocksdb_watch_subscribers: this.watchSubscribers.size,
      rocksdb_watch_queue_drops_total: this.watchQueueDrops,
    };

    try {
      const stats = this.db.getStats();
      const selectedStats = [
        'rocksdb.block-cache-capacity',
        'rocksdb.block-cache-usage',
        'rocksdb.block-cache-pinned-usage',
        'rocksdb.cur-size-all-mem-tables',
        'rocksdb.estimate-live-data-size',
        'rocksdb.estimate-pending-compaction-bytes',
        'rocksdb.live-sst-files-size',
        'rocksdb.num-running-compactions',
        'rocksdb.num-running-flushes',
        'txnlog.totalSizeBytes',
        'txnlog.uncommittedTransactions',
      ];

      for (const name of selectedStats) {
        const value = (stats as Record<string, unknown>)[name];
        if (typeof value === 'number') snapshot[`rocksdb_${name.replace(/[^A-Za-z0-9]/g, '_')}`] = value;
      }
    } catch {
      // Statistics are best-effort; healthCheck remains authoritative.
    }

    return snapshot;
  }

  getMetadata<T>(name: string): T | undefined {
    return this.db.getSync(metadataKey(name)) as T | undefined;
  }

  async setMetadata(name: string, value: unknown): Promise<void> {
    this.assertWritable('write metadata');
    this.assertPrepared('write metadata');
    await this.runWrite(async () => {
      await this.db.put(metadataKey(name), value);
    });
  }

  /** Performs a complete snapshot validation without creating persistent verification keys. */
  async validateCompactIndexes(): Promise<void> {
    if (this.closing) throw new Error('Cannot validate compact indexes: RocksDB repository is closing');
    this.assertPrepared('validate compact indexes');
    if (this.compactIndexValidationPromise) return this.compactIndexValidationPromise;

    const validation = this.runCompactIndexValidation().finally(() => {
      if (this.compactIndexValidationPromise === validation) this.compactIndexValidationPromise = null;
    });
    this.compactIndexValidationPromise = validation;
    return validation;
  }

  private async runCompactIndexValidation(): Promise<void> {
    await this.db.transaction(async (transaction) => {
      let expectedCount = 0;
      const documentCounts = new Map<IndexerCollection, number>();
      for await (const entry of transaction.getRange(rangeForPrefix(['d']))) {
        if (this.closing) throw new Error('Compact RocksDB index validation stopped during close');
        const identity = documentIdentityFromKey(entry?.key);
        if (!identity) {
          throw new Error(`Compact RocksDB index validation failed: malformed document key ${JSON.stringify(entry?.key)}`);
        }
        const document = decodeStoredDocument(identity.collection, identity.id, entry?.value);
        if (!document) throw new Error(`Compact RocksDB index validation failed: missing value for ${identity.collection}/${identity.id}`);
        documentCounts.set(identity.collection, (documentCounts.get(identity.collection) ?? 0) + 1);
        expectedCount += new Set(compactDocumentIndexKeys(document).map((key) => JSON.stringify(key))).size;
      }

      for (const collection of INDEXER_COLLECTIONS) {
        const actual = documentCounts.get(collection) ?? 0;
        const stored = transaction.getSync(countKey(collection));
        if ((stored === undefined && actual === 0) || stored === actual) continue;
        throw new Error(
          `Compact RocksDB index validation failed: ${collection} count metadata is ${String(stored)}, expected ${actual}`
        );
      }

      let actualCount = 0;
      let activeCountKey: RocksKey | null = null;
      let activeCountIdentity: string | null = null;
      let activePrefixCount = 0;
      let expectedPrefixCountKeys = 0;
      const validateActivePrefixCount = (): void => {
        if (!activeCountKey) return;
        const stored = transaction.getSync(activeCountKey);
        if (stored !== activePrefixCount) {
          throw new Error(
            `Compact RocksDB index validation failed: prefix count ${JSON.stringify(activeCountKey)} is ${String(stored)}, expected ${activePrefixCount}`
          );
        }
        expectedPrefixCountKeys += 1;
      };
      for await (const entry of transaction.getRange(rangeForPrefix(['x']))) {
        if (this.closing) throw new Error('Compact RocksDB index validation stopped during close');
        actualCount += 1;
        const key = entry?.key;
        if (
          !Array.isArray(key) ||
          key[0] !== 'x' ||
          typeof key[1] !== 'string' ||
          !INDEXER_COLLECTIONS.includes(key[1] as IndexerCollection) ||
          typeof key[key.length - 1] !== 'string' ||
          entry?.value !== 1
        ) {
          throw new Error(`Compact RocksDB index validation failed: malformed key ${JSON.stringify(key)}`);
        }

        const collection = key[1] as IndexerCollection;
        const id = key[key.length - 1] as string;
        const document = decodeStoredDocument(collection, id, transaction.getSync(documentKey(collection, id)));
        if (!document) {
          throw new Error(`Compact RocksDB index validation failed: dangling key ${JSON.stringify(key)}`);
        }

        const expectedKeys = new Set(compactDocumentIndexKeys(document).map((candidate) => JSON.stringify(candidate)));
        if (!expectedKeys.has(JSON.stringify(key))) {
          throw new Error(`Compact RocksDB index validation failed: stale key ${JSON.stringify(key)}`);
        }

        const countKeyValue = indexCountKeyForCompactIndex(key);
        if (countKeyValue) {
          const countIdentity = JSON.stringify(countKeyValue);
          if (activeCountIdentity !== countIdentity) {
            validateActivePrefixCount();
            activeCountKey = countKeyValue;
            activeCountIdentity = countIdentity;
            activePrefixCount = 0;
          }
          activePrefixCount += 1;
        }
      }
      validateActivePrefixCount();

      let storedPrefixCountKeys = 0;
      for await (const entry of transaction.getRange(rangeForPrefix(['m', 'indexCount']))) {
        const key = entry?.key;
        if (
          !Array.isArray(key) ||
          key.length < 4 ||
          key[0] !== 'm' ||
          key[1] !== 'indexCount' ||
          typeof key[2] !== 'string' ||
          !INDEXER_COLLECTIONS.includes(key[2] as IndexerCollection) ||
          typeof key[3] !== 'string' ||
          typeof entry?.value !== 'number' ||
          !Number.isSafeInteger(entry.value) ||
          entry.value <= 0
        ) {
          throw new Error(`Compact RocksDB index validation failed: malformed prefix count ${JSON.stringify(key)}`);
        }
        storedPrefixCountKeys += 1;
      }
      if (storedPrefixCountKeys !== expectedPrefixCountKeys) {
        throw new Error(
          `Compact RocksDB index validation failed: expected ${expectedPrefixCountKeys} prefix counts but found ${storedPrefixCountKeys}`
        );
      }

      if (actualCount !== expectedCount) {
        throw new Error(
          `Compact RocksDB index validation failed: expected ${expectedCount} keys but found ${actualCount}`
        );
      }
    });
  }

  private async runWrite<T>(operation: () => Promise<T>): Promise<T> {
    this.assertWritable('write');
    const run = this.writeQueue.then(operation, operation);
    this.writeQueue = run.then(
      () => undefined,
      () => undefined
    );

    return run;
  }

  private assertWritable(operation: string): void {
    if (this.readOnly) throw new Error(`Cannot ${operation}: RocksDB repository is read-only`);
    if (this.closing) throw new Error(`Cannot ${operation}: RocksDB repository is closing`);
  }

  private assertPrepared(operation: string): void {
    if (!this.prepared) throw new Error(`Cannot ${operation}: call RocksDB repository prepare() first`);
  }

  private documentCacheKey(collection: IndexerCollection, id: string): string {
    return `${collection}\0${id}`;
  }

  private cacheDocument(document: IndexerDocument): void {
    const key = this.documentCacheKey(document.collection, document.id);
    const previous = this.documentCache.get(key);
    if (previous) {
      this.documentCache.delete(key);
      this.documentCacheBytes -= previous.bytes;
    }
    if (this.documentCacheMax === 0 || this.documentCacheMaxBytes === 0) {
      this.updateDocumentCacheGauges();
      return;
    }
    const cloneAdmissionLimit = Math.floor(this.documentCacheMaxBytes / 2);
    const bytes = estimateRetainedValueBytes(document, cloneAdmissionLimit);
    if (bytes > cloneAdmissionLimit) {
      metrics.increment('indexer_rocksdb_document_cache_rejections_total', { reason: 'oversized' });
      this.updateDocumentCacheGauges();
      return;
    }
    while (
      this.documentCache.size >= this.documentCacheMax ||
      this.documentCacheBytes + bytes * 2 > this.documentCacheMaxBytes
    ) {
      const oldest = this.documentCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const evicted = this.documentCache.get(oldest);
      this.documentCache.delete(oldest);
      if (evicted) this.documentCacheBytes -= evicted.bytes;
      metrics.increment('indexer_rocksdb_document_cache_evictions_total');
    }
    const owned = cloneIndexerDocument(document);
    this.documentCache.set(key, { document: owned, bytes });
    this.documentCacheBytes += bytes;

    while (
      this.documentCache.size > this.documentCacheMax ||
      this.documentCacheBytes > this.documentCacheMaxBytes
    ) {
      const oldest = this.documentCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const evicted = this.documentCache.get(oldest);
      this.documentCache.delete(oldest);
      if (evicted) this.documentCacheBytes -= evicted.bytes;
      metrics.increment('indexer_rocksdb_document_cache_evictions_total');
    }
    this.updateDocumentCacheGauges();
  }

  private updateDocumentCacheGauges(): void {
    metrics.setGauge('indexer_rocksdb_document_cache_entries', {}, this.documentCache.size);
    metrics.setGauge('indexer_rocksdb_document_cache_bytes', {}, this.documentCacheBytes);
  }

  private evictCachedDocument(collection: IndexerCollection, id: string): void {
    const key = this.documentCacheKey(collection, id);
    const cached = this.documentCache.get(key);
    if (cached && this.documentCache.delete(key)) {
      this.documentCacheBytes -= cached.bytes;
      this.updateDocumentCacheGauges();
    }
  }

  private readDocument(collection: IndexerCollection, id: string, exposeToCaller: boolean): IndexerDocument | undefined {
    if (this.documentCacheMax > 0) {
      const key = this.documentCacheKey(collection, id);
      const cached = this.documentCache.get(key);
      if (cached) {
        this.documentCache.delete(key);
        this.documentCache.set(key, cached);
        metrics.increment('indexer_rocksdb_document_cache_hits_total', { collection });
        return exposeToCaller ? cloneIndexerDocument(cached.document) : cached.document;
      }
      metrics.increment('indexer_rocksdb_document_cache_misses_total', { collection });
    }

    const document = decodeStoredDocument(collection, id, this.db.getSync(documentKey(collection, id)));
    if (document) this.cacheDocument(document);
    return document;
  }

  private selectQuerySource(collection: IndexerCollection, args: RepositoryQueryArgs): QuerySource {
    const { field, direction } = getOrderField(args.orderBy);
    const equalities = collectEqualities(args.filter);
    const idEquality = equalities.find((entry) => entry.field === 'id');
    const orEqualities = collectOrEqualities(args.filter);

    // Validate opaque cursors even if this query ultimately needs a scan/sort.
    orderedPositionForArgs(args, field, direction, (value) =>
      NUMERIC_ORDER_FIELDS.has(field) ? numericSortKey(value) : value
    );

    // Primary IDs are bounded point reads regardless of the requested output
    // order (wallet subscription hydration requests TIMESTAMP_DESC + id eq).
    if (idEquality) {
      return {
        ranges: [{ keyKind: 'document', options: { key: documentKey(collection, String(idEquality.value)) } }],
        preservesOrder: true,
        reason: 'id',
      };
    }
    const directIds = sourceForDirectIdSet(collection, args.filter);
    if (directIds) return directIds;

    if (field === 'id') {
      const indexedEquality = sourceForCompactIdEquality(collection, args.filter, direction);
      if (indexedEquality) return indexedEquality;

      if (collection === 'historyElements') {
        const signatureBlockRange = sourceForHistoryIdSignatureBlockRange(args.filter);
        if (signatureBlockRange) return signatureBlockRange;
      }

      if (collection === 'assets') {
        const activeAssets = sourceForNumericIdProjection(
          collection,
          args.filter,
          ['liquidity', 'liquidityBooks'],
          'x:assets-active-id'
        );
        if (activeAssets) return activeAssets;
        const pricedAssets = sourceForNumericIdProjection(collection, args.filter, ['priceUSD'], 'x:assets-price-id');
        if (pricedAssets) return pricedAssets;
      }

      if (collection === 'poolXYKs') {
        const activePools = sourceForNumericIdProjection(
          collection,
          args.filter,
          ['baseAssetReserves'],
          'x:pools-active-id'
        );
        if (activePools) return activePools;
        const apyPools = sourceForNumericIdProjection(
          collection,
          args.filter,
          ['strategicBonusApy'],
          'x:pools-apy-id'
        );
        if (apyPools) return apyPools;
      }

      const directDocumentOrder = isEmptyFilter(args.filter);
      // A filtered ID query is sorted by the fallback comparator. Do not
      // pre-trim it with RocksDB's byte collation because locale ordering can
      // put valid post-cursor strings on the other side of that raw key.
      const position = directDocumentOrder ? orderedPositionForArgs(args, 'id', direction) : null;
      return {
        ranges: [{ keyKind: 'document', options: rangeForDocumentOrder(collection, direction, position) }],
        preservesOrder: directDocumentOrder,
        reason: directDocumentOrder ? 'document' : 'x:scan-id',
      };
    }

    if (field === 'timestamp' || field === 'blockHeight' || field === 'updatedAtBlock') {
      if (collection === 'accountMeta' && field === 'timestamp') {
        const createdAtBounds = collectNumericRangeBounds(args.filter, 'createdAtTimestamp');
        if (createdAtBounds.lower || createdAtBounds.upper) {
          return {
            ranges: [
              {
                keyKind: 'index',
                options: rangeForOrderedPrefix(compactIndexPrefix(collection, 'c'), 'asc', createdAtBounds),
              },
            ],
            preservesOrder: false,
            reason: 'x:account-created',
          };
        }
      }

      if (orEqualities && field !== 'updatedAtBlock') {
        const selections = orEqualities.map((entry) => {
          const selected = selectCompactDefinition(collection, field, [...equalities, entry]);
          return selected?.definition.equalityFields.includes(entry.field) ? selected : null;
        });

        if (selections.every((selected): selected is NonNullable<typeof selected> => Boolean(selected))) {
          const bounds = collectNumericRangeBounds(args.filter, field);
          const position = orderedPositionForArgs(args, field, direction, numericSortKey);

          return {
            ranges: selections.map(({ definition, values }) => ({
              keyKind: 'index',
              options: rangeForOrderedPrefix(
                compactIndexPrefix(collection, definition.code, values),
                direction,
                bounds,
                position,
                numericSortKey,
                '3'
              ),
            })),
            preservesOrder: true,
            reason: `x:or-${field === 'timestamp' ? 't' : 'b'}`,
            mergeOrder: { field, direction },
          };
        }
      }

      const selected = selectCompactDefinition(collection, field, equalities);
      if (selected) return sourceForCompactOrderedRange(collection, selected, direction, args);

      return {
        ranges: [{ keyKind: 'document', options: rangeForPrefix(['d', collection]) }],
        preservesOrder: false,
        reason: `x:missing-${field === 'timestamp' ? 't' : field === 'blockHeight' ? 'b' : 'u'}`,
      };
    }

    if (NUMERIC_ORDER_FIELDS.has(field) && numericFieldIndexedForCollection(field, collection)) {
      const compactSelected = selectCompactDefinition(collection, field as CompactIndexOrderField, equalities);
      if (compactSelected) return sourceForCompactOrderedRange(collection, compactSelected, direction, args);
      const prefix = compactIndexPrefix(collection, `n:${field}`);
      const position = orderedPositionForArgs(args, field, direction, numericSortKey);
      const bounds = collectExactNumericRangeBounds(args.filter, field);

      return {
        ranges: [
          {
            keyKind: 'index',
            options: rangeForOrderedPrefix(prefix, direction, bounds, position, numericSortKey, '3'),
          },
        ],
        preservesOrder: true,
        reason: 'x:num',
        exactCountKeys: isEmptyFilter(args.filter) ? [countKey(collection)] : undefined,
      };
    }

    return {
      ranges: [{ keyKind: 'document', options: rangeForPrefix(['d', collection]) }],
      preservesOrder: false,
      reason: 'x:scan-sort',
    };
  }

  private async queryOrderedSource(
    collection: IndexerCollection,
    source: QuerySource,
    args: RepositoryQueryArgs
  ): Promise<RepositoryQueryResult> {
    const keyset = args.offset === null || args.offset === undefined ? args.keyset ?? null : null;
    const offset = args.seek || keyset ? 0 : Math.max(Number(args.offset ?? afterToOffset(args.after)), 0);
    const logicalOffset = offset;
    const first = args.first ?? null;
    const last = args.last ?? null;
    const limit = first === null || first === undefined ? null : Math.max(first, 0);
    const collectionCount =
      source.reason === 'document' && !args.seek && !keyset && isEmptyFilter(args.filter) ? this.count(collection) : null;
    const compactRangeCount =
          args.includeTotalCount !== false && source.exactCountKeys
        ? source.exactCountKeys.reduce((sum, key) => {
            const stored = this.db.getSync(key);
            if (stored === undefined) return sum;
            if (typeof stored !== 'number' || !Number.isSafeInteger(stored) || stored < 0) {
              throw new Error(`Missing or corrupt RocksDB compact prefix count ${JSON.stringify(key)}`);
            }
            return sum + stored;
          }, 0)
        : null;
    const exactTotalCount =
      collectionCount ?? compactRangeCount;
    const shouldOverfetch = exactTotalCount === null && (args.includeTotalCount === false || keyset !== null) && limit !== null;
    const queryLimit = shouldOverfetch ? limit + 1 : limit;
    const rows: IndexerDocument[] = [];
    const requestedLimit = queryLimit ?? Number.POSITIVE_INFINITY;
    const { field: orderField } = getOrderField(args.orderBy);
    const keysetAppliedByDocumentRange = keyset !== null && source.reason === 'document' && orderField === 'id';
    const maxBytes = args.maxBytes ?? null;
    let retainedBytes = 0;
    let byteLimitReached = false;

    if (compactRangeCount !== null) {
      metrics.increment('indexer_rocksdb_query_fast_count_total', { collection, source: source.reason });
    }

    if (exactTotalCount !== null && args.includeTotalCount !== false && limit === 0) {
      return {
        items: [],
        itemCursors: [],
        totalCount: exactTotalCount,
        pageStart: logicalOffset,
        hasNextPage: logicalOffset < exactTotalCount,
        hasPreviousPage: logicalOffset > 0,
      };
    }

    let scanned = 0;
    let matched = 0;
    const seen = source.ranges.length > 1 ? new Set<string>() : null;

    for (const document of this.iterateSourceDocuments(collection, source)) {
      scanned += 1;
      this.assertQueryScanBudget(collection, source.reason, scanned);
      if (seen?.has(document.id)) continue;
      seen?.add(document.id);
      if ((args.seek || keyset) && !keysetAppliedByDocumentRange && !isAfterQueryPosition(document, args)) continue;
      if (!matchesDocumentFilter(document, args.filter)) continue;

      if (matched >= offset && rows.length < requestedLimit && !byteLimitReached) {
        if (maxBytes === null) {
          rows.push(document);
        } else {
          const remainingBytes = Math.max(maxBytes - retainedBytes, 0);
          const documentBytes = estimateRetainedValueBytes(document, remainingBytes);
          if (rows.length > 0 && documentBytes > remainingBytes) {
            byteLimitReached = true;
          } else {
            rows.push(document);
            retainedBytes = Math.min(maxBytes + 1, retainedBytes + documentBytes);
          }
        }
      }
      matched += 1;

      if (byteLimitReached && (args.includeTotalCount === false || exactTotalCount !== null)) break;
      if (args.includeTotalCount === false && rows.length >= requestedLimit) break;
      if (exactTotalCount !== null && limit !== null && matched >= offset + requestedLimit) break;
    }

    metrics.increment('indexer_rocksdb_query_scanned_rows_total', { collection, source: source.reason }, scanned);

    const totalCount =
      args.includeTotalCount === false ? null : exactTotalCount ?? matched;
    const requestedWindowLimit = limit ?? rows.length;
    const hasOverfetched = shouldOverfetch && rows.length > requestedWindowLimit;
    const windowRows = hasOverfetched ? rows.slice(0, requestedWindowLimit) : rows;
    const pageStartOffset = last === null || last === undefined ? 0 : Math.max(windowRows.length - Math.max(last, 0), 0);
    const items = last === null || last === undefined ? windowRows : windowRows.slice(pageStartOffset);
    const pageStart = logicalOffset + pageStartOffset;
    const itemCursors = items.map((document) => cursorForIndexerDocument(collection, document, args));

    return {
      items,
      itemCursors,
      totalCount,
      pageStart,
      hasNextPage:
        byteLimitReached ||
        (totalCount === null ? hasOverfetched : logicalOffset + windowRows.length < totalCount),
      hasPreviousPage: keyset !== null || pageStart > 0,
    };
  }

  private async queryFallbackSource(
    collection: IndexerCollection,
    source: QuerySource,
    args: RepositoryQueryArgs
  ): Promise<RepositoryQueryResult> {
    const keyset = args.offset === null || args.offset === undefined ? args.keyset ?? null : null;
    const offset = args.seek || keyset ? 0 : Math.max(Number(args.offset ?? afterToOffset(args.after)), 0);
    const first = args.first ?? null;
    const last = args.last ?? null;
    const limit = first === null || first === undefined ? null : Math.max(first, 0);
    const retainedLimit = limit === null ? Number.POSITIVE_INFINITY : offset + limit;
    const seen = new Set<string>();
    const matching: IndexerDocument[] = [];
    const maxBytes = args.maxBytes ?? null;
    const documentBytes = new Map<string, number>();
    let scanned = 0;
    let matched = 0;

    const trimCandidates = (): void => {
      const sorted = sortIndexerDocuments(matching, args.orderBy);
      const countLimited = Number.isFinite(retainedLimit) ? sorted.slice(0, retainedLimit) : sorted;
      if (maxBytes === null) {
        matching.splice(0, matching.length, ...countLimited);
        return;
      }

      const retained: IndexerDocument[] = [];
      let retainedBytes = 0;
      for (let index = 0; index < countLimited.length; index += 1) {
        const document = countLimited[index]!;
        // Offset rows are needed only to establish the requested window. The
        // public GraphQL surface is keyset-only, so this compatibility path
        // cannot be attacker-amplified there.
        if (index < offset) {
          retained.push(document);
          continue;
        }
        const identity = `${document.collection}\0${document.id}`;
        let bytes = documentBytes.get(identity);
        if (bytes === undefined) {
          bytes = estimateRetainedValueBytes(document, maxBytes);
          documentBytes.set(identity, bytes);
        }
        if (retained.length > offset && bytes > Math.max(maxBytes - retainedBytes, 0)) break;
        retained.push(document);
        retainedBytes = Math.min(maxBytes + 1, retainedBytes + bytes);
      }
      matching.splice(0, matching.length, ...retained);
    };

    for (const document of this.iterateSourceDocuments(collection, source)) {
      scanned += 1;
      this.assertQueryScanBudget(collection, source.reason, scanned);
      if (seen.has(document.id)) continue;
      seen.add(document.id);
      if ((args.seek || keyset) && !isAfterQueryPosition(document, args)) continue;
      if (!matchesDocumentFilter(document, args.filter)) continue;
      matched += 1;
      if (retainedLimit > 0) matching.push(document);
      if (
        maxBytes !== null ||
        (Number.isFinite(retainedLimit) && matching.length >= Math.max(retainedLimit * 2, 1_000))
      ) {
        trimCandidates();
      }
    }

    metrics.increment('indexer_rocksdb_query_scanned_rows_total', { collection, source: source.reason }, scanned);

    trimCandidates();
    const sorted = sortIndexerDocuments(matching, args.orderBy);
    const remainingCount = matched;
    const totalCount = matched;
    const end = limit === null || limit === undefined ? remainingCount : Math.min(offset + limit, remainingCount);
    const countWindowSize = Math.max(end - offset, 0);
    const byteLimitReached = maxBytes !== null && Math.max(sorted.length - offset, 0) < countWindowSize;
    const relativePageStart = last === null || last === undefined ? offset : Math.max(end - Math.max(last, 0), offset);
    const items = sorted.slice(relativePageStart, end);
    const pageStart = relativePageStart;
    const itemCursors = items.map((document) => cursorForIndexerDocument(collection, document, args));

    return {
      items,
      itemCursors,
      totalCount: args.includeTotalCount === false ? null : totalCount,
      pageStart,
      hasNextPage: byteLimitReached || end < remainingCount,
      hasPreviousPage: keyset !== null || pageStart > 0,
    };
  }

  private *iterateSourceDocuments(collection: IndexerCollection, source: QuerySource): Generator<IndexerDocument> {
    if (source.mergeOrder && source.ranges.length > 1) {
      const iterators = source.ranges.map((range) => this.iterateRangeDocuments(collection, range));
      const heads = iterators.map((iterator) => iterator.next());
      const { field, direction } = source.mergeOrder;

      while (true) {
        let selectedIndex = -1;
        for (let index = 0; index < heads.length; index += 1) {
          const head = heads[index];
          if (!head || head.done) continue;
          if (selectedIndex < 0) {
            selectedIndex = index;
            continue;
          }

          const selected = heads[selectedIndex];
          if (!selected || selected.done) {
            selectedIndex = index;
            continue;
          }

          const comparison = compareDocumentOrderValues(
            documentOrderValue(head.value, field),
            documentOrderValue(selected.value, field),
            field,
            direction
          );
          const comesFirst =
            comparison === 0
              ? direction === 'desc'
                ? head.value.id > selected.value.id
                : head.value.id < selected.value.id
              : comparison < 0;
          if (comesFirst) selectedIndex = index;
        }

        if (selectedIndex < 0) return;
        const selected = heads[selectedIndex];
        if (!selected || selected.done) return;
        yield selected.value;
        heads[selectedIndex] = iterators[selectedIndex]!.next();
      }
    }

    for (const range of source.ranges) {
      yield* this.iterateRangeDocuments(collection, range);
    }
  }

  private *iterateRangeDocuments(collection: IndexerCollection, range: IndexRange): Generator<IndexerDocument> {
    for (const entry of this.db.getRange(range.options)) {
      if (range.keyKind === 'document') {
          const identity = documentIdentityFromKey(entry?.key);
          if (!identity) continue;
          const document = decodeStoredDocument(identity.collection, identity.id, entry?.value);
          if (document) yield document;
        continue;
      }

      const id = keyId(entry?.key);
      if (!id) continue;
        const document = decodeStoredDocument(collection, id, this.db.getSync(documentKey(collection, id)));
        if (document) yield document;
    }
  }

  private async waitForWatchDocument(subscriber: WatchSubscriber): Promise<void> {
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };

      timer = setTimeout(() => {
        if (subscriber.notify === wake) subscriber.notify = null;
        resolve();
      }, WATCH_IDLE_WAKE_INTERVAL_MS);
      subscriber.notify = wake;
    });
  }

  private assertQueryScanBudget(collection: IndexerCollection, source: string, scanned: number): void {
    if (scanned <= this.queryMaxScannedRows) return;

    metrics.increment('indexer_rocksdb_query_scan_limit_total', { collection, source });
    throw new Error(
      `RocksDB query exceeded the ${this.queryMaxScannedRows} row scan limit for ${collection}; refine the filter or order`
    );
  }

  private async recordOperation<T>(
    operation: string,
    collectionName: IndexerCollection | 'all',
    run: () => Promise<T>
  ): Promise<T> {
    const startedAt = Date.now();
    const labels = { operation, collection: collectionName, engine: 'rocksdb' };

    metrics.increment('indexer_repository_operations_total', labels);
    try {
      return await run();
    } catch (error) {
      metrics.increment('indexer_repository_errors_total', labels);
      throw error;
    } finally {
      metrics.observe('indexer_repository_operation_duration_seconds', labels, secondsSince(startedAt));
    }
  }
}
