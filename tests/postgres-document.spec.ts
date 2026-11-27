import { describe, expect, it } from 'vitest';

import { decodePostgresDocument, decodePostgresDocumentText } from '../src/repository/postgres-document.js';

describe('Postgres document decoding', () => {
  it('preserves matching JSONB position strings while normalizing pg int8 columns', () => {
    const data = { id: 'reward', amount: '1000000000000000000', updated: 1,
      referral: 'alice', referrer: 'bob', timestamp: 1_779_860_520, blockHeight: '26309250' };
    const document = decodePostgresDocumentText({ collection: 'referrerRewards', id: data.id,
      blockHeight: '26309250', timestamp: '1779860520', dataText: JSON.stringify(data) });
    expect(document).toEqual({ collection: 'referrerRewards', id: 'reward',
      blockHeight: 26_309_250, timestamp: 1_779_860_520, data });
    expect(typeof document.data.blockHeight).toBe('string');
    expect(() => decodePostgresDocumentText({ collection: 'referrerRewards', id: data.id,
      blockHeight: null, timestamp: '1779860520', dataText: JSON.stringify(data) })).toThrow(/safe integer/);
    expect(() => decodePostgresDocumentText({ collection: 'referrerRewards', id: data.id,
      blockHeight: '26309251', timestamp: '1779860520', dataText: JSON.stringify(data) })).toThrow(/conflicts/);
  });

  it('normalizes pg bigint strings to repository-safe integers', () => {
    expect(
      decodePostgresDocument({
        collection: 'assets',
        id: 'xor',
        blockHeight: '123456',
        timestamp: 1_700_000_000n,
        data: { id: 'xor' },
      })
    ).toEqual({
      collection: 'assets',
      id: 'xor',
      blockHeight: 123_456,
      timestamp: 1_700_000_000,
      data: { id: 'xor' },
    });
  });

  it.each([
    [{ collection: 'unknown', id: 'id', blockHeight: 1, timestamp: 1, data: {} }, /unknown collection/],
    [{ collection: 'assets', id: '', blockHeight: 1, timestamp: 1, data: {} }, /non-empty/],
    [{ collection: 'assets', id: 'id', blockHeight: '1.5', timestamp: 1, data: {} }, /integer/],
    [{ collection: 'assets', id: 'id', blockHeight: '-1', timestamp: 1, data: {} }, /non-negative/],
    [
      { collection: 'assets', id: 'id', blockHeight: '9007199254740992', timestamp: 1, data: {} },
      /safe integer/,
    ],
    [{ collection: 'assets', id: 'id', blockHeight: 1, timestamp: 1, data: [] }, /JSON object/],
  ])('rejects malformed persisted row %#', (row, expected) => {
    expect(() => decodePostgresDocument(row)).toThrow(expected);
  });

  it('decodes raw JSONB text only after exact cross-engine numeric validation', () => {
    expect(
      decodePostgresDocumentText({
        collection: 'assets',
        id: 'exact',
        blockHeight: '1',
        timestamp: '2',
        dataText: '{"nested":[{"fraction":1.2300}],"digits":"9007199254740992"}',
      })
    ).toMatchObject({ data: { nested: [{ fraction: 1.23 }], digits: '9007199254740992' } });

    expect(() =>
      decodePostgresDocumentText({
        collection: 'assets',
        id: 'lossy',
        blockHeight: '1',
        timestamp: '2',
        dataText: '{"nested":[{"unsafe":9007199254740992}]}',
      })
    ).toThrow(/cannot be represented exactly/);
  });
});
