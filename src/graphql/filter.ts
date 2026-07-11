import { getOrderField, NUMERIC_ORDER_FIELDS } from './order.js';
import { compareLexical } from '../lexical.js';

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

const matchesComparison = (actual: unknown, comparison: Record<string, unknown>, numeric: boolean): boolean => {
  return Object.entries(comparison).every(([operator, expected]) => {
    if (isNullishFilterValue(expected)) return true;

    switch (operator) {
      case 'equalTo':
      case 'eq': {
        if (!numeric) return toComparable(actual) === toComparable(expected);
        return compareDecimalValues(actual, expected) === 0;
      }
      case 'equalToInsensitive':
        return String(actual ?? '').toLowerCase() === String(expected ?? '').toLowerCase();
      case 'notEqualTo':
      case 'not_eq': {
        if (!numeric) return toComparable(actual) !== toComparable(expected);
        const result = compareDecimalValues(actual, expected);
        return result !== null && result !== 0;
      }
      case 'in': {
        if (!Array.isArray(expected)) return false;
        const values = expected.filter((value) => !isNullishFilterValue(value));
        if (numeric) return values.some((value) => compareDecimalValues(actual, value) === 0);
        return values.map(toComparable).includes(toComparable(actual));
      }
      case 'notIn':
      case 'not_in': {
        if (!Array.isArray(expected)) return false;
        const values = expected.filter((value) => !isNullishFilterValue(value));
        if (numeric) {
          return values.every((value) => {
            const result = compareDecimalValues(actual, value);
            return result !== null && result !== 0;
          });
        }
        return !values.map(toComparable).includes(toComparable(actual));
      }
      case 'greaterThan':
      case 'gt': {
        const result = compareDecimalValues(actual, expected);
        return result !== null && result > 0;
      }
      case 'greaterThanOrEqualTo':
      case 'gte': {
        const result = compareDecimalValues(actual, expected);
        return result !== null && result >= 0;
      }
      case 'lessThan':
      case 'lt': {
        const result = compareDecimalValues(actual, expected);
        return result !== null && result < 0;
      }
      case 'lessThanOrEqualTo':
      case 'lte': {
        const result = compareDecimalValues(actual, expected);
        return result !== null && result <= 0;
      }
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
      return matchesComparison(
        getPath(item, field),
        condition as Record<string, unknown>,
        NUMERIC_ORDER_FIELDS.has(field)
      );
    }

    if (NUMERIC_ORDER_FIELDS.has(field)) return compareDecimalValues(getPath(item, field), condition) === 0;
    return getPath(item, field) === condition;
  });
}

/**
 * Normalizes decimal-like values for exact sorting without converting token
 * amounts or USD strings to JavaScript floating point numbers.
 */
type NormalizedDecimal = { sign: -1 | 0 | 1; integer: string; fraction: string };

export const normalizeDecimal = (value: unknown): NormalizedDecimal | null => {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  const text = String(value);
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;

  const negative = text.startsWith('-');
  const [integerRaw = '0', fractionRaw = ''] = (negative ? text.slice(1) : text).split('.');
  const integer = integerRaw.replace(/^0+/, '') || '0';
  const fraction = fractionRaw.replace(/0+$/, '');
  const sign = integer === '0' && !fraction ? 0 : negative ? -1 : 1;

  return { sign, integer, fraction };
};

const compareUnsignedDecimals = (left: NormalizedDecimal, right: NormalizedDecimal): number => {
  if (left.integer.length !== right.integer.length) return left.integer.length > right.integer.length ? 1 : -1;
  if (left.integer !== right.integer) return left.integer > right.integer ? 1 : -1;

  const maxFractionLength = Math.max(left.fraction.length, right.fraction.length);
  const leftFraction = left.fraction.padEnd(maxFractionLength, '0');
  const rightFraction = right.fraction.padEnd(maxFractionLength, '0');

  if (leftFraction === rightFraction) return 0;
  return leftFraction > rightFraction ? 1 : -1;
};

export const compareDecimalValues = (left: unknown, right: unknown): number | null => {
  const normalizedLeft = normalizeDecimal(left);
  const normalizedRight = normalizeDecimal(right);
  if (!normalizedLeft || !normalizedRight) return null;

  if (normalizedLeft.sign !== normalizedRight.sign) return normalizedLeft.sign > normalizedRight.sign ? 1 : -1;
  if (normalizedLeft.sign === 0) return 0;

  const unsignedComparison = compareUnsignedDecimals(normalizedLeft, normalizedRight);
  return normalizedLeft.sign > 0 ? unsignedComparison : -unsignedComparison;
};

/** Compares one order value using the list-fallback sort semantics. */
export const compareOrderValues = (
  left: unknown,
  right: unknown,
  field: string,
  direction: 'asc' | 'desc'
): number => {
  const factor = direction === 'desc' ? -1 : 1;
  const numeric = NUMERIC_ORDER_FIELDS.has(field);
  const leftNullish = left === undefined || left === null || (numeric && normalizeDecimal(left) === null);
  const rightNullish = right === undefined || right === null || (numeric && normalizeDecimal(right) === null);

  if (left === right) return 0;
  if (leftNullish && rightNullish) return 0;
  if (leftNullish) return factor;
  if (rightNullish) return -factor;
  if (numeric) return (compareDecimalValues(left, right) ?? 0) * factor;
  if (typeof left === 'number' && typeof right === 'number') return left > right ? factor : -factor;

  return compareLexical(String(left), String(right)) * factor;
};

export const isAfterOrderPosition = (
  item: Record<string, unknown>,
  position: {
    field: string;
    value: string | null;
    id: string;
    direction: 'asc' | 'desc';
  }
): boolean => {
  const comparison = compareOrderValues(
    getPath(item, position.field),
    position.value,
    position.field,
    position.direction
  );
  if (comparison !== 0) return comparison > 0;

  const idComparison = compareLexical(String(item.id ?? ''), position.id);
  return position.direction === 'desc' ? idComparison < 0 : idComparison > 0;
};

export function sortDocuments<T extends Record<string, unknown>>(items: T[], orderBy: unknown): T[] {
  const { field, direction } = getOrderField(orderBy);
  const factor = direction === 'desc' ? -1 : 1;

  return [...items].sort((a, b) => {
    const left = getPath(a, field);
    const right = getPath(b, field);
    const comparison = compareOrderValues(left, right, field, direction);

    if (comparison !== 0) return comparison;
    return compareLexical(String(a.id ?? ''), String(b.id ?? '')) * factor;
  });
}
