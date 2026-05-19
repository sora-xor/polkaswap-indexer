import { describe, expect, it } from 'vitest';

import {
  hasCompletedAccountTransactionsBackfill,
  normalizeIndexedAccountId,
  uniqueIndexedAccountIds,
} from '../src/account-activity.js';

describe('account activity helpers', () => {
  it('normalizes real-looking accounts and controlled test aliases', () => {
    expect(normalizeIndexedAccountId(' alice ')).toBe('alice');
    expect(normalizeIndexedAccountId('cnVhPytLG9bq4toLwg4QW5z8Yw5uH5ycZH6cZzMLxwTP5GQ')).toBe(
      'cnVhPytLG9bq4toLwg4QW5z8Yw5uH5ycZH6cZzMLxwTP5GQ'
    );
  });

  it('rejects external, malformed, and coercion-derived account identifiers', () => {
    expect(normalizeIndexedAccountId(null)).toBeNull();
    expect(normalizeIndexedAccountId(undefined)).toBeNull();
    expect(normalizeIndexedAccountId('0xrecipient')).toBeNull();
    expect(normalizeIndexedAccountId('0XABCDEF')).toBeNull();
    expect(normalizeIndexedAccountId('1'.repeat(31))).toBeNull();
    expect(normalizeIndexedAccountId('1'.repeat(65))).toBeNull();
    expect(normalizeIndexedAccountId(`${'1'.repeat(31)}0`)).toBeNull();
    expect(normalizeIndexedAccountId(`${'1'.repeat(31)}O`)).toBeNull();
    expect(normalizeIndexedAccountId(`${'1'.repeat(31)}I`)).toBeNull();
    expect(normalizeIndexedAccountId(`${'1'.repeat(31)}l`)).toBeNull();
    expect(normalizeIndexedAccountId('Alice')).toBeNull();
    expect(normalizeIndexedAccountId('attacker')).toBeNull();
    expect(normalizeIndexedAccountId('alice\nbob')).toBeNull();
    expect(normalizeIndexedAccountId('not an account')).toBeNull();
    expect(normalizeIndexedAccountId('bridge-peer')).toBeNull();
    expect(normalizeIndexedAccountId('<script>alert(1)</script>')).toBeNull();
    expect(normalizeIndexedAccountId({ toString: () => 'alice' })).toBeNull();
    expect(normalizeIndexedAccountId(['alice'])).toBeNull();
    expect(normalizeIndexedAccountId(12345)).toBeNull();
  });

  it('deduplicates only accepted account identifiers', () => {
    expect(uniqueIndexedAccountIds(['alice', ' alice ', '0xrecipient', 'not an account', 'bob'])).toEqual(['alice', 'bob']);
  });

  it('does not treat corrupt backfill state as complete', () => {
    expect(hasCompletedAccountTransactionsBackfill(null)).toBe(false);
    expect(hasCompletedAccountTransactionsBackfill(JSON.stringify([]))).toBe(false);
    expect(hasCompletedAccountTransactionsBackfill('not-json')).toBe(false);
    expect(hasCompletedAccountTransactionsBackfill(JSON.stringify({ processedDocuments: 1 }))).toBe(false);
    expect(
      hasCompletedAccountTransactionsBackfill(
        JSON.stringify({ processedDocuments: '1', writtenDocuments: 1, lastIndexedBlock: 2, lastTimestamp: 3 })
      )
    ).toBe(false);
    expect(
      hasCompletedAccountTransactionsBackfill(
        JSON.stringify({ processedDocuments: -1, writtenDocuments: 1, lastIndexedBlock: 2, lastTimestamp: 3 })
      )
    ).toBe(false);
    expect(
      hasCompletedAccountTransactionsBackfill(
        JSON.stringify({ processedDocuments: 1.5, writtenDocuments: 1, lastIndexedBlock: 2, lastTimestamp: 3 })
      )
    ).toBe(false);
    expect(
      hasCompletedAccountTransactionsBackfill(
        JSON.stringify({
          processedDocuments: Number.MAX_SAFE_INTEGER + 1,
          writtenDocuments: 1,
          lastIndexedBlock: 2,
          lastTimestamp: 3,
        })
      )
    ).toBe(false);
    expect(
      hasCompletedAccountTransactionsBackfill(
        JSON.stringify({ processedDocuments: 1, writtenDocuments: 1, lastIndexedBlock: 2, lastTimestamp: 3 })
      )
    ).toBe(true);
  });
});
