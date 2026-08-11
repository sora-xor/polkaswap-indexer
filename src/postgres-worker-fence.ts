/**
 * PostgreSQL protocol shared by the dedicated worker lease session and fenced
 * repository mutation transactions.
 *
 * The session lease prevents two healthy workers from running concurrently.
 * The second advisory lock is a handoff barrier: mutations hold it in shared
 * transaction mode, while lease acquisition/release takes it exclusively.
 */
export const POSTGRES_WORKER_LEASE_LOCK_KEY = 4_350_435_200;
export const POSTGRES_WORKER_MUTATION_FENCE_LOCK_KEY = 4_350_435_201;
export const POSTGRES_WORKER_LEASE_FENCE_TABLE = 'public.polkaswap_indexer_worker_lease_fence';

export const POSTGRES_WORKER_LEASE_FENCE_TABLE_SQL = `
  create table if not exists ${POSTGRES_WORKER_LEASE_FENCE_TABLE} (
    singleton boolean primary key default true check (singleton),
    fencing_token uuid not null,
    fencing_epoch bigint not null check (fencing_epoch > 0),
    lease_backend_pid integer not null check (lease_backend_pid > 0),
    acquired_at timestamptz not null default clock_timestamp()
  )
`;

const FENCING_TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertPostgresWorkerFencingToken(token: unknown): asserts token is string {
  if (typeof token !== 'string' || !FENCING_TOKEN_PATTERN.test(token)) {
    throw new Error('Invalid PostgreSQL worker fencing token');
  }
}

/** pg_locks encodes the bigint advisory-lock key as two unsigned 32-bit OIDs. */
export const postgresAdvisoryLockParts = (key: number): { classId: number; objectId: number } => {
  if (!Number.isSafeInteger(key) || key < 0) throw new Error('Invalid PostgreSQL advisory lock key');

  return {
    classId: Math.floor(key / 2 ** 32),
    objectId: key >>> 0,
  };
};
