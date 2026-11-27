import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Metadata, TypeRegistry } from '@polkadot/types';
import { u8aToHex } from '@polkadot/util';
import { blake2AsHex, encodeAddress } from '@polkadot/util-crypto';
import { allocateRecoveryBurns, ATTACKER_ACCOUNT, burnAtoms, canonicalAccount, loadBurnAllocationPolicy, loadBurnRecoveryPolicy, RECOVERY_CHECKPOINT, validateBurnAllocationPolicy, validateBurnRecoveryPolicy, type BurnRecoveryPolicy, type CanonicalBurnReceipt } from '../src/burn-recovery.js';
import { decodeRecoveryBlock } from '../src/recovery-metadata.js';
import { SORA_TRUST_BURN_ADDRESS, TONSWAP_START_BLOCK } from '../src/tonswap-burn.js';
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

const { releaseManifestHash: _releaseHash, postForkAnchor: _postForkAnchor, metadata: _witnesses, ...allocationOnly } = policy;
const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('burn allocation policy boundaries', () => {
  it('canonicalizes display encodings but rejects identities that are not AccountId32', () => {
    expect(canonicalAccount(encodeAddress(old, 69))).toBe(old);
    expect(canonicalAccount(encodeAddress(old, 42))).toBe(old);
    expect(() => canonicalAccount(`0x${'11'.repeat(20)}`)).toThrow('Expected AccountId32');
    expect(() => canonicalAccount(`0x${'11'.repeat(33)}`)).toThrow('Expected AccountId32');
  });
  it.each([
    ['missing policy', null],
    ['version', { ...allocationOnly, version: 2 }],
    ['genesis', { ...allocationOnly, genesisHash: h(5) }],
    ['checkpoint block', { ...allocationOnly, checkpoint: { ...RECOVERY_CHECKPOINT, block: RECOVERY_CHECKPOINT.block + 1 } }],
    ['checkpoint hash', { ...allocationOnly, checkpoint: { ...RECOVERY_CHECKPOINT, hash: h(6) } }],
    ['zero policy hash', { ...allocationOnly, policyHash: `0x${'0'.repeat(64)}` }],
    ['substitution list', { ...allocationOnly, substitutions: {} }],
    ['attacker list', { ...allocationOnly, attackerAccounts: ATTACKER_ACCOUNT }],
  ])('rejects an allocation policy with an invalid %s', (_name, value) => {
    expect(() => validateBurnAllocationPolicy(value)).toThrow('Invalid burn allocation policy');
  });
  it('rejects self, repeated or chained substitutions, including across display encodings', () => {
    const withSubstitutions = (substitutions: Array<{ old: string; new: string }>) => validateBurnAllocationPolicy({ ...allocationOnly, substitutions });
    expect(() => withSubstitutions([{ old, new: encodeAddress(old, 69) }])).toThrow('Duplicate recovery substitution');
    expect(() => withSubstitutions([{ old, new: replacement }, { old: encodeAddress(old, 69), new: h(5) }])).toThrow('Duplicate recovery substitution');
    expect(() => withSubstitutions([{ old, new: replacement }, { old: h(5), new: replacement }])).toThrow('Duplicate recovery substitution');
    expect(() => withSubstitutions([{ old, new: replacement }, { old: replacement, new: h(5) }])).toThrow('Overlapping recovery substitutions');
    expect(withSubstitutions([{ old, new: replacement }, { old: h(5), new: h(6) }]).substitutions).toHaveLength(2);
  });
  it('requires the execution metadata witnesses to reach the post-fork anchor', () => {
    expect(() => validateBurnRecoveryPolicy({ ...policy, metadata: [{ ...policy.metadata[0], lastBlock: policy.postForkAnchor.block - 1 }] }))
      .toThrow('Recovery metadata does not cover the post-fork anchor');
  });
});

describe('pinned policy files', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'burn-policy-file-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('treats absent recovery configuration as disabled and loads a policy only with its exact digest', async () => {
    const path = join(dir, 'policy.json'), bytes = JSON.stringify(policy);
    await writeFile(path, bytes);
    expect(loadBurnRecoveryPolicy(undefined, undefined)).toBeNull();
    expect(loadBurnRecoveryPolicy('', '')).toBeNull();
    expect(loadBurnRecoveryPolicy(path, sha256(bytes))).toEqual(policy);
    for (const [file, digest] of [[path, undefined], [undefined, sha256(bytes)], [path, sha256(bytes).toUpperCase()], [path, sha256(bytes).slice(1)]]) {
      expect(() => loadBurnRecoveryPolicy(file, digest)).toThrow('Recovery policy path and SHA-256 are required together');
    }
    expect(() => loadBurnRecoveryPolicy(path, sha256(`${bytes}\n`))).toThrow('Recovery policy hash mismatch or excessive size');
  });
  it('requires a well-formed allocation digest that matches the exact bytes', async () => {
    const path = join(dir, 'allocation.json'), bytes = JSON.stringify(allocationOnly);
    await writeFile(path, bytes);
    expect(loadBurnAllocationPolicy(path, sha256(bytes))).toEqual(allocationOnly);
    expect(() => loadBurnAllocationPolicy(path, 'not-a-sha256')).toThrow('Allocation policy SHA-256 is required');
    expect(() => loadBurnAllocationPolicy(path, sha256(`${bytes}\n`))).toThrow('Allocation policy hash mismatch or excessive size');
  });
  it('bounds policy size even when the oversized bytes are valid JSON with a matching digest', async () => {
    const json = Buffer.from(JSON.stringify(policy));
    const bytes = Buffer.concat([json, Buffer.alloc(16 * 1024 * 1024 + 1 - json.length, 0x20)]);
    const path = join(dir, 'oversized.json');
    const digest = sha256(bytes);
    await writeFile(path, bytes);
    expect(() => loadBurnRecoveryPolicy(path, digest)).toThrow('Recovery policy hash mismatch or excessive size');
    expect(() => loadBurnAllocationPolicy(path, digest)).toThrow('Allocation policy hash mismatch or excessive size');
  });
});

describe('checkpoint allocation boundaries', () => {
  const fresh = h(50);
  const at = (blockHeight: number, amount: string, extra: Partial<CanonicalBurnReceipt> = {}): CanonicalBurnReceipt =>
    ({ ...receipt(blockHeight, fresh), amount, ...extra });
  it('parses natural XOR amounts exactly and rejects lossy or non-canonical spellings', () => {
    expect(burnAtoms('1.000000000000000001')).toBe(10n ** 18n + 1n);
    expect(burnAtoms('0')).toBe(0n);
    for (const amount of ['01', '1.', '.5', '-1', '1e3', ' 1', '0.0000000000000000001']) {
      expect(() => burnAtoms(amount)).toThrow('Invalid burn amount');
    }
    expect(() => allocateRecoveryBurns([at(27_800_000, '1,5')], policy)).toThrow('Invalid burn amount');
  });
  it('accepts checkpoint-block burns only on the pinned checkpoint hash', () => {
    const wrong = receipt(RECOVERY_CHECKPOINT.block, fresh);
    expect(() => allocateRecoveryBurns([wrong], policy)).toThrow('Wrong checkpoint burn hash');
    const pinned = { ...wrong, blockHash: RECOVERY_CHECKPOINT.hash, id: `${RECOVERY_CHECKPOINT.hash}:0` };
    expect(allocateRecoveryBurns([pinned], policy)[0]).toMatchObject({ blockHash: RECOVERY_CHECKPOINT.hash, ssAllocated: '50' });
  });
  it('rejects receipts from two branches at one height', () => {
    const sibling = { ...receipt(27_800_000, fresh, undefined, 1), blockHash: h(5), id: `${h(5)}:1` };
    expect(() => allocateRecoveryBurns([receipt(27_800_000, fresh), sibling], policy)).toThrow('Conflicting burn branch');
  });
  it('rejects TS markers before the campaign and two TS burns attributed to one extrinsic', () => {
    expect(() => allocateRecoveryBurns([receipt(TONSWAP_START_BLOCK - 1, fresh, 'tonswap')], policy)).toThrow('TS marker before campaign start');
    const first = receipt(27_800_000, fresh, 'tonswap', 0), second = receipt(27_800_000, fresh, 'tonswap', 1);
    expect(() => allocateRecoveryBurns([first, { ...second, extrinsicIndex: 0 }], policy)).toThrow('Ambiguous TS burn association');
    expect(allocateRecoveryBurns([first, second], policy)).toHaveLength(2);
  });
  it('clamps the global TS curve at its cap so later burns receive no TS', () => {
    const rows = allocateRecoveryBurns([at(27_800_000, '1753356', { campaign: 'tonswap' }),
      at(27_800_001, '5', { campaign: 'tonswap' }), at(27_800_002, '1', { campaign: 'tonswap' })], policy);
    // The curve integrates to 27.5 TS per XOR over the 1,753,357 XOR cap; the crossing burn only earns the remainder
    // for its first (uncapped) XOR: 5 + 22.5 / 1,753,357 TS, rounded up by the floor in the preceding cumulative value.
    expect(rows[0].tsAllocated).toBe('48217312.499987167473594938');
    expect(rows[1]).toMatchObject({ tsAllocated: '5.000012832526405062', tsClaimable: '5.000012832526405062', ssAllocated: '0' });
    expect(burnAtoms(rows[0].tsAllocated) + burnAtoms(rows[1].tsAllocated)).toBe(burnAtoms('48217317.5'));
    expect(rows[2]).toMatchObject({ tsAllocated: '0', tsClaimable: '0', ssAllocated: '0' });
  });
  it('applies the 1% and 2% SS thresholds and keeps Nexus XOR claimable for an unreplaced owner', () => {
    const rows = allocateRecoveryBurns([at(25_867_640, '0.009'), at(25_867_641, '0.01'),
      at(25_867_650, '0.019', { nexusRecipient: 'recorded' }), at(25_867_651, '0.02', { nexusRecipient: 'recorded' })], policy);
    expect(rows.map((row) => [row.ssAllocated, row.nexusXorAllocated, row.nexusXorClaimable]))
      .toEqual([['0', '0', '0'], ['1', '0', '0'], ['0', '0', '0'], ['1', '0.02', '0.02']]);
    expect(rows[3]).toMatchObject({ claimOwner: fresh, claimStatus: 'reserved' });
  });
  it('keeps SORA Trust burns without SS or TS allocation and without consuming the TS curve', () => {
    const user = at(27_800_001, '1', { campaign: 'tonswap' });
    const rows = allocateRecoveryBurns([receipt(25_900_000, SORA_TRUST_BURN_ADDRESS),
      receipt(27_800_000, SORA_TRUST_BURN_ADDRESS, 'tonswap'), user], policy);
    expect(rows.slice(0, 2).map((row) => [row.tsAllocated, row.ssAllocated, row.claimStatus])).toEqual([['0', '0', 'reserved'], ['0', '0', 'reserved']]);
    expect(rows[2].tsAllocated).not.toBe('0');
    expect(rows[2].tsAllocated).toBe(allocateRecoveryBurns([user], policy)[0].tsAllocated);
  });
});

describe('raw recovery block evidence', () => {
  // A palletless V14 metadata keeps registry construction cheap while exercising the real decode path.
  const metadataHex = u8aToHex(new Metadata(new TypeRegistry(), { magicNumber: 0x6174656d, metadata: { v14: {
    lookup: { types: [{ id: 0, type: { path: [], params: [], def: { Primitive: 'U8' }, docs: [] } }] },
    pallets: [], extrinsic: { type: 0, version: 4, signedExtensions: [] }, type: 0 } } }).toU8a());
  const height = RECOVERY_CHECKPOINT.block + 1;
  const header = new TypeRegistry().createType('Header', { parentHash: RECOVERY_CHECKPOINT.hash, number: height, stateRoot: h(6), extrinsicsRoot: h(7), digest: { logs: [] } });
  const configured = { ...policy, metadata: [{ ...policy.metadata[0], metadataHash: blake2AsHex(metadataHex, 256) }] };
  const signedBlock = { block: { header: header.toJSON(), extrinsics: [] }, justifications: null };
  const decode = (patch: { hash?: string; height?: number; events?: string; timestamp?: string } = {}) =>
    decodeRecoveryBlock(configured, patch.hash ?? header.hash.toHex(), patch.height ?? height, metadataHex, signedBlock,
      patch.events ?? '0x00', patch.timestamp ?? '0xe803000000000000');

  it('rejects malformed hash, event or timestamp evidence', () => {
    expect(decode()).toMatchObject({ timestampMilliseconds: '1000', executionCodeHash: h(7), metadataHash: configured.metadata[0].metadataHash });
    for (const patch of [{ hash: `0x${'0'.repeat(64)}` }, { hash: `0x${header.hash.toHex().slice(2).toUpperCase()}` }, { events: '0x0' },
      { events: '00' }, { timestamp: '0xe8030000' }, { timestamp: '0xe803000000000000ff' }]) {
      expect(() => decode(patch)).toThrow('Missing raw recovery block evidence');
    }
  });
  it('rejects a block whose header hash or height differs from the requested identity', () => {
    expect(() => decode({ hash: h(11) })).toThrow('Recovery block header does not match requested identity');
    expect(() => decode({ height: height + 1 })).toThrow('Recovery block header does not match requested identity');
  });
  it('accepts timestamps up to the safe-integer bound and rejects zero or larger values', () => {
    expect(decode({ timestamp: '0xffffffffffff1f00' }).timestampMilliseconds).toBe(String(Number.MAX_SAFE_INTEGER));
    expect(() => decode({ timestamp: '0x0000000000000000' })).toThrow('Invalid recovery timestamp');
    expect(() => decode({ timestamp: '0x0000000000002000' })).toThrow('Invalid recovery timestamp');
  });
});

describe('checkpoint ledger preparation command line', () => {
  const cli = fileURLToPath(new URL('../src/scripts/prepare-burn-recovery.ts', import.meta.url));
  let argv: string[], dir: string;
  beforeEach(async () => { argv = process.argv; dir = await mkdtemp(join(tmpdir(), 'burn-prepare-cli-')); vi.resetModules(); });
  afterEach(async () => { process.argv = argv; await rm(dir, { recursive: true, force: true }); });
  const run = async (...args: string[]) => {
    process.argv = [process.execPath, cli, ...args];
    await import('../src/scripts/prepare-burn-recovery.js');
  };

  it.each([
    ['an unknown flag', ['--capture', 'a', '--force', 'b']],
    ['a flag without its value', ['--capture']],
    ['a repeated flag', ['--capture', 'a', '--capture', 'b']],
  ])('rejects %s before reading any input', async (_name, args) => {
    await expect(run(...args)).rejects.toThrow('Use --capture FILE --capture-sha256 HASH --policy FILE --policy-sha256 HASH --output NEW_FILE');
  });
  it('requires all five explicit arguments', async () => {
    await expect(run('--capture', 'a', '--policy', 'b')).rejects.toThrow('All five explicit preparation arguments are required');
  });
  it('prepares the ledger when invoked directly with all five arguments', async () => {
    const capture = JSON.stringify({ version: 1, checkpoint: RECOVERY_CHECKPOINT,
      coverage: { firstBlock: 25_043_003, lastBlock: RECOVERY_CHECKPOINT.block, evidenceHash: h(25) },
      receipts: [receipt(27_800_000, old, 'tonswap')] });
    const allocation = JSON.stringify(allocationOnly);
    const paths = { capture: join(dir, 'capture.json'), policy: join(dir, 'policy.json'), output: join(dir, 'ledger.json') };
    await writeFile(paths.capture, capture);
    await writeFile(paths.policy, allocation);
    await run('--capture', paths.capture, '--capture-sha256', sha256(capture), '--policy', paths.policy,
      '--policy-sha256', sha256(allocation), '--output', paths.output);
    expect(JSON.parse(await readFile(paths.output, 'utf8'))).toMatchObject({ receiptCount: 1, policyHash: policy.policyHash,
      sourceCaptureSha256: sha256(capture), allocationPolicySha256: sha256(allocation), status: 'prepared-requires-release-verification' });
  });
});
