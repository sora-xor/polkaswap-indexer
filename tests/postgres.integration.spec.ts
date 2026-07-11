import pg from 'pg';
import { RocksDatabase } from '@harperfast/rocksdb-js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrate } from '../src/db/migrate.js';
import { readConfig } from '../src/config.js';
import { evaluateServiceReadiness } from '../src/readiness.js';
import { decodeRepositoryCursor } from '../src/repository/cursor.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { PostgresRepository } from '../src/repository/postgres.js';
import { RocksRepository } from '../src/repository/rocksdb.js';
import { cleanupPostgresRocksdbCapture } from '../src/scripts/cleanup-postgres-rocksdb-capture.js';
import { runPostgresToRocksdbMigration } from '../src/scripts/migrate-postgres-to-rocksdb.js';
import {
  acquireMigrationProcessLock,
  beginChangeCaptureSeal,
  capturedChangeHash,
  CHANGE_SCHEMA,
  CHANGE_STATE_TABLE,
  CHANGE_TABLE,
  installChangeCapture,
  readChangeCaptureDescriptor,
  releaseMigrationProcessLock,
} from '../src/scripts/postgres-rocksdb-capture.js';
import { createPersistedWorkerStatusDocument } from '../src/worker/status.js';

import type {
  IndexerDocument,
  RepositoryKeyset,
  RepositoryQueryArgs,
  RepositoryQueryResult,
} from '../src/repository/types.js';

const { Pool } = pg;

const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL ?? '';
const describeWithPostgres = databaseUrl ? describe : describe.skip;

const asset = (
  id: string,
  blockHeight: number | null,
  version: string,
  timestamp: number | null = blockHeight
): IndexerDocument => ({
  collection: 'assets',
  id,
  blockHeight,
  timestamp,
  data: { id, version },
});

describeWithPostgres('PostgresRepository integration', () => {
  const adminPool = new Pool({ connectionString: databaseUrl, max: 6 });
  let repository: PostgresRepository | null = null;

  const forceResetCapture = async () => {
    await adminPool.query('drop trigger if exists indexer_documents_rocksdb_writer_guard_trigger on indexer_documents');
    await adminPool.query('drop trigger if exists indexer_documents_rocksdb_changes_trigger on indexer_documents');
    await adminPool.query(`drop schema if exists ${CHANGE_SCHEMA} cascade`);
  };

  beforeAll(async () => {
    await migrate(databaseUrl);
  }, 60_000);

  beforeEach(async () => {
    await forceResetCapture();
    await adminPool.query('truncate table indexer_documents');
    repository = new PostgresRepository(databaseUrl);
  });

  afterEach(async () => {
    await repository?.close();
    repository = null;
    await forceResetCapture();
  });

  afterAll(async () => {
    await adminPool.end();
  });

  it('publishes identity-only INSERT, UPDATE, and DELETE notifications from committed writes', async () => {
    const watcher = repository!.watch('assets', ['watch-identity']);
    const withDeadline = <T>(promise: Promise<T>): Promise<T> =>
      Promise.race([
        promise,
        sleep(5_000).then(() => {
          throw new Error('Timed out waiting for PostgreSQL watch identity');
        }),
      ]);
    const inserted = watcher.next();
    await sleep(50);
    await repository!.upsert(asset('watch-identity', 1, 'insert'));
    await expect(withDeadline(inserted)).resolves.toEqual({
      done: false,
      value: { collection: 'assets', id: 'watch-identity', mutationType: 'INSERT' },
    });

    const updated = watcher.next();
    await repository!.upsert(asset('watch-identity', 2, 'update'));
    await expect(withDeadline(updated)).resolves.toEqual({
      done: false,
      value: { collection: 'assets', id: 'watch-identity', mutationType: 'UPDATE' },
    });

    const deleted = watcher.next();
    await repository!.deleteMany('assets', ['watch-identity']);
    await expect(withDeadline(deleted)).resolves.toEqual({
      done: false,
      value: { collection: 'assets', id: 'watch-identity', mutationType: 'DELETE' },
    });
    await watcher.return(undefined);
  }, 20_000);

  it('enforces the exact cross-engine JSON numeric domain for direct nested JSONB writes', async () => {
    const deepExact = `${'{"level":'.repeat(64)}1.25${'}'.repeat(64)}`;
    for (const [index, data] of [
      '{"value":9007199254740991}',
      '{"value":-9007199254740991}',
      '{"nested":[{"scaled":1.2300,"exponent":1.2e-3}]}',
      '{"digits":"9007199254740992","fraction":"0.1234567890123456789"}',
      deepExact,
    ].entries()) {
      await expect(
        adminPool.query(
          `insert into indexer_documents(collection, id, block_height, timestamp, data)
           values ('assets', $1, 1, 1, $2::jsonb)`,
          [`exact-${index}`, data]
        )
      ).resolves.toMatchObject({ rowCount: 1 });
    }

    const deepUnsafe = `${'{"level":'.repeat(64)}9007199254740992${'}'.repeat(64)}`;
    const oversizedScale = `{"scale":0.${'0'.repeat(1_025)}}`;
    for (const [index, [data, error]] of [
      ['{"value":9007199254740992}', /indexer_documents_json_numbers_v1_check/],
      ['{"value":-9007199254740992}', /indexer_documents_json_numbers_v1_check/],
      ['{"nested":[{"rounded":0.1234567890123456789}]}', /indexer_documents_json_numbers_v1_check/],
      ['{"nested":[{"roundedInteger":9007199254740991.1}]}', /indexer_documents_json_numbers_v1_check/],
      ['{"overflow":1e309}', /indexer_documents_json_numbers_v1_check/],
      // PostgreSQL's own numeric parser rejects this before the CHECK runs.
      ['{"underflow":1e-100000}', /value overflows numeric format/],
      [deepUnsafe, /indexer_documents_json_numbers_v1_check/],
      [oversizedScale, /indexer_documents_json_numbers_v1_check/],
    ].entries()) {
      await expect(
        adminPool.query(
          `insert into indexer_documents(collection, id, block_height, timestamp, data)
           values ('assets', $1, 1, 1, $2::jsonb)`,
          [`lossy-${index}`, data]
        )
      ).rejects.toThrow(error as RegExp);
    }

    const functions = await adminPool.query<{ name: string; volatility: string; parallel: string }>(
      `select proname as name, provolatile as volatility, proparallel as parallel
         from pg_proc
        where proname in ('indexer_json_number_is_exact_v1', 'indexer_json_numbers_are_exact_v1')
        order by proname`
    );
    expect(functions.rows).toEqual([
      { name: 'indexer_json_number_is_exact_v1', volatility: 'i', parallel: 's' },
      { name: 'indexer_json_numbers_are_exact_v1', volatility: 'i', parallel: 's' },
    ]);

    const hostileSession = await adminPool.connect();
    try {
      await hostileSession.query('set extra_float_digits = -15');
      await expect(
        hostileSession.query(
          `select indexer_json_number_is_exact_v1(0.123456789012345::numeric) as exact`
        )
      ).resolves.toMatchObject({ rows: [{ exact: true }] });
    } finally {
      hostileSession.release();
    }
  });

  it('enforces collection-scoped decimal and scalar equality domains for direct writes', async () => {
    await expect(
      adminPool.query(
        `insert into indexer_documents(collection, id, data) values
          ('assetSnapshots', 'asset-day', '{"id":"asset-day","priceUSD":{"open":"1","close":"2"}}'::jsonb),
          ('poolSnapshots', 'pool-day', '{"id":"pool-day","priceUSD":{"open":"1","close":"2"}}'::jsonb)`
      )
    ).resolves.toMatchObject({ rowCount: 2 });

    for (const [id, collection, data, constraint] of [
      ['asset-object', 'assets', '{"id":"asset-object","priceUSD":{"close":"2"}}', 'indexed_decimals'],
      ['history-address-object', 'historyElements', '{"id":"history-address-object","address":["alice"]}', 'indexed_strings'],
      ['history-to-object', 'historyElements', '{"id":"history-to-object","data":{"to":["alice"]}}', 'indexed_strings'],
      [
        'pool-hostile-decimal',
        'poolXYKs',
        JSON.stringify({ id: 'pool-hostile-decimal', targetAssetReserves: '9'.repeat(257) }),
        'indexed_decimals',
      ],
    ] as const) {
      await expect(
        adminPool.query(
          `insert into indexer_documents(collection, id, data) values ($1, $2, $3::jsonb)`,
          [collection, id, data]
        )
      ).rejects.toThrow(new RegExp(`indexer_documents_${constraint}_v1_check`));
    }
  });

  it('replaces a stale same-name document CHECK instead of trusting its name', async () => {
    await adminPool.query(
      `alter table indexer_documents drop constraint indexer_documents_json_numbers_v1_check`
    );
    await adminPool.query(
      `alter table indexer_documents add constraint indexer_documents_json_numbers_v1_check check (true)`
    );
    try {
      await migrate(databaseUrl);
      await expect(
        adminPool.query(
          `insert into indexer_documents(collection, id, block_height, timestamp, data)
           values ('assets', 'stale-check-probe', 1, 1, '{"value":9007199254740992}'::jsonb)`
        )
      ).rejects.toThrow(/indexer_documents_json_numbers_v1_check/);
    } finally {
      // Restore the production definition even if an assertion above fails.
      await migrate(databaseUrl);
    }
  });

  it('rejects stale and unversioned regressions while allowing equal-height repairs', async () => {
    if (!repository) throw new Error('Postgres repository was not initialized');
    await repository.upsert(asset('single', null, 'unversioned-first'));
    await repository.upsert(asset('single', null, 'unversioned-repair'));
    expect((await repository.get('assets', 'single'))?.data.version).toBe('unversioned-repair');

    await repository.upsert(asset('single', 20, 'current'));
    await repository.upsert(asset('single', 19, 'stale'));
    await repository.upsert(asset('single', null, 'unversioned-regression'));
    await repository.upsert(asset('single', 20, 'equal-height-repair'));

    const repaired = await repository.get('assets', 'single');
    expect(typeof repaired?.blockHeight).toBe('number');
    expect(typeof repaired?.timestamp).toBe('number');
    expect(Number(repaired?.blockHeight)).toBe(20);
    expect(repaired?.data.version).toBe('equal-height-repair');

    await repository.upsert(asset('single', 18, 'late-stale'));
    expect((await repository.get('assets', 'single'))?.data.version).toBe('equal-height-repair');
  });

  it('deduplicates a batch by highest block and applies the last equal-height payload', async () => {
    if (!repository) throw new Error('Postgres repository was not initialized');
    await repository.upsert(asset('persisted', 50, 'persisted-current'));

    await repository.upsertMany([
      asset('batched', 30, 'highest-first'),
      asset('batched', 29, 'stale'),
      asset('batched', null, 'unversioned'),
      asset('batched', 30, 'highest-repair'),
      asset('persisted', 49, 'persisted-stale'),
      asset('persisted', null, 'persisted-unversioned'),
    ]);

    const documents = await repository.getMany('assets', ['batched', 'persisted']);
    expect(Number(documents.get('batched')?.blockHeight)).toBe(30);
    expect(documents.get('batched')?.data.version).toBe('highest-repair');
    expect(Number(documents.get('persisted')?.blockHeight)).toBe(50);
    expect(documents.get('persisted')?.data.version).toBe('persisted-current');
  });

  it('uses stable keysets and reports the exact current connection count', async () => {
    if (!repository) throw new Error('Postgres repository was not initialized');
    await repository.upsertMany([
      asset('asset-a', 1, 'a', 10),
      asset('asset-b', 2, 'b', 20),
      asset('asset-c', 3, 'c', 20),
      asset('asset-d', 4, 'd', 30),
      asset('asset-e', 5, 'e', null),
    ]);

    const firstPage = await repository.query('assets', {
      first: 2,
      orderBy: ['TIMESTAMP_ASC'],
      includeTotalCount: true,
    });

    expect(firstPage.items.map(({ id }) => id)).toEqual(['asset-a', 'asset-b']);
    expect(firstPage.totalCount).toBe(5);
    expect(firstPage.hasNextPage).toBe(true);
    const after = decodeRepositoryCursor(firstPage.itemCursors?.at(-1));
    expect(after).not.toBeNull();
    if (!after) throw new Error('First PostgreSQL page did not return a valid keyset cursor');

    await repository.deleteMany('assets', ['asset-a']);
    const secondPage = await repository.query('assets', {
      first: 2,
      orderBy: ['TIMESTAMP_ASC'],
      includeTotalCount: true,
      keyset: after,
    });

    expect(secondPage.items.map(({ id }) => id)).toEqual(['asset-c', 'asset-d']);
    expect(secondPage.totalCount).toBe(4);
    expect(secondPage.hasPreviousPage).toBe(true);
    expect(secondPage.hasNextPage).toBe(true);

    const secondAfter = decodeRepositoryCursor(secondPage.itemCursors?.at(-1));
    expect(secondAfter).not.toBeNull();
    if (!secondAfter) throw new Error('Second PostgreSQL page did not return a valid keyset cursor');

    const finalPage = await repository.query('assets', {
      first: 2,
      orderBy: ['TIMESTAMP_ASC'],
      includeTotalCount: true,
      keyset: secondAfter,
    });

    expect(finalPage.items.map(({ id }) => id)).toEqual(['asset-e']);
    expect(finalPage.totalCount).toBe(4);
    expect(finalPage.hasNextPage).toBe(false);
  });

  it('uses audited indexes for critical first-release UI plans', async () => {
    if (!repository) throw new Error('Postgres repository was not initialized');
    await repository.upsertMany([
      {
        collection: 'assets',
        id: 'active-asset',
        data: { id: 'active-asset', liquidity: '10', liquidityBooks: '0', priceUSD: '2' },
      },
      {
        collection: 'stakingStakers',
        id: 'alice',
        data: { id: 'alice' },
      },
      ...Array.from({ length: 500 }, (_item, index) => ({
        collection: 'historyElements' as const,
        id: `unrelated-${String(index).padStart(3, '0')}`,
        blockHeight: 1_000 + index,
        timestamp: 1_000 + index,
        data: {
          id: `unrelated-${String(index).padStart(3, '0')}`,
          blockHeight: 1_000 + index,
          timestamp: 1_000 + index,
          module: 'system',
          method: 'remark',
          address: 'alice',
        },
      })),
      {
        collection: 'assetSnapshots',
        id: 'asset-day-100',
        blockHeight: 100,
        timestamp: 100,
        data: { id: 'asset-day-100', assetId: 'xor', type: 'DAY', blockHeight: 100, timestamp: 100 },
      },
      {
        collection: 'historyElements',
        id: 'burn-100',
        blockHeight: 100,
        timestamp: 100,
        data: { id: 'burn-100', blockHeight: 100, timestamp: 100, module: 'assets', method: 'burn', address: 'alice' },
      },
      {
        collection: 'historyElements',
        id: 'swap-101',
        blockHeight: 101,
        timestamp: 101,
        data: { id: 'swap-101', blockHeight: 101, timestamp: 101, module: 'liquidityProxy', method: 'swap', address: 'alice' },
      },
      {
        collection: 'historyElements',
        id: 'burn-asset-102',
        blockHeight: 102,
        timestamp: 102,
        data: {
          id: 'burn-asset-102',
          blockHeight: 102,
          timestamp: 102,
          module: 'assets',
          method: 'burn',
          data: { assetId: 'xor' },
        },
      },
      {
        collection: 'historyElements',
        id: 'bridge-to-103',
        blockHeight: 103,
        timestamp: 103,
        data: {
          id: 'bridge-to-103',
          blockHeight: 103,
          timestamp: 103,
          module: 'bridgeMultisig',
          method: 'asMulti',
          data: { to: 'alice' },
        },
      },
    ]);

    const client = await adminPool.connect();
    const explain = async (sql: string): Promise<string> => {
      const result = await client.query<{ 'QUERY PLAN': string }>(`explain (format text) ${sql}`);
      const plan = result.rows.map((row) => row['QUERY PLAN']).join('\n');
      expect(plan).not.toContain('Seq Scan on indexer_documents');
      return plan;
    };
    try {
      await client.query('begin');
      await client.query('set local enable_seqscan = off');
      await client.query('analyze indexer_documents');

      await expect(
        explain(`select id from indexer_documents where collection = 'stakingStakers' and id >= '' order by id collate "C" limit 10`)
      ).resolves.toContain('indexer_documents_pkey');
      await expect(
        explain(`select id from indexer_documents
          where collection = 'historyElements' and data->>'address' = 'alice'
          order by timestamp desc, id collate "C" desc limit 10`)
      ).resolves.toContain('indexer_documents_history_address_timestamp_idx');
      await expect(
        explain(`select id from indexer_documents
          where collection = 'historyElements'
            and timestamp between 90 and 110
            and block_height <= 110
          order by timestamp asc, id collate "C" asc limit 100`)
      ).resolves.toContain('indexer_documents_history_timestamp_idx');
      await client.query('set local enable_indexscan = off');
      const historyOrPlan = await explain(`select id from indexer_documents
        where collection = 'historyElements' and block_height between 1 and 200 and (
          (data->>'module' = 'assets' and data->>'method' = 'burn' and data->>'address' = 'alice') or
          (data->>'module' = 'liquidityProxy' and data->>'method' = 'swap' and data->>'address' = 'alice')
        ) order by id collate "C" asc limit 100`);
      expect(historyOrPlan).toContain('indexer_documents_history_assets_burn_address_block_idx');
      expect(historyOrPlan).toContain('indexer_documents_history_liquidity_swap_address_block_idx');
      await client.query('set local enable_indexscan = on');
      await expect(
        explain(`select id from indexer_documents
          where collection = 'historyElements'
            and data->>'module' = 'assets'
            and data->>'method' = 'burn'
            and data->'data'->>'assetId' = 'xor'
            and block_height between 1 and 200
          order by id collate "C" asc limit 100`)
      ).resolves.toContain('indexer_documents_history_assets_burn_asset_block_idx');
      await expect(
        explain(`select id from indexer_documents
          where collection = 'historyElements'
            and data->>'module' = 'bridgeMultisig'
            and data->>'method' = 'asMulti'
            and data->'data'->>'to' = 'alice'
            and block_height between 1 and 200
          order by id collate "C" asc limit 100`)
      ).resolves.toContain('indexer_documents_history_bridge_in_to_block_idx');
      await expect(
        explain(`select id from indexer_documents where collection = 'assets' and
          (case when jsonb_typeof(data->'liquidity') in ('number', 'string')
            and nullif(data->>'liquidity', '') ~ '^-?[0-9]+(\\.[0-9]+)?$'
            then (data->>'liquidity')::numeric else null end) > 0
          order by id collate "C" asc limit 100`)
      ).resolves.toContain('indexer_documents_collection_liquidity_idx');
      await expect(
        explain(`select id from indexer_documents where collection = 'assetSnapshots'
          and data->>'assetId' = 'xor' and data->>'type' = 'DAY'
          order by timestamp asc, id collate "C" asc limit 100`)
      ).resolves.toContain('indexer_documents_asset_snapshots_asset_type_timestamp_idx');
      await client.query('rollback');
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  });

  it('matches exact vault ordering and partial-index counts across PostgreSQL, RocksDB, and memory', async () => {
    if (!repository) throw new Error('Postgres repository was not initialized');
    const postgres = repository;
    const memory = new MemoryRepository();
    const tempDir = await mkdtemp(join(tmpdir(), 'polkaswap-cross-engine-exactness-'));
    const rocks = new RocksRepository({
      ...readConfig(),
      storageEngine: 'rocksdb',
      rocksdbPath: join(tempDir, 'indexer.rocksdb'),
      rocksdbBlockCacheMb: 32,
      rocksdbWriteBufferManagerMb: 16,
      rocksdbParallelism: 1,
    });
    const documents: IndexerDocument[] = [
      {
        collection: 'vaults',
        id: 'vault-y-safe',
        data: { id: 'vault-y-safe', ownerId: 'alice', updatedAtBlock: '9007199254740991' },
      },
      {
        collection: 'vaults',
        id: 'vault-z-lower',
        data: { id: 'vault-z-lower', ownerId: 'alice', updatedAtBlock: '9007199254740992' },
      },
      {
        collection: 'vaults',
        id: 'vault-a-higher',
        data: { id: 'vault-a-higher', ownerId: 'alice', updatedAtBlock: '9007199254740993' },
      },
      {
        collection: 'vaults',
        id: 'vault-b-huge',
        data: { id: 'vault-b-huge', ownerId: 'alice', updatedAtBlock: '9'.repeat(80) },
      },
      {
        collection: 'vaults',
        id: 'vault-other-owner',
        data: { id: 'vault-other-owner', ownerId: 'bob', updatedAtBlock: '1'.repeat(80) },
      },
      {
        collection: 'historyElements',
        id: 'polkamarkt-old',
        blockHeight: 10,
        timestamp: 10,
        data: { id: 'polkamarkt-old', blockHeight: 10, module: 'polkamarkt', timestamp: 10 },
      },
      {
        collection: 'historyElements',
        id: 'polkamarkt-new',
        blockHeight: 30,
        timestamp: 30,
        data: { id: 'polkamarkt-new', blockHeight: 30, module: 'polkamarkt', timestamp: 30 },
      },
      {
        collection: 'historyElements',
        id: 'unrelated-history',
        blockHeight: 20,
        timestamp: 20,
        data: { id: 'unrelated-history', blockHeight: 20, module: 'system', timestamp: 20 },
      },
    ];

    try {
      await rocks.prepare();
      await Promise.all([
        postgres.upsertMany(documents),
        rocks.upsertMany(documents),
        memory.upsertMany(documents),
      ]);

      const compareQuery = async (collection: 'vaults' | 'historyElements', args: RepositoryQueryArgs) => {
        const [postgresResult, rocksResult, memoryResult] = await Promise.all([
          postgres.query(collection, args),
          rocks.query(collection, args),
          memory.query(collection, args),
        ]);
        const shape = (result: RepositoryQueryResult) => ({
          ids: result.items.map(({ id }) => id),
          totalCount: result.totalCount,
        });
        expect(shape(rocksResult)).toEqual(shape(memoryResult));
        expect(shape(postgresResult)).toEqual(shape(memoryResult));
        return memoryResult;
      };

      const vaults = await compareQuery('vaults', {
        first: 100,
        orderBy: ['UPDATED_AT_BLOCK_ASC'],
        filter: { ownerId: { equalTo: 'alice' } },
        includeTotalCount: true,
      });
      expect(vaults.items.map(({ id }) => id)).toEqual([
        'vault-y-safe',
        'vault-z-lower',
        'vault-a-higher',
        'vault-b-huge',
      ]);
      expect(vaults.totalCount).toBe(4);

      const polkamarkt = await compareQuery('historyElements', {
        first: 1,
        orderBy: ['TIMESTAMP_DESC'],
        filter: { module: { equalTo: 'polkamarkt' } },
        includeTotalCount: true,
      });
      expect(polkamarkt.items.map(({ id }) => id)).toEqual(['polkamarkt-new']);
      expect(polkamarkt.totalCount).toBe(2);

      const historyFilter = {
        and: [
          { timestamp: { greaterThanOrEqualTo: 10, lessThanOrEqualTo: 30 } },
          { blockHeight: { lessThanOrEqualTo: 30 } },
        ],
      };
      const historyFirst = await compareQuery('historyElements', {
        first: 2,
        orderBy: ['TIMESTAMP_ASC'],
        filter: historyFilter,
        includeTotalCount: false,
      });
      expect(historyFirst.items.map(({ id }) => id)).toEqual(['polkamarkt-old', 'unrelated-history']);
      const historySecond = await compareQuery('historyElements', {
        first: 2,
        orderBy: ['TIMESTAMP_ASC'],
        filter: historyFilter,
        includeTotalCount: false,
        seek: { field: 'timestamp', value: 20, id: 'unrelated-history', direction: 'asc' },
      });
      expect(historySecond.items.map(({ id }) => id)).toEqual(['polkamarkt-new']);

      for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '9007199254740992', '9'.repeat(80)]) {
        for (const engine of [postgres, rocks, memory]) {
          await expect(
            engine.query('historyElements', {
              filter: { timestamp: { greaterThanOrEqualTo: invalid } },
              orderBy: ['TIMESTAMP_ASC'],
            })
          ).rejects.toThrow('non-negative safe integer');
        }
      }
    } finally {
      await Promise.allSettled([rocks.close(), memory.close()]);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('matches in/notIn semantics for empty, null-only, and mixed sets', async () => {
    if (!repository) throw new Error('Postgres repository was not initialized');
    const memory = new MemoryRepository();
    const documents: IndexerDocument[] = [
      { ...asset('asset-a', 1, 'a'), data: { id: 'asset-a', cohort: 'x' } },
      { ...asset('asset-b', 2, 'b'), data: { id: 'asset-b' } },
    ];
    await repository.upsertMany(documents);
    await memory.upsertMany(documents);

    const cases: Array<{ filter: Record<string, unknown>; expected: string[] }> = [
      { filter: { cohort: { in: [] } }, expected: [] },
      { filter: { cohort: { in: [null, 'null'] } }, expected: [] },
      { filter: { cohort: { notIn: [] } }, expected: ['asset-a', 'asset-b'] },
      { filter: { cohort: { not_in: [null, 'null'] } }, expected: ['asset-a', 'asset-b'] },
      { filter: { cohort: { in: [null, 'x'] } }, expected: ['asset-a'] },
    ];

    for (const testCase of cases) {
      const args = {
        first: 10,
        orderBy: ['ID_ASC'],
        filter: testCase.filter,
        includeTotalCount: false,
      } as const;
      const [postgresResult, memoryResult] = await Promise.all([
        repository.query('assets', args),
        memory.query('assets', args),
      ]);
      expect(postgresResult.items.map(({ id }) => id)).toEqual(testCase.expected);
      expect(memoryResult.items.map(({ id }) => id)).toEqual(testCase.expected);
    }

    await memory.close();
  });

  it('matches exact numeric equality across number/string representations', async () => {
    if (!repository) throw new Error('Postgres repository was not initialized');
    const memory = new MemoryRepository();
    const documents: IndexerDocument[] = [
      { collection: 'markets', id: 'market-one', blockHeight: 1, data: { id: 'market-one', marketId: 1 } },
      { collection: 'markets', id: 'market-two', blockHeight: 2, data: { id: 'market-two', marketId: '2.00' } },
    ];
    await repository.upsertMany(documents);
    await memory.upsertMany(documents);

    for (const filter of [
      { marketId: { equalTo: '1.0' } },
      { marketId: { in: [1, '2'] } },
    ]) {
      const args = { first: 10, orderBy: ['ID_ASC'], filter, includeTotalCount: false } as const;
      const [postgresResult, memoryResult] = await Promise.all([
        repository.query('markets', args),
        memory.query('markets', args),
      ]);
      expect(postgresResult.items.map(({ id }) => id)).toEqual(memoryResult.items.map(({ id }) => id));
      expect(postgresResult.items.length).toBe('equalTo' in filter.marketId ? 1 : 2);
    }

    await memory.close();
  });

  it('paginates missing, null, zero, and positive numeric values with one null-last contract', async () => {
    if (!repository) throw new Error('Postgres repository was not initialized');
    const memory = new MemoryRepository();
    const documents: IndexerDocument[] = [
      { ...asset('missing', 1, 'a'), data: { id: 'missing' } },
      { ...asset('null', 2, 'b'), data: { id: 'null', liquidity: null } },
      { ...asset('zero', 3, 'c'), data: { id: 'zero', liquidity: '0' } },
      { ...asset('positive', 4, 'd'), data: { id: 'positive', liquidity: '1' } },
    ];
    await repository.upsertMany(documents);
    await memory.upsertMany(documents);

    const readAll = async (engine: PostgresRepository | MemoryRepository, orderBy: string[]) => {
      const ids: string[] = [];
      let keyset: RepositoryKeyset | undefined;
      do {
        const result: RepositoryQueryResult = await engine.query('assets', {
          first: 2,
          orderBy,
          includeTotalCount: false,
          keyset,
        });
        ids.push(...result.items.map(({ id }) => id));
        keyset = result.hasNextPage ? decodeRepositoryCursor(result.itemCursors?.at(-1)) ?? undefined : undefined;
        if (!result.hasNextPage) break;
      } while (keyset);
      return ids;
    };

    await expect(readAll(repository, ['LIQUIDITY_ASC'])).resolves.toEqual(['zero', 'positive', 'missing', 'null']);
    await expect(readAll(memory, ['LIQUIDITY_ASC'])).resolves.toEqual(['zero', 'positive', 'missing', 'null']);
    await expect(readAll(repository, ['LIQUIDITY_DESC'])).resolves.toEqual(['null', 'missing', 'positive', 'zero']);
    await expect(readAll(memory, ['LIQUIDITY_DESC'])).resolves.toEqual(['null', 'missing', 'positive', 'zero']);
    await memory.close();
  });

  it('deletes idempotently and reports database health', async () => {
    if (!repository) throw new Error('Postgres repository was not initialized');
    await repository.upsertMany([asset('keep', 1, 'keep'), asset('remove', 1, 'remove')]);

    await repository.deleteMany('assets', ['remove', 'remove', 'missing']);
    await repository.deleteMany('assets', ['remove']);

    expect(await repository.get('assets', 'remove')).toBeNull();
    expect((await repository.get('assets', 'keep'))?.data.version).toBe('keep');
    await expect(repository.healthCheck()).resolves.toBe(true);
  });

  it('shares a compatible live worker heartbeat with a split API process', async () => {
    if (!repository) throw new Error('Postgres repository was not initialized');
    const now = 1_700_000_000;
    await repository.upsert(
      createPersistedWorkerStatusDocument(
        {
          lifecycle: 'running',
          startupComplete: true,
          latestFinalizedBlock: 1_000,
          latestIndexedBlock: 995,
          lag: 5,
          lastSuccessfulIndexTimestamp: now,
          lastError: null,
          lastErrorTimestamp: null,
        },
        now
      )
    );
    await repository.upsert(
      createPersistedWorkerStatusDocument(
        {
          lifecycle: 'failed',
          startupComplete: false,
          latestFinalizedBlock: 900,
          latestIndexedBlock: 900,
          lag: 0,
          lastSuccessfulIndexTimestamp: now - 10,
          lastError: 'delayed old worker',
          lastErrorTimestamp: now - 10,
        },
        now - 1
      )
    );

    await expect(
      evaluateServiceReadiness(
        repository,
        undefined,
        { maxLagBlocks: 25, maxStalenessSeconds: 120 },
        now
      )
    ).resolves.toMatchObject({
      ok: true,
      repositoryReady: true,
      worker: { available: true, ready: true },
    });
  });

  it('serializes capture writers through commit so visible sequence order cannot skip an older transaction', async () => {
    const processLock = await acquireMigrationProcessLock(adminPool);
    const first = await adminPool.connect();
    const second = await adminPool.connect();
    try {
      await installChangeCapture(processLock);
      await first.query('begin');
      await first.query(
        `insert into indexer_documents(collection, id, block_height, timestamp, data)
         values ('assets', 'first', 1, 1, '{"id":"first"}'::jsonb)`
      );

      let secondSettled = false;
      const secondInsert = second
        .query(
          `insert into indexer_documents(collection, id, block_height, timestamp, data)
           values ('assets', 'second', 2, 2, '{"id":"second"}'::jsonb)`
        )
        .then(() => {
          secondSettled = true;
        });
      await sleep(50);
      expect(secondSettled).toBe(false);

      await first.query('commit');
      await secondInsert;
      const changes = await adminPool.query<{
        seq: string;
        sourceId: string;
        id: string;
        previousSeq: string;
        previousHash: string;
        rowHash: string;
        operation: 'I';
        collection: string;
        blockHeight: string;
        timestamp: string;
        dataText: string;
        hashBytes: number;
        hashType: string;
      }>(
        `select seq::text, source_id::text as "sourceId", id,
                previous_seq::text as "previousSeq", encode(previous_hash, 'hex') as "previousHash",
                encode(row_hash, 'hex') as "rowHash", operation::text as operation, collection,
                block_height::text as "blockHeight", timestamp::text as timestamp,
                data::text as "dataText", octet_length(row_hash) as "hashBytes",
                pg_typeof(row_hash)::text as "hashType"
           from ${CHANGE_TABLE}
          where seq > 0
          order by seq`
      );
      expect(changes.rows.map(({ seq, id }) => [seq, id])).toEqual([
        ['1', 'first'],
        ['2', 'second'],
      ]);
      expect(changes.rows[1]?.previousSeq).toBe('1');
      expect(changes.rows[1]?.previousHash).toBe(changes.rows[0]?.rowHash);
      for (const change of changes.rows) {
        expect(change).toMatchObject({ hashBytes: 32, hashType: 'bytea' });
        expect(change.rowHash).toBe(capturedChangeHash(change));
      }
    } finally {
      await first.query('rollback').catch(() => undefined);
      first.release();
      second.release();
      await releaseMigrationProcessLock(processLock);
    }
  });

  it('rejects source truncation, key-changing updates, log mutation, malformed rows, and all post-seal writes', async () => {
    const processLock = await acquireMigrationProcessLock(adminPool);
    try {
      const capture = await installChangeCapture(processLock);
      await expect(adminPool.query('truncate table indexer_documents')).rejects.toThrow(/cannot be truncated/);
      await adminPool.query(
        `insert into indexer_documents(collection, id, block_height, timestamp, data)
         values ('assets', 'xor', 1, 1, '{"id":"xor"}'::jsonb)`
      );
      await expect(
        adminPool.query(
          `update indexer_documents
              set id = 'renamed', data = jsonb_set(data, '{id}', '"renamed"'::jsonb)
            where collection = 'assets' and id = 'xor'`
        )
      ).rejects.toThrow(/primary-key updates are forbidden/);
      await expect(adminPool.query(`delete from ${CHANGE_TABLE} where seq = 1`)).rejects.toThrow(/append-only/);
      await expect(adminPool.query(`truncate table ${CHANGE_TABLE}`)).rejects.toThrow(/append-only/);
      await expect(
        adminPool.query(`update ${CHANGE_STATE_TABLE} set next_seq = next_seq + 1 where singleton`)
      ).rejects.toThrow(/process lock|lifecycle/);
      await expect(adminPool.query(`delete from ${CHANGE_STATE_TABLE} where singleton`)).rejects.toThrow(
        /cannot be inserted, deleted, or truncated/
      );
      await expect(adminPool.query(`truncate table ${CHANGE_STATE_TABLE}`)).rejects.toThrow(
        /cannot be inserted, deleted, or truncated/
      );
      await expect(
        adminPool.query(
          `insert into ${CHANGE_TABLE}(
             seq, source_id, previous_seq, previous_hash, row_hash, operation, collection, id, data
           ) values (999, $1::uuid, 1, decode($2, 'hex'), decode($2, 'hex'),
                     'I', 'assets', 'malformed', null)`,
          [capture.sourceId, 'f'.repeat(64)]
        )
      ).rejects.toThrow();
      await expect(
        adminPool.query(
          `insert into ${CHANGE_TABLE}(
             seq, source_id, previous_seq, previous_hash, row_hash, operation,
             collection, id, block_height, timestamp, data
           ) select next_seq + 1, source_id, next_seq, head_hash, decode(repeat('f', 64), 'hex'), 'I',
                    'assets', 'forged-but-shaped', 2, 2, '{"id":"forged-but-shaped"}'::jsonb
               from ${CHANGE_STATE_TABLE} where singleton`
        )
      ).rejects.toThrow(/accepts rows only from its source capture trigger/);
      await expect(
        adminPool.query(
          `insert into indexer_documents(collection, id, block_height, timestamp, data)
           values ('notACollection', 'bad-collection', 2, 2, '{"id":"bad-collection"}'::jsonb)`
        )
      ).rejects.toThrow();
      await expect(
        adminPool.query(
          `insert into indexer_documents(collection, id, block_height, timestamp, data)
           values ('assets', 'negative-height', -1, 2, '{"id":"negative-height"}'::jsonb)`
        )
      ).rejects.toThrow();

      const functionDefinition = await adminPool.query<{ definition: string }>(
        `select pg_get_functiondef($1::regprocedure) as definition`,
        ['polkaswap_indexer_migration.capture_indexer_documents_change()']
      );
      expect(functionDefinition.rows[0]?.definition).toContain('sha256(');
      expect(functionDefinition.rows[0]?.definition).not.toMatch(/\b(?:md5|digest)\s*\(/i);

      const seal = await beginChangeCaptureSeal(processLock);
      const sealedSeq = seal.descriptor.sealedSeq;
      await seal.commit();
      expect(sealedSeq).toBe('1');
      await expect(
        adminPool.query(
          `insert into indexer_documents(collection, id, block_height, timestamp, data)
           values ('assets', 'late', 2, 2, '{"id":"late"}'::jsonb)`
        )
      ).rejects.toThrow(/sealed after PostgreSQL-to-RocksDB cutover/);
      await expect(readChangeCaptureDescriptor(adminPool)).resolves.toMatchObject({
        sealed: true,
        sealedSeq: '1',
      });
    } finally {
      await releaseMigrationProcessLock(processLock);
    }
  });

  it('seals at the exact committed high-water and rejects a writer queued behind the final fence', async () => {
    const processLock = await acquireMigrationProcessLock(adminPool);
    const writer = await adminPool.connect();
    try {
      await installChangeCapture(processLock);
      await writer.query('begin');
      await writer.query(
        `insert into indexer_documents(collection, id, block_height, timestamp, data)
         values ('assets', 'committing-before-seal', 1, 1, '{"id":"committing-before-seal"}'::jsonb)`
      );

      let sealSettled = false;
      const sealing = beginChangeCaptureSeal(processLock).then((seal) => {
        sealSettled = true;
        return seal;
      });
      await sleep(50);
      expect(sealSettled).toBe(false);
      await writer.query('commit');

      const seal = await sealing;
      expect(seal.descriptor).toMatchObject({
        headSeq: '1',
        sealed: true,
        sealedSeq: '1',
        sealedHash: seal.descriptor.headHash,
      });

      let lateWriterSettled = false;
      const lateWriter = adminPool.query(
          `insert into indexer_documents(collection, id, block_height, timestamp, data)
           values ('assets', 'queued-behind-seal', 2, 2, '{"id":"queued-behind-seal"}'::jsonb)`
        )
        .then(
          () => {
            lateWriterSettled = true;
            return null;
          },
          (error: unknown) => {
            lateWriterSettled = true;
            return error;
          }
        );
      await sleep(50);
      expect(lateWriterSettled).toBe(false);
      await seal.commit();
      const lateWriterError = await lateWriter;
      expect(lateWriterError).toBeInstanceOf(Error);
      expect((lateWriterError as Error).message).toMatch(/sealed after PostgreSQL-to-RocksDB cutover/);

      const descriptor = await readChangeCaptureDescriptor(adminPool);
      expect(descriptor).toMatchObject({ headSeq: '1', sealedSeq: '1', headHash: descriptor.sealedHash });
    } finally {
      await writer.query('rollback').catch(() => undefined);
      writer.release();
      await releaseMigrationProcessLock(processLock);
    }
  });

  it('detects a missing/recreated change log and rotates generation only after explicit capture reset', async () => {
    const processLock = await acquireMigrationProcessLock(adminPool);
    try {
      const first = await installChangeCapture(processLock);
      await adminPool.query(`drop table ${CHANGE_TABLE}`);
      await expect(installChangeCapture(processLock)).rejects.toThrow(/missing from an existing capture generation/);

      await forceResetCapture();
      const second = await installChangeCapture(processLock);
      expect(second.sourceId).not.toBe(first.sourceId);
    } finally {
      await releaseMigrationProcessLock(processLock);
    }
  });

  it('captures inserts that land behind an already-exported keyset cursor', async () => {
    await adminPool.query(
      `insert into indexer_documents(collection, id, block_height, timestamp, data) values
       ('assets', 'asset-a', 1, 1, '{"id":"asset-a"}'::jsonb),
       ('assets', 'asset-c', 3, 3, '{"id":"asset-c"}'::jsonb)`
    );
    const processLock = await acquireMigrationProcessLock(adminPool);
    try {
      await installChangeCapture(processLock);
      const firstPage = await adminPool.query<{ id: string }>(
        `select id from indexer_documents where collection = 'assets' order by id collate "C" limit 1`
      );
      expect(firstPage.rows[0]?.id).toBe('asset-a');
      await adminPool.query(
        `insert into indexer_documents(collection, id, block_height, timestamp, data) values
         ('assets', 'asset-0-behind', 2, 2, '{"id":"asset-0-behind"}'::jsonb),
         ('assets', 'asset-b-ahead', 2, 2, '{"id":"asset-b-ahead"}'::jsonb)`
      );
      const remainder = await adminPool.query<{ id: string }>(
        `select id from indexer_documents
          where collection = 'assets' and id collate "C" > $1 collate "C"
          order by id collate "C"`,
        [firstPage.rows[0]!.id]
      );
      expect(remainder.rows.map(({ id }) => id)).toEqual(['asset-b-ahead', 'asset-c']);
      const captured = await adminPool.query<{ id: string }>(
        `select id from ${CHANGE_TABLE} where seq > 0 order by seq`
      );
      expect(captured.rows.map(({ id }) => id)).toEqual(['asset-0-behind', 'asset-b-ahead']);
    } finally {
      await releaseMigrationProcessLock(processLock);
    }
  });

  it('publishes a serveable destination only after sealed logical verification and a durable cutover receipt', async () => {
    if (!repository) throw new Error('Postgres repository was not initialized');
    const migrationSeeds = Array.from({ length: 100 }, (_, index) => {
      const id = `seed-${String(index).padStart(3, '0')}`;
      const document = asset(id, 30 + index, `seed-${index}`);
      return { ...document, data: { ...document.data, payload: 'x'.repeat(1_500) } };
    });
    await repository.upsertMany([asset('xor', 10, 'source-xor'), asset('val', 20, 'source-val'), ...migrationSeeds]);
    await adminPool.query(
      `insert into indexer_documents(collection, id, block_height, timestamp, data)
       values ('assets', 'exact-jsonb-number', 21, 21,
               '{"id":"exact-jsonb-number","scaled":1.2300,"tiny":1.2e-3,"numericString":"9007199254740992"}'::jsonb)`
    );
    await repository.close();
    repository = null;

    const tempDir = await mkdtemp(join(tmpdir(), 'polkaswap-migration-integration-'));
    const rocksdbPath = join(tempDir, 'destination.rocksdb');
    const previous = {
      databaseUrl: process.env.DATABASE_URL,
      rocksdbPath: process.env.ROCKSDB_PATH,
      storageEngine: process.env.STORAGE_ENGINE,
      follow: process.env.ROCKSDB_MIGRATION_FOLLOW,
      batchSize: process.env.ROCKSDB_MIGRATION_BATCH_SIZE,
      batchBytes: process.env.ROCKSDB_MIGRATION_BATCH_BYTES,
      replayBatchSize: process.env.ROCKSDB_CHANGE_REPLAY_BATCH_SIZE,
      replayBatchBytes: process.env.ROCKSDB_CHANGE_REPLAY_BATCH_BYTES,
      drop: process.env.ROCKSDB_DROP_CHANGE_TABLE,
      dropConfirm: process.env.ROCKSDB_DROP_CHANGE_TABLE_CONFIRM,
    };
    let rocks: RocksRepository | null = null;
    try {
      process.env.DATABASE_URL = databaseUrl;
      process.env.ROCKSDB_PATH = rocksdbPath;
      process.env.STORAGE_ENGINE = 'rocksdb';
      process.env.ROCKSDB_MIGRATION_FOLLOW = 'false';
      process.env.ROCKSDB_MIGRATION_BATCH_SIZE = '100';
      process.env.ROCKSDB_MIGRATION_BATCH_BYTES = '8192';
      process.env.ROCKSDB_CHANGE_REPLAY_BATCH_SIZE = '100';
      process.env.ROCKSDB_CHANGE_REPLAY_BATCH_BYTES = '8192';
      delete process.env.ROCKSDB_DROP_CHANGE_TABLE;

      const migration = runPostgresToRocksdbMigration();
      void migration.catch(() => undefined);
      let captureVisible = false;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const exists = await adminPool.query<{ exists: boolean }>('select to_regclass($1) is not null as exists', [
          CHANGE_TABLE,
        ]);
        if (exists.rows[0]?.exists) {
          captureVisible = true;
          break;
        }
        await sleep(5);
      }
      expect(captureVisible).toBe(true);
      await sleep(25);
      await adminPool.query(
        `insert into indexer_documents(collection, id, block_height, timestamp, data)
         values ('assets', '000-replayed-behind', 500, 500, $1::jsonb)`,
        [JSON.stringify({ id: '000-replayed-behind', version: 'captured', payload: 'y'.repeat(1_500) })]
      );
      await migration;
      const crashWindow = new RocksRepository(readConfig(), { allowIncompleteMigration: true });
      await crashWindow.prepare();
      const completedBeforeCrash = crashWindow.getMetadata<Record<string, unknown>>(
        'postgresToRocksdbMigration'
      );
      expect(completedBeforeCrash).toMatchObject({ status: 'validated_complete' });
      expect(BigInt(String(completedBeforeCrash?.lastReplayedSeq))).toBeGreaterThan(
        BigInt(String(completedBeforeCrash?.captureStartSeq))
      );
      if (!completedBeforeCrash) throw new Error('Completed migration receipt was not persisted');
      await crashWindow.setMetadata('postgresToRocksdbMigration', {
        ...completedBeforeCrash,
        status: 'in_progress',
        sealedSeq: null,
        sealedHash: null,
        validatedAt: null,
        lastError: null,
      });
      await crashWindow.close();

      const refusedCrashArtifact = new RocksRepository(readConfig());
      await expect(refusedCrashArtifact.prepare()).rejects.toThrow(/incomplete or failed PostgreSQL migration artifact/);
      await refusedCrashArtifact.close();
      // This is the durable-source-receipt / unpublished-destination crash
      // window. A rerun must repeat exhaustive verification and publish the
      // destination receipt without reopening source writes.
      await runPostgresToRocksdbMigration();
      rocks = new RocksRepository(readConfig());
      await rocks.prepare();
      await expect(rocks.get('assets', 'xor')).resolves.toMatchObject({ data: { version: 'source-xor' } });
      await expect(rocks.get('assets', 'val')).resolves.toMatchObject({ data: { version: 'source-val' } });
      await expect(rocks.get('assets', 'exact-jsonb-number')).resolves.toMatchObject({
        data: { scaled: 1.23, tiny: 0.0012, numericString: '9007199254740992' },
      });
      await expect(rocks.get('assets', '000-replayed-behind')).resolves.toMatchObject({
        data: { version: 'captured' },
      });
      expect(rocks.getMetadata<Record<string, unknown>>('postgresToRocksdbMigration')).toMatchObject({
        version: 1,
        status: 'validated_complete',
      });
      const capture = await readChangeCaptureDescriptor(adminPool);
      expect(capture).toMatchObject({
        sealed: true,
        sealedSeq: capture.headSeq,
        sealedHash: capture.headHash,
      });
      expect(capture.cutoverRunId).toBeTypeOf('string');
      expect(capture.cutoverDestinationId).toBeTypeOf('string');
      const hashStorage = await adminPool.query<{
        headType: string;
        sealedType: string;
        cutoverType: string;
        headBytes: number;
        sealedBytes: number;
        cutoverBytes: number;
      }>(
        `select pg_typeof(head_hash)::text as "headType",
                pg_typeof(sealed_hash)::text as "sealedType",
                pg_typeof(cutover_hash)::text as "cutoverType",
                octet_length(head_hash) as "headBytes",
                octet_length(sealed_hash) as "sealedBytes",
                octet_length(cutover_hash) as "cutoverBytes"
           from ${CHANGE_STATE_TABLE}
          where singleton`
      );
      expect(hashStorage.rows[0]).toEqual({
        headType: 'bytea',
        sealedType: 'bytea',
        cutoverType: 'bytea',
        headBytes: 32,
        sealedBytes: 32,
        cutoverBytes: 32,
      });

      await cleanupPostgresRocksdbCapture();
      await expect(
        adminPool.query(
          `insert into indexer_documents(collection, id, block_height, timestamp, data)
           values ('assets', 'post-cleanup', 30, 30, '{"id":"post-cleanup"}'::jsonb)`
        )
      ).rejects.toThrow(/permanently fenced after validated PostgreSQL-to-RocksDB cutover/);
      await expect(adminPool.query('truncate table indexer_documents')).rejects.toThrow(
        /permanently fenced after validated PostgreSQL-to-RocksDB cutover/
      );
      await expect(
        adminPool.query(`update ${CHANGE_STATE_TABLE} set sealed = false where singleton`)
      ).rejects.toThrow(/validated cutover receipt is immutable/);
      await expect(adminPool.query(`delete from ${CHANGE_STATE_TABLE} where singleton`)).rejects.toThrow(
        /cannot be inserted, deleted, or truncated/
      );
      await expect(adminPool.query(`truncate table ${CHANGE_STATE_TABLE}`)).rejects.toThrow(
        /cannot be inserted, deleted, or truncated/
      );

      await expect(
        adminPool.query<{ exists: boolean }>('select to_regclass($1) is not null as exists', [CHANGE_TABLE])
      ).resolves.toMatchObject({ rows: [{ exists: true }] });
      process.env.ROCKSDB_DROP_CHANGE_TABLE = 'true';
      process.env.ROCKSDB_DROP_CHANGE_TABLE_CONFIRM = `DROP:${CHANGE_TABLE}`;
      await cleanupPostgresRocksdbCapture();
      await expect(
        adminPool.query<{ exists: boolean }>('select to_regclass($1) is not null as exists', [CHANGE_TABLE])
      ).resolves.toMatchObject({ rows: [{ exists: false }] });
      const postCleanupLock = await acquireMigrationProcessLock(adminPool);
      try {
        await expect(installChangeCapture(postCleanupLock)).rejects.toThrow(
          /missing from an existing capture generation/
        );
      } finally {
        await releaseMigrationProcessLock(postCleanupLock);
      }
      await expect(
        adminPool.query(
          `insert into indexer_documents(collection, id, block_height, timestamp, data)
           values ('assets', 'post-log-drop', 31, 31, '{"id":"post-log-drop"}'::jsonb)`
        )
      ).rejects.toThrow(/permanently fenced after validated PostgreSQL-to-RocksDB cutover/);
    } finally {
      await rocks?.close().catch(() => undefined);
      const restore = (name: string, value: string | undefined) => {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      };
      restore('DATABASE_URL', previous.databaseUrl);
      restore('ROCKSDB_PATH', previous.rocksdbPath);
      restore('STORAGE_ENGINE', previous.storageEngine);
      restore('ROCKSDB_MIGRATION_FOLLOW', previous.follow);
      restore('ROCKSDB_MIGRATION_BATCH_SIZE', previous.batchSize);
      restore('ROCKSDB_MIGRATION_BATCH_BYTES', previous.batchBytes);
      restore('ROCKSDB_CHANGE_REPLAY_BATCH_SIZE', previous.replayBatchSize);
      restore('ROCKSDB_CHANGE_REPLAY_BATCH_BYTES', previous.replayBatchBytes);
      restore('ROCKSDB_DROP_CHANGE_TABLE', previous.drop);
      restore('ROCKSDB_DROP_CHANGE_TABLE_CONFIRM', previous.dropConfirm);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('refuses any untracked RocksDB destination key even when no document is present', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'polkaswap-untracked-destination-'));
    const rocksdbPath = join(tempDir, 'destination.rocksdb');
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousRocksdbPath = process.env.ROCKSDB_PATH;
    const previousStorageEngine = process.env.STORAGE_ENGINE;
    let rocks: RocksRepository | null = null;
    try {
      process.env.DATABASE_URL = databaseUrl;
      process.env.ROCKSDB_PATH = rocksdbPath;
      process.env.STORAGE_ENGINE = 'rocksdb';
      rocks = new RocksRepository(readConfig());
      await rocks.prepare();
      const raw = rocks as unknown as { db: RocksDatabase };
      await raw.db.put(['x', 'assets', 'orphan-index-only'], 1);
      await rocks.close();
      rocks = null;

      await expect(runPostgresToRocksdbMigration()).rejects.toThrow(/non-empty RocksDB destination/);
    } finally {
      await rocks?.close().catch(() => undefined);
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      if (previousRocksdbPath === undefined) delete process.env.ROCKSDB_PATH;
      else process.env.ROCKSDB_PATH = previousRocksdbPath;
      if (previousStorageEngine === undefined) delete process.env.STORAGE_ENGINE;
      else process.env.STORAGE_ENGINE = previousStorageEngine;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('prevents cleanup/migrator races with one process-wide session lock', async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = databaseUrl;
    const processLock = await acquireMigrationProcessLock(adminPool);
    const unlockedClient = await adminPool.connect();
    try {
      await expect(acquireMigrationProcessLock(adminPool)).rejects.toThrow(/already running/);
      await expect(installChangeCapture(unlockedClient)).rejects.toThrow(/process lock must be held by this session/);
      await expect(cleanupPostgresRocksdbCapture()).rejects.toThrow(/already running/);
    } finally {
      unlockedClient.release();
      await releaseMigrationProcessLock(processLock);
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }
  });
});
