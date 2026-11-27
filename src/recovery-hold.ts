import { isDeepStrictEqual } from 'node:util';

import { parseStoredSoraChainState } from './soraIdentity.js';
import type { IndexerRepository } from './repository/types.js';
import type { ChainIndexerStatusProvider } from './worker/status.js';

/** Exact finalized shared-prefix endpoint for the separately verified legacy replay. */
export const PRE_FORK_HISTORY_HOLD_CHECKPOINT = Object.freeze({
  block: 28_191_816,
  hash: '0x60b63e40ce4de9b9c1408bf7455a6f5ced796825f2437a0ee8496476d80c56d6',
  timestamp: 1_792_939_554,
});

/** Pins a retained checkpoint and exposes an explicitly stopped worker.
 * A pre-fork-prefix hold requires the exact shared-prefix endpoint; the caller
 * must independently verify its replay provenance before selecting that mode.
 * This never certifies entitlements, writes a heartbeat,
 * or enables indexing. The caller must open RocksDB in native read-only mode.
 */
export async function createRecoveryHoldStatus(
  repository: Pick<IndexerRepository, 'get'>,
  expectedState: unknown,
  observedFinalizedBlock: number,
  now = Math.floor(Date.now() / 1_000),
  dataStatus: unknown = 'abandoned-fork',
): Promise<ChainIndexerStatusProvider> {
  const expected = parseStoredSoraChainState(expectedState);
  if (!expected || !Number.isSafeInteger(observedFinalizedBlock) || observedFinalizedBlock < 0 ||
      !Number.isSafeInteger(now) || now <= 0) throw new Error('Invalid recovery hold checkpoint');
  if (dataStatus !== 'abandoned-fork' && dataStatus !== 'pre-fork-prefix') {
    throw new Error('Invalid recovery hold data status');
  }
  if (dataStatus === 'pre-fork-prefix' &&
      (expected.lastIndexedBlock !== PRE_FORK_HISTORY_HOLD_CHECKPOINT.block ||
       expected.blockHash !== PRE_FORK_HISTORY_HOLD_CHECKPOINT.hash ||
       expected.blockTimestamp !== PRE_FORK_HISTORY_HOLD_CHECKPOINT.timestamp ||
       observedFinalizedBlock < PRE_FORK_HISTORY_HOLD_CHECKPOINT.block)) {
    throw new Error('Pre-fork history hold requires the verified finalized prefix endpoint');
  }
  const document = await repository.get('updatesStreams', 'chainState');
  const actual = typeof document?.data.data === 'string'
    ? parseStoredSoraChainState(JSON.parse(document.data.data)) : null;
  if (!actual || !isDeepStrictEqual(actual, expected) || document?.blockHeight !== expected.lastIndexedBlock ||
      document.data.block !== expected.lastIndexedBlock) throw new Error('Recovery hold database checkpoint changed');
  return {
    getStatus: () => ({
      lifecycle: 'stopped',
      startupComplete: false,
      latestFinalizedBlock: observedFinalizedBlock,
      latestIndexedBlock: expected.lastIndexedBlock,
      lag: null,
      lastSuccessfulIndexTimestamp: null,
      lastError: dataStatus === 'pre-fork-prefix'
        ? 'Recovery hold: read-only legacy history through block 28191816 (2026-10-25 14:45:54 UTC); live recovery-chain indexing is unavailable. Entitlements are not certified.'
        : 'Recovery hold: retained abandoned-fork data is read-only; canonical rebuild and finalized recovery anchor required.',
      lastErrorTimestamp: now,
    }),
  };
}
