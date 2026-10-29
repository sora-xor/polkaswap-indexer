import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateRecoveryBurns, ATTACKER_ACCOUNT, RECOVERY_CHECKPOINT, validateBurnAllocationPolicy, validateBurnRecoveryPolicy, type BurnRecoveryPolicy, type CanonicalBurnReceipt } from '../src/burn-recovery.js';
import { createXorBurnDocumentsFromEvents } from '../src/worker/chain.js';
import { SORA_MAINNET_GENESIS_HASH } from '../src/soraIdentity.js';
import { prepareBurnRecovery } from '../src/scripts/prepare-burn-recovery.js';
import { ChainIndexer } from '../src/worker/chain.js';
import { MemoryRepository } from '../src/repository/memory.js';
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const old = h(3), replacement = h(4);
const policy: BurnRecoveryPolicy = {
  version: 1, policyHash: h(1), releaseManifestHash: h(2), genesisHash: SORA_MAINNET_GENESIS_HASH,
  checkpoint: RECOVERY_CHECKPOINT, postForkAnchor: { block: RECOVERY_CHECKPOINT.block + 2, hash: h(10) },
  substitutions: [{ old, new: replacement }], attackerAccounts: [ATTACKER_ACCOUNT],
  metadata: [{ firstBlock: RECOVERY_CHECKPOINT.block + 1, lastBlock: RECOVERY_CHECKPOINT.block + 2, executionCodeHash: h(7), metadataHash: h(8) }],
};
const receipt = (blockHeight: number, address = old, campaign?: 'tonswap', eventIndex = 0): CanonicalBurnReceipt => ({
  id: `${h(blockHeight)}:${eventIndex}`, blockHash: h(blockHeight), eventIndex, blockHeight,
  extrinsicIndex: eventIndex, txHash: h(blockHeight + 1 + eventIndex), address, amount: '1', ...(campaign ? { campaign } : {}),
});
const XOR = `0x02${'00'.repeat(31)}`;
const burn = (amount = '1000000000000000000') => ({ phase: { isApplyExtrinsic: true, asApplyExtrinsic: { toNumber: () => 0 } },
  event: { section: 'assets', method: 'Burn', data: { toArray: () => [old, XOR, amount].map((v) => ({ toString: () => v })) } },
});
const call = { section: 'assets', method: 'burn', args: [XOR, '999000000000000000000'], meta: { args: [{ name: 'assetId' }, { name: 'amount' }] } };
const block = (method = 'batch', calls: unknown[] = [call, call]) => ({ block: { extrinsics: [{ hash: { toString: () => h(9) }, method: { section: 'utility', method, args: [calls] } }] } });

describe('canonical burn event receipts', () => {
  it('never uses call amounts when no Burn event exists, even for a successful outer batch', () => {
    expect(createXorBurnDocumentsFromEvents(h(1), 27_800_000, 1, block(), [], new Map())).toEqual([]);
  });
  it('keeps multiple events in one extrinsic distinct and uses executed event amounts', () => {
    const rows = createXorBurnDocumentsFromEvents(h(1), 27_800_000, 1, block(), [burn(), burn('2000000000000000000')] as never, new Map());
    expect(rows.map((r) => [r.id, r.data.amount])).toEqual([[`${h(1)}:0`, '1'], [`${h(1)}:1`, '2']]);
  });
  it('rejects ambiguous event association with an atomic campaign marker', () => {
    const remark = { section: 'system', method: 'remark', args: [JSON.stringify({ app: 'polkaswap', kind: 'tonswap-xor-burn', version: 1 })], meta: { args: [{ name: 'remark' }] } };
    expect(() => createXorBurnDocumentsFromEvents(h(1), 27_800_000, 1, block('batchAll', [call, remark]), [burn(), burn()] as never, new Map())).toThrow('Ambiguous');
    expect(() => createXorBurnDocumentsFromEvents(h(1), 27_800_000, 1, block('batch', [call, remark]), [burn()] as never, new Map())).toThrow('Ambiguous');
  });
});
describe('checkpoint burn allocations', () => {
  it('computes entitlements before a post-fork anchor or outer release exists while live admission still rejects it', () => {
    const {releaseManifestHash: _release, postForkAnchor: _anchor, metadata: _metadata, ...allocationPolicy} = policy;
    expect(validateBurnAllocationPolicy(allocationPolicy)).toEqual(allocationPolicy);
    expect(allocateRecoveryBurns([receipt(25_867_650)], allocationPolicy)[0].ssAllocated).toBe('50');
    expect(() => validateBurnRecoveryPolicy(allocationPolicy)).toThrow('Invalid burn recovery');
  });
  it('remaps effective owner without rewriting burn provenance and applies SS tier boundaries', () => {
    const rows = allocateRecoveryBurns([receipt(25_867_649), { ...receipt(25_867_650), nexusRecipient: 'recorded' }], policy);
    expect(rows.map((r) => r.ssAllocated)).toEqual(['100', '50']);
    expect(rows[1]).toMatchObject({ originalAddress: old, address: old, claimOwner: replacement, nexusXorAllocated: '1', nexusXorClaimable: '0', claimStatus: 'recipient-confirmation-required' });
  });
  it('extinguishes attacker rewards after the curve, without reallocating to victims', () => {
    const receipts = [receipt(27_720_478, ATTACKER_ACCOUNT, 'tonswap'), receipt(27_720_479, old, 'tonswap')];
    const rows = allocateRecoveryBurns(receipts, policy);
    expect(rows[0].tsClaimable).toBe('0');
    expect(rows[0].tsAllocated).not.toBe('0');
    expect(rows[0].claimStatus).toBe('extinguished');
    const withoutFirst = allocateRecoveryBurns([receipts[1]], policy);
    expect(rows[1].tsAllocated).not.toBe(withoutFirst[0].tsAllocated);
  });
  it('deduplicates identical receipt identities and rejects contradictory evidence and orphan blocks', () => {
    const r = receipt(27_800_000, old, 'tonswap');
    expect(allocateRecoveryBurns([r, r], policy)).toHaveLength(1);
    expect(() => allocateRecoveryBurns([r, { ...r, amount: '2' }], policy)).toThrow('Conflicting');
    expect(() => allocateRecoveryBurns([receipt(RECOVERY_CHECKPOINT.block + 1)], policy)).toThrow('checkpoint');
  });
  it('rejects overlapping victim/attacker mappings and a pre-fork identity anchor', () => {
    expect(() => validateBurnRecoveryPolicy({ ...policy, substitutions: [{ old: ATTACKER_ACCOUNT, new: replacement }] })).toThrow('overlap');
    expect(() => validateBurnRecoveryPolicy({ ...policy, postForkAnchor: RECOVERY_CHECKPOINT })).toThrow('Invalid');
    expect(() => validateBurnRecoveryPolicy({ ...policy, metadata: [] })).toThrow('metadata');
  });
});

describe('recovery metadata witnesses', () => {
  it('allows a contiguous historical prefix but rejects gaps and uncovered recovery history', () => {
    const historical = { firstBlock: 25_043_003, lastBlock: RECOVERY_CHECKPOINT.block, executionCodeHash: h(20), metadataHash: h(21) };
    expect(validateBurnRecoveryPolicy({ ...policy, metadata: [historical, ...policy.metadata] }).metadata).toHaveLength(2);
    expect(() => validateBurnRecoveryPolicy({ ...policy, metadata: [{ ...historical, lastBlock: historical.lastBlock - 1 }, ...policy.metadata] })).toThrow('metadata');
    expect(() => validateBurnRecoveryPolicy({ ...policy, metadata: [{ ...policy.metadata[0], firstBlock: RECOVERY_CHECKPOINT.block + 2 }] })).toThrow('metadata');
  });
  it('rejects unbound metadata before constructing a registry', async () => {
    const { decodeRecoveryBlock, recoveryMetadataWitness } = await import('../src/recovery-metadata.js');
    expect(() => recoveryMetadataWitness(policy, RECOVERY_CHECKPOINT.block)).toThrow('No pinned');
    expect(() => decodeRecoveryBlock(policy, h(10), RECOVERY_CHECKPOINT.block + 1, '0x0102', {}, '0x00', '0x0100000000000000')).toThrow('metadata hash mismatch');
  });
  it('decodes the witnessed execution metadata independently of spec-version registry caches', async () => {
    const { default: metadata } = await import('@polkadot/types-support/metadata/v14/substrate-hex');
    const { TypeRegistry } = await import('@polkadot/types');
    const { blake2AsHex } = await import('@polkadot/util-crypto');
    const { decodeRecoveryBlock } = await import('../src/recovery-metadata.js');
    const registry = new TypeRegistry();
    const height = RECOVERY_CHECKPOINT.block + 1;
    const header = registry.createType('Header', { parentHash: RECOVERY_CHECKPOINT.hash, number: height, stateRoot: h(6), extrinsicsRoot: h(7), digest: { logs: [] } });
    const configured = { ...policy, metadata: [{ ...policy.metadata[0], metadataHash: blake2AsHex(metadata) }] };
    const decoded = decodeRecoveryBlock(configured, header.hash.toHex(), height, metadata,
      { block: { header: header.toJSON(), extrinsics: [] }, justifications: null }, '0x00', '0xe803000000000000');
    expect(decoded.signedBlock.block.header.number.toNumber()).toBe(height);
    expect(decoded.events).toHaveLength(0);
    expect(decoded.timestampMilliseconds).toBe('1000');
    expect(decoded.executionCodeHash).toBe(h(7));
  });
});

describe('isolated recovery admission', () => {
  const indexer = (repository: MemoryRepository, recovery: unknown = policy) => new ChainIndexer({
    host: '127.0.0.1', port: 4350, graphqlPath: '/graphql', databaseUrl: '', soraWsEndpoint: 'ws://localhost.invalid',
    chainStartBlock: 0, chainBatchSize: 25, stateRefreshIntervalBlocks: 250, snapshotIntervalBlocks: 250,
    burnRecoveryPolicy: recovery,
  } as never, repository) as unknown as {
    ensureRecoveryBurnIdentity: (height: number) => Promise<void>;
    indexFetchedBlock: (fetched: unknown) => Promise<void>;
  };
  it('pins a new database and refuses a changed policy or omitted recovery identity on restart', async () => {
    const repository = new MemoryRepository();
    await indexer(repository).ensureRecoveryBurnIdentity(policy.postForkAnchor.block);
    await expect(indexer(repository).ensureRecoveryBurnIdentity(policy.postForkAnchor.block)).resolves.toBeUndefined();
    await expect(indexer(repository, { ...policy, policyHash: h(24) }).ensureRecoveryBurnIdentity(policy.postForkAnchor.block)).rejects.toThrow('policy mismatch');
    await expect(indexer(repository, null).ensureRecoveryBurnIdentity(policy.postForkAnchor.block)).rejects.toThrow('without its pinned policy');
  });
  it('rejects legacy receipts and an existing materialized checkpoint database', async () => {
    const legacy = new MemoryRepository();
    await legacy.upsert({ collection: 'xorBurns', id: 'legacy', blockHeight: 27_800_000, timestamp: null, data: {} });
    await expect(indexer(legacy).ensureRecoveryBurnIdentity(policy.postForkAnchor.block)).rejects.toThrow('isolated event-derived rebuild');
    const materialized = new MemoryRepository();
    await materialized.upsert({ collection: 'networkSnapshots', id: 'block-1', blockHeight: 1, timestamp: null, data: {} });
    await expect(indexer(materialized).ensureRecoveryBurnIdentity(policy.postForkAnchor.block)).rejects.toThrow('isolated empty database');
    await expect(indexer(new MemoryRepository()).ensureRecoveryBurnIdentity(RECOVERY_CHECKPOINT.block)).rejects.toThrow('not finalized');
  });
  it('cannot cross the checkpoint when a worker started without recovery policy', async () => {
    const repository = new MemoryRepository();
    await expect(indexer(repository, null).indexFetchedBlock({ events: [], signedBlock: {
      block: { header: { number: { toNumber: () => RECOVERY_CHECKPOINT.block + 1 } } },
    } })).rejects.toThrow('Post-checkpoint indexing');
    expect(await repository.list('xorBurns')).toEqual([]);
  });
});

describe('offline checkpoint ledger preparation', () => {
  it('binds exact inputs, keeps replacement provenance, and cannot overwrite an existing output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'burn-recovery-test-'));
    const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
    try {
      const capture = JSON.stringify({ version: 1, checkpoint: RECOVERY_CHECKPOINT,
        coverage: { firstBlock: 25_043_003, lastBlock: RECOVERY_CHECKPOINT.block, evidenceHash: h(25) },
        receipts: [receipt(27_800_000, old, 'tonswap')],
      });
      const {releaseManifestHash: _release, postForkAnchor: _anchor, metadata: _metadata, ...allocationPolicy} = policy;
      const policyJson = JSON.stringify(allocationPolicy);
      const options = { capture: join(dir, 'capture.json'), captureSha256: digest(capture),
        policy: join(dir, 'policy.json'), policySha256: digest(policyJson), output: join(dir, 'ledger.json') };
      await writeFile(options.capture, capture);
      await writeFile(options.policy, policyJson);
      await expect(prepareBurnRecovery({ ...options, captureSha256: '0'.repeat(64) })).rejects.toThrow('SHA-256');
      await prepareBurnRecovery(options);
      const ledger = JSON.parse(await readFile(options.output, 'utf8'));
      expect(ledger).toMatchObject({ policyHash: policy.policyHash, receiptCount: 1,
        status: 'prepared-requires-release-verification', sourceCaptureSha256: options.captureSha256 });
      expect(ledger.entitlements[0]).toMatchObject({ originalAddress: old, claimOwner: replacement });
      expect(ledger).not.toHaveProperty('postForkAnchor');
      expect(ledger).not.toHaveProperty('releaseManifestHash');
      expect(ledger.allocationPolicySha256).toBe(digest(policyJson));
      expect(ledger.entitlementsSha256).toBe(digest(JSON.stringify(ledger.entitlements)));
      await expect(prepareBurnRecovery(options)).rejects.toThrow('EEXIST');
      const incomplete = capture.replace('25043003', '25043004');
      await writeFile(options.capture, incomplete);
      await expect(prepareBurnRecovery({ ...options, captureSha256: digest(incomplete), output: join(dir, 'bad.json') })).rejects.toThrow('Incomplete');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
