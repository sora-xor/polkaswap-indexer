import { describe, expect, it, vi } from 'vitest';
import { readConfig } from '../src/config.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { ChainIndexer } from '../src/worker/chain.js';
import { HISTORICAL_DENOMINATOR_KEY } from '../src/worker/denomination.js';
import { HOURLY_HISTORY_ASSETS, HOURLY_HISTORY_GENESIS } from '../src/worker/hourly-history.js';

/** Runs the actual hourly close path with only the pinned chain reads replaced. */
function fixture() {
  const repository = new MemoryRepository();
  const worker = new ChainIndexer(readConfig(), repository) as any;
  const before = { height: 90, timestamp: 7199,
    hash: '0xa07c08f83b432f84a3e98746bd7d0844bd5ea9eb328f989a7cb814951cdd2a1f' };
  const raw = vi.fn(async (): Promise<unknown> => null);
  const query: Record<string, unknown> = {
    assets: { assetInfos: { entriesPaged: async () => [[{ args: [HOURLY_HISTORY_ASSETS[0]!.id] }, ['XOR', 'SORA Nexus', 18, true]]] } },
    poolXYK: { reserves: { entriesPaged: async () => [] } },
  };
  const context = { query, runtimeVersion: { specName: 'sora-substrate', specVersion: 1 },
    registry: { metadata: { pallets: ['System', 'Timestamp', 'Assets', 'PoolXYK'].map(name => ({ name })) } } };
  worker.api = { genesisHash: { toString: () => HOURLY_HISTORY_GENESIS } };
  worker.observedGenesisHash = HOURLY_HISTORY_GENESIS;
  worker.previousHourlyHistoryBlock = before;
  worker.getBlockDataApi = vi.fn(async () => ({ rpc: { state: { getStorage: { raw } } } }));
  worker.getHistoricalValuationQueryAt = vi.fn(async (_height, _hash, _observeHash, observeContext) => {
    observeContext(context); return query;
  });
  const state = { blockHeight: before.height, assets: new Map(), pools: new Map() };
  const signedBlock = { block: { header: { number: { toNumber: () => 91 },
    parentHash: { toString: () => before.hash }, hash: { toString: () => `0x${'2'.repeat(64)}` } } } };
  const close = () => worker.prepareAssetHourlyCloseDocuments(signedBlock, 7200, state);
  return { worker, repository, before, query, context, raw, close };
}

describe('hourly original-unit denomination', () => {
  it('records one after metadata absence and a pinned raw-key absence check', async () => {
    const test = fixture(); const result = await test.close();
    expect(result.documents.filter((row: { collection: string }) => row.collection === 'assetSnapshots'))
      .toEqual(expect.arrayContaining([expect.objectContaining({ data: expect.objectContaining({ denominator: '1' }) })]));
    expect(test.raw).toHaveBeenCalledExactlyOnceWith(HISTORICAL_DENOMINATOR_KEY, test.before.hash);
    expect(test.worker.getHistoricalValuationQueryAt).toHaveBeenCalledWith(90, test.before.hash, undefined, expect.any(Function));
  });
  it('retains a readable historical coefficient without invoking the original-unit exception', async () => {
    const test = fixture();
    test.query.denomination = { denominator: async () => ({ toString: () => '100' }) };
    const result = await test.close();
    expect(result.documents[0].data.denominator).toBe('100'); expect(test.raw).not.toHaveBeenCalled();
  });
  it.each(['declared', 'malformed', 'pruned', 'missing-context', 'wrong-context', 'late-runtime'])('rejects %s evidence', async mode => {
    const test = fixture();
    if (mode === 'declared') test.context.registry.metadata.pallets.push({ name: 'Denomination' });
    if (mode === 'malformed') test.query.denomination = {};
    if (mode === 'pruned') test.query.denomination = { denominator: async () => { throw new Error('pruned'); } };
    if (mode === 'missing-context') test.worker.getHistoricalValuationQueryAt = vi.fn(async () => test.query);
    if (mode === 'wrong-context') test.context.query = { ...test.query };
    if (mode === 'late-runtime') test.context.runtimeVersion.specVersion = 134;
    await expect(test.close()).rejects.toThrow('Hourly history requires the exact historical denomination');
    expect(test.raw).not.toHaveBeenCalled();
    expect(await test.repository.list('assetSnapshots')).toEqual([]);
  });
  it('rejects a present raw denominator rather than guessing its meaning from an absent pallet', async () => {
    const test = fixture(); test.raw.mockResolvedValue('0x01000000000000000000000000000000');
    await expect(test.close()).rejects.toThrow('Hourly history requires the exact historical denomination');
  });
  it('fails closed if the historical raw key cannot be read', async () => {
    const test = fixture(); test.raw.mockRejectedValue(new Error('historical state unavailable'));
    await expect(test.close()).rejects.toThrow('historical state unavailable');
  });
});

describe('historical denomination query provenance', () => {
  it.each([true, false])('observes the exact api.at context only after both hashes agree: %s', async agree => {
    const worker = new ChainIndexer(readConfig(), new MemoryRepository()) as any;
    const hash = '0xa07c08f83b432f84a3e98746bd7d0844bd5ea9eb328f989a7cb814951cdd2a1f';
    const context = { query: {}, registry: { metadata: { pallets: [] } }, runtimeVersion: {} };
    const archive = { rpc: { chain: { getBlockHash: vi.fn(async () => hash) } }, at: vi.fn(async () => context) };
    worker.api = { rpc: { chain: { getBlockHash: vi.fn(async () => agree ? hash : `0x${'3'.repeat(64)}`) } } };
    worker.getBlockDataApi = vi.fn(async () => archive);
    const observe = vi.fn();
    const call = worker.getHistoricalValuationQueryAt(90, hash, undefined, observe);
    if (agree) {
      expect(await call).toBe(context.query);
      expect(archive.at).toHaveBeenCalledWith(hash);
      expect(observe).toHaveBeenCalledExactlyOnceWith(context);
    } else {
      await expect(call).rejects.toThrow('historical baseline does not match the verified parent hash');
      expect(archive.at).not.toHaveBeenCalled(); expect(observe).not.toHaveBeenCalled();
    }
  });
});
