import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { IndexerDocument } from '../src/repository/types.js';

const mocks = vi.hoisted(() => {
  const pool = {
    query: vi.fn(),
    connect: vi.fn(),
    end: vi.fn(),
  };
  const Pool = vi.fn(function MockPool() {
    return pool;
  });

  return { Pool, pool };
});

vi.mock('pg', () => ({
  default: {
    Pool: mocks.Pool,
  },
}));

const { PostgresRepository } = await import('../src/repository/postgres.js');

const DATABASE_URL = 'postgres://polkaswap:polkaswap@localhost:5432/polkaswap_indexer';

const assetDocument = (id: string, timestamp = 10): IndexerDocument => ({
  collection: 'assets',
  id,
  blockHeight: timestamp,
  timestamp,
  data: { id, timestamp, liquidity: String(timestamp) },
});

describe('PostgresRepository', () => {
  afterEach(() => {
    mocks.Pool.mockClear();
    mocks.pool.query.mockReset();
    mocks.pool.connect.mockReset();
    mocks.pool.end.mockReset();
    delete process.env.POSTGRES_POOL_MAX;
    delete process.env.POSTGRES_LISTEN_POOL_MAX;
    delete process.env.POSTGRES_CONNECTION_TIMEOUT_MS;
    delete process.env.POSTGRES_QUERY_TIMEOUT_MS;
    delete process.env.POSTGRES_STATEMENT_TIMEOUT_MS;
  });

  it('uses separate pools for regular queries and subscription listeners', () => {
    process.env.POSTGRES_POOL_MAX = '7';
    process.env.POSTGRES_LISTEN_POOL_MAX = '3';
    process.env.POSTGRES_CONNECTION_TIMEOUT_MS = '15000';
    process.env.POSTGRES_QUERY_TIMEOUT_MS = '90000';
    process.env.POSTGRES_STATEMENT_TIMEOUT_MS = '95000';

    new PostgresRepository(DATABASE_URL);

    expect(mocks.Pool).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        connectionString: DATABASE_URL,
        connectionTimeoutMillis: 15_000,
        query_timeout: 90_000,
        statement_timeout: 95_000,
        max: 7,
      })
    );
    expect(mocks.Pool).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        connectionString: DATABASE_URL,
        connectionTimeoutMillis: 15_000,
        query_timeout: 90_000,
        statement_timeout: 95_000,
        max: 3,
      })
    );
  });

  it('checks database readiness without throwing on query failure', async () => {
    const repository = new PostgresRepository(DATABASE_URL);

    mocks.pool.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    await expect(repository.healthCheck()).resolves.toBe(true);

    mocks.pool.query.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(repository.healthCheck()).resolves.toBe(false);
    expect(mocks.pool.query).toHaveBeenNthCalledWith(1, 'select 1');
    expect(mocks.pool.query).toHaveBeenNthCalledWith(2, 'select 1');
  });

  it('shares one Postgres LISTEN client across concurrent watchers', async () => {
    const assetB = assetDocument('asset-b', 20);
    const listenClient = Object.assign(new EventEmitter(), {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    });
    mocks.pool.connect.mockResolvedValueOnce(listenClient);
    mocks.pool.query.mockResolvedValueOnce({ rows: [assetB] });
    const repository = new PostgresRepository(DATABASE_URL);
    const watcherA = repository.watch('assets', ['asset-b']);
    const watcherB = repository.watch('assets', ['asset-b']);
    const nextA = watcherA.next();
    const nextB = watcherB.next();

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(listenClient.query).toHaveBeenCalledWith('listen indexer_documents');

    listenClient.emit('notification', {
      channel: 'indexer_documents',
      payload: JSON.stringify({ collection: 'assets', id: 'asset-b' }),
    });

    await expect(nextA).resolves.toMatchObject({ done: false, value: assetB });
    await expect(nextB).resolves.toMatchObject({ done: false, value: assetB });
    expect(mocks.pool.connect).toHaveBeenCalledTimes(1);
    expect(mocks.pool.query).toHaveBeenCalledTimes(1);
    expect(mocks.pool.query.mock.calls[0]?.[1]).toEqual(['assets', ['asset-b']]);

    await watcherA.return(undefined);
    await watcherB.return(undefined);

    expect(listenClient.query).toHaveBeenCalledWith('unlisten indexer_documents');
    expect(listenClient.release).toHaveBeenCalledOnce();
  });

  it('overfetches one row instead of counting when totalCount is not requested', async () => {
    const rows = [assetDocument('asset-a', 10), assetDocument('asset-b', 20), assetDocument('asset-c', 30)];
    mocks.pool.query.mockResolvedValueOnce({ rows });
    const repository = new PostgresRepository(DATABASE_URL);

    const result = await repository.query('assets', {
      first: 2,
      after: '4',
      orderBy: ['TIMESTAMP_ASC'],
      includeTotalCount: false,
    });

    expect(mocks.Pool).toHaveBeenCalledWith(expect.objectContaining({ connectionString: DATABASE_URL }));
    expect(mocks.pool.query).toHaveBeenCalledTimes(1);
    expect(String(mocks.pool.query.mock.calls[0]?.[0])).toContain('order by timestamp asc, id asc');
    expect(mocks.pool.query.mock.calls[0]?.[1]).toEqual(['assets', 3, 5]);
    expect(result).toEqual({
      items: rows.slice(0, 2),
      totalCount: null,
      pageStart: 5,
      hasNextPage: true,
      hasPreviousPage: true,
    });
  });

  it('answers count-only queries without running a useless select', async () => {
    mocks.pool.query.mockResolvedValueOnce({ rows: [{ count: 42 }] });
    const repository = new PostgresRepository(DATABASE_URL);

    const result = await repository.query('assets', {
      first: 0,
      includeTotalCount: true,
    });

    expect(mocks.pool.query).toHaveBeenCalledTimes(1);
    expect(String(mocks.pool.query.mock.calls[0]?.[0])).toContain('select count(*)::int as count');
    expect(result).toEqual({
      items: [],
      totalCount: 42,
      pageStart: 0,
      hasNextPage: true,
      hasPreviousPage: false,
    });
  });

  it('builds SQL for nested filters, numeric ordering, and seek pagination', async () => {
    const row = {
      collection: 'historyElements',
      id: 'history-8',
      blockHeight: 499,
      timestamp: 123,
      data: { id: 'history-8', updatedAtBlock: 499 },
    } satisfies IndexerDocument;
    mocks.pool.query.mockResolvedValueOnce({ rows: [{ count: 2 }] }).mockResolvedValueOnce({ rows: [row] });
    const repository = new PostgresRepository(DATABASE_URL);

    const result = await repository.query('historyElements', {
      first: 10,
      filter: {
        and: [
          { timestamp: { greaterThanOrEqualTo: 100 } },
          {
            or: [{ dataAssets: { contains: 'xor' } }, { module: { equalToInsensitive: 'Assets' } }],
          },
        ],
      },
      orderBy: ['UPDATED_AT_BLOCK_DESC'],
      seek: { field: 'blockHeight', value: 500, id: 'history-9', direction: 'desc' },
    });

    expect(mocks.pool.query).toHaveBeenCalledTimes(2);
    const [countSql, countValues] = mocks.pool.query.mock.calls[0] ?? [];
    const [selectSql, selectValues] = mocks.pool.query.mock.calls[1] ?? [];
    expect(String(countSql)).toContain('timestamp >= $2::bigint');
    expect(String(countSql)).toContain("(data->'dataAssets' @> $3::jsonb or data @> $4::jsonb)");
    expect(String(countSql)).toContain("lower(data->>'module') = $5");
    expect(String(countSql)).toContain('block_height < $6::bigint');
    expect(countValues).toEqual([
      'historyElements',
      '100',
      '["xor"]',
      '{"dataAssets":"xor"}',
      'assets',
      '500',
      'history-9',
    ]);
    expect(String(selectSql)).toContain("jsonb_typeof(data->'updatedAtBlock') in ('number', 'string')");
    expect(String(selectSql)).toContain("then (data->>'updatedAtBlock')::numeric else 0 end) desc, id desc");
    expect(selectValues).toEqual([...countValues, 10, 0]);
    expect(result).toEqual({
      items: [row],
      totalCount: 2,
      pageStart: 0,
      hasNextPage: true,
      hasPreviousPage: false,
    });
  });

  it('orders USD acronym fields against the stored JSON key', async () => {
    const row = {
      collection: 'poolXYKs',
      id: 'pool-a',
      data: { id: 'pool-a', liquidityUSD: '100' },
    } satisfies IndexerDocument;
    mocks.pool.query.mockResolvedValueOnce({ rows: [row] });
    const repository = new PostgresRepository(DATABASE_URL);

    const result = await repository.query('poolXYKs', {
      first: 1,
      orderBy: ['LIQUIDITY_USD_DESC'],
      includeTotalCount: false,
    });

    expect(mocks.pool.query).toHaveBeenCalledTimes(1);
    expect(String(mocks.pool.query.mock.calls[0]?.[0])).toContain(
      "jsonb_typeof(data->'liquidityUSD') in ('number', 'string')"
    );
    expect(String(mocks.pool.query.mock.calls[0]?.[0])).toContain(
      "then (data->>'liquidityUSD')::numeric else 0 end) desc, id desc"
    );
    expect(result.items).toEqual([row]);
  });

  it('builds SQL for stats page network snapshot filters', async () => {
    const row = {
      collection: 'networkSnapshots',
      id: 'network-day-200',
      timestamp: 200,
      data: { id: 'network-day-200', type: 'DAY', timestamp: 200, liquidityUSD: '250.75', volumeUSD: '45.125' },
    } satisfies IndexerDocument;
    mocks.pool.query.mockResolvedValueOnce({ rows: [row] });
    const repository = new PostgresRepository(DATABASE_URL);

    const result = await repository.query('networkSnapshots', {
      first: 2,
      orderBy: ['TIMESTAMP_DESC'],
      filter: {
        type: { equalTo: 'DAY' },
        timestamp: { lessThanOrEqualTo: 300, greaterThanOrEqualTo: 100 },
      },
      includeTotalCount: false,
    });

    expect(mocks.pool.query).toHaveBeenCalledTimes(1);
    const [sql, values] = mocks.pool.query.mock.calls[0] ?? [];
    expect(String(sql)).toContain("data->>'type' = $2");
    expect(String(sql)).toContain('timestamp <= $3::bigint');
    expect(String(sql)).toContain('timestamp >= $4::bigint');
    expect(String(sql)).toContain('order by timestamp desc, id desc');
    expect(values).toEqual(['networkSnapshots', 'DAY', '300', '100', 3, 0]);
    expect(result).toEqual({
      items: [row],
      totalCount: null,
      pageStart: 0,
      hasNextPage: false,
      hasPreviousPage: false,
    });
  });

  it('ignores nullish optional comparison filter values before SQL casts', async () => {
    const row = {
      collection: 'assetSnapshots',
      id: 'asset-snapshot-a',
      timestamp: 200,
      data: { id: 'asset-snapshot-a', type: 'DAY', assetId: 'xor', timestamp: 200 },
    } satisfies IndexerDocument;
    mocks.pool.query.mockResolvedValueOnce({ rows: [row] });
    const repository = new PostgresRepository(DATABASE_URL);

    const result = await repository.query('assetSnapshots', {
      first: 2,
      orderBy: ['TIMESTAMP_DESC'],
      filter: {
        and: [
          { type: { equalTo: 'DAY' } },
          { timestamp: { lessThanOrEqualTo: null, greaterThanOrEqualTo: 'null' } },
          { blockHeight: { in: [null, 'null'] } },
        ],
      },
      includeTotalCount: false,
    });

    expect(mocks.pool.query).toHaveBeenCalledTimes(1);
    const [sql, values] = mocks.pool.query.mock.calls[0] ?? [];
    expect(String(sql)).toContain("data->>'type' = $2");
    expect(String(sql)).not.toContain('timestamp <= ');
    expect(String(sql)).not.toContain('timestamp >= ');
    expect(String(sql)).not.toContain('block_height = any');
    expect(values).toEqual(['assetSnapshots', 'DAY', 3, 0]);
    expect(result.items).toEqual([row]);
  });

  it('builds SQL for SORA mobile notIn history filters without broadening them', async () => {
    const row = {
      collection: 'historyElements',
      id: 'history-transfer',
      timestamp: 200,
      data: { id: 'history-transfer', address: 'alice', method: 'transfer', timestamp: 200 },
    } satisfies IndexerDocument;
    mocks.pool.query.mockResolvedValueOnce({ rows: [row] });
    const repository = new PostgresRepository(DATABASE_URL);

    const result = await repository.query('historyElements', {
      first: 10,
      orderBy: ['TIMESTAMP_DESC'],
      filter: {
        or: [
          { address: 'alice', method: { notIn: ['swap', 'rewarded'] } },
          { dataTo: 'alice', method: { not_in: ['swap', 'rewarded'] } },
        ],
      },
      includeTotalCount: false,
    });

    expect(mocks.pool.query).toHaveBeenCalledTimes(1);
    const [sql, values] = mocks.pool.query.mock.calls[0] ?? [];
    expect(String(sql)).toContain("data->>'address' = $2");
    expect(String(sql)).toContain("(data->>'method' is null or not (data->>'method' = any($3::text[])))");
    expect(String(sql)).toContain("data->>'dataTo' = $4");
    expect(String(sql)).toContain("(data->>'method' is null or not (data->>'method' = any($5::text[])))");
    expect(String(sql)).toContain('order by timestamp desc, id desc');
    expect(values).toEqual([
      'historyElements',
      'alice',
      ['swap', 'rewarded'],
      'alice',
      ['swap', 'rewarded'],
      11,
      0,
    ]);
    expect(result.items).toEqual([row]);
  });

  it('fails closed for malformed or unsupported comparison filters', async () => {
    mocks.pool.query.mockResolvedValueOnce({ rows: [] });
    const repository = new PostgresRepository(DATABASE_URL);

    await repository.query('historyElements', {
      first: 1,
      filter: {
        and: 'not-an-array',
        method: { in: 'swap' },
        id: { startsWith: 'history-' },
      },
      includeTotalCount: false,
    });

    expect(mocks.pool.query).toHaveBeenCalledTimes(1);
    const [sql, values] = mocks.pool.query.mock.calls[0] ?? [];
    expect(String(sql)).toContain('where collection = $1 and (false and (false) and (false))');
    expect(values).toEqual(['historyElements', 2, 0]);
  });

  it('rejects adversarial JSON field names before building SQL', async () => {
    const repository = new PostgresRepository(DATABASE_URL);

    await expect(
      repository.query('historyElements', {
        first: 1,
        filter: {
          "id') or true --": { equalTo: 'history-a' },
        },
        includeTotalCount: false,
      })
    ).rejects.toThrow("Unsupported JSON field in repository query: id') or true --");
    expect(mocks.pool.query).not.toHaveBeenCalled();
  });

  it('deduplicates requested ids for getMany while returning documents by id', async () => {
    const assetA = assetDocument('asset-a', 10);
    const assetB = assetDocument('asset-b', 20);
    mocks.pool.query.mockResolvedValueOnce({ rows: [assetB, assetA] });
    const repository = new PostgresRepository(DATABASE_URL);

    const result = await repository.getMany('assets', ['asset-b', 'asset-a', 'asset-b']);

    expect(mocks.pool.query).toHaveBeenCalledTimes(1);
    expect(String(mocks.pool.query.mock.calls[0]?.[0])).toContain('id = any($2::text[])');
    expect(mocks.pool.query.mock.calls[0]?.[1]).toEqual(['assets', ['asset-b', 'asset-a']]);
    expect([...result.keys()]).toEqual(['asset-b', 'asset-a']);
    expect(result.get('asset-a')).toEqual(assetA);
  });

  it('deduplicates ids before deleting documents', async () => {
    mocks.pool.query.mockResolvedValueOnce({ rows: [] });
    const repository = new PostgresRepository(DATABASE_URL);

    await repository.deleteMany('assetSnapshots', ['snapshot-a', 'snapshot-b', 'snapshot-a']);

    expect(mocks.pool.query).toHaveBeenCalledTimes(1);
    expect(String(mocks.pool.query.mock.calls[0]?.[0])).toContain('delete from indexer_documents');
    expect(String(mocks.pool.query.mock.calls[0]?.[0])).toContain('pg_notify');
    expect(mocks.pool.query.mock.calls[0]?.[1]).toEqual(['assetSnapshots', ['snapshot-a', 'snapshot-b']]);
  });

  it('deduplicates bulk upserts by primary key and writes the latest document payload', async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    };
    mocks.pool.connect.mockResolvedValueOnce(client);
    const repository = new PostgresRepository(DATABASE_URL);

    await repository.upsertMany([
      { collection: 'assets', id: 'asset-a', blockHeight: 1, timestamp: 10, data: { id: 'asset-a', version: 'old' } },
      { collection: 'assets', id: 'asset-b', data: { id: 'asset-b', version: 'only' } },
      { collection: 'assets', id: 'asset-a', blockHeight: 2, timestamp: 20, data: { id: 'asset-a', version: 'new' } },
    ]);

    expect(client.query.mock.calls[0]?.[0]).toBe('begin');
    expect(client.query.mock.calls[2]?.[0]).toBe('commit');
    expect(client.release).toHaveBeenCalledOnce();
    const payload = JSON.parse(client.query.mock.calls[1]?.[1]?.[0] as string) as Array<Record<string, unknown>>;
    expect(payload).toEqual([
      {
        collection: 'assets',
        id: 'asset-a',
        blockHeight: 2,
        timestamp: 20,
        data: { id: 'asset-a', version: 'new' },
      },
      {
        collection: 'assets',
        id: 'asset-b',
        blockHeight: null,
        timestamp: null,
        data: { id: 'asset-b', version: 'only' },
      },
    ]);
  });

  it('rolls back and releases the client when a bulk upsert batch fails', async () => {
    const error = new Error('insert failed');
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    };
    mocks.pool.connect.mockResolvedValueOnce(client);
    const repository = new PostgresRepository(DATABASE_URL);

    await expect(repository.upsertMany([assetDocument('asset-a')])).rejects.toThrow(error);

    expect(client.query.mock.calls.map((call) => call[0])).toEqual(['begin', expect.any(String), 'rollback']);
    expect(client.release).toHaveBeenCalledOnce();
  });
});
