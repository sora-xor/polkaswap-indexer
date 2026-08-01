import { randomUUID } from 'node:crypto';

import { INDEXER_COLLECTIONS } from '../repository/types.js';
import { assertValidDocumentId } from '../repository/validation.js';
import { capturedChangeHash } from './postgres-rocksdb-capture.js';

import type { IndexerCollection } from '../repository/types.js';
import type { ChangeCaptureDescriptor } from './postgres-rocksdb-capture.js';

export const POSTGRES_ROCKSDB_MIGRATION_STATE_KEY = 'postgresToRocksdbMigration';
export const POSTGRES_ROCKSDB_MIGRATION_STATE_VERSION = 1;

export type PostgresRocksdbMigrationState = {
  version: 1;
  status: 'in_progress' | 'failed' | 'validated_complete';
  destinationId: string;
  sourceId: string;
  sourceDatabaseIdentity: string;
  runId: string;
  collection: string;
  id: string;
  rows: number;
  exportCompleted: boolean;
  captureStartSeq: string;
  captureStartHash: string;
  lastReplayedSeq: string;
  lastReplayedHash: string;
  sealedSeq: string | null;
  sealedHash: string | null;
  validatedAt: string | null;
  lastError: string | null;
};

export type ValidatedCapturedChange = {
  seq: string;
  sourceId: string;
  previousSeq: string;
  previousHash: string;
  rowHash: string;
  operation: 'I' | 'U' | 'D';
  collection: IndexerCollection;
  id: string;
  blockHeight: number | string | null;
  timestamp: number | string | null;
  data: Record<string, unknown> | null;
  dataText: string | null;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SEQUENCE_PATTERN = /^(0|[1-9]\d*)$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const parseSequence = (name: string, value: unknown): string => {
  if (typeof value !== 'string' || !SEQUENCE_PATTERN.test(value)) {
    throw new Error(`Invalid ${name}: expected an unsigned decimal sequence`);
  }
  return value;
};

const parseHash = (name: string, value: unknown): string => {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    throw new Error(`Invalid ${name}: expected a 64-character lowercase SHA-256 capture hash`);
  }
  return value;
};

const parseUuid = (name: string, value: unknown): string => {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new Error(`Invalid ${name}: expected a UUID`);
  return value;
};

export const createPostgresRocksdbMigrationState = (
  capture: ChangeCaptureDescriptor,
  ids: { destinationId?: string; runId?: string } = {}
): PostgresRocksdbMigrationState => ({
  version: 1,
  status: 'in_progress',
  destinationId: ids.destinationId ?? randomUUID(),
  sourceId: capture.sourceId,
  sourceDatabaseIdentity: capture.sourceDatabaseIdentity,
  runId: ids.runId ?? randomUUID(),
  collection: '',
  id: '',
  rows: 0,
  exportCompleted: false,
  captureStartSeq: capture.headSeq,
  captureStartHash: capture.headHash,
  lastReplayedSeq: capture.headSeq,
  lastReplayedHash: capture.headHash,
  sealedSeq: null,
  sealedHash: null,
  validatedAt: null,
  lastError: null,
});

/** Rejects partial, predecessor-format, or hand-edited destination checkpoints. */
export const parsePostgresRocksdbMigrationState = (value: unknown): PostgresRocksdbMigrationState | null => {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new Error('Invalid RocksDB migration state: expected a versioned object');
  const expectedKeys = [
    'captureStartHash',
    'captureStartSeq',
    'collection',
    'destinationId',
    'exportCompleted',
    'id',
    'lastError',
    'lastReplayedHash',
    'lastReplayedSeq',
    'rows',
    'runId',
    'sealedHash',
    'sealedSeq',
    'sourceDatabaseIdentity',
    'sourceId',
    'status',
    'validatedAt',
    'version',
  ];
  if (Object.keys(value).sort().join(',') !== expectedKeys.join(',')) {
    throw new Error('Invalid RocksDB migration state: unexpected or missing fields');
  }
  if (value.version !== POSTGRES_ROCKSDB_MIGRATION_STATE_VERSION) {
    throw new Error(`Invalid RocksDB migration state version: ${String(value.version)}`);
  }
  if (!['in_progress', 'failed', 'validated_complete'].includes(String(value.status))) {
    throw new Error('Invalid RocksDB migration state status');
  }
  const collection = value.collection;
  const id = value.id;
  if (
    typeof collection !== 'string' ||
    (collection !== '' && !INDEXER_COLLECTIONS.includes(collection as IndexerCollection)) ||
    typeof id !== 'string' ||
    (collection === '') !== (id === '')
  ) {
    throw new Error('Invalid RocksDB migration export cursor');
  }
  if (id !== '') assertValidDocumentId(id);
  if (!Number.isSafeInteger(value.rows) || (value.rows as number) < 0 || typeof value.exportCompleted !== 'boolean') {
    throw new Error('Invalid RocksDB migration exported row count');
  }
  if (
    value.lastError !== null &&
    (typeof value.lastError !== 'string' || value.lastError.length === 0 || value.lastError.length > 4_096)
  ) {
    throw new Error('Invalid RocksDB migration error');
  }
  if (
    value.validatedAt !== null &&
    (typeof value.validatedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.validatedAt)) ||
      new Date(value.validatedAt).toISOString() !== value.validatedAt)
  ) {
    throw new Error('Invalid RocksDB migration validation timestamp');
  }
  const sealedSeq = value.sealedSeq === null ? null : parseSequence('sealed sequence', value.sealedSeq);
  const sealedHash = value.sealedHash === null ? null : parseHash('sealed hash', value.sealedHash);
  if ((sealedSeq === null) !== (sealedHash === null)) throw new Error('Invalid RocksDB migration seal pair');
  const captureStartSeq = parseSequence('capture-start sequence', value.captureStartSeq);
  const lastReplayedSeq = parseSequence('last-replayed sequence', value.lastReplayedSeq);
  const captureStartHash = parseHash('capture-start hash', value.captureStartHash);
  const lastReplayedHash = parseHash('last-replayed hash', value.lastReplayedHash);
  if (BigInt(lastReplayedSeq) < BigInt(captureStartSeq)) {
    throw new Error('Invalid RocksDB migration state: replay position precedes capture start');
  }
  if (lastReplayedSeq === captureStartSeq && lastReplayedHash !== captureStartHash) {
    throw new Error('Invalid RocksDB migration state: unreplayed checkpoint hash differs from capture start');
  }
  if (((value.rows as number) === 0) !== (collection === '')) {
    throw new Error('Invalid RocksDB migration state: exported row count does not match its keyset cursor');
  }
  if (
    sealedSeq !== null &&
    (lastReplayedSeq !== sealedSeq || lastReplayedHash !== sealedHash)
  ) {
    throw new Error('Invalid RocksDB migration state: replay position does not match its seal');
  }
  if (value.status === 'validated_complete') {
    if (
      sealedSeq === null ||
      value.validatedAt === null ||
      value.exportCompleted !== true ||
      value.lastError !== null
    ) {
      throw new Error('Invalid completed RocksDB migration state: export, seal, validation, and error state are inconsistent');
    }
  } else if (sealedSeq !== null || value.validatedAt !== null) {
    throw new Error('Invalid incomplete RocksDB migration state: completion fields are already populated');
  } else if (value.status === 'in_progress' && value.lastError !== null) {
    throw new Error('Invalid in-progress RocksDB migration state: an error is already populated');
  } else if (value.status === 'failed' && value.lastError === null) {
    throw new Error('Invalid failed RocksDB migration state: missing error');
  }

  return {
    version: 1,
    status: value.status as PostgresRocksdbMigrationState['status'],
    destinationId: parseUuid('destination UUID', value.destinationId),
    sourceId: parseUuid('source UUID', value.sourceId),
    sourceDatabaseIdentity:
      typeof value.sourceDatabaseIdentity === 'string' && /^[0-9a-f]{64}$/.test(value.sourceDatabaseIdentity)
        ? value.sourceDatabaseIdentity
        : (() => {
            throw new Error('Invalid source database identity');
          })(),
    runId: parseUuid('migration run UUID', value.runId),
    collection,
    id,
    rows: value.rows as number,
    exportCompleted: value.exportCompleted,
    captureStartSeq,
    captureStartHash,
    lastReplayedSeq,
    lastReplayedHash,
    sealedSeq,
    sealedHash,
    validatedAt: value.validatedAt as string | null,
    lastError: value.lastError as string | null,
  };
};

/** Rejects any destination that was exported but never durably validated. */
export const assertServeablePostgresRocksdbMigrationState = (value: unknown): void => {
  const state = parsePostgresRocksdbMigrationState(value);
  if (state !== null && state.status !== 'validated_complete') {
    throw new Error(
      'RocksDB contains an incomplete or failed PostgreSQL migration artifact; resume and validate the migration before serving or copying it'
    );
  }
};

export const assertChangeCaptureContinuity = (
  capture: ChangeCaptureDescriptor,
  state: PostgresRocksdbMigrationState
): void => {
  if (capture.sourceId !== state.sourceId || capture.sourceDatabaseIdentity !== state.sourceDatabaseIdentity) {
    throw new Error('PostgreSQL RocksDB capture generation or source database does not match the destination checkpoint');
  }
  const start = BigInt(state.captureStartSeq);
  const replayed = BigInt(state.lastReplayedSeq);
  const current = BigInt(capture.headSeq);
  if (replayed < start) throw new Error('Invalid RocksDB migration checkpoint: last replayed sequence precedes capture start');
  if (current < replayed) throw new Error('PostgreSQL RocksDB change capture was truncated or reset behind the checkpoint');
  if (current === replayed && capture.headHash !== state.lastReplayedHash) {
    throw new Error('PostgreSQL RocksDB change-capture hash does not match the destination checkpoint');
  }
  if (capture.sealed) {
    if (capture.sealedSeq === null || capture.sealedHash === null || replayed > BigInt(capture.sealedSeq)) {
      throw new Error('Invalid sealed PostgreSQL RocksDB capture high-water mark');
    }
  }
  if (state.status === 'validated_complete') {
    if (
      !capture.sealed ||
      state.sealedSeq !== capture.sealedSeq ||
      state.sealedHash !== capture.sealedHash ||
      capture.cutoverRunId !== state.runId ||
      capture.cutoverDestinationId !== state.destinationId ||
      capture.cutoverSeq !== state.sealedSeq ||
      capture.cutoverHash !== state.sealedHash
    ) {
      throw new Error('Completed RocksDB migration has no matching durable PostgreSQL cutover receipt');
    }
  }
};

/** Validates a complete predecessor/hash chain before any destination mutation. */
export const validateCapturedChangeBatch = (
  rows: ValidatedCapturedChange[],
  state: Pick<PostgresRocksdbMigrationState, 'sourceId' | 'lastReplayedSeq' | 'lastReplayedHash'>,
  throughSeq?: string
): { lastSeq: string; lastHash: string } => {
  let previousSeq = state.lastReplayedSeq;
  let previousHash = state.lastReplayedHash;
  const upper = throughSeq === undefined ? null : BigInt(parseSequence('replay high-water sequence', throughSeq));

  for (const row of rows) {
    const seq = parseSequence('captured change sequence', row.seq);
    if (
      row.sourceId !== state.sourceId ||
      row.previousSeq !== previousSeq ||
      row.previousHash !== previousHash ||
      BigInt(seq) !== BigInt(previousSeq) + 1n ||
      (upper !== null && BigInt(seq) > upper) ||
      !['I', 'U', 'D'].includes(row.operation) ||
      !INDEXER_COLLECTIONS.includes(row.collection) ||
      !isRecord(row.data) && row.data !== null ||
      ((row.operation === 'I' || row.operation === 'U') && (row.data === null || row.dataText === null)) ||
      (row.operation === 'D' && (row.data !== null || row.dataText !== null))
    ) {
      throw new Error(`Malformed or discontinuous PostgreSQL RocksDB change row at sequence ${seq}`);
    }
    assertValidDocumentId(row.id);
    const expectedHash = capturedChangeHash(row);
    if (row.rowHash !== expectedHash) {
      throw new Error(`PostgreSQL RocksDB change-row hash mismatch at sequence ${seq}`);
    }
    previousSeq = seq;
    previousHash = row.rowHash;
  }

  return { lastSeq: previousSeq, lastHash: previousHash };
};
