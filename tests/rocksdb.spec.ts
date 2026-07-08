import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RocksRepository } from '../src/repository/rocksdb.js';
import { metrics } from '../src/metrics.js';

import type { AppConfig } from '../src/config.js';
import type { IndexerDocument } from '../src/repository/types.js';

const createConfig = (rocksdbPath: string): AppConfig => ({
  host: '127.0.0.1',
  port: 4350,
  graphqlPath: '/graphql',
  storageEngine: 'rocksdb',
  databaseUrl: 'postgres://polkaswap:polkaswap@127.0.0.1:5432/polkaswap_indexer',
  rocksdbPath,
  rocksdbBlockCacheMb: 32,
  rocksdbWriteBufferManagerMb: 16,
  rocksdbParallelism: 1,
  rocksdbEnableStats: false,
  soraWsEndpoint: 'wss://mof2.sora.org',
  chainStartBlock: 0,
  chainBatchSize: 25,
  stateRefreshIntervalBlocks: 25,
  snapshotIntervalBlocks: 25,
});

const assetSnapshot = (id: string, assetId: string, timestamp: number, type = 'DAY'): IndexerDocument => ({
  collection: 'assetSnapshots',
  id,
  blockHeight: timestamp,
  timestamp,
  data: { id, assetId, timestamp, type },
});

describe('RocksRepository', () => {
  let tempDir: string;
  let repository: RocksRepository;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'polkaswap-rocksdb-'));
    repository = new RocksRepository(createConfig(join(tempDir, 'indexer.rocksdb')));
  });

  afterEach(async () => {
    await repository.close().catch(() => undefined);
    await rm(tempDir, { recursive: true, force: true });
  });

  it('stores and retrieves documents by collection/id', async () => {
    const xor = assetSnapshot('snapshot-xor', 'xor', 10);
    const val = assetSnapshot('snapshot-val', 'val', 20);

    await repository.upsertMany([xor, val]);

    await expect(repository.get('assetSnapshots', 'snapshot-xor')).resolves.toEqual(xor);
    await expect(repository.getMany('assetSnapshots', ['snapshot-val', 'missing'])).resolves.toEqual(
      new Map([['snapshot-val', val]])
    );
    await expect(repository.list('assetSnapshots')).resolves.toEqual([val, xor].sort((left, right) => left.id.localeCompare(right.id)));
  });

  it('uses timestamp indexes for filtered pagination and seek queries', async () => {
    await repository.upsertMany([
      assetSnapshot('xor-10', 'xor', 10),
      assetSnapshot('xor-20', 'xor', 20),
      assetSnapshot('xor-30', 'xor', 30),
      assetSnapshot('val-40', 'val', 40),
    ]);

    const firstPage = await repository.query('assetSnapshots', {
      first: 2,
      filter: { assetId: { equalTo: 'xor' }, type: { equalTo: 'DAY' } },
      orderBy: ['TIMESTAMP_ASC'],
      includeTotalCount: false,
    });

    expect(firstPage.items.map((document) => document.id)).toEqual(['xor-10', 'xor-20']);
    expect(firstPage.totalCount).toBeNull();
    expect(firstPage.hasNextPage).toBe(true);

    const secondPage = await repository.query('assetSnapshots', {
      first: 2,
      filter: { assetId: { equalTo: 'xor' }, type: { equalTo: 'DAY' } },
      orderBy: ['TIMESTAMP_ASC'],
      includeTotalCount: false,
      seek: { field: 'timestamp', value: 20, id: 'xor-20', direction: 'asc' },
    });

    expect(secondPage.items.map((document) => document.id)).toEqual(['xor-30']);
    expect(secondPage.hasNextPage).toBe(false);
  });

  it('uses the market snapshot block-height index for final pre-close lookups', async () => {
    await repository.upsertMany([
      {
        collection: 'marketSnapshots',
        id: 'market-7-default-80',
        blockHeight: 80,
        timestamp: 80,
        data: { id: 'market-7-default-80', marketId: 7, type: 'DEFAULT', blockHeight: 80, timestamp: 80 },
      },
      {
        collection: 'marketSnapshots',
        id: 'market-7-day-90',
        blockHeight: 90,
        timestamp: 90,
        data: { id: 'market-7-day-90', marketId: 7, type: 'DAY', blockHeight: 90, timestamp: 90 },
      },
      {
        collection: 'marketSnapshots',
        id: 'market-8-default-95',
        blockHeight: 95,
        timestamp: 95,
        data: { id: 'market-8-default-95', marketId: 8, type: 'DEFAULT', blockHeight: 95, timestamp: 95 },
      },
    ]);

    metrics.reset();
    const result = await repository.query('marketSnapshots', {
      first: 1,
      orderBy: ['BLOCK_HEIGHT_DESC'],
      filter: {
        marketId: { equalTo: 7 },
        type: { equalTo: 'DEFAULT' },
        blockHeight: { lessThanOrEqualTo: 100 },
      },
      includeTotalCount: false,
    });

    expect(result.items.map((document) => document.id)).toEqual(['market-7-default-80']);
    expect(metrics.render()).toContain('source="marketSnapshotBh"');
  });

  it('removes stale secondary index entries on update and delete', async () => {
    await repository.upsert(assetSnapshot('snapshot-a', 'xor', 10));
    await repository.upsert(assetSnapshot('snapshot-a', 'val', 20));

    const oldAsset = await repository.query('assetSnapshots', {
      filter: { assetId: { equalTo: 'xor' } },
      orderBy: ['ID_ASC'],
      includeTotalCount: true,
    });
    const newAsset = await repository.query('assetSnapshots', {
      filter: { assetId: { equalTo: 'val' } },
      orderBy: ['ID_ASC'],
      includeTotalCount: true,
    });

    expect(oldAsset.items).toEqual([]);
    expect(oldAsset.totalCount).toBe(0);
    expect(newAsset.items.map((document) => document.id)).toEqual(['snapshot-a']);
    expect(newAsset.totalCount).toBe(1);

    await repository.deleteMany('assetSnapshots', ['snapshot-a']);

    const deleted = await repository.query('assetSnapshots', {
      filter: { assetId: { equalTo: 'val' } },
      orderBy: ['ID_ASC'],
      includeTotalCount: true,
    });

    expect(deleted.items).toEqual([]);
    expect(deleted.totalCount).toBe(0);
  });

  it('falls back to filtered scans for OR filters while preserving compatibility', async () => {
    await repository.upsertMany([
      {
        collection: 'historyElements',
        id: 'history-1',
        timestamp: 10,
        data: { id: 'history-1', timestamp: 10, address: 'alice', method: 'transfer' },
      },
      {
        collection: 'historyElements',
        id: 'history-2',
        timestamp: 30,
        data: { id: 'history-2', timestamp: 30, dataTo: 'alice', method: 'swap' },
      },
      {
        collection: 'historyElements',
        id: 'history-3',
        timestamp: 20,
        data: { id: 'history-3', timestamp: 20, dataFrom: 'bob', method: 'transfer' },
      },
    ]);

    const result = await repository.query('historyElements', {
      filter: {
        or: [{ address: { equalTo: 'alice' } }, { dataTo: { equalTo: 'alice' } }],
      },
      orderBy: ['TIMESTAMP_DESC'],
      includeTotalCount: true,
    });

    expect(result.items.map((document) => document.id)).toEqual(['history-2', 'history-1']);
    expect(result.totalCount).toBe(2);
  });

  it('orders numeric fields through numeric secondary indexes', async () => {
    await repository.upsertMany([
      {
        collection: 'poolXYKs',
        id: 'pool-low',
        data: { id: 'pool-low', liquidityUSD: '2' },
      },
      {
        collection: 'poolXYKs',
        id: 'pool-high',
        data: { id: 'pool-high', liquidityUSD: '10' },
      },
      {
        collection: 'poolXYKs',
        id: 'pool-missing',
        data: { id: 'pool-missing' },
      },
    ]);

    const result = await repository.query('poolXYKs', {
      first: 3,
      orderBy: ['LIQUIDITY_USD_DESC'],
      includeTotalCount: true,
    });

    expect(result.items.map((document) => document.id)).toEqual(['pool-high', 'pool-low', 'pool-missing']);
    expect(result.totalCount).toBe(3);
  });

  it('publishes in-process watch updates', async () => {
    const watcher = repository.watch('assetSnapshots', ['watched']);
    const next = watcher.next();

    await repository.upsert(assetSnapshot('ignored', 'xor', 1));
    await repository.upsert(assetSnapshot('watched', 'xor', 2));

    await expect(next).resolves.toMatchObject({
      value: expect.objectContaining({ id: 'watched' }),
      done: false,
    });

    await watcher.return(undefined);
  });
});
