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
