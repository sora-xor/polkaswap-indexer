import {
  SORA_LEGACY_IDENTITY_ANCHOR,
  SORA_MAINNET_GENESIS_HASH,
} from '../src/soraIdentity.js';

import type { IndexerDocument } from '../src/repository/types.js';

export const HEALTH_TEST_STATE_BLOCK = SORA_LEGACY_IDENTITY_ANCHOR.block + 100;
export const HEALTH_TEST_STATE_HASH = `0x${'ab'.repeat(32)}`;

export const createHealthIdentityDocuments = (
  now: number,
  stateBlock = HEALTH_TEST_STATE_BLOCK,
  stateHash = HEALTH_TEST_STATE_HASH,
): IndexerDocument[] => [
  {
    collection: 'updatesStreams',
    id: 'chainIdentity',
    blockHeight: SORA_LEGACY_IDENTITY_ANCHOR.block,
    timestamp: SORA_LEGACY_IDENTITY_ANCHOR.timestamp,
    data: {
      id: 'chainIdentity',
      block: SORA_LEGACY_IDENTITY_ANCHOR.block,
      data: JSON.stringify({
        schemaVersion: 1,
        genesisHash: SORA_MAINNET_GENESIS_HASH,
        verificationBlock: SORA_LEGACY_IDENTITY_ANCHOR.block,
        verificationBlockHash: SORA_LEGACY_IDENTITY_ANCHOR.hash,
        verificationBlockTimestamp: SORA_LEGACY_IDENTITY_ANCHOR.timestamp,
        migration: 'fresh-database',
      }),
    },
  },
  {
    collection: 'updatesStreams',
    id: 'chainState',
    blockHeight: stateBlock,
    timestamp: now,
    data: {
      id: 'chainState',
      block: stateBlock,
      data: JSON.stringify({
        lastIndexedBlock: stateBlock,
        genesisHash: SORA_MAINNET_GENESIS_HASH,
        blockHash: stateHash,
        blockTimestamp: now,
      }),
    },
  },
];
