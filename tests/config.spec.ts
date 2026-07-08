import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readConfig } from '../src/config.js';

const CONFIG_ENV_KEYS = [
  'HOST',
  'PORT',
  'GRAPHQL_PATH',
  'STORAGE_ENGINE',
  'DATABASE_URL',
  'ROCKSDB_PATH',
  'ROCKSDB_BLOCK_CACHE_MB',
  'ROCKSDB_WRITE_BUFFER_MANAGER_MB',
  'ROCKSDB_PARALLELISM',
  'ROCKSDB_ENABLE_STATS',
  'SORA_WS_ENDPOINT',
  'CHAIN_START_BLOCK',
  'CHAIN_BATCH_SIZE',
  'CHAIN_STATE_REFRESH_INTERVAL_BLOCKS',
  'CHAIN_SNAPSHOT_INTERVAL_BLOCKS',
];

const originalEnv = new Map(CONFIG_ENV_KEYS.map((key) => [key, process.env[key]]));

const restoreEnv = () => {
  for (const key of CONFIG_ENV_KEYS) {
    const value = originalEnv.get(key);

    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
};

describe('runtime configuration', () => {
  beforeEach(() => {
    for (const key of CONFIG_ENV_KEYS) {
      delete process.env[key];
    }
  });

  afterEach(restoreEnv);

  it('uses documented defaults when environment variables are absent', () => {
    expect(readConfig()).toEqual({
      host: '0.0.0.0',
      port: 4350,
      graphqlPath: '/graphql',
      storageEngine: 'postgres',
      databaseUrl: 'postgres://polkaswap:polkaswap@127.0.0.1:5432/polkaswap_indexer',
      rocksdbPath: './data/polkaswap-indexer.rocksdb',
      rocksdbBlockCacheMb: 512,
      rocksdbWriteBufferManagerMb: 256,
      rocksdbParallelism: 4,
      rocksdbEnableStats: false,
      soraWsEndpoint: 'wss://mof2.sora.org',
      chainStartBlock: 0,
      chainBatchSize: 25,
      stateRefreshIntervalBlocks: 25,
      snapshotIntervalBlocks: 25,
    });
  });

  it('parses numeric overrides and falls back on invalid numbers', () => {
    process.env.HOST = '127.0.0.1';
    process.env.PORT = '4444';
    process.env.GRAPHQL_PATH = '/alt-graphql';
    process.env.STORAGE_ENGINE = 'rocksdb';
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/indexer';
    process.env.ROCKSDB_PATH = '/tmp/polkaswap.rocksdb';
    process.env.ROCKSDB_BLOCK_CACHE_MB = '1024';
    process.env.ROCKSDB_WRITE_BUFFER_MANAGER_MB = '512';
    process.env.ROCKSDB_PARALLELISM = '8';
    process.env.ROCKSDB_ENABLE_STATS = 'true';
    process.env.SORA_WS_ENDPOINT = 'wss://example.invalid';
    process.env.CHAIN_START_BLOCK = '100';
    process.env.CHAIN_BATCH_SIZE = 'not-a-number';
    process.env.CHAIN_STATE_REFRESH_INTERVAL_BLOCKS = '50';
    process.env.CHAIN_SNAPSHOT_INTERVAL_BLOCKS = '75';

    expect(readConfig()).toEqual({
      host: '127.0.0.1',
      port: 4444,
      graphqlPath: '/alt-graphql',
      storageEngine: 'rocksdb',
      databaseUrl: 'postgres://user:pass@localhost:5432/indexer',
      rocksdbPath: '/tmp/polkaswap.rocksdb',
      rocksdbBlockCacheMb: 1024,
      rocksdbWriteBufferManagerMb: 512,
      rocksdbParallelism: 8,
      rocksdbEnableStats: true,
      soraWsEndpoint: 'wss://example.invalid',
      chainStartBlock: 100,
      chainBatchSize: 25,
      stateRefreshIntervalBlocks: 50,
      snapshotIntervalBlocks: 75,
    });
  });
});
