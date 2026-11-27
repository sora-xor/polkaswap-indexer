import { describe, expect, it, vi } from 'vitest';
import { readConfig } from '../src/config.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { ChainIndexer } from '../src/worker/chain.js';
const instance = (): any => new ChainIndexer({ ...readConfig(), legacySoraBlockTypes: false, soraArchiveWsEndpoint: null }, new MemoryRepository());
const SCALE = 10n ** 18n;
const entry = (book: unknown, amount: unknown, value: unknown = null) => [{ args: [book, amount] }, value];

describe('SORA governance reference projection', () => {
  it.each([
    ['democracy', 'referendum', 'Democracy', 'Referendum', 'governanceReferendumIndex'],
    ['democracy', 'proposal', 'Democracy', 'PublicProposal', 'governanceProposalIndex'],
    ['democracy', 'public-proposal', 'Democracy', 'PublicProposal', 'governanceProposalIndex'],
    ['council', 'motion', 'Council', 'CouncilMotion', 'governanceProposalIndex'],
    ['technical-committee', 'motion', 'Technical Committee', 'TechnicalCommitteeMotion', 'governanceProposalIndex'],
    ['ceres', 'poll', 'Ceres Governance', 'CeresPoll', 'governancePollId'],
    ['ceres-governance', 'poll', 'Ceres Governance', 'CeresPoll', 'governancePollId'],
    ['ceres-governance-platform', 'poll', 'Ceres Governance', 'CeresPoll', 'governancePollId'],
    ['hermes', 'poll', 'Hermes Governance', 'HermesPoll', 'governancePollId'],
    ['hermes-governance', 'poll', 'Hermes Governance', 'HermesPoll', 'governancePollId'],
    ['hermes-governance-platform', 'poll', 'Hermes Governance', 'HermesPoll', 'governancePollId'],
  ])('projects %s %s references from both documented URI forms', (pallet, kind, body, expectedKind, field) => {
    const indexer = instance();
    for (const uri of [`sora:governance:${pallet}:${kind}:42`, ` sora://governance/${pallet}/${kind}/42 `]) {
      expect(indexer.parseSoraGovernanceReference(uri)).toMatchObject({ governanceBody: body, governanceKind: expectedKind, [field]: 42 });
    }
  });
  it.each(['council', 'technical-committee'])('preserves %s motion hashes without inventing numeric indices', pallet => {
    expect(instance().parseSoraGovernanceReference(`sora:governance:${pallet}:motion:0xaAbB`)).toMatchObject({ governanceMotionHash: '0xaAbB', governanceProposalIndex: undefined });
  });
  it.each(['', 'https://example.org', 'sora:governance:unknown:poll:1', 'sora:governance:council:poll:1',
    'sora:governance:hermes:motion:1', 'sora:governance:democracy:motion:1', 'sora:governance:technical-committee:referendum:1'])('does not invent governance metadata for %j', uri => {
    expect(instance().parseSoraGovernanceReference(uri)).toEqual({});
  });
  it.each(['0', 'text'])('does not invent a positive referendum index from %j', reference => {
    expect(instance().parseSoraGovernanceReference(`sora:governance:democracy:referendum:${reference}`)).toMatchObject({ governanceKind: 'Referendum', governanceReferendumIndex: undefined });
  });
  it.each([
    [null, null, null], ['Oracle. ', null, 'Resolved by Oracle.'], [null, 'Source.  ', 'Resolution source: Source.'],
    ['Oracle...', 'Source.', 'Resolved by Oracle. Resolution source: Source.'],
  ])('forms a readable market description from oracle and resolution witnesses', (oracle, source, expected) => {
    expect(instance().createPolkamarktMarketDescription(oracle, source)).toBe(expected);
  });
});

describe('order book authoritative storage projection', () => {
  it('finds best bid and ask regardless of storage ordering and keeps markets separate', () => {
    const result = instance().extractOrderBookPriceLevels(
      [entry('0-base-quote', 10), entry('0-base-quote', 20), entry('0-base-quote', 15), entry({ dexId: 1, base: 'b', quote: 'q' }, 8)],
      [entry('0-base-quote', 30), entry('0-base-quote', 25), entry('0-base-quote', 40), entry('2-b-q', 9)]
    );
    expect([...result]).toEqual([['0-base-quote', { bestBid: 20n, bestAsk: 25n }], ['1-b-q', { bestBid: 8n }], ['2-b-q', { bestAsk: 9n }]]);
    expect(instance().extractOrderBookPriceLevels([], []).size).toBe(0);
  });
  it('adds buy quote reserves and sell base reserves at each assets own precision', () => {
    const analytics = { orderBookActiveReserves: new Map(), assetOrderBookLiquidity: new Map() };
    const assets = new Map([['base', { decimals: 6 }], ['quote', { decimals: 8 }]]);
    const prices = new Map([['base', 5n * SCALE], ['quote', 2n * SCALE]]);
    instance().mergeLimitOrderStorage([
      entry('0-base-quote', 1, { side: 'Buy', amount: '2000000', price: String(3n * SCALE) }),
      entry('0-base-quote', 2, { side: 'Buy', amount: '1000000', price: String(4n * SCALE) }),
      entry('0-base-quote', 3, { side: 'Sell', amount: '3000000', price: String(7n * SCALE) }),
      entry('0-base-quote', 4, { amount: '1000000', price: String(9n * SCALE) }),
    ], assets, prices, analytics);
    expect(analytics.orderBookActiveReserves.get('0-base-quote')).toEqual({ baseAssetReserves: 4000000n, quoteAssetReserves: 1000000000n, liquidityUSD: 40n * SCALE });
    expect([...analytics.assetOrderBookLiquidity]).toEqual([['quote', 1000000000n], ['base', 4000000n]]);
  });
  it('uses zero valuation for assets with no price and default precision for unknown assets', () => {
    const analytics = { orderBookActiveReserves: new Map(), assetOrderBookLiquidity: new Map() };
    instance().mergeLimitOrderStorage([entry('0-b-q', 1, { side: 'Buy', amount: String(2n * SCALE), price: String(3n * SCALE) }), entry('0-b-q', 2, { amount: String(SCALE) }), entry('0-b-q', 3, {})], new Map(), new Map(), analytics);
    expect(analytics.orderBookActiveReserves.get('0-b-q')).toEqual({ baseAssetReserves: SCALE, quoteAssetReserves: 6n * SCALE, liquidityUSD: 0n });
  });
  it('ignores incomplete market identifiers without contaminating reserves', () => {
    const analytics = { orderBookActiveReserves: new Map(), assetOrderBookLiquidity: new Map() };
    instance().mergeLimitOrderStorage([entry('0--q', 1, {}), entry('0-b-', 2, {}), entry(null, 3, {})], new Map(), new Map(), analytics);
    expect(analytics.orderBookActiveReserves.size).toBe(0); expect(analytics.assetOrderBookLiquidity.size).toBe(0);
  });
});

describe('historical native issuance reads', () => {
  it('reads issuance at the requested block hash with lossless codec conversion', async () => {
    const indexer = instance(); const hash = '0x' + 'a'.repeat(64);
    const totalIssuance = vi.fn(async () => '9007199254740993');
    const at = vi.fn(async () => ({ query: { balances: { totalIssuance } } }));
    const getBlockHash = vi.fn(async () => ({ toString: () => hash })); indexer.api = { rpc: { chain: { getBlockHash } }, at };
    expect(await indexer.fetchNativeXorIssuanceAtBlock(42)).toBe(9007199254740993n);
    expect(getBlockHash).toHaveBeenCalledWith(42); expect(at).toHaveBeenCalledWith(hash); expect(totalIssuance).toHaveBeenCalledOnce();
  });
  it('rejects historical reads before API initialization', async () => {
    await expect(instance().fetchNativeXorIssuanceAtBlock(42)).rejects.toThrow('before the chain API is initialized');
  });
  it.each([null, '', '0x0000'])('rejects an unavailable historical block hash %j', async hash => {
    const indexer = instance(); const at = vi.fn(); indexer.api = { rpc: { chain: { getBlockHash: async () => hash } }, at };
    await expect(indexer.fetchNativeXorIssuanceAtBlock(42)).rejects.toThrow('No SORA block hash'); expect(at).not.toHaveBeenCalled();
  });
  it.each([{}, { balances: {} }, { balances: { totalIssuance: 1 } }])('requires historical native balances storage %j', async query => {
    const indexer = instance(); indexer.api = { rpc: { chain: { getBlockHash: async () => '0x1234' } }, at: async () => ({ query }) };
    await expect(indexer.fetchNativeXorIssuanceAtBlock(42)).rejects.toThrow('balances.totalIssuance is required');
  });
});
