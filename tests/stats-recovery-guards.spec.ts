import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ATTACKER_ACCOUNT, RECOVERY_CHECKPOINT } from '../src/burn-recovery.js';
import { PRE_FORK_HISTORY_HOLD_CHECKPOINT } from '../src/recovery-hold.js';
import { MemoryRepository } from '../src/repository/memory.js';
import type { IndexerDocument } from '../src/repository/types.js';
import { SORA_MAINNET_GENESIS_HASH } from '../src/soraIdentity.js';
import {
  STATS_ADMISSION_ID, STATS_CURSOR_ID, STATS_RECONCILIATION_ID, assertStatsPublicRead, assertStatsQueryArguments,
  indexerCapabilities, requireStatsRecoveryState, restrictStatsRecoveryWrites, statsCoreReadBoundary, statsEvidenceDigest,
  statsReconciliationPending, verifyStatsCoreReconciliation, type StatsRecoveryAdmission,
} from '../src/stats-recovery.js';

// Same synthetic admitted COPY as tests/stats-recovery.spec.ts; none of these rows is native qualification evidence.
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
const chainState = (block: number, blockHash: string, blockTimestamp: number): IndexerDocument => ({
  collection: 'updatesStreams', id: 'chainState', blockHeight: block, timestamp: blockTimestamp,
  data: { id: 'chainState', block, data: JSON.stringify({ lastIndexedBlock: block, blockHash, blockTimestamp, genesisHash: SORA_MAINNET_GENESIS_HASH }) } });

async function fixture() {
  const repo = new MemoryRepository();
  await repo.upsertMany([
    repair,
    { collection: 'updatesStreams', id: STATS_ADMISSION_ID, blockHeight: prefix.block, timestamp: null,
      data: { id: STATS_ADMISSION_ID, admission, admissionDigest: statsEvidenceDigest(admission) } },
    { collection: 'updatesStreams', id: STATS_CURSOR_ID, blockHeight: prefix.block, timestamp: null,
      data: { id: STATS_CURSOR_ID, admissionDigest: statsEvidenceDigest(admission), block: prefix.block,
        hash: prefix.hash, blockTimestamp: prefix.timestamp, entitlementsReady: false } },
    chainState(prefix.block, prefix.hash, prefix.timestamp),
  ]);
  return repo;
}

/** Complete core row set at the admitted checkpoint, with the receipt invalidated first. */
async function coreFixture() {
  const repo = await fixture();
  const rows: IndexerDocument[] = [
    { collection: 'assets', id: 'asset', blockHeight: prefix.block, timestamp: prefix.timestamp, data: { id: 'asset', priceUSD: '1.00000001' } },
    { collection: 'poolXYKs', id: 'pool', blockHeight: prefix.block, timestamp: prefix.timestamp, data: { id: 'pool' } },
    { collection: 'orderBooks', id: 'book', blockHeight: prefix.block, timestamp: prefix.timestamp, data: { id: 'book' } },
    ...['price', 'apy', 'assetRegistration'].map((id): IndexerDocument => ({ collection: 'updatesStreams', id,
      blockHeight: prefix.block, timestamp: prefix.timestamp, data: { id, block: prefix.block, data: '{}' } })),
  ];
  await repo.upsertMany([...rows, statsReconciliationPending(admission, prefix.block, prefix.hash)]);
  return { repo, rows };
}

afterEach(() => vi.restoreAllMocks());

describe('capabilities outside canonical stats mode', () => {
  it('reports legacy and full-recovery modes only from observed checkpoints, policy and worker health', async () => {
    const reason = 'Recovery entitlements require independent complete-history certification.';
    expect(await indexerCapabilities(new MemoryRepository(), true)).toEqual({ schemaVersion: 1, genesisHash: SORA_MAINNET_GENESIS_HASH,
      policyHash: null, mode: 'legacy', statsReady: false, historyReady: false, currentViewsReady: false, coreViewsReady: false,
      entitlementsReady: false, indexedBlock: null, indexedBlockHash: null, reason });
    const repo = new MemoryRepository();
    await repo.upsert(chainState(prefix.block, prefix.hash, prefix.timestamp));
    expect(await indexerCapabilities(repo, true)).toMatchObject({ mode: 'legacy', statsReady: true, historyReady: true,
      currentViewsReady: true, coreViewsReady: true, entitlementsReady: false, indexedBlock: prefix.block, indexedBlockHash: prefix.hash });
    expect(await indexerCapabilities(repo, false)).toMatchObject({ statsReady: false, historyReady: false, currentViewsReady: false,
      coreViewsReady: false, indexedBlock: prefix.block });
    const identity = (policy: unknown): IndexerDocument => ({ collection: 'updatesStreams', id: 'burnRecoveryIdentity-v1',
      blockHeight: prefix.block, timestamp: null, data: { id: 'burnRecoveryIdentity-v1', data: JSON.stringify(policy) } });
    await repo.upsert(identity(admission.policy));
    expect(await indexerCapabilities(repo, true)).toMatchObject({ mode: 'full-recovery', policyHash: admission.policy.policyHash,
      entitlementsReady: false, reason });
    await repo.upsert(identity({ ...admission.policy, metadata: [] }));
    await expect(indexerCapabilities(repo, true)).rejects.toThrow('Incomplete recovery execution metadata witnesses');
  });
});

describe('canonical stats guards', () => {
  it('refuses stats mode when the chain checkpoint is absent or not a serialized state', async () => {
    const repo = await fixture();
    const state = (await repo.get('updatesStreams', 'chainState'))!;
    await repo.upsert({ ...state, data: { ...state.data, data: JSON.parse(String(state.data.data)) } });
    await expect(requireStatsRecoveryState(repo, admission)).rejects.toThrow('invalid stats chain checkpoint');
    await repo.deleteMany('updatesStreams', ['chainState']);
    await expect(requireStatsRecoveryState(repo, admission)).rejects.toThrow('invalid stats chain checkpoint');
    await expect(indexerCapabilities(repo, true)).rejects.toThrow('invalid stats chain checkpoint');
  });

  it('treats nested account-count filters and account ordering as unavailable predicates', () => {
    expect(() => assertStatsQueryArguments(undefined, undefined)).not.toThrow();
    expect(() => assertStatsQueryArguments({ and: [{ type: { equalTo: 'DAY' } }, { or: [{ volumeUSD: { greaterThan: '1' } }] }] },
      ['TIMESTAMP_DESC', 'ID_ASC'])).not.toThrow();
    for (const filter of [{ accounts: { greaterThan: 0 } }, { and: [{ type: { equalTo: 'DAY' } }, { or: [{ accounts: { isNull: false } }] }] },
      [{ not: { accounts: { equalTo: 1 } } }]]) {
      expect(() => assertStatsQueryArguments(filter, undefined)).toThrow('account creation counts are unavailable');
    }
    for (const orderBy of ['ACCOUNTS_DESC', ['TIMESTAMP_DESC', 'ACCOUNTS_ASC']]) {
      expect(() => assertStatsQueryArguments(null, orderBy)).toThrow('account creation counts are unavailable');
    }
  });

  it('serves identity streams unconditionally but gates core and current update streams on verified reconciliation', async () => {
    const { repo, rows } = await coreFixture();
    const ready = async () => true;
    expect(await assertStatsPublicRead(repo, 'updatesStreams', ['chainState', 'chainIdentity'])).toBe(true);
    for (const ids of [['stakingValidators'], ['price', 'stakingValidators']]) {
      await expect(assertStatsPublicRead(repo, 'updatesStreams', ids, ready)).rejects.toThrow('await independently verified complete reconciliation');
    }
    await expect(assertStatsPublicRead(repo, 'updatesStreams', ['price'], ready)).rejects.toThrow('core views are not ready');
    await verifyStatsCoreReconciliation(repo, admission, prefix.block, prefix.hash, rows);
    expect(await assertStatsPublicRead(repo, 'updatesStreams', ['price', 'apy'], ready)).toBe(true);
    // Without an explicit pipeline health probe the default is not ready.
    await expect(assertStatsPublicRead(repo, 'updatesStreams', ['price'])).rejects.toThrow('core views are not ready');
    await expect(assertStatsPublicRead(repo, 'assets')).rejects.toThrow('core views are not ready');
  });

  it('fences core update-stream reads to the receipt generation and leaves identity streams unfenced', async () => {
    const { repo, rows } = await coreFixture();
    await verifyStatsCoreReconciliation(repo, admission, prefix.block, prefix.hash, rows);
    const receipt = (await repo.get('updatesStreams', STATS_RECONCILIATION_ID))!;
    const fence = await statsCoreReadBoundary(repo, 'updatesStreams', ['price'], async () => true);
    expect(fence.generation).toEqual({ generation: receipt.data.generation, block: prefix.block, hash: prefix.hash });
    expect(await fence({ price: 'read' })).toEqual({ price: 'read' });
    const identity = await statsCoreReadBoundary(repo, 'updatesStreams', ['chainState'], async () => true);
    expect(identity.generation).toBeUndefined();
    await repo.upsert(statsReconciliationPending(admission, prefix.block, prefix.hash));
    await expect(fence('crossed')).rejects.toThrow('core view changed during the read');
    await expect(statsCoreReadBoundary(repo, 'updatesStreams', ['apy'], async () => true)).rejects.toThrow('core refresh is in progress');
    expect(await identity('still readable')).toBe('still readable');
  });

  it('verifies a core collection across multiple bounded pages before publishing readiness', async () => {
    const { repo, rows } = await coreFixture();
    const assets = Array.from({ length: 300 }, (_, index): IndexerDocument => {
      const id = `asset-${String(index).padStart(3, '0')}`;
      return { collection: 'assets', id, blockHeight: prefix.block, timestamp: prefix.timestamp, data: { id, priceUSD: '1' } };
    });
    await repo.upsertMany(assets);
    const query = vi.spyOn(repo, 'query');
    expect(await verifyStatsCoreReconciliation(repo, admission, prefix.block, prefix.hash, [...rows, ...assets])).toBe(true);
    expect(query.mock.calls.filter(([collection]) => collection === 'assets').map(([, args]) => args.offset)).toEqual([0, 256]);
    expect((await repo.get('updatesStreams', STATS_RECONCILIATION_ID))?.data).toMatchObject({ ready: true, rows: rows.length + assets.length });
  });

  it('does not publish readiness for rows reconciled against a different head hash', async () => {
    const { repo, rows } = await coreFixture();
    expect(await verifyStatsCoreReconciliation(repo, admission, prefix.block, hash(90), rows)).toBe(false);
    expect((await repo.get('updatesStreams', STATS_RECONCILIATION_ID))?.data.ready).toBe(false);
    expect((await indexerCapabilities(repo, true)).coreViewsReady).toBe(false);
  });

  it('keeps optional repository capabilities absent behind the stats write boundary', async () => {
    const repo = new MemoryRepository(), scoped = restrictStatsRecoveryWrites(repo, admission);
    expect(scoped.prepare).toBeUndefined();
    expect(scoped.metricsSnapshot).toBeUndefined();
    await scoped.upsert({ collection: 'assets', id: 'asset', blockHeight: prefix.block + 1, data: { id: 'asset' } });
    expect((await scoped.get('assets', 'asset'))?.data).toEqual({ id: 'asset' });
  });
});
