import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/config.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { ChainIndexer } from '../src/worker/chain.js';
const XOR = '0x0200000000000000000000000000000000000000000000000000000000000000';
const SCALE = 10n ** 18n;
const worker = (): any => new ChainIndexer(readConfig(), new MemoryRepository());

describe('asset issuance codec identity', () => {
  it.each([
    ['string', 'ASSET', 'ASSET'], ['JSON code', { code: 'ASSET' }, 'ASSET'],
    ['missing JSON code', { code: null }, ''],
    ['human code', { toJSON: () => 5, toHuman: () => ({ code: 'ASSET' }) }, 'ASSET'],
    ['missing human code', { toJSON: () => 5, toHuman: () => ({ code: null }) }, ''],
    ['serialized code', { toJSON: () => 5, toString: () => '{"code":"ASSET"}' }, 'ASSET'],
    ['empty serialized code', { toJSON: () => 5, toString: () => '{"code":null}' }, ''],
    ['plain fallback', { toJSON: () => 5, toString: () => 'ASSET' }, 'ASSET'],
    ['integer', 7, '7'], ['empty', null, ''],
    ['absent string method', Object.assign(Object.create(null), { toJSON: () => 5, [Symbol.toPrimitive]: () => 'ASSET' }), 'ASSET'],
  ])('retains the %s form separately from native XOR supply', (_name, value, id) => {
    const result: Map<string, bigint> = worker().createSupplyByAsset([[{ args: [value] }, '15']], '20');
    expect([...result]).toEqual([[id, 15n], [XOR, 20n]]);
  });
});

describe('account activity point accumulation', () => {
  const apply = (module: string, method: string, data: any = {}, extra: any = {}, current: any = {}) =>
    worker().applyAccountPointUpdate(current, { module, method, data, fee: 0n, failed: false, ...extra }, new Map([[XOR, 3n * SCALE]]));
  it('clones every nested aggregate before applying updates', () => {
    const original = { xorFees: { amount: '1', amountUSD: '3' }, governance: { votes: 4, amount: '2', amountUSD: '6' } };
    const result = apply('democracy', 'vote', { amount: '3', amountUSD: '9' }, { fee: SCALE }, original);
    expect(result.xorFees).toMatchObject({ amount: '2', amountUSD: '6' });
    expect(result.governance).toMatchObject({ votes: 5, amount: '5', amountUSD: '15' });
    expect(original).toEqual({ xorFees: { amount: '1', amountUSD: '3' }, governance: { votes: 4, amount: '2', amountUSD: '6' } });
  });
  it('charges a failed transaction fee without counting its requested burn', () => {
    const result = apply('assets', 'burn', { assetId: XOR, amount: '2', amountUSD: '6' }, { fee: SCALE, failed: true });
    expect(result.xorFees).toMatchObject({ amount: '1', amountUSD: '3' }); expect(result.xorBurned).toMatchObject({ amount: '0', amountUSD: '0' });
  });
  it('counts XOR burns while leaving another asset out of XOR totals', () => {
    expect(apply('assets', 'burn', { assetId: XOR, amount: '2', amountUSD: '6' }).xorBurned).toMatchObject({ amount: '2', amountUSD: '6' });
    expect(apply('assets', 'burn', { assetId: 'OTHER', amount: '2' }).xorBurned.amount).toBe('0');
    expect(apply('assets', 'burn').xorBurned.amount).toBe('0');
  });
  it.each([
    ['placeLimitOrder', { amountUSD: '5' }, 'created', 1, '5'],
    ['cancelLimitOrder', {}, 'closed', 1, '0'],
    ['cancelLimitOrdersBatch', [{}, {}, {}], 'closed', 3, '0'],
  ])('counts order book %s activity', (method, data, field, count, usd) => {
    expect(apply('orderBook', method as string, data).orderBook).toMatchObject({ [field as string]: count, amountUSD: usd });
  });
  it.each([
    ['createVault', { collateralAmountUSD: '5' }, 'created', '5'],
    ['closeVault', { debtAmountUSD: '2' }, 'closed', '2'],
    ['liquidate', {}, 'closed', '0'],
  ])('counts vault %s activity', (method, data, field, usd) => {
    expect(apply('kensetsu', method as string, data).vault).toMatchObject({ [field as string]: 1, amountUSD: usd });
  });
  it.each([
    ['ethBridge', 'transferToSidechain', 'outgoingUSD'], ['bridgeProxy', 'burn', 'outgoingUSD'],
    ['bridgeProxy', 'mint', 'incomingUSD'], ['bridgeMultisig', 'approveRequest', 'incomingUSD'],
  ])('accumulates %s %s in the correct bridge direction', (module, method, field) => {
    expect(apply(module, method, { amountUSD: '2' }).deposit[field]).toBe('2');
  });
  it('accepts legacy vote balances and missing optional totals', () => {
    const result = apply('governance', 'Vote', { balance: '7' }, {}, { governance: { votes: null, amount: null, amountUSD: null } });
    expect(result.governance).toEqual({ votes: 1, amount: '7', amountUSD: '0' });
  });
  it('returns initialized independent aggregates when no update exists', () => {
    const result = worker().applyAccountPointUpdate({});
    expect(result).toMatchObject({ xorFees: { amount: '0' }, orderBook: { created: 0, closed: 0 }, deposit: { incomingUSD: '0', outgoingUSD: '0' } });
  });
  it('uses zero for null legacy aggregate fields without modifying the source', () => {
    const current = { xorFees: { amount: null, amountUSD: null }, orderBook: { created: null, amountUSD: null }, deposit: { incomingUSD: null } };
    expect(apply('orderBook', 'placeLimitOrder', null, { fee: SCALE }, current)).toMatchObject({ xorFees: { amount: '1', amountUSD: '3' }, orderBook: { created: 1, amountUSD: '0' } });
    expect(apply('bridgeProxy', 'mint', { amountUSD: '2' }, {}, current).deposit.incomingUSD).toBe('2');
  });
});
