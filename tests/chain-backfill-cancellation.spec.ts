import { describe, expect, it, vi } from 'vitest';
import { readConfig } from '../src/config.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { ChainIndexer } from '../src/worker/chain.js';
import type { IndexerDocument } from '../src/repository/types.js';

describe('historical maintenance cancellation boundaries', () => {
  it.each(['cleanupAssetSnapshotPriceOutliers', 'backfillAccountTransactions', 'backfillNetworkAggregateSnapshots', 'repairNetworkTransactionCounters'])('%s stops before reading storage during shutdown', async method => {
    const repository = new MemoryRepository(), worker: any = new ChainIndexer(readConfig(), repository);
    worker.lifecycleState = 'stopping'; const get = vi.spyOn(repository, 'get'), query = vi.spyOn(repository, 'query');
    expect(await worker[method]()).toBe(false); expect(get).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled();
  });
  for (const [method, collection] of [
    ['cleanupAssetSnapshotPriceOutliers', 'assetSnapshots'],
    ['backfillAccountTransactions', 'historyElements'],
    ['backfillNetworkAggregateSnapshots', 'networkSnapshots'],
    ['repairNetworkTransactionCounters', 'networkSnapshots'],
  ] as const) {
    it.each([false, true])(`${method} does not commit a completion receipt after shutdown arrives during a query (rows=%s)`, async withRows => {
      const repository = new MemoryRepository(), worker: any = new ChainIndexer(readConfig(), repository);
      if (withRows) await repository.upsert({ collection, id: 'fixture', timestamp: 10, blockHeight: 1, data: { type: 'DAY', assetId: 'XOR', accountId: 'alice' } });
      const originalQuery = repository.query.bind(repository);
      vi.spyOn(repository, 'query').mockImplementation(async (name, args) => {
        const result = await originalQuery(name, args); if (name === collection) worker.lifecycleState = 'stopping'; return result;
      });
      const upsert = vi.spyOn(repository, 'upsert'), upsertMany = vi.spyOn(repository, 'upsertMany'), remove = vi.spyOn(repository, 'deleteMany');
      expect(await worker[method]()).toBe(false);
      expect(upsert).not.toHaveBeenCalled(); expect(upsertMany).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
      expect(await repository.list('updatesStreams')).toEqual([]);
    });
  }
  it('leaves a cancelled history counter scan empty instead of reporting a partial total', async () => {
    const repository = new MemoryRepository(), worker: any = new ChainIndexer(readConfig(), repository);
    await repository.upsert({ collection: 'historyElements', id: 'tx', timestamp: 10, blockHeight: 1, data: { networkFee: '1' } });
    const original = repository.query.bind(repository);
    vi.spyOn(repository, 'query').mockImplementation(async (name, args) => { const result = await original(name, args); worker.lifecycleState = 'stopping'; return result; });
    expect((await worker.collectNetworkTransactionCountersByBlock()).size).toBe(0);
  });
  it('leaves irrelevant and incomplete snapshots intact and records a completed no-op cleanup', async () => {
    const repository = new MemoryRepository(), worker: any = new ChainIndexer(readConfig(), repository);
    const rows: IndexerDocument[] = [{ collection: 'assetSnapshots', timestamp: 10, blockHeight: 1, id: 'empty', data: {} }, { collection: 'assetSnapshots', timestamp: 10, blockHeight: 1, id: 'no-asset', data: { type: 'DAY' } }, { collection: 'assetSnapshots', timestamp: 10, blockHeight: 1, id: 'block', data: { type: 'BLOCK', assetId: 'XOR' } }];
    await repository.upsertMany(rows); const remove = vi.spyOn(repository, 'deleteMany');
    expect(await worker.cleanupAssetSnapshotPriceOutliers()).toBe(false); expect(await repository.list('assetSnapshots')).toHaveLength(3); expect(remove).not.toHaveBeenCalled();
    const query = vi.spyOn(repository, 'query'); expect(await worker.cleanupAssetSnapshotPriceOutliers()).toBe(false); expect(query).not.toHaveBeenCalled();
  });
});
