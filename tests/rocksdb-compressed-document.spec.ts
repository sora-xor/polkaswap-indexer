import { brotliCompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeRocksDocument, encodeRocksDocument, isCurrentRocksDocument } from '../src/repository/rocksdb-document.js';
import { MAX_DOCUMENT_DATA_JSON_BYTES } from '../src/repository/validation.js';
import { pointsDigest } from '../src/points-recovery.js';
import type { IndexerDocument } from '../src/repository/types.js';

const record = (data: Record<string, unknown> = {}): IndexerDocument => ({ collection: 'assets', id: 'xor',
  blockHeight: undefined, timestamp: null, data: { id: 'xor', timestamp: null, memo: '界😀'.repeat(1000), ...data } });
const compressedJson = (bytes: Buffer | string, length?: number): unknown[] => {
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return [3, undefined, null, 0, 'brotli-json-v1', length ?? input.length, brotliCompressSync(input)];
};
const decode = (stored: unknown) => decodeRocksDocument('assets', 'xor', stored, 3);

describe('bounded format-3 document codec', () => {
  it('round-trips normalized values and preserves native optional header slots and receipt digests', () => {
    const nested = Object.assign(Object.create(null), { number: -0, precise: '9007199254740993', unicode: '界😀', null: null });
    const document = record({ nested, decimals: 0.1, rows: [true, false, null, -0, 1e-7] });
    const plain = decodeRocksDocument('assets', 'xor', encodeRocksDocument(document));
    const stored = encodeRocksDocument(document, 'brotli');
    expect(stored[0]).toBe(3);
    expect(stored[1]).toBeUndefined(); expect(stored[2]).toBeNull();
    expect(stored[3]).toBe(3);
    expect(Buffer.isBuffer(stored[6])).toBe(true);
    expect(isCurrentRocksDocument(stored)).toBe(false);
    expect(isCurrentRocksDocument(stored, 3)).toBe(true);
    expect(decode(stored)).toStrictEqual(plain);
    expect(pointsDigest(decode(stored))).toBe(pointsDigest(plain));
    expect(Object.is((decode(stored)!.data.nested as Record<string, unknown>).number, -0)).toBe(false);
    expect(() => decodeRocksDocument('assets', 'xor', stored)).toThrow(/Unsupported/);
  });
  it('retains v2 envelopes for small records and the default encoder', () => {
    const small = { collection: 'assets' as const, id: 'xor', data: { id: 'xor', value: '1' } };
    expect(encodeRocksDocument(small, 'brotli')[0]).toBe(2);
    expect(decode(encodeRocksDocument(small, 'brotli'))).toEqual(decodeRocksDocument('assets', 'xor', encodeRocksDocument(small)));
    expect(encodeRocksDocument(record())[0]).toBe(2);
  });
  it('preserves every explicit/undefined/null header and restored-data combination', () => {
    for (const blockHeight of [undefined, null, 0, 17]) for (const timestamp of [undefined, null, 0, 19]) {
      const document = { ...record(), blockHeight, timestamp, data: { memo: 'x'.repeat(2048),
        ...(blockHeight === undefined ? {} : { blockHeight }), ...(timestamp === undefined ? {} : { timestamp }) } };
      expect(decode(encodeRocksDocument(document, 'brotli'))).toStrictEqual(decodeRocksDocument('assets', 'xor', encodeRocksDocument(document)));
    }
  });
  it.each([
    ['unsupported codec', () => [3, null, null, 0, 'gzip', 2, Buffer.from('x')]],
    ['wrong payload', () => [3, null, null, 0, 'brotli-json-v1', 2, 'eA==']],
    ['noninteger size', () => [3, null, null, 0, 'brotli-json-v1', 2.5, Buffer.from('x')]],
    ['negative size', () => [3, null, null, 0, 'brotli-json-v1', -1, Buffer.from('x')]],
    ['oversized declaration', () => [3, null, null, 0, 'brotli-json-v1', MAX_DOCUMENT_DATA_JSON_BYTES + 1, Buffer.from('x')]],
    ['oversized compressed input', () => [3, null, null, 0, 'brotli-json-v1', 2, Buffer.alloc(MAX_DOCUMENT_DATA_JSON_BYTES + 1)]],
    ['bad flags', () => [3, null, null, 8, 'brotli-json-v1', 2, Buffer.from('x')]],
    ['invalid header', () => [3, -1, null, 0, 'brotli-json-v1', 2, Buffer.from('x')]],
    ['extra envelope fields', () => [...compressedJson('{}'), 0]],
  ])('rejects %s before decompression', (_name, value) => {
    expect(() => decode((value as () => unknown)())).toThrow(/Unsupported or corrupt/);
  });
  it.each([
    ['truncated', () => { const value = compressedJson('{"value":"abc"}'); value[6] = (value[6] as Buffer).subarray(0, -1); return value; }],
    ['trailing bytes', () => { const value = compressedJson('{}'); value[6] = Buffer.concat([value[6] as Buffer, Buffer.from([0])]); return value; }],
    ['concatenated streams', () => { const value = compressedJson('{}'); value[6] = Buffer.concat([value[6] as Buffer, value[6] as Buffer]); return value; }],
    ['output shorter than declaration', () => compressedJson('{}', 3)],
    ['decompression bomb', () => compressedJson(JSON.stringify({ x: 'a'.repeat(1024 * 1024) }), 2)],
    ['duplicate JSON keys', () => compressedJson('{"x":1,"x":2}')],
    ['invalid UTF-8', () => compressedJson(Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]))],
    ['noncanonical number', () => compressedJson('{"x":-0}')],
    ['array instead of object', () => compressedJson('[]')],
    ['null instead of object', () => compressedJson('null')],
    ['trailing JSON', () => compressedJson('{}{}')],
    ['JSON whitespace', () => compressedJson('{ "x":1}')],
  ])('rejects corrupt %s', (_name, value) => {
    expect(() => decode((value as () => unknown)())).toThrow(/Unsupported or corrupt/);
  });
  it('keeps normalization and restore-flag corruption guards after decompression', () => {
    expect(() => decode(compressedJson('{"__proto__":{}}'))).toThrow();
    expect(() => decode(compressedJson('{"x":9007199254740992}'))).toThrow();
    const contradictory = compressedJson('{"id":"xor"}'); contradictory[3] = 1;
    expect(() => decode(contradictory)).toThrow(/restore flags/);
    expect(() => encodeRocksDocument(record({ invalid: undefined }), 'brotli')).toThrow();
  });
});
