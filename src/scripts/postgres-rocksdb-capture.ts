import { createHash, randomUUID } from 'node:crypto';

import pg from 'pg';

import { INDEXER_COLLECTIONS } from '../repository/types.js';

export const CHANGE_SCHEMA = 'polkaswap_indexer_migration';
export const CHANGE_TABLE = `${CHANGE_SCHEMA}.rocksdb_changes`;
export const CHANGE_STATE_TABLE = `${CHANGE_SCHEMA}.rocksdb_capture_state`;
export const CHANGE_TRIGGER = 'indexer_documents_rocksdb_changes_trigger';
export const CHANGE_WRITER_GUARD_TRIGGER = 'indexer_documents_rocksdb_writer_guard_trigger';
export const CHANGE_APPEND_ONLY_TRIGGER = 'rocksdb_changes_append_only_trigger';
export const CHANGE_INSERT_GUARD_TRIGGER = 'rocksdb_changes_insert_guard_trigger';
export const CHANGE_STATE_UPDATE_GUARD_TRIGGER = 'rocksdb_capture_state_update_guard_trigger';
export const CHANGE_STATE_MUTATION_GUARD_TRIGGER = 'rocksdb_capture_state_mutation_guard_trigger';
export const CHANGE_FUNCTION = `${CHANGE_SCHEMA}.capture_indexer_documents_change`;
export const CHANGE_WRITER_GUARD_FUNCTION = `${CHANGE_SCHEMA}.guard_indexer_documents_write`;
export const CHANGE_APPEND_ONLY_FUNCTION = `${CHANGE_SCHEMA}.reject_change_log_mutation`;
export const CHANGE_INSERT_GUARD_FUNCTION = `${CHANGE_SCHEMA}.guard_change_log_insert`;
export const CHANGE_STATE_UPDATE_GUARD_FUNCTION = `${CHANGE_SCHEMA}.guard_capture_state_update`;
export const CHANGE_STATE_MUTATION_GUARD_FUNCTION = `${CHANGE_SCHEMA}.reject_capture_state_mutation`;

/** Session lock shared by the migrator and cleanup command. */
export const MIGRATION_PROCESS_LOCK_KEY = 4_350_435_101;
/** Transaction lock held by every source-table writer until commit. */
export const CAPTURE_WRITER_LOCK_KEY = 4_350_435_102;

const NULL_HASH = '0'.repeat(64);
const CAPTURE_VERSION = 1;
const CAPTURE_COLLECTIONS_SQL = INDEXER_COLLECTIONS.map((collection) => `'${collection}'`).join(', ');
const MIGRATION_PROCESS_LOCK_CLASS_ID = Math.floor(MIGRATION_PROCESS_LOCK_KEY / 2 ** 32);
const MIGRATION_PROCESS_LOCK_OBJECT_ID = MIGRATION_PROCESS_LOCK_KEY >>> 0;

type Queryable = pg.Pool | pg.PoolClient;

type CaptureStateRow = {
  version: number;
  sourceId: string;
  sourceDatabaseIdentity: string;
  nextSeq: string;
  headHash: string;
  sealed: boolean;
  sealedSeq: string | null;
  sealedHash: string | null;
  cutoverRunId: string | null;
  cutoverDestinationId: string | null;
  cutoverSeq: string | null;
  cutoverHash: string | null;
};

export type ChangeCaptureDescriptor = {
  version: 1;
  sourceId: string;
  sourceDatabaseIdentity: string;
  headSeq: string;
  headHash: string;
  sealed: boolean;
  sealedSeq: string | null;
  sealedHash: string | null;
  cutoverRunId: string | null;
  cutoverDestinationId: string | null;
  cutoverSeq: string | null;
  cutoverHash: string | null;
};

export type CapturedChangeHashInput = {
  sourceId: string;
  seq: string;
  previousSeq: string;
  previousHash: string;
  operation: 'I' | 'U' | 'D';
  collection: string;
  id: string;
  blockHeight: string | number | null;
  timestamp: string | number | null;
  dataText: string | null;
};

const hashText = (value: string): string => createHash('sha256').update(value).digest('hex');

export const captureSentinelHash = (sourceId: string): string =>
  hashText(`polkaswap-indexer-capture-v${CAPTURE_VERSION}:${sourceId}`);

export const capturedChangeHash = (input: CapturedChangeHashInput): string =>
  hashText(
    [
      input.sourceId,
      input.seq,
      input.previousSeq,
      input.previousHash,
      input.operation,
      input.collection,
      input.id,
      input.blockHeight ?? 'null',
      input.timestamp ?? 'null',
      input.dataText ?? 'null',
    ].join('\x1f')
  );

const sourceDatabaseIdentity = async (client: pg.PoolClient): Promise<string> => {
  const result = await client.query<{ databaseName: string; databaseOid: string }>(
    `select current_database() as "databaseName",
            (select oid::text from pg_catalog.pg_database where datname = current_database()) as "databaseOid"`
  );
  const row = result.rows[0];
  if (!row?.databaseName || !/^[0-9]+$/.test(row.databaseOid)) {
    throw new Error('Unable to identify the PostgreSQL source database');
  }

  return createHash('sha256')
    .update(`postgres-source-v1\0${row.databaseName}\0${row.databaseOid}`)
    .digest('hex');
};

const validateDescriptor = async (queryable: Queryable): Promise<ChangeCaptureDescriptor> => {
  const stateResult = await queryable.query<CaptureStateRow>(
    `select version,
            source_id::text as "sourceId",
            source_database_identity as "sourceDatabaseIdentity",
            next_seq::text as "nextSeq",
            encode(head_hash, 'hex') as "headHash",
            sealed,
            sealed_seq::text as "sealedSeq",
            encode(sealed_hash, 'hex') as "sealedHash",
            cutover_run_id::text as "cutoverRunId",
            cutover_destination_id::text as "cutoverDestinationId",
            cutover_seq::text as "cutoverSeq",
            encode(cutover_hash, 'hex') as "cutoverHash"
       from ${CHANGE_STATE_TABLE}
       where singleton`
  );
  const state = stateResult.rows[0];
  if (!state || state.version !== CAPTURE_VERSION) {
    throw new Error(`Missing or unsupported PostgreSQL RocksDB capture state (expected version ${CAPTURE_VERSION})`);
  }
  if (
    !/^[0-9a-f]{64}$/.test(state.sourceDatabaseIdentity) ||
    !/^[0-9a-f]{64}$/.test(state.headHash) ||
    (state.sealedHash !== null && !/^[0-9a-f]{64}$/.test(state.sealedHash)) ||
    (state.cutoverHash !== null && !/^[0-9a-f]{64}$/.test(state.cutoverHash))
  ) {
    throw new Error('PostgreSQL RocksDB capture state contains a malformed identity or SHA-256 hash');
  }

  const sentinelResult = await queryable.query<{
    sourceId: string;
    operation: string;
    collection: string;
    id: string;
    previousSeq: string;
    previousHash: string;
    blockHeight: string | null;
    timestamp: string | null;
    dataText: string | null;
    rowHash: string;
  }>(
    `select source_id::text as "sourceId", operation::text as operation, collection, id,
            previous_seq::text as "previousSeq", encode(previous_hash, 'hex') as "previousHash",
            block_height::text as "blockHeight", timestamp::text as timestamp, data::text as "dataText",
            encode(row_hash, 'hex') as "rowHash"
       from ${CHANGE_TABLE}
       where seq = 0`
  );
  const sentinel = sentinelResult.rows[0];
  const expectedSentinelHash = captureSentinelHash(state.sourceId);
  if (
    sentinelResult.rowCount !== 1 ||
    sentinel?.sourceId !== state.sourceId ||
    sentinel.operation !== 'S' ||
    sentinel.collection !== '__capture__' ||
    sentinel.id !== state.sourceId ||
    sentinel.previousSeq !== '-1' ||
    sentinel.previousHash !== NULL_HASH ||
    sentinel.blockHeight !== null ||
    sentinel.timestamp !== null ||
    sentinel.dataText !== null ||
    sentinel.rowHash !== expectedSentinelHash
  ) {
    throw new Error('PostgreSQL RocksDB change-capture sentinel is missing or does not match its generation');
  }

  const aggregateResult = await queryable.query<{
    rows: string;
    minSeq: string | null;
    maxSeq: string | null;
    foreignRows: string;
    headHash: string | null;
  }>(
    `select count(*) filter (where seq > 0)::text as rows,
            min(seq) filter (where seq > 0)::text as "minSeq",
            max(seq) filter (where seq > 0)::text as "maxSeq",
            count(*) filter (where source_id <> $1::uuid)::text as "foreignRows",
            max(encode(row_hash, 'hex')) filter (where seq = $2::bigint) as "headHash"
       from ${CHANGE_TABLE}`,
    [state.sourceId, state.nextSeq]
  );
  const aggregate = aggregateResult.rows[0];
  const nextSeq = BigInt(state.nextSeq);
  if (
    !aggregate ||
    BigInt(aggregate.foreignRows) !== 0n ||
    BigInt(aggregate.rows) !== nextSeq ||
    (nextSeq === 0n
      ? aggregate.minSeq !== null || aggregate.maxSeq !== null || state.headHash !== expectedSentinelHash
      : aggregate.minSeq !== '1' || aggregate.maxSeq !== state.nextSeq || aggregate.headHash !== state.headHash)
  ) {
    throw new Error('PostgreSQL RocksDB change-capture chain is incomplete, truncated, or from another generation');
  }
  if (
    state.sealed !== (state.sealedSeq !== null && state.sealedHash !== null) ||
    (state.sealed && (state.sealedSeq !== state.nextSeq || state.sealedHash !== state.headHash))
  ) {
    throw new Error('PostgreSQL RocksDB change-capture seal is inconsistent with its exact high-water mark');
  }
  const cutoverValues = [
    state.cutoverRunId,
    state.cutoverDestinationId,
    state.cutoverSeq,
    state.cutoverHash,
  ];
  const hasCutover = cutoverValues.every((value) => value !== null);
  if (
    cutoverValues.some((value) => value !== null) !== hasCutover ||
    (hasCutover &&
      (!state.sealed || state.cutoverSeq !== state.sealedSeq || state.cutoverHash !== state.sealedHash))
  ) {
    throw new Error('PostgreSQL RocksDB cutover receipt is incomplete or does not match the sealed high-water mark');
  }

  return {
    version: 1,
    sourceId: state.sourceId,
    sourceDatabaseIdentity: state.sourceDatabaseIdentity,
    headSeq: state.nextSeq,
    headHash: state.headHash,
    sealed: state.sealed,
    sealedSeq: state.sealedSeq,
    sealedHash: state.sealedHash,
    cutoverRunId: state.cutoverRunId,
    cutoverDestinationId: state.cutoverDestinationId,
    cutoverSeq: state.cutoverSeq,
    cutoverHash: state.cutoverHash,
  };
};

/** Holds a session lock until the returned client is explicitly released. */
export const acquireMigrationProcessLock = async (pool: pg.Pool): Promise<pg.PoolClient> => {
  const client = await pool.connect();
  try {
    const result = await client.query<{ acquired: boolean }>(
      'select pg_try_advisory_lock($1) as acquired',
      [MIGRATION_PROCESS_LOCK_KEY]
    );
    if (result.rows[0]?.acquired !== true) {
      throw new Error('Another PostgreSQL-to-RocksDB migration or capture cleanup is already running');
    }
    return client;
  } catch (error) {
    client.release();
    throw error;
  }
};

export const releaseMigrationProcessLock = async (client: pg.PoolClient): Promise<void> => {
  await client.query('select pg_advisory_unlock($1)', [MIGRATION_PROCESS_LOCK_KEY]).catch(() => undefined);
  client.release();
};

const assertMigrationProcessLockHeld = async (client: pg.PoolClient): Promise<void> => {
  const result = await client.query<{ held: boolean }>(
    `select exists (
       select 1
         from pg_catalog.pg_locks
        where locktype = 'advisory'
          and pid = pg_backend_pid()
          and granted
          and classid = $1::oid
          and objid = $2::oid
          and objsubid = 1
     ) as held`,
    [MIGRATION_PROCESS_LOCK_CLASS_ID, MIGRATION_PROCESS_LOCK_OBJECT_ID]
  );
  if (result.rows[0]?.held !== true) {
    throw new Error('The PostgreSQL-to-RocksDB migration process lock must be held by this session');
  }
};

/** Installs a commit-ordered, append-only, generation-bound source change log. */
export const installChangeCapture = async (client: pg.PoolClient): Promise<ChangeCaptureDescriptor> => {
  try {
    await assertMigrationProcessLockHeld(client);
    await client.query('begin');
    const identity = await sourceDatabaseIdentity(client);
    await client.query(`create schema if not exists ${CHANGE_SCHEMA};`);
    const existingResult = await client.query<{ exists: boolean }>(
      `select to_regclass($1) is not null as exists`,
      [CHANGE_TABLE]
    );
    const tableExisted = existingResult.rows[0]?.exists === true;

    await client.query(`
      create table if not exists ${CHANGE_STATE_TABLE} (
        singleton boolean primary key default true check (singleton),
        version integer not null check (version = ${CAPTURE_VERSION}),
        source_id uuid not null unique,
        source_database_identity text not null check (source_database_identity ~ '^[0-9a-f]{64}$'),
        next_seq bigint not null check (next_seq >= 0),
        head_hash bytea not null check (octet_length(head_hash) = 32),
        sealed boolean not null default false,
        sealed_seq bigint,
        sealed_hash bytea,
        cutover_run_id uuid,
        cutover_destination_id uuid,
        cutover_seq bigint,
        cutover_hash bytea,
        created_at timestamptz not null default clock_timestamp(),
        sealed_at timestamptz,
        cutover_completed_at timestamptz,
        check ((not sealed and sealed_seq is null and sealed_hash is null and sealed_at is null) or
               (sealed and sealed_seq is not null and sealed_hash is not null and
                sealed_seq = next_seq and sealed_hash = head_hash and
                octet_length(sealed_hash) = 32 and sealed_at is not null)),
        check ((cutover_run_id is null and cutover_destination_id is null and cutover_seq is null and
                cutover_hash is null and cutover_completed_at is null) or
               (cutover_run_id is not null and cutover_destination_id is not null and cutover_seq is not null and
                cutover_hash is not null and octet_length(cutover_hash) = 32 and
                cutover_completed_at is not null and sealed and
                cutover_seq = sealed_seq and cutover_hash = sealed_hash))
      );
    `);

    const stateCount = await client.query<{ count: string }>(`select count(*)::text as count from ${CHANGE_STATE_TABLE}`);
    if (tableExisted) {
      if (stateCount.rows[0]?.count !== '1') {
        throw new Error('Existing PostgreSQL RocksDB change table has no unique generation state; clean it up and restart');
      }
    } else {
      if (stateCount.rows[0]?.count !== '0') {
        throw new Error('PostgreSQL RocksDB change table is missing from an existing capture generation');
      }
      const sourceId = randomUUID();
      const sentinelHash = captureSentinelHash(sourceId);
      await client.query(
        `insert into ${CHANGE_STATE_TABLE}(
           singleton, version, source_id, source_database_identity, next_seq, head_hash, sealed
         ) values (true, $1, $2::uuid, $3, 0, decode($4, 'hex'), false)`,
        [CAPTURE_VERSION, sourceId, identity, sentinelHash]
      );
    }

    await client.query(`
      create table if not exists ${CHANGE_TABLE} (
        seq bigint primary key check (seq >= 0),
        source_id uuid not null,
        previous_seq bigint not null,
        previous_hash bytea not null check (octet_length(previous_hash) = 32),
        row_hash bytea not null check (octet_length(row_hash) = 32),
        changed_at timestamptz not null default clock_timestamp(),
        operation char(1) not null check (operation in ('S', 'I', 'U', 'D')),
        collection text not null,
        id text not null,
        block_height bigint,
        timestamp bigint,
        data jsonb,
        check (block_height is null or block_height between 0 and 9007199254740991),
        check (timestamp is null or timestamp between 0 and 9007199254740991),
        check (length(id) between 1 and 1024 and id collate "C" ~ '^[!-~]+$'),
        check (
          (seq = 0 and operation = 'S' and collection = '__capture__' and
           previous_seq = -1 and previous_hash = decode('${NULL_HASH}', 'hex') and
           block_height is null and timestamp is null and data is null) or
          (seq > 0 and previous_seq = seq - 1 and collection in (${CAPTURE_COLLECTIONS_SQL}) and
           ((operation in ('I', 'U') and data is not null and jsonb_typeof(data) = 'object') or
            (operation = 'D' and data is null)))
        )
      );
    `);

    if (!tableExisted) {
      await client.query(
        `insert into ${CHANGE_TABLE}(
           seq, source_id, previous_seq, previous_hash, row_hash, operation, collection, id, data
         )
         select 0, source_id, -1, decode($1, 'hex'), head_hash, 'S', '__capture__', source_id::text, null
         from ${CHANGE_STATE_TABLE}
         where singleton`,
        [NULL_HASH]
      );
    }

    const storedIdentity = await client.query<{ identity: string }>(
      `select source_database_identity as identity from ${CHANGE_STATE_TABLE} where singleton`
    );
    if (storedIdentity.rows[0]?.identity !== identity) {
      throw new Error('PostgreSQL RocksDB capture belongs to a different source database identity');
    }

    await client.query(`
      create or replace function ${CHANGE_WRITER_GUARD_FUNCTION}()
      returns trigger
      language plpgsql
      as $$
      declare capture_sealed boolean;
      begin
        perform pg_advisory_xact_lock(${CAPTURE_WRITER_LOCK_KEY});
        select sealed into capture_sealed from ${CHANGE_STATE_TABLE} where singleton;
        if capture_sealed is null then
          raise exception 'PostgreSQL RocksDB capture state is missing';
        end if;
        if tg_op = 'TRUNCATE' then
          raise exception 'indexer_documents cannot be truncated while RocksDB capture metadata exists';
        end if;
        if capture_sealed then
          raise exception 'indexer_documents is sealed after PostgreSQL-to-RocksDB cutover';
        end if;
        return null;
      end;
      $$;
    `);
    await client.query(`
      create or replace function ${CHANGE_FUNCTION}()
      returns trigger
      language plpgsql
      as $$
      declare capture_source uuid;
      declare next_capture_seq bigint;
      declare predecessor_seq bigint;
      declare predecessor_hash bytea;
      declare change_operation char(1);
      declare change_collection text;
      declare change_id text;
      declare change_block_height bigint;
      declare change_timestamp bigint;
      declare change_data jsonb;
      declare change_hash bytea;
      begin
        if tg_op = 'UPDATE' and (old.collection, old.id) is distinct from (new.collection, new.id) then
          raise exception 'indexer_documents primary-key updates are forbidden during RocksDB change capture';
        end if;

        select source_id, next_seq + 1, next_seq, head_hash
          into capture_source, next_capture_seq, predecessor_seq, predecessor_hash
          from ${CHANGE_STATE_TABLE}
          where singleton
          for update;
        if capture_source is null then
          raise exception 'PostgreSQL RocksDB capture state is missing';
        end if;

        change_operation := substring(tg_op from 1 for 1);
        if tg_op = 'DELETE' then
          change_collection := old.collection;
          change_id := old.id;
          change_block_height := old.block_height;
          change_timestamp := old.timestamp;
          change_data := null;
        else
          change_collection := new.collection;
          change_id := new.id;
          change_block_height := new.block_height;
          change_timestamp := new.timestamp;
          change_data := new.data;
        end if;

        change_hash := pg_catalog.sha256(convert_to(array_to_string(array[
          capture_source::text,
          next_capture_seq::text,
          predecessor_seq::text,
          encode(predecessor_hash, 'hex'),
          change_operation::text,
          change_collection,
          change_id,
          coalesce(change_block_height::text, 'null'),
          coalesce(change_timestamp::text, 'null'),
          coalesce(change_data::text, 'null')
        ], chr(31)), 'UTF8'));

        insert into ${CHANGE_TABLE}(
          seq, source_id, previous_seq, previous_hash, row_hash, operation,
          collection, id, block_height, timestamp, data
        ) values (
          next_capture_seq, capture_source, predecessor_seq, predecessor_hash, change_hash, change_operation,
          change_collection, change_id, change_block_height, change_timestamp, change_data
        );
        update ${CHANGE_STATE_TABLE}
          set next_seq = next_capture_seq, head_hash = change_hash
          where singleton;

        if tg_op = 'DELETE' then return old; end if;
        return new;
      end;
      $$;
    `);
    await client.query(`
      create or replace function ${CHANGE_APPEND_ONLY_FUNCTION}()
      returns trigger
      language plpgsql
      as $$
      begin
        raise exception 'PostgreSQL RocksDB change log is append-only';
      end;
      $$;
    `);
    await client.query(`
      create or replace function ${CHANGE_INSERT_GUARD_FUNCTION}()
      returns trigger
      language plpgsql
      as $$
      declare capture_state ${CHANGE_STATE_TABLE}%rowtype;
      declare expected_hash bytea;
      begin
        if pg_trigger_depth() <> 2 then
          raise exception 'PostgreSQL RocksDB change log accepts rows only from its source capture trigger';
        end if;
        select * into capture_state from ${CHANGE_STATE_TABLE} where singleton;
        if capture_state.source_id is null or capture_state.sealed or
           new.source_id <> capture_state.source_id or
           new.seq <> capture_state.next_seq + 1 or
           new.previous_seq <> capture_state.next_seq or
           new.previous_hash <> capture_state.head_hash then
          raise exception 'PostgreSQL RocksDB change row does not extend the active generation head';
        end if;

        expected_hash := pg_catalog.sha256(convert_to(array_to_string(array[
          new.source_id::text,
          new.seq::text,
          new.previous_seq::text,
          encode(new.previous_hash, 'hex'),
          new.operation::text,
          new.collection,
          new.id,
          coalesce(new.block_height::text, 'null'),
          coalesce(new.timestamp::text, 'null'),
          coalesce(new.data::text, 'null')
        ], chr(31)), 'UTF8'));
        if new.row_hash <> expected_hash then
          raise exception 'PostgreSQL RocksDB change-row SHA-256 hash is invalid';
        end if;
        return new;
      end;
      $$;
    `);
    await client.query(`
      create or replace function ${CHANGE_STATE_MUTATION_GUARD_FUNCTION}()
      returns trigger
      language plpgsql
      as $$
      begin
        raise exception 'PostgreSQL RocksDB capture generation state cannot be inserted, deleted, or truncated';
      end;
      $$;
    `);
    await client.query(`
      create or replace function ${CHANGE_STATE_UPDATE_GUARD_FUNCTION}()
      returns trigger
      language plpgsql
      as $$
      declare control_lock_held boolean;
      begin
        if pg_trigger_depth() = 2 and not old.sealed and
           new.next_seq = old.next_seq + 1 and
           (to_jsonb(new) - 'next_seq' - 'head_hash') =
             (to_jsonb(old) - 'next_seq' - 'head_hash') and
           exists (
             select 1 from ${CHANGE_TABLE}
              where seq = new.next_seq
                and source_id = new.source_id
                and previous_seq = old.next_seq
                and previous_hash = old.head_hash
                and row_hash = new.head_hash
           ) then
          return new;
        end if;

        select exists (
          select 1 from pg_catalog.pg_locks
           where locktype = 'advisory'
             and pid = pg_backend_pid()
             and granted
             and classid = ${MIGRATION_PROCESS_LOCK_CLASS_ID}::oid
             and objid = ${MIGRATION_PROCESS_LOCK_OBJECT_ID}::oid
             and objsubid = 1
        ) into control_lock_held;
        if not control_lock_held then
          raise exception 'PostgreSQL RocksDB capture control update requires the migration process lock';
        end if;

        if not old.sealed and new.sealed and
           new.sealed_seq = old.next_seq and new.sealed_hash = old.head_hash and
           new.sealed_at is not null and
           (to_jsonb(new) - 'sealed' - 'sealed_seq' - 'sealed_hash' - 'sealed_at') =
             (to_jsonb(old) - 'sealed' - 'sealed_seq' - 'sealed_hash' - 'sealed_at') then
          return new;
        end if;

        if old.sealed and new.sealed and
           new.cutover_run_id is not null and new.cutover_destination_id is not null and
           new.cutover_seq = old.sealed_seq and new.cutover_hash = old.sealed_hash and
           new.cutover_completed_at is not null and
           (old.cutover_run_id is null or
             (old.cutover_run_id = new.cutover_run_id and
              old.cutover_destination_id = new.cutover_destination_id and
              old.cutover_seq = new.cutover_seq and old.cutover_hash = new.cutover_hash and
              old.cutover_completed_at = new.cutover_completed_at)) and
           (to_jsonb(new) - 'cutover_run_id' - 'cutover_destination_id' - 'cutover_seq' -
             'cutover_hash' - 'cutover_completed_at') =
             (to_jsonb(old) - 'cutover_run_id' - 'cutover_destination_id' - 'cutover_seq' -
              'cutover_hash' - 'cutover_completed_at') then
          return new;
        end if;

        raise exception 'PostgreSQL RocksDB capture generation state update violates its lifecycle';
      end;
      $$;
    `);

    // Trigger DDL holds an exclusive table lock. Replacing all triggers in this
    // transaction therefore leaves no uncaptured writer gap.
    await client.query(`drop trigger if exists ${CHANGE_WRITER_GUARD_TRIGGER} on indexer_documents;`);
    await client.query(`drop trigger if exists ${CHANGE_TRIGGER} on indexer_documents;`);
    await client.query(`
      create trigger ${CHANGE_WRITER_GUARD_TRIGGER}
      before insert or update or delete or truncate on indexer_documents
      for each statement execute function ${CHANGE_WRITER_GUARD_FUNCTION}();
    `);
    await client.query(`
      create trigger ${CHANGE_TRIGGER}
      after insert or update or delete on indexer_documents
      for each row execute function ${CHANGE_FUNCTION}();
    `);
    await client.query(`drop trigger if exists ${CHANGE_APPEND_ONLY_TRIGGER} on ${CHANGE_TABLE};`);
    await client.query(`drop trigger if exists ${CHANGE_INSERT_GUARD_TRIGGER} on ${CHANGE_TABLE};`);
    await client.query(`
      create trigger ${CHANGE_APPEND_ONLY_TRIGGER}
      before update or delete or truncate on ${CHANGE_TABLE}
      for each statement execute function ${CHANGE_APPEND_ONLY_FUNCTION}();
    `);
    await client.query(`
      create trigger ${CHANGE_INSERT_GUARD_TRIGGER}
      before insert on ${CHANGE_TABLE}
      for each row execute function ${CHANGE_INSERT_GUARD_FUNCTION}();
    `);
    await client.query(`drop trigger if exists ${CHANGE_STATE_UPDATE_GUARD_TRIGGER} on ${CHANGE_STATE_TABLE};`);
    await client.query(`drop trigger if exists ${CHANGE_STATE_MUTATION_GUARD_TRIGGER} on ${CHANGE_STATE_TABLE};`);
    await client.query(`
      create trigger ${CHANGE_STATE_UPDATE_GUARD_TRIGGER}
      before update on ${CHANGE_STATE_TABLE}
      for each row execute function ${CHANGE_STATE_UPDATE_GUARD_FUNCTION}();
    `);
    await client.query(`
      create trigger ${CHANGE_STATE_MUTATION_GUARD_TRIGGER}
      before insert or delete or truncate on ${CHANGE_STATE_TABLE}
      for each statement execute function ${CHANGE_STATE_MUTATION_GUARD_FUNCTION}();
    `);

    const descriptor = await validateDescriptor(client);
    await client.query('commit');
    return descriptor;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  }
};

export const readChangeCaptureDescriptor = (queryable: Queryable): Promise<ChangeCaptureDescriptor> =>
  validateDescriptor(queryable);

export type ChangeCaptureSeal = {
  client: pg.PoolClient;
  descriptor: ChangeCaptureDescriptor;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
};

/** Fences source writes and returns the exact committed replay high-water. */
export const beginChangeCaptureSeal = async (client: pg.PoolClient): Promise<ChangeCaptureSeal> => {
  let finished = false;
  const finish = async (action: 'commit' | 'rollback') => {
    if (finished) return;
    finished = true;
    await client.query(action);
  };

  try {
    await assertMigrationProcessLockHeld(client);
    await client.query('begin');
    // SHARE excludes INSERT/UPDATE/DELETE/TRUNCATE while allowing unrelated
    // read-only traffic to finish during the bounded final comparison.
    await client.query('lock table indexer_documents in share mode');
    let descriptor = await validateDescriptor(client);
    if (!descriptor.sealed) {
      await client.query(
        `update ${CHANGE_STATE_TABLE}
            set sealed = true,
                sealed_seq = next_seq,
                sealed_hash = head_hash,
                sealed_at = clock_timestamp()
          where singleton`
      );
      descriptor = await validateDescriptor(client);
    }

    return {
      client,
      descriptor,
      commit: () => finish('commit'),
      rollback: () => finish('rollback'),
    };
  } catch (error) {
    await finish('rollback').catch(() => undefined);
    throw error;
  }
};

export const recordCutoverReceipt = async (
  client: pg.PoolClient,
  receipt: { runId: string; destinationId: string; seq: string; hash: string }
): Promise<void> => {
  await assertMigrationProcessLockHeld(client);
  const result = await client.query(
    `update ${CHANGE_STATE_TABLE}
        set cutover_run_id = $1::uuid,
            cutover_destination_id = $2::uuid,
            cutover_seq = $3::bigint,
            cutover_hash = decode($4, 'hex'),
            cutover_completed_at = coalesce(cutover_completed_at, clock_timestamp())
      where singleton
        and sealed
        and sealed_seq = $3::bigint
        and sealed_hash = decode($4, 'hex')
        and (cutover_run_id is null or
             (cutover_run_id = $1::uuid and cutover_destination_id = $2::uuid and
              cutover_seq = $3::bigint and cutover_hash = decode($4, 'hex')))`,
    [receipt.runId, receipt.destinationId, receipt.seq, receipt.hash]
  );
  if (result.rowCount !== 1) throw new Error('Unable to persist the PostgreSQL RocksDB cutover receipt');
};
