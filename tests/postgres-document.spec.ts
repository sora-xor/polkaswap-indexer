import { describe, expect, it } from 'vitest';

import { decodePostgresDocument, decodePostgresDocumentText } from '../src/repository/postgres-document.js';

describe('Postgres document decoding', () => {
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
