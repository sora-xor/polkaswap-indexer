import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import pg from 'pg';

import { POSTGRES_TRUSTED_SESSION_OPTIONS } from '../postgres-session.js';
import {
  assertPostgresWorkerFencingToken,
  POSTGRES_WORKER_LEASE_FENCE_TABLE,
  POSTGRES_WORKER_LEASE_LOCK_KEY,
  POSTGRES_WORKER_MUTATION_FENCE_LOCK_KEY,
} from '../postgres-worker-fence.js';

const { Client } = pg;

export { POSTGRES_WORKER_LEASE_LOCK_KEY, POSTGRES_WORKER_MUTATION_FENCE_LOCK_KEY };

export type WorkerLeaseClient = EventEmitter & {
  connect(): Promise<void>;
  query<T extends object = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
};

export type WorkerLease = {
  /** Unpredictable epoch identity required by every worker repository mutation. */
  fencingToken: string;
  /** Monotonic diagnostic epoch persisted with the token. */
  fencingEpoch: string;
  /** PostgreSQL backend that owns the dedicated session lease. */
  backendPid: number;
  /** Rejects if the lease connection disappears before explicit release. */
  lost: Promise<never>;
  release(): Promise<void>;
};

export type WorkerLeaseOptions = {
  createClient?: () => WorkerLeaseClient;
  connectionTimeoutMs?: number;
  queryTimeoutMs?: number;
  statementTimeoutMs?: number;
  /** Deterministic token injection for unit tests. */
  createFencingToken?: () => string;
};

export const createPostgresWorkerLeaseClientConfig = (
  databaseUrl: string,
  options: WorkerLeaseOptions
): pg.ClientConfig => ({
  connectionString: databaseUrl,
  connectionTimeoutMillis: options.connectionTimeoutMs ?? 10_000,
  query_timeout: options.queryTimeoutMs ?? 120_000,
  statement_timeout: options.statementTimeoutMs ?? 120_000,
  options: POSTGRES_TRUSTED_SESSION_OPTIONS,
  keepAlive: true,
  application_name: 'polkaswap-indexer-chain-worker-lease',
});

const leaseLostError = (cause: unknown): Error =>
  new Error('The PostgreSQL chain-worker lease connection was lost; indexing must stop immediately', { cause });

/**
 * Acquires a session-scoped advisory lock on a dedicated connection.
 *
 * The connection is intentionally never returned to a pool: pooling could
 * move unlock work to another session or release the lock while the worker is
 * still active. A lost connection releases PostgreSQL advisory locks, so the
 * `lost` promise is a fatal runtime signal rather than a reconnect request.
 */
export const acquirePostgresWorkerLease = async (
  databaseUrl: string,
  options: WorkerLeaseOptions = {}
): Promise<WorkerLease> => {
  const client =
    options.createClient?.() ??
    (new Client(createPostgresWorkerLeaseClientConfig(databaseUrl, options)) as unknown as WorkerLeaseClient);
  let released = false;
  let connectionIsLost = false;
  let releasePromise: Promise<void> | null = null;
  let fencingToken = '';
  let fencingEpoch = '';
  let backendPid = 0;
  let rejectLost!: (error: Error) => void;
  const lost = new Promise<never>((_resolve, reject) => {
    rejectLost = reject;
  });
  // Acquiring a lease and installing its fatal handler are separate startup
  // steps. Pre-attach a rejection observer so a connection failure in that
  // narrow window cannot become an unhandled rejection.
  void lost.catch(() => undefined);

  const connectionLost = (cause: unknown): void => {
    if (!released) {
      connectionIsLost = true;
      rejectLost(leaseLostError(cause));
    }
  };
  client.on('error', connectionLost);
  client.on('end', connectionLost);

  try {
    await client.connect();
    const result = await client.query<{ acquired: boolean }>(
      'select pg_try_advisory_lock($1::bigint) as acquired',
      [POSTGRES_WORKER_LEASE_LOCK_KEY]
    );
    if (result.rows[0]?.acquired !== true) {
      throw new Error('Another Polkaswap chain worker already holds the PostgreSQL writer lease');
    }

    fencingToken = options.createFencingToken?.() ?? randomUUID();
    assertPostgresWorkerFencingToken(fencingToken);
    let transactionOpen = false;
    try {
      await client.query('begin');
      transactionOpen = true;
      // An exclusive handoff waits for every mutation that validated the prior
      // lease while it was still alive. No successor token becomes visible
      // until those transactions have committed or rolled back.
      await client.query('select pg_advisory_xact_lock($1::bigint)', [
        POSTGRES_WORKER_MUTATION_FENCE_LOCK_KEY,
      ]);
      const existingFenceTable = await client.query<{ leaseFenceTable: string | null }>(
        'select to_regclass($1)::text as "leaseFenceTable"',
        [POSTGRES_WORKER_LEASE_FENCE_TABLE]
      );
      if (!existingFenceTable.rows[0]?.leaseFenceTable) {
        throw new Error(
          'PostgreSQL worker lease fence table is missing; run the schema migration with the migration-owner role before starting the worker'
        );
      }
      const rotated = await client.query<{
        fencingToken: string;
        fencingEpoch: string;
        backendPid: number;
      }>(
        `insert into ${POSTGRES_WORKER_LEASE_FENCE_TABLE} as fence(
           singleton, fencing_token, fencing_epoch, lease_backend_pid, acquired_at
         ) values (true, $1::uuid, 1, pg_backend_pid(), clock_timestamp())
         on conflict (singleton)
         do update set
           fencing_token = excluded.fencing_token,
           fencing_epoch = fence.fencing_epoch + 1,
           lease_backend_pid = excluded.lease_backend_pid,
           acquired_at = excluded.acquired_at
         returning fencing_token::text as "fencingToken",
                   fencing_epoch::text as "fencingEpoch",
                   lease_backend_pid as "backendPid"`,
        [fencingToken]
      );
      const epoch = rotated.rows[0];
      if (
        epoch?.fencingToken !== fencingToken ||
        !/^[1-9][0-9]*$/.test(epoch.fencingEpoch) ||
        !Number.isSafeInteger(epoch.backendPid) ||
        epoch.backendPid <= 0
      ) {
        throw new Error('PostgreSQL worker lease did not publish a valid fencing epoch');
      }
      fencingEpoch = epoch.fencingEpoch;
      backendPid = epoch.backendPid;
      await client.query('commit');
      transactionOpen = false;
    } catch (error) {
      if (transactionOpen) await client.query('rollback').catch(() => undefined);
      throw error;
    }
  } catch (error) {
    released = true;
    client.off('error', connectionLost);
    client.off('end', connectionLost);
    await client.end().catch(() => undefined);
    throw error;
  }

  return {
    fencingToken,
    fencingEpoch,
    backendPid,
    lost,
    release: () => {
      if (releasePromise) return releasePromise;
      releasePromise = (async () => {
        released = true;
        try {
          if (!connectionIsLost) {
            let transactionOpen = false;
            try {
              await client.query('begin');
              transactionOpen = true;
              // Healthy shutdown also drains validated mutations. The session
              // lock is released while the exclusive barrier is still held, so
              // a successor cannot rotate the epoch until this handoff commits.
              await client.query('select pg_advisory_xact_lock($1::bigint)', [
                POSTGRES_WORKER_MUTATION_FENCE_LOCK_KEY,
              ]);
              const result = await client.query<{ unlocked: boolean }>(
                'select pg_advisory_unlock($1::bigint) as unlocked',
                [POSTGRES_WORKER_LEASE_LOCK_KEY]
              );
              if (result.rows[0]?.unlocked !== true) {
                throw new Error('The PostgreSQL chain-worker lease was not held by its dedicated session');
              }
              await client.query('commit');
              transactionOpen = false;
            } catch (error) {
              if (transactionOpen) await client.query('rollback').catch(() => undefined);
              throw error;
            }
          }
        } finally {
          client.off('error', connectionLost);
          client.off('end', connectionLost);
          await client.end().catch(() => undefined);
        }
      })();
      return releasePromise;
    },
  };
};

/** Converts lease loss into one idempotent fatal shutdown path. */
export const stopOnWorkerLeaseLoss = (
  lease: WorkerLease | null,
  stop: () => Promise<void>,
  report: (error: Error) => void
): Promise<void> | null => {
  if (!lease) return null;

  return lease.lost.catch(async (error: unknown) => {
    const fatal = error instanceof Error ? error : leaseLostError(error);
    report(fatal);
    await stop();
  });
};
