import { describe, expect, it, vi } from 'vitest';
import { readConfig } from '../src/config.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { ChainIndexer } from '../src/worker/chain.js';
import type { IndexerDocument } from '../src/repository/types.js';
const indexer = (repository = new MemoryRepository()): any => new ChainIndexer(readConfig(), repository);
const entry = (id: unknown, value: unknown, account?: unknown): any => [{ args: account === undefined ? [id] : [id, account] }, value];
const project = (patch: Record<string, any> = {}) => indexer().createPolkamarktPositionDocuments(
  patch.positions ?? [entry(42, { yesShares: '20', noShares: '10', netCollateralPaid: '5' }, 'alice')],
  patch.markets ?? [entry(42, { collateralAsset: 'collateral', status: patch.status ?? 'Open', creator: 'alice' })],
  patch.collateral ?? [entry(42, '100')], patch.totals ?? [entry(42, { totalYesShares: '100', totalNoShares: '40' })],
  patch.resolutions ?? [entry(42, patch.outcome ?? 'Yes')], patch.cost ?? [entry(42, { yes: '3', no: '2' }, 'alice')],
  patch.costTotals ?? [entry(42, { yes: '30', no: '20' })], patch.assets ?? new Map([['collateral', { decimals: 0 }]]), 900, 1000);

describe('market storage settlement projection', () => {
  it.each([['Yes', '20', '15'], ['No', '25', '20'], ['Invalid', '0', '-5']])('settles resolved %s using actual winning shares and cost basis', (outcome, payout, pnl) => {
    const result = project({ status: 'Resolved', outcome });
    expect(result).toHaveLength(1); expect(result[0].data).toMatchObject({ id: '42-alice', account: 'alice', marketId: 42, yesShares: '20', noShares: '10', shares: '20', outcome: 'Yes', netCollateralPaid: '5', costBasisUsd: '5', yesCostBasisUsd: '3', noCostBasisUsd: '2', claimablePayoutUsd: payout, marketValueUsd: payout, unrealizedPnlUsd: pnl, isCreator: true });
  });
  it('allocates cancelled collateral by cost basis instead of outstanding shares', () => {
    expect(project({ status: 'Cancelled' })[0].data).toMatchObject({ claimablePayoutUsd: '10', marketValueUsd: '10', unrealizedPnlUsd: '5' });
  });
  it.each([{ cost: [] }, { costTotals: [] }, { costTotals: [entry(42, { yes: '0', no: '0' })] }])('leaves cancelled settlement unknown without complete refund evidence', patch => {
    expect(project({ status: 'Cancelled', ...patch })[0].data).toMatchObject({ claimablePayoutUsd: null, marketValueUsd: null, unrealizedPnlUsd: null });
  });
  it('does not invent settled value for an open market', () => {
    expect(project()[0].data).toMatchObject({ status: 'Open', claimablePayoutUsd: '0', marketValueUsd: null, unrealizedPnlUsd: null });
  });
  it('keeps absent cost basis unknown even when a resolved payout is known', () => {
    expect(project({ status: 'Resolved', cost: [] })[0].data).toMatchObject({ costBasisUsd: null, yesCostBasisUsd: null, noCostBasisUsd: null, unrealizedPnlUsd: null, claimablePayoutUsd: '20' });
  });
  it('does not divide by zero when winning market totals are unavailable', () => {
    expect(project({ status: 'Resolved', totals: [] })[0].data.claimablePayoutUsd).toBe('0');
    expect(project({ status: 'Resolved', resolutions: [] })[0].data.claimablePayoutUsd).toBe('0');
    expect(project({ status: 'Resolved', collateral: [] })[0].data.claimablePayoutUsd).toBe('0');
  });
  it('chooses the larger no position and supports legacy snake-case fields', () => {
    expect(project({ positions: [entry(42, { yes_shares: '1', no_shares: '7', net_collateral_paid: '2' }, 'bob')] })[0].data).toMatchObject({ account: 'bob', outcome: 'No', shares: '7', yesShares: '1', noShares: '7', netCollateralPaid: '2', isCreator: false });
  });
  it('retains spent-only positions without inventing an outcome or live shares', () => {
    expect(project({ positions: [entry(42, { netCollateralPaid: '2' }, 'alice')] })[0].data).toMatchObject({ outcome: null, shares: '0', yesShares: '0', noShares: '0', netCollateralPaid: '2' });
    expect(project({ positions: [entry(42, {}, 'alice')] })).toEqual([]);
  });
  it('omits positions whose market is absent and defaults unknown asset precision to eighteen', () => {
    expect(project({ markets: [] })).toEqual([]);
    const amount = '2000000000000000000';
    expect(project({ assets: new Map(), positions: [entry(42, { yesShares: amount }, 'alice')] })[0].data.yesShares).toBe('2');
  });
  it.each(['markets', 'collateral', 'totals', 'resolutions', 'costTotals'])('ignores malformed %s storage keys without affecting a valid market', field => {
    const valid = { markets: [entry(42, { collateralAsset: 'collateral', status: 'Resolved' })], collateral: [entry(42, '100')], totals: [entry(42, { totalYesShares: '100' })], resolutions: [entry(42, 'Yes')], costTotals: [entry(42, { yes: '30', no: '20' })] };
    const entries = valid[field as keyof typeof valid];
    expect(project({ status: 'Resolved', [field]: [entry('invalid', {}), entry(-1, {}), ...entries] })).toHaveLength(1);
  });
  it.each(['positions', 'cost'])('ignores malformed account %s keys without inventing positions', field => {
    const valid = field === 'positions' ? [entry(42, { yesShares: '1' }, 'alice')] : [entry(42, { yes: '1' }, 'alice')];
    const result = project({ [field]: [entry('invalid', {}, 'alice'), entry(42, {}, ''), [{}, {}], ...valid] });
    expect(result).toHaveLength(1); expect(result[0].data.account).toBe('alice');
  });
});

describe('runtime metadata codec projections', () => {
  it.each([
    ['  plain text  ', 'plain text'], ['0x68656c6c6f', 'hello'], [[104, 101, 108, 108, 111], 'hello'],
    [{ value: 'hello' }, 'hello'], [{ inner: 'hello' }, 'hello'], [{ raw: 'hello' }, 'hello'],
    ['0xff', ''], [[256], ''], [[-1], ''], [[0.5], ''], [[], ''], [{}, ''], [null, ''], [42, ''],
  ])('decodes human-readable metadata %j without replacement bytes', (value, expected) => { expect(indexer().decodeMetadataText(value)).toBe(expected); });
  it.each([
    ['0xAaBb', '0xaabb'], ['hello', '0x68656c6c6f'], [[0, 255], '0x00ff'],
    [{ value: '0xaabb' }, '0xaabb'], [{ inner: [1, 2] }, '0x0102'], [{ raw: 'A' }, '0x41'],
    ['', null], [null, null], ['0x1', null], ['0xzz', null], [[], null], [[256], null], [[-1], null], [[1.5], null], [{}, null], [7, null],
  ])('decodes binary metadata %j without silently truncating bytes', (value, expected) => { expect(indexer().decodeBytesHex(value)).toBe(expected); });
  it.each([['Open', 'Open'], [{ type: 'Resolved' }, 'Resolved'], [{ status: 'Cancelled' }, 'Cancelled'], [{ outcome: 'No' }, 'No'], [{ yes: null }, 'Yes'], [{ no: true }, 'No'], [{ cancelled: undefined }, ''], [{ value: 3 }, ''], [null, '']])('projects runtime variant %j', (value, expected) => { expect(indexer().variantName(value)).toBe(expected); });
  it('reads human fallback records when codec JSON is not a record', () => {
    expect(indexer().normalizedRecord({ toJSON: () => 'opaque', toHuman: () => ({ total_yes_shares: '10' }) })).toEqual({ totalYesShares: '10' });
    expect(indexer().normalizedRecord({ toJSON: () => [1, 2] })).toEqual({});
    expect(indexer().normalizedRecord({ toJSON: () => { throw new Error('unavailable'); }, toString: () => 'opaque', toHuman: () => ({ total_no_shares: '5' }) })).toEqual({ totalNoShares: '5' });
  });
  it.each([[null, 0n], ['0x10', 16n], ['1,234', 1234n], [{ inner: '99' }, 99n], [123n, 123n], [2.9, 2n], ['malformed', 0n]])('converts runtime integer %s without losing large precision', (value, expected) => { expect(indexer().safeCodecToBigInt(value)).toBe(expected); });
});

const row = (id: string, value = 1): IndexerDocument => ({ collection: 'assets', id, timestamp: value, blockHeight: value, data: { rank: value } });
const collect = async (generator: AsyncGenerator<IndexerDocument[]>) => { const rows: IndexerDocument[] = []; for await (const page of generator) rows.push(...page); return rows; };
describe('worker repository paging boundaries', () => {
  it('filters and orders a legacy list-only repository while yielding every page', async () => {
    const repository = new MemoryRepository(); const rows = Array.from({ length: 1002 }, (_, n) => row(`a${String(n).padStart(4, '0')}`, n)); await repository.upsertMany(rows);
    Object.defineProperty(repository, 'query', { value: undefined });
    const result = await collect(indexer(repository).queryPages('assets', { orderBy: ['ID_ASC'], filter: { rank: { gt: 0 } } }));
    expect(result.map(item => item.id)).toEqual(rows.slice(1).map(item => item.id));
  });
  it('advances short offset pages by actual returned size', async () => {
    const repository = new MemoryRepository(), query = vi.spyOn(repository, 'query');
    query.mockResolvedValueOnce({ items: [row('a'), row('b')], totalCount: 3, hasNextPage: true }).mockResolvedValueOnce({ items: [row('c')], totalCount: 3, hasNextPage: false });
    expect((await collect(indexer(repository).queryPages('assets', { orderBy: 'RANK_ASC' }))).map(item => item.id)).toEqual(['a', 'b', 'c']);
    expect(query.mock.calls.map(([, args]) => args?.offset)).toEqual([0, 2]);
  });
  it.each(['TIMESTAMP_ASC', 'BLOCK_HEIGHT_ASC'])('uses payload positions and deterministic tie breakers for %s', async orderBy => {
    const repository = new MemoryRepository(), query = vi.spyOn(repository, 'query');
    const first = { ...row('a'), timestamp: null, blockHeight: null, data: { timestamp: 10, blockHeight: 10 } };
    query.mockResolvedValueOnce({ items: [first], totalCount: 2, hasNextPage: true }).mockResolvedValueOnce({ items: [row('b', 10)], totalCount: 2, hasNextPage: false });
    expect(await collect(indexer(repository).queryPages('assets', { orderBy }))).toHaveLength(2);
    expect(query.mock.calls[1]?.[1]?.seek).toMatchObject({ field: orderBy === 'TIMESTAMP_ASC' ? 'timestamp' : 'blockHeight', value: 10, id: 'a' });
  });
  it.each(['TIMESTAMP_ASC', 'BLOCK_HEIGHT_ASC'])('refuses invalid %s cursor values before yielding rows', async orderBy => {
    const repository = new MemoryRepository(); vi.spyOn(repository, 'query').mockResolvedValue({ items: [row('a', NaN)], totalCount: 1 });
    await expect(collect(indexer(repository).queryPages('assets', { orderBy }))).rejects.toThrow(/invalid cursor value/);
  });
  it('refuses empty continuations and exhausted aggregate memory budgets', async () => {
    const repository = new MemoryRepository(), query = vi.spyOn(repository, 'query'); query.mockResolvedValue({ items: [], totalCount: 1, hasNextPage: true });
    await expect(collect(indexer(repository).queryPages('assets'))).rejects.toThrow(/without returning a cursor row/);
    query.mockClear(); await expect(collect(indexer(repository).queryPages('assets', {}, () => 0))).rejects.toThrow(/aggregate retained-byte budget/); expect(query).not.toHaveBeenCalled();
  });
});
