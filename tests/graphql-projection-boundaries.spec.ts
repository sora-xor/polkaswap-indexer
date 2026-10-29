import { GraphQLObjectType } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import { createSchema, NETWORK_ACCOUNT_ACTIVITY_MAX_DOCUMENTS, POLKAMARKT_SIGNALS_MAX_DOCUMENTS } from '../src/graphql/resolvers.js';
import type { IndexerCollection, IndexerDocument, IndexerRepository } from '../src/repository/types.js';

const doc = (collection: IndexerCollection, id: string, data: Record<string, unknown>, timestamp?: number): IndexerDocument => ({ collection, id, data: { id, ...data }, ...(timestamp === undefined ? {} : { timestamp }) });
const listRepository = (documents: IndexerDocument[]): IndexerRepository => ({
  list: async collection => documents.filter(d => d.collection === collection),
  get: async (collection, id) => documents.find(d => d.collection === collection && d.id === id) ?? null,
  getMany: async (collection, ids) => new Map(documents.filter(d => d.collection === collection && ids.includes(d.id)).map(d => [d.id, d])),
  upsert: async () => undefined, upsertMany: async () => undefined, deleteMany: async () => undefined, close: async () => undefined,
});
const resolve = (name: string, documents: IndexerDocument[], args: Record<string, unknown> = {}, repository = listRepository(documents)): Promise<any> =>
  Promise.resolve(createSchema().getQueryType()!.getFields()[name]!.resolve!({}, args, { repository }, {} as never));
const field = (type: string, name: string, value: unknown): unknown => {
  const schemaType = createSchema().getType(type) as GraphQLObjectType;
  return schemaType.getFields()[name]!.resolve!({ [name]: value }, {}, {}, {} as never);
};

describe('account connection legacy repository compatibility', () => {
  const position = doc('accountPositions', 'position', { account: 'alice', timestamp: 42, marketId: 1 });
  it.each([false, true])('derives a bounded count and opaque cursor when metadata is absent (next=%s)', async hasNextPage => {
    const query = vi.fn(async () => ({ items: [position], hasNextPage }));
    const result = await resolve('accountPositions', [], { where: { account: 'alice' }, first: 1 }, { ...listRepository([]), query } as any);
    expect(result.totalCount).toBe(hasNextPage ? 2 : 1); expect(result.edges[0].cursor).toMatch(/^psc2\./);
    expect(result.pageInfo).toMatchObject({ hasNextPage, hasPreviousPage: false });
  });
  it('preserves numeric legacy pagination when a repository omits page metadata', async () => {
    const query = vi.fn(async () => ({ items: [position] }));
    const result = await resolve('accountPositions', [], { filter: { account_eq: 'alice' }, after: '2', first: 1 }, { ...listRepository([]), query } as any);
    expect(result.pageInfo).toMatchObject({ hasPreviousPage: true, hasNextPage: false });
    expect(query.mock.calls[0]).toEqual(['accountPositions', expect.objectContaining({ offset: 3 })]);
  });
  it.each([
    { account: 'alice', account_eq: 'alice' },
    { and: { status: { equalTo: 'Open' } }, account: 'alice', account_eq: 'alice' },
    { and: [{ status: { equalTo: 'Open' } }], account: 'alice', account_eq: 'alice' },
  ])('retains every colliding account alias as a conjunction %#', async filter => {
    const query = vi.fn(async () => ({ items: [], totalCount: 0 }));
    const result = await resolve('accountPositions', [], { filter, orderBy: 'UPDATED_AT_ASC' }, { ...listRepository([]), query });
    expect(result.totalCount).toBe(0); expect(query.mock.calls[0]).toEqual(['accountPositions', expect.objectContaining({ orderBy: 'TIMESTAMP_ASC', filter: { and: expect.arrayContaining([{ account: 'alice' }, { account: { equalTo: 'alice' } }]) } })]);
  });
  it('combines where and filter without discarding either source', async () => {
    const query = vi.fn(async () => ({ items: [], totalCount: 0 }));
    await resolve('accountPositions', [], { where: { account_eq: 'alice' }, filter: { status: 'Open' }, orderBy: ['UPDATED_AT_DESC'] }, { ...listRepository([]), query });
    expect(query.mock.calls[0]).toEqual(['accountPositions', expect.objectContaining({ filter: { and: [{ account: { equalTo: 'alice' } }, { status: 'Open' }] } })]);
  });
  it('ignores a nonrecord optional filter before requiring a real account anchor', async () => {
    await expect(resolve('accountPositions', [], { filter: 4 })).rejects.toThrow(/indexed public filter/);
    await expect(resolve('accountPositions', [], { where: { account: 'alice' }, orderBy: [4] })).rejects.toThrow();
  });
  it('returns safe page metadata for an empty list-only tail', async () => {
    const result = await resolve('accountPositions', [], { where: { account: 'alice' }, last: 2 });
    expect(result).toMatchObject({ edges: [], totalCount: 0, pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } });
  });
  it('retains legacy call data when canonical trade fields are absent', async () => {
    const trade = doc('accountTransactions', 'tx', { accountId: 'alice', module: 'polkamarkt', marketId: 1, calls: [{ data: { shares: '4', method: 'sell' } }] });
    const query = vi.fn(async () => ({ items: [trade], totalCount: 1 }));
    const result = await resolve('accountTrades', [], {}, { ...listRepository([]), query });
    expect(result.edges[0].node).toMatchObject({ id: 'tx', marketId: 1, shares: '4', side: 'sell', timestamp: null, blockNumber: null });
  });
});

describe('GraphQL list-repository overview and signal projections', () => {
  it.each(['DAY', 'DEFAULT', 'HOUR'])('prefers the newest %s snapshot including stable timestamp ties', async type => {
    const documents = [doc('networkSnapshots', 'a', { type, liquidityUSD: '2' }, 10), doc('networkSnapshots', 'z', { type, liquidityUSD: '3' }, 10), doc('networkSnapshots', 'older', { type }, 9)];
    if (type === 'DAY') documents.push(doc('networkSnapshots', 'default', { type: 'DEFAULT', liquidityUSD: '999' }, 100));
    const result = await resolve('exploreStats', documents);
    expect(result).toMatchObject({ liquidityUSD: '3', volumeDayUSD: '0', updatedAtTimestamp: 10, tokenCount: 0, poolCount: 0, orderBookCount: 0 });
  });
  it('uses zeroes for an empty overview and for malformed legacy timestamps', async () => {
    expect(await resolve('exploreStats', [])).toMatchObject({ liquidityUSD: '0', volumeDayUSD: '0', updatedAtTimestamp: null });
    expect(await resolve('exploreStats', [doc('networkSnapshots', 'a', { timestamp: 'invalid' })])).toMatchObject({ updatedAtTimestamp: 0 });
  });
  it('counts a list-only activity range once per normalized account', async () => {
    const rows = [doc('accountTransactions', 'a', { timestamp: 12, accountId: 'alice' }), doc('accountTransactions', 'b', { timestamp: 15, accountId: 'alice' }), doc('accountTransactions', 'c', { timestamp: 18, accountId: 'bob' }), doc('accountTransactions', 'd', { timestamp: 22, accountId: 'outside' })];
    expect(await resolve('networkAccountActivity', rows, { from: 20, to: 10 })).toMatchObject({ from: 10, to: 20, activeAccounts: 2 });
  });
  it('rejects an over-budget list-only activity scan', async () => {
    const row = doc('accountTransactions', 'a', { timestamp: 12, accountId: 'alice' });
    await expect(resolve('networkAccountActivity', Array(NETWORK_ACCOUNT_ACTIVITY_MAX_DOCUMENTS + 1).fill(row), { from: 10, to: 20 })).rejects.toThrow(/scan budget/);
  });
  it('uses the streaming repository for account activity when available', async () => {
    const repository = listRepository([]), streamingRepository = { ...repository, query: vi.fn(async () => ({ items: [doc('accountTransactions', 'a', { accountId: 'alice' })], hasNextPage: false })) };
    const result = await createSchema().getQueryType()!.getFields().networkAccountActivity!.resolve!({}, { from: 10, to: 20 }, { repository, streamingRepository }, {} as never);
    expect(result).toMatchObject({ activeAccounts: 1 }); expect(streamingRepository.query).toHaveBeenCalledOnce();
  });
  it('sums sparse amounts exactly and removes zero-only fractional tails', async () => {
    const result = await resolve('polkamarktSignals', [doc('markets', '1', { volumeUSD: '0.5', liquidityUSD: null }), doc('markets', '2', { volumeUSD: '0.5' }), doc('markets', '3', { creator: '  ' })]);
    expect(result).toMatchObject({ totalVolumeUsd: '1', liquidityUsd: '0', activeMarkets: 3, activeAccounts: 0, accuracySummary: null });
  });
  it('projects sparse and invalid legacy snapshot scalar fallbacks', async () => {
    const result = await resolve('polkamarktSignals', [doc('networkSnapshots', 'a', { accounts: ' ', timestamp: 'bad' }), doc('networkSnapshots', 'b', { accounts: 'NaN', timestamp: 0 })]);
    expect(result).toMatchObject({ totalVolumeUsd: '0', liquidityUsd: '0', activeAccounts: 0, liquiditySeries: [{ label: '0', value: '0' }, { label: '0', value: '0' }] });
  });
  it.each([
    ['market id', { marketId: -1 }], ['close block', { closeBlock: 'bad' }], ['title', { title: ' ' }],
  ])('omits a resolved market with invalid %s from accuracy', async (_label, override) => {
    const result = await resolve('polkamarktSignals', [doc('markets', '1', { status: 'Resolved', resolutionOutcome: 'Yes', title: 'Question', marketId: 1, closeBlock: 10, ...override })]);
    expect(result.accuracySummary).toMatchObject({ resolvedMarkets: 1, scoredMarkets: 0, correctMarkets: 0, accuracyPercent: 0 });
  });
  it.each([null, -1, 1.01, ' ', 'NaN', false])('rejects unusable unit probability %s from scoring', async priceYes => {
    const result = await resolve('polkamarktSignals', [doc('markets', '1', { status: 'Resolved', resolutionOutcome: 'Yes', title: 'Question', marketId: 1, closeBlock: 10 }), doc('marketSnapshots', 's', { type: 'DEFAULT', marketId: 1, blockHeight: 9, priceYes })]);
    expect(result.accuracySummary.scoredMarkets).toBe(0);
  });
  it.each([[0.75, 'No', 0, 25], [0.25, 'No', 1, 75]] as const)('scores unit price %s against outcome %s', async (priceYes, outcome, correct, confidence) => {
    const result = await resolve('polkamarktSignals', [doc('markets', '1', { status: 'Resolved', resolutionOutcome: outcome, title: 'Question', marketId: 1, closeBlock: 10 }), doc('marketSnapshots', 's', { type: 'DEFAULT', marketId: 1, blockHeight: 9, priceYes, timestamp: 1_700_000_000_000 })]);
    expect(result.accuracySummary).toMatchObject({ scoredMarkets: 1, correctMarkets: correct, averageConfidencePercent: confidence });
    expect(result.accuracySeries[0].label).toMatch(/\d\d:\d\d [AP]M/);
  });
  it('excludes unknown outcomes without inventing an accuracy estimate', async () => {
    const result = await resolve('polkamarktSignals', [doc('markets', '1', { status: 'Resolved', resolutionOutcome: 'Maybe' })]);
    expect(result.accuracySummary).toBeNull();
  });
  it('rejects the list-only market scan beyond its document budget', async () => {
    await expect(resolve('polkamarktSignals', Array(POLKAMARKT_SIGNALS_MAX_DOCUMENTS + 1).fill(doc('markets', '1', {})))).rejects.toThrow(/scan budget/);
  });
  it('rejects an empty query page that advertises a continuation', async () => {
    const repository = { ...listRepository([]), query: async (collection: IndexerCollection) => ({ totalCount: 0, items: [], hasNextPage: collection === 'markets' }) };
    await expect(resolve('polkamarktSignals', [], {}, repository)).rejects.toThrow(/empty markets page/);
  });
  it.each([false, true])('rejects a native query exceeding the market scan budget (continuation %s)', async hasNextPage => {
    const rows = Array.from({ length: POLKAMARKT_SIGNALS_MAX_DOCUMENTS + (hasNextPage ? 0 : 1) }, (_, i) => doc('markets', String(i), {}));
    const repository = { ...listRepository([]), query: async (collection: IndexerCollection) => ({ totalCount: rows.length, items: collection === 'markets' ? rows : [], hasNextPage: collection === 'markets' && hasNextPage }) };
    await expect(resolve('polkamarktSignals', [], {}, repository)).rejects.toThrow(/scan budget/);
  });
});

describe('GraphQL scalar and connection admission boundaries', () => {
  it.each([undefined, null])('preserves missing nullable decimal values %s', value => {
    expect(field('AccountTrade', 'realizedPnlUsd', value)).toBeNull();
    expect(field('Market', 'probability', value)).toBeNull();
    expect(field('Asset', 'priceUSD', value)).toBeNull();
  });
  it.each([[-1.25, '-1.25'], [-0, '0'], ['-000.000', '0'], ['-000.12300', '-0.123']] as const)('normalizes signed indexed quantity %s', (input, expected) => {
    expect(field('AccountTrade', 'realizedPnlUsd', input)).toBe(expected);
  });
  it.each(['--1', '-NaN', NaN, false, {}, Infinity])('rejects malformed signed indexed quantity %s', input => {
    expect(() => field('AccountTrade', 'realizedPnlUsd', input)).toThrow(/invalid/);
  });
  it.each([
    ['before type', { before: 1 }], ['before size', { before: 'a'.repeat(8193) }],
    ['mixed cursors', { offset: 1, after: 'opaque' }], ['string length', { filter: { id: 'a'.repeat(20_000) } }],
    ['bigint', { filter: { id: 1n } }], ['function', { filter: { id: () => 1 } }],
    ['forbidden key', { filter: JSON.parse('{"constructor":1}') }], ['key length', { filter: { ['a'.repeat(129)]: 1 } }],
    ['nonplain object', { filter: new Date() }], ['invalid last offset', { last: 1000, offset: 100000 }],
  ])('rejects %s before repository access', async (_label, args) => {
    const repository = listRepository([]); const list = vi.spyOn(repository, 'list');
    await expect(resolve('assets', [], args, repository)).rejects.toThrow(); expect(list).not.toHaveBeenCalled();
  });
});

describe('GraphQL account trade runtime payload projection', () => {
  const trade = async (data: Record<string, unknown>, envelope: Record<string, unknown> = {}) => {
    const document = doc('accountTransactions', 'tx', { accountId: 'alice', module: 'polkamarkt', marketId: 7, timestamp: 100, ...data, ...envelope });
    return (await resolve('accountTrades', [document], { where: { account_eq: 'alice' }, first: 10 })).edges[0]?.node;
  };
  it.each([['flipOutcome', 'flip'], ['claimPayout', 'claim'], ['limitOrder', 'order'], ['sellShares', 'sell'], ['buyShares', 'buy'], ['customAction', 'customaction']] as const)('normalizes %s into side %s', async (method, side) => {
    expect(await trade({ method })).toMatchObject({ side, account: 'alice', market: { marketId: 7 } });
  });
  it('reads call payload aliases while preserving top-level precedence', async () => {
    const node = await trade({ data: { outcome: 'YES' }, calls: [null, { data: { shares_in: '2', shares_out: '3', feeUSD: '0.1', action: 'flipOutcome' } }], timestamp: 1_700_000_000_000 });
    expect(node).toMatchObject({ side: 'flip', outcome: 'YES', sharesIn: '2', sharesOut: '3', feeUsd: '0.1', timestamp: '2023-11-14T22:13:20.000Z' });
  });
  it.each([0, 'bad', ' ', null])('preserves or rejects uninterpretable trade timestamp %s without fabricating a date', async timestamp => {
    const node = await trade({ timestamp });
    expect(node.timestamp).toBe(timestamp === null || timestamp === ' ' ? null : String(timestamp));
  });
  it.each([[], '7', [null], [7, 7], Array.from({ length: 25 }, (_, i) => i)])('rejects malformed multi-market identifiers %j', async marketIds => {
    await expect(trade({ marketIds })).rejects.toThrow(/identifiers/);
  });
  it('falls back to the document key when an embedded identifier is blank', async () => {
    expect(await trade({ id: ' ' })).toMatchObject({ id: 'tx' });
  });
});
