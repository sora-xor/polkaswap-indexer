import { TypeRegistry } from '@polkadot/types';
import type { Header } from '@polkadot/types/interfaces';
import { isNonzeroCanonicalSubstrateHash, SORA_MAX_BLOCK_NUMBER } from './soraIdentity.js';

const HASH = /^0x[0-9a-f]{64}$/;
const HEX = /^0x(?:[0-9a-f]{2})+$/;
const MAX_HEADER_BYTES = 4 * 1024 * 1024;
// Header and DigestItem are protocol types, independent of runtime storage/event metadata.
const registry = new TypeRegistry();

/** Decode an exact raw Substrate header without invoking the SDK's historic registry lookup. */
export function decodeRecoveryHeader(requestedHash: string, value: unknown): Header {
  if (!isNonzeroCanonicalSubstrateHash(requestedHash) || !value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid raw recovery header identity');
  }
  const raw = value as Record<string, unknown>;
  const digest = raw.digest as Record<string, unknown> | undefined;
  if (Object.keys(raw).sort().join(',') !== 'digest,extrinsicsRoot,number,parentHash,stateRoot' ||
      typeof raw.number !== 'string' || !/^0x[0-9a-f]{1,8}$/.test(raw.number) ||
      !isNonzeroCanonicalSubstrateHash(raw.parentHash) ||
      typeof raw.stateRoot !== 'string' || !HASH.test(raw.stateRoot) ||
      typeof raw.extrinsicsRoot !== 'string' || !HASH.test(raw.extrinsicsRoot) ||
      !digest || typeof digest !== 'object' || Array.isArray(digest) || Object.keys(digest).join(',') !== 'logs' ||
      !Array.isArray(digest.logs) || digest.logs.length > 4096) {
    throw new Error('Invalid raw recovery header fields');
  }
  let logBytes = 0;
  for (const log of digest.logs) {
    if (typeof log !== 'string') throw new Error('Invalid raw recovery header fields');
    logBytes += log.length;
    if (logBytes > MAX_HEADER_BYTES) throw new Error('Invalid raw recovery header aggregate bound');
    if (!HEX.test(log)) throw new Error('Invalid raw recovery header fields');
  }
  if (Buffer.byteLength(JSON.stringify(raw)) > MAX_HEADER_BYTES) throw new Error('Invalid raw recovery header fields');
  const height = Number(BigInt(raw.number));
  if (height < 1 || height > SORA_MAX_BLOCK_NUMBER) throw new Error('Invalid raw recovery header height');
  const logs = digest.logs;
  // SCALE decoding may accept trailing input; exact digest roundtrips reject it and noncanonical lengths.
  const header = registry.createType<Header>('Header', raw);
  if (header.number.toNumber() !== height || header.parentHash.toHex() !== raw.parentHash ||
      header.stateRoot.toHex() !== raw.stateRoot || header.extrinsicsRoot.toHex() !== raw.extrinsicsRoot ||
      header.digest.logs.length !== logs.length ||
      header.digest.logs.some((log, index) => log.toHex() !== logs[index]) ||
      header.hash.toHex() !== requestedHash) {
    throw new Error('Raw recovery header does not match requested identity or canonical digest');
  }
  return header;
}
