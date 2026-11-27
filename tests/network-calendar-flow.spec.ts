import { graphql } from 'graphql';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createSchema } from '../src/graphql/resolvers.js';
import { assertNetworkFlowQuery, NETWORK_FLOW_FIELDS, projectNetworkSnapshotFlows } from '../src/graphql/network-flow.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { RocksRepository } from '../src/repository/rocksdb.js';
import { readConfig } from '../src/config.js';
import type { IndexerDocument } from '../src/repository/types.js';

const times = [3500, 3590, 3599, 3600, 3650, 7000, 7100, 7190, 7199, 7200, 7250, 7300];
const feeUnit = 1198943809014728936376n;
const flows = (value: number) => ({ accounts: value, transactions: value, swaps: value,
  bridgeIncomingTransactions: value, bridgeOutgoingTransactions: value,
  fees: (BigInt(value) * feeUnit).toString(), volumeUSD: `${value}.00000001` });
const blocks = (): IndexerDocument[] => times.map((timestamp, index) => ({
  collection: 'networkSnapshots', id: `block-${100 + index}`, blockHeight: 100 + index, timestamp,
  data: { id: `block-${100 + index}`, type: 'BLOCK', timestamp, ...flows(index + 1) },
}));
const aggregate = (timestamp: number, type = 'HOUR'): IndexerDocument => {
  const window = type === 'DAY' ? 86400 : 3600;
  const rows = blocks().filter((row) => row.timestamp! >= timestamp - window && row.timestamp! <= timestamp);
  const value = rows.reduce((sum, row) => sum + Number(row.data.transactions), 0);
  const id = `network-all-${type}-${Math.floor(timestamp / window) * window}`;
  return { collection: 'networkSnapshots', id, blockHeight: rows.at(-1)!.blockHeight, timestamp, data: {
    id, type, timestamp, ...flows(value), volumeUSD: `${value}.${String(rows.length).padStart(8, '0')}`,
    liquidityUSD: '999.1234', activePools: 7,
  } };
};
async function fixture() {
  const repository = new MemoryRepository();
  const rows = [aggregate(7100), aggregate(7300)];
  await repository.upsertMany([{ collection: 'networkSnapshots', id: 'block-99', blockHeight: 99, timestamp: 0,
    data: { id: 'block-99', type: 'BLOCK', timestamp: 0, ...flows(0), volumeUSD: '0' } }, ...blocks(), ...rows]);
  return { repository, rows };
}

describe('calendar network API flow projection', () => {
  it('removes overlapping prefixes and includes the unrecorded completed-hour tail with exact arithmetic', async () => {
    const { repository, rows } = await fixture();
    const projected = await projectNetworkSnapshotFlows(repository, rows);
    expect(projected.map((row) => row.data.transactions)).toEqual([39, 33]);
    expect(projected.map((row) => row.data.fees)).toEqual([(39n * feeUnit).toString(), (33n * feeUnit).toString()]);
    expect(projected.map((row) => row.data.volumeUSD)).toEqual(['39.00000006', '33.00000003']);
    expect(projected.map((row) => row.data.flowAggregation)).toEqual(['CALENDAR', 'CALENDAR']);
    for (const row of projected) expect(row.data).toMatchObject({ liquidityUSD: '999.1234', activePools: 7 });
    expect((await repository.get('networkSnapshots', rows[0]!.id))!.data.transactions).toBe(28);
  });

  it('clips partial query buckets and assigns shared comparison boundaries exactly once', async () => {
    const { repository, rows } = await fixture();
    const current = await projectNetworkSnapshotFlows(repository, rows, { and: [
      { timestamp: { greaterThanOrEqualTo: 3650 } }, { timestamp: { lessThanOrEqualTo: 7300 } },
    ] });
    expect(current.map((row) => row.data.transactions)).toEqual([30, 33]);
    expect(current[0]!.data.flowBucketStart).toBe(3651);
  });

  it('fails closed for holes inside retained boundary coverage', async () => {
    const { repository, rows } = await fixture();
    await repository.deleteMany('networkSnapshots', ['block-107']);
    await expect(projectNetworkSnapshotFlows(repository, rows)).rejects.toThrow('noncontiguous BLOCK coverage');
  });

  it('marks expired history explicitly without fabricating zero or dropping the whole page', async () => {
    const { repository, rows } = await fixture();
    await repository.deleteMany('networkSnapshots', ['block-99', ...blocks().slice(0, 5).map((row) => row.id)]);
    const projected = await projectNetworkSnapshotFlows(repository, rows);
    expect(projected.map((row) => row.data.flowAggregation)).toEqual(['LEGACY_ROLLING', 'LEGACY_ROLLING']);
    expect(projected[0]!.data.fees).toBe(rows[0]!.data.fees);
  });

  it('serves completed durable calendar flows after BLOCK retention expires', async () => {
    const { repository, rows } = await fixture();
    const old = rows[0]!;
    old.data.calendarFlows = { version: 1, bucketStart: 3600, bucketEnd: 7200, throughBlock: 108,
      throughTimestamp: 7199, complete: true, ...flows(39), volumeUSD: '39.00000006' };
    await repository.deleteMany('networkSnapshots', ['block-99', ...blocks().slice(0, 9).map((row) => row.id)]);
    const projected = await projectNetworkSnapshotFlows(repository, [old]);
    expect(projected[0]!.data).toMatchObject({ flowAggregation: 'CALENDAR', transactions: 39, volumeUSD: '39.00000006' });
  });

  it('shares only bounded per-repository correction results and retains page/cursor identity', async () => {
    const { repository, rows } = await fixture();
    const query = vi.spyOn(repository, 'query');
    const first = await projectNetworkSnapshotFlows(repository, rows);
    const firstReads = query.mock.calls.length;
    expect(firstReads).toBeGreaterThan(2);
    await projectNetworkSnapshotFlows(repository, rows);
    expect(query.mock.calls.length - firstReads).toBe(2);
    for (const [, args] of query.mock.calls) {
      expect(args.first).toBeLessThanOrEqual(1000);
      expect(args.includeTotalCount).toBe(false);
      expect(args.filter?.type).toEqual({ equalTo: 'BLOCK' });
    }
    expect(first.map((row) => row.id)).toEqual(rows.map((row) => row.id));
  });

  it('rejects aggregate metric filters instead of applying predicates to obsolete rolling values', () => {
    expect(() => assertNetworkFlowQuery({ type: { equalTo: 'HOUR' }, fees: { greaterThan: '0' } }, ['TIMESTAMP_DESC']))
      .toThrow('require type BLOCK');
    expect(() => assertNetworkFlowQuery({ and: [{ type: { equalTo: 'BLOCK' } }, { fees: { greaterThan: '0' } }] }, ['TIMESTAMP_DESC']))
      .not.toThrow();
  });

  it('projects aliases/fragments without poisoning the connection cache after stock-only selection', async () => {
    const { repository } = await fixture();
    const schema = createSchema();
    const source = (selection: string) => `{networkSnapshots(first:1,orderBy:TIMESTAMP_DESC,filter:{type:{equalTo:HOUR}}){nodes{${selection}} edges{cursor}}}`;
    const stock = await graphql({ schema, source: source('id liquidityUSD'), contextValue: { repository } });
    expect(stock.errors).toBeUndefined();
    const result = await graphql({ schema, source: source('id charged:fees ...Flows') + ' fragment Flows on NetworkSnapshot {transactions volumeUSD flowAggregation}', contextValue: { repository } });
    expect(result.errors).toBeUndefined();
    expect((result.data!.networkSnapshots as { nodes: unknown[] }).nodes[0]).toMatchObject({
      transactions: 33, charged: (33n * feeUnit).toString(), volumeUSD: '33.00000003', flowAggregation: 'CALENDAR',
    });
    expect((result.data!.networkSnapshots as { edges: unknown[] }).edges).toEqual((stock.data!.networkSnapshots as { edges: unknown[] }).edges);
  });

  it('handles exact window boundaries without including a previous-hour block twice', async () => {
    const { repository } = await fixture();
    const atBoundary = aggregate(7200);
    const result = await projectNetworkSnapshotFlows(repository, [atBoundary]);
    expect(result[0]!.data.transactions).toBe(33);
    expect(NETWORK_FLOW_FIELDS.every((field) => result[0]!.data[field] !== undefined)).toBe(true);
  });

  it('includes historical upper partial buckets and keeps public keyset pagination stable', async () => {
    const { repository } = await fixture();
    const schema = createSchema();
    const source = `query($after:Cursor){networkSnapshots(first:1,after:$after,orderBy:TIMESTAMP_DESC,
      filter:{and:[{type:{equalTo:HOUR}},{timestamp:{greaterThanOrEqualTo:3599,lessThanOrEqualTo:7250}}]}){
      nodes{id timestamp transactions flowAggregation} pageInfo{hasNextPage endCursor}}}`;
    const first = await graphql({ schema, source, contextValue: { repository } });
    expect(first.errors).toBeUndefined();
    const page = first.data!.networkSnapshots as { nodes: Record<string, unknown>[]; pageInfo: { endCursor: string; hasNextPage: boolean } };
    expect(page.nodes[0]).toMatchObject({ timestamp: 7250, transactions: 21, flowAggregation: 'CALENDAR' });
    expect(page.pageInfo.hasNextPage).toBe(true);
    const second = await graphql({ schema, source, variableValues: { after: page.pageInfo.endCursor }, contextValue: { repository } });
    expect(second.errors).toBeUndefined();
    expect((second.data!.networkSnapshots as { nodes: Record<string, unknown>[] }).nodes[0]).toMatchObject({ timestamp: 7100, transactions: 39 });
  });

  it('includes a lower partial bucket when its source snapshot precedes the query lower bound', async () => {
    const { repository } = await fixture();
    // Exact source-prefix coverage is sufficient; a whole extra hour is unnecessary.
    await repository.deleteMany('networkSnapshots', ['block-99']);
    const result = await graphql({ schema: createSchema(), source: `{networkSnapshots(orderBy:TIMESTAMP_DESC,
      filter:{type:{equalTo:HOUR},timestamp:{greaterThanOrEqualTo:7150,lessThanOrEqualTo:7300}}){
      nodes{timestamp transactions flowAggregation}}}`, contextValue: { repository } });
    expect(result.errors).toBeUndefined();
    expect((result.data!.networkSnapshots as { nodes: unknown[] }).nodes).toEqual([
      { timestamp: 7300, transactions: 33, flowAggregation: 'CALENDAR' },
      { timestamp: 7151, transactions: 17, flowAggregation: 'CALENDAR' },
    ]);
  });

  it('owns equal-timestamp tail blocks by height rather than dropping or counting them twice', async () => {
    const { repository, rows } = await fixture();
    await repository.upsert({ collection: 'networkSnapshots', id: 'block-112', blockHeight: 112, timestamp: 7300,
      data: { id: 'block-112', type: 'BLOCK', timestamp: 7300, ...flows(13) } });
    const projected = await projectNetworkSnapshotFlows(repository, [rows[1]!]);
    expect(projected[0]!.data).toMatchObject({ transactions: 46, fees: (46n * feeUnit).toString(), volumeUSD: '46.00000004' });
  });

  it('does not widen legacy query membership after boundary evidence has expired', async () => {
    const { repository } = await fixture();
    await repository.deleteMany('networkSnapshots', ['block-99', ...blocks().slice(0, 9).map((row) => row.id)]);
    const result = await graphql({ schema: createSchema(), source: `{networkSnapshots(orderBy:TIMESTAMP_DESC,
      filter:{type:{equalTo:HOUR},timestamp:{greaterThanOrEqualTo:3599,lessThanOrEqualTo:7250}}){
      nodes{timestamp flowAggregation}}}`, contextValue: { repository } });
    expect(result.errors).toBeUndefined();
    expect((result.data!.networkSnapshots as { nodes: unknown[] }).nodes).toEqual([
      { timestamp: 7100, flowAggregation: 'LEGACY_ROLLING' },
    ]);
  });

  it('preserves repair-marked rolling values even when an earlier numeric projection is cached', async () => {
    const { repository, rows } = await fixture();
    expect((await projectNetworkSnapshotFlows(repository, rows))[0]!.data.flowAggregation).toBe('CALENDAR');
    rows[0]!.data.networkFlowRepair = { version: 2, status: 'LEGACY_UNVERIFIED', reason: 'Rolling swap count does not reconcile' };
    const projected = (await projectNetworkSnapshotFlows(repository, rows))[0]!;
    expect(projected.data).toMatchObject({ ...rows[0]!.data, flowAggregation: 'LEGACY_ROLLING',
      flowBucketStart: null, flowBucketEnd: null });
    for (const field of NETWORK_FLOW_FIELDS) expect(projected.data[field]).toBe(rows[0]!.data[field]);
  });

  it.each([
    { complete: false },
    { complete: true, bucketEnd: 7201 },
    { complete: true, throughBlock: '108' },
  ])('does not use an incomplete or invalid durable envelope over an unverified rolling marker: %j', async (override) => {
    const { repository, rows } = await fixture();
    const source = rows[0]!;
    source.data.networkFlowRepair = { version: 2, status: 'LEGACY_UNVERIFIED', reason: 'Unprovable original window' };
    source.data.calendarFlows = { version: 1, bucketStart: 3600, bucketEnd: 7200, throughBlock: 108,
      throughTimestamp: 7199, ...flows(39), volumeUSD: '39.00000006', ...override };
    const [projected] = await projectNetworkSnapshotFlows(repository, [source]);
    expect(projected!.data).toMatchObject({ flowAggregation: 'LEGACY_ROLLING', fees: source.data.fees,
      volumeUSD: source.data.volumeUSD });
  });

  it('uses a valid completed calendar record in preference to a rolling repair warning', async () => {
    const { repository, rows } = await fixture();
    const source = rows[0]!;
    source.data.networkFlowRepair = { version: 2, status: 'LEGACY_UNVERIFIED', reason: 'Unprovable original window' };
    source.data.calendarFlows = { version: 1, bucketStart: 3600, bucketEnd: 7200, throughBlock: 108,
      throughTimestamp: 7199, complete: true, ...flows(39), volumeUSD: '39.00000006' };
    const [projected] = await projectNetworkSnapshotFlows(repository, [source]);
    expect(projected!.data).toMatchObject({ flowAggregation: 'CALENDAR', transactions: 39, volumeUSD: '39.00000006' });
    await repository.upsert(source);
    const result = await graphql({ schema: createSchema(), source: `{networkSnapshots(orderBy:TIMESTAMP_DESC,
      filter:{type:{equalTo:HOUR},timestamp:{greaterThanOrEqualTo:3599,lessThanOrEqualTo:3650}}){
      nodes{timestamp transactions flowAggregation}}}`, contextValue: { repository } });
    expect(result.errors).toBeUndefined();
    expect((result.data!.networkSnapshots as { nodes: unknown[] }).nodes).toEqual([
      { timestamp: 3650, transactions: 9, flowAggregation: 'CALENDAR' },
    ]);
  });

  it('does not widen query membership to include a repair-marked unverified rolling row', async () => {
    const { repository, rows } = await fixture();
    rows[1]!.data.networkFlowRepair = { version: 2, status: 'LEGACY_UNVERIFIED', reason: 'Unprovable original window' };
    await repository.upsert(rows[1]!);
    const result = await graphql({ schema: createSchema(), source: `{networkSnapshots(orderBy:TIMESTAMP_DESC,
      filter:{type:{equalTo:HOUR},timestamp:{greaterThanOrEqualTo:3599,lessThanOrEqualTo:7250}}){
      nodes{timestamp transactions flowAggregation}}}`, contextValue: { repository } });
    expect(result.errors).toBeUndefined();
    expect((result.data!.networkSnapshots as { nodes: unknown[] }).nodes).toEqual([
      { timestamp: 7100, transactions: 39, flowAggregation: 'CALENDAR' },
    ]);
  });

  it('uses bounded compact native indexes with source-preserving public pagination', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'network-calendar-native-'));
    const repository = new RocksRepository({ ...readConfig(), storageEngine: 'rocksdb', rocksdbPath: join(directory, 'db'),
      rocksdbBlockCacheMb: 2, rocksdbWriteBufferManagerMb: 2, rocksdbParallelism: 1, rocksdbDocumentCacheMax: 0 });
    try {
      await repository.prepare();
      const seeded = await fixture();
      await repository.upsertMany(await seeded.repository.list('networkSnapshots'));
      const schema = createSchema();
      const source = `query($after:Cursor){networkSnapshots(first:1,after:$after,orderBy:TIMESTAMP_DESC,
        filter:{type:{equalTo:HOUR},timestamp:{greaterThanOrEqualTo:3599,lessThanOrEqualTo:7250}}){
        nodes{transactions flowAggregation} pageInfo{endCursor}}}`;
      const first = await graphql({ schema, source, contextValue: { repository } });
      expect(first.errors).toBeUndefined();
      const data = first.data!.networkSnapshots as { nodes: unknown[]; pageInfo: { endCursor: string } };
      expect(data.nodes).toEqual([{ transactions: 21, flowAggregation: 'CALENDAR' }]);
      const second = await graphql({ schema, source, variableValues: { after: data.pageInfo.endCursor }, contextValue: { repository } });
      expect(second.errors).toBeUndefined();
      expect((second.data!.networkSnapshots as { nodes: unknown[] }).nodes).toEqual([{ transactions: 39, flowAggregation: 'CALENDAR' }]);
    } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
