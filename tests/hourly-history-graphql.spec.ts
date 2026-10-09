import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { graphql, parse, specifiedRules, validate } from 'graphql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readConfig } from '../src/config.js';
import { createSchema } from '../src/graphql/resolvers.js';
import { assetHourlyCoverage } from '../src/graphql/hourly-history.js';
import { createGraphQLQueryLimitsRule } from '../src/graphql/validation.js';
import { RocksRepository } from '../src/repository/rocksdb.js';
import { buildAssetHourlyCloseDocumentsAtBoundary, HOURLY_HISTORY_ASSETS, HOURLY_HISTORY_GENESIS, HOUR_SECONDS } from '../src/worker/hourly-history.js';
import { MemoryRepository } from '../src/repository/memory.js';

import type { IndexerDocument } from '../src/repository/types.js';

describe('public hourly history evidence', () => {
  it('exposes exact evidence and keeps legacy evidence nullable', async () => {
    const repository = new MemoryRepository();
    const evidence = {
      kind: 'finalized-hour-close', availability: 'priced',
      genesisHash: `0x${'1'.repeat(64)}`,
      blockHeight: 123, blockHash: `0x${'2'.repeat(64)}`,
      nextBlockHeight: 124, nextBlockHash: `0x${'3'.repeat(64)}`,
      timestamp: 3599, nextTimestamp: 3601, completedAt: 3600,
      symbol: 'XOR', decimals: 18,
    };
    for (const [id, extra] of [['verified', { closeEvidence: evidence }], ['legacy', {}]] as const) {
      await repository.upsert({
        collection: 'assetSnapshots', id, blockHeight: 123, timestamp: 3599,
        data: {
          id, assetId: 'xor', type: 'HOUR', timestamp: 3599,
          denominator: '100000000000000000000000000000000000000',
          priceUSD: { close: '7.000000000000000019' }, ...extra,
        },
      });
    }
    const response = await graphql({
      schema: createSchema(),
      source: '{ assetSnapshots(first: 10) { nodes { id denominator priceUSD closeEvidence } } }',
      contextValue: { repository },
    });
    expect(response.errors).toBeUndefined();
    const nodes = (response.data?.assetSnapshots as { nodes: Array<Record<string, unknown>> }).nodes;
    expect(nodes.find(({ id }) => id === 'verified')).toMatchObject({
      denominator: '100000000000000000000000000000000000000',
      priceUSD: { close: '7.000000000000000019' },
      closeEvidence: evidence,
    });
    expect(nodes.find(({ id }) => id === 'legacy')?.closeEvidence).toBeNull();
    await repository.close();
  });
});

// Exact operations shipped in BotsPage-BpI6PP3O.js (38913a65…), retained as
// literal fixtures so tests do not depend on a frontend checkout at runtime.
const botHourlyReadiness = `
  query BotHourlyReadiness($assetId: String!, $start: Int!, $end: Int!) {
    data: assetHourlyCoverage(assetId: $assetId, start: $start, end: $end) {
      assetId
      symbol
      start
      end
      asOf
      expectedHours
      observedHours
      verifiedHours
      poolUsableHours
      missingHours
      legacyHours
      invalidHours
      absentPoolHours
      zeroReserveHours
      unknownPoolHours
      latestCompletedAt
      latestUsableCompletedAt
      hours {
        hour
        proofStatus
        poolStatus
        completedAt
        timestamp
        blockHeight
        blockHash
        nextTimestamp
        nextBlockHeight
        nextBlockHash
        denominator
        decimals
      }
    }
  }
`;
const botClosedPoolPrices = `
  query BotClosedPoolPrices($first: Int!, $after: Cursor!, $filter: AssetSnapshotFilter!) {
    data: assetSnapshots(first: $first, after: $after, filter: $filter, orderBy: [TIMESTAMP_ASC]) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          timestamp
          denominator
          closeEvidence
        }
      }
    }
  }
`;
const XOR = HOURLY_HISTORY_ASSETS[0]!.id;
const KUSD = HOURLY_HISTORY_ASSETS[4]!.id;
const firstHour = HOUR_SECONDS;
const denominator = '100000000000000000000000000000000000000';

function closedHour(hour: number, assetId = XOR): IndexerDocument {
  return buildAssetHourlyCloseDocumentsAtBoundary({
    before: { height: 100 + hour / HOUR_SECONDS * 2, hash: `0x${'1'.repeat(64)}`, timestamp: hour + HOUR_SECONDS - 1 },
    after: { height: 101 + hour / HOUR_SECONDS * 2, hash: `0x${'2'.repeat(64)}`, timestamp: hour + HOUR_SECONDS + 1 },
    genesisHash: HOURLY_HISTORY_GENESIS, denominator,
    assets: new Map(HOURLY_HISTORY_ASSETS.map((asset) => [asset.id, { ...asset, decimals: 18 }])),
    prices: new Map(HOURLY_HISTORY_ASSETS.map((asset) => [asset.id, 7_000_000_000_000_000_019n])),
    pools: [{ baseAssetId: XOR, targetAssetId: KUSD, baseAssetReserves: 12_345_678_901_234_567_890n,
      targetAssetReserves: 23_456_789_012_345_678_901n }],
    xorPoolsComplete: true,
  }).find((document) => document.data.assetId === assetId)!;
}

describe('shipped hourly operations for dynamic assets', () => {
  it('returns same-boundary direct-pool evidence with non-18 precision and rename without requiring USD pricing', async () => {
    const grt = { id: '0x00d1fb79bbd1005a678fbf2de9256b3afe260e8eead49bb07bd3a566f9fe8355', symbol: 'GRT' };
    const kcny = { id: '0x0500ed06084001e2d8a5674b9728d2da5ecb0000000000000000000000000000', symbol: 'KCNY' };
    const repository = new MemoryRepository();
    const rows = buildAssetHourlyCloseDocumentsAtBoundary({
      before: { height: 102, hash: `0x${'1'.repeat(64)}`, timestamp: firstHour + HOUR_SECONDS - 1 },
      after: { height: 103, hash: `0x${'2'.repeat(64)}`, timestamp: firstHour + HOUR_SECONDS + 1 },
      genesisHash: HOURLY_HISTORY_GENESIS, denominator, targets: [HOURLY_HISTORY_ASSETS[0]!, grt, kcny],
      assets: new Map([
        [XOR, { id: XOR, symbol: 'XOR', decimals: 18 }],
        [grt.id, { ...grt, symbol: 'OLD_GRT', decimals: 6 }],
        [kcny.id, { ...kcny, decimals: 12 }],
      ]), prices: new Map(), xorPoolsComplete: true,
      pools: [
        { baseAssetId: XOR, targetAssetId: grt.id, baseAssetReserves: 1234567890123456789n, targetAssetReserves: 987654321n },
        { baseAssetId: XOR, targetAssetId: kcny.id, baseAssetReserves: 4321098765432109876n, targetAssetReserves: 12345678901234n },
      ],
    });
    await repository.upsertMany(rows);
    const schema = createSchema();
    for (const target of [grt, kcny]) {
      const coverage = await graphql({ schema, source: botHourlyReadiness,
        variableValues: { assetId: target.id, start: firstHour, end: firstHour + HOUR_SECONDS }, contextValue: { repository } });
      expect(coverage.errors).toBeUndefined();
      expect(coverage.data?.data).toMatchObject({ assetId: target.id, verifiedHours: 1, poolUsableHours: 1,
        hours: [{ blockHeight: 102, nextBlockHeight: 103, denominator, proofStatus: 'VERIFIED', poolStatus: 'USABLE' }] });
      const prices = await graphql({ schema, source: botClosedPoolPrices, variableValues: { first: 100, after: '',
        filter: { assetId: { equalTo: target.id }, type: { equalTo: 'HOUR' },
          timestamp: { greaterThanOrEqualTo: firstHour, lessThan: firstHour + HOUR_SECONDS } } }, contextValue: { repository } });
      expect(prices.errors).toBeUndefined();
      const data = prices.data?.data as { edges: Array<{ node: Record<string, unknown> }> };
      expect(data.edges).toHaveLength(1);
      expect(data.edges[0]!.node).toMatchObject({ denominator, closeEvidence: {
        requestedSymbol: target.symbol, symbol: target.id === grt.id ? 'OLD_GRT' : target.symbol,
        decimals: target.id === grt.id ? 6 : 12, availability: 'price-unavailable',
        xorPool: { baseAssetId: XOR, targetAssetId: target.id, baseDecimals: 18, targetDecimals: target.id === grt.id ? 6 : 12 },
      } });
    }
    expect(rows.every((row) => (row.data.priceUSD as { close: unknown }).close === null)).toBe(true);
  });
});

describe('deployed Bots hourly queries against native RocksDB', () => {
  let directory: string;
  let repository: RocksRepository;
  const config = (path: string) => ({
    ...readConfig(), storageEngine: 'rocksdb' as const, rocksdbPath: path,
    rocksdbBlockCacheMb: 2, rocksdbWriteBufferManagerMb: 2, rocksdbParallelism: 1,
    rocksdbDocumentCacheMax: 0, rocksdbQueryMaxScannedRows: 1_000,
  });
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'polkaswap-hourly-api-'));
    repository = new RocksRepository(config(join(directory, 'hourly.rocksdb')));
    await repository.prepare();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await repository.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('executes the exact 369-hour readiness and closed-pool operations after a compact-store reopen', async () => {
    const rows = Array.from({ length: 369 }, (_, index) => closedHour(firstHour + index * HOUR_SECONDS));
    const poolRow = closedHour(firstHour, KUSD);
    await repository.upsertMany([...rows, poolRow]);
    await repository.close();
    repository = new RocksRepository(config(join(directory, 'hourly.rocksdb')));
    await repository.prepare();
    await expect(repository.get('assetSnapshots', poolRow.id)).resolves.toEqual(poolRow);
    const schema = createSchema();
    const limits = createGraphQLQueryLimitsRule({ maxDepth: 12, maxDocumentNodes: 2_000, maxFields: 500,
      maxAliases: 50, maxFragmentSpreads: 100, maxOperationCost: 100_000, allowIntrospection: false });
    for (const operation of [botHourlyReadiness, botClosedPoolPrices]) {
      expect(validate(schema, parse(operation), [...specifiedRules, limits])).toEqual([]);
    }
    const queried = vi.spyOn(repository, 'query');
    const listed = vi.spyOn(repository, 'list');
    const response = await graphql({
      schema, source: botHourlyReadiness,
      variableValues: { assetId: XOR, start: firstHour, end: firstHour + 369 * HOUR_SECONDS },
      contextValue: { repository },
    });
    expect(response.errors).toBeUndefined();
    const coverage = response.data?.data as { hours: Array<Record<string, unknown>> };
    expect(coverage).toMatchObject({
      assetId: XOR, symbol: 'XOR', expectedHours: 369, observedHours: 369, verifiedHours: 369, poolUsableHours: 369,
      missingHours: 0, legacyHours: 0, invalidHours: 0, absentPoolHours: 0, zeroReserveHours: 0, unknownPoolHours: 0,
      latestCompletedAt: firstHour + 369 * HOUR_SECONDS, latestUsableCompletedAt: firstHour + 369 * HOUR_SECONDS,
    });
    expect(coverage.hours).toHaveLength(369);
    expect(coverage.hours[0]).toMatchObject({ proofStatus: 'VERIFIED', poolStatus: 'XOR_SELF', denominator });
    expect(queried).toHaveBeenCalledTimes(4);
    expect(listed).not.toHaveBeenCalled();
    for (const [collection, args] of queried.mock.calls) {
      expect(collection).toBe('assetSnapshots');
      expect(args).toMatchObject({ first: 100, includeTotalCount: false, maxBytes: 512 * 1024,
        orderBy: ['TIMESTAMP_ASC'], filter: { assetId: { equalTo: XOR }, type: { equalTo: 'HOUR' },
          timestamp: { greaterThanOrEqualTo: firstHour, lessThan: firstHour + 369 * HOUR_SECONDS } } });
    }
    expect(queried.mock.calls[1]![1].seek).toMatchObject({ field: 'timestamp', id: rows[99]!.id, direction: 'asc' });
    const poolResponse = await graphql({
      schema, source: botClosedPoolPrices,
      variableValues: { first: 100, after: '', filter: { assetId: { equalTo: KUSD }, type: { equalTo: 'HOUR' },
        timestamp: { greaterThanOrEqualTo: firstHour, lessThan: firstHour + HOUR_SECONDS } } },
      contextValue: { repository },
    });
    expect(poolResponse.errors).toBeUndefined();
    expect(poolResponse.data?.data).toMatchObject({ pageInfo: { hasNextPage: false }, edges: [{ node: {
      timestamp: poolRow.timestamp, denominator, closeEvidence: poolRow.data.closeEvidence,
    } }] });
    expect((poolRow.data.priceUSD as { close: string }).close).toBe('7.000000000000000019');
    expect((poolRow.data.closeEvidence as { xorPool: { baseAssetReserves: string } }).xorPool.baseAssetReserves)
      .toBe('12345678901234567890');
  });

  it('keeps legacy, malformed and duplicate cold rows unusable across bounded seek pages and rereads new evidence', async () => {
    const valid = closedHour(firstHour, KUSD);
    const legacy = closedHour(firstHour + HOUR_SECONDS, KUSD); delete legacy.data.closeEvidence;
    const invalid = closedHour(firstHour + 2 * HOUR_SECONDS, KUSD);
    (invalid.data.closeEvidence as Record<string, unknown>).nextBlockHeight = invalid.blockHeight! + 2;
    const duplicate = closedHour(firstHour + 3 * HOUR_SECONDS, KUSD);
    const coldDuplicate = structuredClone(duplicate);
    coldDuplicate.id += '-cold'; coldDuplicate.data.id = coldDuplicate.id;
    for (const row of [duplicate, coldDuplicate]) row.data.padding = 'x'.repeat(160_000);
    await repository.upsertMany([valid, legacy, invalid, duplicate, coldDuplicate]);
    // Distracting documents must not affect this asset/type/range scan.
    await repository.upsertMany(Array.from({ length: 1_001 }, (_, index) => ({
      ...closedHour(firstHour + index * HOUR_SECONDS), id: `other-${index}`,
      data: { id: `other-${index}`, assetId: XOR, type: 'HOUR', timestamp: firstHour + (index + 1) * HOUR_SECONDS - 1 },
    })));
    const listed = vi.spyOn(repository, 'list');
    const queried = vi.spyOn(repository, 'query');
    const args = { assetId: KUSD, start: firstHour, end: firstHour + 5 * HOUR_SECONDS };
    const coverage = await assetHourlyCoverage(repository, args);
    expect(coverage).toMatchObject({ expectedHours: 5, observedHours: 4, verifiedHours: 1, poolUsableHours: 1,
      missingHours: 1, legacyHours: 1, invalidHours: 2,
      gaps: [
        { start: firstHour + HOUR_SECONDS, end: firstHour + 2 * HOUR_SECONDS, hours: 1, status: 'LEGACY' },
        { start: firstHour + 2 * HOUR_SECONDS, end: firstHour + 4 * HOUR_SECONDS, hours: 2, status: 'INVALID' },
        { start: firstHour + 4 * HOUR_SECONDS, end: firstHour + 5 * HOUR_SECONDS, hours: 1, status: 'MISSING' },
      ] });
    expect(queried.mock.calls.length).toBeGreaterThan(1);
    expect(queried.mock.calls[1]![1].seek).toBeDefined();
    expect(listed).not.toHaveBeenCalled();
    await repository.upsert(closedHour(firstHour + 4 * HOUR_SECONDS, KUSD));
    await expect(assetHourlyCoverage(repository, args)).resolves.toMatchObject({
      verifiedHours: 2, poolUsableHours: 2, missingHours: 0,
      latestUsableCompletedAt: firstHour + 5 * HOUR_SECONDS,
    });
    const response = await graphql({ schema: createSchema(), source: botClosedPoolPrices,
      variableValues: { first: 100, after: '', filter: { assetId: { equalTo: KUSD }, type: { equalTo: 'HOUR' } } },
      contextValue: { repository } });
    expect(response.errors).toBeUndefined();
    const edges = (response.data?.data as { edges: Array<{ node: { timestamp: number; closeEvidence: unknown } }> }).edges;
    expect(edges.find(({ node }) => node.timestamp === legacy.timestamp)?.node.closeEvidence).toBeNull();
  });
});
