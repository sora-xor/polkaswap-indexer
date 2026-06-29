import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const client = {
    query: vi.fn(),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn().mockResolvedValue(client),
    end: vi.fn(),
  };
  const Pool = vi.fn(function MockPool() {
    return pool;
  });

  return { Pool, client, pool };
});

vi.mock('pg', () => ({
  default: {
    Pool: mocks.Pool,
  },
}));

const { migrate } = await import('../src/db/migrate.js');

const DATABASE_URL = 'postgres://polkaswap:polkaswap@localhost:5432/polkaswap_indexer';

describe('migrate', () => {
  afterEach(() => {
    mocks.Pool.mockClear();
    mocks.pool.connect.mockClear();
    mocks.pool.end.mockClear();
    mocks.client.release.mockClear();
    mocks.client.query.mockReset();
  });

  it('does not build the costly createdAtTimestamp index during startup migration', async () => {
    mocks.client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_get_indexdef')) throw new Error('index does not exist');
      return { rows: [] };
    });

    await migrate(DATABASE_URL);

    const createIndexSql = mocks.client.query.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes('indexer_documents_collection_created_at_timestamp_idx'));

    expect(createIndexSql).toBeUndefined();
  });
});
