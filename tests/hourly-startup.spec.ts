import { afterEach, describe, expect, it, vi } from 'vitest';
import { readConfig } from '../src/config.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { ChainIndexer } from '../src/worker/chain.js';
import { HOURLY_HISTORY_GENESIS } from '../src/worker/hourly-history.js';

const dependencies = vi.hoisted(() => ({ create: vi.fn(), apply: vi.fn(), disconnect: vi.fn() }));
vi.mock('@polkadot/api', () => ({
  ApiPromise: { create: dependencies.create },
  WsProvider: class { disconnect = dependencies.disconnect; },
}));
vi.mock('../src/scripts/backfill-hourly-history.js', () => ({ applyHourlyBackfillFile: dependencies.apply }));

afterEach(() => vi.clearAllMocks());

/** Start the real worker lifecycle with all network and artifact I/O replaced. */
function startup() {
  const repository = new MemoryRepository();
  const worker = new ChainIndexer({
    ...readConfig(), hourlyRepairFile: '/prepared/verified.jsonl', hourlyRepairSha256: 'a'.repeat(64),
  }, repository);
  dependencies.create.mockResolvedValue({
    genesisHash: { toString: () => HOURLY_HISTORY_GENESIS },
    disconnect: dependencies.disconnect,
    rpc: { chain: {
      getFinalizedHead: async () => 'finalized',
      getHeader: async () => ({ number: { toNumber: () => 101 } }),
    } },
  });
  const internal = worker as unknown as {
    backfill: () => Promise<boolean>;
    runStartupMaintenance: (height: number) => Promise<number>;
    subscribeFinalizedHeads: () => Promise<void>;
  };
  internal.backfill = vi.fn(async () => false);
  internal.runStartupMaintenance = vi.fn(async () => 101);
  internal.subscribeFinalizedHeads = vi.fn(async () => undefined);
  return { worker, internal, repository };
}

describe('single-owner hourly repair activation', () => {
  it('awaits validated repair through the existing repository before normal catchup or subscription', async () => {
    const test = startup();
    let complete: (() => void) | undefined;
    dependencies.apply.mockImplementationOnce(async () => await new Promise<void>((resolve) => { complete = resolve; }));
    try {
      const starting = test.worker.start();
      await vi.waitFor(() => expect(dependencies.apply).toHaveBeenCalledExactlyOnceWith(test.repository, {
        path: '/prepared/verified.jsonl', sha256: 'a'.repeat(64),
        genesisHash: HOURLY_HISTORY_GENESIS, finalizedHeight: 101,
      }));
      expect(test.internal.backfill).not.toHaveBeenCalled();
      expect(test.internal.subscribeFinalizedHeads).not.toHaveBeenCalled();
      complete?.();
      await starting;
      expect(test.internal.backfill).toHaveBeenCalledOnce();
      expect(test.internal.subscribeFinalizedHeads).toHaveBeenCalledOnce();
    } finally {
      complete?.();
      await test.worker.stop();
    }
  });

  it('fails startup before catchup when artifact verification fails', async () => {
    const test = startup();
    dependencies.apply.mockRejectedValueOnce(new Error('artifact checksum mismatch'));
    try {
      await expect(test.worker.start()).rejects.toThrow('artifact checksum mismatch');
      expect(test.internal.backfill).not.toHaveBeenCalled();
      expect(test.internal.subscribeFinalizedHeads).not.toHaveBeenCalled();
      expect(await test.repository.get('updatesStreams', 'chainState')).toBeNull();
    } finally {
      await test.worker.stop();
    }
  });
});
