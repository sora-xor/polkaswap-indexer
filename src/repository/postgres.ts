import pg from 'pg';

import type {
  IndexerCollection,
  IndexerDocument,
  IndexerRepository,
  RepositoryQueryArgs,
  RepositoryQueryResult,
} from './types.js';

const { Pool } = pg;

const afterToOffset = (after: RepositoryQueryArgs['after']): number => {
  if (after === null || after === undefined || after === '') return 0;

  const parsed = Number(after);
  return Number.isFinite(parsed) ? parsed + 1 : 0;
};

const getOrderField = (orderBy: unknown): { field: string; direction: 'asc' | 'desc' } => {
  const first = Array.isArray(orderBy) ? orderBy[0] : orderBy;
  const token = String(first ?? 'ID_ASC');
  const direction = token.endsWith('_DESC') ? 'desc' : 'asc';
  const rawField = token.replace(/_(ASC|DESC)$/, '').toLowerCase();
  const parts = rawField.split('_');
  const field = parts
    .map((part, index) => (index === 0 ? part : `${part.charAt(0).toUpperCase()}${part.slice(1)}`))
    .join('');

  return { field, direction };
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

const sqlJsonValue = (field: string): string => {
  if (!isSafeJsonField(field)) {
    throw new Error(`Unsupported JSON field in repository query: ${field}`);
  }

  return `data->'${field}'`;
};

const NUMERIC_ORDER_FIELDS = new Set([
  'timestamp',
  'blockHeight',
  'updatedAtBlock',
  'createdAtBlock',
  'dexId',
  'orderId',
  'liquidity',
  'liquidityBooks',
  'priceChangeDay',
  'volumeDayUSD',
  'volumeWeekUSD',
  'amount',
]);
const UPSERT_BATCH_SIZE = 1_000;

const sqlNumericField = (field: string): string | null => {
  const nativeExpression = sqlNativeNumericField(field);
  if (nativeExpression) return nativeExpression;
  if (!NUMERIC_ORDER_FIELDS.has(field)) return null;

  return `coalesce(nullif(${sqlJsonField(field)}, ''), '0')::numeric`;
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

const scalarCondition = (
  field: string,
  comparison: Record<string, unknown>,
  values: unknown[],
  joins: 'and' | 'or' = 'and'
): string => {
  const clauses = Object.entries(comparison).map(([operator, expected]) => {
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
        values.push((Array.isArray(expected) ? expected : []).map(String));
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

  constructor(databaseUrl: string) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 5_000,
      query_timeout: 15_000,
      statement_timeout: 15_000,
    });
  }

  async list(collection: IndexerCollection): Promise<IndexerDocument[]> {
    const result = await this.pool.query(
      `select collection, id, block_height as "blockHeight", timestamp, data
       from indexer_documents
       where collection = $1`,
      [collection]
    );

    return result.rows;
  }

  async query(collection: IndexerCollection, args: RepositoryQueryArgs): Promise<RepositoryQueryResult> {
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
  }

  async get(collection: IndexerCollection, id: string): Promise<IndexerDocument | null> {
    const result = await this.pool.query(
      `select collection, id, block_height as "blockHeight", timestamp, data
       from indexer_documents
       where collection = $1 and id = $2
       limit 1`,
      [collection, id]
    );

    return result.rows[0] ?? null;
  }

  async getMany(collection: IndexerCollection, ids: string[]): Promise<Map<string, IndexerDocument>> {
    if (!ids.length) return new Map();

    const result = await this.pool.query(
      `select collection, id, block_height as "blockHeight", timestamp, data
       from indexer_documents
       where collection = $1 and id = any($2::text[])`,
      [collection, [...new Set(ids)]]
    );

    return new Map((result.rows as IndexerDocument[]).map((document) => [document.id, document]));
  }

  async upsert(document: IndexerDocument): Promise<void> {
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
  }

  async upsertMany(documents: IndexerDocument[]): Promise<void> {
    if (!documents.length) return;

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
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async *watch(collection: IndexerCollection, ids: string[] = []): AsyncGenerator<IndexerDocument, void, unknown> {
    const client = await this.pool.connect();
    const queue: IndexerDocument[] = [];
    const pendingIds = new Set<string>();
    let notify: (() => void) | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let flushing = false;
    const idSet = new Set(ids);

    const wake = () => {
      notify?.();
      notify = null;
    };
    const flush = async () => {
      if (flushing) return;

      flushing = true;
      try {
        while (pendingIds.size) {
          const idsToLoad = [...pendingIds];
          pendingIds.clear();
          const documents = await this.getMany(collection, idsToLoad);

          for (const id of idsToLoad) {
            const document = documents.get(id);
            if (document) queue.push(document);
          }

          wake();
        }
      } catch {
        // Notifications are best-effort; the backing table remains authoritative.
      } finally {
        flushing = false;
        if (pendingIds.size) scheduleFlush();
      }
    };
    const scheduleFlush = () => {
      if (flushTimer || flushing) return;

      flushTimer = setTimeout(() => {
        flushTimer = null;
        void flush();
      }, 25);
    };
    const listener = (message: pg.Notification) => {
      if (message.channel !== 'indexer_documents' || !message.payload) return;

      try {
        const payload = JSON.parse(message.payload) as { collection?: IndexerCollection; id?: string };
        if (payload.collection !== collection || !payload.id || (idSet.size && !idSet.has(payload.id))) return;

        pendingIds.add(payload.id);
        scheduleFlush();
      } catch {
        // Ignore malformed notifications; the backing table remains authoritative.
      }
    };

    client.on('notification', listener);
    await client.query('listen indexer_documents');

    try {
      while (true) {
        if (!queue.length) {
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
        }

        const document = queue.shift();
        if (document) yield document;
      }
    } finally {
      if (flushTimer) clearTimeout(flushTimer);
      pendingIds.clear();
      client.off('notification', listener);
      await client.query('unlisten indexer_documents').catch(() => undefined);
      client.release();
    }
  }
}
