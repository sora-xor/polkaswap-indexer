import { afterEach, describe, expect, it, vi } from 'vitest';

import { readConfig } from '../src/config.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { ChainIndexer } from '../src/worker/chain.js';
import { projectNetworkSnapshotFlows } from '../src/graphql/network-flow.js';
import type { IndexerDocument } from '../src/repository/types.js';

const liquidity = { liquidityUSD: '0', poolLiquidityUSD: '0', orderBookLiquidityUSD: '0',
  activePools: 0, activeOrderBooks: 0, listedAssets: 0 };
type Worker = {
  runStartupMaintenance(height: number): Promise<number>;
  runLegacyStartupMaintenance(height: number, indexed: boolean): Promise<void>;
  getLastIndexedBlock(): Promise<number>;
  refreshDerivedState(height: number, timestamp: number, snapshots: boolean, force: boolean): Promise<void>;
  requestDerivedStateRefresh(height: number, timestamp: number, snapshots: boolean, force: boolean): void;
  loadAnalyticsInputDocuments(): Promise<null>;
  buildAnalytics(timestamp: number, assets: Map<string, never>, prices: Map<string, bigint>, pools: never[],
    stocks: typeof liquidity, sourceVersion: number): Promise<unknown>;
  createNetworkSnapshotDocuments(analytics: unknown, height: number, timestamp: number, snapshots: boolean): IndexerDocument[];
  cleanupAssetSnapshotPriceOutliers(): Promise<boolean>;
  repairXorSupplyDocuments(): Promise<boolean>;
  backfillAccountTransactions(): Promise<boolean>;
  repairNetworkTransactionCounters(): Promise<boolean>;
  backfillNetworkAggregateSnapshots(): Promise<boolean>;
  requestXorBurnBackfill(): void;
  backfillBridgeProxyHistory(): Promise<void>;
};

/** Canonical source timestamps intentionally differ from the process wall clock. */
const block = (height: number, timestamp: number, volumeUSD: string): IndexerDocument => ({
  collection: 'networkSnapshots', id: `block-${height}`, blockHeight: height, timestamp,
  data: { id: `block-${height}`, type: 'BLOCK', timestamp, accounts: 0, transactions: 1,
    fees: '1', volumeUSD, swaps: 1, bridgeIncomingTransactions: 0, bridgeOutgoingTransactions: 0 },
});
const setup = () => {
  const repository = new MemoryRepository();
  const worker = new ChainIndexer(readConfig(), repository) as unknown as Worker;
  worker.getLastIndexedBlock = async () => 2;
  return { repository, worker };
};

afterEach(() => vi.restoreAllMocks());

describe('startup network snapshot source time', () => {
  it('uses the indexed source clock for streaming rolling totals and snapshot metadata', async () => {
    const { repository, worker } = setup();
    await repository.upsertMany([block(0, 3699, '0'), block(1, 3700, '5'), block(2, 7300, '7')]);
    vi.spyOn(Date, 'now').mockReturnValue(7317 * 1000);
    // The bounded-cache fallback intentionally retains no calendar evidence.
    worker.loadAnalyticsInputDocuments = async () => null;
    let snapshots: IndexerDocument[] = [];
    worker.refreshDerivedState = async (height, timestamp, includeSnapshots) => {
      const analytics = await worker.buildAnalytics(timestamp, new Map<string, never>(), new Map<string, bigint>(), [], liquidity, height);
      snapshots = worker.createNetworkSnapshotDocuments(analytics, height, timestamp, includeSnapshots);
    };
    await expect(worker.runStartupMaintenance(1)).resolves.toBe(2);
    const hour = snapshots.find((document) => document.data.type === 'HOUR');
    expect(hour).toMatchObject({ blockHeight: 2, timestamp: 7300,
      data: { timestamp: 7300, volumeUSD: '12', transactions: 2, swaps: 2 } });
    expect(hour?.data).not.toHaveProperty('calendarFlows');
    const projected = await projectNetworkSnapshotFlows(repository, [hour!], {
      type: { equalTo: 'HOUR' }, timestamp: { greaterThanOrEqualTo: 7200, lessThanOrEqualTo: 7300 },
    });
    expect(projected[0]?.data).toMatchObject({ flowAggregation: 'CALENDAR', volumeUSD: '7' });
  });

  it('queues legacy startup follow-up at its canonical indexed timestamp', async () => {
    const { repository, worker } = setup();
    await repository.upsert(block(2, 7300, '7'));
    vi.spyOn(Date, 'now').mockReturnValue(7317 * 1000);
    worker.cleanupAssetSnapshotPriceOutliers = async () => false;
    worker.repairXorSupplyDocuments = async () => false;
    worker.backfillAccountTransactions = async () => false;
    worker.repairNetworkTransactionCounters = async () => false;
    worker.backfillNetworkAggregateSnapshots = async () => false;
    worker.requestXorBurnBackfill = () => undefined;
    worker.backfillBridgeProxyHistory = async () => undefined;
    const request = vi.fn();
    worker.requestDerivedStateRefresh = request;
    await worker.runLegacyStartupMaintenance(1, true);
    expect(request).toHaveBeenCalledExactlyOnceWith(2, 7300, true, true);
  });

  it.each(['missing', 'wrong-type', 'inconsistent-time'] as const)(
    'refuses %s BLOCK evidence before projecting startup state', async (kind) => {
      const { repository, worker } = setup();
      if (kind !== 'missing') {
        const source = block(2, 7300, '7');
        source.data = { ...source.data, ...(kind === 'wrong-type' ? { type: 'HOUR' } : { timestamp: 7317 }) };
        if (kind === 'inconsistent-time') vi.spyOn(repository, 'get').mockResolvedValue(source);
        else await repository.upsert(source);
      }
      const refresh = vi.fn(async () => undefined);
      worker.refreshDerivedState = refresh;
      await expect(worker.runStartupMaintenance(1)).rejects.toThrow(/canonical timestamped BLOCK 2/);
      expect(refresh).not.toHaveBeenCalled();
    }
  );
});
