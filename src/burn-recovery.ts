import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { decodeAddress } from '@polkadot/util-crypto';
import { SORA_MAINNET_GENESIS_HASH, isNonzeroCanonicalSubstrateHash } from './soraIdentity.js';
import { isExcludedTonswapBurnAccount, TONSWAP_START_BLOCK } from './tonswap-burn.js';

export const RECOVERY_CHECKPOINT = Object.freeze({
  block: 28_191_817,
  hash: '0x7f7c253fa72f32e7b03f32bdc9ae456fd7174fb131b689be6d876006124129f0',
});
export const SOLSWAP_START_BLOCK = 25_043_003;
export const SOLSWAP_NEXUS_START_BLOCK = 25_867_650;
export const ATTACKER_ACCOUNT = '0x64650caa38ca952fc214cbb38cb625d779d1387b52910e664012cbd7d7593a7d';
const SCALE = 10n ** 18n;
const TS_CAP = 1_753_357n * SCALE;

export type RecoveryMetadataWitness = {
  firstBlock: number;
  lastBlock: number;
  executionCodeHash: string;
  metadataHash: string;
};
/** Preactivation allocation commitment; no post-fork or outer-artifact hashes. */
export type BurnAllocationPolicy = {
  version: 1;
  policyHash: string;
  genesisHash: string;
  checkpoint: typeof RECOVERY_CHECKPOINT;
  substitutions: Array<{ old: string; new: string }>;
  attackerAccounts: string[];
};
/** Live admission adds a finalized fork anchor after release/restart. */
export type BurnRecoveryPolicy = BurnAllocationPolicy & {
  releaseManifestHash: string;
  postForkAnchor: { block: number; hash: string };
  metadata: RecoveryMetadataWitness[];
};
export type CanonicalBurnReceipt = {
  id: string;
  blockHash: string;
  eventIndex: number;
  blockHeight: number;
  extrinsicIndex: number;
  txHash: string;
  address: string;
  amount: string;
  campaign?: 'tonswap';
  nexusRecipient?: string;
};
export type RecoveryBurnEntitlement = CanonicalBurnReceipt & {
  originalAddress: string;
  claimOwner: string;
  recoveryPolicyHash: string;
  claimStatus: 'reserved' | 'recipient-confirmation-required' | 'extinguished';
  tsAllocated: string;
  ssAllocated: string;
  nexusXorAllocated: string;
  tsClaimable: string;
  ssClaimable: string;
  nexusXorClaimable: string;
};

/** Canonicalizes identity without treating display-prefix changes as distinct owners. */
export function canonicalAccount(address: string): string {
  const decoded = decodeAddress(address);
  if (decoded.length !== 32) throw new Error('Expected AccountId32');
  return `0x${Buffer.from(decoded).toString('hex')}`;
}

/** Validate ownership/allocation inputs independently of the later release artifact. */
export function validateBurnAllocationPolicy(value: unknown): BurnAllocationPolicy {
  const p = value as BurnAllocationPolicy;
  if (!p || p.version !== 1 || p.genesisHash !== SORA_MAINNET_GENESIS_HASH ||
      p.checkpoint?.block !== RECOVERY_CHECKPOINT.block || p.checkpoint.hash !== RECOVERY_CHECKPOINT.hash ||
      !isNonzeroCanonicalSubstrateHash(p.policyHash) || !Array.isArray(p.substitutions) ||
      !Array.isArray(p.attackerAccounts)) throw new Error('Invalid burn allocation policy');
  const old = new Set<string>();
  const destinations = new Set<string>();
  for (const entry of p.substitutions) {
    const from = canonicalAccount(entry.old);
    const to = canonicalAccount(entry.new);
    if (from === to || old.has(from) || destinations.has(to)) throw new Error('Duplicate recovery substitution');
    old.add(from); destinations.add(to);
  }
  if ([...old].some((account) => destinations.has(account))) throw new Error('Overlapping recovery substitutions');
  const attackers = new Set(p.attackerAccounts.map(canonicalAccount));
  if (!attackers.has(ATTACKER_ACCOUNT) || attackers.size !== p.attackerAccounts.length ||
      [...attackers].some((account) => old.has(account) || destinations.has(account))) {
    throw new Error('Missing attacker identity or attacker/victim overlap');
  }
  return p;
}

/** Rejects unpinned, overlapping, malformed or pre-fork live admission. */
export function validateBurnRecoveryPolicy(value: unknown): BurnRecoveryPolicy {
  validateBurnAllocationPolicy(value);
  const p = value as BurnRecoveryPolicy;
  if (!isNonzeroCanonicalSubstrateHash(p.releaseManifestHash) ||
      !Number.isSafeInteger(p.postForkAnchor?.block) || p.postForkAnchor.block <= RECOVERY_CHECKPOINT.block ||
      !isNonzeroCanonicalSubstrateHash(p.postForkAnchor.hash) || !Array.isArray(p.metadata)) {
    throw new Error('Invalid burn recovery policy');
  }
  let next = p.metadata[0]?.firstBlock;
  if (!Number.isSafeInteger(next) || next < 1 || next > RECOVERY_CHECKPOINT.block + 1) {
    throw new Error('Incomplete recovery execution metadata witnesses');
  }
  for (const witness of p.metadata) {
    if (witness.firstBlock !== next || !Number.isSafeInteger(witness.lastBlock) || witness.lastBlock < next ||
        !isNonzeroCanonicalSubstrateHash(witness.executionCodeHash) || !isNonzeroCanonicalSubstrateHash(witness.metadataHash)) {
      throw new Error('Incomplete recovery execution metadata witnesses');
    }
    next = witness.lastBlock + 1;
  }
  if (next <= p.postForkAnchor.block) throw new Error('Recovery metadata does not cover the post-fork anchor');
  return p;
}

/** Reads a local public policy only when its exact bytes match the release's configured SHA-256. */
export function loadBurnRecoveryPolicy(path: string | undefined, sha256: string | undefined): BurnRecoveryPolicy | null {
  if (!path && !sha256) return null;
  if (!path || !sha256 || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Recovery policy path and SHA-256 are required together');
  const bytes = readFileSync(path);
  if (bytes.length > 16 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== sha256) {
    throw new Error('Recovery policy hash mismatch or excessive size');
  }
  return validateBurnRecoveryPolicy(JSON.parse(bytes.toString('utf8')));
}

export function loadBurnAllocationPolicy(path: string, sha256: string): BurnAllocationPolicy {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Allocation policy SHA-256 is required');
  const bytes = readFileSync(path);
  if (bytes.length > 16 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== sha256) {
    throw new Error('Allocation policy hash mismatch or excessive size');
  }
  return validateBurnAllocationPolicy(JSON.parse(bytes.toString('utf8')));
}

/** Parses natural units exactly; no floating point or silent truncation is permitted. */
export function burnAtoms(amount: string): bigint {
  if (!/^(0|[1-9]\d{0,77})(\.\d{1,18})?$/.test(amount)) throw new Error('Invalid burn amount');
  const [whole, fraction = ''] = amount.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, '0'));
}
function natural(atoms: bigint): string {
  const fraction = (atoms % SCALE).toString().padStart(18, '0').replace(/0+$/, '');
  return `${atoms / SCALE}${fraction ? `.${fraction}` : ''}`;
}
function cumulativeTs(eligible: bigint): bigint {
  return (100n * TS_CAP * eligible - 45n * eligible * eligible) / (2n * TS_CAP);
}

/** Resolves ownership only; historical signer/remark provenance never changes. */
export function resolveBurnOwner(address: string, policy: BurnAllocationPolicy): { claimOwner: string; replaced: boolean; extinguished: boolean } {
  const original = canonicalAccount(address);
  const replacement = policy.substitutions.find((entry) => canonicalAccount(entry.old) === original);
  return {
    claimOwner: replacement?.new ?? address,
    replaced: Boolean(replacement),
    extinguished: policy.attackerAccounts.some((account) => canonicalAccount(account) === original),
  };
}

/**
 * Allocates a complete, independently captured checkpoint event stream. Completeness is a
 * separate release evidence gate: this pure function validates identities, ordering and amounts.
 * Attacker allocations are extinguished only after computing the original global TS curve.
 */
export function allocateRecoveryBurns(receipts: readonly CanonicalBurnReceipt[], policyValue: unknown): RecoveryBurnEntitlement[] {
  const policy = validateBurnAllocationPolicy(policyValue);
  const unique = new Map<string, CanonicalBurnReceipt>();
  const blockHashes = new Map<number, string>();
  const positions = new Map<string, string>();
  for (const receipt of receipts) {
    if (!isNonzeroCanonicalSubstrateHash(receipt.blockHash) || !isNonzeroCanonicalSubstrateHash(receipt.txHash) ||
        !Number.isSafeInteger(receipt.eventIndex) || receipt.eventIndex < 0 ||
        receipt.id !== `${receipt.blockHash}:${receipt.eventIndex}` ||
        !Number.isSafeInteger(receipt.blockHeight) || receipt.blockHeight < SOLSWAP_START_BLOCK ||
        receipt.blockHeight > RECOVERY_CHECKPOINT.block ||
        !Number.isSafeInteger(receipt.extrinsicIndex) || receipt.extrinsicIndex < 0 || burnAtoms(receipt.amount) <= 0n ||
        (receipt.campaign !== undefined && receipt.campaign !== 'tonswap')) throw new Error('Invalid canonical checkpoint burn receipt');
    canonicalAccount(receipt.address);
    if (receipt.blockHeight === RECOVERY_CHECKPOINT.block && receipt.blockHash !== RECOVERY_CHECKPOINT.hash) throw new Error('Wrong checkpoint burn hash');
    const blockHash = blockHashes.get(receipt.blockHeight);
    if (blockHash && blockHash !== receipt.blockHash) throw new Error('Conflicting burn branch');
    blockHashes.set(receipt.blockHeight, receipt.blockHash);
    const position = `${receipt.blockHeight}:${receipt.eventIndex}`;
    if (positions.has(position) && positions.get(position) !== receipt.id) throw new Error('Conflicting burn event');
    positions.set(position, receipt.id);
    const previous = unique.get(receipt.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(receipt)) throw new Error('Conflicting duplicate burn receipt');
    unique.set(receipt.id, receipt);
  }
  let eligibleTs = 0n;
  const tsPositions = new Set<string>();
  return [...unique.values()].sort((a, b) => a.blockHeight - b.blockHeight || a.eventIndex - b.eventIndex).map((receipt) => {
    const amount = burnAtoms(receipt.amount);
    let ts = 0n, ss = 0n, nexus = 0n;
    if (!isExcludedTonswapBurnAccount(receipt.address)) {
      if (receipt.campaign === 'tonswap') {
        if (receipt.blockHeight < TONSWAP_START_BLOCK) throw new Error('TS marker before campaign start');
        const position = `${receipt.blockHeight}:${receipt.extrinsicIndex}`;
        if (tsPositions.has(position)) throw new Error('Ambiguous TS burn association');
        tsPositions.add(position);
        const after = eligibleTs + amount > TS_CAP ? TS_CAP : eligibleTs + amount;
        ts = cumulativeTs(after) - cumulativeTs(eligibleTs);
        eligibleTs = after;
      } else {
        const current = receipt.blockHeight >= SOLSWAP_NEXUS_START_BLOCK;
        if (amount >= (current ? SCALE / 50n : SCALE / 100n)) {
          ss = amount * (current ? 50n : 100n);
          if (current && receipt.nexusRecipient) nexus = amount;
        }
      }
    }
    const owner = resolveBurnOwner(receipt.address, policy);
    return {
      ...receipt,
      originalAddress: receipt.address,
      claimOwner: owner.claimOwner,
      recoveryPolicyHash: policy.policyHash,
      claimStatus: owner.extinguished ? 'extinguished' : owner.replaced && nexus > 0n ? 'recipient-confirmation-required' : 'reserved',
      tsAllocated: natural(ts), ssAllocated: natural(ss), nexusXorAllocated: natural(nexus),
      tsClaimable: natural(owner.extinguished ? 0n : ts), ssClaimable: natural(owner.extinguished ? 0n : ss),
      // The allocation survives replacement, but the old remark cannot authorize payout.
      nexusXorClaimable: natural(owner.extinguished || owner.replaced ? 0n : nexus),
    };
  });
}
