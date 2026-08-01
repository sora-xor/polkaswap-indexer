import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrate } from '../src/db/migrate.js';
import {
  postgresAdvisoryLockParts,
  POSTGRES_WORKER_LEASE_LOCK_KEY,
  POSTGRES_WORKER_MUTATION_FENCE_LOCK_KEY,
} from '../src/postgres-worker-fence.js';
import { PostgresRepository } from '../src/repository/postgres.js';
import { acquirePostgresWorkerLease } from '../src/worker/lease.js';

const { Pool } = pg;
const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('Postgres worker lease integration', () => {
  const adminPool = new Pool({ connectionString: databaseUrl, max: 4 });

  beforeAll(async () => {
    await migrate(databaseUrl!);
  }, 60_000);

  afterAll(async () => {
    await adminPool.end();
  });

  it('excludes a concurrent worker and becomes acquirable only after explicit release', async () => {
    const first = await acquirePostgresWorkerLease(databaseUrl!);
    try {
      await expect(acquirePostgresWorkerLease(databaseUrl!)).rejects.toThrow('already holds');
    } finally {
      await first.release();
    }

    const successor = await acquirePostgresWorkerLease(databaseUrl!);
    await successor.release();
  });

  it('acquires and validates through the migrated fence table without schema CREATE privilege', async () => {
    const suffix = randomUUID().replaceAll('-', '');
    const role = `lease_restricted_${suffix}`;
    const password = `pw${suffix}`;
    const documentId = `restricted-fence-${suffix}`;
    const restrictedUrl = new URL(databaseUrl!);
    restrictedUrl.username = role;
    restrictedUrl.password = password;
    let lease: Awaited<ReturnType<typeof acquirePostgresWorkerLease>> | null = null;
    let repository: PostgresRepository | null = null;

    await adminPool.query(`create role "${role}" login password '${password}'`);
    try {
      await adminPool.query(`grant usage on schema public to "${role}"`);
      await adminPool.query(
        `grant select, insert, update on public.polkaswap_indexer_worker_lease_fence to "${role}"`
      );
      await adminPool.query(`grant select, insert, update, delete on indexer_documents to "${role}"`);
      const privileges = await adminPool.query<{ canCreate: boolean }>(
        `select has_schema_privilege($1, 'public', 'CREATE') as "canCreate"`,
        [role]
      );
      expect(privileges.rows[0]?.canCreate).toBe(false);

      lease = await acquirePostgresWorkerLease(restrictedUrl.toString());
      repository = new PostgresRepository(restrictedUrl.toString(), {
        workerFencingToken: lease.fencingToken,
      });
      await expect(
        repository.upsert({
          collection: 'assets',
          id: documentId,
          blockHeight: 1,
          data: { id: documentId, source: 'restricted-runtime-role' },
        })
      ).resolves.toBeUndefined();
    } finally {
      await repository?.close().catch(() => undefined);
      await lease?.release().catch(() => undefined);
      await adminPool
        .query(`delete from indexer_documents where collection = 'assets' and id = $1`, [documentId])
        .catch(() => undefined);
      await adminPool.query(`drop owned by "${role}"`).catch(() => undefined);
      await adminPool.query(`drop role if exists "${role}"`).catch(() => undefined);
    }
  });

  it('drains an old in-flight write at handoff and rejects that token afterward', async () => {
    const documentId = `worker-fence-${randomUUID()}`;
    const staleDocumentId = `worker-stale-${randomUUID()}`;
    const successorDocumentId = `worker-successor-${randomUUID()}`;
    const leaseParts = postgresAdvisoryLockParts(POSTGRES_WORKER_LEASE_LOCK_KEY);
    const mutationParts = postgresAdvisoryLockParts(POSTGRES_WORKER_MUTATION_FENCE_LOCK_KEY);
    const blocker = await adminPool.connect();
    const first = await acquirePostgresWorkerLease(databaseUrl!);
    const oldRepository = new PostgresRepository(databaseUrl!, {
      workerFencingToken: first.fencingToken,
    });
    let successor: Awaited<ReturnType<typeof acquirePostgresWorkerLease>> | null = null;
    let successorAcquisition: ReturnType<typeof acquirePostgresWorkerLease> | null = null;
    let successorRepository: PostgresRepository | null = null;
    let blockedOldWrite: Promise<void> | null = null;
    let blockerTransactionOpen = false;

    const waitForLock = async (
      parts: { classId: number; objectId: number },
      mode: 'ExclusiveLock' | 'ShareLock',
      predicate: (held: boolean) => boolean
    ): Promise<void> => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const result = await adminPool.query<{ held: boolean }>(
          `select exists (
             select 1
             from pg_catalog.pg_locks
             where locktype = 'advisory'
               and database = (select oid from pg_catalog.pg_database where datname = current_database())
               and classid = $1::oid
               and objid = $2::oid
               and objsubid = 1
               and mode = $3
               and granted
           ) as held`,
          [parts.classId, parts.objectId, mode]
        );
        if (predicate(result.rows[0]?.held === true)) return;
        await sleep(20);
      }
      throw new Error(`Timed out waiting for PostgreSQL ${mode} advisory lock state`);
    };

    try {
      await oldRepository.upsert({
        collection: 'assets',
        id: documentId,
        blockHeight: 1,
        timestamp: 1,
        data: { id: documentId, version: 'seed' },
      });
      await blocker.query('begin');
      blockerTransactionOpen = true;
      await blocker.query(
        `select id from indexer_documents
          where collection = 'assets' and id = $1
          for update`,
        [documentId]
      );

      blockedOldWrite = oldRepository.upsert({
        collection: 'assets',
        id: documentId,
        blockHeight: 2,
        timestamp: 2,
        data: { id: documentId, version: 'old-worker-in-flight' },
      });
      await waitForLock(mutationParts, 'ShareLock', (held) => held);

      const terminated = await adminPool.query<{ terminated: boolean }>(
        'select pg_terminate_backend($1) as terminated',
        [first.backendPid]
      );
      expect(terminated.rows[0]?.terminated).toBe(true);
      await expect(
        Promise.race([
          first.lost,
          sleep(5_000).then(() => {
            throw new Error('Timed out waiting for lease-loss notification');
          }),
        ])
      ).rejects.toThrow('lease connection was lost');
      await waitForLock(leaseParts, 'ExclusiveLock', (held) => !held);

      let successorSettled = false;
      successorAcquisition = acquirePostgresWorkerLease(databaseUrl!).then((lease) => {
        successorSettled = true;
        return lease;
      });
      await sleep(100);
      expect(successorSettled).toBe(false);

      await blocker.query('commit');
      blockerTransactionOpen = false;
      await expect(blockedOldWrite).resolves.toBeUndefined();
      successor = await successorAcquisition;

      await expect(
        oldRepository.upsert({
          collection: 'assets',
          id: staleDocumentId,
          blockHeight: 3,
          data: { id: staleDocumentId, version: 'must-not-write' },
        })
      ).rejects.toThrow('writer lease is no longer current');

      successorRepository = new PostgresRepository(databaseUrl!, {
        workerFencingToken: successor.fencingToken,
      });
      await expect(
        successorRepository.upsert({
          collection: 'assets',
          id: successorDocumentId,
          blockHeight: 3,
          data: { id: successorDocumentId, version: 'successor' },
        })
      ).resolves.toBeUndefined();

      const rows = await adminPool.query<{ id: string; version: string }>(
        `select id, data->>'version' as version
           from indexer_documents
          where collection = 'assets' and id = any($1::text[])
          order by id`,
        [[documentId, staleDocumentId, successorDocumentId]]
      );
      expect(rows.rows).toEqual(
        [
          { id: documentId, version: 'old-worker-in-flight' },
          { id: successorDocumentId, version: 'successor' },
        ].sort((left, right) => left.id.localeCompare(right.id))
      );
    } finally {
      if (blockerTransactionOpen) await blocker.query('rollback').catch(() => undefined);
      blocker.release();
      await blockedOldWrite?.catch(() => undefined);
      if (!successor && successorAcquisition) {
        successor = await successorAcquisition.catch(() => null);
      }
      await oldRepository.close().catch(() => undefined);
      await successorRepository?.close().catch(() => undefined);
      await first.release().catch(() => undefined);
      await successor?.release().catch(() => undefined);
      await adminPool
        .query(
          `delete from indexer_documents
            where collection = 'assets' and id = any($1::text[])`,
          [[documentId, staleDocumentId, successorDocumentId]]
        )
        .catch(() => undefined);
    }
  }, 30_000);
});
