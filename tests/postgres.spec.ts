import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { POSTGRES_WORKER_MUTATION_FENCE_LOCK_KEY } from '../src/postgres-worker-fence.js';
import { createRepositoryCursorScope, decodeRepositoryCursor } from '../src/repository/cursor.js';
import type { IndexerDocument } from '../src/repository/types.js';

const opaqueCursor = () => expect.stringMatching(/^psc2\./);

const mocks = vi.hoisted(() => {
  const pool = {
    query: vi.fn(),
    connect: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
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
const WORKER_FENCING_TOKEN = '11111111-1111-4111-8111-111111111111';

const postgresConfig = (overrides: Partial<{
  postgresPoolMax: number;
  postgresListenPoolMax: number;
  postgresConnectionTimeoutMs: number;
  postgresQueryTimeoutMs: number;
  postgresStatementTimeoutMs: number;
  postgresWatchQueueMax: number;
  postgresWatchReconnectMinDelayMs: number;
  postgresWatchReconnectMaxDelayMs: number;
}> = {}) => ({
  databaseUrl: DATABASE_URL,
  postgresPoolMax: 20,
  postgresListenPoolMax: 2,
  postgresConnectionTimeoutMs: 10_000,
  postgresQueryTimeoutMs: 120_000,
  postgresStatementTimeoutMs: 120_000,
  postgresWatchQueueMax: 1_000,
  postgresWatchReconnectMinDelayMs: 1,
  postgresWatchReconnectMaxDelayMs: 10,
  ...overrides,
});

const assetDocument = (id: string, timestamp = 10): IndexerDocument => ({
  collection: 'assets',
  id,
  blockHeight: timestamp,
  timestamp,
  data: { id, timestamp, liquidity: String(timestamp) },
});

describe('PostgresRepository', () => {
  afterEach(() => {
    vi.useRealTimers();
    mocks.Pool.mockClear();
    mocks.pool.query.mockReset();
    mocks.pool.connect.mockReset();
    mocks.pool.end.mockReset();
    mocks.pool.on.mockReset();
    delete process.env.POSTGRES_POOL_MAX;
    delete process.env.POSTGRES_LISTEN_POOL_MAX;
    delete process.env.POSTGRES_CONNECTION_TIMEOUT_MS;
    delete process.env.POSTGRES_QUERY_TIMEOUT_MS;
    delete process.env.POSTGRES_STATEMENT_TIMEOUT_MS;
  });

  it('uses separate pools for regular queries and subscription listeners', () => {
    new PostgresRepository(postgresConfig({
      postgresPoolMax: 7,
      postgresListenPoolMax: 3,
      postgresConnectionTimeoutMs: 15_000,
      postgresQueryTimeoutMs: 90_000,
      postgresStatementTimeoutMs: 95_000,
    }));

    expect(mocks.Pool).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        connectionString: DATABASE_URL,
        connectionTimeoutMillis: 15_000,
        query_timeout: 90_000,
        statement_timeout: 95_000,
        options: '-c search_path=pg_catalog,public,pg_temp',
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
        options: '-c search_path=pg_catalog,public,pg_temp',
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

  it('handles idle pool error events without an unhandled EventEmitter error', () => {
    const repository = new PostgresRepository(DATABASE_URL);
    const handlers = mocks.pool.on.mock.calls
      .filter(([event]) => event === 'error')
      .map(([, handler]) => handler as (error: Error) => void);

    expect(() => handlers.forEach((handler) => handler(new Error('idle connection lost')))).not.toThrow();
    expect(repository.metricsSnapshot()).toMatchObject({
      postgres_query_pool_errors_total: 1,
      postgres_listen_pool_errors_total: 1,
    });
  });

  it('shares one Postgres LISTEN client across concurrent watchers', async () => {
    const listenClient = Object.assign(new EventEmitter(), {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    });
    mocks.pool.connect.mockResolvedValueOnce(listenClient);
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
      payload: JSON.stringify({ collection: 'assets', id: 'asset-b', mutationType: 'UPDATE' }),
    });

    const first = await nextA;
    expect(first).toEqual({
      done: false,
      value: { collection: 'assets', id: 'asset-b', mutationType: 'UPDATE' },
    });
    await expect(nextB).resolves.toEqual(first);
    expect(mocks.pool.connect).toHaveBeenCalledTimes(1);
    expect(mocks.pool.query).not.toHaveBeenCalled();

    await watcherA.return(undefined);
    await watcherB.return(undefined);

    expect(listenClient.query).toHaveBeenCalledWith('unlisten indexer_documents');
    expect(listenClient.release).toHaveBeenCalledOnce();
  });

  it('retains only the latest pending version per watched id and still drops the oldest distinct id', async () => {
    const listenClient = Object.assign(new EventEmitter(), {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    });
    mocks.pool.connect.mockResolvedValueOnce(listenClient);
    const repository = new PostgresRepository(postgresConfig({ postgresWatchQueueMax: 1_000 }));
    const watcher = repository.watch('assets');
    const firstPending = watcher.next();
    await new Promise((resolve) => setImmediate(resolve));
    const internal = repository as unknown as {
      deliverWatchEvent(event: {
        collection: 'assets';
        id: string;
        mutationType: 'INSERT' | 'UPDATE' | 'DELETE';
      }): void;
    };

    for (let version = 0; version < 1_000; version += 1) {
      internal.deliverWatchEvent({
        collection: 'assets',
        id: 'hot-asset',
        mutationType: version === 999 ? 'DELETE' : 'UPDATE',
      });
    }

    await expect(firstPending).resolves.toMatchObject({
      done: false,
      value: { id: 'hot-asset', mutationType: 'DELETE' },
    });
    expect(repository.metricsSnapshot()).toMatchObject({ postgres_watch_queue_drops_total: 0 });

    for (let index = 0; index <= 1_000; index += 1) {
      internal.deliverWatchEvent({
        collection: 'assets',
        id: `distinct-${index}`,
        mutationType: 'UPDATE',
      });
    }
    await expect(watcher.next()).resolves.toMatchObject({ value: { id: 'distinct-1' }, done: false });
    expect(repository.metricsSnapshot()).toMatchObject({ postgres_watch_queue_drops_total: 1 });

    await watcher.return(undefined);
  });

  it('aborts an idle Postgres watcher and releases the shared LISTEN client immediately', async () => {
    const listenClient = Object.assign(new EventEmitter(), {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    });
    mocks.pool.connect.mockResolvedValueOnce(listenClient);
    const repository = new PostgresRepository(DATABASE_URL);
    const controller = new AbortController();
    const watcher = repository.watch('assets', ['never-updated'], controller.signal);
    const pending = watcher.next();
    await new Promise((resolve) => setImmediate(resolve));

    controller.abort();

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(listenClient.query).toHaveBeenCalledWith('unlisten indexer_documents');
    expect(listenClient.release).toHaveBeenCalledOnce();
  });

  it('cleans up a failed LISTEN setup without retaining client listeners', async () => {
    const setupError = new Error('LISTEN failed');
    const listenClient = Object.assign(new EventEmitter(), {
      query: vi.fn().mockRejectedValue(setupError),
      release: vi.fn(),
    });
    mocks.pool.connect.mockResolvedValueOnce(listenClient);
    const repository = new PostgresRepository(postgresConfig());
    const watcher = repository.watch('assets', ['asset-a']);

    await expect(watcher.next()).rejects.toThrow(setupError);

    expect(listenClient.release).toHaveBeenCalledWith(true);
    expect(listenClient.listenerCount('notification')).toBe(0);
    expect(listenClient.listenerCount('error')).toBe(0);
    expect(listenClient.listenerCount('end')).toBe(0);
  });

  it('reconnects a lost listener and resynchronizes only explicit ids', async () => {
    vi.useFakeTimers();
    const assetA = assetDocument('asset-a', 30);
    const firstClient = Object.assign(new EventEmitter(), {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    });
    const secondClient = Object.assign(new EventEmitter(), {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    });
    mocks.pool.connect.mockResolvedValueOnce(firstClient).mockResolvedValueOnce(secondClient);
    mocks.pool.query.mockResolvedValueOnce({ rows: [assetA] });
    const repository = new PostgresRepository(postgresConfig());
    const watcher = repository.watch('assets', ['asset-a']);
    const pending = watcher.next();
    await vi.advanceTimersByTimeAsync(0);

    firstClient.emit('error', new Error('connection lost'));
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual({
      done: false,
      value: { collection: 'assets', id: 'asset-a', mutationType: 'UPDATE' },
    });
    expect(firstClient.release).toHaveBeenCalledWith(true);
    expect(secondClient.query).toHaveBeenCalledWith('listen indexer_documents');
    expect(mocks.pool.query).toHaveBeenCalledTimes(1);
    expect(mocks.pool.query.mock.calls[0]?.[1]).toEqual(['assets', ['asset-a']]);
    expect(repository.metricsSnapshot()).toMatchObject({
      postgres_watch_reconnects_total: 1,
      postgres_watch_resyncs_total: 1,
    });

    await watcher.return(undefined);
  });

  it('never performs an unbounded list resync for an unscoped watcher', async () => {
    vi.useFakeTimers();
    const firstClient = Object.assign(new EventEmitter(), {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    });
    const secondClient = Object.assign(new EventEmitter(), {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    });
    mocks.pool.connect.mockResolvedValueOnce(firstClient).mockResolvedValueOnce(secondClient);
    const repository = new PostgresRepository(postgresConfig());
    const controller = new AbortController();
    const watcher = repository.watch('assets', [], controller.signal);
    const pending = watcher.next();
    await vi.advanceTimersByTimeAsync(0);

    firstClient.emit('end');
    await vi.advanceTimersByTimeAsync(1);

    expect(mocks.pool.query).not.toHaveBeenCalled();
    expect(repository.metricsSnapshot()).toMatchObject({
      postgres_watch_reconnects_total: 1,
      postgres_watch_resyncs_total: 1,
    });
    controller.abort();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
  });

  it('coalesces a relevant notification without materializing its document before execution', async () => {
    vi.useFakeTimers();
    const listenClient = Object.assign(new EventEmitter(), {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    });
    mocks.pool.connect.mockResolvedValueOnce(listenClient);
    const repository = new PostgresRepository(postgresConfig());
    const watcher = repository.watch('assets', ['asset-a']);
    const pending = watcher.next();
    await vi.advanceTimersByTimeAsync(0);

    listenClient.emit('notification', {
      channel: 'indexer_documents',
      payload: JSON.stringify({ collection: 'assets', id: 'asset-a', mutationType: 'UPDATE' }),
    });
    await vi.advanceTimersByTimeAsync(25);

    await expect(pending).resolves.toEqual({
      done: false,
      value: { collection: 'assets', id: 'asset-a', mutationType: 'UPDATE' },
    });
    expect(mocks.pool.query).not.toHaveBeenCalled();
    await watcher.return(undefined);
  });

  it('drops irrelevant notification floods before allocating pending ids', async () => {
    vi.useFakeTimers();
    const listenClient = Object.assign(new EventEmitter(), {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    });
    mocks.pool.connect.mockResolvedValueOnce(listenClient);
    const repository = new PostgresRepository(postgresConfig({ postgresWatchQueueMax: 2 }));
    const controller = new AbortController();
    const watcher = repository.watch('assets', ['wanted'], controller.signal);
    const pending = watcher.next();
    await vi.advanceTimersByTimeAsync(0);

    for (let index = 0; index < 1_000; index += 1) {
      listenClient.emit('notification', {
        channel: 'indexer_documents',
        payload: JSON.stringify({
          collection: 'assets',
          id: `irrelevant-${index}`,
          mutationType: 'UPDATE',
        }),
      });
    }
    await vi.advanceTimersByTimeAsync(100);

    expect(mocks.pool.query).not.toHaveBeenCalled();
    expect(repository.metricsSnapshot()).toMatchObject({
      postgres_watch_pending_ids: 0,
      postgres_watch_queue_drops_total: 0,
    });
    controller.abort();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
  });

  it('shares one idempotent close promise while LISTEN setup is in flight', async () => {
    let resolveConnect!: (client: EventEmitter & { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }) => void;
    const connect = new Promise<EventEmitter & { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }>(
      (resolve) => { resolveConnect = resolve; }
    );
    const listenClient = Object.assign(new EventEmitter(), {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    });
    mocks.pool.connect.mockReturnValueOnce(connect);
    mocks.pool.end.mockResolvedValue(undefined);
    const repository = new PostgresRepository(postgresConfig());
    const watcher = repository.watch('assets', ['asset-a']);
    const pending = watcher.next();
    await Promise.resolve();

    const firstClose = repository.close();
    const secondClose = repository.close();
    expect(secondClose).toBe(firstClose);
    resolveConnect(listenClient);

    await expect(firstClose).resolves.toBeUndefined();
    await expect(pending).rejects.toThrow('Postgres LISTEN setup was cancelled');
    expect(listenClient.release).toHaveBeenCalledWith(true);
    expect(mocks.pool.end).toHaveBeenCalledTimes(2);
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
    expect(String(mocks.pool.query.mock.calls[0]?.[0])).toContain('order by timestamp asc, id collate "C" asc');
    expect(mocks.pool.query.mock.calls[0]?.[1]).toEqual(['assets', 3, 5]);
    expect(result).toEqual({
      items: rows.slice(0, 2),
      itemCursors: [opaqueCursor(), opaqueCursor()],
      totalCount: null,
      pageStart: 5,
      hasNextPage: true,
      hasPreviousPage: true,
    });
  });

  it('uses opaque keysets for page reads while counting the full filtered connection', async () => {
    const row = assetDocument('asset-c', 30);
    mocks.pool.query.mockResolvedValueOnce({ rows: [{ count: 3 }] }).mockResolvedValueOnce({ rows: [row] });
    const repository = new PostgresRepository(DATABASE_URL);

    const result = await repository.query('assets', {
      first: 1,
      orderBy: ['TIMESTAMP_ASC'],
      includeTotalCount: true,
      keyset: {
        scope: createRepositoryCursorScope('assets', ['TIMESTAMP_ASC'], undefined),
        field: 'timestamp',
        direction: 'asc',
        numeric: true,
        value: '20',
        id: 'asset-b',
      },
    });

    expect(mocks.pool.query).toHaveBeenCalledTimes(2);
    const [countSql, countValues] = mocks.pool.query.mock.calls[0] ?? [];
    const [selectSql, selectValues] = mocks.pool.query.mock.calls[1] ?? [];
    expect(String(countSql)).not.toContain('timestamp >');
    expect(countValues).toEqual(['assets']);
    expect(String(selectSql)).toContain(
      'timestamp > $2::bigint or timestamp is null or (timestamp = $2::bigint and id collate "C" > $3)'
    );
    expect(String(selectSql)).toContain('offset $5::int');
    expect(selectValues).toEqual(['assets', '20', 'asset-b', 2, 0]);
    expect(result).toMatchObject({
      items: [row],
      totalCount: 3,
      pageStart: 0,
      hasNextPage: false,
      hasPreviousPage: true,
    });
    expect(result.itemCursors).toHaveLength(1);
    expect(decodeRepositoryCursor(result.itemCursors?.[0])).toEqual({
      scope: createRepositoryCursorScope('assets', ['TIMESTAMP_ASC'], undefined),
      field: 'timestamp',
      direction: 'asc',
      numeric: true,
      value: '30',
      id: 'asset-c',
    });
  });

  it('dispatches independent count and page reads concurrently after keyset validation', async () => {
    let resolveCount!: (value: { rows: Array<{ count: number }> }) => void;
    let resolvePage!: (value: { rows: IndexerDocument[] }) => void;
    mocks.pool.query
      .mockReturnValueOnce(new Promise((resolve) => { resolveCount = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolvePage = resolve; }));
    const repository = new PostgresRepository(DATABASE_URL);
    const pending = repository.query('assets', { first: 1, orderBy: ['ID_ASC'], includeTotalCount: true });
    await Promise.resolve();

    expect(mocks.pool.query).toHaveBeenCalledTimes(2);
    resolveCount({ rows: [{ count: 1 }] });
    resolvePage({ rows: [assetDocument('asset-a')] });
    await expect(pending).resolves.toMatchObject({ totalCount: 1, items: [{ id: 'asset-a' }] });
  });

  it('does not dispatch count SQL for an invalid direct keyset', async () => {
    const repository = new PostgresRepository(DATABASE_URL);
    await expect(
      repository.query('assets', {
        first: 1,
        orderBy: ['ID_ASC'],
        includeTotalCount: true,
        keyset: {
          scope: 'scope',
          field: 'timestamp',
          direction: 'asc',
          numeric: true,
          value: '1',
          id: 'asset-a',
        },
      })
    ).rejects.toThrow('Pagination cursor does not match the requested order');
    expect(mocks.pool.query).not.toHaveBeenCalled();
  });

  it('rejects unsafe native positions before dispatching SQL', async () => {
    const repository = new PostgresRepository(DATABASE_URL);
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '9007199254740992', '9'.repeat(80)]) {
      await expect(
        repository.query('historyElements', {
          filter: { timestamp: { greaterThanOrEqualTo: value } },
          orderBy: ['TIMESTAMP_ASC'],
        })
      ).rejects.toThrow('non-negative safe integer');
    }
    await expect(
      repository.query('historyElements', {
        filter: { blockHeight: { in: [1, '9007199254740992'] } },
        orderBy: ['ID_ASC'],
      })
    ).rejects.toThrow('non-negative safe integer');
    await expect(
      repository.query('historyElements', {
        orderBy: ['TIMESTAMP_ASC'],
        seek: {
          field: 'timestamp',
          value: Number.MAX_SAFE_INTEGER + 1,
          id: 'history-a',
        },
      })
    ).rejects.toThrow('non-negative safe integer');
    await expect(
      repository.query('historyElements', {
        orderBy: ['TIMESTAMP_ASC'],
        keyset: {
          scope: createRepositoryCursorScope('historyElements', ['TIMESTAMP_ASC'], undefined),
          field: 'timestamp',
          direction: 'asc',
          numeric: true,
          value: '9007199254740992',
          id: 'history-a',
        },
      })
    ).rejects.toThrow('non-negative safe integer');
    expect(mocks.pool.query).not.toHaveBeenCalled();
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
      itemCursors: [],
      totalCount: 42,
      pageStart: 0,
      hasNextPage: true,
      hasPreviousPage: false,
    });
  });

  it('plans IDs and byte sizes before fetching only the budgeted PostgreSQL documents', async () => {
    const row = {
      ...assetDocument('asset-a'),
      __cursorValue: 'asset-a',
      __candidateCount: '2',
    };
    mocks.pool.query.mockResolvedValueOnce({ rows: [row] });
    const repository = new PostgresRepository(DATABASE_URL);

    const result = await repository.query('assets', {
      first: 1,
      orderBy: ['ID_ASC'],
      includeTotalCount: false,
      maxBytes: 4_096,
    });

    expect(mocks.pool.query).toHaveBeenCalledTimes(1);
    const [sql, values] = mocks.pool.query.mock.calls[0] ?? [];
    const statement = String(sql);
    expect(statement).toContain('with ordered_ids as materialized');
    expect(statement).toContain('octet_length(data::text)');
    expect(statement).toContain('budgeted_ids as materialized');
    expect(statement.indexOf('limit coalesce')).toBeLessThan(statement.indexOf('sum("__documentBytes")'));
    expect(statement).toContain('join indexer_documents document');
    expect(values).toEqual(['assets', 2, 0, 4_096]);
    expect(result.items.map(({ id }) => id)).toEqual(['asset-a']);
    expect(result.hasNextPage).toBe(true);
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
    expect(String(countSql)).toContain("data->'dataAssets' @> $3::jsonb");
    expect(String(countSql)).toContain("lower(data->>'module') = $4");
    expect(String(countSql)).toContain('block_height < $5::bigint');
    expect(countValues).toEqual([
      'historyElements',
      '100',
      '["xor"]',
      'assets',
      '500',
      'history-9',
    ]);
    expect(String(selectSql)).toContain("jsonb_typeof(data->'updatedAtBlock') in ('number', 'string')");
    expect(String(selectSql)).toContain(
      "then (data->>'updatedAtBlock')::numeric else null end) desc, id collate \"C\" desc"
    );
    expect(selectValues).toEqual([...countValues, 10, 0]);
    expect(result).toEqual({
      items: [row],
      itemCursors: [opaqueCursor()],
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
      "then (data->>'liquidityUSD')::numeric else null end) desc, id collate \"C\" desc"
    );
    expect(result.items).toEqual([row]);
  });

  it('supports keyset pagination for numeric JSON order fields', async () => {
    const row = assetDocument('asset-b', 20);
    row.data.liquidity = '90.5';
    mocks.pool.query.mockResolvedValueOnce({ rows: [row] });
    const repository = new PostgresRepository(DATABASE_URL);

    const result = await repository.query('assets', {
      first: 1,
      orderBy: ['LIQUIDITY_DESC'],
      includeTotalCount: false,
      keyset: {
        scope: createRepositoryCursorScope('assets', ['LIQUIDITY_DESC'], undefined),
        field: 'liquidity',
        direction: 'desc',
        numeric: true,
        value: '100.25',
        id: 'asset-a',
      },
    });

    const [sql, values] = mocks.pool.query.mock.calls[0] ?? [];
    expect(String(sql)).toContain("then (data->>'liquidity')::numeric else null end) < $2::numeric");
    expect(String(sql)).toContain('id collate "C" < $3');
    expect(values).toEqual(['assets', '100.25', 'asset-a', 2, 0]);
    expect(decodeRepositoryCursor(result.itemCursors?.[0])).toMatchObject({
      field: 'liquidity',
      direction: 'desc',
      numeric: true,
      value: '90.5',
      id: 'asset-b',
      scope: createRepositoryCursorScope('assets', ['LIQUIDITY_DESC'], undefined),
    });
  });

  it('orders DPM market metrics numerically against the stored JSON key', async () => {
    const row = {
      collection: 'markets',
      id: 'market-a',
      data: { id: 'market-a', marginalYesPriceBps: 10000 },
    } satisfies IndexerDocument;
    mocks.pool.query.mockResolvedValueOnce({ rows: [row] });
    const repository = new PostgresRepository(DATABASE_URL);

    const result = await repository.query('markets', {
      first: 1,
      orderBy: ['MARGINAL_YES_PRICE_BPS_DESC'],
      includeTotalCount: false,
    });

    expect(mocks.pool.query).toHaveBeenCalledTimes(1);
    expect(String(mocks.pool.query.mock.calls[0]?.[0])).toContain(
      "jsonb_typeof(data->'marginalYesPriceBps') in ('number', 'string')"
    );
    expect(String(mocks.pool.query.mock.calls[0]?.[0])).toContain(
      "then (data->>'marginalYesPriceBps')::numeric else null end) desc, id collate \"C\" desc"
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
    expect(String(sql)).toContain('order by timestamp desc, id collate "C" desc');
    expect(values).toEqual(['networkSnapshots', 'DAY', '300', '100', 3, 0]);
    expect(result).toEqual({
      items: [row],
      itemCursors: [opaqueCursor()],
      totalCount: null,
      pageStart: 0,
      hasNextPage: false,
      hasPreviousPage: false,
    });
  });

  it('builds SQL for Polkamarkt final pre-close market snapshot lookups', async () => {
    const row = {
      collection: 'marketSnapshots',
      id: 'market-7-default-80',
      blockHeight: 80,
      timestamp: 80,
      data: { id: 'market-7-default-80', marketId: 7, type: 'DEFAULT', blockHeight: 80, probability: 75 },
    } satisfies IndexerDocument;
    mocks.pool.query.mockResolvedValueOnce({ rows: [row] });
    const repository = new PostgresRepository(DATABASE_URL);

    const result = await repository.query('marketSnapshots', {
      first: 1,
      orderBy: ['BLOCK_HEIGHT_DESC'],
      filter: {
        marketId: { equalTo: 7 },
        type: { equalTo: 'DEFAULT' },
        blockHeight: { lessThanOrEqualTo: 100 },
      },
      includeTotalCount: false,
    });

    expect(mocks.pool.query).toHaveBeenCalledTimes(1);
    const [sql, values] = mocks.pool.query.mock.calls[0] ?? [];
    expect(String(sql)).toContain("then (data->>'marketId')::numeric else null end) = ($2)::numeric");
    expect(String(sql)).toContain("data->>'type' = $3");
    expect(String(sql)).toContain('block_height <= $4::bigint');
    expect(String(sql)).toContain('order by block_height desc, id collate "C" desc');
    expect(values).toEqual(['marketSnapshots', '7', 'DEFAULT', '100', 2, 0]);
    expect(result.items).toEqual([row]);
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

  it('keeps empty and null-only set predicates fail-closed across storage engines', async () => {
    mocks.pool.query.mockResolvedValueOnce({ rows: [] });
    const repository = new PostgresRepository(DATABASE_URL);

    await repository.query('assets', {
      first: 1,
      filter: {
        and: [
          { id: { in: [] } },
          { id: { in: [null, 'null'] } },
          { id: { notIn: [] } },
          { id: { not_in: [null, 'null'] } },
        ],
      },
      includeTotalCount: false,
    });

    const [sql, values] = mocks.pool.query.mock.calls[0] ?? [];
    expect(String(sql)).toContain('((false) and (false) and (true) and (true))');
    expect(values).toEqual(['assets', 2, 0]);
  });

  it('casts numeric equality, sets, and arbitrary-precision ranges without JS coercion', async () => {
    mocks.pool.query.mockResolvedValueOnce({ rows: [] });
    const repository = new PostgresRepository(DATABASE_URL);
    const huge = '900719925474099312345678901234567890';
    const fraction = `0.${'0'.repeat(39)}1`;

    await repository.query('assets', {
      first: 1,
      filter: {
        liquidity: { equalTo: 1, in: ['1.0', '2'], greaterThan: huge, lessThanOrEqualTo: fraction },
      },
      includeTotalCount: false,
    });

    const [sql, values] = mocks.pool.query.mock.calls[0] ?? [];
    expect(String(sql)).toContain("then (data->>'liquidity')::numeric else null end)");
    expect(String(sql)).toContain('= ($2)::numeric');
    expect(String(sql)).toContain('= any($3::numeric[])');
    expect(String(sql)).toContain('> ($4)::numeric');
    expect(String(sql)).toContain('<= ($5)::numeric');
    expect(values).toEqual(['assets', '1', ['1.0', '2'], huge, fraction, 2, 0]);
  });

  it('rejects invalid numeric filter syntax before querying Postgres', async () => {
    const repository = new PostgresRepository(DATABASE_URL);
    await expect(
      repository.query('assets', {
        first: 1,
        filter: { liquidity: { greaterThan: '1e3' } },
        includeTotalCount: false,
      })
    ).rejects.toThrow('Invalid numeric filter value for liquidity');
    await expect(
      repository.query('poolXYKs', {
        first: 1,
        filter: { targetAssetReserves: { greaterThan: '9'.repeat(257) } },
        includeTotalCount: false,
      })
    ).rejects.toThrow('Invalid numeric filter value for targetAssetReserves');
    expect(mocks.pool.query).not.toHaveBeenCalled();
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
    expect(String(sql)).toContain('order by timestamp desc, id collate "C" desc');
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
    expect(String(client.query.mock.calls[1]?.[0])).toContain(
      'excluded.block_height >= indexer_documents.block_height'
    );
  });

  it('deduplicates bulk upserts to the highest block instead of a later stale payload', async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    };
    mocks.pool.connect.mockResolvedValueOnce(client);
    const repository = new PostgresRepository(DATABASE_URL);

    await repository.upsertMany([
      { collection: 'assets', id: 'asset-a', blockHeight: 20, data: { id: 'asset-a', version: 'current' } },
      { collection: 'assets', id: 'asset-a', blockHeight: 19, data: { id: 'asset-a', version: 'stale' } },
      { collection: 'assets', id: 'asset-a', data: { id: 'asset-a', version: 'unversioned' } },
      { collection: 'assets', id: 'asset-a', blockHeight: 20, data: { id: 'asset-a', version: 'equal-repair' } },
    ]);

    const payload = JSON.parse(client.query.mock.calls[1]?.[1]?.[0] as string) as Array<Record<string, unknown>>;
    expect(payload).toEqual([
      {
        collection: 'assets',
        id: 'asset-a',
        blockHeight: 20,
        timestamp: null,
        data: { id: 'asset-a', version: 'equal-repair' },
      },
    ]);
  });

  it('guards single upserts against lower or unversioned block regressions', async () => {
    mocks.pool.query.mockResolvedValueOnce({ rows: [] });
    const repository = new PostgresRepository(DATABASE_URL);

    await repository.upsert({
      collection: 'assets',
      id: 'asset-a',
      blockHeight: 20,
      data: { id: 'asset-a' },
    });

    const sql = String(mocks.pool.query.mock.calls[0]?.[0]);
    expect(sql).toContain('(excluded.block_height is null and indexer_documents.block_height is null)');
    expect(sql).toContain('excluded.block_height >= indexer_documents.block_height');
  });

  it('validates a configured worker lease under a shared transaction fence before mutation', async () => {
    const client = {
      query: vi.fn(async (text: string, _values?: unknown[]) => {
        if (text.includes('fence.fencing_token')) {
          return { rows: [{ tokenMatches: true, leaseHeld: true }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    mocks.pool.connect.mockResolvedValueOnce(client);
    const repository = new PostgresRepository(DATABASE_URL, {
      workerFencingToken: WORKER_FENCING_TOKEN,
    });

    await repository.upsert(assetDocument('asset-fenced'));

    expect(client.query.mock.calls.map(([text]) => String(text))).toEqual([
      'begin',
      'select pg_advisory_xact_lock_shared($1::bigint)',
      expect.stringContaining('fence.fencing_token = $1::uuid'),
      expect.stringContaining('insert into indexer_documents'),
      'commit',
    ]);
    expect(client.query.mock.calls[1]?.[1]).toEqual([POSTGRES_WORKER_MUTATION_FENCE_LOCK_KEY]);
    expect(client.query.mock.calls[2]?.[1]?.[0]).toBe(WORKER_FENCING_TOKEN);
    expect(client.release).toHaveBeenCalledOnce();
    expect(mocks.pool.query).not.toHaveBeenCalled();
  });

  it('rolls back without mutation when a configured worker token is no longer current', async () => {
    const client = {
      query: vi.fn(async (text: string, _values?: unknown[]) => {
        if (text.includes('fence.fencing_token')) {
          return { rows: [{ tokenMatches: false, leaseHeld: true }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    mocks.pool.connect.mockResolvedValueOnce(client);
    const repository = new PostgresRepository(DATABASE_URL, {
      workerFencingToken: WORKER_FENCING_TOKEN,
    });

    await expect(repository.upsert(assetDocument('asset-stale'))).rejects.toThrow(
      'writer lease is no longer current'
    );

    expect(client.query.mock.calls.map(([text]) => String(text))).toEqual([
      'begin',
      'select pg_advisory_xact_lock_shared($1::bigint)',
      expect.stringContaining('fence.fencing_token = $1::uuid'),
      'rollback',
    ]);
    expect(client.query.mock.calls.some(([text]) => String(text).includes('insert into indexer_documents'))).toBe(
      false
    );
    expect(client.release).toHaveBeenCalledOnce();
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

  it('rejects invalid documents before opening a write query or transaction', async () => {
    const repository = new PostgresRepository(DATABASE_URL);
    await expect(
      repository.upsert({ collection: 'assets', id: 'contains space', data: { id: 'contains space' } })
    ).rejects.toThrow(/document id/);
    await expect(
      repository.upsertMany([{ collection: 'assets', id: 'unicode-ä', data: { id: 'unicode-ä' } }])
    ).rejects.toThrow(/document id/);
    await expect(
      repository.upsert({ collection: 'unknown', id: 'id', data: {} } as unknown as IndexerDocument)
    ).rejects.toThrow(/collection/);
    await expect(
      repository.upsert({ collection: 'assets', id: 'id', blockHeight: -1, data: {} })
    ).rejects.toThrow(/blockHeight/);
    await expect(
      repository.upsert({ collection: 'assets', id: 'id', timestamp: Number.MAX_SAFE_INTEGER + 1, data: {} })
    ).rejects.toThrow(/timestamp/);
    await expect(
      repository.upsert({ collection: 'assets', id: 'id', data: [] } as unknown as IndexerDocument)
    ).rejects.toThrow(/data/);
    await expect(
      repository.upsert({ collection: 'assets', id: 'id', data: { bad: 1n } })
    ).rejects.toThrow(/non-JSON bigint/);
    await expect(
      repository.upsert({ collection: 'assets', id: 'id', data: { bad: new Date() } })
    ).rejects.toThrow(/plain objects/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(repository.upsert({ collection: 'assets', id: 'id', data: cyclic })).rejects.toThrow(/cycle/);
    await expect(repository.deleteMany('unknown' as never, ['id'])).rejects.toThrow(/collection/);
    await expect(repository.deleteMany('assets', ['contains space'])).rejects.toThrow(/document id/);
    expect(mocks.pool.query).not.toHaveBeenCalled();
    expect(mocks.pool.connect).not.toHaveBeenCalled();
  });
});
