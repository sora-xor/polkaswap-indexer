import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { readConfig } from '../src/config.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { ROCKSDB_FORMAT_VERSION, ROCKSDB_SWAP_ASSET_INDEX_METADATA_KEY } from '../src/repository/rocksdb.js';
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
    networkSnapshot({ id: 'block-0', type: 'BLOCK', blockHeight: 0, timestamp: 0, swaps: 0, volumeUSD: '0' }),
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
      blockSnapshotsScanned: 3,
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
      repairVersion: 2,
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
      volumeUSD: '999',
      networkFlowRepair: { version: 2, status: 'LEGACY_UNVERIFIED' },
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

  it('rejects stale calendar metadata before writing any volume rows', async () => {
    const repository = new MemoryRepository();
    await seedRepairFixture(repository);
    const row = (await repository.get('networkSnapshots', 'network-all-HOUR-0'))!;
    await repository.upsert({ ...row, data: { ...row.data, calendarFlows: { version: 1, volumeUSD: '999' } } });
    const writes = vi.spyOn(repository, 'upsertMany');
    await expect(executeNetworkVolumeRepair(repository, {
      apply: true, availableBytes: 20 * GIB, minimumFreeBytes: GIB,
    })).rejects.toThrow(/before calendar worker startup/);
    expect(writes).not.toHaveBeenCalled();
  });

  it('repairs a mismatched aggregate only using independent complete BLOCK coverage', async () => {
    const repository = new MemoryRepository();
    await seedRepairFixture(repository);
    const row = (await repository.get('networkSnapshots', 'network-all-HOUR-0'))!;
    await repository.upsert({ ...row, data: { ...row.data, swaps: 99 } });
    const result = await executeNetworkVolumeRepair(repository, {
      apply: true, availableBytes: 20 * GIB, minimumFreeBytes: GIB,
    });
    expect(result.reconciledAggregateCountMismatches).toBe(1);
    expect((await repository.get('networkSnapshots', row.id))?.data).toMatchObject({
      volumeUSD: '12', swaps: 99, networkFlowRepair: { version: 2, status: 'CANONICAL_BLOCKS' },
    });
  });

  it.each(['missing block', 'wrong source timestamp'])('preserves unprovable rolling amounts for %s with explicit legacy evidence', async (cause) => {
    const repository = new MemoryRepository();
    await seedRepairFixture(repository);
    if (cause === 'missing block') await repository.deleteMany('networkSnapshots', ['block-1']);
    else {
      const row = (await repository.get('networkSnapshots', 'network-all-HOUR-0'))!;
      await repository.upsert({ ...row, timestamp: 201, data: { ...row.data, timestamp: 201 } });
    }
    const result = await executeNetworkVolumeRepair(repository, { apply: true, availableBytes: 20 * GIB, minimumFreeBytes: GIB });
    expect(result.preservedUnverifiedAggregates).toBeGreaterThan(0);
    expect((await repository.get('networkSnapshots', 'network-all-HOUR-0'))?.data).toMatchObject({
      volumeUSD: '999', networkFlowRepair: { version: 2, status: 'LEGACY_UNVERIFIED' },
    });
    expect((await repository.get('networkSnapshots', 'block-2'))?.data.volumeUSD).toBe('7');
  });

  it('uses source height to exclude later blocks sharing the exact source timestamp', async () => {
    const repository = new MemoryRepository();
    await seedRepairFixture(repository);
    const block = (await repository.get('networkSnapshots', 'block-2'))!;
    const swap = (await repository.get('historyElements', 'swap-exact'))!;
    await repository.upsertMany([
      { ...block, timestamp: 100, data: { ...block.data, timestamp: 100 } },
      { ...swap, timestamp: 100, data: { ...swap.data, timestamp: 100 } },
      networkSnapshot({ id: 'source-bound', type: 'HOUR', blockHeight: 1, timestamp: 100, swaps: 1 }),
    ]);
    await executeNetworkVolumeRepair(repository, { apply: true, availableBytes: 20 * GIB, minimumFreeBytes: GIB });
    expect((await repository.get('networkSnapshots', 'source-bound'))?.data.volumeUSD).toBe('5');
  });

  it('rejects a swap history timestamp inconsistent with its canonical BLOCK before writes', async () => {
    const repository = new MemoryRepository();
    await seedRepairFixture(repository);
    const swap = (await repository.get('historyElements', 'swap-exact'))!;
    await repository.upsert({ ...swap, timestamp: 201, data: { ...swap.data, timestamp: 201 } });
    const writes = vi.spyOn(repository, 'upsertMany');
    await expect(executeNetworkVolumeRepair(repository, { apply: true, availableBytes: 20 * GIB, minimumFreeBytes: GIB }))
      .rejects.toThrow(/timestamp does not match|BLOCK snapshot swap count/);
    expect(writes).not.toHaveBeenCalled();
  });

  it.each([
    'maxSnapshots', 'maxAggregateSnapshots', 'maxHistoryRows', 'maxSwapObservations', 'maxWriteBytes',
  ] as const)('aborts before writes when %s is exceeded', async (limit) => {
    const repository = new MemoryRepository();
    await seedRepairFixture(repository);
    const writes = vi.spyOn(repository, 'upsertMany');
    await expect(executeNetworkVolumeRepair(repository, {
      apply: true, availableBytes: 20 * GIB, minimumFreeBytes: GIB, limits: { [limit]: 1 },
    })).rejects.toThrow(/limit|exceed/);
    expect(writes).not.toHaveBeenCalled();
    expect(await repository.get('updatesStreams', NETWORK_VOLUME_REPAIR_MARKER_ID)).toBeNull();
  });

  it('resumes safely after interruption between write batches and marks completion last', async () => {
    const repository = new MemoryRepository();
    await seedRepairFixture(repository);
    const original = repository.upsertMany.bind(repository);
    let batches = 0;
    const writes = vi.spyOn(repository, 'upsertMany').mockImplementation(async (documents) => {
      batches += 1;
      if (batches === 2) throw new Error('simulated maintenance interruption');
      await original(documents);
    });
    const options = { apply: true, availableBytes: 20 * GIB, minimumFreeBytes: GIB, limits: { writeBatchSize: 1 } };
    await expect(executeNetworkVolumeRepair(repository, options)).rejects.toThrow(/simulated/);
    expect((await repository.get('networkSnapshots', 'block-1'))?.data.volumeUSD).toBe('5');
    expect((await repository.get('networkSnapshots', 'block-2'))?.data.volumeUSD).toBe('999');
    expect(await repository.get('updatesStreams', NETWORK_VOLUME_REPAIR_MARKER_ID)).toBeNull();
    writes.mockRestore();
    expect((await executeNetworkVolumeRepair(repository, options)).status).toBe('applied');
    expect((await repository.get('networkSnapshots', 'block-2'))?.data.volumeUSD).toBe('7');
    expect((await repository.get('networkSnapshots', 'network-all-HOUR-0'))?.data.volumeUSD).toBe('12');
    expect(await repository.get('updatesStreams', NETWORK_VOLUME_REPAIR_MARKER_ID)).not.toBeNull();
  });

  it('resumes after a calendar-bearing aggregate batch and verifies values independently of key order', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([
      ...[3599, 3600, 7199, 7200].map((timestamp, height) => networkSnapshot({
        id: `block-${height}`, type: 'BLOCK', blockHeight: height, timestamp, swaps: height === 1 || height === 2 ? 1 : 0,
        volumeUSD: height === 1 || height === 2 ? '999' : '0',
      })),
      history({ id: 'one', blockHeight: 1, timestamp: 3600, data: { baseAssetAmountUSD: '5', targetAssetAmountUSD: '5' } }),
      history({ id: 'two', blockHeight: 2, timestamp: 7199, data: { baseAssetAmountUSD: '7', targetAssetAmountUSD: '7' } }),
      networkSnapshot({ id: 'network-all-HOUR-3600', type: 'HOUR', blockHeight: 2, timestamp: 7199, swaps: 99 }),
      networkSnapshot({ id: 'network-all-DEFAULT-6900', type: 'DEFAULT', blockHeight: 2, timestamp: 7199, swaps: 99 }),
      { collection: 'updatesStreams', id: 'networkVolumeRepair-v1', blockHeight: 2, timestamp: 7199, data: { data: '{}' } },
    ]);
    const originalWrite = repository.upsertMany.bind(repository);
    let batches = 0;
    const writes = vi.spyOn(repository, 'upsertMany').mockImplementation(async (documents) => {
      if (++batches === 4) throw new Error('interrupted after calendar metadata was written');
      await originalWrite(documents);
    });
    const options = { apply: true, availableBytes: 20 * GIB, minimumFreeBytes: GIB, limits: { writeBatchSize: 1 } };
    await expect(executeNetworkVolumeRepair(repository, options)).rejects.toThrow(/interrupted/);
    expect((await repository.get('networkSnapshots', 'network-all-DEFAULT-6900'))?.data.calendarFlows).toMatchObject({ complete: true, volumeUSD: '7' });
    expect(await repository.get('updatesStreams', NETWORK_VOLUME_REPAIR_MARKER_ID)).toBeNull();
    writes.mockRestore();
    const originalGet = repository.get.bind(repository);
    vi.spyOn(repository, 'get').mockImplementation(async (collection, id) => {
      const row = await originalGet(collection, id);
      return row ? { ...row, data: Object.fromEntries(Object.entries(row.data).reverse()) } : row;
    });
    const result = await executeNetworkVolumeRepair(repository, options);
    expect(result.status).toBe('applied');
    expect(result.seededCalendarSnapshots).toBe(2);
    expect((await repository.get('networkSnapshots', 'network-all-HOUR-3600'))?.data).toMatchObject({
      volumeUSD: '12', swaps: 99,
      calendarFlows: { complete: true, swaps: 2, volumeUSD: '12', throughBlock: 2, throughTimestamp: 7199 },
    });
    expect(await repository.get('updatesStreams', 'networkVolumeRepair-v1')).not.toBeNull();
  });

  it('requires an explicit acknowledgement for apply mode', () => {
    expect(readNetworkVolumeRepairMode({})).toMatchObject({ apply: false });
    expect(() =>
      readNetworkVolumeRepairMode({ NETWORK_VOLUME_REPAIR_APPLY: 'true' })
    ).toThrow(/NETWORK_VOLUME_REPAIR_CONFIRM/);
    expect(
      readNetworkVolumeRepairMode({
        NETWORK_VOLUME_REPAIR_APPLY: 'true',
        NETWORK_VOLUME_REPAIR_CONFIRM: 'REPAIR:networkSnapshots.volumeUSD:v2',
      })
    ).toMatchObject({ apply: true });
  });

  it('refuses to open a RocksDB path held by the live combined process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polkaswap-volume-repair-lock-'));
    const sourcePath = join(root, 'live.rocksdb');
    const script = `
      import { RocksDatabase } from '@harperfast/rocksdb-js';
      const db = RocksDatabase.open(${JSON.stringify(sourcePath)});
      await db.put(['m', 'metadata', 'rocksdbFormatVersion'], ${ROCKSDB_FORMAT_VERSION});
      await db.put(['m', 'metadata', '${ROCKSDB_SWAP_ASSET_INDEX_METADATA_KEY}'], { version: 1, status: 'ready' });
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
