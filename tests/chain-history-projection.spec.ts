import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/config.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { ChainIndexer } from '../src/worker/chain.js';
import { SORA_MAINNET_GENESIS_HASH } from '../src/soraIdentity.js';
const SCALE = 10n ** 18n;
const XOR = '0x0200000000000000000000000000000000000000000000000000000000000000';
const QUOTE = '0x02000c0000000000000000000000000000000000000000000000000000000000';
const raw = String(2n * SCALE);
const event = (section: string, method: string, data: Record<string, unknown>) => ({
  phase: { isApplyExtrinsic: true, asApplyExtrinsic: { toNumber: () => 0 } },
  event: { section, method, data: { toArray: () => Object.values(data).map(value => ({ toJSON: () => value, toString: () => String(value ?? '') })) },
    meta: { fields: Object.keys(data).map(name => ({ name: { isSome: true, unwrap: () => ({ toString: () => name }) } })) } },
});
async function project(module: string, method: string, args: Record<string, unknown> = {}, events: any[] = []) {
  const repository = new MemoryRepository(); const indexer: any = new ChainIndexer(readConfig(), repository);
  indexer.observedGenesisHash = SORA_MAINNET_GENESIS_HASH;
  indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
  indexer.prices = new Map([[XOR, 3n * SCALE]]);
  const hash = '0x' + 'a'.repeat(64), tx = '0x' + 'b'.repeat(64);
  await indexer.indexFetchedBlock({ requestedHash: hash, timestamp: 1700000000, events, signedBlock: { block: {
    header: { number: { toNumber: () => 42 }, hash: { toString: () => hash } },
    extrinsics: [{ isSigned: true, signer: { toString: () => 'alice' }, hash: { toString: () => tx }, method: {
      section: module, method, args: Object.values(args), meta: { args: Object.keys(args).map(name => ({ name })) },
    } }],
  } } }, { refreshDerivedState: false });
  return (await repository.get('historyElements', tx))!.data;
}

describe('utility call codec compatibility', () => {
  const call = { module: 'assets', method: 'transfer', args: { to: 'bob', amount: '1' } };
  it.each([
    ['array', [call]],
    ['codec collection', { forEach: (visit: (value: unknown) => void) => visit(call) }],
    ['iterable', new Set([call])],
    ['JSON collection', { toJSON: () => [call] }],
  ])('retains nested metadata from a %s', async (_name, calls) => {
    const history = await project('utility', 'batch', { calls });
    expect(history.calls).toEqual([{ module: 'assets', method: 'transfer', data: { args: { to: 'bob', amount: '1' } } }]);
  });
  it.each([undefined, null, {}, { toJSON: () => 'unavailable' }])('does not invent nested calls from %s', async calls => {
    expect((await project('utility', 'batch', { calls })).calls).toEqual([]);
  });
  it.each([
    [null, '', ''], [4, '', ''], ['opaque', '', ''], [{}, '', ''],
    [{ section: 'assets' }, 'assets', ''], [{ module: 'tokens', method: 'transfer' }, 'tokens', 'transfer'],
    [{ call: 'assets.transfer' }, 'assets', 'transfer'], [{ call: 'assets' }, 'assets', ''],
    [{ toJSON: () => ({ module: 'tokens', method: 'transfer' }) }, 'tokens', 'transfer'],
    [{ toJSON: () => ({ section: 'assets', method: 'burn' }) }, 'assets', 'burn'],
    [{ toJSON: () => null }, '', ''],
  ])('projects nested call %j without losing module or method', async (nested, module, method) => {
    expect((await project('utility', 'batch', { calls: [nested] })).calls).toEqual([{ module, method, data: { args: {} } }]);
  });
});

describe('persisted staking history projections', () => {
  it.each([
    ['bond', { value: raw, controller: 'bob', payee: { Account: 'bob' } }, { amount: '2', amountUSD: '6', controller: 'bob', payee: { Account: 'bob' } }],
    ['bond', {}, { amount: '0', controller: '', payee: {} }],
    ['bondExtra', { maxAdditional: raw }, { amount: '2', amountUSD: '6' }],
    ['unbond', { amount: raw }, { amount: '2', amountUSD: '6' }],
    ['rebond', { value: raw }, { value: '2', amountUSD: '6' }],
    ['nominate', { targets: ['bob', 'carol'] }, { targets: ['bob', 'carol'] }],
    ['nominate', {}, { targets: [] }],
    ['withdrawUnbonded', { numSlashingSpans: 3 }, { amount: '0', numSlashingSpans: 3 }],
    ['withdrawUnbonded', {}, { amount: '0', numSlashingSpans: 0 }],
    ['setPayee', { payee: 'Staked' }, { payee: 'Staked', payeeType: 'Staked' }],
    ['setPayee', { payee: null }, { payee: '', payeeType: null }],
    ['setController', { controller: 'bob' }, { controller: 'bob' }],
    ['payoutStakers', { validatorStash: 'bob', era: 42 }, { validatorStash: 'bob', era: 42 }],
    ['payoutStakers', {}, { validatorStash: '', era: 0 }],
    ['chill', {}, {}],
  ] as const)('stores normalized %s call data', async (method, args, expected) => {
    expect((await project('staking', method, args)).data).toMatchObject(expected);
  });
});

describe('asset and liquidity history projections', () => {
  it.each(['mint', 'burn'])('preserves %s destination when supplied and exact amounts', async method => {
    expect((await project('assets', method, { assetId: XOR, amount: raw, to: 'bob' })).data).toMatchObject({ amount: '2', amountUSD: '6', to: 'bob' });
    expect((await project('assets', method, { assetId: QUOTE, amount: raw })).data).toMatchObject({ amount: '2', amountUSD: '0' });
  });
  it('uses a registered asset event when available and call data otherwise', async () => {
    expect((await project('assets', 'register', { assetId: QUOTE }, [event('assets', 'AssetRegistered', { assetId: XOR })])).data).toEqual({ assetId: XOR });
    expect((await project('assets', 'register', { assetId: QUOTE })).data).toEqual({ assetId: QUOTE });
    expect((await project('assets', 'register')).data).toEqual({ assetId: '' });
  });
  it.each([
    ['depositLiquidity', 'baseAssetId', 'targetAssetId', 'baseAssetAmount', 'targetAssetAmount'],
    ['withdrawLiquidity', 'inputAssetA', 'inputAssetB', 'baseAssetDesired', 'targetAssetDesired'],
    ['depositLiquidity', 'assetA', 'assetB', 'inputADesired', 'inputBDesired'],
    ['withdrawLiquidity', 'baseAssetId', 'targetAssetId', 'amountA', 'amountB'],
  ])('normalizes %s argument aliases %s/%s', async (method, baseId, quoteId, baseAmount, quoteAmount) => {
    const history = await project('poolXYK', method, { [baseId]: XOR, [quoteId]: QUOTE, [baseAmount]: raw, [quoteAmount]: raw });
    expect(history.data).toMatchObject({ baseAssetId: XOR, targetAssetId: QUOTE, baseAssetAmount: '2', targetAssetAmount: '2', baseAssetAmountUSD: '6', targetAssetAmountUSD: '0', type: method === 'depositLiquidity' ? 'Deposit' : 'Withdraw' });
  });
  it('keeps absent legacy pool amounts and assets explicit', async () => {
    expect((await project('poolXYK', 'depositLiquidity')).data).toMatchObject({ baseAssetId: '', targetAssetId: '', baseAssetAmount: '0', targetAssetAmount: '0' });
  });
  it('uses executed exchange amounts over declared swap limits', async () => {
    const history = await project('liquidityProxy', 'swapTransfer', { inputAssetId: XOR, outputAssetId: QUOTE, receiver: 'bob', selectedSourceType: 'OrderBook', swapAmount: { WithDesiredInput: { desiredAmountIn: '999' } } },
      [event('liquidityProxy', 'Exchange', { inputAssetId: XOR, outputAssetId: QUOTE, inputAmount: raw, outputAmount: String(4n * SCALE) })]);
    expect(history.data).toMatchObject({ baseAssetAmount: '2', targetAssetAmount: '4', selectedMarket: 'OrderBook', to: 'bob' });
  });
  it('keeps an exchange without call asset metadata bound to event assets', async () => {
    expect((await project('liquidityProxy', 'swap', {}, [event('liquidityProxy', 'Exchange', { arg2: XOR, arg3: QUOTE, arg4: raw, arg5: raw })])).data).toMatchObject({ baseAssetId: XOR, targetAssetId: QUOTE, baseAssetAmount: '2', targetAssetAmount: '2', selectedMarket: 'PoolXYK' });
    expect((await project('liquidityProxy', 'swap')).data).toMatchObject({ baseAssetId: '', targetAssetId: '', baseAssetAmount: '0', targetAssetAmount: '0' });
  });
});

describe('bridge and vault history projections', () => {
  it.each(['value', 'amount'])('preserves direct bridge mint parties and %s precision', async key => {
    expect((await project('bridgeProxy', 'mint', { assetId: XOR, [key]: raw, recipient: 'bob', sender: 'external', networkId: { EVM: '0x1' } })).data).toMatchObject({ assetId: XOR, amount: '2', amountUSD: '6', recipient: 'bob', sender: 'external' });
    expect((await project('bridgeProxy', 'mint', { assetId: QUOTE })).data).toMatchObject({ amount: '0', amountUSD: '0' });
  });
  it('retains outgoing bridge destination aliases even without a status event', async () => {
    expect((await project('ethBridge', 'transferToSidechain', { assetId: XOR, amount: raw, sidechainAddress: 'external' })).data).toMatchObject({ amount: '2', sidechainAddress: 'external' });
    expect((await project('bridgeProxy', 'burn', { assetId: XOR, value: raw, dest: 'external', network: { Sub: 'Liberland' } })).data).toMatchObject({ amount: '2', recipient: 'external' });
  });
  it.each([
    ['assets', 'Transfer', { assetId: XOR, from: 'bridge', to: 'bob', amount: raw }],
    ['assets', 'Issued', { assetId: XOR, owner: 'bob', amount: raw }],
    ['assets', 'Minted', { currencyId: XOR, who: 'bob', arg2: raw }],
    ['tokens', 'Transfer', { currencyId: XOR, source: 'bridge', dest: 'bob', arg3: raw }],
    ['tokens', 'Deposited', { assetId: XOR, account: 'bob', amount: raw }],
    ['tokens', 'Endowed', { arg0: XOR, arg1: 'bob', arg2: raw }],
    ['balances', 'Transfer', { arg0: 'bridge', arg1: 'bob', arg2: raw }],
    ['balances', 'Deposited', { who: 'bob', amount: raw }],
    ['balances', 'Endowed', { arg0: 'bob', arg1: raw }],
  ] as const)('identifies inbound bridge movements from %s.%s', async (section, method, data) => {
    const history = await project('bridgeMultisig', 'approve', { note: 'request' }, [event(section, method, data)]);
    expect(history.data).toMatchObject({ amount: '2', amountUSD: '6', to: 'bob', assetId: XOR }); expect(history.dataTo).toBe('bob');
  });
  it('ignores irrelevant or zero movements without fabricating an inbound transfer', async () => {
    const history = await project('bridgeMultisig', 'approve', { note: 'request' }, [event('assets', 'Unknown', {}), event('tokens', 'Unknown', {}), event('balances', 'Unknown', {}), event('other', 'Transfer', {}), event('assets', 'Transfer', { assetId: XOR, to: 'bob', amount: '0' })]);
    expect(history.data).toEqual({ note: 'request' }); expect(history.dataTo).toBe('');
  });
  it.each(['CDPCreated', 'CDPClosed'])('uses %s event metadata for legacy vault calls', async method => {
    expect((await project('kensetsu', 'close', {}, [event('kensetsu', method, { cdpId: 7, collateralAssetId: XOR, stablecoinAssetId: QUOTE, collateralAmount: raw, debt: raw })])).data).toMatchObject({ id: '7', collateralAssetId: XOR, debtAssetId: QUOTE, collateralAmount: '2', debtAmount: '2', collateralAmountUSD: '6' });
  });
  it('uses vault call aliases and zero defaults without an event', async () => {
    expect((await project('kensetsu', 'repay', { id: 7, collateralAssetId: XOR, debtAssetId: QUOTE, amount: raw, debtAmount: raw })).data).toMatchObject({ id: '7', collateralAmount: '2', debtAmount: '2' });
    expect((await project('kensetsu', 'repay')).data).toMatchObject({ id: '', collateralAssetId: '', debtAssetId: '', collateralAmount: '0', debtAmount: '0' });
  });
});

describe('event-backed Polkamarkt history', () => {
  it.each(['buy', 'sell'])('projects %s outcome, amount and fee from the executed event', async method => {
    const history = await project('polkamarkt', method, { marketId: 42, outcome: 'Yes', collateralIn: raw }, [event('polkamarkt', 'TradeExecuted', {
      marketId: 42, trader: 'alice', side: method, outcome: 'No', collateralAmount: raw, shareAmount: String(4n * SCALE), feeAmount: String(SCALE / 10n),
    })]);
    expect(history.data).toMatchObject({ marketId: 42, side: method, outcome: 'No', collateralUsd: '2', shares: '4', price: '0.5', feeUsd: '0.1' });
  });
  it('supports positional event metadata and legacy argument fallback without inventing a fee', async () => {
    const positional = await project('polkamarkt', 'buy', { marketId: 42 }, [event('polkamarkt', 'TradeExecuted', { arg0: 42, arg1: 'alice', arg2: 'buy', arg3: 'Yes', arg4: raw, arg5: raw, arg6: '0' })]);
    expect(positional.data).toMatchObject({ marketId: 42, collateralUsd: '2', shares: '2', feeUsd: '0' });
    const legacy = await project('polkamarkt', 'sell', { arg0: 42, arg1: 'No', arg2: raw }, [event('polkamarkt', 'TradeExecuted', {})]);
    expect(legacy.data).toMatchObject({ marketId: 42, side: 'sell', outcome: 'No', collateralUsd: '2', shares: '2', feeUsd: '0' });
  });
  it('does not promote an invalid or absent trade event to executed trade metadata', async () => {
    const args = { marketId: 42, outcome: 'Yes' };
    for (const events of [[], [event('polkamarkt', 'TradeExecuted', { marketId: 'invalid' })]]) {
      const history = await project('polkamarkt', 'buy', args, events);
      expect(history.data).toMatchObject(args); expect(history.data).not.toHaveProperty('executionPrice');
    }
  });
  it.each([
    ['claim_market', 'MarketClaimed', { marketId: 42, trader: 'alice', payout: raw }, 'claim'],
    ['claimMarket', 'MarketClaimed', { arg0: 42, arg1: 'alice', arg2: raw }, 'claim'],
    ['claim_creator_fees', 'CreatorFeesClaimed', { marketId: 42, creator: 'alice', amount: raw }, 'claim_creator_fees'],
    ['claimCreatorFees', 'CreatorFeesClaimed', { arg0: 42, arg1: 'alice', arg2: raw }, 'claim_creator_fees'],
  ] as const)('projects %s payouts only from %s', async (method, eventName, data, side) => {
    expect((await project('polkamarkt', method, {}, [event('polkamarkt', eventName, data)])).data).toMatchObject({ marketId: 42, side, collateralUsd: '2' });
  });
  it.each([['claimMarket', 'MarketClaimed'], ['claimCreatorFees', 'CreatorFeesClaimed']])('uses the signed market identity when %s has no market witness', async (method, name) => {
    const history = await project('polkamarkt', method, { arg0: 42 }, [event('polkamarkt', name, {})]);
    expect(history.data).toMatchObject({ marketId: 42, collateralUsd: '0' }); expect(history.dataFrom).toBe('alice');
  });
  it.each([['claimMarket', 'MarketClaimed'], ['claimCreatorFees', 'CreatorFeesClaimed']])('keeps %s without a usable event as a raw call', async (method, name) => {
    const args = { marketId: 42 };
    for (const events of [[], [event('polkamarkt', name, { marketId: 'invalid' })]]) {
      expect((await project('polkamarkt', method, args, events)).data).toEqual(args);
    }
  });
  it('aggregates batch claim payouts and preserves the requested count', async () => {
    const history = await project('polkamarkt', 'claimMarkets', { marketIds: [42, 43, 44] }, [
      event('polkamarkt', 'MarketClaimed', { marketId: 42, trader: 'alice', payout: raw }),
      event('polkamarkt', 'MarketClaimed', { arg0: 43, arg1: 'alice', amount: raw }),
      event('polkamarkt', 'MarketClaimsBatched', { trader: 'alice', requested: 3 }),
    ]);
    expect(history.data).toMatchObject({ marketId: 42, marketIds: [42, 43], claimedMarkets: 2, requestedMarkets: 3, collateralUsd: '4', side: 'claim' });
  });
  it('uses claim count and signer when optional batch metadata is absent', async () => {
    const history = await project('polkamarkt', 'claim_markets', { marketIds: [42] }, [event('polkamarkt', 'MarketClaimed', { marketId: 42 })]);
    expect(history.data).toMatchObject({ marketIds: [42], claimedMarkets: 1, requestedMarkets: 1, collateralUsd: '0' }); expect(history.dataFrom).toBe('alice');
  });
  it('rejects conflicting batch recipients and invalid claim identities as execution evidence', async () => {
    const args = { marketIds: [42, 43] };
    for (const events of [[], [event('polkamarkt', 'MarketClaimed', { marketId: 'invalid' })],
      [event('polkamarkt', 'MarketClaimed', { marketId: 42, trader: 'alice' }), event('polkamarkt', 'MarketClaimsBatched', { trader: 'bob' })]]) {
      expect((await project('polkamarkt', 'claimMarkets', args, events)).data).toEqual(args);
    }
  });
});

describe('order book history projections', () => {
  it.each(['Buy', 'Sell'])('preserves a %s order and the assigned event order ID', async side => {
    const history = await project('orderBook', 'placeLimitOrder', { orderBookId: { dexId: 0, base: XOR, quote: QUOTE }, amount: raw, price: String(3n * SCALE), side, lifetime: 3600 },
      [event('orderBook', 'LimitOrderPlaced', { orderId: 7 })]);
    expect(history.data).toMatchObject({ dexId: 0, baseAssetId: XOR, quoteAssetId: QUOTE, orderId: 7, amount: '2', price: '3', side, lifetime: 3600, amountUSD: side === 'Buy' ? '0' : '6' });
  });
  it('uses supplied order IDs and the default side when no placement event is retained', async () => {
    expect((await project('orderBook', 'placeLimitOrder', { orderBookId: `0-${XOR}-${QUOTE}`, amount: raw, price: raw, orderId: 8 })).data).toMatchObject({ orderId: 8, side: 'Buy', lifetime: 0 });
    expect((await project('orderBook', 'placeLimitOrder', { orderBookId: `0-${XOR}-${QUOTE}`, amount: raw, price: raw }, [event('orderBook', 'LimitOrderPlaced', { side: 'Sell' })])).data).toMatchObject({ orderId: 0, side: 'Sell' });
  });
  it('projects single and batch cancellations without losing order identity', async () => {
    const orderBookId = { dexId: 1, base: XOR, quote: QUOTE };
    expect((await project('orderBook', 'cancelLimitOrder', { orderBookId, orderId: 7 })).data).toEqual([{ dexId: 1, baseAssetId: XOR, quoteAssetId: QUOTE, orderId: 7 }]);
    expect((await project('orderBook', 'cancelLimitOrdersBatch', { orderBookId, orderIds: [7, 8] })).data).toEqual([7, 8].map(orderId => ({ dexId: 1, baseAssetId: XOR, quoteAssetId: QUOTE, orderId })));
    expect((await project('orderBook', 'cancelLimitOrder', { orderBookId })).data).toEqual([{ dexId: 1, baseAssetId: XOR, quoteAssetId: QUOTE, orderId: 0 }]);
  });
});
