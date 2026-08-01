import { createHash } from 'node:crypto';

import { getOrderField, NUMERIC_ORDER_FIELDS } from '../graphql/order.js';
import { compareLexical } from '../lexical.js';
import { assertValidDocumentId } from './validation.js';

import type { IndexerCollection, RepositoryKeyset } from './types.js';

const CURSOR_PREFIX = 'psc2.';
export const MAX_REPOSITORY_CURSOR_LENGTH = 2_048;
const MAX_CURSOR_FIELD_LENGTH = 128;
const MAX_CURSOR_VALUE_LENGTH = 1_024;
const SAFE_FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const SCOPE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DECIMAL_PATTERN = /^-?[0-9]+(\.[0-9]+)?$/;
const MAX_CURSOR_NUMERIC_DIGITS = 256;

type CursorPayload = {
  v: 2;
  s: string;
  f: string;
  d: 'asc' | 'desc';
  n: boolean;
  k: string | null;
  i: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const validDecimalValue = (value: string): boolean =>
  DECIMAL_PATTERN.test(value) && value.replace(/[-.]/g, '').length <= MAX_CURSOR_NUMERIC_DIGITS;

const validNativeIntegerValue = (field: string, value: string): boolean => {
  if (field !== 'timestamp' && field !== 'blockHeight') return true;
  if (!/^-?[0-9]+$/.test(value)) return false;

  const parsed = Number(value);
  return Number.isSafeInteger(parsed);
};

const validDocumentId = (value: unknown): value is string => {
  try {
    assertValidDocumentId(value);
    return true;
  } catch {
    return false;
  }
};

const stableJson = (value: unknown, ancestors = new Set<object>()): string => {
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error('Cannot scope a cyclic pagination filter');
    ancestors.add(value);
    const result = `[${value.map((item) => stableJson(item, ancestors)).join(',')}]`;
    ancestors.delete(value);
    return result;
  }
  if (value && typeof value === 'object') {
    if (ancestors.has(value)) throw new Error('Cannot scope a cyclic pagination filter');
    ancestors.add(value);
    const result = `{${Object.entries(value)
      .sort(([left], [right]) => compareLexical(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item, ancestors)}`)
      .join(',')}}`;
    ancestors.delete(value);
    return result;
  }

  return JSON.stringify(value) ?? 'undefined';
};

/** Binds a cursor to one collection, normalized order, and canonical filter. */
export const createRepositoryCursorScope = (
  collection: IndexerCollection,
  orderBy: unknown,
  filter: Record<string, unknown> | null | undefined
): string => {
  const { field, direction } = getOrderField(orderBy);
  const numeric = NUMERIC_ORDER_FIELDS.has(field);
  return createHash('sha256')
    .update(stableJson({ collection, direction, field, filter: filter ?? null, numeric }))
    .digest('base64url');
};

/** Normalizes values to the same representation used by repository indexes. */
export const normalizeRepositoryCursorValue = (value: unknown, numeric: boolean): string | null => {
  if (value === null || value === undefined) return null;

  const text = String(value);
  if (!numeric) return text;

  return DECIMAL_PATTERN.test(text.trim()) ? text.trim() : null;
};

const validCursorKeyset = (keyset: RepositoryKeyset): boolean =>
  SAFE_FIELD.test(keyset.field) &&
  keyset.field.length <= MAX_CURSOR_FIELD_LENGTH &&
  (keyset.direction === 'asc' || keyset.direction === 'desc') &&
  typeof keyset.numeric === 'boolean' &&
  (keyset.value === null ||
    (typeof keyset.value === 'string' &&
      keyset.value.length <= MAX_CURSOR_VALUE_LENGTH &&
      (!keyset.numeric ||
        (validDecimalValue(keyset.value) && validNativeIntegerValue(keyset.field, keyset.value))))) &&
  validDocumentId(keyset.id) &&
  SCOPE_PATTERN.test(keyset.scope);

export const encodeRepositoryCursor = (keyset: RepositoryKeyset): string => {
  if (!validCursorKeyset(keyset)) throw new Error('Cannot encode an invalid repository cursor position');
  const payload: CursorPayload = {
    v: 2,
    s: keyset.scope,
    f: keyset.field,
    d: keyset.direction,
    n: keyset.numeric,
    k: keyset.value,
    i: keyset.id,
  };
  const cursor = `${CURSOR_PREFIX}${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  if (cursor.length > MAX_REPOSITORY_CURSOR_LENGTH) throw new Error('Encoded repository cursor exceeds its size limit');

  return cursor;
};

/** Returns null for malformed, legacy, unscoped, or oversized cursor values. */
export const decodeRepositoryCursor = (cursor: unknown): RepositoryKeyset | null => {
  if (
    typeof cursor !== 'string' ||
    cursor.length > MAX_REPOSITORY_CURSOR_LENGTH ||
    !cursor.startsWith(CURSOR_PREFIX)
  ) {
    return null;
  }

  try {
    const encoded = cursor.slice(CURSOR_PREFIX.length);
    if (!encoded || !BASE64URL_PATTERN.test(encoded)) return null;
    const decoded = Buffer.from(encoded, 'base64url');
    if (decoded.toString('base64url') !== encoded) return null;

    const payload: unknown = JSON.parse(decoded.toString('utf8'));
    if (
      !isRecord(payload) ||
      Object.keys(payload).sort().join(',') !== 'd,f,i,k,n,s,v' ||
      payload.v !== 2 ||
      typeof payload.s !== 'string' ||
      !SCOPE_PATTERN.test(payload.s) ||
      typeof payload.f !== 'string' ||
      payload.f.length > MAX_CURSOR_FIELD_LENGTH ||
      !SAFE_FIELD.test(payload.f) ||
      (payload.d !== 'asc' && payload.d !== 'desc') ||
      typeof payload.n !== 'boolean' ||
      (payload.k !== null &&
        (typeof payload.k !== 'string' || payload.k.length > MAX_CURSOR_VALUE_LENGTH)) ||
      (payload.n &&
        typeof payload.k === 'string' &&
        (!validDecimalValue(payload.k) || !validNativeIntegerValue(payload.f, payload.k))) ||
      !validDocumentId(payload.i)
    ) {
      return null;
    }

    return {
      scope: payload.s,
      field: payload.f,
      direction: payload.d,
      numeric: payload.n,
      value: payload.k,
      id: payload.i,
    };
  } catch {
    return null;
  }
};

export const isOpaqueRepositoryCursor = (cursor: unknown): cursor is string =>
  typeof cursor === 'string' && cursor.startsWith(CURSOR_PREFIX);
