import { describe, expect, it } from 'vitest';

import { evaluateServiceReadiness, evaluateWorkerReadiness } from '../src/readiness.js';
import { MemoryRepository } from '../src/repository/memory.js';
import {
  createPersistedWorkerStatusDocument,
  WORKER_STATUS_DOCUMENT_ID,
} from '../src/worker/status.js';

import type { ChainIndexerStatus, ChainIndexerStatusProvider } from '../src/worker/status.js';

const NOW = 1_700_000_000;
const thresholds = { maxLagBlocks: 25, maxStalenessSeconds: 120 };
const healthyStatus = (overrides: Partial<ChainIndexerStatus> = {}): ChainIndexerStatus => ({
  lifecycle: 'running',
  startupComplete: true,
  latestFinalizedBlock: 1_000,
  latestIndexedBlock: 995,
  lag: 5,
  lastSuccessfulIndexTimestamp: NOW - 5,
  lastError: null,
  lastErrorTimestamp: null,
  ...overrides,
});
const provider = (status: ChainIndexerStatus): ChainIndexerStatusProvider => ({ getStatus: () => ({ ...status }) });

describe('worker readiness', () => {
  it('fails closed when neither a local worker nor a shared heartbeat is available', async () => {
    const repository = new MemoryRepository();

    expect(evaluateWorkerReadiness(undefined, thresholds, NOW)).toEqual({
      available: false,
      ready: false,
      reason: 'status-unavailable',
      status: null,
    });
    await expect(evaluateServiceReadiness(repository, undefined, thresholds, NOW)).resolves.toMatchObject({
      ok: false,
      repositoryReady: true,
      worker: { available: false, ready: false, reason: 'status-unavailable' },
    });
  });

  it.each([
    ['never-started', healthyStatus({ lifecycle: 'idle', startupComplete: false }), 'lifecycle-idle'],
    ['starting', healthyStatus({ lifecycle: 'starting', startupComplete: false }), 'lifecycle-starting'],
    ['backfill', healthyStatus({ lifecycle: 'running', startupComplete: false }), 'startup-incomplete'],
    ['stopping', healthyStatus({ lifecycle: 'stopping' }), 'lifecycle-stopping'],
    ['stopped', healthyStatus({ lifecycle: 'stopped' }), 'lifecycle-stopped'],
    [
      'failed',
      healthyStatus({ lifecycle: 'failed', lastError: 'boom', lastErrorTimestamp: NOW }),
      'lifecycle-failed',
    ],
  ])('rejects a %s worker', (_label, status, reason) => {
    expect(evaluateWorkerReadiness(provider(status), thresholds, NOW)).toMatchObject({
      available: true,
      ready: false,
      reason,
    });
  });

  it('accepts the lag and staleness boundaries inclusively', () => {
    const status = healthyStatus({
      latestFinalizedBlock: 1_000,
      latestIndexedBlock: 975,
      lag: 25,
      lastSuccessfulIndexTimestamp: NOW - 120,
    });

    expect(evaluateWorkerReadiness(provider(status), thresholds, NOW)).toMatchObject({ ready: true, reason: null });
  });

  it('rejects a lagged worker', () => {
    const status = healthyStatus({ latestIndexedBlock: 974, lag: 26 });
    expect(evaluateWorkerReadiness(provider(status), thresholds, NOW)).toMatchObject({
      ready: false,
      reason: 'lag-exceeded',
    });
  });

  it('rejects an indexed height ahead of the finalized source instead of clamping lag to zero', () => {
    const status = healthyStatus({ latestFinalizedBlock: 1_000, latestIndexedBlock: 1_001, lag: null });
    expect(evaluateWorkerReadiness(provider(status), thresholds, NOW)).toMatchObject({
      available: true,
      ready: false,
      reason: 'indexed-ahead-of-finalized',
    });
  });

  it('rejects a stale or future commit timestamp', () => {
    expect(
      evaluateWorkerReadiness(
        provider(healthyStatus({ lastSuccessfulIndexTimestamp: NOW - 121 })),
        thresholds,
        NOW
      )
    ).toMatchObject({ ready: false, reason: 'last-success-stale' });
    expect(
      evaluateWorkerReadiness(
        provider(healthyStatus({ lastSuccessfulIndexTimestamp: NOW + 1 })),
        thresholds,
        NOW
      )
    ).toMatchObject({ ready: false, reason: 'last-success-in-future' });
  });

  it.each([
    [healthyStatus({ latestFinalizedBlock: null, lag: null }), 'finalized-head-unavailable'],
    [healthyStatus({ latestIndexedBlock: null, lag: null }), 'indexed-block-unavailable'],
    [healthyStatus({ lag: null }), 'lag-unavailable'],
    [healthyStatus({ lastSuccessfulIndexTimestamp: null }), 'last-success-unavailable'],
    [healthyStatus({ latestFinalizedBlock: 1_000, latestIndexedBlock: 995, lag: 4 }), 'status-inconsistent'],
    [healthyStatus({ lastSuccessfulIndexTimestamp: -1 }), 'last-success-invalid'],
  ])('rejects incomplete or inconsistent worker status', (status, reason) => {
    expect(evaluateWorkerReadiness(provider(status), thresholds, NOW)).toMatchObject({ ready: false, reason });
  });

  it('fails closed when status collection throws or thresholds are invalid', () => {
    expect(
      evaluateWorkerReadiness(
        {
          getStatus: () => {
            throw new Error('status failure');
          },
        },
        thresholds,
        NOW
      )
    ).toMatchObject({ available: true, ready: false, reason: 'status-unavailable', status: null });
    expect(
      evaluateWorkerReadiness(
        provider(healthyStatus({ startupComplete: 'yes' as never })),
        thresholds,
        NOW
      )
    ).toMatchObject({ available: true, ready: false, reason: 'status-inconsistent', status: null });
    expect(
      evaluateWorkerReadiness(
        provider(healthyStatus({ lastError: 123 as never })),
        thresholds,
        NOW
      )
    ).toMatchObject({ available: true, ready: false, reason: 'status-inconsistent', status: null });
    expect(evaluateWorkerReadiness(provider(healthyStatus()), { ...thresholds, maxLagBlocks: -1 }, NOW)).toMatchObject({
      ready: false,
      reason: 'invalid-thresholds',
    });
    expect(evaluateWorkerReadiness(provider(healthyStatus()), thresholds, Number.NaN)).toMatchObject({
      ready: false,
      reason: 'invalid-clock',
    });
    expect(
      evaluateWorkerReadiness({ getStatus: () => null as never }, thresholds, NOW)
    ).toMatchObject({ available: true, ready: false, reason: 'status-unavailable', status: null });
    expect(
      evaluateWorkerReadiness(
        {
          getStatus: () =>
            Object.defineProperty({}, 'lifecycle', {
              get: () => {
                throw new Error('hostile getter');
              },
            }) as ChainIndexerStatus,
        },
        thresholds,
        NOW
      )
    ).toMatchObject({ available: true, ready: false, reason: 'status-unavailable', status: null });
  });

  it('requires both repository and worker readiness in combined mode', async () => {
    const repository = new MemoryRepository();
    repository.healthCheck = async () => false;

    await expect(
      evaluateServiceReadiness(repository, provider(healthyStatus()), thresholds, NOW)
    ).resolves.toMatchObject({
      ok: false,
      repositoryReady: false,
      worker: { ready: true },
    });
  });

  it('fails closed for synchronous and non-boolean repository health results', async () => {
    const synchronousFailure = {
      healthCheck: () => {
        throw new Error('repository unavailable');
      },
    } as unknown as MemoryRepository;
    const invalidSuccess = {
      healthCheck: async () => 'yes',
    } as unknown as MemoryRepository;

    await expect(
      evaluateServiceReadiness(synchronousFailure, provider(healthyStatus()), thresholds, NOW)
    ).resolves.toMatchObject({ ok: false, repositoryReady: false });
    await expect(
      evaluateServiceReadiness(invalidSuccess, provider(healthyStatus()), thresholds, NOW)
    ).resolves.toMatchObject({ ok: false, repositoryReady: false });
  });

  it('reports a healthy combined service only when every gate passes', async () => {
    await expect(
      evaluateServiceReadiness(new MemoryRepository(), provider(healthyStatus()), thresholds, NOW)
    ).resolves.toMatchObject({
      ok: true,
      repositoryReady: true,
      worker: { available: true, ready: true, reason: null },
    });
  });

  it('uses a compatible persisted heartbeat for split-process readiness', async () => {
    const repository = new MemoryRepository();
    await repository.upsert(createPersistedWorkerStatusDocument(healthyStatus(), NOW));

    await expect(evaluateServiceReadiness(repository, undefined, thresholds, NOW)).resolves.toMatchObject({
      ok: true,
      repositoryReady: true,
      worker: { available: true, ready: true, reason: null },
    });
  });

  it('rejects stale, future, and incompatible persisted heartbeats', async () => {
    const stale = new MemoryRepository();
    await stale.upsert(createPersistedWorkerStatusDocument(healthyStatus(), NOW - 121));
    await expect(evaluateServiceReadiness(stale, undefined, thresholds, NOW)).resolves.toMatchObject({
      ok: false,
      worker: { available: true, ready: false, reason: 'heartbeat-stale' },
    });

    const future = new MemoryRepository();
    await future.upsert(createPersistedWorkerStatusDocument(healthyStatus(), NOW + 1));
    await expect(evaluateServiceReadiness(future, undefined, thresholds, NOW)).resolves.toMatchObject({
      ok: false,
      worker: { available: true, ready: false, reason: 'heartbeat-in-future' },
    });

    const incompatible = new MemoryRepository();
    await incompatible.upsert({
      collection: 'updatesStreams',
      id: WORKER_STATUS_DOCUMENT_ID,
      blockHeight: null,
      timestamp: NOW,
      data: {
        id: WORKER_STATUS_DOCUMENT_ID,
        schemaVersion: 999,
        heartbeatTimestamp: NOW,
        status: healthyStatus(),
      },
    });
    await expect(evaluateServiceReadiness(incompatible, undefined, thresholds, NOW)).resolves.toMatchObject({
      ok: false,
      worker: { available: false, ready: false, reason: 'status-incompatible' },
    });
  });

  it('rejects timestamp, lag, and exact-shape tampering in a persisted status', async () => {
    const base = createPersistedWorkerStatusDocument(healthyStatus(), NOW);
    const tamperedDocuments = [
      { ...structuredClone(base), timestamp: NOW - 1 },
      {
        ...structuredClone(base),
        data: {
          ...structuredClone(base.data),
          status: { ...(base.data.status as Record<string, unknown>), lag: 4 },
        },
      },
      {
        ...structuredClone(base),
        data: {
          ...structuredClone(base.data),
          status: { ...(base.data.status as Record<string, unknown>), unexpected: true },
        },
      },
    ];

    for (const document of tamperedDocuments) {
      const repository = new MemoryRepository();
      await repository.upsert(document);
      await expect(evaluateServiceReadiness(repository, undefined, thresholds, NOW)).resolves.toMatchObject({
        ok: false,
        worker: { available: false, ready: false, reason: 'status-incompatible' },
      });
    }
  });

  it('does not allow a delayed heartbeat to overwrite a newer shared lease', async () => {
    const repository = new MemoryRepository();
    await repository.upsert(createPersistedWorkerStatusDocument(healthyStatus(), NOW));
    await repository.upsert(
      createPersistedWorkerStatusDocument(
        healthyStatus({ lifecycle: 'failed', startupComplete: false, lastError: 'late old process' }),
        NOW - 1
      )
    );

    await expect(evaluateServiceReadiness(repository, undefined, thresholds, NOW)).resolves.toMatchObject({
      ok: true,
      worker: { available: true, ready: true, reason: null, status: { lifecycle: 'running' } },
    });
  });
});
