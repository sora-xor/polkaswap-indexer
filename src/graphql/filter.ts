import { getOrderField, NUMERIC_ORDER_FIELDS } from './order.js';

export type FilterValue = Record<string, unknown> | null | undefined;

const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);
const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isFilterRecord = (value: unknown): value is Record<string, unknown> => {
  if (!isRecord(value)) return false;

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const isSafePath = (path: string): boolean => {
  const segments = path.split('.');

  return segments.length > 0 && segments.every((segment) => segment.length > 0 && !UNSAFE_PATH_SEGMENTS.has(segment));
};

const toComparable = (value: unknown): string | number | boolean | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  return String(value);
};

const toNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const getPath = (item: Record<string, unknown>, path: string): unknown => {
  if (!isSafePath(path)) return undefined;

  return path.split('.').reduce<unknown>((value, key) => {
    if (isRecord(value) && hasOwn(value, key)) {
      return (value as Record<string, unknown>)[key];
    }
    return undefined;
  }, item);
};

const includesInsensitive = (value: unknown, needle: unknown): boolean => {
  return String(value ?? '').toLowerCase().includes(String(needle ?? '').toLowerCase());
};

const isNullishFilterValue = (value: unknown): boolean => value === null || value === undefined || value === 'null';

const contains = (value: unknown, expected: unknown): boolean => {
  if (Array.isArray(value)) {
    if (Array.isArray(expected)) {
      return expected.every((item) => value.includes(item));
    }
    return value.includes(expected);
  }

  if (isRecord(value) && isRecord(expected)) {
    return Object.entries(expected as Record<string, unknown>).every(([key, expectedValue]) => {
      if (!isSafePath(key) || !hasOwn(value, key)) return false;

      return (value as Record<string, unknown>)[key] === expectedValue;
    });
  }

  return value === expected;
};

const matchesComparison = (actual: unknown, comparison: Record<string, unknown>): boolean => {
  return Object.entries(comparison).every(([operator, expected]) => {
    if (isNullishFilterValue(expected)) return true;

    switch (operator) {
      case 'equalTo':
      case 'eq':
        return toComparable(actual) === toComparable(expected);
      case 'equalToInsensitive':
        return String(actual ?? '').toLowerCase() === String(expected ?? '').toLowerCase();
      case 'notEqualTo':
      case 'not_eq':
        return toComparable(actual) !== toComparable(expected);
      case 'in':
        return Array.isArray(expected) && expected.map(toComparable).includes(toComparable(actual));
      case 'notIn':
      case 'not_in':
        return Array.isArray(expected) && !expected.map(toComparable).includes(toComparable(actual));
      case 'greaterThan':
      case 'gt':
        return toNumber(actual) > toNumber(expected);
      case 'greaterThanOrEqualTo':
      case 'gte':
        return toNumber(actual) >= toNumber(expected);
      case 'lessThan':
      case 'lt':
        return toNumber(actual) < toNumber(expected);
      case 'lessThanOrEqualTo':
      case 'lte':
        return toNumber(actual) <= toNumber(expected);
      case 'includesInsensitive':
        return includesInsensitive(actual, expected);
      case 'contains':
        return contains(actual, expected);
      default:
        return false;
    }
  });
};

/**
 * Evaluates the SubQuery-style filter objects produced by the Polkaswap UI.
 */
export function matchesFilter(item: Record<string, unknown>, filter: FilterValue): boolean {
  if (!filter) return true;
  if (!isFilterRecord(filter)) return false;
  if (!Object.keys(filter).length) return true;

  return Object.entries(filter).every(([field, condition]) => {
    if (field === 'and') {
      return Array.isArray(condition) && condition.every((entry) => isFilterRecord(entry) && matchesFilter(item, entry));
    }

    if (field === 'or') {
      return Array.isArray(condition) && condition.some((entry) => isFilterRecord(entry) && matchesFilter(item, entry));
    }

    if (!isSafePath(field)) return false;

    if (isFilterRecord(condition)) {
      return matchesComparison(getPath(item, field), condition as Record<string, unknown>);
    }

    return getPath(item, field) === condition;
  });
}

/**
 * Normalizes decimal-like values for exact sorting without converting token
 * amounts or USD strings to JavaScript floating point numbers.
 */
const normalizeDecimal = (value: unknown): { sign: -1 | 0 | 1; integer: string; fraction: string } => {
  const text = String(value ?? '0').trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) return { sign: 0, integer: '0', fraction: '' };

  const negative = text.startsWith('-');
  const [integerRaw = '0', fractionRaw = ''] = (negative ? text.slice(1) : text).split('.');
  const integer = integerRaw.replace(/^0+/, '') || '0';
  const fraction = fractionRaw.replace(/0+$/, '');
  const sign = integer === '0' && !fraction ? 0 : negative ? -1 : 1;

  return { sign, integer, fraction };
};

const compareUnsignedDecimals = (
  left: { integer: string; fraction: string },
  right: { integer: string; fraction: string }
): number => {
  if (left.integer.length !== right.integer.length) return left.integer.length > right.integer.length ? 1 : -1;
  if (left.integer !== right.integer) return left.integer > right.integer ? 1 : -1;

  const maxFractionLength = Math.max(left.fraction.length, right.fraction.length);
  const leftFraction = left.fraction.padEnd(maxFractionLength, '0');
  const rightFraction = right.fraction.padEnd(maxFractionLength, '0');

  if (leftFraction === rightFraction) return 0;
  return leftFraction > rightFraction ? 1 : -1;
};

const compareNumericValues = (left: unknown, right: unknown): number => {
  const normalizedLeft = normalizeDecimal(left);
  const normalizedRight = normalizeDecimal(right);

  if (normalizedLeft.sign !== normalizedRight.sign) return normalizedLeft.sign > normalizedRight.sign ? 1 : -1;
  if (normalizedLeft.sign === 0) return 0;

  const unsignedComparison = compareUnsignedDecimals(normalizedLeft, normalizedRight);
  return normalizedLeft.sign > 0 ? unsignedComparison : -unsignedComparison;
};

export function sortDocuments<T extends Record<string, unknown>>(items: T[], orderBy: unknown): T[] {
  const { field, direction } = getOrderField(orderBy);
  const factor = direction === 'desc' ? -1 : 1;

  return [...items].sort((a, b) => {
    const left = getPath(a, field);
    const right = getPath(b, field);
    const leftNullishRank = left === undefined ? 0 : left === null ? 1 : -1;
    const rightNullishRank = right === undefined ? 0 : right === null ? 1 : -1;

    if (left === right) return 0;
    if (leftNullishRank >= 0 && rightNullishRank >= 0) return leftNullishRank - rightNullishRank;
    if (leftNullishRank >= 0) return factor;
    if (rightNullishRank >= 0) return -factor;

    if (NUMERIC_ORDER_FIELDS.has(field)) {
      const comparison = compareNumericValues(left, right);
      return comparison === 0 ? 0 : comparison * factor;
    }

    if (typeof left === 'number' && typeof right === 'number') {
      return left > right ? factor : -factor;
    }

    return String(left).localeCompare(String(right)) * factor;
  });
}
