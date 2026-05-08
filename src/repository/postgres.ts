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
  if (!isSafeJsonField(field)) {
    throw new Error(`Unsupported JSON field in repository query: ${field}`);
  }

  return `data->>'${field}'`;
};

const NUMERIC_ORDER_FIELDS = new Set([
  'timestamp',
  'blockHeight',
  'updatedAtBlock',
  'createdAtBlock',
  'dexId',
  'orderId',
  'priceChangeDay',
  'volumeDayUSD',
]);

const scalarCondition = (
  field: string,
  comparison: Record<string, unknown>,
  values: unknown[],
  joins: 'and' | 'or' = 'and'
): string => {
  const clauses = Object.entries(comparison).map(([operator, expected]) => {
    const expression = sqlJsonField(field);

    switch (operator) {
      case 'equalTo':
      case 'eq':
        values.push(String(expected));
        return `${expression} = $${values.length}`;
      case 'equalToInsensitive':
        values.push(String(expected).toLowerCase());
        return `lower(${expression}) = $${values.length}`;
      case 'notEqualTo':
      case 'not_eq':
        values.push(String(expected));
        return `${expression} <> $${values.length}`;
      case 'in':
        values.push((Array.isArray(expected) ? expected : []).map(String));
        return `${expression} = any($${values.length}::text[])`;
      case 'greaterThan':
      case 'gt':
        values.push(String(expected));
        return `(${expression})::numeric > ($${values.length})::numeric`;
      case 'greaterThanOrEqualTo':
      case 'gte':
        values.push(String(expected));
        return `(${expression})::numeric >= ($${values.length})::numeric`;
      case 'lessThan':
      case 'lt':
        values.push(String(expected));
        return `(${expression})::numeric < ($${values.length})::numeric`;
      case 'lessThanOrEqualTo':
      case 'lte':
        values.push(String(expected));
        return `(${expression})::numeric <= ($${values.length})::numeric`;
      case 'includesInsensitive':
        values.push(`%${String(expected).toLowerCase()}%`);
        return `lower(${expression}) like $${values.length}`;
      case 'contains':
        values.push(JSON.stringify({ [field]: expected }));
        return `data @> $${values.length}::jsonb`;
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
    return `${sqlJsonField(field)} = $${values.length}`;
  });

  return clauses.join(' and ');
};

export class PostgresRepository implements IndexerRepository {
  private readonly pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl });
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
    const where = filterCondition(args.filter, values);
    const { field, direction } = getOrderField(args.orderBy);
    const orderExpression =
      field === 'id'
        ? 'id'
        : NUMERIC_ORDER_FIELDS.has(field)
          ? `coalesce(nullif(${sqlJsonField(field)}, ''), '0')::numeric`
          : sqlJsonField(field);
    const offset = Math.max(Number(args.offset ?? afterToOffset(args.after)), 0);
    const first = args.first ?? null;
    const last = args.last ?? null;
    const limit = first === null || first === undefined ? null : Math.max(first, 0);
    const countResult = await this.pool.query(
      `select count(*)::int as count
       from indexer_documents
       where collection = $1 and ${where}`,
      values
    );
    const queryValues = [...values];
    queryValues.push(limit);
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
    const items = last === null || last === undefined ? rows : rows.slice(Math.max(rows.length - last, 0));

    return {
      items,
      totalCount: countResult.rows[0]?.count ?? 0,
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

  async upsert(document: IndexerDocument): Promise<void> {
    await this.pool.query(
      `insert into indexer_documents(collection, id, block_height, timestamp, data)
       values ($1, $2, $3, $4, $5)
       on conflict (collection, id)
       do update set
         block_height = excluded.block_height,
         timestamp = excluded.timestamp,
         data = excluded.data,
         updated_at = now()`,
      [document.collection, document.id, document.blockHeight ?? null, document.timestamp ?? null, document.data]
    );
  }

  async upsertMany(documents: IndexerDocument[]): Promise<void> {
    if (!documents.length) return;

    const client = await this.pool.connect();

    try {
      await client.query('begin');
      for (const document of documents) {
        await client.query(
          `insert into indexer_documents(collection, id, block_height, timestamp, data)
           values ($1, $2, $3, $4, $5)
           on conflict (collection, id)
           do update set
             block_height = excluded.block_height,
             timestamp = excluded.timestamp,
             data = excluded.data,
             updated_at = now()`,
          [document.collection, document.id, document.blockHeight ?? null, document.timestamp ?? null, document.data]
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
}
