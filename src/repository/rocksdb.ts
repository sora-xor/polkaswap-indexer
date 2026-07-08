import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { RocksDatabase } from '@harperfast/rocksdb-js';

import { matchesFilter, sortDocuments } from '../graphql/filter.js';
import { getOrderField, NUMERIC_ORDER_FIELDS } from '../graphql/order.js';
import { metrics } from '../metrics.js';

import type { AppConfig } from '../config.js';
import type {
  IndexerCollection,
  IndexerDocument,
  IndexerRepository,
  RepositoryMetricsSnapshot,
  RepositoryQueryArgs,
  RepositoryQueryResult,
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
};
type WatchSubscriber = {
  id: number;
  collection: IndexerCollection;
  ids: Set<string>;
  queue: IndexerDocument[];
  notify: (() => void) | null;
};

const HIGH_KEY = Buffer.from([0xff]);
const UPSERT_BATCH_SIZE = 1_000;
const WATCH_IDLE_WAKE_INTERVAL_MS = 30_000;
const DEFAULT_WATCH_QUEUE_MAX = 1_000;
const NUMERIC_INTEGER_WIDTH = 80;
const NUMERIC_FRACTION_WIDTH = 40;
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

const EQUALITY_INDEX_FIELDS = new Set([
  'account',
  'accountId',
  'accountLiquidityId',
  'address',
  'assetId',
  'baseAssetId',
  'collateralAssetId',
  'dataFrom',
  'dataTo',
  'debtAssetId',
  'historyElementId',
  'marketId',
  'method',
  'module',
  'orderBookId',
  'ownerId',
  'poolId',
  'quoteAssetId',
  'referrer',
  'status',
  'targetAssetId',
  'type',
  'validatorId',
]);

const EQUALITY_FIELD_PRIORITY = [
  'id',
  'account',
  'accountId',
  'accountLiquidityId',
  'address',
  'dataFrom',
  'dataTo',
  'assetId',
  'poolId',
  'orderBookId',
  'marketId',
  'historyElementId',
  'referrer',
  'status',
  'type',
  'module',
  'method',
];

const NUMERIC_INDEX_COLLECTIONS = {
  updatedAtBlock: ['historyElements', 'markets', 'orderBooks', 'orderBookOrders', 'vaults', 'vaultEvents', 'accountPositions'],
  createdAtBlock: ['accountMeta', 'markets', 'orderBookOrders', 'vaults', 'vaultEvents'],
  priceChangeDay: ['assets', 'orderBooks'],
  liquidity: ['assets'],
  liquidityBooks: ['assets'],
  liquidityUSD: ['assets', 'markets', 'marketSnapshots', 'networkSnapshots', 'orderBooks', 'orderBookSnapshots', 'poolXYKs', 'poolSnapshots'],
  priceUSD: ['assets', 'poolXYKs'],
  poolTokenPriceUSD: ['poolXYKs', 'poolSnapshots'],
  priceChangeWeek: ['assets'],
  volumeDayUSD: ['assets', 'orderBooks'],
  volumeWeekUSD: ['assets'],
  volumeUSD: ['markets', 'marketSnapshots', 'networkSnapshots', 'orderBookSnapshots', 'poolSnapshots'],
  baseAssetReserves: ['orderBooks', 'poolXYKs', 'poolSnapshots'],
  targetAssetReserves: ['poolXYKs', 'poolSnapshots'],
  amount: ['orderBookOrders', 'referrerRewards', 'xorBurns'],
  apy: ['stakingValidators'],
  commission: ['stakingValidators'],
  rewardPoints: ['stakingValidators'],
} satisfies Record<string, string[]>;

const readPositiveInt = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);

  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
};

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
const metadataKey = (name: string): RocksKey => ['m', 'metadata', name];

const readDocumentNumber = (document: IndexerDocument, field: 'timestamp' | 'blockHeight'): number | null => {
  const value = field === 'timestamp' ? document.timestamp ?? document.data.timestamp : document.blockHeight ?? document.data.blockHeight;
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;
};

const readPositiveTimestamp = (document: IndexerDocument): number | null => readDocumentNumber(document, 'timestamp');
const readPositiveBlockHeight = (document: IndexerDocument): number | null => readDocumentNumber(document, 'blockHeight');

const isScalarIndexValue = (value: unknown): value is string | number | boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

const indexValue = (value: unknown): string | number | boolean | null => {
  if (!isScalarIndexValue(value)) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;

  return value;
};

const normalizeDecimal = (value: unknown): { sign: -1 | 0 | 1; integer: string; fraction: string } => {
  const text = String(value ?? '0').trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) return { sign: 0, integer: '0', fraction: '' };

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
  const normalized = normalizeDecimal(value);
  const integer = normalized.integer.padStart(NUMERIC_INTEGER_WIDTH, '0').slice(-NUMERIC_INTEGER_WIDTH);
  const fraction = normalized.fraction.padEnd(NUMERIC_FRACTION_WIDTH, '0').slice(0, NUMERIC_FRACTION_WIDTH);

  if (normalized.sign < 0) return `0:${invertDigits(integer)}:${invertDigits(fraction)}`;
  if (normalized.sign === 0) return `1:${integer}:${fraction}`;

  return `2:${integer}:${fraction}`;
};

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
      JSON.stringify(left.data) === JSON.stringify(right.data)
  );

const dedupeDocuments = (documents: IndexerDocument[]): IndexerDocument[] => {
  const byPrimaryKey = new Map<string, IndexerDocument>();

  for (const document of documents) {
    byPrimaryKey.set(`${document.collection}\0${document.id}`, document);
  }

  return [...byPrimaryKey.values()];
};

const indexedNumericFieldsForCollection = (collection: IndexerCollection): string[] =>
  Object.entries(NUMERIC_INDEX_COLLECTIONS)
    .filter(([, collections]) => collections.includes(collection))
    .map(([field]) => field);

const documentIndexKeys = (document: IndexerDocument): RocksKey[] => {
  const keys: RocksKey[] = [];
  const timestamp = readPositiveTimestamp(document);
  const blockHeight = readPositiveBlockHeight(document);

  if (timestamp !== null) keys.push(['i', 'ts', document.collection, timestamp, document.id]);
  if (blockHeight !== null) keys.push(['i', 'bh', document.collection, blockHeight, document.id]);

  for (const field of EQUALITY_INDEX_FIELDS) {
    const value = indexValue(document.data[field]);
    if (value === null) continue;

    keys.push(['i', 'eq', document.collection, field, value, document.id]);
    if (timestamp !== null) keys.push(['i', 'eqTs', document.collection, field, value, timestamp, document.id]);
  }

  for (const field of indexedNumericFieldsForCollection(document.collection)) {
    keys.push(['i', 'num', document.collection, field, numericSortKey(document.data[field]), document.id]);
  }

  return keys;
};

const matchesDocumentFilter = (document: IndexerDocument, filter: RepositoryQueryArgs['filter']): boolean =>
  matchesFilter(queryableData(document), filter);

const sortIndexerDocuments = (documents: IndexerDocument[], orderBy: RepositoryQueryArgs['orderBy']): IndexerDocument[] =>
  sortDocuments(
    documents.map((document) => ({
      ...queryableData(document),
      __document: document,
    })),
    orderBy
  ).map((item) => item.__document as IndexerDocument);

const isFilterRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isEmptyFilter = (filter: RepositoryQueryArgs['filter']): boolean =>
  !filter || (isFilterRecord(filter) && Object.keys(filter).length === 0);

const readEqualValue = (condition: unknown): unknown => {
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

    const value = indexValue(readEqualValue(condition));
    if (value !== null) equalities.push({ field, value });
  }

  return equalities;
};

const collectOrEqualities = (filter: RepositoryQueryArgs['filter']): Array<{ field: string; value: string | number | boolean }> | null => {
  if (!filter || !isFilterRecord(filter)) return null;
  const orItems = filter.or;
  if (!Array.isArray(orItems) || !orItems.length) return null;

  const branches = orItems
    .map((item) => collectEqualities(item as RepositoryQueryArgs['filter']).find((entry) => EQUALITY_INDEX_FIELDS.has(entry.field)))
    .filter((entry): entry is { field: string; value: string | number | boolean } => Boolean(entry));

  return branches.length === orItems.length ? branches : null;
};

const chooseEquality = (
  equalities: Array<{ field: string; value: string | number | boolean }>
): { field: string; value: string | number | boolean } | null => {
  for (const field of EQUALITY_FIELD_PRIORITY) {
    const equality = equalities.find((entry) => entry.field === field);
    if (equality) return equality;
  }

  return equalities[0] ?? null;
};

const keyId = (key: unknown): string | null => {
  if (!Array.isArray(key)) return null;
  const id = key[key.length - 1];

  return typeof id === 'string' ? id : null;
};

const sourceForOrderedRange = (
  collection: IndexerCollection,
  indexName: 'ts' | 'bh',
  field: 'timestamp' | 'blockHeight',
  direction: 'asc' | 'desc',
  seek: RepositoryQueryArgs['seek']
): QuerySource => {
  const prefix: RocksKey = ['i', indexName, collection];
  const options = rangeForPrefix(prefix, { values: false, reverse: direction === 'desc' });

  if (seek?.field === field && direction === 'asc') {
    options.start = [...prefix, seek.value, seek.id];
    options.exclusiveStart = true;
  } else if (seek?.field === field && direction === 'desc') {
    options.start = [...prefix, seek.value, seek.id];
  }

  return {
    ranges: [{ keyKind: 'index', options }],
    preservesOrder: true,
    reason: indexName,
  };
};

const sourceForEqualityTimestampRange = (
  collection: IndexerCollection,
  equality: { field: string; value: string | number | boolean },
  direction: 'asc' | 'desc',
  seek: RepositoryQueryArgs['seek']
): QuerySource => {
  const prefix: RocksKey = ['i', 'eqTs', collection, equality.field, equality.value];
  const options = rangeForPrefix(prefix, { values: false, reverse: direction === 'desc' });

  if (seek?.field === 'timestamp' && direction === 'asc') {
    options.start = [...prefix, seek.value, seek.id];
    options.exclusiveStart = true;
  } else if (seek?.field === 'timestamp' && direction === 'desc') {
    options.start = [...prefix, seek.value, seek.id];
  }

  return {
    ranges: [{ keyKind: 'index', options }],
    preservesOrder: true,
    reason: 'eqTs',
  };
};

const isAfterSeek = (document: IndexerDocument, seek: NonNullable<RepositoryQueryArgs['seek']>): boolean => {
  const value = readDocumentNumber(document, seek.field) ?? 0;
  const direction = seek.direction ?? 'asc';

  if (value === seek.value) {
    return direction === 'desc' ? document.id < seek.id : document.id > seek.id;
  }

  return direction === 'desc' ? value < seek.value : value > seek.value;
};

export class RocksRepository implements IndexerRepository {
  private readonly db: RocksDatabase;
  private readonly events = new EventEmitter();
  private readonly watchQueueMax: number;
  private nextWatchSubscriberId = 1;
  private writeQueue = Promise.resolve();

  constructor(config: AppConfig) {
    mkdirSync(dirname(config.rocksdbPath), { recursive: true });
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
    });
    this.watchQueueMax = readPositiveInt('ROCKSDB_WATCH_QUEUE_MAX', DEFAULT_WATCH_QUEUE_MAX);
  }

  async list(collection: IndexerCollection): Promise<IndexerDocument[]> {
    return this.recordOperation('list', collection, async () => {
      const documents: IndexerDocument[] = [];

      for (const entry of this.db.getRange(rangeForPrefix(['d', collection]))) {
        if (entry?.value) documents.push(entry.value as IndexerDocument);
      }

      return documents;
    });
  }

  async query(collection: IndexerCollection, args: RepositoryQueryArgs): Promise<RepositoryQueryResult> {
    return this.recordOperation('query', collection, async () => {
      const source = this.selectQuerySource(collection, args);
      if (!source.preservesOrder) {
        metrics.increment('indexer_rocksdb_query_fallback_total', { collection, reason: source.reason });
      }

      return source.preservesOrder
        ? this.queryOrderedSource(collection, source, args)
        : this.queryFallbackSource(collection, source, args);
    });
  }

  async get(collection: IndexerCollection, id: string): Promise<IndexerDocument | null> {
    return this.recordOperation('get', collection, async () => {
      return (this.db.getSync(documentKey(collection, id)) as IndexerDocument | undefined) ?? null;
    });
  }

  count(collection: IndexerCollection): number {
    const value = this.db.getSync(countKey(collection));

    return typeof value === 'number' ? value : 0;
  }

  async getMany(collection: IndexerCollection, ids: string[]): Promise<Map<string, IndexerDocument>> {
    if (!ids.length) return new Map();

    return this.recordOperation('getMany', collection, async () => {
      const result = new Map<string, IndexerDocument>();

      for (const id of new Set(ids)) {
        const document = this.db.getSync(documentKey(collection, id)) as IndexerDocument | undefined;
        if (document) result.set(id, document);
      }

      return result;
    });
  }

  async upsert(document: IndexerDocument): Promise<void> {
    await this.upsertMany([document]);
  }

  async upsertMany(documents: IndexerDocument[]): Promise<void> {
    if (!documents.length) return;

    await this.recordOperation('upsertMany', 'all', () => this.runWrite(async () => {
      const changedDocuments: IndexerDocument[] = [];
      const uniqueDocuments = dedupeDocuments(documents);

      for (let start = 0; start < uniqueDocuments.length; start += UPSERT_BATCH_SIZE) {
        const batch = uniqueDocuments.slice(start, start + UPSERT_BATCH_SIZE);
        const changedBatch: Array<{ document: IndexerDocument; previous: IndexerDocument | undefined }> = [];
        const insertedByCollection = new Map<IndexerCollection, number>();

        for (const document of batch) {
          const previous = this.db.getSync(documentKey(document.collection, document.id)) as IndexerDocument | undefined;
          if (documentsEqual(previous, document)) continue;

          changedBatch.push({ document, previous });
          if (!previous) insertedByCollection.set(document.collection, (insertedByCollection.get(document.collection) ?? 0) + 1);
        }

        if (!changedBatch.length) continue;

        const nextCounts = new Map<IndexerCollection, number>();
        for (const [collection, inserted] of insertedByCollection) {
          nextCounts.set(collection, this.count(collection) + inserted);
        }

        await this.db.transaction(async (transaction) => {
          for (const { document, previous } of changedBatch) {
            const key = documentKey(document.collection, document.id);

            if (previous) {
              for (const indexKey of documentIndexKeys(previous)) {
                await transaction.remove(indexKey);
              }
            }

            await transaction.put(key, document);
            for (const indexKey of documentIndexKeys(document)) {
              await transaction.put(indexKey, 1);
            }
            changedDocuments.push(document);
          }

          for (const [collection, count] of nextCounts) {
            await transaction.put(countKey(collection), count);
          }
        });
      }

      for (const document of changedDocuments) {
        this.events.emit('document', document);
      }
    }));
  }

  async deleteMany(collection: IndexerCollection, ids: string[]): Promise<void> {
    const uniqueIds = [...new Set(ids)];
    if (!uniqueIds.length) return;

    await this.recordOperation('deleteMany', collection, () => this.runWrite(async () => {
      const previousDocuments = uniqueIds
        .map((id) => this.db.getSync(documentKey(collection, id)) as IndexerDocument | undefined)
        .filter((document): document is IndexerDocument => Boolean(document));

      if (!previousDocuments.length) return;

      const nextCount = Math.max(this.count(collection) - previousDocuments.length, 0);

      await this.db.transaction(async (transaction) => {
        for (const previous of previousDocuments) {
          for (const indexKey of documentIndexKeys(previous)) {
            await transaction.remove(indexKey);
          }
          await transaction.remove(documentKey(collection, previous.id));
        }

        await transaction.put(countKey(collection), nextCount);
      });
    }));
  }

  async close(): Promise<void> {
    this.events.removeAllListeners();
    this.db.close();
  }

  async healthCheck(): Promise<boolean> {
    try {
      return this.db.isOpen();
    } catch {
      return false;
    }
  }

  async *watch(collection: IndexerCollection, ids: string[] = []): AsyncGenerator<IndexerDocument, void, unknown> {
    const subscriber: WatchSubscriber = {
      id: this.nextWatchSubscriberId++,
      collection,
      ids: new Set(ids),
      queue: [],
      notify: null,
    };
    const listener = (document: IndexerDocument) => {
      if (document.collection !== subscriber.collection) return;
      if (subscriber.ids.size && !subscriber.ids.has(document.id)) return;

      if (subscriber.queue.length >= this.watchQueueMax) subscriber.queue.shift();
      subscriber.queue.push(document);
      subscriber.notify?.();
      subscriber.notify = null;
    };

    this.events.on('document', listener);

    try {
      while (true) {
        if (!subscriber.queue.length) {
          await this.waitForWatchDocument(subscriber);
        }

        const document = subscriber.queue.shift();
        if (document) yield document;
      }
    } finally {
      this.events.off('document', listener);
      subscriber.notify?.();
      subscriber.notify = null;
    }
  }

  metricsSnapshot(): RepositoryMetricsSnapshot {
    const snapshot: RepositoryMetricsSnapshot = {
      rocksdb_estimated_keys: this.db.getEstimatedKeyCount(),
      rocksdb_open: this.db.isOpen() ? 1 : 0,
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
    await this.db.put(metadataKey(name), value);
  }

  private async runWrite<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(operation, operation);
    this.writeQueue = run.then(
      () => undefined,
      () => undefined
    );

    return run;
  }

  private selectQuerySource(collection: IndexerCollection, args: RepositoryQueryArgs): QuerySource {
    const { field, direction } = getOrderField(args.orderBy);
    const equalities = collectEqualities(args.filter);
    const equality = chooseEquality(equalities.filter((entry) => entry.field === 'id' || EQUALITY_INDEX_FIELDS.has(entry.field)));
    const orEqualities = collectOrEqualities(args.filter);

    if (field === 'timestamp') {
      if (orEqualities) {
        return {
          ranges: orEqualities.map((entry) => ({
            keyKind: 'index',
            options: rangeForPrefix(['i', 'eqTs', collection, entry.field, entry.value], { values: false, reverse: direction === 'desc' }),
          })),
          preservesOrder: false,
          reason: 'or-eqTs',
        };
      }
      const timestampEquality = equality && EQUALITY_INDEX_FIELDS.has(equality.field) ? equality : null;
      if (timestampEquality) return sourceForEqualityTimestampRange(collection, timestampEquality, direction, args.seek);
      return sourceForOrderedRange(collection, 'ts', 'timestamp', direction, args.seek);
    }

    if (field === 'blockHeight') return sourceForOrderedRange(collection, 'bh', 'blockHeight', direction, args.seek);

    if (field === 'id') {
      if (equality?.field === 'id') {
        return {
          ranges: [{ keyKind: 'document', options: { key: documentKey(collection, String(equality.value)) } }],
          preservesOrder: true,
          reason: 'id',
        };
      }
      if (orEqualities) {
        return {
          ranges: orEqualities.map((entry) => ({
            keyKind: 'index',
            options: rangeForPrefix(['i', 'eq', collection, entry.field, entry.value], { values: false }),
          })),
          preservesOrder: false,
          reason: 'or-eq',
        };
      }
      if (equality && EQUALITY_INDEX_FIELDS.has(equality.field)) {
        return {
          ranges: [{ keyKind: 'index', options: rangeForPrefix(['i', 'eq', collection, equality.field, equality.value], { values: false }) }],
          preservesOrder: true,
          reason: 'eq',
        };
      }

      return {
        ranges: [{ keyKind: 'document', options: rangeForPrefix(['d', collection], { reverse: direction === 'desc' }) }],
        preservesOrder: true,
        reason: 'document',
      };
    }

    if (NUMERIC_ORDER_FIELDS.has(field) && numericFieldIndexedForCollection(field, collection)) {
      return {
        ranges: [{ keyKind: 'index', options: rangeForPrefix(['i', 'num', collection, field], { values: false, reverse: direction === 'desc' }) }],
        preservesOrder: true,
        reason: 'num',
      };
    }

    if (orEqualities) {
      return {
        ranges: orEqualities.map((entry) => ({
          keyKind: 'index',
          options: rangeForPrefix(['i', 'eq', collection, entry.field, entry.value], { values: false }),
        })),
        preservesOrder: false,
        reason: 'or-eq',
      };
    }

    if (equality && EQUALITY_INDEX_FIELDS.has(equality.field)) {
      return {
        ranges: [{ keyKind: 'index', options: rangeForPrefix(['i', 'eq', collection, equality.field, equality.value], { values: false }) }],
        preservesOrder: false,
        reason: 'eq-sort',
      };
    }

    return {
      ranges: [{ keyKind: 'document', options: rangeForPrefix(['d', collection]) }],
      preservesOrder: false,
      reason: 'scan-sort',
    };
  }

  private async queryOrderedSource(
    collection: IndexerCollection,
    source: QuerySource,
    args: RepositoryQueryArgs
  ): Promise<RepositoryQueryResult> {
    const offset = args.seek ? 0 : Math.max(Number(args.offset ?? afterToOffset(args.after)), 0);
    const first = args.first ?? null;
    const last = args.last ?? null;
    const limit = first === null || first === undefined ? null : Math.max(first, 0);
    const shouldOverfetch = args.includeTotalCount === false && limit !== null;
    const queryLimit = shouldOverfetch ? limit + 1 : limit;
    const rows: IndexerDocument[] = [];
    const requestedLimit = queryLimit ?? Number.POSITIVE_INFINITY;
    const collectionCount = source.reason === 'document' && !args.seek && isEmptyFilter(args.filter) ? this.count(collection) : null;

    if (collectionCount !== null && args.includeTotalCount !== false && limit === 0) {
      return {
        items: [],
        totalCount: collectionCount,
        pageStart: offset,
        hasNextPage: offset < collectionCount,
        hasPreviousPage: offset > 0,
      };
    }

    let scanned = 0;
    let matched = 0;

    for (const document of this.iterateSourceDocuments(collection, source)) {
      scanned += 1;
      if (args.seek && !isAfterSeek(document, args.seek)) continue;
      if (!matchesDocumentFilter(document, args.filter)) continue;

      if (matched >= offset && rows.length < requestedLimit) rows.push(document);
      matched += 1;

      if (args.includeTotalCount === false && rows.length >= requestedLimit) break;
      if (collectionCount !== null && limit !== null && matched >= offset + requestedLimit) break;
    }

    metrics.increment('indexer_rocksdb_query_scanned_rows_total', { collection, source: source.reason }, scanned);

    const totalCount = args.includeTotalCount === false ? null : collectionCount ?? matched;
    const requestedWindowLimit = limit ?? rows.length;
    const hasOverfetched = shouldOverfetch && rows.length > requestedWindowLimit;
    const windowRows = hasOverfetched ? rows.slice(0, requestedWindowLimit) : rows;
    const pageStartOffset = last === null || last === undefined ? 0 : Math.max(windowRows.length - Math.max(last, 0), 0);
    const items = last === null || last === undefined ? windowRows : windowRows.slice(pageStartOffset);
    const pageStart = offset + pageStartOffset;

    return {
      items,
      totalCount,
      pageStart,
      hasNextPage: totalCount === null ? hasOverfetched : offset + windowRows.length < totalCount,
      hasPreviousPage: pageStart > 0,
    };
  }

  private async queryFallbackSource(
    collection: IndexerCollection,
    source: QuerySource,
    args: RepositoryQueryArgs
  ): Promise<RepositoryQueryResult> {
    const offset = args.seek ? 0 : Math.max(Number(args.offset ?? afterToOffset(args.after)), 0);
    const first = args.first ?? null;
    const last = args.last ?? null;
    const limit = first === null || first === undefined ? null : Math.max(first, 0);
    const seen = new Set<string>();
    const matching: IndexerDocument[] = [];
    let scanned = 0;

    for (const document of this.iterateSourceDocuments(collection, source)) {
      scanned += 1;
      if (seen.has(document.id)) continue;
      seen.add(document.id);
      if (args.seek && !isAfterSeek(document, args.seek)) continue;
      if (matchesDocumentFilter(document, args.filter)) matching.push(document);
    }

    metrics.increment('indexer_rocksdb_query_scanned_rows_total', { collection, source: source.reason }, scanned);

    const sorted = sortIndexerDocuments(matching, args.orderBy);
    const totalCount = sorted.length;
    const end = limit === null || limit === undefined ? totalCount : Math.min(offset + limit, totalCount);
    const pageStart = last === null || last === undefined ? offset : Math.max(end - Math.max(last, 0), offset);
    const items = sorted.slice(pageStart, end);

    return {
      items,
      totalCount: args.includeTotalCount === false ? null : totalCount,
      pageStart,
      hasNextPage: end < totalCount,
      hasPreviousPage: pageStart > 0,
    };
  }

  private *iterateSourceDocuments(collection: IndexerCollection, source: QuerySource): Generator<IndexerDocument> {
    for (const range of source.ranges) {
      for (const entry of this.db.getRange(range.options)) {
        if (range.keyKind === 'document') {
          const document = entry?.value as IndexerDocument | undefined;
          if (document) yield document;
          continue;
        }

        const id = keyId(entry?.key);
        if (!id) continue;
        const document = this.db.getSync(documentKey(collection, id)) as IndexerDocument | undefined;
        if (document) yield document;
      }
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
