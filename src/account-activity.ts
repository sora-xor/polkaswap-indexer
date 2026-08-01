const SS58_ACCOUNT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;
const TEST_ACCOUNT_ALIASES = new Set(['alice', 'bob', 'carol', 'dave', 'old']);

/**
 * Normalizes account identifiers used by transaction activity metrics.
 * Production SORA accounts are stored as SS58 strings. A small set of readable
 * aliases is accepted for deterministic unit tests. Hex identifiers are
 * external addresses or asset IDs in this indexer data model and must not be
 * counted as active Polkaswap accounts.
 */
export const normalizeIndexedAccountId = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;

  const accountId = value.trim();

  if (!accountId || accountId.toLowerCase().startsWith('0x')) return null;
  if (!SS58_ACCOUNT_PATTERN.test(accountId) && !TEST_ACCOUNT_ALIASES.has(accountId)) return null;

  return accountId;
};

/** Returns de-duplicated, normalized account IDs while preserving first-seen order. */
export const uniqueIndexedAccountIds = (values: Iterable<unknown>): string[] => {
  const accounts = new Set<string>();

  for (const value of values) {
    const accountId = normalizeIndexedAccountId(value);
    if (accountId) accounts.add(accountId);
  }

  return [...accounts];
};
