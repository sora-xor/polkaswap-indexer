import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import {
  acquirePostgresWorkerLease,
  createPostgresWorkerLeaseClientConfig,
  POSTGRES_WORKER_LEASE_LOCK_KEY,
  POSTGRES_WORKER_MUTATION_FENCE_LOCK_KEY,
  stopOnWorkerLeaseLoss,
} from '../src/worker/lease.js';

import type { WorkerLeaseClient } from '../src/worker/lease.js';

const FENCING_TOKEN = '11111111-1111-4111-8111-111111111111';

const fakeClient = (options: {
  acquired?: boolean;
  unlocked?: boolean;
  fenceTableExists?: boolean;
  epoch?: { fencingToken: string; fencingEpoch: string; backendPid: number };
} = {}) => {
  const client = Object.assign(new EventEmitter(), {
    connect: vi.fn().mockResolvedValue(undefined),
    query: vi.fn(async (text: string, values?: unknown[]) => {
      if (text.includes('pg_try_advisory_lock')) {
        return { rows: [{ acquired: options.acquired ?? true }] };
      }
      if (text.includes('returning fencing_token')) {
        return {
          rows: [
            options.epoch ?? {
              fencingToken: values?.[0] as string,
              fencingEpoch: '1',
              backendPid: 123,
            },
          ],
        };
      }
      if (text.includes('to_regclass')) {
        return {
          rows: [
            {
              leaseFenceTable:
                options.fenceTableExists === false ? null : 'polkaswap_indexer_worker_lease_fence',
            },
          ],
        };
      }
      if (text.includes('pg_advisory_unlock')) {
        return { rows: [{ unlocked: options.unlocked ?? true }] };
      }
      return { rows: [] };
    }),
    end: vi.fn().mockResolvedValue(undefined),
  });
  return client as unknown as WorkerLeaseClient & {
    connect: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
};

describe('Postgres chain-worker lease', () => {
  it('uses the centralized Postgres connection and query deadlines', () => {
    expect(
      createPostgresWorkerLeaseClientConfig('postgres://unused', {
        connectionTimeoutMs: 1_234,
        queryTimeoutMs: 5_678,
        statementTimeoutMs: 9_012,
      })
    ).toMatchObject({
      connectionString: 'postgres://unused',
      connectionTimeoutMillis: 1_234,
      query_timeout: 5_678,
      statement_timeout: 9_012,
      keepAlive: true,
      application_name: 'polkaswap-indexer-chain-worker-lease',
    });
  });

  it('publishes an epoch only after draining old mutations and releases on the dedicated session', async () => {
    const client = fakeClient();
    const lease = await acquirePostgresWorkerLease('postgres://unused', {
      createClient: () => client,
      createFencingToken: () => FENCING_TOKEN,
    });

    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.query).toHaveBeenNthCalledWith(
      1,
      'select pg_try_advisory_lock($1::bigint) as acquired',
      [POSTGRES_WORKER_LEASE_LOCK_KEY]
    );
    expect(client.query).toHaveBeenNthCalledWith(2, 'begin');
    expect(client.query).toHaveBeenNthCalledWith(
      3,
      'select pg_advisory_xact_lock($1::bigint)',
      [POSTGRES_WORKER_MUTATION_FENCE_LOCK_KEY]
    );
    expect(String(client.query.mock.calls[3]?.[0])).toContain('to_regclass');
    expect(String(client.query.mock.calls[4]?.[0])).toContain('returning fencing_token::text');
    expect(client.query.mock.calls[4]?.[1]).toEqual([FENCING_TOKEN]);
    expect(client.query.mock.calls[5]?.[0]).toBe('commit');
    expect(lease).toMatchObject({ fencingToken: FENCING_TOKEN, fencingEpoch: '1', backendPid: 123 });

    await lease.release();
    await lease.release();
    expect(client.query).toHaveBeenNthCalledWith(
      9,
      'select pg_advisory_unlock($1::bigint) as unlocked',
      [POSTGRES_WORKER_LEASE_LOCK_KEY]
    );
    expect(client.query).toHaveBeenNthCalledWith(7, 'begin');
    expect(client.query).toHaveBeenNthCalledWith(
      8,
      'select pg_advisory_xact_lock($1::bigint)',
      [POSTGRES_WORKER_MUTATION_FENCE_LOCK_KEY]
    );
    expect(client.query.mock.calls[9]?.[0]).toBe('commit');
    expect(client.query).toHaveBeenCalledTimes(10);
    expect(client.end).toHaveBeenCalledOnce();
  });

  it('fails closed when another worker owns the lease and closes its client', async () => {
    const client = fakeClient({ acquired: false });

    await expect(
      acquirePostgresWorkerLease('postgres://unused', { createClient: () => client })
    ).rejects.toThrow('already holds');
    expect(client.end).toHaveBeenCalledOnce();
  });

  it('fails closed without runtime DDL when the migrated fence table is missing', async () => {
    const client = fakeClient({ fenceTableExists: false });
    await expect(
      acquirePostgresWorkerLease('postgres://unused', {
        createClient: () => client,
        createFencingToken: () => FENCING_TOKEN,
      })
    ).rejects.toThrow('run the schema migration');
    const statements = client.query.mock.calls.map(([text]) => String(text));

    expect(statements.some((text) => text.includes('create table'))).toBe(false);
    expect(statements.some((text) => text.includes('returning fencing_token::text'))).toBe(false);
    expect(statements.at(-1)).toBe('rollback');
    expect(client.end).toHaveBeenCalledOnce();
  });

  it.each(['error', 'end'] as const)('turns an unexpected client %s event into fatal idempotent shutdown', async (event) => {
    const client = fakeClient();
    const lease = await acquirePostgresWorkerLease('postgres://unused', { createClient: () => client });
    const stop = vi.fn().mockResolvedValue(undefined);
    const report = vi.fn();
    const monitored = stopOnWorkerLeaseLoss(lease, stop, report)!;

    client.emit(event, event === 'error' ? new Error('socket reset') : undefined);
    client.emit(event, event === 'error' ? new Error('duplicate') : undefined);
    await monitored;

    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0]?.[0]).toMatchObject({
      message: expect.stringContaining('lease connection was lost'),
    });
    expect(stop).toHaveBeenCalledOnce();
  });

  it('does not report normal explicit release as lease loss', async () => {
    const client = fakeClient();
    const lease = await acquirePostgresWorkerLease('postgres://unused', { createClient: () => client });
    const report = vi.fn();
    const stop = vi.fn().mockResolvedValue(undefined);
    void stopOnWorkerLeaseLoss(lease, stop, report);

    await lease.release();
    client.emit('end');
    await new Promise((resolve) => setImmediate(resolve));

    expect(report).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it('does not issue an unlock query after the dedicated lease connection is lost', async () => {
    const client = fakeClient();
    const lease = await acquirePostgresWorkerLease('postgres://unused', { createClient: () => client });
    client.emit('error', new Error('connection lost'));

    await expect(lease.release()).resolves.toBeUndefined();
    expect(client.query.mock.calls.some(([text]) => String(text).includes('pg_advisory_unlock'))).toBe(false);
    expect(client.end).toHaveBeenCalledOnce();
  });

  it('rolls back and closes the session when epoch publication is malformed', async () => {
    const client = fakeClient({
      epoch: { fencingToken: FENCING_TOKEN, fencingEpoch: '0', backendPid: 123 },
    });

    await expect(
      acquirePostgresWorkerLease('postgres://unused', {
        createClient: () => client,
        createFencingToken: () => FENCING_TOKEN,
      })
    ).rejects.toThrow('valid fencing epoch');

    expect(client.query.mock.calls.at(-1)?.[0]).toBe('rollback');
    expect(client.end).toHaveBeenCalledOnce();
  });

  it('closes a failed connection attempt without trying to unlock', async () => {
    const client = fakeClient();
    client.connect.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(
      acquirePostgresWorkerLease('postgres://unused', { createClient: () => client })
    ).rejects.toThrow('database unavailable');
    expect(client.query).not.toHaveBeenCalled();
    expect(client.end).toHaveBeenCalledOnce();
  });
});
