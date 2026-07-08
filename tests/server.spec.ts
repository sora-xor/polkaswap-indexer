import { createServer } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import { MemoryRepository } from '../src/repository/memory.js';

import type { AppConfig } from '../src/config.js';

vi.mock('../src/db/migrate.js', () => ({
  migrate: vi.fn().mockResolvedValue(undefined),
}));

const { startServer } = await import('../src/server.js');

const baseConfig = (port: number): AppConfig => ({
  host: '127.0.0.1',
  port,
  graphqlPath: '/graphql',
  storageEngine: 'postgres',
  databaseUrl: 'postgres://polkaswap:polkaswap@localhost:5432/polkaswap_indexer',
  rocksdbPath: './data/polkaswap-indexer.rocksdb',
  rocksdbBlockCacheMb: 512,
  rocksdbWriteBufferManagerMb: 256,
  rocksdbParallelism: 4,
  rocksdbEnableStats: false,
  soraWsEndpoint: 'wss://mof2.sora.org',
  chainStartBlock: 0,
  chainBatchSize: 25,
  stateRefreshIntervalBlocks: 250,
  snapshotIntervalBlocks: 250,
});

const listenOnEphemeralPort = async (): Promise<{ port: number; close: () => Promise<void> }> => {
  const server = createServer((_request, response) => {
    response.end('busy');
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('Expected TCP listener address'));
    });
  });

  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
};

describe('startServer', () => {
  it('rejects cleanly and closes the repository when the listen port is already in use', async () => {
    const blocker = await listenOnEphemeralPort();
    const repository = new MemoryRepository();
    const close = vi.spyOn(repository, 'close');

    try {
      await expect(startServer(baseConfig(blocker.port), repository)).rejects.toHaveProperty('code', 'EADDRINUSE');
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await blocker.close();
    }
  });
});
