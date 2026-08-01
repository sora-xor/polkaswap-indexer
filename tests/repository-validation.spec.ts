import { describe, expect, it } from 'vitest';

import {
  assertValidIndexerDocument,
  chunkIndexerDocumentJsonPayloads,
  indexerDocumentJsonBytes,
  MAX_DOCUMENT_DATA_DEPTH,
  MAX_DOCUMENT_DATA_JSON_BYTES,
  MAX_DOCUMENT_DATA_NODES,
  MAX_DOCUMENT_DATA_STRING_LENGTH,
  normalizeIndexerDocument,
} from '../src/repository/validation.js';

describe('persisted repository document validation', () => {
  it('accepts bounded JSON data including nested arrays and null-prototype records', () => {
    const nested = Object.assign(Object.create(null) as Record<string, unknown>, {
      scalar: 'value',
      values: [null, true, 1.5, { id: 'nested' }],
    });

    expect(() =>
      assertValidIndexerDocument({
        collection: 'historyElements',
        id: 'valid-id',
        blockHeight: 0,
        timestamp: Number.MAX_SAFE_INTEGER,
        data: { id: 'valid-id', nested },
      })
    ).not.toThrow();
  });

  it('rejects cycles, sparse arrays, accessors, symbols, and forbidden keys', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const sparse = new Array(2);
    sparse[1] = 'value';
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, 'computed', { enumerable: true, get: () => 'value' });
    const symbolKey = { value: 1 } as Record<PropertyKey, unknown>;
    symbolKey[Symbol('hidden')] = true;

    for (const [data, message] of [
      [cyclic, /cycle/],
      [{ sparse }, /sparse array/],
      [accessor, /enumerable data property/],
      [symbolKey, /symbol keys/],
      [JSON.parse('{"__proto__":true}') as Record<string, unknown>, /forbidden key/],
    ] as const) {
      expect(() => assertValidIndexerDocument({ collection: 'assets', id: 'id', data })).toThrow(message);
    }
  });

  it('rejects unsafe integer-valued numbers at any JSON depth', () => {
    for (const value of [Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1]) {
      expect(() =>
        assertValidIndexerDocument({
          collection: 'assets',
          id: 'unsafe-number',
          data: { nested: [{ value }] },
        })
      ).toThrow(/integer outside the JavaScript safe range/);
    }
    expect(() =>
      assertValidIndexerDocument({ collection: 'assets', id: 'fraction', data: { value: 1.25 } })
    ).not.toThrow();
  });

  it('scopes scalar decimal checks without rejecting snapshot OHLC JSON', () => {
    for (const [collection, data] of [
      ['assetSnapshots', { id: 'asset-day', assetId: 'xor', type: 'DAY', priceUSD: { open: '1', close: '2' } }],
      ['poolSnapshots', { id: 'pool-day', poolId: 'xor-val', type: 'DAY', priceUSD: { open: '1', close: '2' } }],
    ] as const) {
      expect(() => assertValidIndexerDocument({ collection, id: data.id, data })).not.toThrow();
    }
    expect(() =>
      assertValidIndexerDocument({ collection: 'assets', id: 'asset', data: { id: 'asset', priceUSD: { close: '2' } } })
    ).toThrow(/indexed decimal/);
    expect(() =>
      assertValidIndexerDocument({
        collection: 'poolXYKs',
        id: 'pool',
        data: { id: 'pool', targetAssetReserves: '9'.repeat(257) },
      })
    ).toThrow(/indexed decimal/);
  });

  it('rejects non-scalar equality keys and deep-owns canonicalized data', () => {
    expect(() =>
      assertValidIndexerDocument({ collection: 'historyElements', id: 'history', data: { address: ['alice'] } })
    ).toThrow(/data.address must be a string/);
    expect(() =>
      assertValidIndexerDocument({ collection: 'historyElements', id: 'history', data: { data: { to: { id: 'alice' } } } })
    ).toThrow(/data.data.to must be a string/);

    const nested = { value: -0, child: { label: 'before' } };
    const normalized = normalizeIndexerDocument({
      collection: 'updatesStreams',
      id: 'owned',
      blockHeight: -0,
      data: { nested },
    });
    nested.child.label = 'after';
    nested.value = 10;
    expect(normalized.blockHeight).toBe(0);
    expect(Object.is(normalized.blockHeight, -0)).toBe(false);
    expect(normalized.data.nested).toEqual({ value: 0, child: { label: 'before' } });
  });

  it('enforces depth, node, string, and encoded-byte budgets', () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let depth = 0; depth <= MAX_DOCUMENT_DATA_DEPTH; depth += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    expect(() => assertValidIndexerDocument({ collection: 'assets', id: 'deep', data: deep })).toThrow(/depth/);

    expect(() =>
      assertValidIndexerDocument({
        collection: 'assets',
        id: 'nodes',
        data: { values: Array.from({ length: MAX_DOCUMENT_DATA_NODES }, () => null) },
      })
    ).toThrow(/JSON nodes/);

    expect(() =>
      assertValidIndexerDocument({
        collection: 'assets',
        id: 'string',
        data: { value: 'x'.repeat(MAX_DOCUMENT_DATA_STRING_LENGTH + 1) },
      })
    ).toThrow(/string length/);

    const chunk = 'x'.repeat(MAX_DOCUMENT_DATA_STRING_LENGTH);
    const chunkCount = Math.ceil(MAX_DOCUMENT_DATA_JSON_BYTES / MAX_DOCUMENT_DATA_STRING_LENGTH) + 1;
    expect(() =>
      assertValidIndexerDocument({
        collection: 'assets',
        id: 'encoded',
        data: { values: Array.from({ length: chunkCount }, () => chunk) },
      })
    ).toThrow(/encoded size/);
  });

  it('builds exact byte- and count-bounded write payloads', () => {
    const documents = ['a', 'b', 'c'].map((id) => ({
      collection: 'assets' as const,
      id,
      data: { id, value: 'x'.repeat(64) },
    }));
    const oneDocumentLimit = indexerDocumentJsonBytes(documents[0]!) + 2;
    const byteBatches = chunkIndexerDocumentJsonPayloads(documents, {
      maxBytes: oneDocumentLimit,
      maxDocuments: 100,
    });
    expect(byteBatches.map(({ documents: batch }) => batch.map(({ id }) => id))).toEqual([['a'], ['b'], ['c']]);
    for (const batch of byteBatches) {
      expect(Buffer.byteLength(batch.json, 'utf8')).toBe(batch.bytes);
      expect(batch.bytes).toBeLessThanOrEqual(oneDocumentLimit);
      expect(JSON.parse(batch.json)).toHaveLength(batch.documents.length);
    }

    const countBatches = chunkIndexerDocumentJsonPayloads(documents, {
      maxBytes: 1_000_000,
      maxDocuments: 2,
    });
    expect(countBatches.map(({ documents: batch }) => batch.map(({ id }) => id))).toEqual([
      ['a', 'b'],
      ['c'],
    ]);
    expect(() =>
      chunkIndexerDocumentJsonPayloads([documents[0]!], { maxBytes: oneDocumentLimit - 1 })
    ).toThrow(/write batch byte limit/);
  });
});
