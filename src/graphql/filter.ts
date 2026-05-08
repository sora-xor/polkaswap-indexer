export type FilterValue = Record<string, unknown> | null | undefined;

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
  return path.split('.').reduce<unknown>((value, key) => {
    if (value && typeof value === 'object') {
      return (value as Record<string, unknown>)[key];
    }
    return undefined;
  }, item);
};

const includesInsensitive = (value: unknown, needle: unknown): boolean => {
  return String(value ?? '').toLowerCase().includes(String(needle ?? '').toLowerCase());
};

const contains = (value: unknown, expected: unknown): boolean => {
  if (Array.isArray(value)) {
    if (Array.isArray(expected)) {
      return expected.every((item) => value.includes(item));
    }
    return value.includes(expected);
  }

  if (value && typeof value === 'object' && expected && typeof expected === 'object') {
    return Object.entries(expected as Record<string, unknown>).every(([key, expectedValue]) => {
      return (value as Record<string, unknown>)[key] === expectedValue;
    });
  }

  return value === expected;
};

const matchesComparison = (actual: unknown, comparison: Record<string, unknown>): boolean => {
  return Object.entries(comparison).every(([operator, expected]) => {
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
  if (!filter || !Object.keys(filter).length) return true;

  return Object.entries(filter).every(([field, condition]) => {
    if (field === 'and') {
      return Array.isArray(condition) && condition.every((entry) => matchesFilter(item, entry as FilterValue));
    }

    if (field === 'or') {
      return Array.isArray(condition) && condition.some((entry) => matchesFilter(item, entry as FilterValue));
    }

    if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
      return matchesComparison(getPath(item, field), condition as Record<string, unknown>);
    }

    return getPath(item, field) === condition;
  });
}

const getOrderField = (orderBy: unknown): { field: string; direction: 'asc' | 'desc' } => {
  const first = Array.isArray(orderBy) ? orderBy[0] : orderBy;
  const token = String(first ?? 'ID_ASC');
  const direction = token.endsWith('_DESC') ? 'desc' : 'asc';
  const rawField = token.replace(/_(ASC|DESC)$/, '').toLowerCase();
  const parts = rawField.split('_');
  const field = parts
    .map((part, index) => (index === 0 ? part : `${part.charAt(0).toUpperCase()}${part.slice(1)}`))
    .join('');

  return { field, direction };
};

export function sortDocuments<T extends Record<string, unknown>>(items: T[], orderBy: unknown): T[] {
  const { field, direction } = getOrderField(orderBy);
  const factor = direction === 'desc' ? -1 : 1;

  return [...items].sort((a, b) => {
    const left = getPath(a, field);
    const right = getPath(b, field);

    if (left === right) return 0;
    if (left === undefined || left === null) return factor;
    if (right === undefined || right === null) return -factor;

    if (typeof left === 'number' && typeof right === 'number') {
      return left > right ? factor : -factor;
    }

    return String(left).localeCompare(String(right)) * factor;
  });
}
