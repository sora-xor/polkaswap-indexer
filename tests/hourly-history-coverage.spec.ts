import { graphql, parse, specifiedRules, validate } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import { assetHourlyCoverage, hourlyCloseMetadata } from '../src/graphql/hourly-history.js';
import { createSchema } from '../src/graphql/resolvers.js';
import { createGraphQLQueryLimitsRule } from '../src/graphql/validation.js';
import { MemoryRepository } from '../src/repository/memory.js';
import type { IndexerDocument, IndexerRepository } from '../src/repository/types.js';
import {
  buildAssetHourlyCloseDocumentsAtBoundary, HOURLY_HISTORY_ASSETS, HOURLY_HISTORY_GENESIS, HOUR_SECONDS,
  type AssetHourlyCloseInput,
} from '../src/worker/hourly-history.js';

const XOR = HOURLY_HISTORY_ASSETS[0]!.id;
const KUSD = HOURLY_HISTORY_ASSETS[4]!.id;
const LLM = HOURLY_HISTORY_ASSETS[6]!.id;
const schema = createSchema();
const start = HOUR_SECONDS;
const end = start + HOUR_SECONDS;
const args = { assetId: KUSD, start, end };

/** Synthetic finalized observations from the real collector; no market files or external services. */
function observation(hour = start, assetId = KUSD, change?: (input: AssetHourlyCloseInput) => void): IndexerDocument {
  const source: AssetHourlyCloseInput = {
    before: { height: 100 + hour / HOUR_SECONDS * 2, hash: `0x${'1'.repeat(64)}`, timestamp: hour + HOUR_SECONDS - 1 },
    after: { height: 101 + hour / HOUR_SECONDS * 2, hash: `0x${'2'.repeat(64)}`, timestamp: hour + HOUR_SECONDS + 1 },
    genesisHash: HOURLY_HISTORY_GENESIS, denominator: '100000000000000000000000000000000000000',
    assets: new Map(HOURLY_HISTORY_ASSETS.map((asset) => [asset.id, { ...asset, decimals: 18 }])),
    prices: new Map(HOURLY_HISTORY_ASSETS.map((asset) => [asset.id, 10n ** 18n])),
    pools: [{ baseAssetId: XOR, targetAssetId: KUSD, baseAssetReserves: 123n, targetAssetReserves: 456n }],
    xorPoolsComplete: true,
  };
  change?.(source);
  return buildAssetHourlyCloseDocumentsAtBoundary(source).find((row) => row.data.assetId === assetId)!;
}

const proof = (row: IndexerDocument) => row.data.closeEvidence as Record<string, unknown>;
const pool = (row: IndexerDocument) => proof(row).xorPool as Record<string, unknown>;
const selection = `assetId symbol start end asOf expectedHours observedHours verifiedHours poolUsableHours
  missingHours legacyHours invalidHours absentPoolHours zeroReserveHours unknownPoolHours
  latestCompletedAt latestObservedCompletedAt latestUsableCompletedAt
  hours { hour proofStatus poolStatus completedAt timestamp blockHeight blockHash nextTimestamp
    nextBlockHeight nextBlockHash denominator decimals }
  gaps { start end hours status }`;
const query = `query Coverage($assetId: String!, $start: Int!, $end: Int!) {
  assetHourlyCoverage(assetId: $assetId, start: $start, end: $end) { ${selection} }
}`;
const execute = (repository: IndexerRepository, variables = args) => graphql({
  schema, source: query, variableValues: variables, contextValue: { repository },
});

describe('hourly coverage proof projection', () => {
  it('retains exact provenance while excluding all prices, reserves and discovery routes', () => {
    const row = observation(start, KUSD, (source) => { source.assets.get(KUSD)!.decimals = 6; });
    expect(hourlyCloseMetadata(row, KUSD, start)).toEqual({
      hour: start, proofStatus: 'VERIFIED', poolStatus: 'USABLE', completedAt: end,
      timestamp: end - 1, blockHeight: 102, blockHash: `0x${'1'.repeat(64)}`,
      nextTimestamp: end + 1, nextBlockHeight: 103, nextBlockHash: `0x${'2'.repeat(64)}`,
      denominator: row.data.denominator, decimals: 6,
    });
    expect(JSON.stringify(hourlyCloseMetadata(row, KUSD, start)))
      .not.toMatch(/"(?:priceUSD|xorPool|pools|baseAssetReserves|targetAssetReserves)":/);
    expect(validate(schema, parse(`{ assetHourlyCoverage(assetId: "${KUSD}", start: ${start}, end: ${end}) {
      hours { priceUSD xorPool baseAssetReserves } } }`)).map((error) => error.message))
      .toEqual(expect.arrayContaining([expect.stringContaining('Cannot query field "priceUSD"')]));
  });

  it('distinguishes legacy, unknown direct evidence, absent pool, zero reserve and the XOR self anchor', () => {
    const legacy = observation(); delete legacy.data.closeEvidence;
    const unknown = observation(); delete proof(unknown).xorPool;
    const absent = observation(start, LLM);
    const zero = observation(); pool(zero).baseAssetReserves = '0';
    const xor = observation(start, XOR);
    expect([legacy, unknown, absent, zero, xor].map((row) => {
      const result = hourlyCloseMetadata(row, row.data.assetId as string, start);
      return [result.proofStatus, result.poolStatus];
    })).toEqual([
      ['LEGACY', 'UNKNOWN'], ['VERIFIED', 'UNKNOWN'], ['VERIFIED', 'ABSENT'],
      ['VERIFIED', 'ZERO_RESERVE'], ['VERIFIED', 'XOR_SELF'],
    ]);
  });

  it('keeps unavailable metadata unknown, and does not require a USD price for verified direct evidence', () => {
    const missing = observation(start, KUSD, (source) => { source.assets.delete(KUSD); });
    const unpriced = observation(start, KUSD, (source) => { source.prices.delete(KUSD); });
    expect(hourlyCloseMetadata(missing, KUSD, start)).toMatchObject({ proofStatus: 'VERIFIED', poolStatus: 'UNKNOWN' });
    expect(hourlyCloseMetadata(missing, KUSD, start)).not.toHaveProperty('decimals');
    expect(hourlyCloseMetadata(unpriced, KUSD, start)).toMatchObject({ proofStatus: 'VERIFIED', poolStatus: 'USABLE' });
    proof(missing).xorPool = null;
    expect(hourlyCloseMetadata(missing, KUSD, start).proofStatus).toBe('INVALID');
  });

  it.each([
    ['noncanonical document', (row: IndexerDocument) => { row.id += '-alias'; }],
    ['mismatched data identity', (row: IndexerDocument) => { row.data.assetId = XOR; }],
    ['timestamp mismatch', (row: IndexerDocument) => { row.data.timestamp = end - 2; }],
    ['wrong genesis', (row: IndexerDocument) => { proof(row).genesisHash = `0x${'f'.repeat(64)}`; }],
    ['wrong symbol', (row: IndexerDocument) => { proof(row).requestedSymbol = 'DAI'; }],
    ['nonadjacent blocks', (row: IndexerDocument) => { proof(row).nextBlockHeight = 104; }],
    ['equal hashes', (row: IndexerDocument) => { proof(row).nextBlockHash = proof(row).blockHash; }],
    ['late boundary', (row: IndexerDocument) => { proof(row).nextTimestamp = end + HOUR_SECONDS; }],
    ['future timestamp', (row: IndexerDocument) => { row.timestamp = end; }],
    ['zero denominator', (row: IndexerDocument) => { row.data.denominator = '0'; }],
    ['noncanonical denominator', (row: IndexerDocument) => { row.data.denominator = '01'; }],
    ['overflow denominator', (row: IndexerDocument) => { row.data.denominator = (1n << 128n).toString(); }],
    ['foreign base asset', (row: IndexerDocument) => { pool(row).baseAssetId = LLM; }],
    ['wrong base precision', (row: IndexerDocument) => { pool(row).baseDecimals = 6; }],
    ['wrong target precision', (row: IndexerDocument) => { pool(row).targetDecimals = 6; }],
    ['negative reserve', (row: IndexerDocument) => { pool(row).baseAssetReserves = '-1'; }],
    ['overflow reserve', (row: IndexerDocument) => { pool(row).targetAssetReserves = (1n << 128n).toString(); }],
    ['exponent reserve', (row: IndexerDocument) => { pool(row).targetAssetReserves = '1e18'; }],
    ['unknown availability', (row: IndexerDocument) => { proof(row).availability = 'available'; }],
  ])('rejects %s without promoting its metadata', (_name, change) => {
    const row = observation(); change(row);
    expect(hourlyCloseMetadata(row, KUSD, start)).toEqual({ hour: start, proofStatus: 'INVALID', poolStatus: 'UNKNOWN' });
  });

  it('does not invoke accessors in stored evidence', () => {
    const row = observation(); const getter = vi.fn(() => 18);
    Object.defineProperty(proof(row), 'decimals', { get: getter });
    expect(hourlyCloseMetadata(row, KUSD, start).proofStatus).toBe('INVALID');
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects nonstandard XOR precision and a fabricated direct XOR/XOR pool', () => {
    const row = observation(start, XOR); proof(row).decimals = 6;
    expect(hourlyCloseMetadata(row, XOR, start).proofStatus).toBe('INVALID');
    proof(row).decimals = 18; proof(row).xorPool = pool(observation());
    expect(hourlyCloseMetadata(row, XOR, start).proofStatus).toBe('INVALID');
  });
});

describe('public hourly coverage resolver', () => {
  it('separates stored, verified and usable counts and compresses only adjacent equal gaps', async () => {
    const repository = new MemoryRepository();
    const rows = [0, 1, 2, 3, 4, 5, 6, 8].map((index) => observation(start + index * HOUR_SECONDS));
    delete rows[1]!.data.closeEvidence;
    delete rows[2]!.data.closeEvidence;
    delete proof(rows[3]!).xorPool;
    proof(rows[4]!).xorPool = null;
    pool(rows[5]!).targetAssetReserves = '0';
    proof(rows[6]!).nextBlockHash = proof(rows[6]!).blockHash;
    delete rows[7]!.data.closeEvidence;
    await repository.upsertMany(rows);
    const result = await execute(repository, { ...args, end: start + 9 * HOUR_SECONDS });
    expect(result.errors).toBeUndefined();
    expect(result.data?.assetHourlyCoverage).toMatchObject({
      expectedHours: 9, observedHours: 8, verifiedHours: 4, poolUsableHours: 1,
      missingHours: 1, legacyHours: 3, invalidHours: 1, unknownPoolHours: 1, absentPoolHours: 1, zeroReserveHours: 1,
      latestCompletedAt: start + 6 * HOUR_SECONDS, latestObservedCompletedAt: start + 9 * HOUR_SECONDS,
      latestUsableCompletedAt: end,
      gaps: [
        { start: start + HOUR_SECONDS, end: start + 3 * HOUR_SECONDS, hours: 2, status: 'LEGACY' },
        ...['UNKNOWN_POOL', 'ABSENT_POOL', 'ZERO_RESERVE', 'INVALID', 'MISSING', 'LEGACY'].map((status, index) => ({
          start: start + (3 + index) * HOUR_SECONDS, end: start + (4 + index) * HOUR_SECONDS, hours: 1, status,
        })),
      ],
    });
  });

  it('reads new finalized rows on every request across a full day without caching', async () => {
    const repository = new MemoryRepository();
    const window = { ...args, end: start + 24 * HOUR_SECONDS };
    const initial = await execute(repository, window);
    expect(initial.errors).toBeUndefined();
    expect(initial.data?.assetHourlyCoverage).toMatchObject({ observedHours: 0, missingHours: 24, latestCompletedAt: null });
    for (let index = 0; index < 24; index++) {
      await repository.upsert(observation(start + index * HOUR_SECONDS));
      const result = await execute(repository, window);
      expect(result.errors).toBeUndefined();
      expect(result.data?.assetHourlyCoverage).toMatchObject({
        observedHours: index + 1, verifiedHours: index + 1, poolUsableHours: index + 1,
        missingHours: 23 - index, latestCompletedAt: start + (index + 1) * HOUR_SECONDS,
      });
    }
  });

  it('keeps duplicates invalid across byte-limited seek pages, including a third row in the same hour', async () => {
    const repository = new MemoryRepository();
    const rows = ['', '-a', '-b'].map((suffix) => {
      const row = observation(); row.id += suffix; row.data.id = row.id; row.data.padding = 'x'.repeat(160_000); return row;
    });
    await repository.upsertMany(rows);
    const queried = vi.spyOn(repository, 'query');
    const result = await execute(repository);
    expect(result.errors).toBeUndefined();
    expect(result.data?.assetHourlyCoverage).toMatchObject({
      observedHours: 1, verifiedHours: 0, poolUsableHours: 0, invalidHours: 1,
      latestCompletedAt: null, latestObservedCompletedAt: end,
      hours: [{ hour: start, proofStatus: 'INVALID', poolStatus: 'UNKNOWN' }],
    });
    expect(queried).toHaveBeenCalledTimes(3);
    expect(queried.mock.calls[1]![1]).toMatchObject({
      maxBytes: 512 * 1024, includeTotalCount: false,
      seek: { field: 'timestamp', value: end - 1, id: rows[0]!.id, direction: 'asc' },
    });
  });

  it('follows count-limited pages for a populated 90-day window', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany(Array.from({ length: 2160 }, (_, index) => observation(start + index * HOUR_SECONDS)));
    const result = await assetHourlyCoverage(repository, { ...args, end: start + 2160 * HOUR_SECONDS });
    expect(result).toMatchObject({ expectedHours: 2160, verifiedHours: 2160, poolUsableHours: 2160, gaps: [] });
    expect(result.hours).toHaveLength(2160);
    expect(result.latestUsableCompletedAt).toBe(start + 2160 * HOUR_SECONDS);
  });

  it.each(HOURLY_HISTORY_ASSETS)('supports canonical $symbol without assuming a direct pool exists', async (asset) => {
    const repository = new MemoryRepository();
    await repository.upsert(observation(start, asset.id));
    const result = await execute(repository, { ...args, assetId: asset.id });
    expect(result.errors).toBeUndefined();
    expect(result.data?.assetHourlyCoverage).toMatchObject({ symbol: asset.symbol, verifiedHours: 1,
      poolUsableHours: [XOR, KUSD].includes(asset.id) ? 1 : 0,
    });
  });

  it('classifies oversized GraphQL Int block heights as invalid without failing serialization', async () => {
    const repository = new MemoryRepository(); const row = observation();
    proof(row).blockHeight = 2_147_483_647; proof(row).nextBlockHeight = 2_147_483_648;
    await repository.upsert(row);
    const result = await execute(repository);
    expect(result.errors).toBeUndefined();
    expect(result.data?.assetHourlyCoverage).toMatchObject({ invalidHours: 1, verifiedHours: 0,
      hours: [{ blockHeight: null, nextBlockHeight: null, proofStatus: 'INVALID' }],
    });
  });

  it.each([
    { assetId: 'KUSD' }, { start: -HOUR_SECONDS }, { start: start + 1 }, { end: end + 1 },
    { end: start }, { end: start - HOUR_SECONDS }, { end: start + 2161 * HOUR_SECONDS },
    { end: start + 2 * HOUR_SECONDS }, { start: NaN }, { end: Infinity },
  ])('rejects invalid or unfinished ranges before reading storage: %o', async (change) => {
    const repository = new MemoryRepository(); const queried = vi.spyOn(repository, 'query');
    await expect(assetHourlyCoverage(repository, { ...args, ...change }, end * 1000))
      .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(queried).not.toHaveBeenCalled();
  });

  it('fails closed without indexed queries or on a broken page instead of scanning all documents', async () => {
    const repository = new MemoryRepository(); const list = vi.spyOn(repository, 'list');
    Object.defineProperty(repository, 'query', { value: undefined, configurable: true });
    await expect(assetHourlyCoverage(repository, args)).rejects.toThrow('requires indexed');
    expect(list).not.toHaveBeenCalled();
    Object.defineProperty(repository, 'query', { value: vi.fn(async () => ({ items: [], totalCount: null, hasNextPage: true })), configurable: true });
    await expect(assetHourlyCoverage(repository, args)).rejects.toMatchObject({ extensions: { code: 'GRAPHQL_EXECUTION_MEMORY_LIMIT_EXCEEDED' } });
  });

  it('enforces bounded rows, bytes, range and progressing cursors', async () => {
    const repository = new MemoryRepository(); const row = observation();
    const queried = vi.spyOn(repository, 'query');
    queried.mockResolvedValue({ items: Array.from({ length: 4321 }, () => row), totalCount: null });
    await expect(assetHourlyCoverage(repository, args)).rejects.toThrow('bounded repository scan');
    queried.mockResolvedValue({ items: [{ ...row, timestamp: end }], totalCount: null });
    await expect(assetHourlyCoverage(repository, args)).rejects.toThrow('out-of-range');
    queried.mockResolvedValue({ items: [row], totalCount: null, hasNextPage: true });
    await expect(assetHourlyCoverage(repository, args)).rejects.toThrow('bounded repository scan');
    row.data.padding = 'x'.repeat(17 * 1024 * 1024);
    queried.mockResolvedValue({ items: [row], totalCount: null });
    await expect(assetHourlyCoverage(repository, args)).rejects.toThrow('bounded repository scan');
  });

  it('admits the documented public query and charges each alias against the default operation budget', () => {
    const limits = createGraphQLQueryLimitsRule({ maxDepth: 12, maxDocumentNodes: 2000, maxFields: 500,
      maxAliases: 50, maxFragmentSpreads: 100, maxOperationCost: 100_000, allowIntrospection: false });
    expect(validate(schema, parse(query), [...specifiedRules, limits])).toEqual([]);
    const field = `assetHourlyCoverage(assetId: "${KUSD}", start: ${start}, end: ${end}) { expectedHours }`;
    expect(validate(schema, parse(`{ first: ${field} second: ${field} }`), [...specifiedRules, limits])
      .map((error) => error.message)).toContainEqual(expect.stringContaining('estimated cost'));
  });
});
