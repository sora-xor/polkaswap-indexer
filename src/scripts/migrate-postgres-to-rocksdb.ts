import { setTimeout as sleep } from 'node:timers/promises';

import pg from 'pg';

import { readConfig } from '../config.js';
import { POSTGRES_TRUSTED_SESSION_OPTIONS } from '../postgres-session.js';
import { parseExactJsonObject } from '../repository/json-numeric.js';
import { decodePostgresDocument, decodePostgresDocumentText } from '../repository/postgres-document.js';
import { ROCKSDB_FORMAT_METADATA_KEY, RocksRepository } from '../repository/rocksdb.js';
import {
  indexerDocumentJsonBytes,
  MAX_REPOSITORY_WRITE_BATCH_JSON_BYTES,
  MAX_REPOSITORY_WRITE_BATCH_DOCUMENTS,
} from '../repository/validation.js';
import {
  acquireMigrationProcessLock,
  beginChangeCaptureSeal,
  CHANGE_TABLE,
  installChangeCapture,
  readChangeCaptureDescriptor,
  recordCutoverReceipt,
  releaseMigrationProcessLock,
} from './postgres-rocksdb-capture.js';
import {
  assertChangeCaptureContinuity,
  createPostgresRocksdbMigrationState,
  parsePostgresRocksdbMigrationState,
  POSTGRES_ROCKSDB_MIGRATION_STATE_KEY,
  validateCapturedChangeBatch,
} from './rocksdb-migration-state.js';
import { readPositiveSafeInteger, readStrictBoolean } from './env.js';
import { verifyPostgresRocksdbLogicalEquality } from './verify-postgres-rocksdb-logical.js';

import type { IndexerCollection, IndexerDocument } from '../repository/types.js';
import type { ChangeCaptureSeal } from './postgres-rocksdb-capture.js';
import type {
  PostgresRocksdbMigrationState,
  ValidatedCapturedChange,
} from './rocksdb-migration-state.js';

const { Pool } = pg;

type ChangeRow = ValidatedCapturedChange;
type MigrationBatchCandidate = {
  estimatedBytes: string | number;
};

const MAX_MIGRATION_ROW_BATCH_SIZE = 10_000;
// PostgreSQL stores the canonical id/positions outside compact JSONB data. The
// destination logical document restores them, and a maximally escaped 1,024
// byte id can add just over 2 KiB. Four KiB is therefore a strict envelope
// upper bound rather than a heuristic allowance.
export const MIGRATION_SIZE_ESTIMATE_OVERHEAD_BYTES = 4 * 1_024;

export const readBoundedPositiveInteger = (
  name: string,
  fallback: number,
  maximum: number,
  env: NodeJS.ProcessEnv = process.env
): number => {
  const value = readPositiveSafeInteger(env, name, fallback);
  if (value > maximum) throw new Error(`${name} must be at most ${maximum}`);
  return value;
};

export const assertMigrationFollowModeAllowed = (follow: boolean, sourceSealed: boolean): void => {
  if (follow && sourceSealed) {
    throw new Error('ROCKSDB_MIGRATION_FOLLOW cannot resume a sealed source; run final mode to validate and publish it');
  }
};

export const migrationCheckpointErrorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return (message || 'Unknown PostgreSQL-to-RocksDB migration failure').slice(0, 4_096);
};

/** Selects a non-empty prefix without ever permitting an oversized fetch. */
export const selectByteBoundedMigrationPrefix = <T extends MigrationBatchCandidate>(
  candidates: readonly T[],
  maxBytes: number
): T[] => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('Migration batch byte limit must be a positive safe integer');
  }
  const selected: T[] = [];
  let total = 0;
  for (const candidate of candidates) {
    const raw = candidate.estimatedBytes;
    const bytes = typeof raw === 'string' && /^(0|[1-9][0-9]*)$/.test(raw) ? Number(raw) : raw;
    if (!Number.isSafeInteger(bytes) || (bytes as number) <= 0) {
      throw new Error(`Invalid PostgreSQL migration row-size estimate: ${String(raw)}`);
    }
    if ((bytes as number) > maxBytes) {
      if (!selected.length) {
        throw new Error(
          `PostgreSQL migration row requires ${bytes as number} bytes, exceeding the ${maxBytes}-byte batch limit`
        );
      }
      break;
    }
    if (total + (bytes as number) > maxBytes) break;
    selected.push(candidate);
    total += bytes as number;
  }
  return selected;
};

/** Groups documents without retaining a second batch-sized array of JSON strings. */
export const chunkMigrationDocuments = (
  documents: readonly IndexerDocument[],
  maxBytes: number
): IndexerDocument[][] => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('Migration document batch byte limit must be a positive safe integer');
  }
  const chunks: IndexerDocument[][] = [];
  let chunk: IndexerDocument[] = [];
  let chunkBytes = 2;
  const flush = (): void => {
    if (chunk.length) chunks.push(chunk);
    chunk = [];
    chunkBytes = 2;
  };
  for (const document of documents) {
    const documentBytes = indexerDocumentJsonBytes(document);
    if (documentBytes + 2 > maxBytes) {
      throw new Error(
        `Indexer document ${document.collection}/${document.id} exceeds migration batch byte limit ${maxBytes}`
      );
    }
    let nextBytes = chunkBytes + (chunk.length ? 1 : 0) + documentBytes;
    if (chunk.length && (chunk.length >= MAX_REPOSITORY_WRITE_BATCH_DOCUMENTS || nextBytes > maxBytes)) {
      flush();
      nextBytes = chunkBytes + documentBytes;
    }
    chunk.push(document);
    chunkBytes = nextBytes;
  }
  flush();
  return chunks;
};

const rowToDocument = (row: {
  collection: IndexerCollection;
  id: string;
  blockHeight: number | string | null;
  timestamp: number | string | null;
  data: Record<string, unknown>;
}): IndexerDocument => decodePostgresDocument(row);

const saveState = async (repository: RocksRepository, state: PostgresRocksdbMigrationState): Promise<void> => {
  await repository.setMetadata(POSTGRES_ROCKSDB_MIGRATION_STATE_KEY, state);
};

const loadState = (repository: RocksRepository): PostgresRocksdbMigrationState | null =>
  parsePostgresRocksdbMigrationState(repository.getMetadata(POSTGRES_ROCKSDB_MIGRATION_STATE_KEY));

const destinationHasUntrackedContent = async (repository: RocksRepository): Promise<boolean> =>
  repository.inspectCurrentSnapshot((db) => {
    for (const entry of db.getRange({ values: false })) {
      const key = entry?.key;
      if (
        Array.isArray(key) &&
        key.length === 3 &&
        key[0] === 'm' &&
        key[1] === 'metadata' &&
        key[2] === ROCKSDB_FORMAT_METADATA_KEY
      ) {
        continue;
      }
      return true;
    }
    return false;
  });

export const exportPostgresRows = async (
  pool: pg.Pool,
  repository: RocksRepository,
  state: PostgresRocksdbMigrationState,
  batchSize: number,
  batchBytes: number
): Promise<PostgresRocksdbMigrationState> => {
  if (state.exportCompleted) {
    console.info(`Postgres export already complete at ${state.rows} rows`);
    return state;
  }

  const client = await pool.connect();
  let nextState = state;
  try {
    while (true) {
      let transactionOpen = false;
      let result: pg.QueryResult<{
        collection: IndexerCollection;
        id: string;
        blockHeight: number | string | null;
        timestamp: number | string | null;
        dataText: string;
      }>;
      try {
        await client.query('begin isolation level repeatable read read only');
        transactionOpen = true;
        const candidates = await client.query<{
          collection: IndexerCollection;
          id: string;
          estimatedBytes: string;
        }>(
          `select collection,
                  id,
                  (octet_length(jsonb_build_object(
                    'collection', collection,
                    'id', id,
                    'blockHeight', block_height,
                    'timestamp', timestamp,
                    'data', data
                  )::text)::bigint + $4::bigint)::text as "estimatedBytes"
             from indexer_documents
            where (collection collate "C", id collate "C") >
                  ($1::text collate "C", $2::text collate "C")
            order by collection collate "C", id collate "C"
            limit $3::int`,
          [nextState.collection, nextState.id, batchSize, MIGRATION_SIZE_ESTIMATE_OVERHEAD_BYTES]
        );
        if (!candidates.rows.length) {
          await client.query('commit');
          transactionOpen = false;
          nextState = { ...nextState, exportCompleted: true };
          await saveState(repository, nextState);
          console.info(`Postgres export complete: ${nextState.rows} rows`);
          return nextState;
        }

        const selected = selectByteBoundedMigrationPrefix(candidates.rows, batchBytes);
        result = await client.query(
          `select document.collection,
                  document.id,
                  document.block_height as "blockHeight",
                  document.timestamp,
                  document.data::text as "dataText"
             from unnest($1::text[], $2::text[]) with ordinality as selected(collection, id, ordinal)
             join indexer_documents as document
               on document.collection = selected.collection and document.id = selected.id
            order by selected.ordinal`,
          [
            selected.map(({ collection }) => collection),
            selected.map(({ id }) => id),
          ]
        );
        if (
          result.rows.length !== selected.length ||
          result.rows.some(
            (row, index) => row.collection !== selected[index]?.collection || row.id !== selected[index]?.id
          )
        ) {
          throw new Error('PostgreSQL migration snapshot changed while reading its byte-bounded batch');
        }
        await client.query('commit');
        transactionOpen = false;
      } catch (error) {
        if (transactionOpen) await client.query('rollback').catch(() => undefined);
        throw error;
      }

      const documents = result.rows.map(decodePostgresDocumentText);
      for (const chunk of chunkMigrationDocuments(documents, batchBytes)) {
        await repository.upsertMany(chunk);
      }

      const last = result.rows[result.rows.length - 1]!;
      nextState = {
        ...nextState,
        collection: last.collection,
        id: last.id,
        rows: nextState.rows + result.rows.length,
      };
      await saveState(repository, nextState);
      console.info(`Exported ${nextState.rows} rows through ${nextState.collection}/${nextState.id}`);
    }
  } finally {
    client.release();
  }
};

/** Applies the authoritative final state of every identity in a replay batch. */
const applyChangeBatch = async (
  repository: RocksRepository,
  rows: ChangeRow[],
  batchBytes: number
): Promise<void> => {
  const finalByIdentity = new Map<string, { collection: IndexerCollection; id: string; document: IndexerDocument | null }>();
  for (const row of rows) {
    const document = row.operation === 'D' ? null : rowToDocument({ ...row, data: row.data! });
    finalByIdentity.set(`${row.collection}\0${row.id}`, { collection: row.collection, id: row.id, document });
  }

  const idsByCollection = new Map<IndexerCollection, string[]>();
  const documents: IndexerDocument[] = [];
  for (const change of finalByIdentity.values()) {
    const ids = idsByCollection.get(change.collection) ?? [];
    ids.push(change.id);
    idsByCollection.set(change.collection, ids);
    if (change.document) documents.push(change.document);
  }

  // Delete first so an authoritative lower block-height repair cannot be
  // discarded by the repository's normal monotonic worker-write guard.
  for (const [collection, ids] of idsByCollection) await repository.deleteMany(collection, ids);
  for (const chunk of chunkMigrationDocuments(documents, batchBytes)) {
    await repository.upsertMany(chunk);
  }
};

const replayChanges = async (
  queryable: pg.Pool | pg.PoolClient,
  repository: RocksRepository,
  state: PostgresRocksdbMigrationState,
  batchSize: number,
  batchBytes: number,
  throughSeq?: string
): Promise<PostgresRocksdbMigrationState> => {
  let nextState = state;
  while (throughSeq === undefined || BigInt(nextState.lastReplayedSeq) < BigInt(throughSeq)) {
    const candidates = await queryable.query<{ seq: string; estimatedBytes: string }>(
      `select seq::text,
              (coalesce(octet_length(data::text), 0)::bigint +
               octet_length(collection)::bigint + octet_length(id)::bigint + $4::bigint)::text as "estimatedBytes"
         from ${CHANGE_TABLE}
        where seq > $1::bigint
          and ($3::bigint is null or seq <= $3::bigint)
        order by ${CHANGE_TABLE}.seq
        limit $2::int`,
      [nextState.lastReplayedSeq, batchSize, throughSeq ?? null, MIGRATION_SIZE_ESTIMATE_OVERHEAD_BYTES]
    );
    if (!candidates.rows.length) {
      if (throughSeq !== undefined && BigInt(nextState.lastReplayedSeq) < BigInt(throughSeq)) {
        throw new Error(
          `PostgreSQL RocksDB change chain ended at ${nextState.lastReplayedSeq} before sealed high-water ${throughSeq}`
        );
      }
      return nextState;
    }

    const selected = selectByteBoundedMigrationPrefix(candidates.rows, batchBytes);
    const selectedHighWater = selected[selected.length - 1]!.seq;
    const result = await queryable.query<ChangeRow>(
      `select seq::text,
              source_id::text as "sourceId",
              previous_seq::text as "previousSeq",
              encode(previous_hash, 'hex') as "previousHash",
              encode(row_hash, 'hex') as "rowHash",
              operation::text as operation,
              collection,
              id,
              block_height as "blockHeight",
              timestamp,
              data::text as "dataText"
         from ${CHANGE_TABLE}
        where seq > $1::bigint and seq <= $2::bigint
        order by ${CHANGE_TABLE}.seq`,
      [nextState.lastReplayedSeq, selectedHighWater]
    );
    if (result.rows.length !== selected.length) {
      throw new Error('PostgreSQL RocksDB change chain changed while reading its byte-bounded replay batch');
    }
    for (const row of result.rows) {
      if (row.operation === 'D') row.data = null;
      else {
        row.data = parseExactJsonObject(
          row.dataText ?? '',
          `Captured PostgreSQL JSON at RocksDB change sequence ${row.seq}`
        );
      }
    }

    const position = validateCapturedChangeBatch(result.rows, nextState, throughSeq);
    for (const row of result.rows) row.dataText = null;
    await applyChangeBatch(repository, result.rows, batchBytes);
    nextState = {
      ...nextState,
      lastReplayedSeq: position.lastSeq,
      lastReplayedHash: position.lastHash,
    };
    await saveState(repository, nextState);
    console.info(`Replayed ${result.rows.length} Postgres change(s) through seq ${position.lastSeq}`);
  }
  return nextState;
};

export const runPostgresToRocksdbMigration = async (): Promise<void> => {
  const config = readConfig();
  const batchSize = readBoundedPositiveInteger('ROCKSDB_MIGRATION_BATCH_SIZE', 5_000, MAX_MIGRATION_ROW_BATCH_SIZE);
  const changeBatchSize = readBoundedPositiveInteger(
    'ROCKSDB_CHANGE_REPLAY_BATCH_SIZE',
    10_000,
    MAX_MIGRATION_ROW_BATCH_SIZE
  );
  const batchBytes = readBoundedPositiveInteger(
    'ROCKSDB_MIGRATION_BATCH_BYTES',
    MAX_REPOSITORY_WRITE_BATCH_JSON_BYTES,
    MAX_REPOSITORY_WRITE_BATCH_JSON_BYTES
  );
  const changeBatchBytes = readBoundedPositiveInteger(
    'ROCKSDB_CHANGE_REPLAY_BATCH_BYTES',
    MAX_REPOSITORY_WRITE_BATCH_JSON_BYTES,
    MAX_REPOSITORY_WRITE_BATCH_JSON_BYTES
  );
  const follow = readStrictBoolean(process.env, 'ROCKSDB_MIGRATION_FOLLOW', false);
  const pollMs = readBoundedPositiveInteger('ROCKSDB_MIGRATION_FOLLOW_POLL_MS', 2_000, 60_000);
  const pool = new Pool({
    connectionString: config.databaseUrl,
    options: POSTGRES_TRUSTED_SESSION_OPTIONS,
  });
  const repository = new RocksRepository(
    { ...config, storageEngine: 'rocksdb' },
    { allowIncompleteMigration: true }
  );
  let processLock: pg.PoolClient | null = null;
  let seal: ChangeCaptureSeal | null = null;
  let state: PostgresRocksdbMigrationState | null = null;

  try {
    await repository.prepare();
    processLock = await acquireMigrationProcessLock(pool);
    state = loadState(repository);
    if (!state && (await destinationHasUntrackedContent(repository))) {
      throw new Error('Refusing to migrate into a non-empty RocksDB destination with no matching migration state');
    }
    const capture = await installChangeCapture(processLock);

    if (!state) {
      state = createPostgresRocksdbMigrationState(capture);
      await saveState(repository, state);
    } else {
      assertChangeCaptureContinuity(capture, state);
      if (state.status === 'validated_complete') {
        await repository.validateCompactIndexes();
        console.info('PostgreSQL-to-RocksDB migration was already validated and has a matching cutover receipt');
        return;
      }
      state = { ...state, status: 'in_progress', lastError: null };
      await saveState(repository, state);
    }

    assertMigrationFollowModeAllowed(follow, capture.sealed);

    state = await exportPostgresRows(pool, repository, state, batchSize, batchBytes);
    if (follow) {
      while (true) {
        const before = state.lastReplayedSeq;
        state = await replayChanges(pool, repository, state, changeBatchSize, changeBatchBytes);
        if (state.lastReplayedSeq === before) await sleep(pollMs);
      }
    }

    seal = await beginChangeCaptureSeal(processLock);
    assertChangeCaptureContinuity(seal.descriptor, state);
    if (seal.descriptor.sealedSeq === null || seal.descriptor.sealedHash === null) {
      throw new Error('PostgreSQL RocksDB finalization did not produce an exact sealed high-water mark');
    }
    state = await replayChanges(
      seal.client,
      repository,
      state,
      changeBatchSize,
      changeBatchBytes,
      seal.descriptor.sealedSeq
    );
    if (
      state.lastReplayedSeq !== seal.descriptor.sealedSeq ||
      state.lastReplayedHash !== seal.descriptor.sealedHash
    ) {
      throw new Error('RocksDB replay did not reach the sealed PostgreSQL change-chain receipt');
    }

    await repository.validateCompactIndexes();
    const verifiedRows = await verifyPostgresRocksdbLogicalEquality(seal.client, repository, batchSize);
    console.info(
      `Validated compact indexes and ${verifiedRows} logical document(s) at the sealed PostgreSQL high-water mark`
    );
    await seal.commit();
    seal = null;

    await recordCutoverReceipt(processLock, {
      runId: state.runId,
      destinationId: state.destinationId,
      seq: state.lastReplayedSeq,
      hash: state.lastReplayedHash,
    });
    const completedState: PostgresRocksdbMigrationState = {
      ...state,
      status: 'validated_complete',
      sealedSeq: state.lastReplayedSeq,
      sealedHash: state.lastReplayedHash,
      validatedAt: new Date().toISOString(),
      lastError: null,
    };
    const completedCapture = await readChangeCaptureDescriptor(pool);
    assertChangeCaptureContinuity(completedCapture, completedState);
    state = completedState;
    await saveState(repository, state);
    console.info(`PostgreSQL-to-RocksDB migration ${state.runId} completed through seq ${state.sealedSeq}`);
  } catch (error) {
    if (state && state.status !== 'validated_complete') {
      state = {
        ...state,
        status: 'failed',
        lastError: migrationCheckpointErrorMessage(error),
      };
      await saveState(repository, state).catch(() => undefined);
    }
    throw error;
  } finally {
    await seal?.rollback().catch(() => undefined);
    if (processLock) await releaseMigrationProcessLock(processLock);
    await repository.close().catch(() => undefined);
    await pool.end();
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  runPostgresToRocksdbMigration().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
