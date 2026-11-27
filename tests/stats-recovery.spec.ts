import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { graphql, parse, subscribe } from 'graphql';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ATTACKER_ACCOUNT, RECOVERY_CHECKPOINT } from '../src/burn-recovery.js';
import { createSchema } from '../src/graphql/resolvers.js';
import { createMaterializationBudgetedRepository } from '../src/graphql/materialization-budget.js';
import { initializePointsRecovery, pointsQueryIdentity } from '../src/points-recovery.js';
import { PRE_FORK_HISTORY_HOLD_CHECKPOINT } from '../src/recovery-hold.js';
import { readConfig } from '../src/config.js';
import { RocksRepository } from '../src/repository/rocksdb.js';
import { INDEXER_COLLECTIONS } from '../src/repository/types.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { SORA_MAINNET_GENESIS_HASH, SORA_LEGACY_IDENTITY_ANCHOR } from '../src/soraIdentity.js';
import { prepareStatsRecoverySeed, validateStatsCloneQualification } from '../src/stats-recovery-admission.js';
import { createPersistedWorkerStatusDocument } from '../src/worker/status.js';
import type { IndexerDocument } from '../src/repository/types.js';
import { ChainIndexer } from '../src/worker/chain.js';
import {
  STATS_ADMISSION_ID, STATS_CURSOR_ID, STATS_RECONCILIATION_ID, STATS_VOLUME_REPAIR_ID, assertNotStatsRecovery, indexerCapabilities, loadStatsRecoveryAdmission,
  requireStatsRecoveryState, restrictStatsRecoveryWrites, statsBlockCursor, statsEvidenceDigest, statsReconciliationPending,
  verifyStatsCoreReconciliation, statsCoreReadBoundary, assertStatsPublicRead,
  validateStatsRecoveryAdmission, type StatsRecoveryAdmission,
} from '../src/stats-recovery.js';

const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const prefix = PRE_FORK_HISTORY_HOLD_CHECKPOINT;
const repair = JSON.parse(await readFile(new URL('./fixtures/stats-prefix-volume-repair.json', import.meta.url), 'utf8')) as IndexerDocument;
const admission: StatsRecoveryAdmission = {
  schema: 'sora-nexus-canonical-stats-history-v1', approvedForStatsHistory: true, entitlementsReady: false,
  sourceDatabasePath: '/qualified/original-prefix', databasePath: '/isolated/stats-copy',
  prefix: { ...prefix, genesisHash: SORA_MAINNET_GENESIS_HASH },
  qualification: { databaseFilesSha256: 'a'.repeat(64), nativeAuditSha256: 'b'.repeat(64), executorReceiptSha256: 'c'.repeat(64), volumeRepairMarkerSha256: statsEvidenceDigest(repair) },
  policy: { version: 1, policyHash: hash(1), releaseManifestHash: hash(2), genesisHash: SORA_MAINNET_GENESIS_HASH,
    checkpoint: RECOVERY_CHECKPOINT, postForkAnchor: { block: RECOVERY_CHECKPOINT.block + 2, hash: hash(5) },
    substitutions: [{ old: hash(3), new: hash(4) }], attackerAccounts: [ATTACKER_ACCOUNT],
    metadata: [{ firstBlock: RECOVERY_CHECKPOINT.block, lastBlock: RECOVERY_CHECKPOINT.block + 100,
      executionCodeHash: hash(6), metadataHash: hash(7) }] },
};

/** Synthetic already-admitted COPY only: these rows are not native prefix qualification evidence. */
async function fixture() {
  const repo = new MemoryRepository();
  const state = { lastIndexedBlock: prefix.block, blockHash: prefix.hash, blockTimestamp: prefix.timestamp,
    genesisHash: SORA_MAINNET_GENESIS_HASH };
  await repo.upsertMany([
    repair,
    { collection: 'updatesStreams', id: STATS_ADMISSION_ID, blockHeight: prefix.block, timestamp: null,
      data: { id: STATS_ADMISSION_ID, admission, admissionDigest: statsEvidenceDigest(admission) } },
    { collection: 'updatesStreams', id: STATS_CURSOR_ID, blockHeight: prefix.block, timestamp: null,
      data: { id: STATS_CURSOR_ID, admissionDigest: statsEvidenceDigest(admission), block: prefix.block,
        hash: prefix.hash, blockTimestamp: prefix.timestamp, entitlementsReady: false } },
    { collection: 'updatesStreams', id: 'chainState', blockHeight: prefix.block, timestamp: prefix.timestamp,
      data: { id: 'chainState', block: prefix.block, data: JSON.stringify(state) } },
    { collection: 'networkSnapshots', id: `block-${prefix.block}`, blockHeight: prefix.block, timestamp: prefix.timestamp,
      data: { id: `block-${prefix.block}`, type: 'BLOCK', timestamp: prefix.timestamp, accounts: 99, volumeUSD: '12.34000001' } },
  ]);
  return repo;
}

describe('separate canonical stats/history admission', () => {
  it('requires the exact prefix, distinct clone, complete qualification and explicit no-entitlements scope', () => {
    expect(validateStatsRecoveryAdmission(admission)).toEqual(admission);
    for (const change of [
      { prefix: { ...admission.prefix, block: prefix.block + 1 } },
      { databasePath: admission.sourceDatabasePath }, { approvedForStatsHistory: false },
      { entitlementsReady: true }, { qualification: { databaseFilesSha256: 'a'.repeat(64) } },
      { qualification: { ...admission.qualification, volumeRepairMarkerSha256: 'a'.repeat(64) } },
    ]) expect(() => validateStatsRecoveryAdmission({ ...admission, ...change })).toThrow();
  });
  it('reads only paired pinned admission bytes and never treats missing approval as default mode', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stats-admission-'));
    try {
      const path = join(directory, 'admission.json'), raw = JSON.stringify(admission);
      await writeFile(path, raw);
      expect(loadStatsRecoveryAdmission(path, createHash('sha256').update(raw).digest('hex'))).toEqual(admission);
      expect(() => loadStatsRecoveryAdmission(path, 'f'.repeat(64))).toThrow();
      expect(() => loadStatsRecoveryAdmission(path, undefined)).toThrow();
      expect(loadStatsRecoveryAdmission(undefined, undefined)).toBeNull();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('keeps full recovery and entitlement extraction closed even when stats state is coherent', async () => {
    const repo = await fixture();
    expect((await requireStatsRecoveryState(repo, admission)).lastIndexedBlock).toBe(prefix.block);
    await expect(assertNotStatsRecovery(repo)).rejects.toThrow('statistics-only');
    await expect(initializePointsRecovery(repo, admission.policy, 1)).rejects.toThrow('statistics-only');
    await expect(pointsQueryIdentity(repo)).rejects.toThrow('statistics-only');
    expect(await indexerCapabilities(repo, true)).toMatchObject({ mode: 'canonical-stats-history',
      entitlementsReady: false, currentViewsReady: false, statsReady: true, indexedBlock: prefix.block });
  });
  it('rejects a changed policy, orphan classification, or cursor/chain disagreement on restart', async () => {
    const repo = await fixture();
    await expect(requireStatsRecoveryState(repo, { ...admission, policy: { ...admission.policy, policyHash: hash(9) } })).rejects.toThrow();
    const cursor = (await repo.get('updatesStreams', STATS_CURSOR_ID))!;
    await repo.upsert({ ...cursor, data: { ...cursor.data, hash: hash(9) } });
    await expect(requireStatsRecoveryState(repo, admission)).rejects.toThrow('cursor/chain');
    await repo.deleteMany('updatesStreams', [STATS_ADMISSION_ID]);
    await expect(assertNotStatsRecovery(repo)).rejects.toThrow('orphan');
  });
  it('requires exact next height, parent hash and pinned checkpoint hash', async () => {
    const repo = await fixture();
    const args = [repo, admission, prefix.block + 1, RECOVERY_CHECKPOINT.hash, prefix.hash, prefix.timestamp + 6] as const;
    expect((await statsBlockCursor(...args)).data.block).toBe(prefix.block + 1);
    await expect(statsBlockCursor(repo, admission, prefix.block + 2, hash(8), prefix.hash, prefix.timestamp + 6)).rejects.toThrow();
    await expect(statsBlockCursor(repo, admission, prefix.block + 1, RECOVERY_CHECKPOINT.hash, hash(8), prefix.timestamp + 6)).rejects.toThrow();
    await expect(statsBlockCursor(repo, admission, prefix.block + 1, hash(8), prefix.hash, prefix.timestamp + 6)).rejects.toThrow('anchor');
  });
});

describe('hard stats write boundary', () => {
  it('rejects entire mixed batches and entitlement deletions before changing any data', async () => {
    const repo = await fixture(), scoped = restrictStatsRecoveryWrites(repo, admission);
    for (const collection of ['accountMeta', 'accountPointSystems', 'xorBurns', 'referrerRewards'] as const) {
      expect(() => scoped.upsertMany([{ collection: 'accounts', id: 'good', data: {} }, { collection, id: 'claim', data: {} }])).toThrow('outside stats');
      expect(() => scoped.deleteMany(collection, ['claim'])).toThrow('outside stats');
    }
    expect(await repo.get('accounts', 'good')).toBeNull();
    expect(() => scoped.upsert({ collection: 'updatesStreams', id: 'soratopiaRecoveryProjection-v1', data: {} })).toThrow();
    expect(() => scoped.deleteMany('updatesStreams', [STATS_CURSOR_ID])).toThrow();
  });
  it('cannot advance chainState or the stats cursor outside the block transaction', async () => {
    const repo = await fixture(), scoped = restrictStatsRecoveryWrites(repo, admission);
    expect(() => scoped.upsert({ collection: 'updatesStreams', id: 'chainState', data: {} })).toThrow('commit together');
    const cursor = await statsBlockCursor(repo, admission, prefix.block + 1, RECOVERY_CHECKPOINT.hash, prefix.hash, prefix.timestamp + 6);
    expect(() => scoped.upsert(cursor)).toThrow('commit together');
  });
  it('persists unavailable account counts rather than fabricated zero, including calendar buckets', async () => {
    const repo = new MemoryRepository(), scoped = restrictStatsRecoveryWrites(repo, admission);
    await scoped.upsert({ collection: 'networkSnapshots', id: 'sample', data: { accounts: 20, transactions: 3,
      calendarFlows: { accounts: 20, transactions: 3, complete: true } } });
    expect((await repo.get('networkSnapshots', 'sample'))?.data).toEqual({ accounts: null, accountCountAvailable: false,
      transactions: 3, calendarFlows: { accounts: null, accountCountAvailable: false, transactions: 3, complete: true } });
  });
});

describe('stats API authorization before caches and subscriptions', () => {
  it('withholds old claim metadata even when the same schema cache was primed before classification', async () => {
    const repo = new MemoryRepository(), schema = createSchema();
    await repo.upsert({ collection: 'accountMeta', id: 'old', data: { id: 'old' } });
    const query = { schema, source: '{ accountMeta(id:"old") { id } }', contextValue: { repository: repo } };
    expect((await graphql(query)).data?.accountMeta).toEqual({ id: 'old' });
    const admitted = await fixture();
    for (const row of await admitted.list('updatesStreams')) await repo.upsert(row);
    expect((await graphql(query)).errors?.length).toBeGreaterThan(0);
  });
  it('blocks entitlement aliases, arbitrary evidence streams and unreconciled current views', async () => {
    const repository = await fixture(), schema = createSchema();
    for (const source of ['{ claim: xorBurns { totalCount } }', '{ tonswapBurnSnapshot { fresh } }',
      '{ referrerRewards { totalCount } }', '{ accountPointSystems { totalCount } }',
      '{ updatesStream(id:"soratopiaRecoveryProjection-v1") { data } }', '{ assets { totalCount } }']) {
      expect((await graphql({ schema, source, contextValue: { repository } })).errors?.length, source).toBeGreaterThan(0);
    }
    const result = await subscribe({ schema, document: parse('subscription { updatesStreams(id:["soratopiaRecoveryProjection-v1"]) { id } }'), contextValue: { repository } });
    expect('next' in result).toBe(true);
    if ('next' in result) await expect(result.next()).rejects.toThrow();
  });
  it('preserves exact trading amounts but returns account counts unavailable', async () => {
    const result = await graphql({ schema: createSchema(), source: '{ networkSnapshots { nodes { accounts volumeUSD } } }',
      contextValue: { repository: await fixture() } });
    expect(result.errors).toBeUndefined();
    expect(result.data?.networkSnapshots).toMatchObject({ nodes: [{ accounts: null, volumeUSD: '12.34000001' }] });
  });
  it('drains the owned identity-only watch when initial authorization rejects a subscription', async () => {
    const repository = await fixture(), watch = repository.watch.bind(repository);
    let registered = false, closed = false;
    vi.spyOn(repository, 'watch').mockImplementation(async function* (collection, ids, signal) {
      registered = true;
      try { yield* watch(collection, ids, signal); } finally { closed = true; }
    });
    const field = createSchema().getSubscriptionType()!.getFields().updatesStreams!;
    const iterator = field.subscribe!({}, { id: ['soratopiaRecoveryProjection-v1'] }, { repository }, {} as never) as AsyncGenerator;
    const next = iterator.next();
    expect(registered).toBe(true);
    await expect(next).rejects.toThrow('unavailable');
    expect(closed).toBe(true);
  });
});

it('indexes one exact canonical suffix block atomically without points, claims, or fabricated account counts', async () => {
  const repo = await fixture();
  const worker = new ChainIndexer({ soraWsEndpoint: 'ws://unused', chainStartBlock: prefix.block + 1,
    chainBatchSize: 1, stateRefreshIntervalBlocks: 25, snapshotIntervalBlocks: 25,
    storageEngine: 'rocksdb', rocksdbPath: admission.databasePath, burnRecoveryPolicy: admission.policy,
    statsRecoveryAdmission: admission } as never, repo) as any;
  worker.observedGenesisHash = SORA_MAINNET_GENESIS_HASH;
  const baseline = { blockHeight: prefix.block, blockHash: prefix.hash, assets: new Map(), pools: new Map(), prices: new Map(),
    orderBookLiquidityComplete: false, networkLiquidityStats: { liquidityUSD: '0', poolLiquidityUSD: '0',
      orderBookLiquidityUSD: '0', activePools: 0, activeOrderBooks: 0, listedAssets: 0 } };
  const currentRefresh = vi.spyOn(worker, 'refreshDerivedState').mockResolvedValue(undefined);
  vi.spyOn(worker, 'prepareAssetHourlyCloseDocuments').mockResolvedValue({ documents: [], targets: null });
  const reload = vi.spyOn(worker, 'loadHistoricalValuationBaseline').mockResolvedValue({ ...baseline,
    blockHeight: prefix.block + 1, blockHash: RECOVERY_CHECKPOINT.hash });
  const fetched = { requestedHash: RECOVERY_CHECKPOINT.hash, timestamp: prefix.timestamp + 6, events: [],
    signedBlock: { block: { extrinsics: [], header: { number: { toNumber: () => prefix.block + 1 },
      hash: { toString: () => RECOVERY_CHECKPOINT.hash }, parentHash: { toString: () => prefix.hash } } } } };
  await worker.indexFetchedBlock(fetched, { historicalValuationState: baseline, refreshDerivedState: true });
  expect(currentRefresh).toHaveBeenCalledWith(prefix.block + 1, prefix.timestamp + 6, false, true);
  expect(reload).toHaveBeenCalledWith(prefix.block + 1, 'stats-recovery-exact-state', RECOVERY_CHECKPOINT.hash);
  expect((await requireStatsRecoveryState(repo, admission)).lastIndexedBlock).toBe(prefix.block + 1);
  expect((await repo.get('networkSnapshots', `block-${prefix.block + 1}`))?.data).toMatchObject({ accounts: null, transactions: 0, volumeUSD: '0' });
  for (const collection of ['accountMeta', 'accountPointSystems', 'xorBurns', 'referrerRewards'] as const) expect(await repo.list(collection)).toEqual([]);
  expect(await repo.get('updatesStreams', 'burnRecoveryIdentity-v1')).toBeNull();
  expect(await repo.get('updatesStreams', 'soratopiaRecoveryContinuity-v1')).toBeNull();
  await expect(worker.indexFetchedBlock(fetched, { historicalValuationState: baseline, refreshDerivedState: false })).rejects.toThrow();
});


/** Minimal real health inputs; these are synthetic fixtures, never qualification receipts. */
async function coreFixture() {
  const repo = await fixture();
  const rows: IndexerDocument[] = [
    { collection: 'assets', id: 'asset', blockHeight: prefix.block, timestamp: prefix.timestamp, data: { id: 'asset', priceUSD: '1.00000001' } },
    { collection: 'poolXYKs', id: 'pool', blockHeight: prefix.block, timestamp: prefix.timestamp, data: { id: 'pool' } },
    { collection: 'orderBooks', id: 'book', blockHeight: prefix.block, timestamp: prefix.timestamp, data: { id: 'book' } },
    ...['price', 'apy', 'assetRegistration'].map((id): IndexerDocument => ({ collection: 'updatesStreams', id,
      blockHeight: prefix.block, timestamp: prefix.timestamp, data: { id, block: prefix.block, data: '{}' } })),
  ];
  const identity = { schemaVersion: 1, genesisHash: SORA_MAINNET_GENESIS_HASH,
    verificationBlock: SORA_LEGACY_IDENTITY_ANCHOR.block, verificationBlockHash: SORA_LEGACY_IDENTITY_ANCHOR.hash,
    verificationBlockTimestamp: SORA_LEGACY_IDENTITY_ANCHOR.timestamp, migration: 'legacy-production-anchor-v1' };
  await repo.upsertMany([...rows, { collection: 'updatesStreams', id: 'chainIdentity', blockHeight: identity.verificationBlock,
    timestamp: identity.verificationBlockTimestamp, data: { id: 'chainIdentity', block: identity.verificationBlock, data: JSON.stringify(identity) } },
    createPersistedWorkerStatusDocument({ lifecycle: 'running', startupComplete: true, latestFinalizedBlock: prefix.block,
      latestIndexedBlock: prefix.block, lag: 0, lastSuccessfulIndexTimestamp: prefix.timestamp, lastError: null, lastErrorTimestamp: null }, prefix.timestamp),
    statsReconciliationPending(admission, prefix.block, prefix.hash)]);
  return { repo, rows };
}

afterEach(() => vi.restoreAllMocks());

describe('verified core projections with coherent reads', () => {
  it('publishes only core capability after all complete row sets match; never certifies full views or entitlements', async () => {
    const { repo, rows } = await coreFixture();
    expect((await indexerCapabilities(repo, true)).coreViewsReady).toBe(false);
    await verifyStatsCoreReconciliation(repo, admission, prefix.block, prefix.hash, rows);
    expect(await indexerCapabilities(repo, true)).toMatchObject({ coreViewsReady: true, currentViewsReady: false, entitlementsReady: false });
    expect((await indexerCapabilities(repo, false)).coreViewsReady).toBe(false);
    await expect(assertStatsPublicRead(repo, 'assets', [], async () => false)).rejects.toThrow('not ready');
    await expect(assertStatsPublicRead(repo, 'orderBookOrders', [], async () => true)).rejects.toThrow('complete reconciliation');
  });
  it.each(['missing', 'extra', 'corrupt'] as const)('rejects %s rows and leaves interrupted refresh unavailable', async (kind) => {
    const { repo, rows } = await coreFixture();
    if (kind === 'missing') await repo.deleteMany('assets', ['asset']);
    if (kind === 'extra') await repo.upsert({ ...rows[0]!, id: 'retired', data: { id: 'retired' } });
    if (kind === 'corrupt') await repo.upsert({ ...rows[0]!, data: { ...rows[0]!.data, priceUSD: '2' } });
    await expect(verifyStatsCoreReconciliation(repo, admission, prefix.block, prefix.hash, rows)).rejects.toThrow('core');
    expect((await indexerCapabilities(repo, true)).coreViewsReady).toBe(false);
  });
  it('rejects a same-height refresh crossing an in-flight read even if the final rows are identical', async () => {
    const { repo, rows } = await coreFixture();
    await verifyStatsCoreReconciliation(repo, admission, prefix.block, prefix.hash, rows);
    const finish = await statsCoreReadBoundary(repo, 'assets', [], async () => true);
    await repo.upsert(statsReconciliationPending(admission, prefix.block, prefix.hash));
    await verifyStatsCoreReconciliation(repo, admission, prefix.block, prefix.hash, rows);
    await expect(finish({ rows: 'partially observed' })).rejects.toThrow('changed during the read');
  });
  it('rejects malformed receipt hashes, old head receipts, and forged full-view claims', async () => {
    const { repo, rows } = await coreFixture();
    await verifyStatsCoreReconciliation(repo, admission, prefix.block, prefix.hash, rows);
    const marker = (await repo.get('updatesStreams', STATS_RECONCILIATION_ID))!;
    for (const change of [{ hash: hash(90) }, { normalizedRowsSha256: 'bad' }, { ready: false }, { policyHash: hash(90) }]) {
      await repo.upsert({ ...marker, data: { ...marker.data, ...change } });
      expect((await indexerCapabilities(repo, true)).coreViewsReady).toBe(false);
    }
  });
  it('uses actual health for current queries and subscriptions after a stopped worker', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(prefix.timestamp * 1000);
    const { repo, rows } = await coreFixture();
    await verifyStatsCoreReconciliation(repo, admission, prefix.block, prefix.hash, rows);
    const schema = createSchema(), query = { schema, source: '{ assets { nodes { id priceUSD } } }', contextValue: { repository: repo } };
    expect((await graphql(query)).errors).toBeUndefined();
    await repo.upsert(createPersistedWorkerStatusDocument({ lifecycle: 'stopped', startupComplete: true,
      latestFinalizedBlock: prefix.block, latestIndexedBlock: prefix.block, lag: 0,
      lastSuccessfulIndexTimestamp: prefix.timestamp, lastError: null, lastErrorTimestamp: null }, prefix.timestamp));
    expect((await graphql(query)).errors?.[0]?.message).toContain('not ready');
    const result = await subscribe({ schema, document: parse('subscription { orderBooks(id:["book"]) { id } }'), contextValue: { repository: repo } });
    expect('next' in result).toBe(true);
    if ('next' in result) await expect(result.next()).rejects.toThrow();
  });
  it('rejects a GraphQL query that sees a partial multi-chunk refresh', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(prefix.timestamp * 1000);
    const { repo, rows } = await coreFixture();
    await verifyStatsCoreReconciliation(repo, admission, prefix.block, prefix.hash, rows);
    const original = repo.query.bind(repo);
    vi.spyOn(repo, 'query').mockImplementation(async (collection, args) => {
      if (collection === 'assets') await repo.upsert(statsReconciliationPending(admission, prefix.block, prefix.hash));
      return original(collection, args);
    });
    const result = await graphql({ schema: createSchema(), source: '{ assets { nodes { id } } }', contextValue: { repository: repo } });
    expect(result.errors?.[0]?.message).toContain('changed during the read');
  });
  it('keeps two core pages within one generation and rejects changed heads, scopes, or legacy cursors', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(prefix.timestamp * 1000);
    const { repo, rows } = await coreFixture();
    const extra = ['asset-b', 'asset-c'].map((id) => ({ ...rows[0]!, id, data: { ...rows[0]!.data, id } }));
    await repo.upsertMany(extra);
    const complete = [...rows, ...extra];
    await verifyStatsCoreReconciliation(repo, admission, prefix.block, prefix.hash, complete);
    const schema = createSchema();
    const query = (after?: string, collection = 'assets', order = 'ID_ASC', filter = '') => graphql({ schema,
      source: `query($after:Cursor){ ${collection}(first:1,after:$after,orderBy:${order}${filter}) { edges { cursor node { id } } pageInfo { endCursor hasNextPage } } }`,
      variableValues: { after }, contextValue: { repository: repo } });
    const first = await query(); expect(first.errors).toBeUndefined();
    const page = first.data?.assets as { edges: Array<{ cursor: string; node: { id: string } }>; pageInfo: { endCursor: string } };
    expect(page.edges[0]?.node.id).toBe('asset'); expect(page.edges[0]?.cursor).toBe(page.pageInfo.endCursor);
    const after = page.pageInfo.endCursor;
    const second = await query(after); expect(second.errors).toBeUndefined();
    expect(second.data?.assets).toMatchObject({ edges: [{ node: { id: 'asset-b' } }] });
    for (const result of [await query(after, 'poolXYKs'), await query(after, 'assets', 'ID_DESC'),
      await query(after, 'assets', 'ID_ASC', ',filter:{id:{equalTo:"asset-b"}}'), await query('0'),
      await query(JSON.parse(Buffer.from(after.slice('pscg1.'.length), 'base64url').toString()).cursor)]) {
      expect(result.errors?.length).toBeGreaterThan(0);
    }
    const nextBlock = prefix.block + 1, nextTimestamp = prefix.timestamp + 6;
    const cursor = await statsBlockCursor(repo, admission, nextBlock, RECOVERY_CHECKPOINT.hash, prefix.hash, nextTimestamp);
    const nextRows = complete.map(row => ({ ...row, blockHeight: nextBlock, timestamp: nextTimestamp,
      data: row.collection === 'updatesStreams' ? { ...row.data, block: nextBlock } : row.data }));
    await repo.upsertMany([cursor, ...nextRows, statsReconciliationPending(admission, nextBlock, RECOVERY_CHECKPOINT.hash),
      { collection: 'updatesStreams', id: 'chainState', blockHeight: nextBlock, timestamp: nextTimestamp,
        data: { id: 'chainState', block: nextBlock, data: JSON.stringify({ lastIndexedBlock: nextBlock, blockHash: RECOVERY_CHECKPOINT.hash, blockTimestamp: nextTimestamp, genesisHash: SORA_MAINNET_GENESIS_HASH }) } },
      { collection: 'networkSnapshots', id: `block-${nextBlock}`, blockHeight: nextBlock, timestamp: nextTimestamp,
        data: { id: `block-${nextBlock}`, type: 'BLOCK', timestamp: nextTimestamp, accounts: null } },
      createPersistedWorkerStatusDocument({ lifecycle: 'running', startupComplete: true, latestFinalizedBlock: nextBlock,
        latestIndexedBlock: nextBlock, lag: 0, lastSuccessfulIndexTimestamp: nextTimestamp, lastError: null, lastErrorTimestamp: null }, nextTimestamp)]);
    vi.spyOn(Date, 'now').mockReturnValue(nextTimestamp * 1000);
    await verifyStatsCoreReconciliation(repo, admission, nextBlock, RECOVERY_CHECKPOINT.hash, nextRows);
    expect((await query(after)).errors?.[0]?.message).toContain('generation changed');
    expect((await query()).errors).toBeUndefined();
  });
  it('rejects old cursors after same-head reconciliation and unanchored core offsets', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(prefix.timestamp * 1000);
    const { repo, rows } = await coreFixture();
    await verifyStatsCoreReconciliation(repo, admission, prefix.block, prefix.hash, rows);
    const schema = createSchema(), contextValue = { repository: repo };
    const first = await graphql({ schema, source: '{ assets(first:1) { pageInfo { endCursor } } }', contextValue });
    const after = (first.data?.assets as { pageInfo: { endCursor: string } }).pageInfo.endCursor;
    await repo.upsert(statsReconciliationPending(admission, prefix.block, prefix.hash));
    await verifyStatsCoreReconciliation(repo, admission, prefix.block, prefix.hash, rows);
    const next = await graphql({ schema, source: 'query($after:Cursor){ assets(first:1,after:$after){ nodes{id} } }', variableValues: { after }, contextValue });
    expect(next.errors?.[0]?.message).toContain('generation changed');
    for (const source of ['{assets(first:1,offset:1){nodes{id}}}', '{assets(last:1){nodes{id}}}', 'query($after:Cursor){assets(first:1,before:$after){nodes{id}}}']) {
      expect((await graphql({ schema, source, variableValues: { after }, contextValue })).errors?.[0]?.message).toContain('forward generation-bound');
    }
  });
  it.each(['assets', 'poolXYKs', 'indexerCapabilities'] as const)('rejects an operation mixing an earlier assets result with a later %s generation', async (laterField) => {
    vi.spyOn(Date, 'now').mockReturnValue(prefix.timestamp * 1000);
    const { repo, rows } = await coreFixture();
    await verifyStatsCoreReconciliation(repo, admission, prefix.block, prefix.hash, rows);
    const schema = createSchema(), fields = schema.getQueryType()!.getFields();
    const originalAssets = fields.assets!.resolve!, originalLater = fields[laterField]!.resolve!;
    let firstDone!: () => void;
    const firstCompleted = new Promise<void>(resolve => { firstDone = resolve; });
    const afterRefresh = async (parent: unknown, args: unknown, context: unknown, info: any) => {
      await firstCompleted;
      await repo.upsert(statsReconciliationPending(admission, prefix.block, prefix.hash));
      await verifyStatsCoreReconciliation(repo, admission, prefix.block, prefix.hash, rows);
      return originalLater(parent, args, context, info);
    };
    fields.assets!.resolve = async (parent, args, context, info) => {
      if (info.path.key === 'second') return afterRefresh(parent, args, context, info);
      const result = await originalAssets(parent, args, context, info); firstDone(); return result;
    };
    if (laterField !== 'assets') fields[laterField]!.resolve = afterRefresh;
    const second = laterField === 'indexerCapabilities' ? 'indexerCapabilities { coreViewsReady indexedBlock }' : `${laterField}(first:1){nodes{id}}`;
    const result = await graphql({ schema, source: `{first:assets(first:1){nodes{id}} second:${second}}`, contextValue: { repository: repo } });
    expect(result.errors?.some(error => error.message.includes('generation changed within the operation'))).toBe(true);
    expect(result.data).toBeNull();
  });
  it('allows multiple current-core roots and capability in one unchanged operation', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(prefix.timestamp * 1000);
    const { repo, rows } = await coreFixture();
    await verifyStatsCoreReconciliation(repo, admission, prefix.block, prefix.hash, rows);
    const result = await graphql({ schema: createSchema(), source: '{ a:assets(first:1){nodes{id}} b:assets(first:1){nodes{id}} poolXYKs(first:1){nodes{id}} indexerCapabilities{coreViewsReady} }', contextValue: { repository: repo } });
    expect(result.errors).toBeUndefined();
    expect(result.data?.indexerCapabilities).toMatchObject({ coreViewsReady: true });
  });
  it('emits successive reconciled generations on one real subscription and rejects a later stopped worker', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(prefix.timestamp * 1000);
    const { repo, rows } = await coreFixture();
    await verifyStatsCoreReconciliation(repo, admission, prefix.block, prefix.hash, rows);
    vi.spyOn(repo, 'watch').mockImplementation(async function* () {
      for (let index = 0; index < 3; index++) yield { collection: 'orderBooks', id: 'book', mutationType: 'UPDATE' } as const;
    });
    const bounded = createMaterializationBudgetedRepository(repo, 16 * 1024 * 1024);
    const result = await subscribe({ schema: createSchema(), document: parse('subscription { orderBooks(id:["book"]){id _entity} }'),
      contextValue: { repository: bounded.repository, streamingRepository: repo } });
    expect('next' in result).toBe(true);
    if (!('next' in result)) throw new Error('Expected a subscription iterator');
    try {
      const first = await result.next(); expect(first.value!.errors).toBeUndefined();
      const firstBytes = bounded.budget.usedBytes;
      await repo.upsert(statsReconciliationPending(admission, prefix.block, prefix.hash));
      const nextRows = rows.map(row => row.collection === 'orderBooks' ? { ...row, data: { ...row.data, price: '2' } } : row);
      await repo.upsertMany(nextRows);
      await verifyStatsCoreReconciliation(repo, admission, prefix.block, prefix.hash, nextRows);
      const second = await result.next(); expect(second.value!.errors).toBeUndefined();
      expect(second.value!.data?.orderBooks).toMatchObject({ id: 'book', _entity: { price: '2' } });
      expect(bounded.budget.usedBytes).toBeGreaterThan(firstBytes);
      await repo.upsert(createPersistedWorkerStatusDocument({ lifecycle: 'stopped', startupComplete: true,
        latestFinalizedBlock: prefix.block, latestIndexedBlock: prefix.block, lag: 0,
        lastSuccessfulIndexTimestamp: prefix.timestamp, lastError: null, lastErrorTimestamp: null }, prefix.timestamp));
      expect((await result.next()).value!.errors?.[0]?.message).toContain('not ready');
    } finally { await result.return?.(); }
  });
  it('rejects a core subscription emission crossing a refresh and retains the supplied aggregate budget', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(prefix.timestamp * 1000);
    const { repo, rows } = await coreFixture();
    await verifyStatsCoreReconciliation(repo, admission, prefix.block, prefix.hash, rows);
    vi.spyOn(repo, 'watch').mockImplementation(async function* () {
      yield { collection: 'orderBooks', id: 'book', mutationType: 'UPDATE' } as const;
      yield { collection: 'orderBooks', id: 'book', mutationType: 'UPDATE' } as const;
    });
    const get = repo.get.bind(repo);
    vi.spyOn(repo, 'get').mockImplementation(async (collection, id) => {
      if (collection === 'orderBooks') await repo.upsert(statsReconciliationPending(admission, prefix.block, prefix.hash));
      return get(collection, id);
    });
    const bounded = createMaterializationBudgetedRepository(repo, 16 * 1024 * 1024);
    const result = await subscribe({ schema: createSchema(), document: parse('subscription { orderBooks(id:["book"]){id _entity} }'),
      contextValue: { repository: bounded.repository, streamingRepository: repo } });
    if (!('next' in result)) throw new Error('Expected a subscription iterator');
    try {
      expect((await result.next()).value!.errors?.[0]?.message).toContain('changed during the read');
      await bounded.budget.materialize(async () => 'x'.repeat(bounded.budget.maximumBytes));
      expect((await result.next()).value!.errors?.[0]?.extensions.code).toBe('GRAPHQL_EXECUTION_MEMORY_LIMIT_EXCEEDED');
    } finally { await result.return?.(); }
  });
  it('requires retained repair evidence and refuses account-count predicates', async () => {
    const repo = await fixture();
    const result = await graphql({ schema: createSchema(), source: '{ networkSnapshots(orderBy:ACCOUNTS_DESC) { totalCount } }', contextValue: { repository: repo } });
    expect(result.errors?.length).toBeGreaterThan(0);
    await repo.deleteMany('updatesStreams', [STATS_VOLUME_REPAIR_ID]);
    await expect(requireStatsRecoveryState(repo, admission)).rejects.toThrow('network volume repair');
  });
});


describe('pure private clone admission', () => {
  async function qualified() {
    const databaseFiles = await readFile(new URL('./fixtures/stats-prefix-files.json', import.meta.url));
    const nativeAudit = await readFile(new URL('./fixtures/stats-prefix-native.json', import.meta.url));
    const sha = (raw: Uint8Array) => createHash('sha256').update(raw).digest('hex');
    const sourceQualification = { databaseFilesSha256: sha(databaseFiles), nativeAuditSha256: sha(nativeAudit),
      completionReceiptSha256: '6d0618532b04d9cfa4f3e2a0687d3798b7955ace84e553125200e561f43315a4' };
    const receipt = { schema: 'sora-nexus-stats-history-clone-qualification-v1',
      sourceDatabasePath: admission.sourceDatabasePath, databasePath: admission.databasePath, prefix: admission.prefix,
      databaseFilesSha256: sha(databaseFiles), nativeAuditSha256: sha(nativeAudit), sourceQualification,
      sourceStopped: true, sourceLockHeldDuringCopy: true, sourceFilesUnchanged: true, targetFilesMatchSource: true,
      targetIndependentInodes: true, nativeReadOnly: true, nativeExitCode: 0, nativeBeforeAfterFilesUnchanged: true,
      nativeOutputMatchesSource: true, nativeValidationMode: 'inherited-exact-source-bytes',
      exhaustiveNativeExecutedOnClone: false, normalizedScanExecutedOnClone: true, volumeRepairMarkerSha256: admission.qualification.volumeRepairMarkerSha256,
      entitlementsReady: false, productionChanged: false, files: 499, logicalBytes: 18_786_660_488 };
    const executorReceipt = Buffer.from(JSON.stringify(receipt));
    const approved = { ...admission, qualification: { ...admission.qualification,
      databaseFilesSha256: sha(databaseFiles), nativeAuditSha256: sha(nativeAudit), executorReceiptSha256: sha(executorReceipt) } };
    const repo = await fixture();
    await repo.deleteMany('updatesStreams', [STATS_ADMISSION_ID, STATS_CURSOR_ID]);
    const native = JSON.parse(nativeAudit.toString());
    await repo.upsert({ collection: 'updatesStreams', id: 'chainIdentity', blockHeight: native.identity.block,
      timestamp: SORA_LEGACY_IDENTITY_ANCHOR.timestamp, data: native.identity });
    return { repo, approved, receipt, bytes: { databaseFiles, nativeAudit, executorReceipt } };
  }
  it('requires exact retained source evidence and prepares only three rows without mutating the clone', async () => {
    const { repo, approved, bytes } = await qualified();
    const before = await repo.list('updatesStreams');
    const seed = await prepareStatsRecoverySeed(repo, approved, bytes);
    expect(seed.map((row) => row.id)).toEqual([STATS_ADMISSION_ID, STATS_CURSOR_ID, STATS_RECONCILIATION_ID]);
    expect(await repo.list('updatesStreams')).toEqual(before);
    await repo.upsertMany(seed);
    expect((await requireStatsRecoveryState(repo, approved)).lastIndexedBlock).toBe(prefix.block);
    await expect(prepareStatsRecoverySeed(repo, approved, bytes)).rejects.toThrow('already carries');
  });
  it.each(['sourceStopped', 'sourceLockHeldDuringCopy', 'sourceFilesUnchanged', 'targetFilesMatchSource',
    'targetIndependentInodes', 'nativeReadOnly', 'nativeBeforeAfterFilesUnchanged', 'nativeOutputMatchesSource'] as const)
  ('rejects missing %s even when a changed executor receipt is explicitly pinned', async (field) => {
    const { approved, receipt, bytes } = await qualified();
    const executorReceipt = Buffer.from(JSON.stringify({ ...receipt, [field]: false }));
    const changed = { ...approved, qualification: { ...approved.qualification,
      executorReceiptSha256: createHash('sha256').update(executorReceipt).digest('hex') } };
    expect(() => validateStatsCloneQualification(changed, { ...bytes, executorReceipt })).toThrow(field);
  });
  it.each([
    { nativeValidationMode: 'repeated-exhaustive-clone-audit' },
    { exhaustiveNativeExecutedOnClone: true }, { normalizedScanExecutedOnClone: false },
  ])('rejects incorrect clone validation provenance %j', async (change) => {
    const { approved, receipt, bytes } = await qualified();
    const executorReceipt = Buffer.from(JSON.stringify({ ...receipt, ...change }));
    const changed = { ...approved, qualification: { ...approved.qualification,
      executorReceiptSha256: createHash('sha256').update(executorReceipt).digest('hex') } };
    expect(() => validateStatsCloneQualification(changed, { ...bytes, executorReceipt })).toThrow('binding differs');
  });
  it('rejects changed evidence bytes, wrong target, missing actual repair, and a changed native checkpoint', async () => {
    const { repo, approved, bytes } = await qualified();
    expect(() => validateStatsCloneQualification(approved, { ...bytes, nativeAudit: Buffer.from('{}') })).toThrow('pin');
    expect(() => validateStatsCloneQualification({ ...approved, databasePath: '/wrong' }, bytes)).toThrow('target');
    const state = (await repo.get('updatesStreams', 'chainState'))!;
    await repo.upsert({ ...state, data: { ...state.data, data: JSON.stringify({ ...JSON.parse(String(state.data.data)), blockHash: hash(88) }) } });
    await expect(prepareStatsRecoverySeed(repo, approved, bytes)).rejects.toThrow('checkpoint');
    await repo.upsert(state);
    await repo.deleteMany('updatesStreams', [STATS_VOLUME_REPAIR_ID]);
    await expect(prepareStatsRecoverySeed(repo, approved, bytes)).rejects.toThrow('repair');
  });
});


it('round-trips the stats cursor, null counters and verified core receipt in a fresh temporary native format-2 fixture', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stats-native-unit-'));
  const config = { ...readConfig(), storageEngine: 'rocksdb' as const, rocksdbPath: join(directory, 'fixture.rocksdb'),
    rocksdbDocumentCompression: 'none' as const, rocksdbBlockCacheMb: 16, rocksdbWriteBufferManagerMb: 16,
    rocksdbParallelism: 1, rocksdbDocumentCacheMax: 0, rocksdbDocumentCacheMaxBytes: 0 };
  const { repo: memory, rows } = await coreFixture();
  const approved = { ...admission, databasePath: config.rocksdbPath };
  const digest = statsEvidenceDigest(approved);
  await memory.upsert({ collection: 'updatesStreams', id: STATS_ADMISSION_ID, blockHeight: prefix.block, timestamp: null,
    data: { id: STATS_ADMISSION_ID, admission: approved, admissionDigest: digest } });
  const cursor = (await memory.get('updatesStreams', STATS_CURSOR_ID))!;
  await memory.upsert({ ...cursor, data: { ...cursor.data, admissionDigest: digest } });
  await memory.upsert(statsReconciliationPending(approved, prefix.block, prefix.hash));
  let native = new RocksRepository(config);
  try {
    await native.prepare();
    for (const collection of INDEXER_COLLECTIONS) await native.upsertMany(await memory.list(collection));
    const scoped = restrictStatsRecoveryWrites(native, approved);
    await scoped.upsert({ collection: 'networkSnapshots', id: 'test-aggregate', blockHeight: prefix.block + 1,
      timestamp: prefix.timestamp + 6, data: { id: 'test-aggregate', type: 'DAY', accounts: 100, volumeUSD: '3.10000001' } });
    expect(await verifyStatsCoreReconciliation(scoped, approved, prefix.block, prefix.hash, rows)).toBe(true);
    await native.validateCompactIndexes();
    await native.close();
    native = RocksRepository.openReadOnly(config); await native.prepare();
    expect((await requireStatsRecoveryState(native, approved)).lastIndexedBlock).toBe(prefix.block);
    expect((await indexerCapabilities(native, true)).coreViewsReady).toBe(true);
    expect((await native.get('networkSnapshots', 'test-aggregate'))?.data).toMatchObject({ accounts: null, volumeUSD: '3.10000001' });
    await native.validateCompactIndexes();
    await expect(initializePointsRecovery(native, approved.policy, 1)).rejects.toThrow('statistics-only');
  } finally { await native.close(); await rm(directory, { recursive: true, force: true }); }
});


/** No connection is started; private worker helpers are exercised with bounded fixture storage. */
function statsWorker(repo: MemoryRepository) {
  return new ChainIndexer({ ...readConfig(), storageEngine: 'rocksdb', rocksdbPath: admission.databasePath,
    chainStartBlock: prefix.block + 1, statsRecoveryAdmission: admission, burnRecoveryPolicy: admission.policy }, repo) as any;
}

describe('suffix startup retains exact rolling coverage', () => {
  async function windowsFixture() {
    const repo = await fixture(), start = prefix.timestamp - 30 * 86400;
    for (const [height, time] of [[prefix.block - 3, start - 1], [prefix.block - 2, start + 1],
      [prefix.block - 1, prefix.timestamp - 6]] as const) await repo.upsert({ collection: 'networkSnapshots', id: `block-${height}`,
        blockHeight: height, timestamp: time, data: { id: `block-${height}`, type: 'BLOCK', timestamp: time,
          accounts: 0, transactions: 1, swaps: 0, fees: '0', volumeUSD: '1.00000001', bridgeIncomingTransactions: 0, bridgeOutgoingTransactions: 0 } });
    return { repo, worker: statsWorker(repo) };
  }
  it('loads the preceding qualified window even when prefix equals configured suffix-start minus one', async () => {
    const { repo, worker } = await windowsFixture();
    const windows = await worker.initializeNetworkBackfillWindows(prefix.block);
    expect(windows).toHaveLength(4);
    expect(windows.find((row: any) => row.type === 'MONTH').totals.volumeUSD).toBe(14_340_000_030_000_000_000n);
    expect((await repo.get('networkSnapshots', `block-${prefix.block}`))?.data.accounts).toBe(99);
  });
  it.each(['gap', 'boundary', 'latest', 'malformed'] as const)('rejects %s rolling input instead of assuming empty history', async (kind) => {
    const { repo, worker } = await windowsFixture();
    if (kind === 'gap') await repo.deleteMany('networkSnapshots', [`block-${prefix.block - 1}`]);
    if (kind === 'boundary') await repo.deleteMany('networkSnapshots', [`block-${prefix.block - 3}`]);
    if (kind === 'latest') await repo.deleteMany('networkSnapshots', [`block-${prefix.block}`]);
    if (kind === 'malformed') vi.spyOn(repo, 'query').mockResolvedValue({ items: [], totalCount: 0 });
    await expect(worker.initializeNetworkBackfillWindows(prefix.block)).rejects.toThrow('Stats');
  });
});

describe('native stats rolling-history index seeks', () => {
  it.each(['valid', 'gap', 'out-of-order', 'boundary-id', 'missing-boundary', 'latest'] as const)(
    'keeps the four-row native scan budget with %s retained history', async (kind) => {
      const directory = await mkdtemp(join(tmpdir(), 'stats-window-seek-'));
      const config = { ...readConfig(), storageEngine: 'rocksdb' as const, rocksdbPath: join(directory, 'fixture.rocksdb'),
        rocksdbDocumentCompression: 'none' as const, rocksdbBlockCacheMb: 16, rocksdbWriteBufferManagerMb: 16,
        rocksdbParallelism: 1, rocksdbDocumentCacheMax: 0, rocksdbDocumentCacheMaxBytes: 0,
        rocksdbQueryMaxScannedRows: 4 };
      const native = new RocksRepository(config), latest = prefix.timestamp, cutoff = latest - 30 * 86400;
      const block = (height: number, timestamp: number): IndexerDocument => ({ collection: 'networkSnapshots',
        id: `block-${height}`, blockHeight: height, timestamp, data: { id: `block-${height}`, type: 'BLOCK', timestamp,
          accounts: 0, transactions: 1, swaps: 0, fees: '7', volumeUSD: '1.00000001' } });
      try {
        const approved = { ...admission, databasePath: config.rocksdbPath };
        const worker = new ChainIndexer({ ...config, chainStartBlock: prefix.block + 1, statsRecoveryAdmission: approved,
          burnRecoveryPolicy: approved.policy }, native) as any;
        await native.prepare();
        await native.upsertMany([
          ...Array.from({ length: 8 }, (_, i) => block(i + 1, cutoff - 100 + i)),
          // Lexical descending ID chooses block-9 before block-10 at this timestamp.
          block(9, cutoff - 1), block(10, cutoff - 1),
          block(11, cutoff), block(12, cutoff + 1), block(13, latest - 6), block(14, latest),
          // A later height can share the boundary timestamp; the admitted cap still applies.
          block(15, cutoff - 1), block(16, latest + 6),
        ]);
        if (kind === 'valid') {
          await expect(native.query('networkSnapshots', { first: 1, includeTotalCount: false,
            orderBy: ['BLOCK_HEIGHT_DESC'], filter: { and: [{ type: { equalTo: 'BLOCK' } },
              { timestamp: { lessThan: cutoff } }, { blockHeight: { lessThanOrEqualTo: 14 } }] } })).rejects.toThrow('4 row scan limit');
          await expect(native.query('networkSnapshots', { first: 1000, includeTotalCount: false,
            orderBy: ['BLOCK_HEIGHT_ASC'], filter: { and: [{ type: { equalTo: 'BLOCK' } },
              { timestamp: { greaterThanOrEqualTo: cutoff, lessThanOrEqualTo: latest } },
              { blockHeight: { lessThanOrEqualTo: 14 } }] } })).rejects.toThrow('4 row scan limit');
          const windows = await worker.initializeNetworkBackfillWindows(14);
          const month = windows.find((row: any) => row.type === 'MONTH');
          expect(month.blocks.map((row: any) => row.blockHeight)).toEqual([11, 12, 13, 14]);
          expect(month.totals).toMatchObject({ transactions: 4, fees: 28n, volumeUSD: 4_000_000_040_000_000_000n });
          expect((await native.get('networkSnapshots', 'block-15'))?.blockHeight).toBe(15);
        } else {
          if (kind === 'gap') await native.deleteMany('networkSnapshots', ['block-12']);
          if (kind === 'out-of-order') {
            await native.upsert(block(11, cutoff + 2));
            await native.upsert(block(12, cutoff + 1));
          }
          if (kind === 'boundary-id') {
            await native.deleteMany('networkSnapshots', ['block-10']);
            const malformed = block(10, cutoff - 1);
            await native.upsert({ ...malformed, id: 'wrong-id', data: { ...malformed.data, id: 'wrong-id' } });
          }
          if (kind === 'missing-boundary') await native.deleteMany('networkSnapshots', ['block-9', 'block-10']);
          if (kind === 'latest') await native.deleteMany('networkSnapshots', ['block-14']);
          await expect(worker.initializeNetworkBackfillWindows(14)).rejects.toThrow('Stats');
        }
      } finally { await native.close(); await rm(directory, { recursive: true, force: true }); }
    }
  );
});

it('reconciles retired core rows without loading unqualified auxiliary storage', async () => {
  const { repo } = await coreFixture(), worker = statsWorker(repo);
  worker.api = {};
  await repo.upsert({ collection: 'stakingStakers', id: 'retained', blockHeight: prefix.block, data: { id: 'retained' } });
  vi.spyOn(worker, 'loadAssetStorageDomain').mockResolvedValue({ assetInfos: [], tokenIssuances: [], nativeXorIssuance: 0n, assetMetadataAuthoritative: true });
  vi.spyOn(worker, 'loadPoolStorageDomain').mockResolvedValue({ poolProperties: [], poolReserves: [], poolIssuances: [], poolReservesAuthoritative: true });
  vi.spyOn(worker, 'loadDerivedStorageDomainWithStatus').mockImplementation(async (...args: any[]) => {
    expect(args[0]).toBe('orderBooks');
    return { value: { orderBooks: [], orderBookBids: [], orderBookAsks: [], orderBookLimitOrders: [] }, refreshed: true, authoritativeForGeneration: true };
  });
  vi.spyOn(worker, 'loadDerivedStorageDomain').mockImplementation(async (...args: any[]) => { expect(args[0]).toBe('farming'); return []; });
  const other = vi.spyOn(worker, 'loadPolkamarktStorageDomain').mockRejectedValue(new Error('noncore RPC must not run'));
  vi.spyOn(worker, 'buildAnalytics').mockResolvedValue({ orderBookActiveReserves: new Map(), network: new Map() });
  await worker.refreshDerivedStateInternal({}, prefix.block, prefix.timestamp, false, true);
  expect(other).not.toHaveBeenCalled();
  for (const collection of ['assets', 'poolXYKs', 'orderBooks'] as const) expect(await repo.list(collection)).toEqual([]);
  expect(await repo.get('stakingStakers', 'retained')).not.toBeNull();
  expect((await indexerCapabilities(repo, true)).coreViewsReady).toBe(true);
});
