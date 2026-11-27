import { describe, expect, it } from 'vitest';
import { encodeRepositoryCursor, createRepositoryCursorScope, MAX_REPOSITORY_CURSOR_LENGTH } from '../src/repository/cursor.js';
import { unwrapStatsCoreCursor, wrapStatsCoreCursor } from '../src/graphql/stats-core-cursor.js';
const generation = { generation: '12345678-1234-4234-8234-123456789abc', block: 28191816, hash: `0x${'a'.repeat(64)}` };
const cursor = encodeRepositoryCursor({ scope: createRepositoryCursorScope('assets', ['ID_ASC'], null), field: 'id', direction: 'asc', numeric: false, value: 'asset', id: 'asset' });
describe('stats core cursor receipt fence', () => {
  it('round-trips the existing scoped cursor without increasing public cursor bounds', () => {
    const wrapped = wrapStatsCoreCursor(cursor, generation);
    expect(wrapped.length).toBeLessThanOrEqual(MAX_REPOSITORY_CURSOR_LENGTH);
    expect(unwrapStatsCoreCursor(wrapped, generation)).toBe(cursor);
    expect(unwrapStatsCoreCursor(null, generation)).toBeNull();
  });
  it.each([{ ...generation, block: generation.block + 1 }, { ...generation, hash: `0x${'b'.repeat(64)}` },
    { ...generation, generation: '12345678-1234-4234-8234-123456789abd' }])('rejects changed receipt identity %j', (next) => {
    expect(() => unwrapStatsCoreCursor(wrapStatsCoreCursor(cursor, generation), next)).toThrow('generation changed');
  });
  it.each([cursor, '0', '1', 'pscg1.invalid!', 'pscg1.' + 'a'.repeat(MAX_REPOSITORY_CURSOR_LENGTH), 1])('rejects unbound/malformed cursor %s', (value) => {
    expect(() => unwrapStatsCoreCursor(value, generation)).toThrow();
  });
  it('rejects duplicate JSON fields, unknown fields, invalid UTF8 and noncanonical base64', () => {
    const payload = JSON.stringify({ v: 1, generation, cursor });
    for (const bytes of [Buffer.from(payload.replace('"v":1', '"v":1,"v":1')), Buffer.from(payload.replace('"v":1', '"v":1,"extra":true')), Buffer.from([255])]) {
      expect(() => unwrapStatsCoreCursor('pscg1.' + bytes.toString('base64url'), generation)).toThrow('Invalid');
    }
    expect(() => unwrapStatsCoreCursor(wrapStatsCoreCursor(cursor, generation) + '=', generation)).toThrow('Invalid');
  });
});
