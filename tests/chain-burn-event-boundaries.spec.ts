import { afterEach, describe, expect, it, vi } from 'vitest';
import { readConfig } from '../src/config.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { ChainIndexer } from '../src/worker/chain.js';
const START = 25_043_003;
const XOR = '0x0200000000000000000000000000000000000000000000000000000000000000';
const amount = '2000000000000000000';
const burn = (values: unknown[], index: number | null = 0): any => ({
  phase: index === null ? { isApplyExtrinsic: false } : { isApplyExtrinsic: true, asApplyExtrinsic: { toNumber: () => index } },
  event: { section: 'assets', method: 'Burn', data: { toArray: () => values } },
});
const call = (section = 'assets', method = 'burn', args: any[] = []): any => ({ hash: { toString: () => 'tx' }, method: { section, method, args } });
async function backfill(events: any[], extrinsics: any[] = [call()]) {
  const repository = new MemoryRepository(), worker: any = new ChainIndexer(readConfig(), repository);
  worker.api = {}; const fetch = vi.spyOn(worker, 'fetchBlockByNumber').mockResolvedValue({ requestedHash: 'hash', timestamp: 100, events, signedBlock: { block: { extrinsics } } });
  await worker.backfillXorBurns(START);
  return { rows: await repository.list('xorBurns'), worker, fetch, repository };
}
afterEach(() => vi.restoreAllMocks());

describe('historical XOR burn event evidence', () => {
  it.each([['alice', XOR, amount], [XOR, 'alice', amount]])('accepts both historical event argument orders %#', async (...values) => {
    const { rows } = await backfill([burn(values)]);
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ id: 'tx', timestamp: null, data: { address: 'alice', amount: '2', assetId: XOR, txHash: 'tx', extrinsicIndex: 0 } });
    expect(rows[0].data).not.toHaveProperty('timestamp');
  });
  it('does not collide when multiple burns belong to one extrinsic', async () => {
    const { rows } = await backfill([burn(['alice', XOR, amount]), burn(['bob', XOR, amount])]);
    expect(rows.map(row => [row.id, row.data.address])).toEqual([['tx', 'alice'], ['tx-1', 'bob']]);
  });
  it.each([null, NaN, 3])('retains a burn without inventing an extrinsic hash for index %s', async index => {
    const { rows } = await backfill([burn(['alice', XOR, amount], index)], []);
    expect(rows[0].id).toBe(`${START}-${index === 3 ? '3' : 'event'}`); expect(rows[0].data).not.toHaveProperty('txHash');
    if (index === 3) expect(rows[0].data.extrinsicIndex).toBe(3); else expect(rows[0].data).not.toHaveProperty('extrinsicIndex');
  });
  it('uses a stable block/index identity when a legacy extrinsic has no hash method', async () => {
    const { rows } = await backfill([burn(['alice', XOR, amount])], [{ method: { section: 'assets', method: 'burn' } }]);
    expect(rows[0].id).toBe(`${START}-0`); expect(rows[0].data).not.toHaveProperty('txHash');
  });
  it('ignores unrelated or incomplete burn events while retaining valid evidence', async () => {
    const events = [burn([]), burn(['alice']), burn(['alice', XOR]), burn(['alice', 'OTHER', amount]),
      { event: { section: 'other', method: 'Burn', data: {} } }, { event: { section: 'assets', method: 'Mint', data: {} } },
      { event: { section: 'assets', method: 'Burn', data: {} } }, burn(['alice', XOR, amount])];
    const { rows } = await backfill(events); expect(rows).toHaveLength(1); expect(rows[0].data.address).toBe('alice');
  });
  it('accepts an address codec through its JSON fallback', async () => {
    const address = { toString: undefined, toJSON: () => 'alice', [Symbol.toPrimitive]: () => 'alice' };
    const { rows } = await backfill([burn([address, XOR, amount])]); expect(rows[0].data.address).toBe('alice');
  });
  it.each([
    [], [{ module: 'assets', method: 'burn', args: { assetId: XOR } }],
    [{ module: 'tokens', method: 'burn', args: { assetId: XOR } }, { module: 'system', method: 'remark', args: {} }],
    [{ module: 'assets', method: 'burn', args: { assetId: XOR } }, { module: 'other', method: 'remark', args: {} }],
    [{ module: 'assets', method: 'burn', args: { assetId: XOR } }, { module: 'system', method: 'other', args: {} }],
    [{ module: 'assets', method: 'burn', args: { assetId: XOR } }, { module: 'system', method: 'remark', args: { arg0: 'invalid' } }],
  ].map(calls => [calls]))('does not infer a Nexus recipient from a nonmatching batch %#', async calls => {
    const { rows } = await backfill([burn(['alice', XOR, amount])], [call('utility', 'batchAll', [calls])]);
    expect(rows[0].data).not.toHaveProperty('nexusRecipient'); expect(rows[0].data).not.toHaveProperty('campaign');
  });
  it('stops at the persisted backfill checkpoint without fetching the same block twice', async () => {
    const { worker, fetch } = await backfill([burn(['alice', XOR, amount])]);
    await worker.backfillXorBurns(START); expect(fetch).toHaveBeenCalledOnce();
  });
  it('propagates an unknown fetch failure without advancing its checkpoint', async () => {
    const repository = new MemoryRepository(), worker: any = new ChainIndexer(readConfig(), repository); worker.api = {};
    vi.spyOn(worker, 'fetchBlockByNumber').mockRejectedValue(new Error('transport failed'));
    await expect(worker.backfillXorBurns(START)).rejects.toThrow(/transport failed/); expect(await repository.list('updatesStreams')).toEqual([]);
  });
});
