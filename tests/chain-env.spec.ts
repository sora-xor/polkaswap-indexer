import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const WORKER_ENV_KEYS = [
  'CHAIN_BACKFILL_PREFETCH_CONCURRENCY',
  'CHAIN_FINALIZED_CATCHUP_PREFETCH_CONCURRENCY',
] as const;

const originalEnv = new Map(WORKER_ENV_KEYS.map((key) => [key, process.env[key]]));

const config = {
  host: '0.0.0.0',
  port: 4350,
  graphqlPath: '/graphql',
  storageEngine: 'postgres' as const,
  databaseUrl: '',
  rocksdbPath: './data/polkaswap-indexer.rocksdb',
  rocksdbBlockCacheMb: 512,
  rocksdbWriteBufferManagerMb: 256,
  rocksdbParallelism: 4,
  rocksdbEnableStats: false,
  soraWsEndpoint: 'wss://mof2.sora.org',
  chainStartBlock: 1,
  chainBatchSize: 25,
  stateRefreshIntervalBlocks: 250,
  snapshotIntervalBlocks: 250,
};

const clearWorkerEnv = () => {
  for (const key of WORKER_ENV_KEYS) {
    delete process.env[key];
  }
};

const restoreWorkerEnv = () => {
  for (const key of WORKER_ENV_KEYS) {
    const value = originalEnv.get(key);

    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
};

const loadWorkerModules = async () => {
  vi.resetModules();
  const [{ ChainIndexer }, { MemoryRepository }] = await Promise.all([
    import('../src/worker/chain.js'),
    import('../src/repository/memory.js'),
  ]);

  return { ChainIndexer, MemoryRepository };
};

describe('chain worker environment parsing', () => {
  beforeEach(clearWorkerEnv);

  afterEach(() => {
    restoreWorkerEnv();
    vi.resetModules();
  });

  it('falls back when backfill prefetch concurrency is non-numeric', async () => {
    process.env.CHAIN_BACKFILL_PREFETCH_CONCURRENCY = 'not-a-number';
    const { ChainIndexer, MemoryRepository } = await loadWorkerModules();
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      api: unknown;
      getIndexableFinalizedBlock: () => Promise<number>;
      getLastIndexedBlock: () => Promise<number>;
      indexBlockByNumber: (block: number, options?: { refreshDerivedState?: boolean }) => Promise<void>;
      backfillNetworkAggregateSnapshots: () => Promise<boolean>;
      backfill: () => Promise<boolean>;
    };

    indexer.api = {};
    indexer.getIndexableFinalizedBlock = vi.fn(async () => 2);
    indexer.getLastIndexedBlock = vi.fn(async () => 0);
    indexer.indexBlockByNumber = vi.fn(async () => undefined);
    indexer.backfillNetworkAggregateSnapshots = vi.fn(async () => false);

    await expect(indexer.backfill()).resolves.toBe(true);

    expect(indexer.indexBlockByNumber).toHaveBeenNthCalledWith(1, 1, { refreshDerivedState: false });
    expect(indexer.indexBlockByNumber).toHaveBeenNthCalledWith(2, 2, { refreshDerivedState: false });
    expect(indexer.backfillNetworkAggregateSnapshots).toHaveBeenCalledTimes(1);
  });

  it('falls back when finalized catch-up prefetch concurrency is non-numeric', async () => {
    process.env.CHAIN_BACKFILL_PREFETCH_CONCURRENCY = '1';
    process.env.CHAIN_FINALIZED_CATCHUP_PREFETCH_CONCURRENCY = 'not-a-number';
    const { ChainIndexer, MemoryRepository } = await loadWorkerModules();
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      api: unknown;
      pendingFinalizedBlock: number;
      getLastIndexedBlock: () => Promise<number>;
      indexBlockByNumber: (block: number) => Promise<void>;
      drainFinalizedHeads: () => Promise<void>;
    };

    indexer.api = {};
    indexer.pendingFinalizedBlock = 2;
    indexer.getLastIndexedBlock = vi.fn(async () => 0);
    indexer.indexBlockByNumber = vi.fn(async () => undefined);

    await expect(indexer.drainFinalizedHeads()).resolves.toBeUndefined();

    expect(indexer.indexBlockByNumber).toHaveBeenNthCalledWith(1, 1);
    expect(indexer.indexBlockByNumber).toHaveBeenNthCalledWith(2, 2);
  });
});
