import { describe, expect, it } from 'vitest';

import {
  decodeRocksDocument,
  encodeRocksDocument,
  isCurrentRocksDocument,
} from '../src/repository/rocksdb-document.js';

import type { IndexerDocument } from '../src/repository/types.js';

describe('compact RocksDB document values', () => {
  it('round-trips fields duplicated by the key and header', () => {
    const document: IndexerDocument = {
      collection: 'assetSnapshots',
      id: 'asset-xor-DAY-100',
      blockHeight: 123,
      timestamp: 100,
      data: {
        id: 'asset-xor-DAY-100',
        blockHeight: 123,
        timestamp: 100,
        assetId: 'xor',
        type: 'DAY',
      },
    };
    const stored = encodeRocksDocument(document);

    expect(isCurrentRocksDocument(stored)).toBe(true);
    expect(stored[4]).toEqual({ assetId: 'xor', type: 'DAY' });
    expect(decodeRocksDocument(document.collection, document.id, stored)).toEqual(document);
  });

  it('does not invent optional data fields or coerce unequal values', () => {
    const document: IndexerDocument = {
      collection: 'updatesStreams',
      id: 'chainState',
      blockHeight: 50,
      timestamp: 100,
      data: { block: '50', data: '{}' },
    };

    expect(decodeRocksDocument(document.collection, document.id, encodeRocksDocument(document))).toEqual(document);
  });

  it('returns null only for an absent key', () => {
    expect(decodeRocksDocument('assets', 'xor', undefined)).toBeNull();
  });

  it.each([
    null,
    { collection: 'assets', id: 'xor', data: {} },
    [1, null, null, 0, {}],
    [2, null, null, 0],
    [2, -1, null, 0, {}],
    [2, 1.5, null, 0, {}],
    [2, Number.MAX_SAFE_INTEGER + 1, null, 0, {}],
    [2, null, Number.NaN, 0, {}],
    [2, null, null, -1, {}],
    [2, null, null, 1.5, {}],
    [2, null, null, 8, {}],
    [2, null, null, 0, null],
    [2, null, null, 0, []],
  ])('rejects malformed or non-current envelope %#', (stored) => {
    expect(isCurrentRocksDocument(stored)).toBe(false);
    expect(() => decodeRocksDocument('assets', 'xor', stored)).toThrow(/Unsupported or corrupt/);
  });

  it.each([
    { stored: [2, null, null, 1, { id: 'duplicate' }] },
    { stored: [2, 1, null, 4, { blockHeight: 1 }] },
    { stored: [2, null, 1, 2, { timestamp: 1 }] },
  ])('rejects contradictory restore flags %#', ({ stored }) => {
    expect(() => decodeRocksDocument('assets', 'xor', stored)).toThrow(/restore flags/);
  });
});
