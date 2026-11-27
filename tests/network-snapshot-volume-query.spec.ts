import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { graphql } from 'graphql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readConfig } from '../src/config.js';
import { validatePublicConnectionQuery } from '../src/graphql/query-policy.js';
import { createSchema } from '../src/graphql/resolvers.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { RocksRepository } from '../src/repository/rocksdb.js';
import { PINNED_NETWORK_VOLUME_QUERIES, PINNED_NETWORK_VOLUME_SOURCE } from './pinned-network-volume-fixture.js';

import type { IndexerDocument, IndexerRepository, RepositoryQueryArgs } from '../src/repository/types.js';

const range = { timestamp: { greaterThanOrEqualTo: 100, lessThanOrEqualTo: 200 } };
const bounded = (metric: 'fees' | 'volumeUSD', condition: unknown = { greaterThan: '0' }) => ({
  and: [{ type: { equalTo: 'BLOCK' } }, range, { [metric]: condition }],
});

describe('shipped network metric public filter bounds', () => {
  it('pins all four complete frontend operations and the genuine public regression evidence', () => {
    expect(PINNED_NETWORK_VOLUME_SOURCE).toEqual({
      source: 'src/indexer/queries/network/volume.ts',
      sourceSha256: 'da65aaa6013d4672527e8d02f6d5f3ae6b101e3fe6390c1092337e7b2dcad429',
      actualPublicDiagnosticSha256: '86602c949c9a54193ad13371d8dc61d5680286aaa3bd754771d428404c6f526c',
    });
    expect(PINNED_NETWORK_VOLUME_QUERIES).toHaveLength(4);
    for (const fixture of PINNED_NETWORK_VOLUME_QUERIES) {
      expect(createHash('sha256').update(fixture.query).digest('hex')).toBe(fixture.querySha256);
    }
  });

  it.each(['fees', 'volumeUSD'] as const)('retains conjunctive anchors and bounded direct-ID reads for %s', (metric) => {
    expect(() => validatePublicConnectionQuery('networkSnapshots', ['TIMESTAMP_DESC'], bounded(metric))).not.toThrow();
    expect(() => validatePublicConnectionQuery('networkSnapshots', ['TIMESTAMP_ASC'], {
      and: [{ type: { eq: 'BLOCK' } }, { timestamp: { gte: 100 } }, { timestamp: { lte: 200 } }, { [metric]: { gt: '0' } }],
    })).not.toThrow();
    // The primary-ID path already bounds the number of document reads.
    expect(() => validatePublicConnectionQuery('networkSnapshots', ['FEES_DESC'], {
      id: { in: ['block-a', 'block-b'] }, [metric]: { greaterThan: '0' },
    })).not.toThrow();
    for (const filter of [
      { type: { equalTo: 'BLOCK' }, [metric]: { greaterThan: '0' } },
      { type: { equalTo: 'BLOCK' }, timestamp: { gte: 100 }, [metric]: { greaterThan: '0' } },
      { type: { equalTo: 'BLOCK' }, timestamp: { lte: 200 }, [metric]: { greaterThan: '0' } },
      { ...range, [metric]: { greaterThan: '0' } },
      { ...range, type: { in: ['BLOCK', 'HOUR'] }, [metric]: { greaterThan: '0' } },
      { type: { equalTo: 'BLOCK' }, [metric]: { greaterThan: '0' }, or: [{ timestamp: { gte: 100 } }, { timestamp: { lte: 200 } }] },
      { or: [bounded(metric), { type: { equalTo: 'HOUR' }, ...range, [metric]: { greaterThan: '0' } }] },
    ]) {
      expect(() => validatePublicConnectionQuery('networkSnapshots', ['TIMESTAMP_DESC'], filter)).toThrow('not backed by a bounded public storage plan');
    }
    for (const orderBy of ['ID_ASC', 'BLOCK_HEIGHT_DESC', 'FEES_DESC', 'VOLUME_USD_DESC']) {
      expect(() => validatePublicConnectionQuery('networkSnapshots', [orderBy], bounded(metric))).toThrow();
    }
    expect(() => validatePublicConnectionQuery('networkSnapshots', ['BLOCK_HEIGHT_DESC'], {
      type: { equalTo: 'BLOCK' }, blockHeight: { gte: 1, lte: 10 }, [metric]: { greaterThan: '0' },
    })).toThrow();
  });

  it.each(['fees', 'volumeUSD'] as const)('keeps finite plain-decimal validation and unsupported fields for %s', (metric) => {
    for (const value of [Number.NaN, Infinity, -Infinity, 'NaN', 'Infinity', '1e0', '0e0', ' 0', true, null]) {
      expect(() => validatePublicConnectionQuery('networkSnapshots', ['TIMESTAMP_DESC'], bounded(metric, { greaterThan: value }))).toThrow();
    }
    expect(() => validatePublicConnectionQuery('networkSnapshots', ['TIMESTAMP_DESC'], {
      ...bounded(metric), transactions: { greaterThan: '0' },
    })).toThrow('filter field transactions');
    expect(() => validatePublicConnectionQuery('networkSnapshots', ['TIMESTAMP_DESC'], bounded(metric, { includesInsensitive: '0' }))).toThrow();
  });
});

const snapshot = (id: string, timestamp: number, type: 'HOUR' | 'BLOCK', volumeUSD: string, fees: string): IndexerDocument => ({
  collection: 'networkSnapshots', id, timestamp, blockHeight: timestamp,
  data: { id, timestamp, blockHeight: timestamp, type, volumeUSD, fees },
});
const documents = [
  snapshot('hour', 150, 'HOUR', '12.34000001', '9007199254740993'),
  snapshot('old', 99, 'BLOCK', '10', '10'), snapshot('new', 201, 'BLOCK', '10', '10'),
  snapshot('negative', 101, 'BLOCK', '-0.00000001', '-1'), snapshot('zero', 102, 'BLOCK', '0', '0'),
  snapshot('tiny', 120, 'BLOCK', '0.000000000000000001', '1'),
  snapshot('large', 130, 'BLOCK', '0.5', '90071992547409931234567890'),
  snapshot('fee-only', 140, 'BLOCK', '0', '1'), snapshot('volume-only', 145, 'BLOCK', '3.5', '0'),
  snapshot('tie-a', 150, 'BLOCK', '0.75', '2'), snapshot('tie-z', 150, 'BLOCK', '0.125', '3'),
];
const expectedMetricRows = (metric: 'fees' | 'volumeUSD', type: 'HOUR' | 'BLOCK') => {
  const ids = type === 'HOUR' ? ['hour'] : metric === 'fees'
    ? ['tie-z', 'tie-a', 'fee-only', 'large', 'tiny']
    : ['tie-z', 'tie-a', 'volume-only', 'large', 'tiny'];
  return ids.map((id) => {
    const document = documents.find((item) => item.id === id)!;
    return { timestamp: document.timestamp, [metric]: document.data[metric] };
  });
};
type WireConnection = { edges: Array<{ node: Record<string, unknown> }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
const execute = (repository: IndexerRepository, query: string, type: 'HOUR' | 'BLOCK', after: string | null = null) =>
  graphql({ schema: createSchema(), source: query, variableValues: { after, type, from: 200, to: 100 }, contextValue: { repository } });
const nativeConfig = (path: string) => ({
  ...readConfig(), storageEngine: 'rocksdb' as const, rocksdbPath: path,
  rocksdbBlockCacheMb: 2, rocksdbWriteBufferManagerMb: 2, rocksdbParallelism: 1, rocksdbDocumentCacheMax: 0,
});

describe('real frontend network queries through memory and compact native timestamp plans', () => {
  let directory: string;
  let memory: MemoryRepository;
  let native: RocksRepository;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'polkaswap-network-volume-query-'));
    memory = new MemoryRepository();
    native = new RocksRepository(nativeConfig(join(directory, 'network.rocksdb')));
    await native.prepare();
    await memory.upsertMany(documents);
    await native.upsertMany(documents);
  });
  afterEach(async () => {
    await native.close();
    await memory.close();
    await rm(directory, { recursive: true, force: true });
  });

  it.each(PINNED_NETWORK_VOLUME_QUERIES)('executes exact $operation and preserves metric units', async ({ query, metric, type }) => {
    for (const repository of [memory, native]) {
      // These synthetic noncanonical block IDs exercise filter/cursor behavior,
      // not calendar evidence. Legacy HOUR units stay available without BLOCK
      // coverage; canonical rebucketing is covered by network-calendar-flow.spec.
      if (type === 'HOUR') await repository.deleteMany('networkSnapshots',
        documents.filter((document) => document.data.type === 'BLOCK').map((document) => document.id));
      const result = await execute(repository, query, type);
      expect(result.errors).toBeUndefined();
      const connection = result.data?.data as WireConnection;
      expect(connection.edges.map(({ node }) => node)).toEqual(expectedMetricRows(metric, type));
      expect(connection.pageInfo.hasNextPage).toBe(false);
      expect(connection.pageInfo.endCursor).toMatch(/^psc2\./);
    }
  });

  it.each(['fees', 'volumeUSD'] as const)('walks bounded %s keyset pages without losing timestamp ties', async (metric) => {
    const fixture = PINNED_NETWORK_VOLUME_QUERIES.find((item) => item.type === 'BLOCK' && item.metric === metric)!;
    // A supplemental page-size variant; the complete unchanged literal runs above.
    const query = fixture.query.replace('data: networkSnapshots(', 'data: networkSnapshots(first: 2,');
    for (const repository of [memory, native]) {
      let after: string | null = null;
      const rows: Record<string, unknown>[] = [];
      for (let page = 0; page < 3; page += 1) {
        const result = await execute(repository, query, 'BLOCK', after);
        expect(result.errors).toBeUndefined();
        const connection = result.data?.data as WireConnection;
        rows.push(...connection.edges.map(({ node }) => node));
        expect(connection.pageInfo.hasNextPage).toBe(page < 2);
        expect(connection.pageInfo.endCursor).not.toBe(after);
        after = connection.pageInfo.endCursor;
      }
      expect(rows).toEqual(expectedMetricRows(metric, 'BLOCK'));
      const other = PINNED_NETWORK_VOLUME_QUERIES.find((item) => item.type === 'BLOCK' && item.metric !== metric)!;
      expect((await execute(repository, other.query, 'BLOCK', after)).errors).toBeDefined();
    }
  });

  it('uses the existing type/timestamp compact source for metric residuals', () => {
    const planner = native as unknown as { selectQuerySource(collection: 'networkSnapshots', args: RepositoryQueryArgs): { reason: string; preservesOrder: boolean } };
    for (const metric of ['fees', 'volumeUSD'] as const) {
      expect(planner.selectQuerySource('networkSnapshots', { first: 100, orderBy: ['TIMESTAMP_DESC'], filter: bounded(metric), includeTotalCount: false }))
        .toMatchObject({ reason: 'x:y-t', preservesOrder: true });
    }
  });

  it('charges residual misses and total counts against the unchanged native scan limit', async () => {
    const budgeted = new RocksRepository({ ...nativeConfig(join(directory, 'budget.rocksdb')), rocksdbQueryMaxScannedRows: 2 });
    try {
      await budgeted.prepare();
      await budgeted.upsertMany([
        ...Array.from({ length: 500 }, (_, index) => snapshot(`outside-${index}`, index % 100, 'BLOCK', '1', '1')),
        snapshot('match-a', 180, 'BLOCK', '0.000000000000000001', '1'), snapshot('match-b', 190, 'BLOCK', '0.5', '90071992547409931234567890'),
      ]);
      for (const metric of ['fees', 'volumeUSD'] as const) {
        const args = { orderBy: ['TIMESTAMP_DESC'], filter: bounded(metric) };
        await expect(budgeted.query('networkSnapshots', { ...args, first: 100, includeTotalCount: true }))
          .resolves.toMatchObject({ totalCount: 2, items: [expect.objectContaining({ id: 'match-b' }), expect.objectContaining({ id: 'match-a' })] });
      }
      await budgeted.upsertMany([snapshot('miss-a', 110, 'BLOCK', '0', '0'), snapshot('miss-b', 120, 'BLOCK', '0', '0'), snapshot('miss-c', 130, 'BLOCK', '0', '0')]);
      for (const metric of ['fees', 'volumeUSD'] as const) {
        const args = { orderBy: ['TIMESTAMP_DESC'], filter: bounded(metric) };
        await expect(budgeted.query('networkSnapshots', { ...args, first: 1, includeTotalCount: false })).resolves.toMatchObject({ hasNextPage: true });
        await expect(budgeted.query('networkSnapshots', { ...args, first: 1, includeTotalCount: true })).rejects.toThrow('2 row scan limit');
        await expect(budgeted.query('networkSnapshots', { ...args, first: 100, includeTotalCount: false })).rejects.toThrow('2 row scan limit');
      }
    } finally {
      await budgeted.close();
    }
  });
});
