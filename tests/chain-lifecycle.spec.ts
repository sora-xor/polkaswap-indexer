import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiPromise } from '@polkadot/api';

import { MemoryRepository } from '../src/repository/memory.js';
import { idempotentShutdown, runShutdownGroup, runShutdownSteps } from '../src/shutdown.js';
import {
  SORA_LEGACY_IDENTITY_ANCHOR,
  SORA_MAINNET_GENESIS_HASH,
} from '../src/soraIdentity.js';
import { ChainIndexer } from '../src/worker/chain.js';
import {
  parsePersistedWorkerStatus,
  WORKER_STATUS_DOCUMENT_ID,
  WORKER_STATUS_HEARTBEAT_INTERVAL_MS,
} from '../src/worker/status.js';

import type { AppConfig } from '../src/config.js';

const config: AppConfig = {
  host: '0.0.0.0',
  port: 4350,
  graphqlPath: '/graphql',
  httpListenBacklog: 4_096,
  httpShutdownTimeoutMs: 30_000,
  httpKeepAliveTimeoutMs: 75_000,
  httpHeadersTimeoutMs: 80_000,
  httpRequestTimeoutMs: 120_000,
  httpMaxConnections: 10_000,
  httpMaxHeaderBytes: 16_384,
  httpMaxRequestsPerSocket: 1_000,
  rateLimitWindowMs: 60_000,
  rateLimitMax: 600,
  rateLimitMaxKeys: 20_000,
  rateLimitGlobalWindowMs: 60_000,
  rateLimitGlobalMax: 50_000,
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
  graphqlWsMaxConnectionsPerClient: 16,
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

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ChainIndexer lifecycle', () => {
  it('exposes a typed never-started status snapshot', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository());

    expect(indexer.getStatus()).toEqual({
      lifecycle: 'idle',
      startupComplete: false,
      latestFinalizedBlock: null,
      latestIndexedBlock: null,
      lag: null,
      lastSuccessfulIndexTimestamp: null,
      lastError: null,
      lastErrorTimestamp: null,
    });
  });

  it('never regresses finalized, indexed, or successful-commit status', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      updateFinalizedStatus: (block: number) => void;
      updateIndexedStatus: (block: number, timestamp: number | null) => void;
      getStatus: () => {
        latestFinalizedBlock: number | null;
        latestIndexedBlock: number | null;
        lag: number | null;
        lastSuccessfulIndexTimestamp: number | null;
      };
    };

    indexer.updateFinalizedStatus(100);
    indexer.updateFinalizedStatus(90);
    indexer.updateFinalizedStatus(Number.NaN);
    indexer.updateIndexedStatus(95, 1_700_000_100);
    indexer.updateIndexedStatus(80, 1_700_000_000);
    indexer.updateIndexedStatus(-1, 1_800_000_000);

    expect(indexer.getStatus()).toMatchObject({
      latestFinalizedBlock: 100,
      latestIndexedBlock: 95,
      lag: 5,
      lastSuccessfulIndexTimestamp: 1_700_000_100,
    });
  });

  it('does not report a zero lag when indexed state is ahead of finality', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      updateFinalizedStatus: (block: number) => void;
      updateIndexedStatus: (block: number, timestamp: number | null) => void;
      getStatus: () => { lag: number | null };
    };

    indexer.updateFinalizedStatus(100);
    indexer.updateIndexedStatus(101, 1_700_000_000);
    expect(indexer.getStatus().lag).toBeNull();
  });

  it('persists a compatible shared heartbeat with a monotonic heartbeat version', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      setLifecycle: (lifecycle: 'running', startupComplete: boolean) => void;
      startWorkerStatusHeartbeat: () => void;
      workerStatusWritePromise: Promise<void> | null;
      repositoryStatusWritesEnabled: boolean;
      stop: () => Promise<void>;
    };

    indexer.repositoryStatusWritesEnabled = true;
    indexer.setLifecycle('running', true);
    indexer.startWorkerStatusHeartbeat();
    await vi.advanceTimersByTimeAsync(WORKER_STATUS_HEARTBEAT_INTERVAL_MS);
    await indexer.workerStatusWritePromise;

    const document = await repository.get('updatesStreams', WORKER_STATUS_DOCUMENT_ID);
    expect(document?.blockHeight).toBe(Math.floor(Date.now() / 1_000));
    expect(parsePersistedWorkerStatus(document)).toMatchObject({
      heartbeatTimestamp: Math.floor(Date.now() / 1_000),
      status: { lifecycle: 'running', startupComplete: true },
    });
    await indexer.stop();
  });

  it('coalesces heartbeat pressure behind a stalled repository write', async () => {
    const repository = new MemoryRepository();
    const originalUpsert = repository.upsert.bind(repository);
    let releaseFirstWrite: (() => void) | undefined;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let calls = 0;
    repository.upsert = vi.fn(async (document) => {
      calls += 1;
      if (calls === 1) await firstWrite;
      await originalUpsert(document);
    });
    const indexer = new ChainIndexer(config, repository) as unknown as {
      persistWorkerStatus: () => Promise<void>;
      pendingWorkerStatusDocument: unknown;
    };

    const first = indexer.persistWorkerStatus();
    const writes = Array.from({ length: 1_000 }, () => indexer.persistWorkerStatus());
    expect(new Set([first, ...writes]).size).toBe(1);
    expect(repository.upsert).toHaveBeenCalledOnce();
    expect(indexer.pendingWorkerStatusDocument).not.toBeNull();

    releaseFirstWrite?.();
    await Promise.all([first, ...writes]);
    expect(repository.upsert).toHaveBeenCalledTimes(2);
    expect(indexer.pendingWorkerStatusDocument).toBeNull();
  });

  it('advances indexed status only after the chain-state batch commits', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      observedGenesisHash: string | null;
      indexFetchedBlock: (block: unknown) => Promise<void>;
      getStatus: () => {
        latestIndexedBlock: number | null;
        lastSuccessfulIndexTimestamp: number | null;
      };
    };
    const blockHash = `0x${'4'.repeat(64)}`;
    indexer.observedGenesisHash = SORA_MAINNET_GENESIS_HASH;
    const before = Math.floor(Date.now() / 1_000);

    await indexer.indexFetchedBlock({
      requestedHash: blockHash,
      signedBlock: {
        block: {
          header: {
            number: { toNumber: () => 42 },
            hash: { toString: () => blockHash },
          },
          extrinsics: [],
        },
      },
      events: [],
      timestamp: 1_700_000_000,
    });

    expect(indexer.getStatus()).toMatchObject({ latestIndexedBlock: 42 });
    expect(indexer.getStatus().lastSuccessfulIndexTimestamp).toBeGreaterThanOrEqual(before);
    expect((await repository.get('updatesStreams', 'chainState'))?.data.block).toBe(42);
  });

  it('coalesces repeated stops and releases a subscription and API exactly once', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      api: unknown;
      pendingFinalizedBlock: number;
      finalizedHeadPollTimer: ReturnType<typeof setInterval> | null;
      subscribeFinalizedHeads: () => Promise<void>;
      updatePendingFinalizedBlockFromRpc: () => Promise<void>;
      drainFinalizedHeads: () => Promise<void>;
      stop: () => Promise<void>;
      getStatus: () => { latestFinalizedBlock: number | null };
    };
    const unsubscribe = vi.fn(async () => undefined);
    const disconnect = vi.fn(async () => undefined);
    const drainFinalizedHeads = vi.fn(async () => undefined);
    let onFinalizedHead:
      | ((header: {
          number: { toNumber: () => number };
          hash: { toString: () => string };
        }) => void)
      | undefined;
    const finalizedBlock = SORA_LEGACY_IDENTITY_ANCHOR.block + 99;
    const finalizedHash = `0x${'9'.repeat(64)}`;

    indexer.api = {
      disconnect,
      rpc: {
        chain: {
          subscribeFinalizedHeads: vi.fn(async (callback: typeof onFinalizedHead) => {
            onFinalizedHead = callback;
            return unsubscribe;
          }),
        },
      },
    };
    indexer.updatePendingFinalizedBlockFromRpc = vi.fn(async () => undefined);
    indexer.drainFinalizedHeads = drainFinalizedHeads;

    await indexer.subscribeFinalizedHeads();
    expect(indexer.finalizedHeadPollTimer).not.toBeNull();

    onFinalizedHead?.({
      number: { toNumber: () => finalizedBlock },
      hash: { toString: () => finalizedHash },
    });
    await Promise.resolve();
    expect(indexer.getStatus()).toMatchObject({ latestFinalizedBlock: finalizedBlock });
    expect(drainFinalizedHeads).toHaveBeenCalledOnce();

    const firstStop = indexer.stop();
    const secondStop = indexer.stop();
    expect(secondStop).toBe(firstStop);
    await Promise.all([firstStop, secondStop, indexer.stop()]);

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(indexer.finalizedHeadPollTimer).toBeNull();
    expect(indexer.pendingFinalizedBlock).toBe(0);

    onFinalizedHead?.({
      number: { toNumber: () => finalizedBlock + 1 },
      hash: { toString: () => `0x${'a'.repeat(64)}` },
    });
    await Promise.resolve();
    expect(drainFinalizedHeads).toHaveBeenCalledOnce();
    expect(indexer.getStatus()).toMatchObject({ latestFinalizedBlock: finalizedBlock });
  });

  it('unsubscribes a subscription that resolves after stop has begun', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      api: unknown;
      subscribeFinalizedHeads: () => Promise<void>;
      stop: () => Promise<void>;
    };
    const unsubscribe = vi.fn(async () => undefined);
    const disconnect = vi.fn(async () => undefined);
    let resolveSubscription: ((unsubscribe: () => Promise<void>) => void) | undefined;
    const subscriptionResult = new Promise<() => Promise<void>>((resolve) => {
      resolveSubscription = resolve;
    });

    indexer.api = {
      disconnect,
      rpc: {
        chain: {
          subscribeFinalizedHeads: vi.fn(() => subscriptionResult),
        },
      },
    };

    const subscribing = indexer.subscribeFinalizedHeads();
    await Promise.resolve();
    const stopping = indexer.stop();
    resolveSubscription?.(unsubscribe);

    await Promise.all([subscribing, stopping]);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('disconnects an API that finishes creating after stop and starts no chain work', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository());
    const disconnect = vi.fn(async () => undefined);
    const getFinalizedHead = vi.fn(async () => '0xfinal');
    let resolveApi: ((api: unknown) => void) | undefined;
    const apiResult = new Promise<unknown>((resolve) => {
      resolveApi = resolve;
    });
    vi.spyOn(ApiPromise, 'create').mockImplementation(() => apiResult as Promise<ApiPromise>);

    const starting = indexer.start();
    await vi.waitFor(() => expect(ApiPromise.create).toHaveBeenCalledOnce());
    const stopping = indexer.stop();
    resolveApi?.({
      disconnect,
      rpc: { chain: { getFinalizedHead } },
    });

    await expect(Promise.all([starting, stopping])).resolves.toEqual([undefined, undefined]);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(getFinalizedHead).not.toHaveBeenCalled();
    await expect(indexer.start()).rejects.toThrow('after shutdown has begun');
  });

  it('cleans up exactly once when startup fails after the API connects', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository());
    const failure = new Error('finalized head unavailable');
    const disconnect = vi.fn(async () => undefined);
    vi.spyOn(ApiPromise, 'create').mockResolvedValue({
      disconnect,
      rpc: {
        chain: {
          getBlockHash: vi.fn(async (block: number) => ({
            toString: () =>
              block === 0
                ? SORA_MAINNET_GENESIS_HASH
                : SORA_LEGACY_IDENTITY_ANCHOR.hash,
          })),
          getFinalizedHead: vi.fn(async () => {
            throw failure;
          }),
        },
      },
      query: {
        timestamp: {
          now: {
            at: vi.fn(async () => ({
              toString: () => String(SORA_LEGACY_IDENTITY_ANCHOR.timestamp * 1_000),
            })),
          },
        },
      },
    } as never);

    await expect(indexer.start()).rejects.toBe(failure);
    await expect(indexer.stop()).resolves.toBeUndefined();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(indexer.getStatus()).toMatchObject({
      lifecycle: 'failed',
      startupComplete: false,
      lastError: 'finalized head unavailable',
    });
  });

  it('clears a scheduled retry and refuses to queue refresh work after stop', async () => {
    vi.useFakeTimers();
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      scheduleFinalizedHeadRetry: () => void;
      drainFinalizedHeads: () => Promise<void>;
      requestDerivedStateRefresh: (
        blockHeight: number,
        timestamp: number,
        includeSnapshots: boolean
      ) => void;
      drainDerivedStateRefreshQueue: () => Promise<void>;
      finalizedHeadRetryTimer: ReturnType<typeof setTimeout> | null;
      stop: () => Promise<void>;
    };
    const drainFinalizedHeads = vi.fn(async () => undefined);
    const drainDerivedStateRefreshQueue = vi.fn(async () => undefined);
    indexer.drainFinalizedHeads = drainFinalizedHeads;
    indexer.drainDerivedStateRefreshQueue = drainDerivedStateRefreshQueue;

    indexer.scheduleFinalizedHeadRetry();
    expect(indexer.finalizedHeadRetryTimer).not.toBeNull();
    await indexer.stop();
    expect(indexer.finalizedHeadRetryTimer).toBeNull();

    indexer.requestDerivedStateRefresh(100, 1_700_000_000, true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(drainFinalizedHeads).not.toHaveBeenCalled();
    expect(drainDerivedStateRefreshQueue).not.toHaveBeenCalled();
  });

  it('cancels outstanding RPC deadlines when stop begins', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      withRpcTimeout: <T>(request: () => Promise<T>, label: string) => Promise<T>;
      rpcTimeoutCancellations: Set<() => void>;
      stop: () => Promise<void>;
    };
    let resolveUnderlying: ((value: string) => void) | undefined;
    const underlying = new Promise<string>((resolve) => {
      resolveUnderlying = resolve;
    });

    const request = indexer.withRpcTimeout(() => underlying, 'test.hungRpc()');
    const cancelled = request.catch((error: unknown) => error);
    expect(indexer.rpcTimeoutCancellations.size).toBe(1);
    const stopping = indexer.stop();

    await expect(cancelled).resolves.toMatchObject({ message: 'test.hungRpc() cancelled during shutdown' });
    resolveUnderlying?.('late');
    await stopping;
    expect(indexer.rpcTimeoutCancellations.size).toBe(0);
  });

  it('keeps timed-out requests in the RPC budget until their underlying work settles', async () => {
    vi.useFakeTimers();
    const budgetConfig = { ...config, chainRpcMaxInFlight: 2 };
    const indexer = new ChainIndexer(budgetConfig, new MemoryRepository()) as unknown as {
      withRpcTimeout: <T>(request: () => Promise<T>, label: string, timeoutMs?: number) => Promise<T>;
      outstandingRpcRequests: Set<Promise<unknown>>;
      stop: () => Promise<void>;
    };
    const resolvers: Array<(value: string) => void> = [];
    const createRequest = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        })
    );

    const first = indexer.withRpcTimeout(createRequest, 'test.first()', 5).catch((error: unknown) => error);
    const second = indexer.withRpcTimeout(createRequest, 'test.second()', 5).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5);
    await expect(first).resolves.toMatchObject({ message: 'test.first() timed out after 5ms' });
    await expect(second).resolves.toMatchObject({ message: 'test.second() timed out after 5ms' });
    expect(indexer.outstandingRpcRequests.size).toBe(2);

    const rejectedFactory = vi.fn(async () => 'never');
    await expect(indexer.withRpcTimeout(rejectedFactory, 'test.rejected()', 5)).rejects.toThrow(
      '2 request RPC budget is exhausted'
    );
    expect(rejectedFactory).not.toHaveBeenCalled();

    for (const resolve of resolvers) resolve('late');
    await vi.runAllTicks();
    expect(indexer.outstandingRpcRequests.size).toBe(0);
    await indexer.stop();
  });

  it('disposes a resource that resolves after its RPC deadline', async () => {
    vi.useFakeTimers();
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      withRpcTimeout: <T>(
        request: () => Promise<T>,
        label: string,
        timeoutMs: number,
        disposeLateValue: (value: T) => void | Promise<void>
      ) => Promise<T>;
      stop: () => Promise<void>;
    };
    let resolveUnderlying: ((value: { id: string }) => void) | undefined;
    const underlying = new Promise<{ id: string }>((resolve) => {
      resolveUnderlying = resolve;
    });
    const disposeLateValue = vi.fn(async () => undefined);
    const request = indexer
      .withRpcTimeout(() => underlying, 'test.resource()', 5, disposeLateValue)
      .catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(5);
    await expect(request).resolves.toMatchObject({ message: 'test.resource() timed out after 5ms' });
    const resource = { id: 'late' };
    resolveUnderlying?.(resource);
    await vi.waitFor(() => expect(disposeLateValue).toHaveBeenCalledWith(resource));
    await indexer.stop();
  });

  it('consumes failures from late RPC resource disposal', async () => {
    vi.useFakeTimers();
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      withRpcTimeout: <T>(
        request: () => Promise<T>,
        label: string,
        timeoutMs: number,
        disposeLateValue: (value: T) => void | Promise<void>
      ) => Promise<T>;
      stop: () => Promise<void>;
    };
    let resolveUnderlying: ((value: string) => void) | undefined;
    const underlying = new Promise<string>((resolve) => {
      resolveUnderlying = resolve;
    });
    const failure = new Error('dispose failed');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const request = indexer
      .withRpcTimeout(
        () => underlying,
        'test.disposalFailure()',
        5,
        async () => {
          throw failure;
        }
      )
      .catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(5);
    await request;
    resolveUnderlying?.('late');
    await vi.waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        'Failed to dispose the late result from test.disposalFailure()',
        failure
      )
    );
    await indexer.stop();
  });

  it('does not requeue a refresh that fails because shutdown disconnected its API', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      api: unknown;
      requestDerivedStateRefresh: (
        blockHeight: number,
        timestamp: number,
        includeSnapshots: boolean
      ) => void;
      refreshDerivedState: () => Promise<void>;
      pendingDerivedStateRefresh: unknown;
      derivedStateRefreshRetryTimer: ReturnType<typeof setTimeout> | null;
      stop: () => Promise<void>;
    };
    let rejectRefresh: ((error: Error) => void) | undefined;
    const refresh = new Promise<void>((_resolve, reject) => {
      rejectRefresh = reject;
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    indexer.api = { disconnect: vi.fn(async () => undefined) };
    indexer.refreshDerivedState = vi.fn(() => refresh);

    indexer.requestDerivedStateRefresh(100, 1_700_000_000, true);
    await vi.waitFor(() => expect(indexer.refreshDerivedState).toHaveBeenCalledOnce());
    const stopping = indexer.stop();
    rejectRefresh?.(new Error('connection closed'));
    await stopping;

    expect(indexer.pendingDerivedStateRefresh).toBeNull();
    expect(indexer.derivedStateRefreshRetryTimer).toBeNull();
    expect(consoleError).not.toHaveBeenCalledWith(
      expect.stringContaining('Failed to refresh derived state'),
      expect.anything()
    );
  });

  it('returns after the configured bound when in-flight work cannot settle', async () => {
    vi.useFakeTimers();
    const shortConfig = { ...config, chainShutdownTimeoutMs: 25 };
    const indexer = new ChainIndexer(shortConfig, new MemoryRepository()) as unknown as {
      backgroundTasks: Set<Promise<void>>;
      stop: () => Promise<void>;
    };
    indexer.backgroundTasks.add(new Promise<void>(() => undefined));
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    let stopped = false;
    const stopping = indexer.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(24);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;

    expect(consoleWarn).toHaveBeenCalledWith(
      'Chain indexer shutdown timed out after 25ms with unfinished work'
    );
  });

  it('does not let a hung terminal heartbeat defeat bounded shutdown', async () => {
    vi.useFakeTimers();
    const repository = new MemoryRepository();
    repository.upsert = vi.fn(() => new Promise<void>(() => undefined));
    const shortConfig = { ...config, chainShutdownTimeoutMs: 25 };
    const indexer = new ChainIndexer(shortConfig, repository) as unknown as {
      repositoryStatusWritesEnabled: boolean;
      stop: () => Promise<void>;
      getStatus: () => { lifecycle: string };
    };
    indexer.repositoryStatusWritesEnabled = true;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    let stopped = false;
    const stopping = indexer.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(24);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;

    expect(stopped).toBe(true);
    expect(repository.upsert).toHaveBeenCalledOnce();
    expect(indexer.getStatus().lifecycle).toBe('stopped');
  });
});

describe('shutdown orchestration', () => {
  it('starts independent cleanup work together and preserves failure order', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const second = vi.fn(async () => {
      releaseFirst();
      throw new Error('second cleanup failed');
    });

    await expect(
      runShutdownGroup([
        async () => firstGate,
        second,
      ])
    ).rejects.toThrow('second cleanup failed');
    expect(second).toHaveBeenCalledOnce();
  });

  it('closes the repository after the indexer even when indexer stop fails', async () => {
    const order: string[] = [];
    const failure = new Error('worker stop failed');

    await expect(
      runShutdownSteps([
        async () => {
          order.push('indexer');
          throw failure;
        },
        async () => {
          order.push('repository');
        },
      ])
    ).rejects.toBe(failure);
    expect(order).toEqual(['indexer', 'repository']);
  });

  it('coalesces concurrent callers onto one ordered shutdown', async () => {
    const operation = vi.fn(async () => undefined);
    const stop = idempotentShutdown(operation);

    const first = stop();
    const second = stop();
    expect(second).toBe(first);
    await Promise.all([first, second, stop()]);
    expect(operation).toHaveBeenCalledOnce();
  });

  it('preserves falsy failures while still running later cleanup steps', async () => {
    const finalStep = vi.fn(async () => undefined);

    await expect(
      runShutdownSteps([
        async () => {
          throw null;
        },
        finalStep,
      ])
    ).rejects.toBeNull();
    expect(finalStep).toHaveBeenCalledOnce();
  });
});
