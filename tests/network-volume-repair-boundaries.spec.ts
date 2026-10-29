import { describe, expect, it, vi } from 'vitest';
import { MemoryRepository } from '../src/repository/memory.js';
import { evaluateNetworkVolumeRepairSpace, executeNetworkVolumeRepair, NETWORK_VOLUME_REPAIR_MARKER_ID, volumeFromSwapHistory, type NetworkVolumeRepairLimits } from '../src/scripts/repair-network-volume.js';
import type { IndexerDocument } from '../src/repository/types.js';
const options = { apply: false, availableBytes: 100 * 1024 ** 3, minimumFreeBytes: 0 };
const history = (data: Record<string, unknown>): IndexerDocument => ({ collection: 'historyElements', id: 'history', blockHeight: 1, timestamp: 100, data });
const swap = (data: unknown, extra: Record<string, unknown> = {}) => history({ module: 'liquidityProxy', method: 'swap', execution: { success: true }, data, ...extra });
const block = (height: number, data: Record<string, unknown> = {}): IndexerDocument => ({ collection: 'networkSnapshots', id: `block-${height}`, blockHeight: height, timestamp: height * 100,
  data: { type: 'BLOCK', swaps: 0, accounts: 0, transactions: 0, fees: '0', volumeUSD: '0', ...data } });
const fixture = async () => { const repository = new MemoryRepository(); await repository.upsertMany([block(0), block(1)]); return repository; };

describe('network repair refuses ambiguous historical amounts', () => {
  it.each([{}, { callNames: false }, { callNames: ['balances.transfer', 'liquidityProxy', 'liquidityProxy.unknown'] }])('ignores unrelated or missing method inventory %j', data => {
    expect(volumeFromSwapHistory(history(data))).toEqual({ candidate: false, successful: false, volumeUSD: null, countsTowardPersistedSnapshotSwaps: false });
  });
  it.each([undefined, null, {}, { success: 'true' }])('does not infer a verified amount from absent execution evidence %j', execution => {
    expect(volumeFromSwapHistory(swap({ exchangeVolumeUSD: '12.5' }, { execution }))).toEqual({ candidate: true, successful: true, volumeUSD: null, countsTowardPersistedSnapshotSwaps: true });
  });
  it.each([null, [], 'amount'])('does not infer volume from malformed payload %j', data => {
    expect(volumeFromSwapHistory(swap(data)).volumeUSD).toBeNull();
  });
  it('requires exact event-derived volume when multiple swap methods appear in one extrinsic', () => {
    const extra = { callNames: ['liquidityProxy.swapTransfer', 'liquidityProxy.swap'] };
    expect(volumeFromSwapHistory(swap({ baseAssetAmountUSD: '10', targetAssetAmountUSD: '9' }, extra)).volumeUSD).toBeNull();
    expect(volumeFromSwapHistory(swap({ exchangeVolumeUSD: '10.125' }, extra)).volumeUSD).toBe(10_125_000_000_000_000_000n);
  });
  it.each([undefined, null, 'receiver', [null], [{ amountUSD: '-1' }], [{ amountUSD: '1.0000000000000000001' }]])('refuses an incomplete batch receiver valuation %j', receivers => {
    expect(volumeFromSwapHistory(swap({ receivers }, { method: 'swapTransferBatch' }))).toMatchObject({ volumeUSD: null, countsTowardPersistedSnapshotSwaps: false });
  });
  it('chooses the larger side without double-counting a direct swap', () => {
    expect(volumeFromSwapHistory(swap({ baseAssetAmountUSD: '10.5', targetAssetAmountUSD: '9.25' })).volumeUSD).toBe(10_500_000_000_000_000_000n);
  });
});

describe('network repair resource preflight', () => {
  for (const field of ['availableBytes', 'estimatedWriteBytes', 'minimumFreeBytes'] as const) {
    it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(`rejects invalid ${field}=%s`, value => {
      const values = { availableBytes: 1000, estimatedWriteBytes: 10, minimumFreeBytes: 20, [field]: value };
      expect(() => evaluateNetworkVolumeRepairSpace(values.availableBytes, values.estimatedWriteBytes, values.minimumFreeBytes)).toThrow(new RegExp(field));
    });
  }
  it('reserves eight times the write size and admits the exact boundary', () => {
    expect(evaluateNetworkVolumeRepairSpace(100, 10, 20)).toMatchObject({ sufficient: true, requiredAvailableBytes: 100, writeAmplificationReserveBytes: 80 });
    expect(evaluateNetworkVolumeRepairSpace(99, 10, 20).sufficient).toBe(false);
    expect(evaluateNetworkVolumeRepairSpace(0, 0, 0).sufficient).toBe(true);
  });
  it('refuses arithmetic overflow in a reserve before any repair writes', () => {
    expect(() => evaluateNetworkVolumeRepairSpace(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 1)).toThrow(/safe integer range/);
  });
  it.each(['maxHistoryRows', 'maxSwapObservations', 'maxSnapshots', 'maxAggregateSnapshots', 'maxWriteBytes', 'progressEvery', 'writeBatchSize'] as const)('rejects nonpositive %s before repository reads', async field => {
    const repository = new MemoryRepository(), get = vi.spyOn(repository, 'get');
    await expect(executeNetworkVolumeRepair(repository, { ...options, limits: { [field]: 0 } as Partial<NetworkVolumeRepairLimits> })).rejects.toThrow(new RegExp(field));
    expect(get).not.toHaveBeenCalled();
  });
  it('refuses a write batch above the repository transaction limit', async () => {
    await expect(executeNetworkVolumeRepair(new MemoryRepository(), { ...options, limits: { writeBatchSize: 10001 } })).rejects.toThrow(/writeBatchSize must not exceed/);
  });
});

describe('network repair persisted evidence boundaries', () => {
  const marker = (data: unknown): IndexerDocument => ({ collection: 'updatesStreams', id: NETWORK_VOLUME_REPAIR_MARKER_ID, data: { data } });
  const completeMarker = () => ({ status: 'complete', repairVersion: 2, semantics: 'verified-block-exchange-volume-calendar-v2', throughBlock: 1, earliestHistoryTimestamp: 0, latestSnapshotTimestamp: 100,
    historyRowsScanned: 0, valuedSwapRows: 0, blockSnapshotsScanned: 2, aggregateSnapshotsScanned: 0, changedBlockSnapshots: 0, changedAggregateSnapshots: 0,
    reconciledAggregateCountMismatches: 0, preservedUnverifiedAggregates: 0, seededCalendarSnapshots: 0, estimatedWriteBytes: 0 });
  it.each([null, 3, '{broken'])('rejects malformed completion marker %j', async data => {
    const repository = new MemoryRepository(); await repository.upsert(marker(data));
    await expect(executeNetworkVolumeRepair(repository, options)).rejects.toThrow(/marker is malformed/);
  });
  it.each([null, [], {}, { status: 'running', repairVersion: 2, semantics: 'verified-block-exchange-volume-calendar-v2' }, { status: 'complete', repairVersion: 1 }, { status: 'complete', repairVersion: 2, semantics: 'unknown' }])('rejects unsupported completion evidence %j', async value => {
    const repository = new MemoryRepository(); await repository.upsert(marker(JSON.stringify(value)));
    await expect(executeNetworkVolumeRepair(repository, options)).rejects.toThrow(/unsupported version or status/);
  });
  it('reads canonical historical numeric strings from a completion marker without rescanning', async () => {
    const repository = new MemoryRepository(); const value = Object.fromEntries(Object.entries(completeMarker()).map(([key, item]) => [key, typeof item === 'number' && key !== 'repairVersion' ? String(item) : item]));
    await repository.upsert(marker(JSON.stringify(value))); const query = vi.spyOn(repository, 'query');
    expect(await executeNetworkVolumeRepair(repository, options)).toMatchObject({ status: 'already-applied', throughBlock: 1, latestSnapshotTimestamp: 100 });
    expect(query).not.toHaveBeenCalled();
  });
  it.each(['01', '-1', '1.5', '9007199254740992', null, false])('rejects a noncanonical completion coordinate %j', async throughBlock => {
    const repository = new MemoryRepository(); await repository.upsert(marker(JSON.stringify({ ...completeMarker(), throughBlock })));
    await expect(executeNetworkVolumeRepair(repository, options)).rejects.toThrow(/repair marker throughBlock/);
  });
  it('requires bounded repository queries even for a dry-run', async () => {
    const repository = new MemoryRepository(); Object.defineProperty(repository, 'query', { value: undefined });
    await expect(executeNetworkVolumeRepair(repository, options)).rejects.toThrow(/query-capable/);
  });
  it('does not treat an empty database as a successful completed repair', async () => {
    const repository = new MemoryRepository(), write = vi.spyOn(repository, 'upsert');
    await expect(executeNetworkVolumeRepair(repository, options)).rejects.toThrow(/No repairable/);
    expect(write).not.toHaveBeenCalled();
  });
  it.each([{ fees: '01' }, { fees: 2 }, { volumeUSD: '-1' }, { swaps: -1 }])('refuses malformed canonical BLOCK measures %j', async fields => {
    const repository = await fixture(); await repository.upsert(block(1, fields)); const writes = vi.spyOn(repository, 'upsertMany');
    await expect(executeNetworkVolumeRepair(repository, options)).rejects.toThrow(); expect(writes).not.toHaveBeenCalled();
  });
  it('refuses duplicate canonical block heights before writing', async () => {
    const repository = await fixture(); await repository.upsert({ ...block(1), id: 'duplicate' });
    await expect(executeNetworkVolumeRepair(repository, options)).rejects.toThrow(/Duplicate BLOCK/);
  });
  it('reports every configured progress boundary while a dry run preserves storage', async () => {
    const repository = await fixture(), events: Array<{ phase: string; rows: number }> = [];
    const before = await repository.query('networkSnapshots', { first: 100, orderBy: ['ID_ASC'] });
    expect(await executeNetworkVolumeRepair(repository, { ...options, limits: { progressEvery: 1 }, onProgress: event => events.push(event) })).toMatchObject({ status: 'dry-run', blockSnapshotsScanned: 2 });
    expect(events.some(event => event.phase === 'snapshot-inventory' && event.rows === 1)).toBe(true);
    expect(await repository.query('networkSnapshots', { first: 100, orderBy: ['ID_ASC'] })).toEqual(before);
    expect(await repository.get('updatesStreams', NETWORK_VOLUME_REPAIR_MARKER_ID)).toBeNull();
  });
});
