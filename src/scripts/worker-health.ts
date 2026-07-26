import pg from 'pg';
import { pathToFileURL } from 'node:url';

import {
  isStoredSoraChainStateCoherent,
  parseStoredSoraChainIdentity,
  parseStoredSoraChainState,
  SORA_LEGACY_IDENTITY_ANCHOR,
} from '../soraIdentity.js';

import type { StoredSoraChainIdentity, StoredSoraChainState } from '../soraIdentity.js';

const { Pool } = pg;

export const WORKER_HEALTH_TOTAL_TIMEOUT_MS = 4_000;
export const WORKER_HEALTH_CONNECTION_TIMEOUT_MS = 1_000;
export const WORKER_HEALTH_QUERY_TIMEOUT_MS = 1_000;
export const WORKER_HEALTH_CLEANUP_TIMEOUT_MS = 500;
export const WORKER_HEALTH_MAX_DOCUMENT_BYTES = 65_536;
export const WORKER_HEALTH_MAX_STALE_SEC = 300;
export const WORKER_HEALTH_MAX_FUTURE_SEC = 30;

const UPDATE_STREAMS_COLLECTION = 'updatesStreams';
const NETWORK_SNAPSHOTS_COLLECTION = 'networkSnapshots';
const CHAIN_IDENTITY_ID = 'chainIdentity';
const CHAIN_STATE_ID = 'chainState';

const UPDATE_ROWS_SQL = `
  select collection, id, block_height::text as "blockHeight", timestamp::text as "timestamp", data
  from indexer_documents
  where collection = $1
    and id = any($2::text[])
    and octet_length(data::text) <= $3
  order by id asc
`;

const SNAPSHOT_ROW_SQL = `
  select collection, id, block_height::text as "blockHeight", timestamp::text as "timestamp", data
  from indexer_documents
  where collection = $1
    and id = $2
    and octet_length(data::text) <= $3
  limit 2
`;

type WorkerHealthFailureCode =
  | 'database-url-invalid'
  | 'deadline-invalid'
  | 'identity-row-invalid'
  | 'identity-checkpoint-invalid'
  | 'identity-anchor-invalid'
  | 'state-row-invalid'
  | 'state-checkpoint-invalid'
  | 'state-incoherent'
  | 'state-stale'
  | 'state-future'
  | 'snapshot-row-invalid'
  | 'snapshot-envelope-invalid'
  | 'database-operation-failed';

export type WorkerHealthValidation =
  | {
      ok: true;
      identity: StoredSoraChainIdentity;
      state: StoredSoraChainState;
    }
  | {
      ok: false;
      code: WorkerHealthFailureCode;
    };

export type WorkerHealthDocumentRow = {
  collection: unknown;
  id: unknown;
  blockHeight: unknown;
  timestamp: unknown;
  data: unknown;
};

type QueryResult = { rows: unknown[] };
type WorkerHealthDatabase = {
  query: (text: string, values: unknown[]) => Promise<QueryResult>;
  end: () => Promise<void>;
};

type ParsedUpdateEnvelope = {
  blockHeight: number;
  timestamp: number;
  payload: unknown;
};

type WorkerHealthProbeOptions = {
  databaseUrl?: string;
  nowSec?: number;
  totalTimeoutMs?: number;
  createDatabase?: (databaseUrl: string) => WorkerHealthDatabase;
};

const isExactRecord = (value: unknown, expectedKeys: readonly string[]): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const actualKeys = Object.keys(value).sort();
  const wantedKeys = [...expectedKeys].sort();
  return actualKeys.length === wantedKeys.length && actualKeys.every((key, index) => key === wantedKeys[index]);
};

const parsePositivePgInteger = (value: unknown): number | null => {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const parsePositiveJsonInteger = (value: unknown): number | null =>
  Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;

const parseUpdateEnvelope = (
  row: unknown,
  expectedId: typeof CHAIN_IDENTITY_ID | typeof CHAIN_STATE_ID,
): ParsedUpdateEnvelope | null => {
  if (!isExactRecord(row, ['blockHeight', 'collection', 'data', 'id', 'timestamp']) ||
      row.collection !== UPDATE_STREAMS_COLLECTION || row.id !== expectedId) {
    return null;
  }
  const blockHeight = parsePositivePgInteger(row.blockHeight);
  const timestamp = parsePositivePgInteger(row.timestamp);
  if (blockHeight === null || timestamp === null ||
      !isExactRecord(row.data, ['block', 'data', 'id']) || row.data.id !== expectedId ||
      parsePositiveJsonInteger(row.data.block) !== blockHeight || typeof row.data.data !== 'string' ||
      Buffer.byteLength(row.data.data, 'utf8') > WORKER_HEALTH_MAX_DOCUMENT_BYTES) {
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(row.data.data);
  } catch {
    return null;
  }
  return { blockHeight, timestamp, payload };
};

const parseIdentityRows = (rows: unknown):
  | { ok: true; identity: StoredSoraChainIdentity; stateEnvelope: ParsedUpdateEnvelope }
  | { ok: false; code: WorkerHealthFailureCode } => {
  if (!Array.isArray(rows) || rows.length !== 2) return { ok: false, code: 'identity-row-invalid' };
  const byId = new Map<string, unknown>();
  for (const row of rows) {
    if (!isExactRecord(row, ['blockHeight', 'collection', 'data', 'id', 'timestamp']) || typeof row.id !== 'string' ||
        byId.has(row.id)) {
      return { ok: false, code: 'identity-row-invalid' };
    }
    byId.set(row.id, row);
  }

  const identityEnvelope = parseUpdateEnvelope(byId.get(CHAIN_IDENTITY_ID), CHAIN_IDENTITY_ID);
  if (!identityEnvelope) return { ok: false, code: 'identity-row-invalid' };
  const identity = parseStoredSoraChainIdentity(identityEnvelope.payload);
  if (!identity || identity.verificationBlock !== identityEnvelope.blockHeight ||
      identity.verificationBlockTimestamp !== identityEnvelope.timestamp) {
    return { ok: false, code: 'identity-checkpoint-invalid' };
  }
  // Keep the fixed-anchor requirement local even though the shared parser also
  // enforces it. This prevents a future parser relaxation from weakening the
  // production worker health contract.
  if (identity.verificationBlock !== SORA_LEGACY_IDENTITY_ANCHOR.block ||
      identity.verificationBlockHash !== SORA_LEGACY_IDENTITY_ANCHOR.hash ||
      identity.verificationBlockTimestamp !== SORA_LEGACY_IDENTITY_ANCHOR.timestamp) {
    return { ok: false, code: 'identity-anchor-invalid' };
  }

  const stateEnvelope = parseUpdateEnvelope(byId.get(CHAIN_STATE_ID), CHAIN_STATE_ID);
  if (!stateEnvelope) return { ok: false, code: 'state-row-invalid' };
  return { ok: true, identity, stateEnvelope };
};

const validateSnapshotRow = (row: unknown, state: StoredSoraChainState): boolean => {
  if (!isExactRecord(row, ['blockHeight', 'collection', 'data', 'id', 'timestamp']) ||
      row.collection !== NETWORK_SNAPSHOTS_COLLECTION || row.id !== `block-${state.lastIndexedBlock}` ||
      parsePositivePgInteger(row.blockHeight) !== state.lastIndexedBlock ||
      parsePositivePgInteger(row.timestamp) !== state.blockTimestamp ||
      !row.data || typeof row.data !== 'object' || Array.isArray(row.data)) {
    return false;
  }
  const data = row.data as Record<string, unknown>;
  return data.id === `block-${state.lastIndexedBlock}` && data.type === 'BLOCK' &&
    parsePositiveJsonInteger(data.timestamp) === state.blockTimestamp;
};

/**
 * Pure validation for the database rows used by the standalone worker probe.
 * PostgreSQL bigint columns are intentionally selected as canonical decimal
 * text, while JSON integers must remain actual safe integers.
 */
export const validateWorkerHealthDocuments = (
  updateRows: unknown,
  snapshotRows: unknown,
  nowSec: number,
): WorkerHealthValidation => {
  if (!Number.isSafeInteger(nowSec) || nowSec <= 0) return { ok: false, code: 'deadline-invalid' };
  const identityRows = parseIdentityRows(updateRows);
  if (!identityRows.ok) return identityRows;

  const state = parseStoredSoraChainState(identityRows.stateEnvelope.payload);
  if (!state || state.lastIndexedBlock !== identityRows.stateEnvelope.blockHeight) {
    return { ok: false, code: 'state-checkpoint-invalid' };
  }
  if (!isStoredSoraChainStateCoherent(identityRows.identity, state) ||
      identityRows.stateEnvelope.timestamp < state.blockTimestamp - WORKER_HEALTH_MAX_FUTURE_SEC ||
      identityRows.stateEnvelope.timestamp > nowSec + WORKER_HEALTH_MAX_FUTURE_SEC) {
    return { ok: false, code: 'state-incoherent' };
  }

  const ageSec = nowSec - state.blockTimestamp;
  if (ageSec > WORKER_HEALTH_MAX_STALE_SEC) return { ok: false, code: 'state-stale' };
  if (ageSec < -WORKER_HEALTH_MAX_FUTURE_SEC) return { ok: false, code: 'state-future' };

  if (!Array.isArray(snapshotRows) || snapshotRows.length !== 1) {
    return { ok: false, code: 'snapshot-row-invalid' };
  }
  if (!validateSnapshotRow(snapshotRows[0], state)) {
    return { ok: false, code: 'snapshot-envelope-invalid' };
  }
  return { ok: true, identity: identityRows.identity, state };
};

const deadline = async <T>(operation: Promise<T>, timeoutMs: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('worker health operation deadline exceeded')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const validDatabaseUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || !value || value.length > 8_192 || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:') && Boolean(parsed.hostname) && !parsed.hash;
  } catch {
    return false;
  }
};

export const parseWorkerHealthTimeoutMs = (value: unknown): number | null => {
  if (value === undefined || value === '') return WORKER_HEALTH_TOTAL_TIMEOUT_MS;
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1_000 && parsed <= 4_500 ? parsed : null;
};

const defaultDatabase = (databaseUrl: string): WorkerHealthDatabase => {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: WORKER_HEALTH_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: WORKER_HEALTH_CLEANUP_TIMEOUT_MS,
    query_timeout: WORKER_HEALTH_QUERY_TIMEOUT_MS,
    statement_timeout: WORKER_HEALTH_QUERY_TIMEOUT_MS,
    application_name: 'polkaswap-worker-health',
    allowExitOnIdle: true,
  });
  // Idle pg errors otherwise become unhandled EventEmitter errors whose driver
  // diagnostics could expose connection metadata. The probe reports only its
  // fixed failure code and the next bounded query determines health.
  pool.on('error', () => undefined);
  return pool;
};

export const runWorkerHealthDatabaseProbe = async (
  options: WorkerHealthProbeOptions = {},
): Promise<WorkerHealthValidation> => {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  const totalTimeoutMs = options.totalTimeoutMs ?? parseWorkerHealthTimeoutMs(process.env.PI_WORKER_HEALTH_TIMEOUT_MS);
  if (!validDatabaseUrl(databaseUrl)) return { ok: false, code: 'database-url-invalid' };
  if (totalTimeoutMs === null || !Number.isSafeInteger(totalTimeoutMs) || totalTimeoutMs < 1_000 || totalTimeoutMs > 4_500) {
    return { ok: false, code: 'deadline-invalid' };
  }
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1_000);
  const createDatabase = options.createDatabase ?? defaultDatabase;
  let database: WorkerHealthDatabase;
  try {
    database = createDatabase(databaseUrl);
  } catch {
    return { ok: false, code: 'database-operation-failed' };
  }

  const startedAt = Date.now();
  const remainingMs = (): number => Math.max(1, totalTimeoutMs - (Date.now() - startedAt));
  let result: WorkerHealthValidation = { ok: false, code: 'database-operation-failed' };
  try {
    const updateResult = await deadline(
      database.query(UPDATE_ROWS_SQL, [
        UPDATE_STREAMS_COLLECTION,
        [CHAIN_IDENTITY_ID, CHAIN_STATE_ID],
        WORKER_HEALTH_MAX_DOCUMENT_BYTES,
      ]),
      Math.min(WORKER_HEALTH_QUERY_TIMEOUT_MS, remainingMs()),
    );
    const parsed = parseIdentityRows(updateResult.rows);
    if (!parsed.ok) {
      result = parsed;
    } else {
      const state = parseStoredSoraChainState(parsed.stateEnvelope.payload);
      if (!state) {
        result = { ok: false, code: 'state-checkpoint-invalid' };
      } else {
        const snapshotResult = await deadline(
          database.query(SNAPSHOT_ROW_SQL, [
            NETWORK_SNAPSHOTS_COLLECTION,
            `block-${state.lastIndexedBlock}`,
            WORKER_HEALTH_MAX_DOCUMENT_BYTES,
          ]),
          Math.min(WORKER_HEALTH_QUERY_TIMEOUT_MS, remainingMs()),
        );
        result = validateWorkerHealthDocuments(updateResult.rows, snapshotResult.rows, nowSec);
      }
    }
  } catch {
    result = { ok: false, code: 'database-operation-failed' };
  } finally {
    try {
      await deadline(database.end(), Math.min(WORKER_HEALTH_CLEANUP_TIMEOUT_MS, remainingMs()));
    } catch {
      result = { ok: false, code: 'database-operation-failed' };
    }
  }
  return result;
};

const runCli = async (): Promise<void> => {
  const totalTimeoutMs = parseWorkerHealthTimeoutMs(process.env.PI_WORKER_HEALTH_TIMEOUT_MS);
  if (totalTimeoutMs === null) {
    console.error('[worker-health] failed closed: invalid deadline configuration');
    process.exit(1);
  }
  const hardDeadline = setTimeout(() => {
    console.error('[worker-health] failed closed before the container deadline');
    process.exit(1);
  }, totalTimeoutMs);
  const result = await runWorkerHealthDatabaseProbe({ totalTimeoutMs });
  clearTimeout(hardDeadline);
  if (!result.ok) {
    console.error(`[worker-health] failed closed: ${result.code}`);
    process.exit(1);
  }
  process.stdout.write('[worker-health] SORA mainnet worker checkpoint is healthy\n');
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch(() => {
    console.error('[worker-health] failed closed: unexpected probe failure');
    process.exit(1);
  });
}
