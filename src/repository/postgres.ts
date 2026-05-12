import pg from 'pg';

import { getOrderField, NUMERIC_ORDER_FIELDS } from '../graphql/order.js';
import { metrics } from '../metrics.js';

import type {
  IndexerCollection,
  IndexerDocument,
  IndexerRepository,
  RepositoryMetricsSnapshot,
  RepositoryQueryArgs,
  RepositoryQueryResult,
} from './types.js';

const { Pool } = pg;

const NUMERIC_TEXT_PATTERN = "^-?[0-9]+(\\.[0-9]+)?$";

const afterToOffset = (after: RepositoryQueryArgs['after']): number => {
  if (after === null || after === undefined || after === '') return 0;

  const parsed = Number(after);
  return Number.isFinite(parsed) ? parsed + 1 : 0;
};

const isSafeJsonField = (field: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(field);

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

const UPSERT_BATCH_SIZE = 1_000;
const WATCH_FLUSH_DELAY_MS = 25;
const WATCH_IDLE_WAKE_INTERVAL_MS = 30_000;

const readPoolMax = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);

  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
};

type WatchSubscriber = {
  id: number;
  collection: IndexerCollection;
  ids: Set<string>;
  queue: IndexerDocument[];
  notify: (() => void) | null;
};

const sqlNumericField = (field: string): string | null => {
  const nativeExpression = sqlNativeNumericField(field);
  if (nativeExpression) return nativeExpression;
  if (!NUMERIC_ORDER_FIELDS.has(field)) return null;

  return `(case when jsonb_typeof(data->'${field}') in ('number', 'string') and nullif(${sqlJsonField(field)}, '') ~ '${NUMERIC_TEXT_PATTERN}' then (${sqlJsonField(field)})::numeric else 0 end)`;
};

const dedupeDocuments = (documents: IndexerDocument[]): IndexerDocument[] => {
  const byPrimaryKey = new Map<string, IndexerDocument>();

  for (const document of documents) {
    byPrimaryKey.set(`${document.collection}\0${document.id}`, document);
  }

  return [...byPrimaryKey.values()];
};

const toDatabasePayload = (documents: IndexerDocument[]): string =>
  JSON.stringify(
    documents.map((document) => ({
      collection: document.collection,
      id: document.id,
      blockHeight: document.blockHeight ?? null,
      timestamp: document.timestamp ?? null,
      data: document.data,
    }))
  );

const isNullishFilterValue = (value: unknown): boolean => value === null || value === undefined || value === 'null';

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
    const numericExpression = sqlNumericField(field);

    switch (operator) {
      case 'equalTo':
      case 'eq':
        values.push(String(expected));
        if (nativeNumericExpression) return `${nativeNumericExpression} = $${values.length}::bigint`;
        return `${expression} = $${values.length}`;
      case 'equalToInsensitive':
        values.push(String(expected).toLowerCase());
        return `lower(${expression}) = $${values.length}`;
      case 'notEqualTo':
      case 'not_eq':
        values.push(String(expected));
        if (nativeNumericExpression) return `${nativeNumericExpression} <> $${values.length}::bigint`;
        return `${expression} <> $${values.length}`;
      case 'in':
        {
          const expectedValues = (Array.isArray(expected) ? expected : [])
            .filter((item) => !isNullishFilterValue(item))
            .map(String);
          if (expectedValues.length === 0) return 'true';
          values.push(expectedValues);
        }
        if (nativeNumericExpression) return `${nativeNumericExpression} = any($${values.length}::bigint[])`;
        return `${expression} = any($${values.length}::text[])`;
      case 'greaterThan':
      case 'gt':
        values.push(String(expected));
        if (nativeNumericExpression) return `${nativeNumericExpression} > $${values.length}::bigint`;
        if (numericExpression) return `${numericExpression} > ($${values.length})::numeric`;
        return `(${expression})::numeric > ($${values.length})::numeric`;
      case 'greaterThanOrEqualTo':
      case 'gte':
        values.push(String(expected));
        if (nativeNumericExpression) return `${nativeNumericExpression} >= $${values.length}::bigint`;
        if (numericExpression) return `${numericExpression} >= ($${values.length})::numeric`;
        return `(${expression})::numeric >= ($${values.length})::numeric`;
      case 'lessThan':
      case 'lt':
        values.push(String(expected));
        if (nativeNumericExpression) return `${nativeNumericExpression} < $${values.length}::bigint`;
        if (numericExpression) return `${numericExpression} < ($${values.length})::numeric`;
        return `(${expression})::numeric < ($${values.length})::numeric`;
      case 'lessThanOrEqualTo':
      case 'lte':
        values.push(String(expected));
        if (nativeNumericExpression) return `${nativeNumericExpression} <= $${values.length}::bigint`;
        if (numericExpression) return `${numericExpression} <= ($${values.length})::numeric`;
        return `(${expression})::numeric <= ($${values.length})::numeric`;
      case 'includesInsensitive':
        values.push(`%${String(expected).toLowerCase()}%`);
        return `lower(${expression}) like $${values.length}`;
      case 'contains':
        if (expected && typeof expected === 'object') {
          values.push(JSON.stringify(expected));
          return `${sqlJsonValue(field)} @> $${values.length}::jsonb`;
        }

        values.push(JSON.stringify([expected]));
        const arrayIndex = values.length;
        values.push(JSON.stringify({ [field]: expected }));
        const objectIndex = values.length;
        return `(${sqlJsonValue(field)} @> $${arrayIndex}::jsonb or data @> $${objectIndex}::jsonb)`;
      default:
        return 'true';
    }
  });

  return clauses.length ? clauses.join(` ${joins} `) : 'true';
};

const filterCondition = (filter: Record<string, unknown> | null | undefined, values: unknown[]): string => {
  if (!filter || !Object.keys(filter).length) return 'true';

  const clauses = Object.entries(filter).map(([field, condition]) => {
    if (field === 'and') {
      const items = Array.isArray(condition) ? condition : [];
      return `(${items.map((item) => filterCondition(item as Record<string, unknown>, values)).join(' and ') || 'true'})`;
    }

    if (field === 'or') {
      const items = Array.isArray(condition) ? condition : [];
      return `(${items.map((item) => filterCondition(item as Record<string, unknown>, values)).join(' or ') || 'false'})`;
    }

    if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
      return `(${scalarCondition(field, condition as Record<string, unknown>, values)})`;
    }

    values.push(String(condition));
    const nativeNumericExpression = sqlNativeNumericField(field);
    if (nativeNumericExpression) return `${nativeNumericExpression} = $${values.length}::bigint`;

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

  return `(${expression} ${comparison} $${valueIndex}::bigint or (${expression} = $${valueIndex}::bigint and id ${comparison} $${idIndex}))`;
};

export class PostgresRepository implements IndexerRepository {
  private readonly pool: pg.Pool;
  private readonly listenPool: pg.Pool;
  private readonly watchQueueMax: number;
  private readonly watchSubscribers = new Map<number, WatchSubscriber>();
  private readonly watchPendingIds = new Map<IndexerCollection, Set<string>>();
  private nextWatchSubscriberId = 1;
  private watchFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private watchFlushing = false;
  private watchListenClient: pg.PoolClient | null = null;
  private watchListenReady: Promise<void> | null = null;
  private watchNotificationListener: ((message: pg.Notification) => void) | null = null;
  private watchErrorListener: ((error: Error) => void) | null = null;

  constructor(databaseUrl: string) {
    const baseConfig = {
      connectionString: databaseUrl,
      connectionTimeoutMillis: 10_000,
      query_timeout: 30_000,
      statement_timeout: 30_000,
    };

    this.pool = new Pool({
      ...baseConfig,
      max: readPoolMax('POSTGRES_POOL_MAX', 20),
    });
    this.listenPool = new Pool({
      ...baseConfig,
      max: readPoolMax('POSTGRES_LISTEN_POOL_MAX', 20),
    });
    this.watchQueueMax = readPoolMax('POSTGRES_WATCH_QUEUE_MAX', 1_000);
  }

  async list(collection: IndexerCollection): Promise<IndexerDocument[]> {
    return this.recordOperation('list', collection, async () => {
      const result = await this.pool.query(
        `select collection, id, block_height as "blockHeight", timestamp, data
         from indexer_documents
         where collection = $1`,
        [collection]
      );

      return result.rows;
    });
  }

  async query(collection: IndexerCollection, args: RepositoryQueryArgs): Promise<RepositoryQueryResult> {
    return this.recordOperation('query', collection, async () => {
      const values: unknown[] = [collection];
      const where = `(${filterCondition(args.filter, values)}) and (${seekCondition(args.seek, values)})`;
      const { field, direction } = getOrderField(args.orderBy);
      const orderExpression =
        field === 'id'
          ? 'id'
          : field === 'timestamp'
            ? 'timestamp'
          : field === 'blockHeight'
              ? 'block_height'
          : NUMERIC_ORDER_FIELDS.has(field)
            ? sqlNumericField(field) ?? sqlJsonField(field)
            : sqlJsonField(field);
      const offset = args.seek ? 0 : Math.max(Number(args.offset ?? afterToOffset(args.after)), 0);
      const first = args.first ?? null;
      const last = args.last ?? null;
      const limit = first === null || first === undefined ? null : Math.max(first, 0);
      const shouldOverfetch = args.includeTotalCount === false && limit !== null;
      const queryLimit = shouldOverfetch ? limit + 1 : limit;
      const countResult =
        args.includeTotalCount === false
          ? null
          : await this.pool.query(
              `select count(*)::int as count
               from indexer_documents
               where collection = $1 and ${where}`,
              values
            );
      const totalCount = countResult?.rows[0]?.count ?? null;
      if (limit === 0 && countResult) {
        return {
          items: [],
          totalCount,
          pageStart: offset,
          hasNextPage: offset < totalCount,
          hasPreviousPage: offset > 0,
        };
      }

      const queryValues = [...values];
      queryValues.push(queryLimit);
      const limitIndex = queryValues.length;
      queryValues.push(offset);
      const offsetIndex = queryValues.length;
      const result = await this.pool.query(
        `select collection, id, block_height as "blockHeight", timestamp, data
         from indexer_documents
         where collection = $1 and ${where}
         order by ${orderExpression} ${direction}, id ${direction}
         limit coalesce($${limitIndex}::int, 2147483647)
         offset $${offsetIndex}::int`,
        queryValues
      );
      const rows = result.rows as IndexerDocument[];
      const requestedLimit = limit ?? rows.length;
      const hasOverfetched = shouldOverfetch && rows.length > requestedLimit;
      const windowRows = hasOverfetched ? rows.slice(0, requestedLimit) : rows;
      const pageStartOffset =
        last === null || last === undefined ? 0 : Math.max(windowRows.length - Math.max(last, 0), 0);
      const items =
        last === null || last === undefined
          ? windowRows
          : windowRows.slice(pageStartOffset);
      const pageStart = offset + pageStartOffset;

      return {
        items,
        totalCount,
        pageStart,
        hasNextPage: totalCount === null ? hasOverfetched : offset + windowRows.length < totalCount,
        hasPreviousPage: pageStart > 0,
      };
    });
  }

  async get(collection: IndexerCollection, id: string): Promise<IndexerDocument | null> {
    return this.recordOperation('get', collection, async () => {
      const result = await this.pool.query(
        `select collection, id, block_height as "blockHeight", timestamp, data
         from indexer_documents
         where collection = $1 and id = $2
         limit 1`,
        [collection, id]
      );

      return result.rows[0] ?? null;
    });
  }

  async getMany(collection: IndexerCollection, ids: string[]): Promise<Map<string, IndexerDocument>> {
    if (!ids.length) return new Map();

    return this.recordOperation('getMany', collection, async () => {
      const result = await this.pool.query(
        `select collection, id, block_height as "blockHeight", timestamp, data
         from indexer_documents
         where collection = $1 and id = any($2::text[])`,
        [collection, [...new Set(ids)]]
      );

      return new Map((result.rows as IndexerDocument[]).map((document) => [document.id, document]));
    });
  }

  async upsert(document: IndexerDocument): Promise<void> {
    await this.recordOperation('upsert', document.collection, async () => {
      await this.pool.query(
        `with upserted as (
           insert into indexer_documents(collection, id, block_height, timestamp, data)
           values ($1, $2, $3, $4, $5)
           on conflict (collection, id)
           do update set
             block_height = excluded.block_height,
             timestamp = excluded.timestamp,
             data = excluded.data,
             updated_at = now()
           where indexer_documents.block_height is distinct from excluded.block_height
              or indexer_documents.timestamp is distinct from excluded.timestamp
              or indexer_documents.data is distinct from excluded.data
           returning collection, id
         )
         select pg_notify('indexer_documents', json_build_object('collection', collection, 'id', id)::text)
         from upserted`,
        [document.collection, document.id, document.blockHeight ?? null, document.timestamp ?? null, document.data]
      );
    });
  }

  async upsertMany(documents: IndexerDocument[]): Promise<void> {
    if (!documents.length) return;

    await this.recordOperation('upsertMany', 'all', async () => {
      const uniqueDocuments = dedupeDocuments(documents);
      const client = await this.pool.connect();

      try {
        await client.query('begin');
        for (let start = 0; start < uniqueDocuments.length; start += UPSERT_BATCH_SIZE) {
          const batch = uniqueDocuments.slice(start, start + UPSERT_BATCH_SIZE);

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
               where indexer_documents.block_height is distinct from excluded.block_height
                  or indexer_documents.timestamp is distinct from excluded.timestamp
                  or indexer_documents.data is distinct from excluded.data
               returning collection, id
             )
             select pg_notify('indexer_documents', json_build_object('collection', collection, 'id', id)::text)
             from upserted`,
            [toDatabasePayload(batch)]
          );
        }
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    });
  }

  async close(): Promise<void> {
    await this.stopSharedWatchListener();
    await Promise.all([this.pool.end(), this.listenPool.end()]);
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

  async *watch(collection: IndexerCollection, ids: string[] = []): AsyncGenerator<IndexerDocument, void, unknown> {
    const subscriber: WatchSubscriber = {
      id: this.nextWatchSubscriberId++,
      collection,
      ids: new Set(ids),
      queue: [],
      notify: null,
    };

    this.watchSubscribers.set(subscriber.id, subscriber);

    try {
      await this.ensureSharedWatchListener();

      while (true) {
        if (!subscriber.queue.length) {
          await this.waitForWatchDocument(subscriber);
        }

        const document = subscriber.queue.shift();
        if (document) yield document;
      }
    } finally {
      this.watchSubscribers.delete(subscriber.id);
      subscriber.notify?.();
      subscriber.notify = null;
      if (!this.watchSubscribers.size) await this.stopSharedWatchListener();
    }
  }

  private async ensureSharedWatchListener(): Promise<void> {
    if (this.watchListenReady) return this.watchListenReady;

    this.watchListenReady = (async () => {
      const client = await this.listenPool.connect();
      const notificationListener = (message: pg.Notification) => this.handleWatchNotification(message);
      const errorListener = () => {
        void this.stopSharedWatchListener();
      };

      client.on('notification', notificationListener);
      client.on('error', errorListener);
      await client.query('listen indexer_documents');

      this.watchListenClient = client;
      this.watchNotificationListener = notificationListener;
      this.watchErrorListener = errorListener;
    })().catch((error) => {
      this.watchListenReady = null;
      throw error;
    });

    return this.watchListenReady;
  }

  private async stopSharedWatchListener(): Promise<void> {
    const ready = this.watchListenReady;
    this.watchListenReady = null;

    if (ready) await ready.catch(() => undefined);

    if (this.watchFlushTimer) {
      clearTimeout(this.watchFlushTimer);
      this.watchFlushTimer = null;
    }
    this.watchPendingIds.clear();

    const client = this.watchListenClient;
    if (!client) return;

    this.watchListenClient = null;
    if (this.watchNotificationListener) client.off('notification', this.watchNotificationListener);
    if (this.watchErrorListener) client.off('error', this.watchErrorListener);
    this.watchNotificationListener = null;
    this.watchErrorListener = null;

    await client.query('unlisten indexer_documents').catch(() => undefined);
    client.release();
  }

  private handleWatchNotification(message: pg.Notification): void {
    if (message.channel !== 'indexer_documents' || !message.payload) return;

    try {
      const payload = JSON.parse(message.payload) as { collection?: IndexerCollection; id?: string };
      if (!payload.collection || !payload.id) return;

      const pendingIds = this.watchPendingIds.get(payload.collection) ?? new Set<string>();
      pendingIds.add(payload.id);
      this.watchPendingIds.set(payload.collection, pendingIds);
      this.scheduleWatchFlush();
    } catch {
      // Ignore malformed notifications; the backing table remains authoritative.
    }
  }

  private scheduleWatchFlush(): void {
    if (this.watchFlushTimer || this.watchFlushing) return;

    this.watchFlushTimer = setTimeout(() => {
      this.watchFlushTimer = null;
      void this.flushWatchNotifications();
    }, WATCH_FLUSH_DELAY_MS);
  }

  private async flushWatchNotifications(): Promise<void> {
    if (this.watchFlushing) return;

    this.watchFlushing = true;
    try {
      while (this.watchPendingIds.size) {
        const pendingEntries: Array<[IndexerCollection, string[]]> = [...this.watchPendingIds.entries()].map(
          ([collection, ids]) => [collection, [...ids]]
        );
        this.watchPendingIds.clear();

        await Promise.all(
          pendingEntries.map(async ([collection, ids]) => {
            const documents = await this.getMany(collection, ids);
            for (const id of ids) {
              const document = documents.get(id);
              if (document) this.deliverWatchDocument(document);
            }
          })
        );
      }
    } catch {
      // Notifications are best-effort; the backing table remains authoritative.
    } finally {
      this.watchFlushing = false;
      if (this.watchPendingIds.size) this.scheduleWatchFlush();
    }
  }

  private deliverWatchDocument(document: IndexerDocument): void {
    for (const subscriber of this.watchSubscribers.values()) {
      if (subscriber.collection !== document.collection) continue;
      if (subscriber.ids.size && !subscriber.ids.has(document.id)) continue;

      if (subscriber.queue.length >= this.watchQueueMax) subscriber.queue.shift();
      subscriber.queue.push(document);
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
      postgres_watch_listener_active: this.watchListenClient ? 1 : 0,
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
