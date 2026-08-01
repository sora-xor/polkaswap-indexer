export const SORA_MAINNET_GENESIS_HASH =
  '0x7e4e32d0feafd4f9c9414b0be86373f9a1efa904809b683453a9af6856d38ad5';

export const SORA_ZERO_HASH = `0x${'0'.repeat(64)}`;
export const SORA_MAX_BLOCK_NUMBER = 0xffff_ffff;

// Audited migration anchor observed identically from both reviewed SORA
// mainnet endpoints and the legacy PI production database.
export const SORA_LEGACY_IDENTITY_ANCHOR = Object.freeze({
  block: 26_872_383,
  hash: '0x28dd415867e637e5c70056a564cfa4e81f0f3df3a18d1132ccc61fe5025c762c',
  timestamp: 1_783_716_432,
});

export const isCanonicalSubstrateHash = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value);

export const isNonzeroCanonicalSubstrateHash = (value: unknown): value is string =>
  isCanonicalSubstrateHash(value) && value !== SORA_ZERO_HASH;

export type StoredSoraChainIdentity = {
  schemaVersion: 1;
  genesisHash: typeof SORA_MAINNET_GENESIS_HASH;
  verificationBlock: number;
  verificationBlockHash: string;
  verificationBlockTimestamp: number;
  migration: 'fresh-database' | 'legacy-production-anchor-v1';
};

export type StoredSoraChainState = {
  lastIndexedBlock: number;
  genesisHash: typeof SORA_MAINNET_GENESIS_HASH;
  blockHash: string;
  blockTimestamp: number;
};

const hasExactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};

export const parseStoredSoraChainIdentity = (value: unknown): StoredSoraChainIdentity | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!hasExactKeys(record, [
    'genesisHash',
    'migration',
    'schemaVersion',
    'verificationBlock',
    'verificationBlockHash',
    'verificationBlockTimestamp',
  ])) return null;
  if (record.schemaVersion !== 1 || record.genesisHash !== SORA_MAINNET_GENESIS_HASH) return null;
  if (!Number.isSafeInteger(record.verificationBlock) || Number(record.verificationBlock) <= 0 ||
      Number(record.verificationBlock) > SORA_MAX_BLOCK_NUMBER) return null;
  if (!isNonzeroCanonicalSubstrateHash(record.verificationBlockHash)) return null;
  if (!Number.isSafeInteger(record.verificationBlockTimestamp) || Number(record.verificationBlockTimestamp) <= 0) {
    return null;
  }
  if (record.migration !== 'fresh-database' && record.migration !== 'legacy-production-anchor-v1') return null;
  if (record.verificationBlock !== SORA_LEGACY_IDENTITY_ANCHOR.block ||
      record.verificationBlockHash !== SORA_LEGACY_IDENTITY_ANCHOR.hash ||
      record.verificationBlockTimestamp !== SORA_LEGACY_IDENTITY_ANCHOR.timestamp) return null;
  return record as StoredSoraChainIdentity;
};

export const parseStoredSoraChainState = (value: unknown): StoredSoraChainState | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!hasExactKeys(record, ['blockHash', 'blockTimestamp', 'genesisHash', 'lastIndexedBlock'])) return null;
  if (!Number.isSafeInteger(record.lastIndexedBlock) || Number(record.lastIndexedBlock) <= 0 ||
      Number(record.lastIndexedBlock) > SORA_MAX_BLOCK_NUMBER) return null;
  if (record.genesisHash !== SORA_MAINNET_GENESIS_HASH) return null;
  if (!isNonzeroCanonicalSubstrateHash(record.blockHash)) return null;
  if (!Number.isSafeInteger(record.blockTimestamp) || Number(record.blockTimestamp) <= 0) return null;
  return record as StoredSoraChainState;
};
