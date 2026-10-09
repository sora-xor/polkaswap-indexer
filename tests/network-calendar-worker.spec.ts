import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/config.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { ChainIndexer } from '../src/worker/chain.js';
import type { IndexerDocument } from '../src/repository/types.js';

type Block = {
  id: string; blockHeight: number; timestamp: number; accounts: number; transactions: number;
  fees: bigint; volumeUSD: bigint; swaps: number; bridgeIncomingTransactions: number; bridgeOutgoingTransactions: number;
};
type Flows = {
  version: number; bucketStart: number; bucketEnd: number; throughBlock: number; throughTimestamp: number;
  complete: boolean; fees: string; volumeUSD: string; accounts: number; transactions: number;
};
type Cache = { calendarBuckets: Map<string, unknown> };
type Window = { type: string; pendingDocument: IndexerDocument | null };
type Worker = {
  networkCalendarHistorySealed: boolean;
  networkCalendarSealedThrough: number;
  createRollingNetworkInputCacheFromBlocks(timestamp: number, version: number, blocks: Block[]): Cache;
  advanceRollingNetworkInputCache(cache: Cache, timestamp: number): void;
  addRollingNetworkBlock(cache: Cache, block: Block, timestamp: number): boolean;
  networkCalendarFlows(cache: Cache, type: string, start: number): Flows | null;
  createCompletedNetworkCalendarDocuments(analytics: { networkCalendarCache: Cache }, timestamp: number, include: boolean): Promise<IndexerDocument[]>;
  createNetworkBackfillWindows(): Window[];
  advanceNetworkBackfillWindow(window: Window, block: Block): IndexerDocument;
};
/** Minimal exact flow input; the values remain codec/fixed-point integers throughout aggregation. */
const block = (height: number, timestamp: number, amount: bigint): Block => ({
  id: `block-${height}`, blockHeight: height, timestamp, accounts: 1, transactions: 1,
  fees: amount * 10n ** 18n, volumeUSD: amount * 10n ** 18n,
  swaps: 1, bridgeIncomingTransactions: 0, bridgeOutgoingTransactions: 0,
});
/** Exercise the actual worker cache and persistence path without a chain connection. */
const setup = () => {
  const repository = new MemoryRepository();
  const worker = new ChainIndexer(readConfig(), repository) as unknown as Worker;
  return { worker, repository };
};

describe('durable calendar network flow evidence', () => {
  it('separates adjacent hours and seals the prior hour including its late tail, preserving original stocks and rolling totals', async () => {
    const { worker, repository } = setup();
    const cache = worker.createRollingNetworkInputCacheFromBlocks(7190, 3, [
      block(1, 3590, 100n), block(2, 3600, 5n), block(3, 7190, 7n),
    ]);
    expect(worker.networkCalendarFlows(cache, 'HOUR', 3600)).toMatchObject({
      fees: '12000000000000000000', volumeUSD: '12', throughBlock: 3, complete: false,
    });
    const original: IndexerDocument = {
      collection: 'networkSnapshots', id: 'network-all-HOUR-3600', blockHeight: 2, timestamp: 7100,
      data: { id: 'network-all-HOUR-3600', type: 'HOUR', timestamp: 7100, fees: '999', volumeUSD: '888', liquidityUSD: '777' },
    };
    await repository.upsert(original);
    worker.advanceRollingNetworkInputCache(cache, 7200);
    worker.addRollingNetworkBlock(cache, block(4, 7200, 9n), 7200);
    expect(worker.networkCalendarFlows(cache, 'HOUR', 7200)).toMatchObject({ fees: '9000000000000000000', complete: false });
    const documents = await worker.createCompletedNetworkCalendarDocuments({ networkCalendarCache: cache }, 7200, true);
    const sealed = documents.find((item) => item.id === original.id)!;
    expect(sealed).toMatchObject({ blockHeight: 2, timestamp: 7100, data: {
      fees: '999', volumeUSD: '888', liquidityUSD: '777', calendarFlows: {
        version: 1, bucketStart: 3600, bucketEnd: 7200, throughBlock: 3, throughTimestamp: 7190,
        fees: '12000000000000000000', volumeUSD: '12', complete: true,
      },
    } });
    expect(original.data).not.toHaveProperty('calendarFlows');
  });

  it('seals retained older hourly buckets once with additive idempotent updates', async () => {
    const { worker, repository } = setup();
    const cache = worker.createRollingNetworkInputCacheFromBlocks(14400, 8, [
      block(1, 3590, 0n), block(2, 3600, 5n), block(3, 7190, 7n), block(4, 7200, 9n),
      block(5, 10790, 11n), block(6, 10800, 13n), block(7, 14390, 15n), block(8, 14400, 17n),
    ]);
    for (const start of [3600, 7200, 10800]) {
      await repository.upsert({ collection: 'networkSnapshots', id: `network-all-HOUR-${start}`,
        timestamp: start + 3000, blockHeight: 1, data: { type: 'HOUR', volumeUSD: '999', liquidityUSD: '50' } });
    }
    const documents = await worker.createCompletedNetworkCalendarDocuments({ networkCalendarCache: cache }, 14400, true);
    expect(documents).toHaveLength(3);
    expect(documents.find((item) => item.id === 'network-all-HOUR-3600')?.data).toMatchObject({
      volumeUSD: '999', liquidityUSD: '50', calendarFlows: { volumeUSD: '12', complete: true },
    });
    await repository.upsertMany(documents);
    expect(await worker.createCompletedNetworkCalendarDocuments({ networkCalendarCache: cache }, 14400, true)).toEqual([]);
  });

  it('seals all newly completed hours after a refresh gap', async () => {
    const { worker, repository } = setup();
    worker.networkCalendarHistorySealed = true;
    worker.networkCalendarSealedThrough = 7200;
    const cache = worker.createRollingNetworkInputCacheFromBlocks(14400, 5, [
      block(1, 3590, 0n), block(2, 3600, 5n), block(3, 7200, 7n), block(4, 10800, 9n), block(5, 14400, 11n),
    ]);
    for (const start of [3600, 7200, 10800]) {
      await repository.upsert({ collection: 'networkSnapshots', id: `network-all-HOUR-${start}`,
        timestamp: start + 3000, blockHeight: 1, data: { type: 'HOUR', volumeUSD: '999' } });
    }
    const documents = await worker.createCompletedNetworkCalendarDocuments({ networkCalendarCache: cache }, 14400, true);
    expect(documents.map((item) => item.id).sort()).toEqual(['network-all-HOUR-10800', 'network-all-HOUR-7200']);
  });

  it('withholds exact evidence when a bucket predecessor or an interior canonical block is missing', () => {
    const { worker } = setup();
    const prefixMissing = worker.createRollingNetworkInputCacheFromBlocks(7200, 4, [block(2, 3600, 5n), block(3, 7190, 7n), block(4, 7200, 9n)]);
    expect(worker.networkCalendarFlows(prefixMissing, 'HOUR', 3600)).toBeNull();
    const gap = worker.createRollingNetworkInputCacheFromBlocks(7200, 5, [block(1, 3590, 0n), block(2, 3600, 5n), block(4, 7190, 7n), block(5, 7200, 9n)]);
    expect(worker.networkCalendarFlows(gap, 'HOUR', 3600)).toBeNull();
  });

  it('updates corrected input exactly once and includes changed account counters', () => {
    const { worker } = setup();
    const cache = worker.createRollingNetworkInputCacheFromBlocks(7200, 4, [block(1, 3590, 0n), block(2, 3600, 5n), block(3, 7190, 7n), block(4, 7200, 9n)]);
    expect(worker.addRollingNetworkBlock(cache, block(3, 7190, 7n), 7200)).toBe(false);
    const corrected = { ...block(3, 7190, 8n), accounts: 3 };
    expect(worker.addRollingNetworkBlock(cache, corrected, 7200)).toBe(true);
    expect(worker.networkCalendarFlows(cache, 'HOUR', 3600)).toMatchObject({ volumeUSD: '13', accounts: 4, complete: true });
  });

  it('persists complete calendar evidence at historical backfill boundaries without changing rolling fields', () => {
    const { worker } = setup();
    const window = worker.createNetworkBackfillWindows().find((item) => item.type === 'HOUR')!;
    for (const input of [block(1, 3590, 100n), block(2, 3600, 5n), block(3, 7190, 7n)]) {
      window.pendingDocument = worker.advanceNetworkBackfillWindow(window, input);
    }
    const prior = window.pendingDocument!;
    const next = worker.advanceNetworkBackfillWindow(window, block(4, 7200, 9n));
    expect(prior.data.calendarFlows).toMatchObject({ fees: '12000000000000000000', complete: true });
    expect(prior.data.fees).toBe('112000000000000000000');
    expect(next.data.fees).toBe('21000000000000000000');
    expect(next.data.calendarFlows).toMatchObject({ fees: '9000000000000000000', complete: false });
  });
});
