export type AppConfig = {
  host: string;
  port: number;
  graphqlPath: string;
  storageEngine: 'postgres' | 'rocksdb';
  databaseUrl: string;
  rocksdbPath: string;
  rocksdbBlockCacheMb: number;
  rocksdbWriteBufferManagerMb: number;
  rocksdbParallelism: number;
  rocksdbEnableStats: boolean;
  soraWsEndpoint: string;
  chainStartBlock: number;
  chainBatchSize: number;
  stateRefreshIntervalBlocks: number;
  snapshotIntervalBlocks: number;
};

const DEFAULT_CHAIN_STATE_REFRESH_INTERVAL_BLOCKS = 25;
const DEFAULT_CHAIN_SNAPSHOT_INTERVAL_BLOCKS = 25;

const readStorageEngine = (): AppConfig['storageEngine'] => {
  const value = String(process.env.STORAGE_ENGINE ?? 'postgres').toLowerCase();

  return value === 'rocksdb' ? 'rocksdb' : 'postgres';
};

const readNumber = (name: string, fallback: number): number => {
  const value = process.env[name];
  if (!value) return fallback;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const readBoolean = (name: string, fallback = false): boolean => {
  const value = process.env[name];
  if (value === undefined) return fallback;

  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};

/**
 * Reads runtime configuration from environment variables.
 *
 * The UI is static and only needs the public GraphQL URL. This service keeps
 * all node/database credentials server-side.
 */
export function readConfig(): AppConfig {
  return {
    host: process.env.HOST ?? '0.0.0.0',
    port: readNumber('PORT', 4350),
    graphqlPath: process.env.GRAPHQL_PATH ?? '/graphql',
    storageEngine: readStorageEngine(),
    databaseUrl:
      process.env.DATABASE_URL ?? 'postgres://polkaswap:polkaswap@127.0.0.1:5432/polkaswap_indexer',
    rocksdbPath: process.env.ROCKSDB_PATH ?? './data/polkaswap-indexer.rocksdb',
    rocksdbBlockCacheMb: readNumber('ROCKSDB_BLOCK_CACHE_MB', 512),
    rocksdbWriteBufferManagerMb: readNumber('ROCKSDB_WRITE_BUFFER_MANAGER_MB', 256),
    rocksdbParallelism: readNumber('ROCKSDB_PARALLELISM', 4),
    rocksdbEnableStats: readBoolean('ROCKSDB_ENABLE_STATS'),
    soraWsEndpoint: process.env.SORA_WS_ENDPOINT ?? 'wss://mof2.sora.org',
    chainStartBlock: readNumber('CHAIN_START_BLOCK', 0),
    chainBatchSize: readNumber('CHAIN_BATCH_SIZE', 25),
    stateRefreshIntervalBlocks: readNumber(
      'CHAIN_STATE_REFRESH_INTERVAL_BLOCKS',
      DEFAULT_CHAIN_STATE_REFRESH_INTERVAL_BLOCKS
    ),
    snapshotIntervalBlocks: readNumber('CHAIN_SNAPSHOT_INTERVAL_BLOCKS', DEFAULT_CHAIN_SNAPSHOT_INTERVAL_BLOCKS),
  };
}
