import type { IndexerRepository } from './repository/types.js';
import {
  CHAIN_INDEXER_LIFECYCLES,
  parsePersistedWorkerStatus,
  WORKER_STATUS_DOCUMENT_ID,
  type ChainIndexerStatus,
  type ChainIndexerStatusProvider,
} from './worker/status.js';

export type WorkerReadinessThresholds = {
  maxLagBlocks: number;
  maxStalenessSeconds: number;
};

export type WorkerReadiness = {
  available: boolean;
  ready: boolean | null;
  reason: string | null;
  status: ChainIndexerStatus | null;
};

export type ServiceReadiness = {
  ok: boolean;
  repositoryReady: boolean;
  worker: WorkerReadiness;
};

const unavailableWorker = (reason = 'status-unavailable'): WorkerReadiness => ({
  available: false,
  ready: false,
  reason,
  status: null,
});

const notReady = (status: ChainIndexerStatus, reason: string): WorkerReadiness => ({
  available: true,
  ready: false,
  reason,
  status,
});

const invalidWorkerStatus = (reason = 'status-inconsistent'): WorkerReadiness => ({
  available: true,
  ready: false,
  reason,
  status: null,
});

const isNullableNonNegativeInteger = (value: number | null): boolean =>
  value === null || (Number.isSafeInteger(value) && value >= 0);

export function evaluateWorkerReadiness(
  provider: ChainIndexerStatusProvider | undefined,
  thresholds: WorkerReadinessThresholds,
  nowTimestamp = Math.floor(Date.now() / 1_000),
  heartbeatTimestamp?: number
): WorkerReadiness {
  if (!provider) return unavailableWorker();

  let status: ChainIndexerStatus;
  try {
    const rawStatus = provider.getStatus();
    if (!rawStatus || typeof rawStatus !== 'object') throw new Error('Invalid worker status');
    status = {
      lifecycle: rawStatus.lifecycle,
      startupComplete: rawStatus.startupComplete,
      latestFinalizedBlock: rawStatus.latestFinalizedBlock,
      latestIndexedBlock: rawStatus.latestIndexedBlock,
      lag: rawStatus.lag,
      lastSuccessfulIndexTimestamp: rawStatus.lastSuccessfulIndexTimestamp,
      lastError: rawStatus.lastError,
      lastErrorTimestamp: rawStatus.lastErrorTimestamp,
    };

    if (!CHAIN_INDEXER_LIFECYCLES.includes(status.lifecycle)) return invalidWorkerStatus();
    if (typeof status.startupComplete !== 'boolean') return invalidWorkerStatus();
    if (
      status.lastError !== null &&
      (typeof status.lastError !== 'string' || status.lastError.length > 1_000)
    ) {
      return invalidWorkerStatus();
    }
    if (!isNullableNonNegativeInteger(status.latestFinalizedBlock)) return invalidWorkerStatus();
    if (!isNullableNonNegativeInteger(status.latestIndexedBlock)) return invalidWorkerStatus();
    if (!isNullableNonNegativeInteger(status.lag)) return invalidWorkerStatus();
    if (!isNullableNonNegativeInteger(status.lastErrorTimestamp)) return invalidWorkerStatus();
    if (!isNullableNonNegativeInteger(status.lastSuccessfulIndexTimestamp)) {
      return invalidWorkerStatus('last-success-invalid');
    }
    if ((status.lastError === null) !== (status.lastErrorTimestamp === null)) return invalidWorkerStatus();
    if (
      status.latestFinalizedBlock !== null &&
      status.latestIndexedBlock !== null &&
      status.latestIndexedBlock > status.latestFinalizedBlock
    ) {
      return notReady(status, 'indexed-ahead-of-finalized');
    }
    if (
      status.latestFinalizedBlock !== null &&
      status.latestIndexedBlock !== null &&
      status.lag !== null &&
      status.lag !== status.latestFinalizedBlock - status.latestIndexedBlock
    ) {
      return invalidWorkerStatus();
    }

    if (
      !Number.isSafeInteger(thresholds.maxLagBlocks) ||
      thresholds.maxLagBlocks < 0 ||
      !Number.isSafeInteger(thresholds.maxStalenessSeconds) ||
      thresholds.maxStalenessSeconds < 0
    ) {
      return notReady(status, 'invalid-thresholds');
    }
    if (!Number.isSafeInteger(nowTimestamp) || nowTimestamp < 0) return notReady(status, 'invalid-clock');
    if (
      heartbeatTimestamp !== undefined &&
      (!Number.isSafeInteger(heartbeatTimestamp) || heartbeatTimestamp < 0)
    ) {
      return invalidWorkerStatus('heartbeat-invalid');
    }
    if (heartbeatTimestamp !== undefined && heartbeatTimestamp > nowTimestamp) {
      return notReady(status, 'heartbeat-in-future');
    }
    if (
      heartbeatTimestamp !== undefined &&
      nowTimestamp - heartbeatTimestamp > thresholds.maxStalenessSeconds
    ) {
      return notReady(status, 'heartbeat-stale');
    }

    if (status.lifecycle !== 'running') return notReady(status, `lifecycle-${status.lifecycle}`);
    if (!status.startupComplete) return notReady(status, 'startup-incomplete');
    if (status.latestFinalizedBlock === null) return notReady(status, 'finalized-head-unavailable');
    if (status.latestIndexedBlock === null) return notReady(status, 'indexed-block-unavailable');
    if (status.lag === null) return notReady(status, 'lag-unavailable');
    if (status.lag > thresholds.maxLagBlocks) return notReady(status, 'lag-exceeded');
    if (status.lastSuccessfulIndexTimestamp === null) return notReady(status, 'last-success-unavailable');
    if (status.lastSuccessfulIndexTimestamp > nowTimestamp) return notReady(status, 'last-success-in-future');
    if (nowTimestamp - status.lastSuccessfulIndexTimestamp > thresholds.maxStalenessSeconds) {
      return notReady(status, 'last-success-stale');
    }

    return {
      available: true,
      ready: true,
      reason: null,
      status,
    };
  } catch {
    return {
      available: true,
      ready: false,
      reason: 'status-unavailable',
      status: null,
    };
  }
}

export async function evaluateServiceReadiness(
  repository: IndexerRepository,
  workerStatusProvider: ChainIndexerStatusProvider | undefined,
  thresholds: WorkerReadinessThresholds,
  nowTimestamp = Math.floor(Date.now() / 1_000)
): Promise<ServiceReadiness> {
  let repositoryReady = true;
  if (repository.healthCheck) {
    try {
      repositoryReady = (await repository.healthCheck()) === true;
    } catch {
      repositoryReady = false;
    }
  }
  let worker: WorkerReadiness;
  if (workerStatusProvider) {
    worker = evaluateWorkerReadiness(workerStatusProvider, thresholds, nowTimestamp);
  } else {
    try {
      const document = await repository.get('updatesStreams', WORKER_STATUS_DOCUMENT_ID);
      const persisted = parsePersistedWorkerStatus(document);
      worker = persisted
        ? evaluateWorkerReadiness(
            { getStatus: () => persisted.status },
            thresholds,
            nowTimestamp,
            persisted.heartbeatTimestamp
          )
        : unavailableWorker(document ? 'status-incompatible' : 'status-unavailable');
    } catch {
      worker = unavailableWorker();
    }
  }

  return {
    ok: repositoryReady && worker.ready === true,
    repositoryReady,
    worker,
  };
}
