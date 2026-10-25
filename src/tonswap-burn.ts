import { decodeAddress } from '@polkadot/util-crypto';

import { SORA_MAINNET_GENESIS_HASH, isNonzeroCanonicalSubstrateHash } from './soraIdentity.js';

import type { IndexerDocument } from './repository/types.js';

export const TONSWAP_START_BLOCK = 27_720_478;
export const TONSWAP_COVERAGE_ID = 'tonswapBurnCoverage-v1';

/** SORA Trust burns remain indexed for audit but never consume TONSWAP reward allocation. */
export const SORA_TRUST_BURN_ADDRESS = 'cnRus2m2Rn776v88H5RUtyiaXtr3daN6ePn6yenLKepx1SqYo';
const SORA_TRUST_ACCOUNT_ID = '12bed8da37e42af92986e9c0988b588da0e23422c287aa81a4bec9bb1e82db02';

/** Matches the Trust AccountId32 independently of its SS58 prefix or hexadecimal display encoding. */
export const isExcludedTonswapBurnAccount = (value: unknown): boolean => {
  if (typeof value !== 'string' || value.length > 128) return false;
  try {
    const accountId = decodeAddress(value.trim());
    return accountId.length === 32 && Buffer.from(accountId).toString('hex') === SORA_TRUST_ACCOUNT_ID;
  } catch {
    return false;
  }
};


export type TonswapBurnCoverage = {
  version: 1;
  startBlock: typeof TONSWAP_START_BLOCK;
  indexedThroughBlock: number;
  blockHash: string;
  blockTimestamp: number;
  genesisHash: typeof SORA_MAINNET_GENESIS_HASH;
};

/** Accepts only the published TS campaign marker, without a destination or extra fields. */
export const isTonswapBurnRemark = (remark: unknown): boolean => {
  if (typeof remark !== 'string' || remark.length > 512) return false;
  try {
    const text = remark.startsWith('0x') ? Buffer.from(remark.slice(2), 'hex').toString('utf8') : remark;
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return Object.keys(record).sort().join(',') === 'app,kind,version' &&
      record.app === 'polkaswap' && record.kind === 'tonswap-xor-burn' && record.version === 1;
  } catch {
    return false;
  }
};

/** Persists coverage only alongside the burns from the complete finalized block range. */
export const createTonswapBurnCoverage = (
  indexedThroughBlock: number,
  blockHash: string,
  blockTimestamp: number
): IndexerDocument => ({
  collection: 'updatesStreams',
  id: TONSWAP_COVERAGE_ID,
  blockHeight: indexedThroughBlock,
  timestamp: blockTimestamp,
  data: {
    id: TONSWAP_COVERAGE_ID,
    block: indexedThroughBlock,
    data: JSON.stringify({
      version: 1,
      startBlock: TONSWAP_START_BLOCK,
      indexedThroughBlock,
      blockHash,
      blockTimestamp,
      genesisHash: SORA_MAINNET_GENESIS_HASH,
    } satisfies TonswapBurnCoverage),
  },
});

/** Rejects missing, malformed, mismatched or foreign-chain coverage checkpoints. */
export const parseTonswapBurnCoverage = (document: IndexerDocument | null): TonswapBurnCoverage | null => {
  if (!document || document.collection !== 'updatesStreams' || document.id !== TONSWAP_COVERAGE_ID ||
    document.data.id !== TONSWAP_COVERAGE_ID || typeof document.data.data !== 'string') return null;
  try {
    const value = JSON.parse(document.data.data) as TonswapBurnCoverage;
    if (value.version !== 1 || value.startBlock !== TONSWAP_START_BLOCK ||
      value.genesisHash !== SORA_MAINNET_GENESIS_HASH ||
      !Number.isSafeInteger(value.indexedThroughBlock) || value.indexedThroughBlock < TONSWAP_START_BLOCK ||
      !Number.isSafeInteger(value.blockTimestamp) || value.blockTimestamp <= 0 ||
      !isNonzeroCanonicalSubstrateHash(value.blockHash) ||
      document.blockHeight !== value.indexedThroughBlock || document.data.block !== value.indexedThroughBlock ||
      document.timestamp !== value.blockTimestamp) return null;
    return value;
  } catch {
    return null;
  }
};
