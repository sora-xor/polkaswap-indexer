import { describe, expect, it, vi } from 'vitest';
import { readConfig } from '../src/config.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { ChainIndexer } from '../src/worker/chain.js';
const make = (): any => new ChainIndexer(readConfig(), new MemoryRepository());
const entry = (id: number): any => [{ args: [id], toHex: () => `0x${id.toString(16).padStart(4, '0')}` }, { amount: id }];
const page = () => Array.from({ length: 256 }, (_, i) => entry(i));
const invoke = (indexer: any, kind: string, storage: any, consume = (entry: any) => entry[1]) => kind === 'retain'
  ? indexer.fetchStorageEntriesPaged(storage, storage.entriesPaged, 'fixture.storage', ['account'])
  : indexer.consumeStorageEntriesPaged(storage, 'fixture.storage', ['account'], consume);

describe.each(['retain', 'stream'])('%s historical storage page admission', kind => {
  it.each([null, {}, 'page'])('rejects a non-array result %s', async value => {
    await expect(invoke(make(), kind, { entriesPaged: async () => value })).rejects.toThrow(/non-array page/);
  });
  it('rejects a runtime page larger than the requested limit', async () => {
    await expect(invoke(make(), kind, { entriesPaged: async () => [...page(), entry(256)] })).rejects.toThrow(/257 entries for page size 256/);
  });
  it.each([[{ args: [] }], [{}, 1], [null, 1], [{ args: {} }, 1], [{ args: [] }, 1, 2]].map(value => [value]))('rejects invalid entry tuple %j', async invalid => {
    await expect(invoke(make(), kind, { entriesPaged: async () => [invalid] })).rejects.toThrow(/invalid storage entry/);
  });
  it('forwards arguments and requests an exclusive second page', async () => {
    const first = page(), second = [entry(256)]; const storage = { entriesPaged: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second) };
    const consume = vi.fn((entry: any) => entry[1]); const result = await invoke(make(), kind, storage, consume);
    expect(storage.entriesPaged.mock.calls).toEqual([[{ args: ['account'], pageSize: 256 }], [{ args: ['account'], pageSize: 256, startKey: '0x00ff' }]]);
    if (kind === 'retain') expect(result).toEqual([...first, ...second]); else expect(consume).toHaveBeenCalledTimes(257);
  });
  it('stops on an empty first page', async () => {
    const storage = { entriesPaged: vi.fn(async () => []) }; const consume = vi.fn();
    const result = await invoke(make(), kind, storage, consume);
    expect(storage.entriesPaged).toHaveBeenCalledOnce(); expect(consume).not.toHaveBeenCalled(); if (kind === 'retain') expect(result).toEqual([]);
  });
  it('rejects inclusive continuation without consuming the duplicate', async () => {
    const first = page(); const storage = { entriesPaged: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce([first.at(-1)]) };
    await expect(invoke(make(), kind, storage)).rejects.toThrow(/repeated its startKey/); expect(storage.entriesPaged).toHaveBeenCalledTimes(2);
  });
  it.each(['missing', 'throwing', 'nonhex'])('rejects a %s continuation key', async shape => {
    const rows = page(); rows[255][0] = { args: [255], ...(shape === 'missing' ? {} : { toHex: () => { if (shape === 'throwing') throw new Error('codec'); return 'bad'; } }) };
    await expect(invoke(make(), kind, { entriesPaged: async () => rows })).rejects.toThrow(/hex continuation encoding/);
  });
  it('rejects a page whose final key makes no progress even if its first key differs', async () => {
    const first = page(), second = page(); second[0] = entry(256);
    const storage = { entriesPaged: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second) };
    await expect(invoke(make(), kind, storage)).rejects.toThrow(/no continuation progress/);
  });
  it('releases the inherited budget and wakes every idle waiter on failure', async () => {
    const indexer = make(), first = vi.fn(), second = vi.fn();
    indexer.activeDerivedStorageLoadBudget = { maximumBytes: 1, retainedBytes: 0, activeLoads: 0, idleWaiters: [first, second] };
    await expect(invoke(indexer, kind, { entriesPaged: async () => [entry(1)] })).rejects.toThrow(/retained-load limit/);
    expect(indexer.activeDerivedStorageLoadBudget.activeLoads).toBe(0); expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledOnce();
    expect(indexer.activeDerivedStorageLoadBudget.idleWaiters).toEqual([]);
  });
});

describe('streaming storage conversion and defensive key fingerprints', () => {
  it.each([undefined, {}, { entriesPaged: 1 }])('requires paginated storage %j', async storage => {
    await expect(invoke(make(), 'stream', storage)).rejects.toThrow(/entriesPaged is required/);
  });
  it('charges the live codec page and converted values together', async () => {
    const indexer = make(); indexer.activeDerivedStorageLoadBudget = { maximumBytes: 2048, retainedBytes: 0, activeLoads: 0, idleWaiters: [] };
    await expect(invoke(indexer, 'stream', { entriesPaged: async () => [entry(1)] }, () => 'x'.repeat(10000))).rejects.toThrow(/while converting/);
    expect(indexer.activeDerivedStorageLoadBudget.retainedBytes).toBe(0);
  });
  it('retains compact conversions after dropping the page', async () => {
    const indexer = make(); indexer.activeDerivedStorageLoadBudget = { maximumBytes: 10000, retainedBytes: 0, activeLoads: 0, idleWaiters: [] };
    await invoke(indexer, 'stream', { entriesPaged: async () => [entry(1)] }, () => 'compact');
    expect(indexer.activeDerivedStorageLoadBudget.retainedBytes).toBeGreaterThan(0); expect(indexer.activeDerivedStorageLoadBudget.retainedBytes).toBeLessThan(1000);
  });
  it.each([
    [{ args: [1], toHex: () => '0x01' }, 'hex:0x01'],
    [{ args: [1], toHex: () => { throw new Error('hex'); }, toString: (): string => 'stable' }, 'string:stable'],
    [{ args: [1], toString: (): string => { throw new Error('string'); } }, 'args:["1"]'],
    [{ args: [{ toHex: () => '0xff' }] }, 'args:["0xff"]'],
    [{ args: [{ toHex: () => { throw new Error('hex'); }, toString: (): string => 'key' }] }, 'args:["key"]'],
    [{ args: [{ toString: (): string => { throw new Error('string'); } }] }, 'args:["[unrenderable]"]'],
    [{ args: null }, null],
  ])('forms a stable defensive fingerprint %#', (key, expected) => expect(make().storageEntryKeyFingerprint(key)).toBe(expected));
});

describe('order and vault runtime event projection', () => {
  const SCALE = 10n ** 18n;
  it.each(['LimitOrderPlaced', 'LimitOrderUpdated', 'LimitOrderFilled', 'LimitOrderCanceled'])('preserves status and fallback fields for %s', method => {
    const records = make().createOrderBookEventDocuments(method, { arg0: '0-base-quote', arg1: 7, arg2: 'Sell', arg3: String(2n * SCALE), arg4: String(3n * SCALE) }, 42, 100, 'alice', new Map([['base', 5n * SCALE]]), new Map());
    expect(records).toHaveLength(1); expect(records[0].data).toMatchObject({ id: '0-base-quote-7', accountId: 'alice', amount: '2', price: '3', amountUSD: '10', isBuy: false, amountFilled: '0', lifetime: 0, expiresAt: 0, status: method === 'LimitOrderFilled' ? 'Filled' : method === 'LimitOrderCanceled' ? 'Canceled' : 'Active' });
  });
  it('does not create an order for unrelated events or incomplete books', () => {
    expect(make().createOrderBookEventDocuments('Other', { arg0: '0-base-quote' }, 1, 2, 'alice')).toEqual([]);
    expect(make().createOrderBookEventDocuments('LimitOrderPlaced', { arg0: '0-base-' }, 1, 2, 'alice')).toEqual([]);
  });
  it('uses the declared owner and defaults absent order amounts to zero', () => {
    const [record] = make().createOrderBookEventDocuments('LimitOrderPlaced', { orderBookId: '0-base-quote', owner: 'bob' }, 1, 2, 'alice');
    expect(record.data).toMatchObject({ accountId: 'bob', orderId: 0, amount: '0', price: '0', amountUSD: '0', isBuy: true });
  });
  it.each(['CDPCreated', 'CDPClosed', 'CollateralDeposit', 'DebtIncreased', 'DebtPayment', 'Liquidated', 'CustomEvent'])('projects vault state and event type for %s', method => {
    const records = make().createVaultEventDocuments(method, { id: 'vault', collateralAmount: String(2n * SCALE), owner: 'bob', stablecoinAssetId: 'USD' }, 42, 100, 'alice');
    expect(records).toHaveLength(2); expect(records[0].data.amount).toBe('2');
    expect(records[1].data).toMatchObject({ ownerId: 'bob', debtAssetId: 'USD', status: method === 'CDPClosed' ? 'Closed' : method === 'Liquidated' ? 'Liquidated' : 'Opened', collateralAmountReturned: ['CDPClosed', 'Liquidated'].includes(method) ? '2' : '0' });
  });
  it('accepts legacy positional vault identifiers and defaults missing amounts', () => {
    expect(make().createVaultEventDocuments('CustomEvent', { arg0: 'v' }, 1, 2, 'alice')[1].data).toMatchObject({ id: 'v', ownerId: 'alice' });
    expect(make().createVaultEventDocuments('CustomEvent', { cdpId: 'v', debt: String(SCALE) }, 1, 2, 'alice')[0].data).toMatchObject({ amount: '1', type: 'CustomEvent' });
    expect(make().createVaultEventDocuments('CustomEvent', {}, 1, 2, 'alice')).toEqual([]);
  });
});
