import { metrics } from '../metrics.js';

import type { IndexerDocument } from '../repository/types.js';

export const CHAIN_INDEXER_LIFECYCLES = [
  'idle',
  'starting',
  'running',
  'stopping',
  'stopped',
  'failed',
] as const;

export type ChainIndexerLifecycle = (typeof CHAIN_INDEXER_LIFECYCLES)[number];

export type ChainIndexerStatus = {
  lifecycle: ChainIndexerLifecycle;
  startupComplete: boolean;
  latestFinalizedBlock: number | null;
  latestIndexedBlock: number | null;
  lag: number | null;
  lastSuccessfulIndexTimestamp: number | null;
  lastError: string | null;
  lastErrorTimestamp: number | null;
};

export type ChainIndexerStatusProvider = {
  getStatus(): ChainIndexerStatus;
};

export const WORKER_STATUS_DOCUMENT_ID = 'workerStatus-v1';
export const WORKER_STATUS_SCHEMA_VERSION = 1;
export const WORKER_STATUS_HEARTBEAT_INTERVAL_MS = 15_000;

export type PersistedChainIndexerStatus = {
  status: ChainIndexerStatus;
  heartbeatTimestamp: number;
};

export const chainIndexerLag = (
  latestFinalizedBlock: number | null,
  latestIndexedBlock: number | null
): number | null => {
  if (latestFinalizedBlock === null || latestIndexedBlock === null) return null;
  if (latestIndexedBlock > latestFinalizedBlock) return null;
  return latestFinalizedBlock - latestIndexedBlock;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isNullableNonNegativeSafeInteger = (value: unknown): value is number | null =>
  value === null || (Number.isSafeInteger(value) && Number(value) >= 0);

/**
 * Creates the repository heartbeat shared by split API and worker processes.
 * The document uses heartbeat time, rather than chain height, as its monotonic
 * repository version so a newly starting worker can replace an old process'
 * terminal status while a delayed old write cannot overwrite a newer lease.
 */
export const createPersistedWorkerStatusDocument = (
  status: ChainIndexerStatus,
  heartbeatTimestamp = Math.floor(Date.now() / 1_000)
): IndexerDocument => ({
  collection: 'updatesStreams',
  id: WORKER_STATUS_DOCUMENT_ID,
  // Repository writes are monotonic by blockHeight. Reusing that guard for the
  // heartbeat clock prevents a delayed process from overwriting a newer lease.
  blockHeight: heartbeatTimestamp,
  timestamp: heartbeatTimestamp,
  data: {
    id: WORKER_STATUS_DOCUMENT_ID,
    schemaVersion: WORKER_STATUS_SCHEMA_VERSION,
    heartbeatTimestamp,
    status: { ...status },
  },
});

/** Parses only the exact, compatible status shape used for readiness. */
export const parsePersistedWorkerStatus = (
  document: IndexerDocument | null
): PersistedChainIndexerStatus | null => {
  if (!document || document.collection !== 'updatesStreams' || document.id !== WORKER_STATUS_DOCUMENT_ID) {
    return null;
  }
  const data = document.data;
  const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
    const actual = Object.keys(value).sort();
    const sortedExpected = [...expected].sort();
    return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
  };
  if (
    !exactKeys(data, ['heartbeatTimestamp', 'id', 'schemaVersion', 'status']) ||
    data.id !== WORKER_STATUS_DOCUMENT_ID ||
    data.schemaVersion !== WORKER_STATUS_SCHEMA_VERSION ||
    !Number.isSafeInteger(data.heartbeatTimestamp) ||
    Number(data.heartbeatTimestamp) < 0 ||
    document.timestamp !== data.heartbeatTimestamp ||
    document.blockHeight !== data.heartbeatTimestamp ||
    !isRecord(data.status)
  ) {
    return null;
  }

  const raw = data.status;
  if (
    !exactKeys(raw, [
      'lag',
      'lastError',
      'lastErrorTimestamp',
      'lastSuccessfulIndexTimestamp',
      'latestFinalizedBlock',
      'latestIndexedBlock',
      'lifecycle',
      'startupComplete',
    ]) ||
    !CHAIN_INDEXER_LIFECYCLES.includes(raw.lifecycle as ChainIndexerLifecycle) ||
    typeof raw.startupComplete !== 'boolean' ||
    !isNullableNonNegativeSafeInteger(raw.latestFinalizedBlock) ||
    !isNullableNonNegativeSafeInteger(raw.latestIndexedBlock) ||
    !isNullableNonNegativeSafeInteger(raw.lag) ||
    !isNullableNonNegativeSafeInteger(raw.lastSuccessfulIndexTimestamp) ||
    (raw.lastError !== null && (typeof raw.lastError !== 'string' || raw.lastError.length > 1_000)) ||
    !isNullableNonNegativeSafeInteger(raw.lastErrorTimestamp)
  ) {
    return null;
  }
  if ((raw.lastError === null) !== (raw.lastErrorTimestamp === null)) return null;

  const expectedLag = chainIndexerLag(raw.latestFinalizedBlock, raw.latestIndexedBlock);
  if (raw.lag !== expectedLag) return null;

  return {
    heartbeatTimestamp: Number(data.heartbeatTimestamp),
    status: {
      lifecycle: raw.lifecycle as ChainIndexerLifecycle,
      startupComplete: raw.startupComplete,
      latestFinalizedBlock: raw.latestFinalizedBlock,
      latestIndexedBlock: raw.latestIndexedBlock,
      lag: raw.lag,
      lastSuccessfulIndexTimestamp: raw.lastSuccessfulIndexTimestamp,
      lastError: raw.lastError,
      lastErrorTimestamp: raw.lastErrorTimestamp,
    },
  };
};

export const publishChainIndexerStatusMetrics = (status: ChainIndexerStatus): void => {
  for (const lifecycle of CHAIN_INDEXER_LIFECYCLES) {
    metrics.setGauge('indexer_worker_lifecycle', { lifecycle }, status.lifecycle === lifecycle ? 1 : 0);
  }
  metrics.setGauge('indexer_worker_startup_complete', {}, status.startupComplete ? 1 : 0);
  metrics.setGauge('indexer_worker_latest_finalized_block', {}, status.latestFinalizedBlock ?? -1);
  metrics.setGauge('indexer_worker_latest_indexed_block', {}, status.latestIndexedBlock ?? -1);
  metrics.setGauge('indexer_worker_lag_blocks', {}, status.lag ?? -1);
  metrics.setGauge(
    'indexer_worker_last_successful_index_timestamp_seconds',
    {},
    status.lastSuccessfulIndexTimestamp ?? 0
  );
  metrics.setGauge('indexer_worker_last_error_timestamp_seconds', {}, status.lastErrorTimestamp ?? 0);
};
