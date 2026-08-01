import { afterEach, describe, expect, it, vi } from 'vitest';

import { metrics } from '../src/metrics.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { buildWorkerObservabilityResponse, createWorkerObservabilityServer } from '../src/worker/observability.js';

import type { AppConfig } from '../src/config.js';
import type { ChainIndexerStatus, ChainIndexerStatusProvider } from '../src/worker/status.js';

const config: AppConfig = {
  host: '127.0.0.1',
  port: 4350,
  graphqlPath: '/graphql',
  httpListenBacklog: 4_096,
  httpShutdownTimeoutMs: 30_000,
  httpKeepAliveTimeoutMs: 75_000,
  httpHeadersTimeoutMs: 80_000,
  httpRequestTimeoutMs: 120_000,
  httpMaxConnections: 10_000,
  graphqlHttpMaxBodyBytes: 262_144,
  graphqlHttpMaxInFlight: 100,
  graphqlMaxDepth: 12,
  graphqlMaxDocumentNodes: 2_000,
  graphqlMaxFields: 500,
  graphqlMaxAliases: 50,
  graphqlMaxFragmentSpreads: 100,
  graphqlMaxOperationCost: 100_000,
  graphqlAllowIntrospection: false,
  graphqlWsMaxPayloadBytes: 65_536,
  graphqlWsConnectionInitTimeoutMs: 30_000,
  graphqlWsMaxConnections: 1_000,
  graphqlWsMaxOperations: 2_000,
  graphqlWsMaxOperationsPerConnection: 20,
  graphqlWsMaxPendingMessagesPerConnection: 64,
  graphqlCacheMaxEntries: 1_000,
  graphqlCacheMaxBytes: 67_108_864,
  graphqlCacheTtlMs: 2_000,
  graphqlMaxResultBytes: 67_108_864,
  graphqlExecutionMemoryMaxBytes: 536_870_912,
  storageEngine: 'postgres',
  databaseUrl: 'postgres://polkaswap:polkaswap@127.0.0.1:5432/polkaswap_indexer',
  skipPostgresMigration: false,
  postgresPoolMax: 20,
  postgresListenPoolMax: 2,
  postgresConnectionTimeoutMs: 10_000,
  postgresQueryTimeoutMs: 120_000,
  postgresStatementTimeoutMs: 120_000,
  postgresMigrationQueryTimeoutMs: 0,
  postgresMigrationStatementTimeoutMs: 0,
  postgresWatchQueueMax: 1_000,
  postgresWatchReconnectMinDelayMs: 100,
  postgresWatchReconnectMaxDelayMs: 10_000,
  rocksdbPath: './data/polkaswap-indexer.rocksdb',
  rocksdbBlockCacheMb: 512,
  rocksdbWriteBufferManagerMb: 256,
  rocksdbParallelism: 4,
  rocksdbEnableStats: false,
  rocksdbDocumentCacheMax: 10_000,
  rocksdbDocumentCacheMaxBytes: 268_435_456,
  rocksdbWatchQueueMax: 1_000,
  rocksdbQueryMaxScannedRows: 100_000,
  rocksdbCompactionMinFreeGb: 10,
  soraWsEndpoint: 'wss://mof2.sora.org',
  chainStartBlock: 0,
  chainBatchSize: 25,
  stateRefreshIntervalBlocks: 25,
  snapshotIntervalBlocks: 25,
  fullReconciliationIntervalBlocks: 250,
  chainShutdownTimeoutMs: 30_000,
  chainRpcTimeoutMs: 15_000,
  chainRpcMaxInFlight: 256,
  derivedStorageLoadMaxBytes: 268_435_456,
  derivedStorageCacheMaxBytes: 67_108_864,
  analyticsInputCacheMaxBytes: 134_217_728,
  backfillPrefetchConcurrency: 1,
  finalizedCatchupPrefetchConcurrency: 1,
  priceStreamRefreshIntervalBlocks: 0,
  legacySoraBlockTypes: false,
  archiveSoraWsEndpoint: '',
  workerReadinessMaxLagBlocks: 25,
  workerReadinessMaxStalenessSeconds: 120,
  workerMetricsHost: '127.0.0.1',
  workerMetricsPort: 9464,
  workerMetricsMaxInFlight: 10,
};

const status = (overrides: Partial<ChainIndexerStatus> = {}): ChainIndexerStatus => {
  const now = Math.floor(Date.now() / 1_000);
  return {
    lifecycle: 'running',
    startupComplete: true,
    latestFinalizedBlock: 1_000,
    latestIndexedBlock: 995,
    lag: 5,
    lastSuccessfulIndexTimestamp: now,
    lastError: null,
    lastErrorTimestamp: null,
    ...overrides,
  };
};
const provider = (value: ChainIndexerStatus): ChainIndexerStatusProvider => ({ getStatus: () => value });

afterEach(() => metrics.reset());

describe('worker observability responses', () => {
  it('constructs the HTTP server without binding a socket', () => {
    const server = createWorkerObservabilityServer(
      config,
      new MemoryRepository(),
      provider(status())
    );

    expect(server.listening).toBe(false);
    expect(server.listenerCount('request')).toBe(1);
    expect(server.maxConnections).toBe(config.httpMaxConnections);
    expect(server.keepAliveTimeout).toBe(config.httpKeepAliveTimeoutMs);
    expect(server.headersTimeout).toBe(config.httpHeadersTimeoutMs);
    expect(server.requestTimeout).toBe(config.httpRequestTimeoutMs);
  });

  it('returns a ready JSON health response for a healthy worker and repository', async () => {
    const result = await buildWorkerObservabilityResponse(
      'GET',
      '/health',
      config,
      new MemoryRepository(),
      provider(status())
    );

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      ok: true,
      repositoryReady: true,
      workerAvailable: true,
      workerReady: true,
      worker: { lifecycle: 'running', lag: 5 },
    });
  });

  it('returns 503 and a concrete reason while the worker is starting', async () => {
    const result = await buildWorkerObservabilityResponse(
      'GET',
      '/health',
      config,
      new MemoryRepository(),
      provider(status({ lifecycle: 'starting', startupComplete: false }))
    );

    expect(result.statusCode).toBe(503);
    expect(JSON.parse(result.body)).toMatchObject({
      ok: false,
      workerReady: false,
      workerReadinessReason: 'lifecycle-starting',
    });
  });

  it('renders standalone lifecycle, finalized, indexed, and lag metrics', async () => {
    const result = await buildWorkerObservabilityResponse(
      'GET',
      '/metrics',
      config,
      new MemoryRepository(),
      provider(status())
    );

    expect(result.statusCode).toBe(200);
    expect(result.contentType).toContain('text/plain');
    expect(result.body).toContain('indexer_worker_lifecycle{lifecycle="running"} 1');
    expect(result.body).toContain('indexer_worker_latest_finalized_block 1000');
    expect(result.body).toContain('indexer_worker_latest_indexed_block 995');
    expect(result.body).toContain('indexer_worker_lag_blocks 5');
  });

  it('rejects unsupported methods and unknown paths without inspecting status', async () => {
    const throwingProvider: ChainIndexerStatusProvider = {
      getStatus: () => {
        throw new Error('must not be called');
      },
    };
    const repository = new MemoryRepository();

    await expect(
      buildWorkerObservabilityResponse('POST', '/health', config, repository, throwingProvider)
    ).resolves.toMatchObject({ statusCode: 405, headers: { allow: 'GET', connection: 'close' } });
    await expect(
      buildWorkerObservabilityResponse('GET', '/unknown', config, repository, throwingProvider)
    ).resolves.toMatchObject({ statusCode: 404 });
  });

  it('bounds concurrent observability work and releases admission after completion', async ({ skip }) => {
    const repository = new MemoryRepository();
    let releaseHealth: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseHealth = resolve;
    });
    repository.healthCheck = vi.fn(async () => {
      if ((repository.healthCheck as ReturnType<typeof vi.fn>).mock.calls.length === 1) await blocked;
      return true;
    });
    const server = createWorkerObservabilityServer(
      { ...config, workerMetricsMaxInFlight: 1 },
      repository,
      provider(status())
    );

    try {
      const port = await new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          if (address && typeof address === 'object') resolve(address.port);
          else reject(new Error('Expected worker observability TCP address'));
        });
      }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') {
          skip('The execution sandbox does not permit loopback listeners; CI runs this assertion.');
          return null;
        }
        throw error;
      });
      if (port === null) return;

      const first = fetch(`http://127.0.0.1:${port}/health`);
      await vi.waitFor(() => expect(repository.healthCheck).toHaveBeenCalledOnce());
      const rejected = await fetch(`http://127.0.0.1:${port}/health`);
      expect(rejected.status).toBe(503);
      expect(rejected.headers.get('retry-after')).toBe('1');
      expect(rejected.headers.get('connection')).toBe('close');

      releaseHealth?.();
      expect((await first).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    } finally {
      releaseHealth?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
