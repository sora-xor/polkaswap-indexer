import { Kind } from 'graphql';
import { describe, expect, it } from 'vitest';

import { CursorScalar } from '../src/graphql/scalars.js';
import {
  MAX_REPOSITORY_CURSOR_LENGTH,
  createRepositoryCursorScope,
  decodeRepositoryCursor,
  encodeRepositoryCursor,
  normalizeRepositoryCursorValue,
} from '../src/repository/cursor.js';

const scope = createRepositoryCursorScope('assets', ['TIMESTAMP_ASC'], {
  and: [{ type: { equalTo: 'DAY' } }, { assetId: { equalTo: 'xor' } }],
});

const validKeyset = {
  scope,
  field: 'timestamp',
  direction: 'asc' as const,
  numeric: true,
  value: '123',
  id: 'asset/day/123',
};

const forge = (payload: unknown): string => `psc2.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;

describe('repository cursor contract', () => {
  it('round-trips a scoped keyset without a client-controlled offset', () => {
    const cursor = encodeRepositoryCursor(validKeyset);

    expect(cursor).toMatch(/^psc2\./);
    expect(decodeRepositoryCursor(cursor)).toEqual(validKeyset);
    expect(decodeRepositoryCursor(cursor)).not.toHaveProperty('offset');
  });

  it('canonicalizes filter object key order while binding collection, filter, and normalized order', () => {
    const ordered = createRepositoryCursorScope('assets', ['TIMESTAMP_ASC'], {
      assetId: { equalTo: 'xor' },
      type: { equalTo: 'DAY' },
    });
    const reordered = createRepositoryCursorScope('assets', ['TIMESTAMP_ASC'], {
      type: { equalTo: 'DAY' },
      assetId: { equalTo: 'xor' },
    });
    expect(reordered).toBe(ordered);
    expect(createRepositoryCursorScope('assets', ['TIMESTAMP_DESC'], { and: [] })).not.toBe(scope);
    expect(createRepositoryCursorScope('poolSnapshots', ['TIMESTAMP_ASC'], { and: [] })).not.toBe(scope);
    expect(createRepositoryCursorScope('assets', ['TIMESTAMP_ASC'], { type: { equalTo: 'HOUR' } })).not.toBe(
      scope
    );
  });

  it('rejects cyclic scope inputs instead of recursing indefinitely', () => {
    const filter: Record<string, unknown> = {};
    filter.self = filter;
    expect(() => createRepositoryCursorScope('assets', ['ID_ASC'], filter)).toThrow(/cyclic/);
  });

  it.each([
    undefined,
    null,
    1,
    '',
    '0',
    'psc1.legacy',
    'psc2.',
    'psc2.not+base64url',
    'psc2.eyJ2IjoyfQ=',
    `psc2.${'a'.repeat(MAX_REPOSITORY_CURSOR_LENGTH)}`,
  ])('rejects malformed or legacy cursor input %#', (cursor) => {
    expect(decodeRepositoryCursor(cursor)).toBeNull();
  });

  it.each([
    [{ ...validKeyset, v: 1 }, 'wrong version'],
    [{ v: 2, s: scope, f: 'timestamp', d: 'asc', n: true, k: '123', i: 'id', extra: true }, 'extra key'],
    [{ v: 2, s: 'short', f: 'timestamp', d: 'asc', n: true, k: '123', i: 'id' }, 'bad scope'],
    [{ v: 2, s: scope, f: "timestamp')", d: 'asc', n: true, k: '123', i: 'id' }, 'unsafe field'],
    [{ v: 2, s: scope, f: 'timestamp', d: 'sideways', n: true, k: '123', i: 'id' }, 'bad direction'],
    [{ v: 2, s: scope, f: 'timestamp', d: 'asc', n: true, k: '1.5', i: 'id' }, 'fractional height'],
    [
      { v: 2, s: scope, f: 'timestamp', d: 'asc', n: true, k: '9007199254740992', i: 'id' },
      'unsafe native integer',
    ],
    [{ v: 2, s: scope, f: 'liquidity', d: 'asc', n: true, k: '1e9', i: 'id' }, 'exponent'],
    [
      { v: 2, s: scope, f: 'liquidity', d: 'asc', n: true, k: '9'.repeat(257), i: 'id' },
      'oversized decimal',
    ],
    [{ v: 2, s: scope, f: 'id', d: 'asc', n: false, k: 'id', i: '' }, 'empty id'],
    [{ v: 2, s: scope, f: 'id', d: 'asc', n: false, k: 'id', i: 'bad\0id' }, 'NUL id'],
    [{ v: 2, s: scope, f: 'id', d: 'asc', n: false, k: 'id', i: 'space id' }, 'space id'],
    [{ v: 2, s: scope, f: 'id', d: 'asc', n: false, k: 'id', i: 'unicode-ä' }, 'Unicode id'],
  ])('rejects forged payload with $2', (payload, _reason) => {
    expect(decodeRepositoryCursor(forge(payload))).toBeNull();
  });

  it('rejects invalid encoder input instead of repairing it silently', () => {
    expect(() => encodeRepositoryCursor({ ...validKeyset, scope: 'invalid' })).toThrow(/invalid/);
    expect(() => encodeRepositoryCursor({ ...validKeyset, value: '1e9' })).toThrow(/invalid/);
    expect(() => encodeRepositoryCursor({ ...validKeyset, value: '9007199254740992' })).toThrow(/invalid/);
    expect(() => encodeRepositoryCursor({ ...validKeyset, id: '' })).toThrow(/invalid/);
    expect(() => encodeRepositoryCursor({ ...validKeyset, id: 'x'.repeat(1_025) })).toThrow(/invalid/);
  });

  it('normalizes malformed stored numeric values as null instead of forging a zero position', () => {
    expect(normalizeRepositoryCursorValue('not-a-decimal', true)).toBeNull();
    expect(normalizeRepositoryCursorValue(undefined, true)).toBeNull();
    expect(normalizeRepositoryCursorValue('0', true)).toBe('0');
  });

  it('accepts only bounded strings through the GraphQL Cursor scalar', () => {
    const cursor = encodeRepositoryCursor(validKeyset);
    expect(CursorScalar.parseValue(cursor)).toBe(cursor);
    expect(CursorScalar.parseValue('')).toBe('');
    expect(CursorScalar.parseLiteral({ kind: Kind.STRING, value: cursor }, undefined)).toBe(cursor);
    expect(() => CursorScalar.parseValue(123)).toThrow(/opaque string/);
    expect(() => CursorScalar.parseValue('x'.repeat(MAX_REPOSITORY_CURSOR_LENGTH + 1))).toThrow(/at most/);
    expect(() => CursorScalar.parseLiteral({ kind: Kind.INT, value: '1' }, undefined)).toThrow(/literal/);
  });
});
