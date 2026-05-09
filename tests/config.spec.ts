import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readConfig } from '../src/config.js';

const CONFIG_ENV_KEYS = [
  'HOST',
  'PORT',
  'GRAPHQL_PATH',
  'DATABASE_URL',
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
      databaseUrl: 'postgres://polkaswap:polkaswap@127.0.0.1:5432/polkaswap_indexer',
      soraWsEndpoint: 'wss://mof2.sora.org',
      chainStartBlock: 0,
      chainBatchSize: 25,
      stateRefreshIntervalBlocks: 250,
      snapshotIntervalBlocks: 250,
    });
  });

  it('parses numeric overrides and falls back on invalid numbers', () => {
    process.env.HOST = '127.0.0.1';
    process.env.PORT = '4444';
    process.env.GRAPHQL_PATH = '/alt-graphql';
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/indexer';
    process.env.SORA_WS_ENDPOINT = 'wss://example.invalid';
    process.env.CHAIN_START_BLOCK = '100';
    process.env.CHAIN_BATCH_SIZE = 'not-a-number';
    process.env.CHAIN_STATE_REFRESH_INTERVAL_BLOCKS = '50';
    process.env.CHAIN_SNAPSHOT_INTERVAL_BLOCKS = '75';

    expect(readConfig()).toEqual({
      host: '127.0.0.1',
      port: 4444,
      graphqlPath: '/alt-graphql',
      databaseUrl: 'postgres://user:pass@localhost:5432/indexer',
      soraWsEndpoint: 'wss://example.invalid',
      chainStartBlock: 100,
      chainBatchSize: 25,
      stateRefreshIntervalBlocks: 50,
      snapshotIntervalBlocks: 75,
    });
  });
});
