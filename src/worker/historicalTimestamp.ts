/** Recognizes explicit discarded state; transport failures and unknown hashes remain fatal. */
export function isDiscardedTimestampState(error: unknown): boolean {
  return error instanceof Error && error.message.includes('State already discarded');
}
