import { Metadata, TypeRegistry } from '@polkadot/types';
import { hexToU8a } from '@polkadot/util';
import type { SignedBlock } from '@polkadot/types/interfaces';
import { blake2AsHex, xxhashAsHex } from '@polkadot/util-crypto';
import { types as soraTypes } from '@sora-substrate/type-definitions';
import type { BurnRecoveryPolicy } from './burn-recovery.js';
import { isNonzeroCanonicalSubstrateHash } from './soraIdentity.js';

const storageKey = (pallet: string, item: string): string => xxhashAsHex(pallet, 128) + xxhashAsHex(item, 128).slice(2);
export const RECOVERY_EVENTS_KEY = storageKey('System', 'Events');
export const RECOVERY_TIMESTAMP_KEY = storageKey('Timestamp', 'Now');

/** Select execution metadata by its release witness, never by the reused spec-134 version. */
export function recoveryMetadataWitness(policy: BurnRecoveryPolicy, block: number) {
  const witness = policy.metadata.find((entry) => block >= entry.firstBlock && block <= entry.lastBlock);
  if (!witness) throw new Error('No pinned execution metadata for recovery block');
  return witness;
}

/**
 * Decode raw block/events with a fresh registry using the executing parent's metadata.
 * The execution-code hash comes from the pinned outer release witness: :code cannot
 * identify a code substitute. The caller separately verifies the recovery branch anchor.
 */
export function decodeRecoveryBlock(
  policy: BurnRecoveryPolicy,
  requestedHash: string,
  blockHeight: number,
  metadataHex: string,
  signedBlockJson: unknown,
  eventsHex: string,
  timestampHex: string,
) {
  const witness = recoveryMetadataWitness(policy, blockHeight);
  if (!/^0x(?:[0-9a-f]{2})+$/i.test(metadataHex) || blake2AsHex(metadataHex, 256) !== witness.metadataHash) {
    throw new Error('Recovery execution metadata hash mismatch');
  }
  if (!isNonzeroCanonicalSubstrateHash(requestedHash) || !/^0x(?:[0-9a-f]{2})+$/i.test(eventsHex) ||
      !/^0x[0-9a-f]{16}$/i.test(timestampHex)) throw new Error('Missing raw recovery block evidence');
  const registry = new TypeRegistry();
  registry.register(soraTypes);
  registry.setMetadata(new Metadata(registry, metadataHex as `0x${string}`));
  const signedBlock = registry.createType<SignedBlock>('SignedBlock', signedBlockJson);
  if (signedBlock.block.header.hash.toHex() !== requestedHash || signedBlock.block.header.number.toNumber() !== blockHeight) {
    throw new Error('Recovery block header does not match requested identity');
  }
  const events = registry.createType('Vec<EventRecord>', eventsHex);
  const timestamp = registry.createType('u64', hexToU8a(timestampHex)).toBigInt();
  if (timestamp <= 0n || timestamp > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid recovery timestamp');
  return { signedBlock, events, timestampMilliseconds: timestamp.toString(), executionCodeHash: witness.executionCodeHash, metadataHash: witness.metadataHash };
}
