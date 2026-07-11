import { describe, expect, it, vi } from 'vitest';

const config = {
  host: '0.0.0.0',
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
  storageEngine: 'postgres' as const,
  databaseUrl: '',
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
  chainStartBlock: 1,
  chainBatchSize: 25,
  stateRefreshIntervalBlocks: 250,
  snapshotIntervalBlocks: 250,
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

const loadWorkerModules = async () => {
  const [{ ChainIndexer }, { MemoryRepository }] = await Promise.all([
    import('../src/worker/chain.js'),
    import('../src/repository/memory.js'),
  ]);

  return { ChainIndexer, MemoryRepository };
};

describe('chain worker runtime configuration', () => {
  it('fails closed when persisted progress is ahead of endpoint finality', async () => {
    const { ChainIndexer, MemoryRepository } = await loadWorkerModules();
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      api: unknown;
      getIndexableFinalizedBlock: () => Promise<number>;
      getLastIndexedBlock: () => Promise<number>;
      indexBlockByNumber: (block: number) => Promise<void>;
      backfill: () => Promise<boolean>;
    };
    indexer.api = {};
    indexer.getIndexableFinalizedBlock = vi.fn(async () => 99);
    indexer.getLastIndexedBlock = vi.fn(async () => 100);
    indexer.indexBlockByNumber = vi.fn(async () => undefined);

    await expect(indexer.backfill()).rejects.toThrow(
      'Stored chain state 100 is ahead of the configured SORA endpoint finalized block 99'
    );
    expect(indexer.indexBlockByNumber).not.toHaveBeenCalled();
  });

  it('uses the documented sequential config default for backfill prefetching', async () => {
    const { ChainIndexer, MemoryRepository } = await loadWorkerModules();
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      api: unknown;
      getIndexableFinalizedBlock: () => Promise<number>;
      getLastIndexedBlock: () => Promise<number>;
      initializeNetworkBackfillWindows: (lastIndexed: number) => Promise<unknown[]>;
      initializeHistoricalValuationState: (startBlock: number) => Promise<unknown>;
      indexBlockByNumber: (
        block: number,
        options?: {
          refreshDerivedState?: boolean;
          networkAggregateWindows?: unknown[];
          flushNetworkAggregates?: boolean;
        }
      ) => Promise<void>;
      backfill: () => Promise<boolean>;
    };

    indexer.api = {};
    indexer.getIndexableFinalizedBlock = vi.fn(async () => 2);
    indexer.getLastIndexedBlock = vi.fn(async () => 0);
    const networkAggregateWindows: unknown[] = [];
    const historicalValuationState = { blockHeight: 0 };
    indexer.initializeNetworkBackfillWindows = vi.fn(async () => networkAggregateWindows);
    indexer.initializeHistoricalValuationState = vi.fn(async () => historicalValuationState);
    indexer.indexBlockByNumber = vi.fn(async () => undefined);

    await expect(indexer.backfill()).resolves.toBe(true);

    expect(indexer.initializeNetworkBackfillWindows).toHaveBeenCalledWith(0);
    expect(indexer.indexBlockByNumber).toHaveBeenNthCalledWith(1, 1, {
      refreshDerivedState: false,
      networkAggregateWindows,
      flushNetworkAggregates: false,
      backfillRetentionTimestamp: expect.any(Number),
      historicalValuationState,
      retireExpiredNetworkBlocks: false,
    });
    expect(indexer.indexBlockByNumber).toHaveBeenNthCalledWith(2, 2, {
      refreshDerivedState: false,
      networkAggregateWindows,
      flushNetworkAggregates: true,
      backfillRetentionTimestamp: expect.any(Number),
      historicalValuationState,
      retireExpiredNetworkBlocks: true,
    });
  }, 15_000);

  it('uses each indexer instance\'s configured prefetch concurrency', async () => {
    const { ChainIndexer, MemoryRepository } = await loadWorkerModules();
    const indexer = new ChainIndexer(
      { ...config, backfillPrefetchConcurrency: 2 },
      new MemoryRepository()
    ) as unknown as {
      api: unknown;
      getIndexableFinalizedBlock: () => Promise<number>;
      getLastIndexedBlock: () => Promise<number>;
      fetchBlockByNumber: (block: number) => Promise<unknown>;
      initializeNetworkBackfillWindows: (lastIndexed: number) => Promise<unknown[]>;
      initializeHistoricalValuationState: (startBlock: number) => Promise<unknown>;
      indexFetchedBlock: (
        block: unknown,
        options?: {
          refreshDerivedState?: boolean;
          networkAggregateWindows?: unknown[];
          flushNetworkAggregates?: boolean;
        }
      ) => Promise<void>;
      backfill: () => Promise<boolean>;
    };

    indexer.api = {};
    indexer.getIndexableFinalizedBlock = vi.fn(async () => 3);
    indexer.getLastIndexedBlock = vi.fn(async () => 0);
    const networkAggregateWindows: unknown[] = [];
    const historicalValuationState = { blockHeight: 0 };
    indexer.initializeNetworkBackfillWindows = vi.fn(async () => networkAggregateWindows);
    indexer.initializeHistoricalValuationState = vi.fn(async () => historicalValuationState);
    indexer.fetchBlockByNumber = vi.fn(async (block: number) => ({
      signedBlock: { block: { header: { number: { toNumber: () => block } } } },
    }));
    indexer.indexFetchedBlock = vi.fn(async () => undefined);

    await expect(indexer.backfill()).resolves.toBe(true);

    expect(indexer.fetchBlockByNumber).toHaveBeenCalledTimes(3);
    expect(indexer.fetchBlockByNumber).toHaveBeenNthCalledWith(1, 1);
    expect(indexer.fetchBlockByNumber).toHaveBeenNthCalledWith(2, 2);
    expect(indexer.fetchBlockByNumber).toHaveBeenNthCalledWith(3, 3);
    expect(indexer.indexFetchedBlock).toHaveBeenCalledTimes(3);
    expect(indexer.indexFetchedBlock).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      expect.objectContaining({
        networkAggregateWindows,
        historicalValuationState,
        flushNetworkAggregates: true,
      })
    );
  });
});
