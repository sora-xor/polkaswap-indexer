import { parse, type FragmentDefinitionNode, type GraphQLResolveInfo, type OperationDefinitionNode } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import { assertNetworkFlowQuery, networkFlowRepositoryFilter, projectNetworkSnapshotFlows, requestsNetworkFlows } from '../src/graphql/network-flow.js';
import { MemoryRepository } from '../src/repository/memory.js';
import type { IndexerDocument, IndexerRepository } from '../src/repository/types.js';
const info = (selection: string, fragments = ''): GraphQLResolveInfo => {
  const ast = parse(`query { snapshots { ${selection} } } ${fragments}`);
  return { fieldNodes: [(ast.definitions[0] as OperationDefinitionNode).selectionSet.selections[0]],
    fragments: Object.fromEntries(ast.definitions.filter((node): node is FragmentDefinitionNode => node.kind === 'FragmentDefinition').map(node => [node.name.value, node])) } as unknown as GraphQLResolveInfo;
};
const block = (height: number, timestamp = height * 100): IndexerDocument => ({ collection: 'networkSnapshots', id: `block-${height}`, blockHeight: height, timestamp,
  data: { type: 'BLOCK', transactions: 1, swaps: 1, fees: '7', volumeUSD: '0.00000001' } });
const aggregate = (fields: Record<string, unknown> = {}): IndexerDocument => ({ collection: 'networkSnapshots', id: 'network-all-DEFAULT-300', blockHeight: 5, timestamp: 599,
  data: { type: 'DEFAULT', liquidityUSD: '1234', calendarFlows: { version: 1, bucketStart: 300, bucketEnd: 600, throughBlock: 5, throughTimestamp: 500, complete: true, transactions: 3, swaps: 3, fees: '21', volumeUSD: '0.00000003', ...fields } } });
const fixture = async () => { const repository = new MemoryRepository(); await repository.upsertMany(Array.from({ length: 7 }, (_, n) => block(n))); return repository; };

describe('network flow selection and query admission', () => {
  it('defaults to flow projection when no resolve info is supplied', () => { expect(requestsNetworkFlows()).toBe(true); });
  it.each(['id', 'liquidityUSD', 'nested { id }', '__typename'])('does not scan flow history for %s', selection => { expect(requestsNetworkFlows(info(selection))).toBe(false); });
  it.each(['charged: fees', '... on NetworkSnapshot { transactions }', 'nested { flowAggregation }', '...Flows'])('discovers flow fields through %s', selection => {
    expect(requestsNetworkFlows(info(selection, 'fragment Flows on NetworkSnapshot { volumeUSD }'))).toBe(true);
  });
  it('stops recursive or unavailable fragments without requesting flow history', () => {
    expect(requestsNetworkFlows(info('...A', 'fragment A on NetworkSnapshot { ...B } fragment B on NetworkSnapshot { ...A }'))).toBe(false);
    expect(requestsNetworkFlows(info('...Missing'))).toBe(false);
    expect(requestsNetworkFlows({ fieldNodes: [{ kind: 'Field', name: { kind: 'Name', value: 'snapshots' } }], fragments: {} } as unknown as GraphQLResolveInfo)).toBe(false);
  });
  it.each(['FEES_DESC', 'VOLUME_USD_ASC', 'ACCOUNTS_DESC', 'TRANSACTIONS_ASC', 'SWAPS_DESC', 'BRIDGE_INCOMING_TRANSACTIONS_DESC'])('requires BLOCK membership before ordering by %s', orderBy => {
    expect(() => assertNetworkFlowQuery({ type: { eq: 'DAY' } }, orderBy)).toThrow(/require type BLOCK/);
    expect(() => assertNetworkFlowQuery({ and: [{ type: { eq: 'BLOCK' } }] }, orderBy)).not.toThrow();
  });
  it('allows stock ordering and rejects nested aggregate flow predicates', () => {
    expect(() => assertNetworkFlowQuery({ type: { eq: 'DAY' } }, 'LIQUIDITY_USD_DESC')).not.toThrow();
    expect(() => assertNetworkFlowQuery({ and: [{ transactions: { gt: 0 } }] }, null)).toThrow(/require type BLOCK/);
  });
});

describe('calendar query boundary ownership', () => {
  it.each([['gte', 300], ['greaterThanOrEqualTo', 300], ['gt', 299], ['greaterThan', 299]])('widens %s only to the verified lower bucket', async (op, value) => {
    const repository = await fixture(); await repository.upsert(aggregate());
    const filter = { type: { eq: 'DEFAULT' }, timestamp: { [op]: 350 } };
    const output = await networkFlowRepositoryFilter(repository, filter);
    expect(output).toEqual({ ...filter, timestamp: { [op]: value } });
    expect(filter.timestamp[op]).toBe(350);
  });
  it.each([['lte', 599], ['lessThanOrEqualTo', 599], ['lt', 600], ['lessThan', 600]])('widens %s only to the verified upper bucket', async (op, value) => {
    const repository = await fixture(); await repository.upsert(aggregate());
    expect(await networkFlowRepositoryFilter(repository, { and: [{ type: { eq: 'DEFAULT' } }, { timestamp: { [op]: 450 } }, null] })).toEqual({ and: [{ type: { eq: 'DEFAULT' } }, { timestamp: { [op]: value } }, null] });
  });
  it('preserves unrelated comparisons while ignoring non-integer bounds', async () => {
    const repository = await fixture(); await repository.upsert(aggregate());
    expect(await networkFlowRepositoryFilter(repository, { type: { eq: 'DEFAULT' }, timestamp: { gt: 350, eq: 'unchanged', invalid: 'not-a-number' } })).toEqual({ type: { eq: 'DEFAULT' }, timestamp: { gt: 299, eq: 'unchanged', invalid: 'not-a-number' } });
  });
  it('does not widen disjunctions, unsupported buckets, or unbounded stock queries', async () => {
    const repository = await fixture(); const query = vi.spyOn(repository, 'query');
    for (const filter of [undefined, null, { or: [{ type: { eq: 'DAY' } }], timestamp: { lt: 300 } }, { type: { eq: 'BLOCK' } }, { type: { eq: 'HOUR' } }]) {
      expect(await networkFlowRepositoryFilter(repository, filter)).toBe(filter);
    }
    expect(query).not.toHaveBeenCalled();
  });
  it('reads legacy source positions from their payload when envelopes are absent', async () => {
    const repository = await fixture(); const source = aggregate();
    vi.spyOn(repository, 'get').mockResolvedValue({ ...source, blockHeight: null, timestamp: null, data: { ...source.data, blockHeight: 5, timestamp: 599 } });
    expect(await networkFlowRepositoryFilter(repository, { type: { eq: 'DEFAULT' }, timestamp: { lte: 450 } })).toMatchObject({ timestamp: { lte: 599 } });
  });
});

describe('calendar projection refuses unprovable flow values', () => {
  it('passes through BLOCK and unsupported rows without requiring repository queries', async () => {
    const repository = {} as IndexerRepository;
    const result = await projectNetworkSnapshotFlows(repository, [block(1), { ...block(2), data: { type: 'UNKNOWN' } }]);
    expect(result.map(row => row.data.flowAggregation)).toEqual(['BLOCK', null]);
  });
  it('requires bounded query support whenever aggregate rows need correction', async () => {
    await expect(projectNetworkSnapshotFlows({} as IndexerRepository, [aggregate()])).rejects.toThrow(/bounded repository queries/);
  });
  it('preserves mixed BLOCK rows while correcting only aggregate flow fields', async () => {
    const repository = await fixture(); const result = await projectNetworkSnapshotFlows(repository, [block(1), aggregate()]);
    expect(result[0]!.data.flowAggregation).toBe('BLOCK');
    expect(result[1]!.data).toMatchObject({ flowAggregation: 'CALENDAR', transactions: 3, fees: '21', volumeUSD: '0.00000003', liquidityUSD: '1234' });
  });
  it.each([{ timestamp: -1 }, { timestamp: 0.5 }, { blockHeight: -1 }, { blockHeight: NaN }])('retains a legacy marker for invalid snapshot positions %j', async override => {
    const repository = await fixture(); const source = { ...aggregate(), ...override };
    expect((await projectNetworkSnapshotFlows(repository, [source]))[0]!.data.flowAggregation).toBe('LEGACY_ROLLING');
  });
  it('uses payload positions when a historical aggregate has no native envelope', async () => {
    const repository = await fixture(); const source = aggregate(); source.blockHeight = null; source.timestamp = null; source.data.blockHeight = 5; source.data.timestamp = 599;
    expect((await projectNetworkSnapshotFlows(repository, [source]))[0]!.data.flowAggregation).toBe('CALENDAR');
  });
  it.each(['-1', '1e4', '1.000000001', 'x'])('refuses malformed or inexact USD flow %s', async volumeUSD => {
    await expect(projectNetworkSnapshotFlows(await fixture(), [aggregate({ volumeUSD })])).rejects.toThrow(/invalid indexed USD flow/);
  });
  it.each(['transactions', 'swaps', 'fees', 'accounts', 'bridgeIncomingTransactions', 'bridgeOutgoingTransactions'])('refuses invalid integral %s flow', async field => {
    await expect(projectNetworkSnapshotFlows(await fixture(), [aggregate({ [field]: '1.5' })])).rejects.toThrow(new RegExp(`invalid indexed ${field}`));
  });
  it('refuses GraphQL integer overflow while preserving exact large fee strings', async () => {
    await expect(projectNetworkSnapshotFlows(await fixture(), [aggregate({ transactions: '2147483648' })])).rejects.toThrow(/overflow in corrected transactions/);
    const fee = '9'.repeat(100); const result = await projectNetworkSnapshotFlows(await fixture(), [aggregate({ fees: fee })]);
    expect(result[0]!.data.fees).toBe(fee);
  });
  it('refuses a correction that would create a negative count', async () => {
    await expect(projectNetworkSnapshotFlows(await fixture(), [aggregate({ transactions: 0 })], { timestamp: { gt: 400 } })).rejects.toThrow(/negative corrected transactions/);
  });
  it('emits an exact zero interval when time bounds do not overlap the bucket', async () => {
    const result = await projectNetworkSnapshotFlows(await fixture(), [aggregate()], { timestamp: { gte: 1000, lte: 1100 } });
    expect(result[0]!.data).toMatchObject({ transactions: 0, fees: '0', volumeUSD: '0', flowAggregation: 'CALENDAR', flowBucketStart: 600, flowBucketEnd: 600 });
  });
  it('rejects noncanonical repository BLOCK identities before projecting amounts', async () => {
    const repository = await fixture(); vi.spyOn(repository, 'query').mockResolvedValue({ items: [{ ...block(1), id: 'wrong' }], totalCount: 1 });
    await expect(projectNetworkSnapshotFlows(repository, [aggregate()])).rejects.toThrow(/noncanonical BLOCK/);
  });
  it('refuses a missing rolling source instead of extrapolating a calendar total', async () => {
    const repository = await fixture(); const source = aggregate(); delete source.data.calendarFlows; vi.spyOn(repository, 'get').mockResolvedValue(null);
    await expect(projectNetworkSnapshotFlows(repository, [source])).rejects.toThrow(/snapshot source block is missing/);
  });
  it('removes rejected cache entries so repaired evidence can be retried', async () => {
    const repository = await fixture(); const source = aggregate(); delete source.data.calendarFlows; source.timestamp = 500;
    source.data.transactions = 3; source.data.fees = '21'; source.data.swaps = 3; source.data.volumeUSD = '0.00000003';
    const get = vi.spyOn(repository, 'get'); get.mockResolvedValueOnce(null);
    await expect(projectNetworkSnapshotFlows(repository, [source])).rejects.toThrow(/snapshot source block is missing/);
    const result = await projectNetworkSnapshotFlows(repository, [source]);
    expect(result[0]!.data.flowAggregation).toBe('CALENDAR');
  });
});
