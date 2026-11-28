/** Recognizes explicit discarded state; transport failures and unknown hashes remain fatal. */
export function isDiscardedTimestampState(error: unknown): boolean {
  return error instanceof Error && error.message.includes('State already discarded');
}

// Substrate's TrieError::InvalidStateRoot: the node no longer holds the root trie node of
// the requested block's state, as a pruned or post-recovery node reports for old blocks.
const MISSING_STATE_ROOT = /Trie lookup error: Invalid state root: 0x[0-9a-f]{64}(?![0-9a-z])/i;

/**
 * Recognizes a node that no longer holds state for an older block: explicit pruning, or a
 * missing state root. Transport failures, unknown hashes, incomplete databases and every
 * other trie error remain fatal. Callers still prove the replacement endpoint themselves.
 */
export function isUnavailableHistoricalState(error: unknown): error is Error {
  return isDiscardedTimestampState(error) || (error instanceof Error && MISSING_STATE_ROOT.test(error.message));
}
