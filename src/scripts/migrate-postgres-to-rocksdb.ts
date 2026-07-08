import { setTimeout as sleep } from 'node:timers/promises';

import pg from 'pg';

import { readConfig } from '../config.js';
import { RocksRepository } from '../repository/rocksdb.js';

import type { IndexerCollection, IndexerDocument } from '../repository/types.js';

const { Pool } = pg;

type MigrationState = {
  collection: string;
  id: string;
  rows: number;
  exportCompleted?: boolean;
  captureStartSeq?: number;
  lastReplayedSeq?: number;
};

type ChangeRow = {
  seq: string;
  operation: 'I' | 'U' | 'D';
  collection: IndexerCollection;
  id: string;
  blockHeight: number | null;
  timestamp: number | null;
  data: Record<string, unknown> | null;
};

const CHECKPOINT_KEY = 'postgres-to-rocksdb-checkpoint-v2';
const LEGACY_CHECKPOINT_KEY = 'postgres-to-rocksdb-checkpoint-v1';
const CHANGE_SCHEMA = 'polkaswap_indexer_migration';
const CHANGE_TABLE = `${CHANGE_SCHEMA}.rocksdb_changes`;
const CHANGE_TRIGGER = 'indexer_documents_rocksdb_changes_trigger';
const CHANGE_FUNCTION = `${CHANGE_SCHEMA}.capture_indexer_documents_change`;

const readPositiveInteger = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);

  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
};

const readBoolean = (name: string, fallback: boolean): boolean => {
  const value = process.env[name];
  if (value === undefined) return fallback;

  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};

const rowToDocument = (row: {
  collection: IndexerCollection;
  id: string;
  blockHeight: number | null;
  timestamp: number | null;
  data: Record<string, unknown>;
}): IndexerDocument => ({
  collection: row.collection,
  id: row.id,
  blockHeight: row.blockHeight,
  timestamp: row.timestamp,
  data: row.data,
});

const installChangeCapture = async (pool: pg.Pool): Promise<void> => {
  await pool.query(`create schema if not exists ${CHANGE_SCHEMA};`);
  await pool.query(`
    create table if not exists ${CHANGE_TABLE} (
      seq bigserial primary key,
      changed_at timestamptz not null default now(),
      operation char(1) not null,
      collection text not null,
      id text not null,
      block_height bigint,
      timestamp bigint,
      data jsonb
    );
  `);
  await pool.query(`
    create or replace function ${CHANGE_FUNCTION}()
    returns trigger
    language plpgsql
    as $$
    begin
      if tg_op = 'DELETE' then
        insert into ${CHANGE_TABLE}(operation, collection, id, block_height, timestamp, data)
        values ('D', old.collection, old.id, old.block_height, old.timestamp, null);
        return old;
      end if;

      insert into ${CHANGE_TABLE}(operation, collection, id, block_height, timestamp, data)
      values (substring(tg_op from 1 for 1), new.collection, new.id, new.block_height, new.timestamp, new.data);
      return new;
    end;
    $$;
  `);
  await pool.query(`drop trigger if exists ${CHANGE_TRIGGER} on indexer_documents;`);
  await pool.query(`
    create trigger ${CHANGE_TRIGGER}
    after insert or update or delete on indexer_documents
    for each row execute function ${CHANGE_FUNCTION}();
  `);
};

const currentChangeSeq = async (pool: pg.Pool): Promise<number> => {
  const result = await pool.query<{ seq: string }>(`select coalesce(max(seq), 0)::text as seq from ${CHANGE_TABLE};`);

  return Number(result.rows[0]?.seq ?? 0);
};

const saveState = async (repository: RocksRepository, state: MigrationState): Promise<void> => {
  await repository.setMetadata(CHECKPOINT_KEY, state);
};

const loadState = (repository: RocksRepository): MigrationState => {
  const current = repository.getMetadata<MigrationState>(CHECKPOINT_KEY);
  if (current) return current;

  const legacy = repository.getMetadata<MigrationState>(LEGACY_CHECKPOINT_KEY);

  return {
    collection: legacy?.collection ?? '',
    id: legacy?.id ?? '',
    rows: legacy?.rows ?? 0,
    exportCompleted: legacy?.exportCompleted ?? false,
    captureStartSeq: legacy?.captureStartSeq,
    lastReplayedSeq: legacy?.lastReplayedSeq,
  };
};

const exportPostgresRows = async (
  pool: pg.Pool,
  repository: RocksRepository,
  state: MigrationState,
  batchSize: number
): Promise<MigrationState> => {
  if (state.exportCompleted) {
    console.info(`Postgres export already complete at ${state.rows} rows`);
    return state;
  }

  let nextState = state;

  while (true) {
    const result = await pool.query<{
      collection: IndexerCollection;
      id: string;
      blockHeight: number | null;
      timestamp: number | null;
      data: Record<string, unknown>;
    }>(
      `select collection,
              id,
              block_height as "blockHeight",
              timestamp,
              data
       from indexer_documents
       where (collection, id) > ($1::text, $2::text)
       order by collection, id
       limit $3::int`,
      [nextState.collection, nextState.id, batchSize]
    );

    if (!result.rows.length) {
      nextState = { ...nextState, exportCompleted: true };
      await saveState(repository, nextState);
      console.info(`Postgres export complete: ${nextState.rows} rows`);
      return nextState;
    }

    await repository.upsertMany(result.rows.map(rowToDocument));

    const last = result.rows[result.rows.length - 1];
    nextState = {
      ...nextState,
      collection: last.collection,
      id: last.id,
      rows: nextState.rows + result.rows.length,
    };
    await saveState(repository, nextState);

    console.info(`Exported ${nextState.rows} rows through ${nextState.collection}/${nextState.id}`);
  }
};

const applyChangeBatch = async (repository: RocksRepository, rows: ChangeRow[]): Promise<void> => {
  let pendingUpserts: IndexerDocument[] = [];

  const flushUpserts = async () => {
    if (!pendingUpserts.length) return;

    await repository.upsertMany(pendingUpserts);
    pendingUpserts = [];
  };

  for (const row of rows) {
    if (row.operation === 'D') {
      await flushUpserts();
      await repository.deleteMany(row.collection, [row.id]);
      continue;
    }

    if (!row.data) continue;
    pendingUpserts.push({
      collection: row.collection,
      id: row.id,
      blockHeight: row.blockHeight,
      timestamp: row.timestamp,
      data: row.data,
    });
  }

  await flushUpserts();
};

const replayChanges = async (
  pool: pg.Pool,
  repository: RocksRepository,
  state: MigrationState,
  batchSize: number
): Promise<MigrationState> => {
  let nextState = state;
  const startSeq = nextState.lastReplayedSeq ?? nextState.captureStartSeq ?? 0;

  while (true) {
    const result = await pool.query<ChangeRow>(
      `select seq::text,
              operation::text as operation,
              collection,
              id,
              block_height as "blockHeight",
              timestamp,
              data
       from ${CHANGE_TABLE}
       where seq > $1::bigint
       order by seq
       limit $2::int`,
      [nextState.lastReplayedSeq ?? startSeq, batchSize]
    );

    if (!result.rows.length) return nextState;

    await applyChangeBatch(repository, result.rows);

    const lastSeq = Number(result.rows[result.rows.length - 1].seq);
    nextState = { ...nextState, lastReplayedSeq: lastSeq };
    await saveState(repository, nextState);

    console.info(`Replayed ${result.rows.length} Postgres change(s) through seq ${lastSeq}`);
  }
};

const config = readConfig();
const batchSize = readPositiveInteger('ROCKSDB_MIGRATION_BATCH_SIZE', 5_000);
const changeBatchSize = readPositiveInteger('ROCKSDB_CHANGE_REPLAY_BATCH_SIZE', 10_000);
const follow = readBoolean('ROCKSDB_MIGRATION_FOLLOW', false);
const pollMs = readPositiveInteger('ROCKSDB_MIGRATION_FOLLOW_POLL_MS', 2_000);
const pool = new Pool({ connectionString: config.databaseUrl });
const repository = new RocksRepository({ ...config, storageEngine: 'rocksdb' });

try {
  await installChangeCapture(pool);

  let state = loadState(repository);
  if (state.captureStartSeq === undefined) {
    const seq = await currentChangeSeq(pool);
    state = { ...state, captureStartSeq: seq, lastReplayedSeq: seq };
    await saveState(repository, state);
    console.info(`Started Postgres change capture at seq ${state.captureStartSeq}`);
  }

  state = await exportPostgresRows(pool, repository, state, batchSize);

  while (true) {
    const beforeReplaySeq = state.lastReplayedSeq ?? state.captureStartSeq ?? 0;
    state = await replayChanges(pool, repository, state, changeBatchSize);
    const afterReplaySeq = state.lastReplayedSeq ?? beforeReplaySeq;

    if (!follow) break;
    if (afterReplaySeq === beforeReplaySeq) await sleep(pollMs);
  }
} finally {
  await repository.close().catch(() => undefined);
  await pool.end();
}
