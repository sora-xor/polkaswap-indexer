import pg from 'pg';

import { getOrderField, NUMERIC_ORDER_FIELDS } from '../graphql/order.js';
import { metrics } from '../metrics.js';
import { POSTGRES_TRUSTED_SESSION_OPTIONS } from '../postgres-session.js';
import {
  assertPostgresWorkerFencingToken,
  postgresAdvisoryLockParts,
  POSTGRES_WORKER_LEASE_FENCE_TABLE,
  POSTGRES_WORKER_LEASE_LOCK_KEY,
  POSTGRES_WORKER_MUTATION_FENCE_LOCK_KEY,
} from '../postgres-worker-fence.js';
import {
  createRepositoryCursorScope,
  encodeRepositoryCursor,
  normalizeRepositoryCursorValue,
} from './cursor.js';
import { decodePostgresDocument } from './postgres-document.js';
import { LatestDocumentWatchQueue } from './watch-queue.js';
import {
  assertValidDocumentId,
  assertValidIndexedDecimal,
  assertValidIndexerCollection,
  assertValidNativePositionQueryValue,
  assertValidRepositoryQueryPositions,
  iterateIndexerDocumentJsonPayloads,
  normalizeIndexerDocument,
  normalizeIndexerDocumentWriteCall,
} from './validation.js';

import type {
  IndexerCollection,
  IndexerDocument,
  IndexerRepository,
  RepositoryKeyset,
  RepositoryMetricsSnapshot,
  RepositoryQueryArgs,
  RepositoryQueryResult,
  RepositoryWatchEvent,
  RepositoryWatchMutation,
} from './types.js';
import type { AppConfig } from '../config.js';

const { Pool } = pg;

const NUMERIC_TEXT_PATTERN = "^-?[0-9]+(\\.[0-9]+)?$";
const afterToOffset = (after: RepositoryQueryArgs['after']): number => {
  if (after === null || after === undefined || after === '') return 0;

  const parsed = Number(after);
  return Number.isFinite(parsed) ? parsed + 1 : 0;
};

const isSafeJsonField = (field: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(field);
const isFilterObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const sqlJsonField = (field: string): string => {
  if (field === 'id') return 'id';
  if (field === 'timestamp') return 'timestamp::text';
  if (field === 'blockHeight') return 'block_height::text';

  if (!isSafeJsonField(field)) {
    throw new Error(`Unsupported JSON field in repository query: ${field}`);
  }

  return `data->>'${field}'`;
};

const sqlNativeNumericField = (field: string): string | null => {
  if (field === 'timestamp') return 'timestamp';
  if (field === 'blockHeight') return 'block_height';

  return null;
};

const secondsSince = (startedAt: number): number => (Date.now() - startedAt) / 1000;

const sqlJsonValue = (field: string): string => {
  if (!isSafeJsonField(field)) {
    throw new Error(`Unsupported JSON field in repository query: ${field}`);
  }

  return `data->'${field}'`;
};

const WATCH_FLUSH_DELAY_MS = 25;
const WATCH_IDLE_WAKE_INTERVAL_MS = 30_000;

type PostgresRuntimeConfig = Pick<
  AppConfig,
  | 'databaseUrl'
  | 'postgresPoolMax'
  | 'postgresListenPoolMax'
  | 'postgresConnectionTimeoutMs'
  | 'postgresQueryTimeoutMs'
  | 'postgresStatementTimeoutMs'
  | 'postgresWatchQueueMax'
  | 'postgresWatchReconnectMinDelayMs'
  | 'postgresWatchReconnectMaxDelayMs'
>;

export type PostgresRepositoryOptions = {
  /**
   * Enables the worker-only mutation fence. API and administrative repository
   * instances intentionally remain unfenced unless a lease token is supplied.
   */
  workerFencingToken?: string | null;
};

const defaultPostgresRuntimeConfig = (databaseUrl: string): PostgresRuntimeConfig => ({
  databaseUrl,
  postgresPoolMax: 20,
  postgresListenPoolMax: 2,
  postgresConnectionTimeoutMs: 10_000,
  postgresQueryTimeoutMs: 120_000,
  postgresStatementTimeoutMs: 120_000,
  postgresWatchQueueMax: 1_000,
  postgresWatchReconnectMinDelayMs: 100,
  postgresWatchReconnectMaxDelayMs: 10_000,
});

const POSTGRES_WORKER_LEASE_LOCK_PARTS = postgresAdvisoryLockParts(POSTGRES_WORKER_LEASE_LOCK_KEY);

type WatchSubscriber = {
  id: number;
  collection: IndexerCollection;
  ids: Set<string>;
  queue: LatestDocumentWatchQueue;
  notify: (() => void) | null;
};

const sqlNumericField = (field: string, invalidValue: '0' | 'null' = 'null'): string | null => {
  const nativeExpression = sqlNativeNumericField(field);
  if (nativeExpression) return nativeExpression;
  if (!NUMERIC_ORDER_FIELDS.has(field)) return null;

  return `(case when jsonb_typeof(data->'${field}') in ('number', 'string') and nullif(${sqlJsonField(field)}, '') ~ '${NUMERIC_TEXT_PATTERN}' then (${sqlJsonField(field)})::numeric else ${invalidValue} end)`;
};

const assertValidNumericFilterValue = (field: string, value: unknown): void => {
  if (field === 'timestamp' || field === 'blockHeight') {
    try {
      assertValidNativePositionQueryValue(field, value);
      return;
    } catch {
      throw new Error(`Invalid numeric filter value for ${field}`);
    }
  }
  try {
    assertValidIndexedDecimal(value, field);
  } catch {
    throw new Error(`Invalid numeric filter value for ${field}`);
  }
};

const dedupeDocuments = (documents: IndexerDocument[]): IndexerDocument[] => {
  const byPrimaryKey = new Map<string, IndexerDocument>();

  for (const document of documents) {
    const key = `${document.collection}\0${document.id}`;
    const previous = byPrimaryKey.get(key);
    const previousHeight = previous?.blockHeight ?? null;
    const nextHeight = document.blockHeight ?? null;

    if (previous && previousHeight !== null && (nextHeight === null || nextHeight < previousHeight)) continue;
    byPrimaryKey.set(key, document);
  }

  return [...byPrimaryKey.values()];
};

const isNullishFilterValue = (value: unknown): boolean => value === null || value === undefined || value === 'null';
const stringArrayFilterValues = (value: unknown): string[] | null => {
  if (!Array.isArray(value)) return null;

  return value.filter((item) => !isNullishFilterValue(item)).map(String);
};

const scalarCondition = (
  field: string,
  comparison: Record<string, unknown>,
  values: unknown[],
  joins: 'and' | 'or' = 'and'
): string => {
  const clauses = Object.entries(comparison).map(([operator, expected]) => {
    if (isNullishFilterValue(expected)) return 'true';

    const expression = sqlJsonField(field);
    const nativeNumericExpression = sqlNativeNumericField(field);
    const numericExpression = sqlNumericField(field, 'null');

    switch (operator) {
      case 'equalTo':
      case 'eq':
        if (nativeNumericExpression || numericExpression) assertValidNumericFilterValue(field, expected);
        values.push(String(expected));
        if (nativeNumericExpression) return `${nativeNumericExpression} = $${values.length}::bigint`;
        if (numericExpression) return `${numericExpression} = ($${values.length})::numeric`;
        return `${expression} = $${values.length}`;
      case 'equalToInsensitive':
        values.push(String(expected).toLowerCase());
        return `lower(${expression}) = $${values.length}`;
      case 'notEqualTo':
      case 'not_eq':
        if (nativeNumericExpression || numericExpression) assertValidNumericFilterValue(field, expected);
        values.push(String(expected));
        if (nativeNumericExpression) return `${nativeNumericExpression} <> $${values.length}::bigint`;
        if (numericExpression) return `${numericExpression} <> ($${values.length})::numeric`;
        return `${expression} <> $${values.length}`;
      case 'in':
        {
          const expectedValues = stringArrayFilterValues(expected);
          if (expectedValues === null) return 'false';
          if (expectedValues.length === 0) return 'false';
          if (nativeNumericExpression || numericExpression) {
            for (const value of expectedValues) assertValidNumericFilterValue(field, value);
          }
          values.push(expectedValues);
        }
        if (nativeNumericExpression) return `${nativeNumericExpression} = any($${values.length}::bigint[])`;
        if (numericExpression) return `${numericExpression} = any($${values.length}::numeric[])`;
        return `${expression} = any($${values.length}::text[])`;
      case 'notIn':
      case 'not_in':
        {
          const expectedValues = stringArrayFilterValues(expected);
          if (expectedValues === null) return 'false';
          if (expectedValues.length === 0) return 'true';
          if (nativeNumericExpression || numericExpression) {
            for (const value of expectedValues) assertValidNumericFilterValue(field, value);
          }
          values.push(expectedValues);
        }
        if (nativeNumericExpression) {
          return `(${nativeNumericExpression} is null or not (${nativeNumericExpression} = any($${values.length}::bigint[])))`;
        }
        if (numericExpression) {
          return `(${numericExpression} is null or not (${numericExpression} = any($${values.length}::numeric[])))`;
        }
        return `(${expression} is null or not (${expression} = any($${values.length}::text[])))`;
      case 'greaterThan':
      case 'gt':
        assertValidNumericFilterValue(field, expected);
        values.push(String(expected));
        if (nativeNumericExpression) return `${nativeNumericExpression} > $${values.length}::bigint`;
        if (numericExpression) return `${numericExpression} > ($${values.length})::numeric`;
        return `(${expression})::numeric > ($${values.length})::numeric`;
      case 'greaterThanOrEqualTo':
      case 'gte':
        assertValidNumericFilterValue(field, expected);
        values.push(String(expected));
        if (nativeNumericExpression) return `${nativeNumericExpression} >= $${values.length}::bigint`;
        if (numericExpression) return `${numericExpression} >= ($${values.length})::numeric`;
        return `(${expression})::numeric >= ($${values.length})::numeric`;
      case 'lessThan':
      case 'lt':
        assertValidNumericFilterValue(field, expected);
        values.push(String(expected));
        if (nativeNumericExpression) return `${nativeNumericExpression} < $${values.length}::bigint`;
        if (numericExpression) return `${numericExpression} < ($${values.length})::numeric`;
        return `(${expression})::numeric < ($${values.length})::numeric`;
      case 'lessThanOrEqualTo':
      case 'lte':
        assertValidNumericFilterValue(field, expected);
        values.push(String(expected));
        if (nativeNumericExpression) return `${nativeNumericExpression} <= $${values.length}::bigint`;
        if (numericExpression) return `${numericExpression} <= ($${values.length})::numeric`;
        return `(${expression})::numeric <= ($${values.length})::numeric`;
      case 'includesInsensitive':
        values.push(`%${String(expected).toLowerCase()}%`);
        return `lower(${expression}) like $${values.length}`;
      case 'contains':
        if (field === 'data' && isFilterObject(expected)) {
          const entries = Object.entries(expected);
          if (
            entries.length === 1 &&
            (entries[0]![0] === 'assetId' || entries[0]![0] === 'to') &&
            typeof entries[0]![1] === 'string'
          ) {
            values.push(entries[0]![1]);
            return `data->'data'->>'${entries[0]![0]}' = $${values.length}`;
          }
        }
        if (expected && typeof expected === 'object') {
          values.push(JSON.stringify(expected));
          return `${sqlJsonValue(field)} @> $${values.length}::jsonb`;
        }

        values.push(JSON.stringify([expected]));
        return `${sqlJsonValue(field)} @> $${values.length}::jsonb`;
      default:
        return 'false';
    }
  });

  return clauses.length ? clauses.join(` ${joins} `) : 'true';
};

const filterCondition = (filter: Record<string, unknown> | null | undefined, values: unknown[]): string => {
  if (!filter || !Object.keys(filter).length) return 'true';

  const clauses = Object.entries(filter).map(([field, condition]) => {
    if (field === 'and') {
      if (!Array.isArray(condition)) return 'false';
      const items = condition.filter(isFilterObject);
      if (items.length !== condition.length) return 'false';
      return `(${items.map((item) => filterCondition(item as Record<string, unknown>, values)).join(' and ') || 'true'})`;
    }

    if (field === 'or') {
      if (!Array.isArray(condition)) return 'false';
      const items = condition.filter(isFilterObject);
      if (items.length !== condition.length) return 'false';
      return `(${items.map((item) => filterCondition(item as Record<string, unknown>, values)).join(' or ') || 'false'})`;
    }

    if (condition && isFilterObject(condition)) {
      return `(${scalarCondition(field, condition as Record<string, unknown>, values)})`;
    }

    values.push(String(condition));
    const nativeNumericExpression = sqlNativeNumericField(field);
    const numericExpression = sqlNumericField(field, 'null');
    if (nativeNumericExpression || numericExpression) assertValidNumericFilterValue(field, condition);
    if (nativeNumericExpression) return `${nativeNumericExpression} = $${values.length}::bigint`;
    if (numericExpression) return `${numericExpression} = ($${values.length})::numeric`;

    return `${sqlJsonField(field)} = $${values.length}`;
  });

  return clauses.join(' and ');
};

const seekCondition = (seek: RepositoryQueryArgs['seek'], values: unknown[]): string => {
  if (!seek) return 'true';

  const expression = sqlNativeNumericField(seek.field);
  if (!expression) throw new Error(`Unsupported seek field in repository query: ${seek.field}`);

  const direction = seek.direction ?? 'asc';
  const comparison = direction === 'desc' ? '<' : '>';
  values.push(String(seek.value));
  const valueIndex = values.length;
  values.push(seek.id);
  const idIndex = values.length;

  return `(${expression} ${comparison} $${valueIndex}::bigint or (${expression} = $${valueIndex}::bigint and id collate "C" ${comparison} $${idIndex}))`;
};

const sqlOrderExpression = (field: string): string =>
  field === 'id'
    ? 'id collate "C"'
    : field === 'timestamp'
      ? 'timestamp'
      : field === 'blockHeight'
        ? 'block_height'
        : NUMERIC_ORDER_FIELDS.has(field)
          ? sqlNumericField(field) ?? sqlJsonField(field)
          : `${sqlJsonField(field)} collate "C"`;

const isNumericOrderField = (field: string): boolean =>
  sqlNativeNumericField(field) !== null || NUMERIC_ORDER_FIELDS.has(field);

/** Builds the strict after-boundary used by an opaque GraphQL cursor. */
const keysetCondition = (
  keyset: RepositoryKeyset | null,
  field: string,
  direction: 'asc' | 'desc',
  orderExpression: string,
  values: unknown[]
): string => {
  if (!keyset) return 'true';

  const numeric = isNumericOrderField(field);
  if (keyset.field !== field || keyset.direction !== direction || keyset.numeric !== numeric) {
    throw new Error('Pagination cursor does not match the requested order');
  }

  const comparison = direction === 'desc' ? '<' : '>';
  if (field === 'id') {
    values.push(keyset.id);
    return `${orderExpression} ${comparison} $${values.length}`;
  }

  if (keyset.value === null) {
    values.push(keyset.id);
    const idIndex = values.length;

    return direction === 'desc'
      ? `(${orderExpression} is not null or (${orderExpression} is null and id collate "C" < $${idIndex}))`
      : `(${orderExpression} is null and id collate "C" > $${idIndex})`;
  }

  if (numeric && !/^-?[0-9]+(\.[0-9]+)?$/.test(keyset.value)) {
    throw new Error('Pagination cursor contains an invalid numeric value');
  }

  values.push(keyset.value);
  const valueIndex = values.length;
  values.push(keyset.id);
  const idIndex = values.length;
  const valueCast = numeric ? (sqlNativeNumericField(field) ? '::bigint' : '::numeric') : '';
  const laterNulls = direction === 'asc' ? ` or ${orderExpression} is null` : '';

  return `(${orderExpression} ${comparison} $${valueIndex}${valueCast}${laterNulls} or (${orderExpression} = $${valueIndex}${valueCast} and id collate "C" ${comparison} $${idIndex}))`;
};

type QueryRow = IndexerDocument & { __cursorValue?: unknown };

const decodeQueryRow = (row: Record<string, unknown>): QueryRow => ({
  ...decodePostgresDocument(row as Parameters<typeof decodePostgresDocument>[0]),
  ...(Object.prototype.hasOwnProperty.call(row, '__cursorValue')
    ? { __cursorValue: row.__cursorValue }
    : {}),
});

const cursorValueForRow = (row: QueryRow, field: string, numeric: boolean): string | null => {
  if (Object.prototype.hasOwnProperty.call(row, '__cursorValue')) {
    return normalizeRepositoryCursorValue(row.__cursorValue, numeric);
  }

  const value =
    field === 'id'
      ? row.id
      : field === 'timestamp'
        ? row.timestamp ?? row.data.timestamp
        : field === 'blockHeight'
          ? row.blockHeight ?? row.data.blockHeight
          : row.data[field];

  return normalizeRepositoryCursorValue(value, numeric);
};

const documentFromQueryRow = (row: QueryRow): IndexerDocument => {
  if (!Object.prototype.hasOwnProperty.call(row, '__cursorValue')) return row;

  const { __cursorValue: _cursorValue, ...document } = row;
  return document;
};

export class PostgresRepository implements IndexerRepository {
  private readonly pool: pg.Pool;
  private readonly listenPool: pg.Pool;
  private readonly workerFencingToken: string | null;
  private readonly watchQueueMax: number;
  private readonly watchReconnectMinDelayMs: number;
  private readonly watchReconnectMaxDelayMs: number;
  private readonly watchSubscribers = new Map<number, WatchSubscriber>();
  private readonly watchPendingIds = new Map<IndexerCollection, Map<string, RepositoryWatchMutation>>();
  private nextWatchSubscriberId = 1;
  private watchFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private watchFlushing = false;
  private watchListenClient: pg.PoolClient | null = null;
  private watchListenReady: Promise<void> | null = null;
  private watchNotificationListener: ((message: pg.Notification) => void) | null = null;
  private watchErrorListener: ((error: Error) => void) | null = null;
  private watchEndListener: (() => void) | null = null;
  private watchReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchReconnectAttempt = 0;
  private watchListenerGeneration = 0;
  private watchClosed = false;
  private closePromise: Promise<void> | null = null;
  private watchReconnects = 0;
  private watchQueueDrops = 0;
  private watchResyncs = 0;
  private queryPoolErrors = 0;
  private listenPoolErrors = 0;

  constructor(input: string | PostgresRuntimeConfig, options: PostgresRepositoryOptions = {}) {
    const config = typeof input === 'string' ? defaultPostgresRuntimeConfig(input) : input;
    if (options.workerFencingToken !== null && options.workerFencingToken !== undefined) {
      assertPostgresWorkerFencingToken(options.workerFencingToken);
    }
    this.workerFencingToken = options.workerFencingToken ?? null;
    const baseConfig = {
      connectionString: config.databaseUrl,
      connectionTimeoutMillis: config.postgresConnectionTimeoutMs,
      query_timeout: config.postgresQueryTimeoutMs,
      statement_timeout: config.postgresStatementTimeoutMs,
      options: POSTGRES_TRUSTED_SESSION_OPTIONS,
    };

    this.pool = new Pool({
      ...baseConfig,
      max: config.postgresPoolMax,
    });
    this.listenPool = new Pool({
      ...baseConfig,
      // One shared LISTEN client serves every subscription; keep a second slot
      // only for reconnect overlap rather than reserving a full query pool.
      max: config.postgresListenPoolMax,
    });
    this.pool.on('error', () => {
      this.queryPoolErrors += 1;
      metrics.increment('indexer_postgres_pool_errors_total', { pool: 'query' });
    });
    this.listenPool.on('error', () => {
      this.listenPoolErrors += 1;
      metrics.increment('indexer_postgres_pool_errors_total', { pool: 'listen' });
    });
    this.watchQueueMax = config.postgresWatchQueueMax;
    this.watchReconnectMinDelayMs = config.postgresWatchReconnectMinDelayMs;
    this.watchReconnectMaxDelayMs = config.postgresWatchReconnectMaxDelayMs;
  }

  async list(collection: IndexerCollection): Promise<IndexerDocument[]> {
    assertValidIndexerCollection(collection);
    return this.recordOperation('list', collection, async () => {
      const result = await this.pool.query(
        `select collection, id, block_height as "blockHeight", timestamp, data
         from indexer_documents
         where collection = $1`,
        [collection]
      );

      return result.rows.map((row) => decodePostgresDocument(row));
    });
  }

  async query(collection: IndexerCollection, args: RepositoryQueryArgs): Promise<RepositoryQueryResult> {
    assertValidIndexerCollection(collection);
    assertValidRepositoryQueryPositions(args);
    return this.recordOperation('query', collection, async () => {
      const countValues: unknown[] = [collection];
      const where = `(${filterCondition(args.filter, countValues)}) and (${seekCondition(args.seek, countValues)})`;
      const { field, direction } = getOrderField(args.orderBy);
      const orderExpression = sqlOrderExpression(field);
      const keyset = args.offset === null || args.offset === undefined ? (args.keyset ?? null) : null;
      const offset = args.seek || keyset ? 0 : Math.max(Number(args.offset ?? afterToOffset(args.after)), 0);
      const logicalOffset = offset;
      const first = args.first ?? null;
      const last = args.last ?? null;
      const limit = first === null || first === undefined ? null : Math.max(first, 0);
      const shouldOverfetch = (args.includeTotalCount === false || keyset !== null) && limit !== null;
      const queryLimit = shouldOverfetch ? limit + 1 : limit;
      // Validate and bind every potentially throwing keyset component before
      // dispatching either independent database query.
      const queryValues = [...countValues];
      const keysetWhere = keysetCondition(keyset, field, direction, orderExpression, queryValues);
      queryValues.push(queryLimit);
      const limitIndex = queryValues.length;
      queryValues.push(offset);
      const offsetIndex = queryValues.length;
      const maxBytes = args.maxBytes ?? null;
      if (maxBytes !== null) queryValues.push(maxBytes);
      const maxBytesIndex = maxBytes === null ? null : queryValues.length;
      const countPromise =
        args.includeTotalCount === false
          ? Promise.resolve(null)
          : this.pool.query(
              `select count(*)::int as count
               from indexer_documents
               where collection = $1 and ${where}`,
              countValues
            );
      if (limit === 0 && args.includeTotalCount !== false && !keyset) {
        const countResult = await countPromise;
        const totalCount = countResult?.rows[0]?.count ?? 0;
        return {
          items: [],
          itemCursors: [],
          totalCount,
          pageStart: logicalOffset,
          hasNextPage: logicalOffset < totalCount,
          hasPreviousPage: logicalOffset > 0,
        };
      }
      const selectSql =
        maxBytesIndex === null
          ? `select collection, id, block_height as "blockHeight", timestamp, data,
                    (${orderExpression})::text as "__cursorValue"
               from indexer_documents
              where collection = $1 and ${where} and (${keysetWhere})
              order by ${orderExpression} ${direction}, id collate "C" ${direction}
              limit coalesce($${limitIndex}::int, 2147483647)
             offset $${offsetIndex}::int`
          : `with ordered_ids as materialized (
               select id,
                      (${orderExpression}) as "__orderValue",
                      (${orderExpression})::text as "__cursorValue",
                      (octet_length(data::text) + octet_length(id) + 128)::bigint as "__documentBytes"
                 from indexer_documents
                where collection = $1 and ${where} and (${keysetWhere})
                order by ${orderExpression} ${direction}, id collate "C" ${direction}
                limit coalesce($${limitIndex}::int, 2147483647)
               offset $${offsetIndex}::int
             ), budgeted_ids as materialized (
               select *,
                      sum("__documentBytes") over (
                        order by "__orderValue" ${direction}, id collate "C" ${direction}
                      ) as "__cumulativeBytes",
                      row_number() over (
                        order by "__orderValue" ${direction}, id collate "C" ${direction}
                      ) as "__sourceRow",
                      count(*) over () as "__candidateCount"
                 from ordered_ids
             ), selected_ids as (
               select *
                 from budgeted_ids
                where "__cumulativeBytes" <= $${maxBytesIndex}::bigint or "__sourceRow" = 1
             )
             select document.collection,
                    document.id,
                    document.block_height as "blockHeight",
                    document.timestamp,
                    document.data,
                    selected."__cursorValue",
                    selected."__candidateCount"
               from selected_ids selected
               join indexer_documents document
                 on document.collection = $1 and document.id = selected.id
              order by selected."__sourceRow"`;
      const selectPromise = this.pool.query(selectSql, queryValues);
      const [countResult, result] = await Promise.all([countPromise, selectPromise]);
      const totalCount = countResult?.rows[0]?.count ?? null;
      const candidateCount = Number((result.rows[0] as Record<string, unknown> | undefined)?.__candidateCount ?? result.rows.length);
      const byteLimitReached = maxBytes !== null && candidateCount > result.rows.length;
      const rows = (result.rows as Array<Record<string, unknown>>).map(decodeQueryRow);
      const requestedLimit = limit ?? rows.length;
      const hasOverfetched = shouldOverfetch && rows.length > requestedLimit;
      const windowRows = hasOverfetched ? rows.slice(0, requestedLimit) : rows;
      const pageStartOffset =
        last === null || last === undefined ? 0 : Math.max(windowRows.length - Math.max(last, 0), 0);
      const itemRows =
        last === null || last === undefined
          ? windowRows
          : windowRows.slice(pageStartOffset);
      const pageStart = logicalOffset + pageStartOffset;
      const numeric = isNumericOrderField(field);
      const items = itemRows.map(documentFromQueryRow);
      const cursorScope = createRepositoryCursorScope(collection, args.orderBy, args.filter);
      const itemCursors = itemRows.map((row, index) =>
        encodeRepositoryCursor({
          scope: cursorScope,
          field,
          direction,
          numeric,
          value: cursorValueForRow(row, field, numeric),
          id: row.id,
        })
      );

      return {
        items,
        itemCursors,
        totalCount,
        pageStart,
        hasNextPage:
          byteLimitReached ||
          (keyset !== null || totalCount === null ? hasOverfetched : logicalOffset + windowRows.length < totalCount),
        hasPreviousPage: keyset !== null || pageStart > 0,
      };
    });
  }

  async get(collection: IndexerCollection, id: string): Promise<IndexerDocument | null> {
    assertValidIndexerCollection(collection);
    assertValidDocumentId(id);
    return this.recordOperation('get', collection, async () => {
      const result = await this.pool.query(
        `select collection, id, block_height as "blockHeight", timestamp, data
         from indexer_documents
         where collection = $1 and id = $2
         limit 1`,
        [collection, id]
      );

      return result.rows[0] ? decodePostgresDocument(result.rows[0]) : null;
    });
  }

  async getMany(collection: IndexerCollection, ids: string[]): Promise<Map<string, IndexerDocument>> {
    assertValidIndexerCollection(collection);
    for (const id of ids) assertValidDocumentId(id);
    if (!ids.length) return new Map();

    return this.recordOperation('getMany', collection, async () => {
      const result = await this.pool.query(
        `select collection, id, block_height as "blockHeight", timestamp, data
         from indexer_documents
         where collection = $1 and id = any($2::text[])`,
        [collection, [...new Set(ids)]]
      );

      return new Map(result.rows.map((row) => decodePostgresDocument(row)).map((document) => [document.id, document]));
    });
  }

  async upsert(document: IndexerDocument): Promise<void> {
    const normalized = normalizeIndexerDocument(document);
    await this.recordOperation('upsert', normalized.collection, async () => {
      await this.executeMutation(
        `with upserted as (
           insert into indexer_documents(collection, id, block_height, timestamp, data)
           values ($1, $2, $3, $4, $5)
           on conflict (collection, id)
           do update set
             block_height = excluded.block_height,
             timestamp = excluded.timestamp,
             data = excluded.data,
             updated_at = now()
           where (
             (excluded.block_height is null and indexer_documents.block_height is null)
             or (
               excluded.block_height is not null
               and (indexer_documents.block_height is null or excluded.block_height >= indexer_documents.block_height)
             )
           ) and (
             indexer_documents.block_height is distinct from excluded.block_height
             or indexer_documents.timestamp is distinct from excluded.timestamp
             or indexer_documents.data is distinct from excluded.data
           )
           returning collection, id, (xmax = 0) as inserted
         )
         select pg_notify('indexer_documents', json_build_object(
           'collection', collection,
           'id', id,
           'mutationType', case when inserted then 'INSERT' else 'UPDATE' end
         )::text)
         from upserted`,
        [
          normalized.collection,
          normalized.id,
          normalized.blockHeight ?? null,
          normalized.timestamp ?? null,
          normalized.data,
        ]
      );
    });
  }

  async upsertMany(documents: IndexerDocument[]): Promise<void> {
    if (!documents.length) return;
    const normalized = normalizeIndexerDocumentWriteCall(documents);
    const deduped = dedupeDocuments(normalized);

    await this.recordOperation('upsertMany', 'all', async () => {
      await this.withMutationTransaction(async (client) => {
        for (const batch of iterateIndexerDocumentJsonPayloads(deduped)) {
          await client.query(
            `with input as (
               select collection, id, "blockHeight" as block_height, timestamp, data
               from jsonb_to_recordset($1::jsonb) as documents(
                 collection text,
                 id text,
                 "blockHeight" bigint,
                 timestamp bigint,
                 data jsonb
               )
             ),
             upserted as (
               insert into indexer_documents(collection, id, block_height, timestamp, data)
               select collection, id, block_height, timestamp, data
               from input
               on conflict (collection, id)
               do update set
                 block_height = excluded.block_height,
                 timestamp = excluded.timestamp,
                 data = excluded.data,
                 updated_at = now()
               where (
                 (excluded.block_height is null and indexer_documents.block_height is null)
                 or (
                   excluded.block_height is not null
                   and (indexer_documents.block_height is null or excluded.block_height >= indexer_documents.block_height)
                 )
               ) and (
                 indexer_documents.block_height is distinct from excluded.block_height
                 or indexer_documents.timestamp is distinct from excluded.timestamp
                 or indexer_documents.data is distinct from excluded.data
               )
               returning collection, id, (xmax = 0) as inserted
             )
             select pg_notify('indexer_documents', json_build_object(
               'collection', collection,
               'id', id,
               'mutationType', case when inserted then 'INSERT' else 'UPDATE' end
             )::text)
             from upserted`,
            [batch.json]
          );
        }
      });
    });
  }

  async deleteMany(collection: IndexerCollection, ids: string[]): Promise<void> {
    assertValidIndexerCollection(collection);
    for (const id of ids) assertValidDocumentId(id);
    const uniqueIds = [...new Set(ids)];
    if (!uniqueIds.length) return;

    await this.recordOperation('deleteMany', collection, async () => {
      await this.executeMutation(
        `with deleted as (
           delete from indexer_documents
           where collection = $1 and id = any($2::text[])
           returning collection, id
         )
         select pg_notify('indexer_documents', json_build_object(
           'collection', collection, 'id', id, 'mutationType', 'DELETE'
         )::text)
         from deleted`,
        [collection, uniqueIds]
      );
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.watchClosed = true;
    for (const subscriber of this.watchSubscribers.values()) {
      subscriber.queue.clear();
      subscriber.notify?.();
      subscriber.notify = null;
    }
    this.closePromise = (async () => {
      await this.stopSharedWatchListener();
      await Promise.all([this.pool.end(), this.listenPool.end()]);
    })();
    return this.closePromise;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.recordOperation('healthCheck', 'all', async () => {
        await this.pool.query('select 1');
      });

      return true;
    } catch {
      return false;
    }
  }

  async *watch(
    collection: IndexerCollection,
    ids: string[] = [],
    signal?: AbortSignal
  ): AsyncGenerator<RepositoryWatchEvent, void, unknown> {
    if (this.watchClosed) throw new Error('Cannot watch documents: Postgres repository is closed');
    assertValidIndexerCollection(collection);
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
    const abort = () => {
      subscriber.notify?.();
      subscriber.notify = null;
    };
    signal?.addEventListener('abort', abort, { once: true });

    try {
      await this.ensureSharedWatchListener();

      while (!signal?.aborted && !this.watchClosed) {
        if (!subscriber.queue.length) {
          await this.waitForWatchDocument(subscriber);
        }

        if (signal?.aborted || this.watchClosed) break;

        const event = subscriber.queue.shift();
        if (event) yield { ...event };
      }
    } finally {
      signal?.removeEventListener('abort', abort);
      this.watchSubscribers.delete(subscriber.id);
      subscriber.queue.clear();
      subscriber.notify?.();
      subscriber.notify = null;
      if (!this.watchSubscribers.size) await this.stopSharedWatchListener();
    }
  }

  private async ensureSharedWatchListener(): Promise<void> {
    if (this.watchClosed) throw new Error('Cannot start Postgres listener: repository is closed');
    if (this.watchListenClient) return;
    if (this.watchListenReady) return this.watchListenReady;

    const generation = ++this.watchListenerGeneration;
    const ready = (async () => {
      let client: pg.PoolClient | null = null;
      let notificationListener: ((message: pg.Notification) => void) | null = null;
      let errorListener: ((error: Error) => void) | null = null;
      let endListener: (() => void) | null = null;
      try {
        client = await this.listenPool.connect();
        notificationListener = (message: pg.Notification) => this.handleWatchNotification(message);
        errorListener = (error: Error) => this.handleWatchListenerLoss(client!, error);
        endListener = () => this.handleWatchListenerLoss(client!, new Error('Postgres LISTEN connection ended'));
        client.on('notification', notificationListener);
        client.on('error', errorListener);
        client.on('end', endListener);
        await client.query('listen indexer_documents');
        if (this.watchClosed || !this.watchSubscribers.size || generation !== this.watchListenerGeneration) {
          throw new Error('Postgres LISTEN setup was cancelled');
        }
        this.watchListenClient = client;
        this.watchNotificationListener = notificationListener;
        this.watchErrorListener = errorListener;
        this.watchEndListener = endListener;
      } catch (error) {
        if (client) {
          if (notificationListener) client.off('notification', notificationListener);
          if (errorListener) client.off('error', errorListener);
          if (endListener) client.off('end', endListener);
          client.release(true);
        }
        throw error;
      }
    })();
    this.watchListenReady = ready;
    try {
      await ready;
    } finally {
      if (this.watchListenReady === ready) this.watchListenReady = null;
    }
  }

  private detachWatchClient(client: pg.PoolClient, destroy: boolean): void {
    if (this.watchNotificationListener) client.off('notification', this.watchNotificationListener);
    if (this.watchErrorListener) client.off('error', this.watchErrorListener);
    if (this.watchEndListener) client.off('end', this.watchEndListener);
    this.watchNotificationListener = null;
    this.watchErrorListener = null;
    this.watchEndListener = null;
    if (this.watchListenClient === client) this.watchListenClient = null;
    client.release(destroy);
  }

  private handleWatchListenerLoss(client: pg.PoolClient, _error: Error): void {
    if (client !== this.watchListenClient) return;
    this.detachWatchClient(client, true);
    this.watchListenerGeneration += 1;
    metrics.increment('indexer_postgres_watch_listener_disconnects_total');
    this.scheduleWatchReconnect();
  }

  private scheduleWatchReconnect(): void {
    if (
      this.watchClosed || !this.watchSubscribers.size || this.watchListenClient ||
      this.watchListenReady || this.watchReconnectTimer
    ) return;
    const delay = Math.min(
      this.watchReconnectMaxDelayMs,
      this.watchReconnectMinDelayMs * 2 ** Math.min(this.watchReconnectAttempt, 20)
    );
    this.watchReconnectTimer = setTimeout(() => {
      this.watchReconnectTimer = null;
      void this.reconnectWatchListener();
    }, delay);
    this.watchReconnectTimer.unref();
  }

  private async reconnectWatchListener(): Promise<void> {
    if (this.watchClosed || !this.watchSubscribers.size) return;
    metrics.increment('indexer_postgres_watch_reconnect_attempts_total');
    try {
      await this.ensureSharedWatchListener();
      this.watchReconnectAttempt = 0;
      this.watchReconnects += 1;
      metrics.increment('indexer_postgres_watch_reconnects_total');
      try {
        await this.resyncWatchSubscribers();
      } catch {
        this.watchReconnectAttempt += 1;
        metrics.increment('indexer_postgres_watch_resync_failures_total');
        this.scheduleWatchResyncRetry();
      }
    } catch {
      this.watchReconnectAttempt += 1;
      metrics.increment('indexer_postgres_watch_reconnect_failures_total');
      this.scheduleWatchReconnect();
    }
  }

  private scheduleWatchResyncRetry(): void {
    if (this.watchClosed || !this.watchSubscribers.size || this.watchReconnectTimer) return;
    const delay = Math.min(
      this.watchReconnectMaxDelayMs,
      this.watchReconnectMinDelayMs * 2 ** Math.min(this.watchReconnectAttempt, 20)
    );
    this.watchReconnectTimer = setTimeout(() => {
      this.watchReconnectTimer = null;
      void this.resyncWatchSubscribers().then(
        () => {
          this.watchReconnectAttempt = 0;
        },
        () => {
          this.watchReconnectAttempt += 1;
          metrics.increment('indexer_postgres_watch_resync_failures_total');
          this.scheduleWatchResyncRetry();
        }
      );
    }, delay);
    this.watchReconnectTimer.unref();
  }

  private async resyncWatchSubscribers(): Promise<void> {
    if (this.watchClosed || !this.watchSubscribers.size) return;
    const groups = new Map<IndexerCollection, Set<string>>();
    for (const subscriber of this.watchSubscribers.values()) {
      if (!subscriber.ids.size) continue;
      const ids = groups.get(subscriber.collection) ?? new Set<string>();
      for (const id of subscriber.ids) ids.add(id);
      groups.set(subscriber.collection, ids);
    }
    for (const [collection, ids] of groups) {
      const idList = [...ids];
      for (let offset = 0; offset < idList.length; offset += this.watchQueueMax) {
        const chunk = idList.slice(offset, offset + this.watchQueueMax);
        // Reconnect resync needs only existence, never full JSON payloads.
        const result = await this.pool.query<{ id: string }>(
          `select id
             from indexer_documents
            where collection = $1 and id = any($2::text[])`,
          [collection, chunk]
        );
        const existing = new Set(result.rows.map(({ id }) => id));
        for (const id of chunk) {
          this.deliverWatchEvent({
            collection,
            id,
            mutationType: existing.has(id) ? 'UPDATE' : 'DELETE',
          });
        }
      }
    }
    this.watchResyncs += 1;
    metrics.increment('indexer_postgres_watch_resyncs_total');
  }

  private async stopSharedWatchListener(): Promise<void> {
    this.watchListenerGeneration += 1;
    if (this.watchReconnectTimer) {
      clearTimeout(this.watchReconnectTimer);
      this.watchReconnectTimer = null;
    }
    const ready = this.watchListenReady;
    if (ready) await ready.catch(() => undefined);

    if (this.watchFlushTimer) {
      clearTimeout(this.watchFlushTimer);
      this.watchFlushTimer = null;
    }
    this.watchPendingIds.clear();

    const client = this.watchListenClient;
    if (!client) return;

    await client.query('unlisten indexer_documents').catch(() => undefined);
    this.detachWatchClient(client, false);
  }

  private watchNotificationIsRelevant(collection: IndexerCollection, id: string): boolean {
    for (const subscriber of this.watchSubscribers.values()) {
      if (subscriber.collection !== collection) continue;
      if (!subscriber.ids.size || subscriber.ids.has(id)) return true;
    }
    return false;
  }

  private watchPendingIdCount(): number {
    let count = 0;
    for (const events of this.watchPendingIds.values()) count += events.size;
    return count;
  }

  private handleWatchNotification(message: pg.Notification): void {
    if (this.watchClosed || message.channel !== 'indexer_documents' || !message.payload) return;

    try {
      const payload = JSON.parse(message.payload) as {
        collection?: unknown;
        id?: unknown;
        mutationType?: unknown;
      };
      assertValidIndexerCollection(payload.collection);
      assertValidDocumentId(payload.id);
      if (!this.watchNotificationIsRelevant(payload.collection, payload.id)) return;
      if (
        payload.mutationType !== 'INSERT' &&
        payload.mutationType !== 'UPDATE' &&
        payload.mutationType !== 'DELETE'
      ) {
        throw new Error('Postgres watch notification has an invalid mutation type');
      }
      const mutationType: RepositoryWatchMutation = payload.mutationType;

      const pendingIds =
        this.watchPendingIds.get(payload.collection) ?? new Map<string, RepositoryWatchMutation>();
      if (!pendingIds.has(payload.id) && this.watchPendingIdCount() >= this.watchQueueMax) {
        this.watchQueueDrops += 1;
        metrics.increment('indexer_postgres_watch_pending_drops_total', { collection: payload.collection });
        return;
      }
      pendingIds.delete(payload.id);
      pendingIds.set(payload.id, mutationType);
      this.watchPendingIds.set(payload.collection, pendingIds);
      this.scheduleWatchFlush();
    } catch {
      metrics.increment('indexer_postgres_watch_malformed_notifications_total');
    }
  }

  private scheduleWatchFlush(delay = WATCH_FLUSH_DELAY_MS): void {
    if (this.watchClosed || !this.watchSubscribers.size || this.watchFlushTimer || this.watchFlushing) return;

    this.watchFlushTimer = setTimeout(() => {
      this.watchFlushTimer = null;
      void this.flushWatchNotifications();
    }, delay);
    this.watchFlushTimer.unref();
  }

  private async flushWatchNotifications(): Promise<void> {
    if (this.watchClosed || this.watchFlushing) return;

    this.watchFlushing = true;
    const pendingEntries: Array<
      [IndexerCollection, Array<[string, RepositoryWatchMutation]>]
    > = [...this.watchPendingIds.entries()].map(
      ([collection, events]) => [collection, [...events]]
    );
    this.watchPendingIds.clear();
    try {
      for (const [collection, events] of pendingEntries) {
        for (const [id, mutationType] of events) {
          this.deliverWatchEvent({ collection, id, mutationType });
        }
      }
    } finally {
      this.watchFlushing = false;
      if (this.watchPendingIds.size) {
        this.scheduleWatchFlush(WATCH_FLUSH_DELAY_MS);
      }
    }
  }

  private deliverWatchEvent(event: RepositoryWatchEvent): void {
    if (this.watchClosed) return;
    for (const subscriber of this.watchSubscribers.values()) {
      if (subscriber.collection !== event.collection) continue;
      if (subscriber.ids.size && !subscriber.ids.has(event.id)) continue;

      if (subscriber.queue.push(event)) {
        this.watchQueueDrops += 1;
        metrics.increment('indexer_postgres_watch_queue_drops_total', { collection: event.collection });
      }
      subscriber.notify?.();
      subscriber.notify = null;
    }
  }

  metricsSnapshot(): RepositoryMetricsSnapshot {
    return {
      postgres_query_pool_total: this.pool.totalCount,
      postgres_query_pool_idle: this.pool.idleCount,
      postgres_query_pool_waiting: this.pool.waitingCount,
      postgres_listen_pool_total: this.listenPool.totalCount,
      postgres_listen_pool_idle: this.listenPool.idleCount,
      postgres_listen_pool_waiting: this.listenPool.waitingCount,
      postgres_watch_subscribers: this.watchSubscribers.size,
      postgres_watch_pending_collections: this.watchPendingIds.size,
      postgres_watch_pending_ids: this.watchPendingIdCount(),
      postgres_watch_listener_active: this.watchListenClient ? 1 : 0,
      postgres_watch_reconnects_total: this.watchReconnects,
      postgres_watch_queue_drops_total: this.watchQueueDrops,
      postgres_watch_resyncs_total: this.watchResyncs,
      postgres_query_pool_errors_total: this.queryPoolErrors,
      postgres_listen_pool_errors_total: this.listenPoolErrors,
    };
  }

  private async recordOperation<T>(
    operation: string,
    collectionName: IndexerCollection | 'all',
    run: () => Promise<T>
  ): Promise<T> {
    const startedAt = Date.now();
    const labels = { operation, collection: collectionName };

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

  private async executeMutation(text: string, values: unknown[]): Promise<void> {
    if (!this.workerFencingToken) {
      await this.pool.query(text, values);
      return;
    }

    await this.withMutationTransaction(async (client) => {
      await client.query(text, values);
    });
  }

  private async withMutationTransaction<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let transactionOpen = false;

    try {
      await client.query('begin');
      transactionOpen = true;
      await this.assertWorkerMutationLease(client);
      const result = await run(client);
      await client.query('commit');
      transactionOpen = false;
      return result;
    } catch (error) {
      if (transactionOpen) await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async assertWorkerMutationLease(client: pg.PoolClient): Promise<void> {
    const token = this.workerFencingToken;
    if (!token) return;

    // Shared transaction locks let already-validated mutations finish while an
    // exclusive acquisition/release handoff waits. Validation happens after
    // the lock is granted, so a queued successor's epoch rotation is observed.
    await client.query('select pg_advisory_xact_lock_shared($1::bigint)', [
      POSTGRES_WORKER_MUTATION_FENCE_LOCK_KEY,
    ]);
    const result = await client.query<{
      tokenMatches: boolean;
      leaseHeld: boolean;
    }>(
      `select fence.fencing_token = $1::uuid as "tokenMatches",
              exists (
                select 1
                from pg_catalog.pg_locks held
                where held.locktype = 'advisory'
                  and held.database = (
                    select oid from pg_catalog.pg_database where datname = current_database()
                  )
                  and held.classid = $2::oid
                  and held.objid = $3::oid
                  and held.objsubid = 1
                  and held.pid = fence.lease_backend_pid
                  and held.mode = 'ExclusiveLock'
                  and held.granted
              ) as "leaseHeld"
         from ${POSTGRES_WORKER_LEASE_FENCE_TABLE} fence
        where fence.singleton`,
      [token, POSTGRES_WORKER_LEASE_LOCK_PARTS.classId, POSTGRES_WORKER_LEASE_LOCK_PARTS.objectId]
    );
    const status = result.rows[0];
    if (status?.tokenMatches !== true || status.leaseHeld !== true) {
      throw new Error('PostgreSQL worker mutation rejected because its writer lease is no longer current');
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
}
