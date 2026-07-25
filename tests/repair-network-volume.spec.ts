import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { readConfig } from '../src/config.js';
import { MemoryRepository } from '../src/repository/memory.js';
import {
  executeNetworkVolumeRepair,
  NETWORK_VOLUME_REPAIR_MARKER_ID,
  openOfflineNetworkVolumeRepairRepository,
  readNetworkVolumeRepairMode,
  volumeFromSwapHistory,
} from '../src/scripts/repair-network-volume.js';

import type { IndexerDocument } from '../src/repository/types.js';

const GIB = 1024 ** 3;

const history = ({
  id,
  blockHeight,
  timestamp,
  module = 'liquidityProxy',
  method = 'swap',
  success = true,
  data,
  callNames = [],
}: {
  id: string;
  blockHeight: number;
  timestamp: number;
  module?: string;
  method?: string;
  success?: boolean;
  data: Record<string, unknown>;
  callNames?: string[];
}): IndexerDocument => ({
  collection: 'historyElements',
  id,
  blockHeight,
  timestamp,
  data: {
    id,
    blockHeight,
    timestamp,
    module,
    method,
    execution: { success },
    callNames,
    data,
  },
});

const networkSnapshot = ({
  id,
  type,
  blockHeight,
  timestamp,
  swaps,
  volumeUSD = '999',
}: {
  id: string;
  type: 'BLOCK' | 'DEFAULT' | 'HOUR' | 'DAY' | 'MONTH';
  blockHeight: number;
  timestamp: number;
  swaps: number;
  volumeUSD?: string;
}): IndexerDocument => ({
  collection: 'networkSnapshots',
  id,
  blockHeight,
  timestamp,
  data: {
    id,
    type,
    blockHeight,
    timestamp,
    swaps,
    volumeUSD,
    liquidityUSD: '123.45',
    transactions: 7,
  },
});

const seedRepairFixture = async (repository: MemoryRepository): Promise<void> => {
  await repository.upsertMany([
    history({
      id: 'swap-fallback',
      blockHeight: 1,
      timestamp: 100,
      data: {
        baseAssetAmountUSD: '4',
        targetAssetAmountUSD: '5',
      },
    }),
    history({
      id: 'unrelated-burn',
      blockHeight: 2,
      timestamp: 150,
      module: 'assets',
      method: 'burn',
      data: { amountUSD: '1000000' },
    }),
    history({
      id: 'swap-exact',
      blockHeight: 2,
      timestamp: 200,
      module: 'utility',
      method: 'batchAll',
      callNames: ['liquidityProxy.swapTransferBatch'],
      data: { exchangeVolumeUSD: '7' },
    }),
    networkSnapshot({
      id: 'block-1',
      type: 'BLOCK',
      blockHeight: 1,
      timestamp: 100,
      swaps: 1,
    }),
    networkSnapshot({
      id: 'block-2',
      type: 'BLOCK',
      blockHeight: 2,
      timestamp: 200,
      swaps: 1,
    }),
    ...(['DEFAULT', 'HOUR', 'DAY', 'MONTH'] as const).map((type) =>
      networkSnapshot({
        id: `network-all-${type}-0`,
        type,
        blockHeight: 2,
        timestamp: 200,
        swaps: 2,
      })
    ),
  ]);
};

describe('network volume snapshot repair', () => {
  it('uses exact projections first and reconstructs strict legacy direct/batch values', () => {
    expect(
      volumeFromSwapHistory(
        history({
          id: 'exact',
          blockHeight: 1,
          timestamp: 1,
          data: {
            exchangeVolumeUSD: '12.5',
            baseAssetAmountUSD: '999',
            targetAssetAmountUSD: '999',
          },
        })
      )
    ).toMatchObject({ candidate: true, successful: true, volumeUSD: 12_500_000_000_000_000_000n });

    expect(
      volumeFromSwapHistory(
        history({
          id: 'direct',
          blockHeight: 2,
          timestamp: 2,
          data: { baseAssetAmountUSD: '2.5', targetAssetAmountUSD: '3' },
        })
      )
    ).toMatchObject({ candidate: true, successful: true, volumeUSD: 3_000_000_000_000_000_000n });

    expect(
      volumeFromSwapHistory(
        history({
          id: 'batch',
          blockHeight: 3,
          timestamp: 3,
          method: 'swapTransferBatch',
          data: { receivers: [{ amountUSD: '1.25' }, { amountUSD: '2.75' }] },
        })
      )
    ).toMatchObject({ candidate: true, successful: true, volumeUSD: 4_000_000_000_000_000_000n });

    expect(
      volumeFromSwapHistory(
        history({
          id: 'failed',
          blockHeight: 4,
          timestamp: 4,
          success: false,
          data: { baseAssetAmountUSD: '100', targetAssetAmountUSD: '200' },
        })
      )
    ).toEqual({
      candidate: true,
      successful: false,
      volumeUSD: null,
      countsTowardPersistedSnapshotSwaps: false,
    });

    expect(
      volumeFromSwapHistory(
        history({
          id: 'burn',
          blockHeight: 5,
          timestamp: 5,
          module: 'assets',
          method: 'burn',
          data: { amountUSD: '500' },
        })
      )
    ).toEqual({
      candidate: false,
      successful: false,
      volumeUSD: null,
      countsTowardPersistedSnapshotSwaps: false,
    });
  });

  it('defaults to a read-only dry run and preserves every snapshot field', async () => {
    const repository = new MemoryRepository();
    await seedRepairFixture(repository);
    const upsertMany = vi.spyOn(repository, 'upsertMany');

    const result = await executeNetworkVolumeRepair(repository, {
      apply: false,
      availableBytes: 20 * GIB,
      minimumFreeBytes: GIB,
    });

    expect(result).toMatchObject({
      status: 'dry-run',
      historyRowsScanned: 3,
      valuedSwapRows: 2,
      blockSnapshotsScanned: 2,
      aggregateSnapshotsScanned: 4,
      changedBlockSnapshots: 2,
      changedAggregateSnapshots: 4,
      space: { sufficient: true },
    });
    expect(upsertMany).not.toHaveBeenCalled();
    expect((await repository.get('networkSnapshots', 'block-1'))?.data).toMatchObject({
      volumeUSD: '999',
      liquidityUSD: '123.45',
      transactions: 7,
    });
    expect(await repository.get('updatesStreams', NETWORK_VOLUME_REPAIR_MARKER_ID)).toBeNull();
  });

  it('applies changed rows in place, verifies them, and records an idempotent marker', async () => {
    const repository = new MemoryRepository();
    await seedRepairFixture(repository);

    const result = await executeNetworkVolumeRepair(repository, {
      apply: true,
      availableBytes: 20 * GIB,
      minimumFreeBytes: GIB,
      now: () => 1_700_000_000_000,
      limits: { writeBatchSize: 1 },
    });

    expect(result.status).toBe('applied');
    expect((await repository.get('networkSnapshots', 'block-1'))?.data).toMatchObject({
      volumeUSD: '5',
      liquidityUSD: '123.45',
      transactions: 7,
    });
    expect((await repository.get('networkSnapshots', 'block-2'))?.data.volumeUSD).toBe('7');
    for (const type of ['DEFAULT', 'HOUR', 'DAY', 'MONTH']) {
      expect(
        (await repository.get('networkSnapshots', `network-all-${type}-0`))?.data
      ).toMatchObject({
        volumeUSD: '12',
        liquidityUSD: '123.45',
        transactions: 7,
      });
    }

    const marker = await repository.get('updatesStreams', NETWORK_VOLUME_REPAIR_MARKER_ID);
    expect(marker).not.toBeNull();
    expect(JSON.parse(String(marker?.data.data))).toMatchObject({
      status: 'complete',
      repairVersion: 1,
      completedAt: 1_700_000_000,
      changedBlockSnapshots: 2,
      changedAggregateSnapshots: 4,
    });

    const upsert = vi.spyOn(repository, 'upsert');
    const upsertMany = vi.spyOn(repository, 'upsertMany');
    const repeated = await executeNetworkVolumeRepair(repository, {
      apply: true,
      availableBytes: 20 * GIB,
      minimumFreeBytes: GIB,
    });
    expect(repeated.status).toBe('already-applied');
    expect(upsert).not.toHaveBeenCalled();
    expect(upsertMany).not.toHaveBeenCalled();
  });

  it('fails closed before writes when retained block swap counts do not reconcile', async () => {
    const repository = new MemoryRepository();
    await seedRepairFixture(repository);
    const block = await repository.get('networkSnapshots', 'block-1');
    await repository.upsert({
      ...block!,
      data: { ...block!.data, swaps: 2 },
    });
    const upsertMany = vi.spyOn(repository, 'upsertMany');

    await expect(
      executeNetworkVolumeRepair(repository, {
        apply: true,
        availableBytes: 20 * GIB,
        minimumFreeBytes: GIB,
      })
    ).rejects.toThrow(/BLOCK snapshot swap count/);
    expect(upsertMany).not.toHaveBeenCalled();
    expect((await repository.get('networkSnapshots', 'block-1'))?.data.volumeUSD).toBe('999');
    expect(await repository.get('updatesStreams', NETWORK_VOLUME_REPAIR_MARKER_ID)).toBeNull();
  });

  it('fails closed on an unvalued successful utility swap instead of guessing zero', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([
      history({
        id: 'legacy-utility-swap',
        blockHeight: 10,
        timestamp: 100,
        module: 'utility',
        method: 'batchAll',
        callNames: ['liquidityProxy.swap'],
        data: { calls: [] },
      }),
      networkSnapshot({
        id: 'block-10',
        type: 'BLOCK',
        blockHeight: 10,
        timestamp: 100,
        swaps: 1,
      }),
    ]);
    const upsertMany = vi.spyOn(repository, 'upsertMany');

    await expect(
      executeNetworkVolumeRepair(repository, {
        apply: true,
        availableBytes: 20 * GIB,
        minimumFreeBytes: GIB,
      })
    ).rejects.toThrow(/Cannot safely value successful liquidityProxy history at block 10/);
    expect(upsertMany).not.toHaveBeenCalled();
  });

  it('repairs safely valued legacy batch volume without adding it to legacy swap counts', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([
      history({
        id: 'legacy-direct-batch',
        blockHeight: 20,
        timestamp: 100,
        method: 'swapTransferBatch',
        data: { receivers: [{ amountUSD: '1.25' }, { amountUSD: '2.75' }] },
      }),
      networkSnapshot({
        id: 'block-20',
        type: 'BLOCK',
        blockHeight: 20,
        timestamp: 100,
        swaps: 0,
      }),
      networkSnapshot({
        id: 'network-all-HOUR-0',
        type: 'HOUR',
        blockHeight: 20,
        timestamp: 100,
        swaps: 0,
      }),
    ]);

    const result = await executeNetworkVolumeRepair(repository, {
      apply: true,
      availableBytes: 20 * GIB,
      minimumFreeBytes: GIB,
    });

    expect(result.status).toBe('applied');
    expect((await repository.get('networkSnapshots', 'block-20'))?.data).toMatchObject({
      swaps: 0,
      volumeUSD: '4',
    });
    expect(
      (await repository.get('networkSnapshots', 'network-all-HOUR-0'))?.data
    ).toMatchObject({
      swaps: 0,
      volumeUSD: '4',
    });
  });

  it('refuses apply mode before writes when the disk reserve is insufficient', async () => {
    const repository = new MemoryRepository();
    await seedRepairFixture(repository);
    const upsertMany = vi.spyOn(repository, 'upsertMany');

    await expect(
      executeNetworkVolumeRepair(repository, {
        apply: true,
        availableBytes: 1,
        minimumFreeBytes: GIB,
      })
    ).rejects.toThrow(/requires .* available bytes but only 1/);
    expect(upsertMany).not.toHaveBeenCalled();
    expect(await repository.get('updatesStreams', NETWORK_VOLUME_REPAIR_MARKER_ID)).toBeNull();
  });

  it('requires an explicit acknowledgement for apply mode', () => {
    expect(readNetworkVolumeRepairMode({})).toMatchObject({ apply: false });
    expect(() =>
      readNetworkVolumeRepairMode({ NETWORK_VOLUME_REPAIR_APPLY: 'true' })
    ).toThrow(/NETWORK_VOLUME_REPAIR_CONFIRM/);
    expect(
      readNetworkVolumeRepairMode({
        NETWORK_VOLUME_REPAIR_APPLY: 'true',
        NETWORK_VOLUME_REPAIR_CONFIRM: 'REPAIR:networkSnapshots.volumeUSD:v1',
      })
    ).toMatchObject({ apply: true });
  });

  it('refuses to open a RocksDB path held by the live combined process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polkaswap-volume-repair-lock-'));
    const sourcePath = join(root, 'live.rocksdb');
    const script = `
      import { RocksDatabase } from '@harperfast/rocksdb-js';
      const db = RocksDatabase.open(${JSON.stringify(sourcePath)});
      await db.put(['m', 'metadata', 'rocksdbFormatVersion'], 1);
      await db.put(['d', 'assets', 'sentinel'], { value: true });
      process.stdout.write('ready\\n');
      process.stdin.once('data', () => { db.close(); process.exit(0); });
    `;
    const writer: ChildProcessWithoutNullStreams = spawn(
      process.execPath,
      ['--input-type=module', '-e', script],
      {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );

    try {
      await new Promise<void>((resolve, reject) => {
        writer.once('error', reject);
        writer.once('exit', (code) =>
          reject(new Error(`Writer exited before ready with code ${String(code)}`))
        );
        writer.stdout.once('data', (chunk) => {
          if (String(chunk).includes('ready')) resolve();
          else reject(new Error(`Unexpected writer output: ${String(chunk)}`));
        });
      });

      await expect(
        openOfflineNetworkVolumeRepairRepository(sourcePath, false, {
          ...readConfig(),
          rocksdbPath: sourcePath,
          storageEngine: 'rocksdb',
        })
      ).rejects.toThrow(/stop the combined indexer/);
    } finally {
      writer.stdin.end('\n');
      if (writer.exitCode === null) await once(writer, 'exit');
      await rm(root, { recursive: true, force: true });
    }
  });
});
