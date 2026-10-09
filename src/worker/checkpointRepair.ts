import { createHash } from 'node:crypto';

import { parseStoredSoraChainState, SORA_MAINNET_GENESIS_HASH, SORA_LEGACY_IDENTITY_ANCHOR, isNonzeroCanonicalSubstrateHash } from '../soraIdentity.js';
import { normalizeIndexerDocument } from '../repository/validation.js';

import type { IndexerDocument, IndexerRepository } from '../repository/types.js';

/** A derived projection, never a claim to recover the legacy asynchronous cache. */
export type LegacyCheckpointBlockRepair = {
  document: IndexerDocument;
  legacyCheckpoint: IndexerDocument;
  priorSnapshot: IndexerDocument;
  anchorSnapshot: IndexerDocument;
  proof: {
    genesisHash: string;
    blockHash: string;
    parentHash: string;
    timestampMilliseconds: string;
    finalizedBlock: number;
    blockSha256: string;
    eventsSha256: string;
    baselineBlock: number;
    baselineHash: string;
    baselineAssets: number;
    baselinePools: number;
    projection: 'current-kernel-parent-assets-pools-v1';
    unavailableStockFields: ['liquidityUSD', 'orderBookLiquidityUSD', 'activeOrderBooks'];
  };
};

/** Digest the exact logical envelope retained in the private repair receipt. */
export const checkpointRepairDocumentHash = (document: IndexerDocument): string =>
  createHash('sha256').update(JSON.stringify(document)).digest('hex');

/** Strictly binds a durable projection receipt to its chain/source preconditions. */
export const assertLegacyCheckpointBlockRepair = (repair: LegacyCheckpointBlockRepair): void => {
  const document = repair.document;
  normalizeIndexerDocument(document);
  const block = Number(document.blockHeight);
  const timestamp = Number(document.timestamp);
  const proof = repair.proof;
  const legacy = repair.legacyCheckpoint;
  const legacyPayload = JSON.parse(String(legacy.data.data));
  const zeroCounts = ['accounts', 'transactions', 'swaps', 'bridgeIncomingTransactions', 'bridgeOutgoingTransactions'];
  const blockKeys = ['accounts', 'activeOrderBooks', 'activePools', 'bridgeIncomingTransactions',
    'bridgeOutgoingTransactions', 'fees', 'id', 'liquidityUSD', 'listedAssets', 'orderBookLiquidityUSD',
    'poolLiquidityUSD', 'swaps', 'timestamp', 'transactions', 'type', 'volumeUSD'].sort();
  if (!Number.isSafeInteger(block) || block <= SORA_LEGACY_IDENTITY_ANCHOR.block ||
      !Number.isSafeInteger(timestamp) || timestamp <= 0 || document.collection !== 'networkSnapshots' ||
      document.id !== `block-${block}` || document.data.id !== document.id ||
      document.data.timestamp !== timestamp || document.data.type !== 'BLOCK' ||
      JSON.stringify(Object.keys(document.data).sort()) !== JSON.stringify(blockKeys) ||
      zeroCounts.some((field) => document.data[field] !== 0) || document.data.fees !== '0' || document.data.volumeUSD !== '0' ||
      document.data.liquidityUSD !== null || document.data.orderBookLiquidityUSD !== null || document.data.activeOrderBooks !== null ||
      typeof document.data.poolLiquidityUSD !== 'string' || !/^\d+(?:\.\d+)?$/.test(document.data.poolLiquidityUSD) ||
      !Number.isSafeInteger(document.data.activePools) || Number(document.data.activePools) < 0 ||
      !Number.isSafeInteger(document.data.listedAssets) || Number(document.data.listedAssets) < 0 ||
      legacy.collection !== 'updatesStreams' || legacy.id !== 'chainState' || legacy.blockHeight !== block ||
      !Number.isSafeInteger(legacy.timestamp) || Number(legacy.timestamp) < timestamp ||
      JSON.stringify(Object.keys(legacy.data).sort()) !== '["block","data","id"]' ||
      legacy.data.id !== 'chainState' || legacy.data.block !== block ||
      JSON.stringify(Object.keys(legacyPayload)) !== '["lastIndexedBlock"]' || legacyPayload.lastIndexedBlock !== block ||
      proof.genesisHash !== SORA_MAINNET_GENESIS_HASH || !isNonzeroCanonicalSubstrateHash(proof.blockHash) ||
      !isNonzeroCanonicalSubstrateHash(proof.parentHash) || proof.baselineHash !== proof.parentHash || proof.baselineBlock !== block - 1 ||
      !Number.isSafeInteger(proof.finalizedBlock) || proof.finalizedBlock < block ||
      !/^[1-9]\d*$/.test(proof.timestampMilliseconds) || !Number.isSafeInteger(Number(proof.timestampMilliseconds)) ||
      Math.floor(Number(proof.timestampMilliseconds) / 1_000) !== timestamp ||
      !/^[0-9a-f]{64}$/.test(proof.blockSha256) || !/^[0-9a-f]{64}$/.test(proof.eventsSha256) ||
      !Number.isSafeInteger(proof.baselineAssets) || proof.baselineAssets <= 0 || proof.baselineAssets !== document.data.listedAssets ||
      !Number.isSafeInteger(proof.baselinePools) || proof.baselinePools <= 0 ||
      proof.projection !== 'current-kernel-parent-assets-pools-v1' ||
      JSON.stringify(proof.unavailableStockFields) !== '["liquidityUSD","orderBookLiquidityUSD","activeOrderBooks"]') {
    throw new Error('Malformed derived checkpoint BLOCK or provenance proof');
  }
  for (const [snapshot, expectedBlock, expectedTime] of [
    [repair.priorSnapshot, block - 1, repair.priorSnapshot.timestamp],
    [repair.anchorSnapshot, SORA_LEGACY_IDENTITY_ANCHOR.block, SORA_LEGACY_IDENTITY_ANCHOR.timestamp],
  ] as const) {
    if (!Number.isSafeInteger(expectedTime) || Number(expectedTime) <= 0 ||
        snapshot.collection !== 'networkSnapshots' || snapshot.id !== `block-${expectedBlock}` ||
        snapshot.blockHeight !== expectedBlock || snapshot.timestamp !== expectedTime ||
        snapshot.data.id !== snapshot.id || snapshot.data.type !== 'BLOCK' || snapshot.data.timestamp !== expectedTime) {
      throw new Error('Malformed checkpoint repair prior BLOCK or immutable anchor');
    }
  }
  if (Number(repair.priorSnapshot.timestamp) >= timestamp) throw new Error('Malformed checkpoint repair parent timestamp');
};

/** Runs the normal block kernel against a source that cannot accept any writes. */
export const createCheckpointProjectionCapture = (
  block: number,
  blockHash: string,
  timestamp: number,
  historyId: string,
  timestampMilliseconds: string,
): { repository: IndexerRepository; result: () => { document: IndexerDocument; history: IndexerDocument } } => {
  let captured: IndexerDocument[] | null = null;
  const startedAt = Math.floor(Date.now() / 1_000);
  const forbidden = async (): Promise<never> => { throw new Error('Checkpoint projection attempted an unexpected repository operation'); };
  const repository: IndexerRepository = {
    list: forbidden,
    get: forbidden,
    getMany: async (collection, ids) => {
      if (collection !== 'accountMeta' || ids.length !== 0) {
        throw new Error('Checkpoint projection attempted to read business accounts');
      }
      return new Map();
    },
    upsert: forbidden,
    upsertMany: async (documents) => {
      if (captured !== null || documents.length !== 3) {
        throw new Error('Checkpoint projection must capture exactly one three-document kernel transaction');
      }
      const keys = documents.map((document) => `${document.collection}/${document.id}`).sort();
      const expected = [`historyElements/${historyId}`, `networkSnapshots/block-${block}`, 'updatesStreams/chainState'].sort();
      if (JSON.stringify(keys) !== JSON.stringify(expected)) {
        throw new Error('Checkpoint projection attempted unexpected business or counter writes');
      }
      captured = structuredClone(documents);
    },
    deleteMany: forbidden,
    close: forbidden,
  };
  return {
    repository,
    result: () => {
      if (!captured) throw new Error('Checkpoint projection did not capture a kernel transaction');
      for (const document of captured) {
        const validTimestamp = document.collection === 'updatesStreams'
          ? Number.isSafeInteger(document.timestamp) && Number(document.timestamp) >= startedAt &&
            Number(document.timestamp) <= Math.floor(Date.now() / 1_000)
          : document.timestamp === timestamp;
        if (document.blockHeight !== block || !validTimestamp || document.data.id !== document.id) {
          throw new Error('Checkpoint projection returned an inconsistent document envelope');
        }
      }
      const document = captured.find((item) => item.collection === 'networkSnapshots')!;
      const history = captured.find((item) => item.collection === 'historyElements')!;
      const state = captured.find((item) => item.collection === 'updatesStreams')!;
      const parsedState = parseStoredSoraChainState(JSON.parse(String(state.data.data)));
      if (!parsedState || parsedState.lastIndexedBlock !== block || parsedState.blockHash !== blockHash ||
          parsedState.genesisHash !== SORA_MAINNET_GENESIS_HASH || parsedState.blockTimestamp !== timestamp ||
          state.data.block !== block) {
        throw new Error('Checkpoint projection returned an invalid captured checkpoint');
      }
      const zeroCounts = ['accounts', 'transactions', 'swaps', 'bridgeIncomingTransactions', 'bridgeOutgoingTransactions'];
      if (document.data.type !== 'BLOCK' || document.data.timestamp !== timestamp ||
          zeroCounts.some((field) => document.data[field] !== 0) ||
          document.data.fees !== '0' || document.data.volumeUSD !== '0' ||
          document.data.liquidityUSD !== null || document.data.orderBookLiquidityUSD !== null ||
          document.data.activeOrderBooks !== null || typeof document.data.poolLiquidityUSD !== 'string' ||
          !/^\d+(?:\.\d+)?$/.test(document.data.poolLiquidityUSD) ||
          !Number.isSafeInteger(document.data.activePools) || Number(document.data.activePools) < 0 ||
          !Number.isSafeInteger(document.data.listedAssets) || Number(document.data.listedAssets) < 0) {
        throw new Error('Checkpoint projection returned nonzero flows or unverified stock fields');
      }
      const expectedBlockKeys = ['accounts', 'activeOrderBooks', 'activePools', 'bridgeIncomingTransactions',
        'bridgeOutgoingTransactions', 'fees', 'id', 'liquidityUSD', 'listedAssets', 'orderBookLiquidityUSD',
        'poolLiquidityUSD', 'swaps', 'timestamp', 'transactions', 'type', 'volumeUSD'].sort();
      const expectedHistoryKeys = ['id', 'type', 'timestamp', 'blockHash', 'blockHeight', 'module', 'method',
        'address', 'networkFee', 'execution', 'data', 'dataFrom', 'dataTo', 'dataAssets', 'callNames', 'calls'].sort();
      const historyData = history.data.data as Record<string, unknown> | null;
      if (JSON.stringify(Object.keys(document.data).sort()) !== JSON.stringify(expectedBlockKeys) ||
          JSON.stringify(Object.keys(history.data).sort()) !== JSON.stringify(expectedHistoryKeys) ||
          JSON.stringify(Object.keys(state.data).sort()) !== JSON.stringify(['block', 'data', 'id']) ||
          history.data.type !== 'CALL' || history.data.module !== 'timestamp' || history.data.method !== 'set' ||
          history.data.address !== '' || history.data.dataFrom !== '' || history.data.dataTo !== '' ||
          history.data.networkFee !== '0' || history.data.blockHash !== blockHash ||
          history.data.blockHeight !== block || history.data.timestamp !== timestamp ||
          JSON.stringify(history.data.execution) !== '{"success":true}' ||
          !historyData || JSON.stringify(Object.keys(historyData)) !== '["now"]' ||
          String(historyData.now) !== timestampMilliseconds ||
          JSON.stringify(history.data.calls) !== '[]' || JSON.stringify(history.data.callNames) !== '[]' ||
          JSON.stringify(history.data.dataAssets) !== '[]') {
        throw new Error('Checkpoint projection returned unexpected block or history fields');
      }
      return { document: structuredClone(document), history: structuredClone(history) };
    },
  };
};
