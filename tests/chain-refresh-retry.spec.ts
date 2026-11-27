import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readConfig } from '../src/config.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { ChainIndexer } from '../src/worker/chain.js';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => undefined); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe.each(['DerivedState', 'PolkamarktState', 'PriceStream'])('%s refresh scheduler', domain => {
  function fixture() {
    const indexer: any = new ChainIndexer(readConfig(), new MemoryRepository());
    const lower = domain[0]!.toLowerCase() + domain.slice(1);
    const refresh = vi.fn(async (..._args: unknown[]): Promise<void> => undefined);
    indexer[`refresh${domain}`] = refresh;
    return {
      indexer, refresh,
      request: (block: number, snapshots = false) => indexer[`request${domain}Refresh`](block, block * 6, snapshots, false),
      drain: () => indexer[`drain${domain}RefreshQueue`](),
      pending: `pending${domain}Refresh`, running: `${lower}RefreshRunning`, timer: `${lower}RefreshRetryTimer`,
      schedule: () => indexer[`schedule${domain}RefreshRetry`](),
    };
  }
  it('coalesces startup requests at the latest block without starting early', async () => {
    const f = fixture(); f.indexer.lifecycleState = 'starting';
    f.request(20); f.request(10, true); f.request(30);
    expect(f.refresh).not.toHaveBeenCalled(); expect(f.indexer[f.pending].blockHeight).toBe(30);
    if (domain !== 'PriceStream') expect(f.indexer[f.pending].includeSnapshots).toBe(true);
    f.indexer.lifecycleState = 'running'; await f.drain();
    expect(f.refresh.mock.calls[0]?.slice(0, 2)).toEqual([30, 180]); expect(f.indexer[f.pending]).toBeNull();
  });
  it.each(['stopping', 'stopped', 'failed'])('rejects work in lifecycle state %s', async state => {
    const f = fixture(); f.indexer.lifecycleState = state; f.request(10); f.schedule(); await f.drain();
    expect(f.refresh).not.toHaveBeenCalled(); expect(f.indexer[f.pending]).toBeNull(); expect(f.indexer[f.timer]).toBeNull();
  });
  it('does no work without a pending request and does not run two refreshes concurrently', async () => {
    const f = fixture(); await f.drain(); expect(f.refresh).not.toHaveBeenCalled();
    let finish!: () => void; f.refresh.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    f.request(10); f.request(20); f.request(15); await flush();
    expect(f.refresh).toHaveBeenCalledOnce(); expect(f.indexer[f.running]).toBe(true);
    finish(); await flush();
    expect(f.refresh.mock.calls.map(call => call[0])).toEqual([10, 20]); expect(f.indexer[f.running]).toBe(false);
  });
  it('retries a failed refresh once, retaining the newest pending block', async () => {
    const f = fixture(); f.refresh.mockRejectedValueOnce(new Error('RPC unavailable'));
    f.request(10); await flush(); const timer = f.indexer[f.timer];
    expect(timer).not.toBeNull(); f.schedule(); expect(f.indexer[f.timer]).toBe(timer);
    f.indexer.lifecycleState = 'starting'; f.request(20); f.indexer.lifecycleState = 'running';
    await vi.runOnlyPendingTimersAsync(); await flush();
    expect(f.refresh.mock.calls.map(call => call[0])).toEqual([10, 20]);
    expect(f.indexer[f.timer]).toBeNull(); expect(f.indexer[f.pending]).toBeNull();
  });
  it('clears an outstanding retry when another refresh succeeds first', async () => {
    const f = fixture(); f.refresh.mockRejectedValueOnce(new Error('retryable'));
    f.request(10); await flush(); expect(f.indexer[f.timer]).not.toBeNull();
    await f.drain(); expect(f.indexer[f.timer]).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  });
  it('does not retry an in-flight failure after shutdown begins', async () => {
    const f = fixture(); let reject!: (reason: Error) => void;
    f.refresh.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    f.request(10); await flush(); f.indexer.lifecycleState = 'stopping'; reject(new Error('closing')); await flush();
    expect(f.indexer[f.timer]).toBeNull(); expect(f.indexer[f.running]).toBe(false);
  });
  it('ignores an already scheduled retry when shutdown has begun', async () => {
    const f = fixture(); f.schedule(); f.indexer.lifecycleState = 'stopping';
    await vi.runOnlyPendingTimersAsync(); expect(f.refresh).not.toHaveBeenCalled(); expect(f.indexer[f.timer]).toBeNull();
  });
});

describe('XOR burn backfill scheduler', () => {
  function fixture() {
    const indexer: any = new ChainIndexer(readConfig(), new MemoryRepository());
    indexer.api = {}; indexer.xorBurnBackfillTargetBlock = 100;
    indexer.backfillXorBurns = vi.fn(async () => undefined);
    return indexer;
  }
  it('backfills the captured target and schedules newly arrived blocks', async () => {
    const indexer = fixture();
    indexer.backfillXorBurns.mockImplementationOnce(async () => { indexer.xorBurnBackfillTargetBlock = 200; });
    await indexer.runXorBurnBackfill(); expect(indexer.xorBurnBackfillRunning).toBe(false);
    await vi.runOnlyPendingTimersAsync(); await flush();
    expect(indexer.backfillXorBurns.mock.calls).toEqual([[100], [200]]);
  });
  it('retries a failed pass without creating duplicate timers', async () => {
    const indexer = fixture(); indexer.backfillXorBurns.mockRejectedValueOnce(new Error('RPC failed'));
    await indexer.runXorBurnBackfill(); const timer = indexer.xorBurnBackfillRetryTimer;
    indexer.scheduleXorBurnBackfillRetry(); expect(indexer.xorBurnBackfillRetryTimer).toBe(timer);
    await vi.runOnlyPendingTimersAsync(); await flush(); expect(indexer.backfillXorBurns).toHaveBeenCalledTimes(2);
  });
  it.each(['stopped', 'no-api', 'already-running'])('avoids starting in %s state', async state => {
    const indexer = fixture();
    if (state === 'stopped') indexer.lifecycleState = 'stopped';
    if (state === 'no-api') indexer.api = null;
    if (state === 'already-running') indexer.xorBurnBackfillRunning = true;
    await indexer.runXorBurnBackfill(); expect(indexer.backfillXorBurns).not.toHaveBeenCalled();
  });
  it('does not execute a scheduled pass after shutdown', async () => {
    const indexer = fixture(); indexer.scheduleXorBurnBackfillRetry(); indexer.lifecycleState = 'stopping';
    await vi.runOnlyPendingTimersAsync(); expect(indexer.backfillXorBurns).not.toHaveBeenCalled();
    indexer.scheduleXorBurnBackfillRetry(); expect(indexer.xorBurnBackfillRetryTimer).toBeNull();
  });
  it('does not schedule retries for a failure that arrives during shutdown', async () => {
    const indexer = fixture(); indexer.backfillXorBurns.mockImplementationOnce(async () => { indexer.lifecycleState = 'stopping'; throw new Error('closing'); });
    await indexer.runXorBurnBackfill(); expect(indexer.xorBurnBackfillRetryTimer).toBeNull(); expect(indexer.xorBurnBackfillRunning).toBe(false);
  });
});
