import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportPointRecoveryFile } from '../src/scripts/export-points-recovery.js';
import { derivePointRecoveryFile } from '../src/scripts/derive-points-recovery.js';
import { describe, expect, it, vi } from 'vitest';
import { graphql } from 'graphql';
import { encodeAddress } from '@polkadot/util-crypto';
import { ATTACKER_ACCOUNT, RECOVERY_CHECKPOINT, type BurnRecoveryPolicy } from '../src/burn-recovery.js';
import { SORA_MAINNET_GENESIS_HASH } from '../src/soraIdentity.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { ChainIndexer } from '../src/worker/chain.js';
import { createSchema } from '../src/graphql/resolvers.js';
import { initializePointsRecovery, admitPointBlock, pointBlockDocuments, pointValuation, pointAccount, projectCheckpointPoints,
  exportPointsRecovery, deriveCheckpointPointLedger, referralPointDocuments, pointsQueryIdentity, pointOwnership, pointsDigest, POINTS_RECOVERY_ID, POINTS_PROJECTION_ID,
  POINTS_CHECKPOINT_ID, POINTS_LEDGER_PREFIX, POINTS_REFERRAL_PREFIX, POINTS_VALUATION_PREFIX, validatePointSource } from '../src/points-recovery.js';
import { pointJournalId, validatePointJournalEntry, initialPointJournalCursor } from '../src/points-recovery.js';
import type { IndexerDocument } from '../src/repository/types.js';

const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const old = h(3), replacement = h(4), other = h(5);
const policy: BurnRecoveryPolicy = { version: 1, policyHash: h(1), releaseManifestHash: h(2), genesisHash: SORA_MAINNET_GENESIS_HASH,
  checkpoint: RECOVERY_CHECKPOINT, postForkAnchor: { block: RECOVERY_CHECKPOINT.block + 2, hash: h(10) },
  substitutions: [{ old, new: replacement }], attackerAccounts: [ATTACKER_ACCOUNT],
  metadata: [{ firstBlock: RECOVERY_CHECKPOINT.block + 1, lastBlock: RECOVERY_CHECKPOINT.block + 2, executionCodeHash: h(7), metadataHash: h(8) }] };
const cp = RECOVERY_CHECKPOINT.block;
const valuationState = (blockHeight: number, blockHash: string) => ({ blockHeight, blockHash,
  assets: new Map(), pools: new Map(), prices: new Map(), orderBookLiquidityComplete: false,
  networkLiquidityStats: { liquidityUSD: '0', poolLiquidityUSD: '0', orderBookLiquidityUSD: '0', activePools: 0, activeOrderBooks: 0, listedAssets: 0 } });
const valuationFor = (block: number, parentHash: string) => pointValuation(valuationState(block - 1, parentHash), block, parentHash);
const meta = (account = old): IndexerDocument => ({ collection: 'accountMeta', id: account, blockHeight: cp - 4, timestamp: 8000,
  data: { id: account, accountId: account, pointRecoveryPolicyHash: policy.policyHash, pointSourceAddresses: [encodeAddress(account, 69)], createdAtBlock: 2, createdAtTimestamp: 100,
    xorFees: { amount: '12.000000000000000001', amountUSD: '3.99999999' },
    xorBurned: { amount: '7', amountUSD: '2' }, xorStakingValRewards: { amount: '1', amountUSD: '0.1' },
    orderBook: { created: 2, closed: 1, amountUSD: '9' }, vault: { created: 1, closed: 0, amountUSD: '5' },
    governance: { votes: 3, amount: '3', amountUSD: '1' }, deposit: { incomingUSD: '8', outgoingUSD: '9' } } });
const era = (version = 1, account = old): IndexerDocument => ({ ...meta(account), collection: 'accountPointSystems', id: `${account}-${version}`,
  data: { ...meta(account).data, id: `${account}-${version}`, version, startedAtBlock: version + 1 } });
const chainState = (block: number, hash: string): IndexerDocument => ({ collection: 'updatesStreams', id: 'chainState', blockHeight: block, timestamp: 9000,
  data: { id: 'chainState', block, data: JSON.stringify({ lastIndexedBlock: block, blockHash: hash }) } });
const identity = (): IndexerDocument => ({ collection: 'updatesStreams', id: 'burnRecoveryIdentity-v1', blockHeight: cp + 2, data: { data: JSON.stringify(policy) } });
/** Unit fixture only: synthetic receipt root is not actual historical replay evidence. */
const checkpoint = async (rows: IndexerDocument[] = [meta(), era(), era(2), meta(ATTACKER_ACCOUNT), era(1, ATTACKER_ACCOUNT)]) => {
  const repo = new MemoryRepository();
  await initializePointsRecovery(repo, policy, 1);
  const initial = (await repo.get('updatesStreams', POINTS_RECOVERY_ID))!.data;
  const completed = { ...initial, throughBlock: cp, blockHash: RECOVERY_CHECKPOINT.hash, receiptRoot: 'a'.repeat(64) };
  await repo.upsertMany([identity(), ...rows, chainState(cp, RECOVERY_CHECKPOINT.hash),
    { collection: 'updatesStreams', id: POINTS_RECOVERY_ID, blockHeight: cp, data: completed },
    { collection: 'updatesStreams', id: POINTS_CHECKPOINT_ID, blockHeight: cp, data: { ...completed, id: POINTS_CHECKPOINT_ID } }]);
  return repo;
};

describe('Soratopia canonical point admission', () => {
  it('refuses legacy recovery continuity without valuation-bound receipts', async () => {
    const repo = new MemoryRepository(); await initializePointsRecovery(repo, policy, 1);
    const row = (await repo.get('updatesStreams', POINTS_RECOVERY_ID))!;
    delete row.data.valuationReceiptSchema;
    await repo.upsert(row);
    await expect(initializePointsRecovery(repo, policy, 1)).rejects.toThrow('fresh replay required');
  });
  it('commits canonical inspectable price inputs and changes the receipt for reserve, metadata or price changes', async () => {
    const repo = new MemoryRepository(); await initializePointsRecovery(repo, policy, 1);
    const previous = await admitPointBlock(repo, policy, 1, h(30), policy.genesisHash);
    const state = valuationState(0, policy.genesisHash);
    state.assets.set(h(5), { id: h(5), symbol: 'B', name: 'B asset', decimals: 18, supply: 0n });
    state.assets.set(h(4), { id: h(4), symbol: 'A', name: 'A asset', decimals: 6, supply: 0n });
    state.pools.set(`${h(4)}\0${h(5)}`, { baseAssetId: h(4), targetAssetId: h(5), baseAssetReserves: 123n, targetAssetReserves: 456n });
    state.prices.set(h(5), 9007199254740993n); state.prices.set(h(4), 1000000000000000000n);
    const witness = pointValuation(state, 1, policy.genesisHash);
    const reversed = { ...state, assets: new Map([...state.assets].reverse()), prices: new Map([...state.prices].reverse()) };
    expect(pointValuation(reversed, 1, policy.genesisHash)).toEqual(witness);
    const documents = pointBlockDocuments(policy, previous, 1, h(30), '0x0102', [], [], witness);
    const snapshot = documents.find((row) => row.id.startsWith(POINTS_VALUATION_PREFIX))!;
    expect(snapshot.data).toMatchObject({ inputsSha256: witness.inputsSha256, storageProofsVerified: false,
      inputs: { priceScaleDecimals: 18, prices: [[h(4), '1000000000000000000'], [h(5), '9007199254740993']] } });
    const receipt = documents.find((row) => row.id === POINTS_RECOVERY_ID)!.data.receiptRoot;
    for (const edit of [(next: typeof state) => { next.assets.get(h(4)).decimals = 7; },
      (next: typeof state) => { next.pools.get(`${h(4)}\0${h(5)}`).targetAssetReserves += 1n; },
      (next: typeof state) => { next.prices.set(h(5), 9007199254740994n); }]) {
      const next = structuredClone(state); edit(next);
      const changed = pointValuation(next, 1, policy.genesisHash);
      expect(changed.inputsSha256).not.toBe(witness.inputsSha256);
      expect(pointBlockDocuments(policy, previous, 1, h(30), '0x0102', [], [], changed)
        .find((row) => row.id === POINTS_RECOVERY_ID)!.data.receiptRoot).not.toBe(receipt);
    }
    const tampered = structuredClone(witness); tampered.inputs.prices[0][1] = '7';
    expect(() => pointBlockDocuments(policy, previous, 1, h(30), '0x0102', [], [], tampered)).toThrow('mismatched');
    const unordered = structuredClone(witness); unordered.inputs.assets.reverse(); unordered.inputsSha256 = pointsDigest(unordered.inputs);
    expect(() => pointBlockDocuments(policy, previous, 1, h(30), '0x0102', [], [], unordered)).toThrow('unordered');
  });
  it('rejects unbound, wrong-parent, oversized and malformed valuation inputs', () => {
    const state = valuationState(0, policy.genesisHash);
    expect(() => pointValuation({ ...state, blockHash: undefined }, 1, policy.genesisHash)).toThrow('exact parent');
    expect(() => pointValuation({ ...state, blockHash: h(99) }, 1, policy.genesisHash)).toThrow('exact parent');
    expect(() => pointValuation({ ...state, blockHeight: 1 }, 1, policy.genesisHash)).toThrow('exact parent');
    const oversized = { ...state, prices: new Map(Array.from({ length: 8193 }, (_, i) => [h(i + 1), 1n] as const)) };
    expect(() => pointValuation(oversized, 1, policy.genesisHash)).toThrow('entry bound');
    state.assets.set(h(4), { id: h(4), symbol: 'A', name: 'x'.repeat(4 * 1024 * 1024), decimals: 18, supply: 0n });
    expect(() => pointValuation(state, 1, policy.genesisHash)).toThrow('byte bound');
    state.assets.clear(); state.prices.set(h(4), -1n);
    expect(() => pointValuation(state, 1, policy.genesisHash)).toThrow('integer');
  });
  it('rejects recovery cache fallbacks and foreign parent inputs before any block writes', async () => {
    const repo = new MemoryRepository(); await initializePointsRecovery(repo, policy, 1);
    const worker = new ChainIndexer({ burnRecoveryPolicy: policy } as never, repo) as any;
    const fetched = { requestedHash: h(30), signedBlock: { block: { toHex: () => '0x0102', extrinsics: [],
      header: { number: { toNumber: () => 1 }, hash: { toString: () => h(30) }, parentHash: { toString: () => policy.genesisHash } } } }, events: [], timestamp: 1000 };
    const writes = vi.spyOn(repo, 'upsertMany');
    worker.prices = new Map([[h(4), 99n]]); worker.assetInfos = new Map();
    await expect(worker.indexFetchedBlock(fetched)).rejects.toThrow('live-cache fallback is forbidden');
    await expect(worker.indexFetchedBlock(fetched, { historicalValuationState: valuationState(0, h(99)) })).rejects.toThrow('exact parent');
    await expect(worker.indexFetchedBlock({ ...fetched, requestedHash: h(99) }, {
      historicalValuationState: valuationState(0, policy.genesisHash) })).rejects.toThrow('does not match requested hash');
    expect(writes).not.toHaveBeenCalled();
    expect((await repo.get('updatesStreams', POINTS_RECOVERY_ID))!.data.throughBlock).toBe(0);
  });
  it('requires fresh full history, and refuses nonempty sources and missing restart markers', async () => {
    await expect(initializePointsRecovery(new MemoryRepository(), policy, 2)).rejects.toThrow('start at block 1');
    const repo = new MemoryRepository(); await repo.upsert(meta());
    await expect(initializePointsRecovery(repo, policy, 1)).rejects.toThrow('not empty');
    const resumed = await checkpoint(); await resumed.deleteMany('updatesStreams', [POINTS_RECOVERY_ID]);
    await expect(initializePointsRecovery(resumed, policy, 1)).rejects.toThrow('retrofitted');
  });
  it('commits continuity with block writes and rejects duplicate/gapped/foreign-parent blocks', async () => {
    const repo = new MemoryRepository(); await initializePointsRecovery(repo, policy, 0);
    const before = await admitPointBlock(repo, policy, 1, h(30), policy.genesisHash);
    const docs = pointBlockDocuments(policy, before, 1, h(30), '0x0102', ['0x0304'], [], valuationFor(1, policy.genesisHash));
    await repo.upsertMany([...docs, chainState(1, h(30))]);
    await expect(admitPointBlock(repo, policy, 1, h(30), policy.genesisHash)).rejects.toThrow('noncontiguous');
    await expect(admitPointBlock(repo, policy, 3, h(31), h(30))).rejects.toThrow('noncontiguous');
    await expect(admitPointBlock(repo, policy, 2, h(31), h(99))).rejects.toThrow('noncontiguous');
    expect(() => pointBlockDocuments(policy, before, 1, h(30), '', [], [], valuationFor(1, policy.genesisHash))).toThrow('canonical');
    await expect(initializePointsRecovery(repo, { ...policy, policyHash: h(99) }, 1)).rejects.toThrow('mismatch');
  });
  it('normalizes public addresses and retires only exact policy accounts after checkpoint', () => {
    expect(pointAccount(encodeAddress(old, 69), policy, cp)).toBe(old);
    expect(pointAccount(encodeAddress(old, 42), policy, cp + 1)).toBeNull();
    expect(pointAccount(ATTACKER_ACCOUNT, policy, cp + 1)).toBeNull();
    expect(pointAccount(replacement, policy, cp + 1)).toBe(replacement);
    expect(pointAccount(other, policy, cp + 1)).toBe(other);
    expect(pointAccount('legacy', undefined, cp + 1)).toBe('legacy');
  });
  it('does not coerce malformed or fractional point values/counters and creation data', () => {
    for (const change of [(r: IndexerDocument) => { (r.data.xorFees as any).amount = 1; },
      (r: IndexerDocument) => { (r.data.orderBook as any).created = 0.1; },
      (r: IndexerDocument) => { r.data.createdAtBlock = cp + 1; },
      (r: IndexerDocument) => { r.data.accountId = replacement; }]) {
      const row = meta(); change(row); expect(() => validatePointSource(row, old)).toThrow();
    }
  });
});

describe('Soratopia checkpoint projection', () => {
  it('moves exact metadata and all eras, preserves original evidence, and extinguishes attacker ownership', async () => {
    const repo = await checkpoint(); await projectCheckpointPoints(repo, policy);
    const replacementMeta = (await repo.get('accountMeta', replacement))!;
    expect(replacementMeta.data).toMatchObject({ ...meta().data, id: replacement, accountId: replacement });
    expect((await repo.get('accountPointSystems', `${replacement}-2`))!.data).toMatchObject({ version: 2, startedAtBlock: 3, createdAtTimestamp: 100 });
    const ledger = await exportPointsRecovery(repo, policy);
    expect(ledger.records[0].sourceMeta).toEqual(meta());
    expect(ledger.records[1]).toMatchObject({ status: 'extinguished', owner: null, claimable: false });
    expect((await repo.get('accountMeta', old))!.data.recovery).toMatchObject({ status: 'retired', claimable: false });
    expect((await repo.get('accountMeta', ATTACKER_ACCOUNT))!.data.recovery).toMatchObject({ status: 'extinguished', claimable: false });
    const before = pointsDigest(await repo.list('accountMeta'));
    await projectCheckpointPoints(repo, policy);
    expect(pointsDigest(await repo.list('accountMeta'))).toBe(before);
    expect(ledger.productionReady).toBe(false);
  });
  it('resumes a crash between atomic owners without repeating transferred balances', async () => {
    const repo = await checkpoint(); const write = repo.upsertMany.bind(repo); let calls = 0;
    vi.spyOn(repo, 'upsertMany').mockImplementation(async (rows) => { if (++calls === 2) throw new Error('synthetic crash before commit'); await write(rows); });
    await expect(projectCheckpointPoints(repo, policy)).rejects.toThrow('synthetic crash');
    expect((await repo.get('updatesStreams', POINTS_PROJECTION_ID))!.data.cursor).toBe(1);
    await expect(pointsQueryIdentity(repo)).rejects.toThrow('unavailable');
    const first = await repo.get('accountMeta', replacement); vi.restoreAllMocks();
    await projectCheckpointPoints(repo, policy);
    expect(await repo.get('accountMeta', replacement)).toEqual(first);
    expect((await exportPointsRecovery(repo, policy)).records).toHaveLength(2);
  });
  it('rejects destination history, orphan eras, oversized eras, wrong checkpoint, and missing ledger', async () => {
    const collision = await checkpoint([meta(), era(), meta(replacement), era(1, replacement)]);
    await expect(projectCheckpointPoints(collision, policy)).rejects.toThrow('destination');
    expect(await collision.get('updatesStreams', POINTS_PROJECTION_ID)).toBeNull();
    await expect(projectCheckpointPoints(await checkpoint([era()]), policy)).rejects.toThrow('mismatch');
    await expect(projectCheckpointPoints(await checkpoint([meta(), ...Array.from({ length: 129 }, (_, i) => era(i + 1))]), policy)).rejects.toThrow('bound');
    const wrong = await checkpoint(); const row = (await wrong.get('updatesStreams', POINTS_CHECKPOINT_ID))!;
    await wrong.upsert({ ...row, data: { ...row.data, blockHash: h(99) } });
    await expect(projectCheckpointPoints(wrong, policy)).rejects.toThrow('checkpoint receipt');
    const missing = await checkpoint(); await projectCheckpointPoints(missing, policy);
    await missing.deleteMany('updatesStreams', [`${POINTS_LEDGER_PREFIX}${old}`]);
    await expect(exportPointsRecovery(missing, policy)).rejects.toThrow('missing projection row');
  });
  it('records truly absent sources without inventing a zero-age entitlement or overwriting an owner', async () => {
    const repo = await checkpoint([]); await projectCheckpointPoints(repo, policy);
    expect(await repo.get('accountMeta', replacement)).toBeNull();
    expect((await exportPointsRecovery(repo, policy)).records.every((row) => row.sourcePresent === false)).toBe(true);
  });
  it('detects altered retained source evidence and ledger ordering', async () => {
    const repo = await checkpoint(); await projectCheckpointPoints(repo, policy);
    const id = `${POINTS_LEDGER_PREFIX}${old}`; const row = (await repo.get('updatesStreams', id))!;
    const changed = structuredClone(row); (changed.data.sourceMeta as any).data.createdAtTimestamp++;
    await repo.upsert(changed);
    await expect(exportPointsRecovery(repo, policy)).rejects.toThrow('commitment');
  });
});

describe('Soratopia worker and GraphQL owner behavior', () => {
  it('continues transferred aggregate exactly once through the unchanged worker point arithmetic', async () => {
    const firstEra = era(); firstEra.data.startedAtBlock = 50; firstEra.data.governance = { votes: 1, amount: '1', amountUSD: '0.5' };
    const repo = await checkpoint([meta(), firstEra, era(2)]); await projectCheckpointPoints(repo, policy);
    const worker = new ChainIndexer({ burnRecoveryPolicy: policy } as never, repo) as any;
    const rows = await worker.createAccountDocuments([encodeAddress(replacement, 69), old, ATTACKER_ACCOUNT], 'tx', cp + 1, 10000, new Map(),
      { module: 'democracy', method: 'vote', data: { amount: '2', amountUSD: '4' }, fee: 0n, failed: false });
    const prior = await admitPointBlock(repo, policy, cp + 1, h(80), RECOVERY_CHECKPOINT.hash);
    await repo.upsertMany([...rows, ...pointBlockDocuments(policy, prior, cp + 1, h(80), '0x0102', [], rows, valuationFor(cp + 1, RECOVERY_CHECKPOINT.hash)), chainState(cp + 1, h(80))]);
    const result = (await repo.get('accountMeta', replacement))!.data;
    expect(result.createdAtTimestamp).toBe(100);
    expect(result.governance).toEqual({ votes: 4, amount: '5', amountUSD: '5' });
    expect((await repo.get('accountPointSystems', `${replacement}-1`))!.data).toMatchObject({ startedAtBlock: 50, governance: { votes: 2, amount: '3', amountUSD: '4.5' } });
    expect((await repo.get('accountPointSystems', `${replacement}-2`))!.data.governance).toEqual(era(2).data.governance);
    expect(rows.filter((r: IndexerDocument) => r.collection === 'accountMeta').map((r: IndexerDocument) => r.id)).toEqual([replacement]);
    await projectCheckpointPoints(repo, policy);
    expect((await repo.get('accountMeta', replacement))!.data.governance).toEqual(result.governance);
  });
  it('serves the replacement with unchanged query shape and hides old/attacker points', async () => {
    const repo = await checkpoint(); await projectCheckpointPoints(repo, policy); const schema = createSchema();
    const query = 'query($id: String!) { accountMeta(id: $id) { id accountId createdAtTimestamp xorFees } accountPointSystems(filter: { accountId: { equalTo: $id } }, orderBy: [ID_ASC]) { nodes { version startedAtBlock } } }';
    const result = await graphql({ schema, source: query, variableValues: { id: encodeAddress(replacement, 69) }, contextValue: { repository: repo } });
    expect(result.errors).toBeUndefined(); expect(result.data?.accountMeta).toMatchObject({ id: replacement, createdAtTimestamp: 100 });
    expect((result.data?.accountPointSystems as any).nodes).toHaveLength(2);
    for (const id of [old, encodeAddress(ATTACKER_ACCOUNT, 69)]) {
      const hidden = await graphql({ schema, source: query, variableValues: { id }, contextValue: { repository: repo } });
      expect(hidden.errors).toBeUndefined(); expect(hidden.data?.accountMeta).toBeNull(); expect((hidden.data?.accountPointSystems as any).nodes).toEqual([]);
    }
    const unsafe = await graphql({ schema, source: '{ accountPointSystems { nodes { id } } }', contextValue: { repository: repo } });
    expect(unsafe.errors).toBeDefined();
  });
  it('deduplicates SS58 aliases into one point owner while retaining exact historical spellings', async () => {
    const repo = new MemoryRepository();
    const worker = new ChainIndexer({ burnRecoveryPolicy: policy } as never, repo) as any;
    const aliases = [encodeAddress(old, 69), encodeAddress(old, 42)];
    const rows = await worker.createAccountDocuments(aliases, 'tx', 7, 10000, new Map(),
      { module: 'democracy', method: 'vote', data: { amount: '2', amountUSD: '4' }, fee: 0n, failed: false });
    const pointRows = rows.filter((r: IndexerDocument) => r.collection !== 'accounts');
    expect(pointRows.map((r: IndexerDocument) => `${r.collection}/${r.id}`)).toHaveLength(2);
    expect(pointRows[0].data.governance.votes).toBe(1);
    expect(pointRows[0].data.pointSourceAddresses).toEqual([...aliases].sort());
    expect(new Set(pointRows.map((r: IndexerDocument) => `${r.collection}/${r.id}`)).size).toBe(2);
  });
  it('commits one canonical owner and continuity atomically with the real worker block path', async () => {
    const repo = new MemoryRepository(); await initializePointsRecovery(repo, policy, 1);
    const worker = new ChainIndexer({ burnRecoveryPolicy: policy, chainStartBlock: 1, stateRefreshIntervalBlocks: 250,
      snapshotIntervalBlocks: 250, fullReconciliationIntervalBlocks: 250, priceStreamRefreshIntervalBlocks: 0 } as never, repo) as any;
    worker.observedGenesisHash = policy.genesisHash;
    const hash = h(90); const aliases = [encodeAddress(old, 69), encodeAddress(old, 42)];
    const xor = '0x0200000000000000000000000000000000000000000000000000000000000000';
    const fee = { toHex: () => '0x0304', phase: { isApplyExtrinsic: true, asApplyExtrinsic: { toNumber: () => 0 } },
      event: { section: 'xorFee', method: 'FeeWithdrawn', data: { toArray: () => [{ toJSON: () => '1000000000000000000' }] },
        meta: { fields: [{ name: { isSome: true, unwrap: () => ({ toString: () => 'amount' }) } }] } } };
    const fetched = { requestedHash: hash, signedBlock: { block: { toHex: () => '0x0102',
      header: { number: { toNumber: () => 1 }, hash: { toString: () => hash }, parentHash: { toString: () => policy.genesisHash } },
      extrinsics: aliases.map((address, index) => ({ isSigned: true, signer: { toString: () => address }, hash: { toString: () => h(100 + index) },
        method: { section: 'system', method: 'remark', args: [], meta: { args: [] } } })) } }, events: [fee], timestamp: 1000 };
    const state = valuationState(0, policy.genesisHash);
    state.assets.set(xor, { id: xor, symbol: 'XOR', name: 'SORA Nexus', decimals: 18, supply: 0n });
    state.prices.set(xor, 2n * 10n ** 18n);
    worker.prices = new Map([[xor, 99n * 10n ** 18n]]);
    const valuation = pointValuation(state, 1, policy.genesisHash);
    const options = { refreshDerivedState: false, historicalValuationState: state };
    const spy = vi.spyOn(repo, 'upsertMany').mockRejectedValueOnce(new Error('atomic backend refusal'));
    await expect(worker.indexFetchedBlock(fetched, options)).rejects.toThrow('atomic backend refusal');
    expect((await repo.get('updatesStreams', POINTS_RECOVERY_ID))!.data.throughBlock).toBe(0);
    expect(await repo.get('accountMeta', old)).toBeNull();
    expect(await repo.get('updatesStreams', POINTS_VALUATION_PREFIX + valuation.inputsSha256)).toBeNull();
    expect(await repo.get('updatesStreams', pointJournalId(1))).toBeNull();
    expect(state).toMatchObject({ blockHeight: 0, blockHash: policy.genesisHash });
    spy.mockRestore(); const committed = vi.spyOn(repo, 'upsertMany');
    await worker.indexFetchedBlock(fetched, options);
    expect((await repo.get('networkSnapshots', 'block-1'))!.data.accounts).toBe(1);
    expect((await repo.get('updatesStreams', POINTS_RECOVERY_ID))!.data.throughBlock).toBe(1);
    const rows = committed.mock.calls[0][0];
    expect(new Set(rows.map((row) => `${row.collection}/${row.id}`)).size).toBe(rows.length);
    expect(rows.some((row) => row.id === 'chainState')).toBe(true);
    expect(rows.some((row) => row.id === POINTS_RECOVERY_ID)).toBe(true);
    expect(rows.some((row) => row.id === POINTS_VALUATION_PREFIX + valuation.inputsSha256)).toBe(true);
    const journal = rows.find((row) => row.id === pointJournalId(1))!;
    expect(journal).toBeDefined();
    expect(journal.data.pointRows).toEqual(rows.filter((row) => row.collection === 'accountMeta' || row.collection === 'accountPointSystems'));
    expect(validatePointJournalEntry({ journal, valuation: rows.find((row) => row.id === POINTS_VALUATION_PREFIX + valuation.inputsSha256)! },
      policy, initialPointJournalCursor(policy)).receiptRoot).toBe((await repo.get('updatesStreams', POINTS_RECOVERY_ID))!.data.receiptRoot);
    expect((await repo.get('updatesStreams', POINTS_RECOVERY_ID))!.data.valuation).toMatchObject({
      parentBlock: 0, parentHash: policy.genesisHash, inputsSha256: valuation.inputsSha256, storageProofsVerified: false });
    expect((await repo.get('accountMeta', old))!.data.xorFees).toEqual({ amount: '1', amountUSD: '2' });
    expect((await repo.get('updatesStreams', POINTS_VALUATION_PREFIX + valuation.inputsSha256))!.data.inputs).toMatchObject({ prices: [[xor, '2000000000000000000']] });
    expect(worker.prices.get(xor)).toBe(99n * 10n ** 18n);
    expect(state).toMatchObject({ blockHeight: 1, blockHash: hash });
    await expect(worker.indexFetchedBlock(fetched, { ...options, historicalValuationState: valuationState(0, policy.genesisHash) })).rejects.toThrow('noncontiguous');
  });
  it('exposes bounded ownership history sources only after exact canonical projection', async () => {
    const repo = await checkpoint(); await projectCheckpointPoints(repo, policy);
    const owner = await pointOwnership(repo, encodeAddress(replacement, 69));
    expect(owner).toMatchObject({ status: 'replacement', ready: true, accountId: replacement, policyHash: policy.policyHash,
      sources: [{ account: encodeAddress(old, 69), firstBlock: 1, lastBlock: cp }] });
    expect(await pointOwnership(repo, old)).toMatchObject({ status: 'retired', sources: [] });
    expect(await pointOwnership(repo, ATTACKER_ACCOUNT)).toMatchObject({ status: 'extinguished', sources: [] });
    const query = await graphql({ schema: createSchema(), source: 'query($id:String!) { soratopiaPointOwnership(id:$id) { status ready policyHash sources { account firstBlock lastBlock } } accountMeta(id:$id) { recoveryPolicyHash } }',
      variableValues: { id: replacement }, contextValue: { repository: repo } });
    expect(query.errors).toBeUndefined(); expect(query.data?.accountMeta).toMatchObject({ recoveryPolicyHash: policy.policyHash });
    await repo.upsert(chainState(cp + 1, h(88)));
    await expect(pointsQueryIdentity(repo)).rejects.toThrow('point/chain checkpoint mismatch');
  });
  it('deduplicates full-root validation and pins selected evidence without a global scan on each query', async () => {
    const repo = await checkpoint(); await projectCheckpointPoints(repo, policy);
    const reads = vi.spyOn(repo, 'get');
    await Promise.all([pointOwnership(repo, replacement), pointOwnership(repo, replacement)]);
    expect(reads.mock.calls.filter(([collection, id]) => collection === 'updatesStreams' && id === POINTS_LEDGER_PREFIX + ATTACKER_ACCOUNT)).toHaveLength(1);
    reads.mockClear();
    await pointOwnership(repo, replacement);
    expect(reads.mock.calls.filter(([collection, id]) => collection === 'updatesStreams' && id === POINTS_LEDGER_PREFIX + ATTACKER_ACCOUNT)).toHaveLength(0);
    expect(reads.mock.calls.filter(([collection, id]) => collection === 'updatesStreams' && id === POINTS_LEDGER_PREFIX + old)).toHaveLength(1);
    const stored = (await repo.get('updatesStreams', POINTS_LEDGER_PREFIX + old))!;
    await repo.upsert({ ...stored, data: { ...stored.data, sourcePresent: false } });
    await expect(pointOwnership(repo, replacement)).rejects.toThrow('selected immutable owner row changed');
  });
  it('refuses queries while projection is incomplete rather than caching partial balances', async () => {
    const repo = await checkpoint();
    const result = await graphql({ schema: createSchema(), source: 'query($id: String!) { accountMeta(id:$id) { id } }', variableValues: { id: replacement }, contextValue: { repository: repo } });
    expect(result.errors?.[0].message).toContain('unavailable');
  });
});


describe('Soratopia referral points and executable export separation', () => {
  const referral = (account = old, amount = '123000000000000000001'): IndexerDocument => ({ collection: 'updatesStreams',
    id: POINTS_REFERRAL_PREFIX + account, blockHeight: cp - 1, timestamp: 8000,
    data: { id: POINTS_REFERRAL_PREFIX + account, accountId: account, policyHash: policy.policyHash, amountCodec: amount } });
  it('projects referral-only ownership, preserves original amount, extinguishes attackers and adds future events once', async () => {
    const repo = await checkpoint([referral(), referral(ATTACKER_ACCOUNT)]);
    await projectCheckpointPoints(repo, policy);
    expect(await repo.get('accountMeta', replacement)).toBeNull();
    expect(await pointOwnership(repo, replacement)).toMatchObject({ referralRewardsCodec: '123000000000000000001', sources: [] });
    const ledger = await exportPointsRecovery(repo, policy);
    expect(ledger.records[0]).toMatchObject({ sourceMeta: null, sourcePresent: true, claimable: true, referralSource: referral() });
    expect(await pointOwnership(repo, ATTACKER_ACCOUNT)).toMatchObject({ referralRewardsCodec: '0', status: 'extinguished' });
    const previous = await admitPointBlock(repo, policy, cp + 1, h(66), RECOVERY_CHECKPOINT.hash);
    const rows = await referralPointDocuments(repo, policy, cp + 1, 10000, [
      { referrer: encodeAddress(replacement, 69), referral: other, amount: '4' },
      { referrer: replacement, referral: other, amount: '6' },
      { referrer: old, referral: other, amount: '100' },
      { referrer: ATTACKER_ACCOUNT, referral: other, amount: '100' },
    ]);
    expect(rows).toHaveLength(1);
    await repo.upsertMany([...rows, ...pointBlockDocuments(policy, previous, cp + 1, h(66), '0x0102', ['0x0304'], rows, valuationFor(cp + 1, RECOVERY_CHECKPOINT.hash)), chainState(cp + 1, h(66))]);
    expect(await pointOwnership(repo, replacement)).toMatchObject({ referralRewardsCodec: '123000000000000000011' });
    await projectCheckpointPoints(repo, policy);
    expect((await repo.get('updatesStreams', POINTS_REFERRAL_PREFIX + replacement))!.data.amountCodec).toBe('123000000000000000011');
    expect((await exportPointsRecovery(repo, policy)).records[0].referralSource).toEqual(referral());
    await expect(referralPointDocuments(repo, policy, cp + 2, 10001, [{ referrer: replacement, referral: other, amount: (1n << 128n).toString() }])).rejects.toThrow('amount');
  });
  it('refuses a preexisting destination referral total even when both account metadata records are absent', async () => {
    const repo = await checkpoint([referral(), referral(replacement)]);
    await expect(projectCheckpointPoints(repo, policy)).rejects.toThrow('destination');
  });
  it('derives identical canonical ledger using allocation policy only, before any future identity exists', async () => {
    const repo = await checkpoint([meta(), era(), referral()]); await projectCheckpointPoints(repo, policy);
    const live = await exportPointsRecovery(repo, policy);
    const { releaseManifestHash: _manifest, postForkAnchor: _anchor, metadata: _metadata, ...allocation } = policy;
    const sources = live.records.map((row) => ({ original: row.original as string, sourceMeta: row.sourceMeta as IndexerDocument | null,
      sourceEras: row.sourceEras as IndexerDocument[], referralSource: row.referralSource as IndexerDocument | null,
      destinationMeta: null, destinationEras: [] as [], destinationReferral: null }));
    const derived = deriveCheckpointPointLedger(allocation, String(live.checkpointReceiptRoot), sources);
    expect(derived).toEqual(live);
    expect(JSON.stringify(derived)).not.toContain('releaseManifestHash');
    expect(JSON.stringify(derived)).not.toContain('postForkAnchor');
    expect(derived.externalReplayVerified).toBe(false);
    const folder = await realpath(await mkdtemp(join(tmpdir(), 'soratopia-pure-')));
    try {
      const policyFile = join(folder, 'allocation.json'), captureFile = join(folder, 'capture.json');
      await writeFile(policyFile, JSON.stringify(allocation));
      await writeFile(captureFile, JSON.stringify({ schema: 'sora-nexus-soratopia-checkpoint-owner-sources-v1', checkpoint: RECOVERY_CHECKPOINT,
        checkpointReceiptRoot: live.checkpointReceiptRoot, sources }));
      const hash = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');
      const opts = { policy: policyFile, policySha256: await hash(policyFile), capture: captureFile, captureSha256: await hash(captureFile), output: join(folder, 'derived.json') };
      const result = await derivePointRecoveryFile(opts);
      expect(result).toMatchObject({ futureAnchorRequired: false, externalReplayVerified: false, productionReady: false });
      expect(JSON.parse(await readFile(opts.output, 'utf8'))).toEqual(live);
      await expect(derivePointRecoveryFile(opts)).rejects.toThrow();
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
  it('exports a read-only owned copy without mutation and refuses existing outputs or changed source files', async () => {
    const folder = await realpath(await mkdtemp(join(tmpdir(), 'soratopia-export-')));
    try {
      const databaseCopy = join(folder, 'points-recovery-copy'); await mkdir(databaseCopy); await writeFile(join(databaseCopy, 'CURRENT'), 'fixture-manifest');
      const policyFile = join(folder, 'policy.json'); const policyBytes = JSON.stringify(policy); await writeFile(policyFile, policyBytes);
      const options = { databaseCopy, policy: policyFile, policySha256: createHash('sha256').update(policyBytes).digest('hex'), output: join(folder, 'out') };
      const repo = await checkpoint(); await projectCheckpointPoints(repo, policy);
      const writes = vi.spyOn(repo, 'upsertMany'); const close = vi.spyOn(repo, 'close').mockResolvedValue(undefined);
      const before = pointsDigest(await repo.list('updatesStreams'));
      const result = await exportPointRecoveryFile(options, { openRepository: async () => repo });
      expect(result.externalReplayVerified).toBe(false); expect(writes).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
      expect(pointsDigest(await repo.list('updatesStreams'))).toBe(before);
      const receipt = JSON.parse(await readFile(join(options.output, 'EXPORT.json'), 'utf8'));
      expect(receipt).toMatchObject({ databaseUnchanged: true, preReleaseGenerationVerified: false });
      await expect(exportPointRecoveryFile(options, { openRepository: async () => repo })).rejects.toThrow();
      await expect(exportPointRecoveryFile({ ...options, output: join(folder, 'mutated') }, { openRepository: async () => {
        await writeFile(join(databaseCopy, 'CURRENT'), 'changed'); return repo;
      } })).rejects.toThrow('database copy changed');
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
});
