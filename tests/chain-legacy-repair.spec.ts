import { afterEach, describe, expect, it, vi } from 'vitest';
import { readConfig } from '../src/config.js';
import { MemoryRepository } from '../src/repository/memory.js';
import type { IndexerDocument } from '../src/repository/types.js';
import { ChainIndexer } from '../src/worker/chain.js';
const XOR = '0x0200000000000000000000000000000000000000000000000000000000000000';
const zero = { transactions: 0, swaps: 0, bridgeIncomingTransactions: 0, bridgeOutgoingTransactions: 0 };
const fixture = () => { const repository = new MemoryRepository(); const indexer: any = new ChainIndexer({ ...readConfig(), snapshotRetentionMode: 'all' }, repository); return { repository, indexer }; };
const history = (data: Record<string, unknown> = {}, coordinates: Partial<IndexerDocument> = {}): IndexerDocument => ({ collection: 'historyElements', id: 'tx', blockHeight: 1, timestamp: 3600, data, ...coordinates });
const block = (height: number, timestamp: number, data: Record<string, unknown> = {}): IndexerDocument => ({ collection: 'networkSnapshots', id: `block-${height}`, blockHeight: height, timestamp, data: { type: 'BLOCK', timestamp, ...data } });
afterEach(() => vi.restoreAllMocks());

describe('legacy history transaction accounting', () => {
  it.each([0, -1, 'invalid', Infinity, NaN])('does not invent a block for invalid history height %s', height => {
    const { indexer } = fixture(); expect(indexer.networkTransactionCountersFromHistory(history({}, { blockHeight: height as number }))).toBeNull();
  });
  it('accepts legacy data coordinates and defaults absent business fields to zero', () => {
    const { indexer } = fixture();
    expect(indexer.networkTransactionCountersFromHistory(history({ blockHeight: '42' }, { blockHeight: null }))).toEqual({ blockHeight: 42, counters: zero });
    expect(indexer.networkTransactionCountersFromHistory(history({}, { blockHeight: undefined }))).toBeNull();
  });
  it.each([
    ['liquidityProxy', 'swap', 'tx', { transactions: 1, swaps: 1 }],
    ['liquidityProxy', 'swapTransfer', 'tx', { transactions: 1, swaps: 1 }],
    ['liquidityProxy', 'swapTransferBatch', 'tx', { transactions: 1, swaps: 1 }],
    ['liquidityProxy', 'other', 'tx', { transactions: 1 }],
    ['ethBridge', 'transferToSidechain', 'tx', { transactions: 1, bridgeOutgoingTransactions: 1 }],
    ['bridgeProxy', 'burn', 'tx', { transactions: 1, bridgeOutgoingTransactions: 1 }],
    ['bridgeMultisig', 'approve', 'tx', { transactions: 1, bridgeIncomingTransactions: 1 }],
    ['bridgeProxy', 'mint', 'tx-mint', { bridgeIncomingTransactions: 1 }],
    ['bridgeProxy', 'mint', 'tx', { transactions: 1 }],
  ])('classifies successful %s.%s history %s', (module, method, id, expected) => {
    const { indexer } = fixture();
    expect(indexer.networkTransactionCountersFromHistory(history({ module, method, id, networkFee: '10', execution: { success: true } })).counters).toEqual({ ...zero, ...expected });
  });
  it.each([undefined, null, 'legacy', {}, { success: true }])('keeps legacy successful execution representation %j', execution => {
    const { indexer } = fixture();
    expect(indexer.networkTransactionCountersFromHistory(history({ module: 'utility', method: 'batch', networkFee: '0', callNames: ['other.swap', 'liquidityProxy', 'liquidityProxy.swap'], execution })).counters).toEqual({ ...zero, swaps: 1 });
  });
  it('charges failed paid calls but excludes their business activity', () => {
    const { indexer } = fixture();
    expect(indexer.networkTransactionCountersFromHistory(history({ module: 'bridgeProxy', method: 'burn', networkFee: '20', execution: { success: false }, callNames: ['liquidityProxy.swap'] })).counters).toEqual({ ...zero, transactions: 1 });
  });
  it.each(Object.keys(zero))('detects and corrects changed %s while preserving stock fields', key => {
    const { indexer } = fixture(); const document = block(1, 10, { ...zero, liquidityUSD: '123', [key]: 9 });
    expect(indexer.networkTransactionCountersChanged(document, zero)).toBe(true);
    const corrected = indexer.withNetworkTransactionCounters(document, zero);
    expect(corrected.data).toMatchObject({ ...zero, liquidityUSD: '123' }); expect(document.data[key]).toBe(9);
    expect(indexer.networkTransactionCountersChanged(corrected, zero)).toBe(false);
    expect(indexer.networkTransactionCountersChanged(block(1, 10), zero)).toBe(false);
  });
  it('decodes aggregate input coordinates and amounts without losing integer precision', () => {
    const { indexer } = fixture();
    expect(indexer.networkBackfillBlockFromSnapshot({ collection: 'networkSnapshots', id: 'legacy', data: { timestamp: '10', blockHeight: '42', accounts: '2', transactions: '3', fees: '9007199254740993', volumeUSD: '1.25', swaps: 1, bridgeIncomingTransactions: 4, bridgeOutgoingTransactions: 5 } })).toEqual({ timestamp: 10, blockHeight: 42, accounts: 2, transactions: 3, fees: 9007199254740993n, volumeUSD: 1250000000000000000n, swaps: 1, bridgeIncomingTransactions: 4, bridgeOutgoingTransactions: 5 });
    expect(indexer.networkBackfillBlockFromSnapshot(history({}, { blockHeight: undefined }))).toMatchObject({ timestamp: 3600, blockHeight: 0, fees: 0n, volumeUSD: 0n });
    for (const value of [0, -1, 'invalid']) expect(indexer.networkBackfillBlockFromSnapshot(block(1, 10, { timestamp: value }))).toBeNull();
    expect(indexer.networkBackfillBlockFromSnapshot(block(NaN, 10))).toBeNull();
    expect(indexer.networkBackfillBlockFromSnapshot({ collection: 'networkSnapshots', id: 'empty', data: {} })).toBeNull();
  });
});

describe('network counter repair', () => {
  it('rebuilds block and existing aggregate counters while preserving stock values', async () => {
    const { indexer, repository } = fixture();
    await repository.upsertMany([
      history({ module: 'liquidityProxy', method: 'swap', networkFee: '10' }),
      history({ module: 'bridgeProxy', method: 'burn', networkFee: '20', execution: { success: false } }, { id: 'failed' }),
      history({ module: 'bridgeProxy', method: 'mint', id: 'incoming-mint', networkFee: '90' }, { id: 'incoming-mint', blockHeight: 2, timestamp: 3606 }),
      block(1, 3600, { transactions: 99, swaps: 99, liquidityUSD: '123', fees: '10' }),
      block(2, 3606, { transactions: 99, bridgeIncomingTransactions: 99, liquidityUSD: '456', fees: '20' }),
      { collection: 'networkSnapshots', id: 'network-all-HOUR-3600', blockHeight: 2, timestamp: 3606, data: { type: 'HOUR', transactions: 99, swaps: 99, bridgeIncomingTransactions: 99, liquidityUSD: '789', volumeUSD: '12.5' } },
    ]);
    expect(await indexer.repairNetworkTransactionCounters()).toBe(true);
    expect((await repository.get('networkSnapshots', 'block-1'))?.data).toMatchObject({ ...zero, transactions: 2, swaps: 1, liquidityUSD: '123', fees: '10' });
    expect((await repository.get('networkSnapshots', 'block-2'))?.data).toMatchObject({ ...zero, bridgeIncomingTransactions: 1, liquidityUSD: '456' });
    expect((await repository.get('networkSnapshots', 'network-all-HOUR-3600'))?.data).toMatchObject({ ...zero, transactions: 2, swaps: 1, bridgeIncomingTransactions: 1, liquidityUSD: '789', volumeUSD: '12.5' });
    const marker = await repository.get('updatesStreams', 'networkTransactionCounterRepair-v1');
    expect(JSON.parse(String(marker?.data.data))).toEqual({ latestBlock: 2, blockSnapshotsUpdated: 2, aggregateSnapshotsUpdated: 1 });
    expect(await indexer.repairNetworkTransactionCounters()).toBe(false);
  });
  it('records an empty repair without creating aggregates or rewriting correct snapshots', async () => {
    const { indexer, repository } = fixture(); await repository.upsertMany([block(1, 3600), block(0, 3600)]);
    const writes = vi.spyOn(repository, 'upsertMany');
    expect(await indexer.repairNetworkTransactionCounters()).toBe(false); expect(writes).not.toHaveBeenCalled();
    expect((await repository.list('networkSnapshots')).length).toBe(2);
  });
  it('does not publish completion when stopped after collecting history', async () => {
    const { indexer, repository } = fixture();
    indexer.collectNetworkTransactionCountersByBlock = async () => { indexer.lifecycleState = 'stopping'; return new Map(); };
    expect(await indexer.repairNetworkTransactionCounters()).toBe(false);
    expect(await repository.list('updatesStreams')).toEqual([]);
  });
  it('does not read data when already stopping', async () => {
    const { indexer, repository } = fixture(); indexer.lifecycleState = 'stopping'; const reads = vi.spyOn(repository, 'get');
    expect(await indexer.repairNetworkTransactionCounters()).toBe(false); expect(reads).not.toHaveBeenCalled();
  });
});

describe('native XOR supply repair', () => {
  const supply = (id: string, height: number | null, data: Record<string, unknown> = {}, collection: 'assets' | 'assetSnapshots' = 'assetSnapshots'): IndexerDocument => ({ collection, id, blockHeight: height, timestamp: 30, data: { assetId: XOR, supply: 'old', ...data } });
  it('repairs the live asset and snapshots with one RPC per historical block', async () => {
    const { indexer, repository } = fixture(); indexer.fetchNativeXorIssuanceAtBlock = vi.fn(async () => 9007199254740993n);
    await repository.upsertMany([supply(XOR, 10, {}, 'assets'), supply('hour', 10), supply('day', 11), supply('correct', 11, { supply: '9007199254740993' })]);
    expect(await indexer.repairXorSupplyDocuments()).toBe(true);
    expect(indexer.fetchNativeXorIssuanceAtBlock).toHaveBeenCalledTimes(2);
    for (const id of ['hour', 'day', 'correct']) expect((await repository.get('assetSnapshots', id))?.data.supply).toBe('9007199254740993');
    expect((await repository.get('assets', XOR))?.data.supply).toBe('9007199254740993');
    const marker = await repository.get('updatesStreams', 'xorSupplyRepair-v1');
    expect(JSON.parse(String(marker?.data.data))).toMatchObject({ processedDocuments: 4, writtenDocuments: 3, skippedDocuments: 0, lastIndexedBlock: 11, lastTimestamp: 30 });
    expect(await indexer.repairXorSupplyDocuments()).toBe(false);
  });
  it('keeps invalid-height rows unchanged and accepts legacy data coordinates', async () => {
    const { indexer, repository } = fixture(); indexer.fetchNativeXorIssuanceAtBlock = vi.fn(async () => 50n);
    await repository.upsertMany([supply(XOR, 0, {}, 'assets'), supply('legacy', null, { blockHeight: 12 })]);
    expect(await indexer.repairXorSupplyDocuments()).toBe(true);
    expect((await repository.get('assetSnapshots', 'legacy'))?.data.supply).toBe('50');
    expect((await repository.get('assets', XOR))?.data.supply).toBe('old');
    expect(JSON.parse(String((await repository.get('updatesStreams', 'xorSupplyRepair-v1'))?.data.data))).toMatchObject({ processedDocuments: 2, writtenDocuments: 1, skippedDocuments: 1 });
  });
  it.each([new Error('State already discarded'), 'unknown Block'])('leaves pruned rows retryable without a completion marker: %s', async error => {
    const { indexer, repository } = fixture(); indexer.fetchNativeXorIssuanceAtBlock = vi.fn().mockRejectedValue(error);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined); await repository.upsert(supply('pruned', 10));
    expect(await indexer.repairXorSupplyDocuments()).toBe(false);
    expect(await repository.get('updatesStreams', 'xorSupplyRepair-v1')).toBeNull();
    expect((await repository.get('assetSnapshots', 'pruned'))?.data.supply).toBe('old');
  });
  it('propagates RPC failure without claiming repair completion', async () => {
    const { indexer, repository } = fixture(); indexer.fetchNativeXorIssuanceAtBlock = vi.fn().mockRejectedValue(new Error('RPC disconnected'));
    await repository.upsert(supply('failed', 10)); await expect(indexer.repairXorSupplyDocuments()).rejects.toThrow('RPC disconnected');
    expect(await repository.get('updatesStreams', 'xorSupplyRepair-v1')).toBeNull();
  });
  it('completes an empty dataset and skips work after shutdown', async () => {
    const { indexer, repository } = fixture(); expect(await indexer.repairXorSupplyDocuments()).toBe(false);
    expect((await repository.get('updatesStreams', 'xorSupplyRepair-v1'))?.blockHeight).toBeNull();
    indexer.lifecycleState = 'stopping'; const read = vi.spyOn(repository, 'get');
    expect(await indexer.repairXorSupplyDocuments()).toBe(false); expect(read).not.toHaveBeenCalled();
  });
});
