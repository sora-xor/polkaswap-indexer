import { describe, expect, it } from 'vitest';
import {
  assertValidIndexerDocument, assertValidRepositoryQueryPositions,
  chunkSerializedIndexerDocuments, chunkIndexerDocumentJsonPayloads,
  chunkIndexerDocumentsByJsonBytes, iterateIndexerDocumentJsonPayloads,
  serializeIndexerDocument, normalizeIndexerDocument, MAX_DOCUMENT_DATA_NODES,
} from '../src/repository/validation.js';
import type { IndexerDocument, RepositoryQueryArgs } from '../src/repository/types.js';
const document = (id = 'a', data: Record<string, unknown> = {}): IndexerDocument => ({ collection: 'assets', id, data });

describe('repository boundary contracts', () => {
  it.each(['timestamp', 'blockHeight', 'marketId'])('ignores absent %s predicates but validates every present operand', field => {
    for (const absent of [null, undefined, 'null']) {
      expect(() => assertValidRepositoryQueryPositions({ filter: { [field]: absent } })).not.toThrow();
      expect(() => assertValidRepositoryQueryPositions({ filter: { [field]: { eq: absent } } })).not.toThrow();
    }
    expect(() => assertValidRepositoryQueryPositions({ filter: { [field]: 12 } })).not.toThrow();
    for (const op of ['in', 'notIn', 'not_in']) {
      expect(() => assertValidRepositoryQueryPositions({ filter: { [field]: { [op]: [0, null, undefined, 'null', '42'] } } })).not.toThrow();
      expect(() => assertValidRepositoryQueryPositions({ filter: { [field]: { [op]: '42' } } })).toThrow(/array/);
    }
  });
  it.each([0, -1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('refuses invalid materialization byte budget %s', maxBytes => {
    expect(() => assertValidRepositoryQueryPositions({ maxBytes })).toThrow(/byte budget/);
  });
  it('refuses unsupported seek fields before backend work', () => {
    const args = { seek: { field: 'id', value: 1, id: 'a', direction: 'asc' } } as unknown as RepositoryQueryArgs;
    expect(() => assertValidRepositoryQueryPositions(args)).toThrow(/seek field/);
  });
  it.each([null, [], 'document', new Date()])('refuses a non-record document envelope %j', value => {
    expect(() => normalizeIndexerDocument(value)).toThrow(/plain object/);
  });
  it('rejects conflicting identity instead of persisting a different payload id', () => {
    expect(() => normalizeIndexerDocument(document('canonical', { id: 'other' }))).toThrow(/canonical id/);
  });
  it('canonicalizes negative zero coordinates to zero for stable storage identity', () => {
    const value = normalizeIndexerDocument({ ...document(), blockHeight: -0, timestamp: -0, data: { blockHeight: -0, timestamp: -0 } });
    expect(Object.is(value.blockHeight, -0)).toBe(false); expect(Object.is(value.timestamp, -0)).toBe(false);
    expect(value.blockHeight).toBe(0); expect(value.timestamp).toBe(0);
  });
  it('bounds arrays before walking an unbounded payload', () => {
    expect(() => assertValidIndexerDocument(document('a', { values: new Array(MAX_DOCUMENT_DATA_NODES + 1) }))).toThrow(/maximum array length/);
  });
  it.each(['label', '01', '-1', Symbol('hidden')])('rejects an array side property %s that JSON would discard', property => {
    const values = [1]; Object.defineProperty(values, property, { value: 'hidden', enumerable: true });
    expect(() => assertValidIndexerDocument(document('a', { values }))).toThrow(/non-index properties/);
  });
  it('bounds field names and equality-index UTF-8 bytes independently', () => {
    expect(() => assertValidIndexerDocument(document('a', { ['x'.repeat(1025)]: 1 }))).toThrow(/oversized key/);
    expect(() => assertValidIndexerDocument(document('a', { account: 'x'.repeat(257) }))).toThrow(/indexed equality/);
    expect(() => assertValidIndexerDocument(document('a', { account: '界'.repeat(86) }))).toThrow(/indexed equality/);
    expect(() => assertValidIndexerDocument({ collection: 'historyElements', id: 'a', data: { data: { to: '界'.repeat(86) } } })).toThrow(/indexed equality/);
  });
  it('checks account-trade batch membership and rejects non-array marketIds', () => {
    expect(() => assertValidIndexerDocument({ collection: 'accountTrades', id: 'a', data: { marketId: 2, marketIds: [2, 3] } })).not.toThrow();
    expect(() => assertValidIndexerDocument({ collection: 'accountTrades', id: 'a', data: { marketId: 3, marketIds: [2, 3] } })).toThrow(/first market/);
    expect(() => assertValidIndexerDocument({ collection: 'markets', id: 'a', data: { marketIds: '2' } })).toThrow(/between 1 and 24/);
  });
  it('permits unrelated batch calls without treating them as runtime market identifiers', () => {
    expect(() => assertValidIndexerDocument({ collection: 'historyElements', id: 'a', data: { calls: [null, 4, {}, { module: 'balances', data: { marketId: 'unrelated' } }] } })).not.toThrow();
  });
});

describe('serialized write batching', () => {
  const docs = [document('a', { label: '界' }), document('b', { label: 'é' }), document('c', { label: 'a' })];
  const serialized = docs.map(value => serializeIndexerDocument(value));
  const check = (batches: ReturnType<typeof chunkSerializedIndexerDocuments>) => {
    expect(batches.flatMap(batch => batch.documents)).toEqual(docs);
    for (const batch of batches) {
      expect(batch.bytes).toBe(Buffer.byteLength(batch.json, 'utf8'));
      expect(JSON.parse(batch.json)).toEqual(batch.documents.map(value => ({ ...value, blockHeight: value.blockHeight ?? null, timestamp: value.timestamp ?? null })));
    }
  };
  it('returns an empty sequence for an empty write in every batching API', () => {
    expect(chunkSerializedIndexerDocuments([])).toEqual([]);
    expect(chunkIndexerDocumentJsonPayloads([])).toEqual([]);
    expect(chunkIndexerDocumentsByJsonBytes([])).toEqual([]);
    expect([...iterateIndexerDocumentJsonPayloads([])]).toEqual([]);
  });
  it('keeps an ordinary write in one transaction with exact UTF-8 framing', () => {
    const batches = chunkSerializedIndexerDocuments(serialized); check(batches); expect(batches).toHaveLength(1);
  });
  it('splits on the document count without dropping or reordering the tail', () => {
    const batches = chunkSerializedIndexerDocuments(serialized, { maxDocuments: 2 }); check(batches);
    expect(batches.map(batch => batch.documents.length)).toEqual([2, 1]);
  });
  it('splits before exceeding exact byte capacity including separators', () => {
    const maxBytes = 3 + serialized[0]!.bytes + serialized[1]!.bytes;
    const batches = chunkSerializedIndexerDocuments(serialized, { maxBytes }); check(batches);
    expect(batches.map(batch => batch.documents.length)).toEqual([2, 1]);
    expect(batches[0]!.bytes).toBe(maxBytes);
  });
  it('rejects an individually oversized record instead of making an oversized batch', () => {
    expect(() => chunkSerializedIndexerDocuments(serialized, { maxBytes: serialized[0]!.bytes + 1 })).toThrow(/exceeds write batch byte limit/);
  });
  for (const key of ['maxBytes', 'maxDocuments'] as const) {
    it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(`rejects invalid ${key}=%s consistently`, value => {
      expect(() => chunkSerializedIndexerDocuments(serialized, { [key]: value })).toThrow(/must be positive/);
      expect(() => [...iterateIndexerDocumentJsonPayloads(docs, { [key]: value })]).toThrow(/must be positive/);
    });
  }
  it('serializes a storage codec result without mutating the logical document', () => {
    const source = document('a', { quantity: '42' });
    const encoded = serializeIndexerDocument(source, value => ({ ...value.data, storageVersion: 1 }));
    expect(JSON.parse(encoded.json).data).toEqual({ quantity: '42', storageVersion: 1 });
    expect(source.data).toEqual({ quantity: '42' });
    expect(encoded.bytes).toBe(Buffer.byteLength(encoded.json));
  });
});
