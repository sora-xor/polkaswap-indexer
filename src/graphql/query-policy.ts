import { getOrderField } from './order.js';
import {
  assertValidNativePositionQueryValue,
  NATIVE_POSITION_FIELDS,
} from '../repository/validation.js';

import type { IndexerCollection } from '../repository/types.js';

type PublicConnectionName = IndexerCollection | 'accountTrades';
type ComparisonKind = 'identifier' | 'numeric' | 'set' | 'search' | 'contains' | 'structuredContains';

type PublicQueryPolicy = {
  filterFields: Readonly<Record<string, ComparisonKind>>;
  orderFields: ReadonlySet<string>;
};

type PublicFilterPlan = {
  orderField: string;
  allowedFields: ReadonlySet<string>;
  requiredAll?: ReadonlySet<string>;
  requiredAny?: ReadonlySet<string>;
  requiredExactAll?: ReadonlySet<string>;
  requiredExactAny?: ReadonlySet<string>;
  requiredBranchExactAll?: ReadonlySet<string>;
  requiredIndexedAll?: ReadonlySet<string>;
  requiredRangeFields?: ReadonlySet<string>;
  requiredBoundedRangeFields?: ReadonlySet<string>;
};

const IDENTIFIER_OPERATORS = new Set(['equalTo', 'eq', 'in']);
const NUMERIC_OPERATORS = new Set([
  'equalTo',
  'eq',
  'in',
  'greaterThan',
  'gt',
  'greaterThanOrEqualTo',
  'gte',
  'lessThan',
  'lt',
  'lessThanOrEqualTo',
  'lte',
]);
const SET_OPERATORS = new Set([
  ...IDENTIFIER_OPERATORS,
  'notEqualTo',
  'not_eq',
  'notIn',
  'not_in',
]);
const CONTAINS_OPERATORS = new Set(['contains']);
const SEARCH_OPERATORS = new Set([...SET_OPERATORS, 'equalToInsensitive', 'includesInsensitive']);
const LOGICAL_FIELDS = new Set(['and', 'or']);
const DECIMAL_PATTERN = /^-?([0-9]+)(?:\.([0-9]+))?$/;
const MAX_DECIMAL_INTEGER_DIGITS = 80;
const MAX_DECIMAL_FRACTION_DIGITS = 40;

const fields = <T extends Record<string, ComparisonKind>>(value: T): T => value;
const orders = (...value: string[]): ReadonlySet<string> => new Set(['id', ...value]);
const fieldSet = (...value: string[]): ReadonlySet<string> => new Set(value);
const plan = (
  orderField: string,
  allowedFields: readonly string[],
  requirements: Pick<
    PublicFilterPlan,
    | 'requiredAll'
    | 'requiredAny'
    | 'requiredExactAll'
    | 'requiredExactAny'
    | 'requiredBranchExactAll'
    | 'requiredIndexedAll'
    | 'requiredRangeFields'
    | 'requiredBoundedRangeFields'
  > = {}
): PublicFilterPlan => ({
  orderField,
  allowedFields: new Set(allowedFields),
  ...requirements,
});

/**
 * Public query capabilities are deliberately narrower than the repository's
 * trusted internal query language. Every listed order field has a production
 * storage plan, and every filter field is part of a supported UI query shape.
 */
const PUBLIC_QUERY_POLICIES: Partial<Record<PublicConnectionName, PublicQueryPolicy>> = {
  accountLiquiditySnapshots: {
    orderFields: orders('timestamp'),
    filterFields: fields({
      id: 'identifier',
      accountLiquidityId: 'identifier',
      type: 'identifier',
      timestamp: 'numeric',
    }),
  },
  accountPointSystems: {
    orderFields: orders(),
    filterFields: fields({ id: 'identifier', accountId: 'identifier' }),
  },
  accountPositions: {
    orderFields: orders('timestamp'),
    filterFields: fields({
      id: 'identifier',
      account: 'identifier',
      marketId: 'numeric',
      status: 'identifier',
    }),
  },
  accountTrades: {
    orderFields: orders('timestamp'),
    filterFields: fields({ account: 'identifier', accountId: 'identifier' }),
  },
  assets: {
    orderFields: orders(),
    filterFields: fields({
      id: 'identifier',
      liquidity: 'numeric',
      liquidityBooks: 'numeric',
      liquidityUSD: 'numeric',
      priceUSD: 'numeric',
      priceChangeDay: 'numeric',
      priceChangeWeek: 'numeric',
      volumeDayUSD: 'numeric',
      volumeWeekUSD: 'numeric',
    }),
  },
  assetSnapshots: {
    orderFields: orders('timestamp', 'blockHeight'),
    filterFields: fields({
      id: 'identifier',
      assetId: 'identifier',
      type: 'identifier',
      timestamp: 'numeric',
      blockHeight: 'numeric',
    }),
  },
  historyElements: {
    orderFields: orders('timestamp'),
    filterFields: fields({
      id: 'identifier',
      type: 'set',
      timestamp: 'numeric',
      blockHeight: 'numeric',
      blockHash: 'search',
      module: 'search',
      method: 'search',
      address: 'identifier',
      dataFrom: 'identifier',
      dataTo: 'identifier',
      dataAssets: 'contains',
      callNames: 'contains',
      data: 'structuredContains',
    }),
  },
  markets: {
    orderFields: orders(),
    filterFields: fields({
      id: 'identifier',
      marketId: 'numeric',
      status: 'identifier',
      creator: 'identifier',
      updatedAtBlock: 'numeric',
      liquidityUSD: 'numeric',
      volumeUSD: 'numeric',
    }),
  },
  marketSnapshots: {
    orderFields: orders('timestamp', 'blockHeight'),
    filterFields: fields({
      id: 'identifier',
      marketId: 'numeric',
      type: 'identifier',
      timestamp: 'numeric',
      blockHeight: 'numeric',
      status: 'identifier',
    }),
  },
  networkSnapshots: {
    orderFields: orders('timestamp', 'blockHeight'),
    filterFields: fields({
      id: 'identifier',
      type: 'identifier',
      timestamp: 'numeric',
      blockHeight: 'numeric',
      liquidityUSD: 'numeric',
    }),
  },
  orderBooks: {
    orderFields: orders(),
    filterFields: fields({
      id: 'identifier',
      baseAssetId: 'identifier',
      quoteAssetId: 'identifier',
      status: 'identifier',
      updatedAtBlock: 'numeric',
      priceChangeDay: 'numeric',
      liquidityUSD: 'numeric',
      volumeDayUSD: 'numeric',
      baseAssetReserves: 'numeric',
    }),
  },
  orderBookOrders: {
    orderFields: orders('timestamp'),
    filterFields: fields({
      id: 'identifier',
      accountId: 'identifier',
      orderBookId: 'identifier',
      type: 'identifier',
      status: 'set',
      timestamp: 'numeric',
      updatedAtBlock: 'numeric',
      createdAtBlock: 'numeric',
      amount: 'numeric',
    }),
  },
  orderBookSnapshots: {
    orderFields: orders('timestamp'),
    filterFields: fields({
      id: 'identifier',
      orderBookId: 'identifier',
      type: 'identifier',
      timestamp: 'numeric',
    }),
  },
  poolXYKs: {
    orderFields: orders(),
    filterFields: fields({
      id: 'identifier',
      baseAssetId: 'identifier',
      targetAssetId: 'identifier',
      liquidityUSD: 'numeric',
      priceUSD: 'numeric',
      poolTokenPriceUSD: 'numeric',
      baseAssetReserves: 'numeric',
      targetAssetReserves: 'numeric',
      strategicBonusApy: 'numeric',
    }),
  },
  poolSnapshots: {
    orderFields: orders('timestamp'),
    filterFields: fields({
      id: 'identifier',
      poolId: 'identifier',
      type: 'identifier',
      timestamp: 'numeric',
    }),
  },
  referrerRewards: {
    orderFields: orders(),
    filterFields: fields({
      id: 'identifier',
      referrer: 'identifier',
      referral: 'identifier',
      amount: 'numeric',
    }),
  },
  stakingStakers: {
    orderFields: orders(),
    filterFields: fields({ id: 'identifier' }),
  },
  stakingValidators: {
    orderFields: orders(),
    filterFields: fields({
      id: 'identifier',
      address: 'identifier',
      apy: 'numeric',
      commission: 'numeric',
      rewardPoints: 'numeric',
    }),
  },
  vaults: {
    orderFields: orders('updatedAtBlock'),
    filterFields: fields({
      id: 'identifier',
      type: 'identifier',
      status: 'identifier',
      ownerId: 'identifier',
      collateralAssetId: 'identifier',
      debtAssetId: 'identifier',
      createdAtBlock: 'numeric',
      updatedAtBlock: 'numeric',
    }),
  },
  vaultEvents: {
    orderFields: orders('timestamp'),
    filterFields: fields({
      id: 'identifier',
      vaultId: 'identifier',
      type: 'identifier',
      timestamp: 'numeric',
    }),
  },
  xorBurns: {
    orderFields: orders(),
    filterFields: fields({
      id: 'identifier',
      address: 'identifier',
      timestamp: 'numeric',
      blockHeight: 'numeric',
      amount: 'numeric',
    }),
  },
};

/**
 * Non-empty filters must select a compact source, not merely use a field that
 * happens to be valid for the collection. This prevents combinations such as
 * an ID sort plus an unrelated numeric predicate from degenerating into a
 * collection scan. Empty filters remain safe because every advertised order
 * field above has a direct ordered source.
 */
const PUBLIC_FILTER_PLANS: Partial<Record<PublicConnectionName, readonly PublicFilterPlan[]>> = {
  accountLiquiditySnapshots: [
    plan('timestamp', ['accountLiquidityId', 'type', 'timestamp'], {
      requiredExactAll: fieldSet('accountLiquidityId'),
    }),
  ],
  accountPointSystems: [plan('id', ['accountId'], { requiredIndexedAll: fieldSet('accountId') })],
  accountPositions: [
    plan('timestamp', ['account', 'marketId', 'status'], { requiredExactAll: fieldSet('account') }),
  ],
  accountTrades: [
    plan('timestamp', ['account', 'accountId'], { requiredExactAny: fieldSet('account', 'accountId') }),
  ],
  assets: [
    plan('id', ['id', 'liquidity', 'liquidityBooks'], {
      requiredAny: fieldSet('liquidity', 'liquidityBooks'),
      requiredRangeFields: fieldSet('liquidity', 'liquidityBooks'),
    }),
    plan('id', ['priceUSD'], {
      requiredAll: fieldSet('priceUSD'),
      requiredRangeFields: fieldSet('priceUSD'),
    }),
  ],
  assetSnapshots: [
    plan('timestamp', ['assetId', 'type', 'timestamp'], { requiredExactAll: fieldSet('assetId', 'type') }),
    plan('timestamp', ['assetId', 'type', 'timestamp'], {
      requiredAll: fieldSet('timestamp'),
      requiredBoundedRangeFields: fieldSet('timestamp'),
    }),
    plan('blockHeight', ['assetId', 'type', 'blockHeight'], { requiredExactAll: fieldSet('assetId') }),
  ],
  historyElements: [
    plan(
      'timestamp',
      ['type', 'timestamp', 'blockHash', 'module', 'method', 'address', 'dataFrom', 'dataTo', 'dataAssets', 'callNames', 'data'],
      { requiredExactAll: fieldSet('address') }
    ),
    plan('id', ['type', 'blockHeight', 'blockHash', 'module', 'method', 'address', 'dataFrom', 'dataTo', 'dataAssets', 'callNames', 'data'], {
      requiredAll: fieldSet('blockHeight'),
      requiredRangeFields: fieldSet('blockHeight'),
      requiredBoundedRangeFields: fieldSet('blockHeight'),
      requiredBranchExactAll: fieldSet('module', 'method'),
    }),
  ],
  marketSnapshots: [
    plan('timestamp', ['marketId', 'type', 'timestamp', 'status'], {
      requiredExactAll: fieldSet('marketId', 'type'),
    }),
    plan('blockHeight', ['marketId', 'type', 'blockHeight', 'status'], {
      requiredExactAll: fieldSet('marketId', 'type'),
    }),
  ],
  networkSnapshots: [
    plan('timestamp', ['type', 'timestamp', 'liquidityUSD'], { requiredExactAll: fieldSet('type') }),
    plan('timestamp', ['type', 'timestamp', 'liquidityUSD'], {
      requiredAll: fieldSet('timestamp'),
      requiredBoundedRangeFields: fieldSet('timestamp'),
    }),
    plan('blockHeight', ['type', 'blockHeight'], { requiredExactAll: fieldSet('type') }),
  ],
  orderBooks: [
    plan('id', ['baseAssetId', 'status'], { requiredIndexedAll: fieldSet('baseAssetId') }),
    plan('id', ['quoteAssetId', 'status'], { requiredIndexedAll: fieldSet('quoteAssetId') }),
  ],
  orderBookOrders: [
    plan('timestamp', ['accountId', 'orderBookId', 'type', 'status', 'timestamp'], {
      requiredExactAny: fieldSet('accountId', 'orderBookId'),
    }),
    plan('timestamp', ['accountId', 'orderBookId', 'type', 'status', 'timestamp'], {
      requiredAll: fieldSet('timestamp'),
      requiredBoundedRangeFields: fieldSet('timestamp'),
    }),
  ],
  orderBookSnapshots: [
    plan('timestamp', ['orderBookId', 'type', 'timestamp'], {
      requiredExactAll: fieldSet('orderBookId', 'type'),
    }),
    plan('timestamp', ['orderBookId', 'type', 'timestamp'], {
      requiredAll: fieldSet('timestamp'),
      requiredBoundedRangeFields: fieldSet('timestamp'),
    }),
  ],
  poolXYKs: [
    plan('id', ['baseAssetId', 'targetAssetId'], { requiredIndexedAll: fieldSet('baseAssetId') }),
    plan('id', ['baseAssetReserves', 'targetAssetReserves', 'targetAssetId'], {
      requiredAll: fieldSet('baseAssetReserves', 'targetAssetReserves'),
      requiredRangeFields: fieldSet('baseAssetReserves', 'targetAssetReserves'),
    }),
    plan('id', ['strategicBonusApy'], {
      requiredAll: fieldSet('strategicBonusApy'),
      requiredRangeFields: fieldSet('strategicBonusApy'),
    }),
  ],
  poolSnapshots: [
    plan('timestamp', ['poolId', 'type', 'timestamp'], { requiredExactAll: fieldSet('poolId', 'type') }),
  ],
  referrerRewards: [
    plan('id', ['referrer', 'referral', 'amount'], { requiredIndexedAll: fieldSet('referrer') }),
  ],
  stakingValidators: [plan('id', ['address'], { requiredIndexedAll: fieldSet('address') })],
  vaults: [
    plan('id', ['ownerId', 'type', 'status', 'collateralAssetId', 'debtAssetId'], {
      requiredIndexedAll: fieldSet('ownerId'),
    }),
    plan('updatedAtBlock', ['ownerId', 'status'], { requiredExactAll: fieldSet('ownerId') }),
  ],
  vaultEvents: [
    plan('timestamp', ['vaultId', 'type', 'timestamp'], { requiredExactAll: fieldSet('vaultId') }),
  ],
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isNullish = (value: unknown): boolean => value === null || value === undefined || value === 'null';

const assertScalar = (value: unknown, label: string): void => {
  if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) {
    throw new Error(`${label} must be a finite scalar value`);
  }
};

const assertNumeric = (value: unknown, label: string): void => {
  if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'string') {
    const match = DECIMAL_PATTERN.exec(String(value));
    if (
      match &&
      match[1]!.length <= MAX_DECIMAL_INTEGER_DIGITS &&
      (match[2]?.length ?? 0) <= MAX_DECIMAL_FRACTION_DIGITS
    ) {
      return;
    }
  }
  throw new Error(`${label} must be a finite decimal value`);
};

const assertNumericFieldValue = (field: string, value: unknown, label: string): void => {
  if (!NATIVE_POSITION_FIELDS.has(field)) {
    assertNumeric(value, label);
    return;
  }
  try {
    assertValidNativePositionQueryValue(field as 'timestamp' | 'blockHeight', value);
  } catch {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
};

const operatorsForKind = (kind: ComparisonKind): ReadonlySet<string> => {
  if (kind === 'numeric') return NUMERIC_OPERATORS;
  if (kind === 'set') return SET_OPERATORS;
  if (kind === 'search') return SEARCH_OPERATORS;
  if (kind === 'contains' || kind === 'structuredContains') return CONTAINS_OPERATORS;
  return IDENTIFIER_OPERATORS;
};

const validateComparisonValue = (
  field: string,
  kind: ComparisonKind,
  operator: string,
  expected: unknown,
  label: string
): void => {
  if (operator === 'contains') {
    if (kind === 'structuredContains') {
      if (!isRecord(expected)) {
        throw new Error(`${label} must be an object containing one supported scalar key`);
      }
      const entries = Object.entries(expected);
      if (
        entries.length !== 1 ||
        !['assetId', 'to'].includes(entries[0]![0]) ||
        typeof entries[0]![1] !== 'string' ||
        entries[0]![1].length === 0 ||
        entries[0]![1].length > 1_024
      ) {
        throw new Error(`${label} must contain exactly one bounded assetId or to string`);
      }
      return;
    }
    const scalarString = typeof expected === 'string' && expected.length > 0 && expected.length <= 1_024;
    const stringSet =
      Array.isArray(expected) &&
      expected.length > 0 &&
      expected.length <= 100 &&
      expected.every((value) => typeof value === 'string' && value.length > 0 && value.length <= 1_024);
    if (!scalarString && !stringSet) {
      throw new Error(`${label} must be a non-empty string or bounded array of non-empty strings`);
    }
    return;
  }

  if (operator === 'in' || operator === 'notIn' || operator === 'not_in') {
    if (!Array.isArray(expected)) throw new Error(`${label} must be a non-empty array`);
    if (expected.length > 100) throw new Error(`${label} must contain at most 100 values`);
    const effective = expected.filter((value) => !isNullish(value));
    if (!effective.length) throw new Error(`${label} must contain at least one non-null value`);
    for (const value of effective) {
      if (kind === 'numeric') assertNumericFieldValue(field, value, label);
      else assertScalar(value, label);
    }
    return;
  }

  if (isNullish(expected)) throw new Error(`${label} must not be null`);
  if (kind === 'numeric') assertNumericFieldValue(field, expected, label);
  else assertScalar(expected, label);
};

const validateFilter = (
  connectionName: PublicConnectionName,
  filter: Record<string, unknown>,
  policy: PublicQueryPolicy
): void => {
  for (const [field, condition] of Object.entries(filter)) {
    if (LOGICAL_FIELDS.has(field)) {
      if (!Array.isArray(condition) || (field === 'or' && condition.length === 0) || !condition.every(isRecord)) {
        throw new Error(`${connectionName} filter ${field} must be a non-empty array of filter objects`);
      }
      for (const nested of condition) validateFilter(connectionName, nested, policy);
      continue;
    }

    const kind = policy.filterFields[field];
    if (!kind) throw new Error(`${connectionName} filter field ${field} is not supported by the public query plan`);

    if (!isRecord(condition)) {
      if (isNullish(condition)) throw new Error(`${connectionName} filter field ${field} must not be null`);
      if (kind === 'numeric') assertNumericFieldValue(field, condition, `${connectionName}.${field}`);
      else assertScalar(condition, `${connectionName}.${field}`);
      continue;
    }

    const comparisons = Object.entries(condition);
    if (!comparisons.length) throw new Error(`${connectionName} filter field ${field} must contain a comparison`);
    const allowedOperators = operatorsForKind(kind);
    for (const [operator, expected] of comparisons) {
      if (!allowedOperators.has(operator)) {
        throw new Error(`${connectionName} filter operator ${field}.${operator} is not supported by the public query plan`);
      }
      validateComparisonValue(field, kind, operator, expected, `${connectionName}.${field}.${operator}`);
    }
  }
};

const filterFields = (filter: Record<string, unknown>): ReadonlySet<string> => {
  const result = new Set<string>();
  const visit = (candidate: Record<string, unknown>): void => {
    for (const [field, condition] of Object.entries(candidate)) {
      if (LOGICAL_FIELDS.has(field)) {
        if (Array.isArray(condition)) {
          for (const nested of condition) if (isRecord(nested)) visit(nested);
        }
      } else {
        result.add(field);
      }
    }
  };
  visit(filter);
  return result;
};

const hasIndexedCondition = (condition: unknown, allowIn: boolean): boolean => {
  if (!isRecord(condition)) return !isNullish(condition);
  if (!isNullish(condition.equalTo) || !isNullish(condition.eq)) return true;
  return allowIn && Array.isArray(condition.in) && condition.in.some((value) => !isNullish(value));
};

/** Finds equality anchors outside OR branches, matching the repository planner. */
const hasConjunctiveField = (
  filter: Record<string, unknown>,
  field: string,
  predicate: (condition: unknown) => boolean = () => true
): boolean => {
  if (field in filter && predicate(filter[field])) return true;
  if (!Array.isArray(filter.and)) return false;
  return filter.and.some((nested) => isRecord(nested) && hasConjunctiveField(nested, field, predicate));
};

/**
 * An OR source is safe only when every branch has an indexed equality. An
 * equality outside the OR anchors the whole expression and wins immediately.
 */
const hasAnchoredSource = (
  filter: Record<string, unknown>,
  candidateFields: ReadonlySet<string>,
  allowIn: boolean
): boolean => {
  for (const field of candidateFields) {
    if (field in filter && hasIndexedCondition(filter[field], allowIn)) return true;
  }

  if (Array.isArray(filter.and)) {
    for (const nested of filter.and) {
      if (isRecord(nested) && hasAnchoredSource(nested, candidateFields, allowIn)) return true;
    }
  }

  if (Array.isArray(filter.or)) {
    return filter.or.every((nested) => isRecord(nested) && hasAnchoredSource(nested, candidateFields, allowIn));
  }

  return false;
};

const RANGE_OPERATORS = new Set([
  'equalTo',
  'eq',
  'greaterThan',
  'gt',
  'greaterThanOrEqualTo',
  'gte',
  'lessThan',
  'lt',
  'lessThanOrEqualTo',
  'lte',
]);

const numericFieldUsesOnlyRangePredicates = (filter: Record<string, unknown>, field: string): boolean => {
  const conditions: unknown[] = [];
  const visit = (candidate: Record<string, unknown>): void => {
    if (field in candidate) conditions.push(candidate[field]);
    for (const logical of LOGICAL_FIELDS) {
      const nested = candidate[logical];
      if (Array.isArray(nested)) for (const item of nested) if (isRecord(item)) visit(item);
    }
  };
  visit(filter);
  return (
    conditions.length > 0 &&
    conditions.every(
      (condition) =>
        !isRecord(condition) ||
        (Object.keys(condition).length > 0 && Object.keys(condition).every((operator) => RANGE_OPERATORS.has(operator)))
    )
  );
};

const numericFieldHasBoundedConjunctiveRange = (filter: Record<string, unknown>, field: string): boolean => {
  let lower = false;
  let upper = false;
  const visit = (candidate: Record<string, unknown>): void => {
    if (field in candidate) {
      const condition = candidate[field];
      if (!isRecord(condition)) {
        if (!isNullish(condition)) {
          lower = true;
          upper = true;
        }
      } else {
        for (const [operator, value] of Object.entries(condition)) {
          if (isNullish(value)) continue;
          if (operator === 'equalTo' || operator === 'eq') {
            lower = true;
            upper = true;
          } else if (['greaterThan', 'gt', 'greaterThanOrEqualTo', 'gte'].includes(operator)) {
            lower = true;
          } else if (['lessThan', 'lt', 'lessThanOrEqualTo', 'lte'].includes(operator)) {
            upper = true;
          }
        }
      }
    }
    if (Array.isArray(candidate.and)) {
      for (const nested of candidate.and) if (isRecord(nested)) visit(nested);
    }
  };
  visit(filter);
  return lower && upper;
};

const exactScalarValue = (condition: unknown): string | number | boolean | null => {
  if (['string', 'number', 'boolean'].includes(typeof condition)) return condition as string | number | boolean;
  if (!isRecord(condition)) return null;
  const value = condition.equalTo ?? condition.eq;
  return ['string', 'number', 'boolean'].includes(typeof value) ? value as string | number | boolean : null;
};

const collectConjunctiveExactValues = (
  filter: Record<string, unknown>,
  values = new Map<string, string | number | boolean>()
): Map<string, string | number | boolean> => {
  for (const [field, condition] of Object.entries(filter)) {
    if (field === 'or') continue;
    if (field === 'and') {
      if (Array.isArray(condition)) {
        for (const nested of condition) if (isRecord(nested)) collectConjunctiveExactValues(nested, values);
      }
      continue;
    }
    const value = exactScalarValue(condition);
    if (value !== null) values.set(field, value);
  }
  return values;
};

const findConjunctiveOrBranches = (filter: Record<string, unknown>): Record<string, unknown>[] | null => {
  if (Array.isArray(filter.or) && filter.or.every(isRecord)) return filter.or;
  if (!Array.isArray(filter.and)) return null;
  for (const nested of filter.and) {
    if (!isRecord(nested)) continue;
    const branches = findConjunctiveOrBranches(nested);
    if (branches) return branches;
  }
  return null;
};

const structuredContainsAnchor = (filter: Record<string, unknown>, field: 'assetId' | 'to'): boolean => {
  const visit = (candidate: Record<string, unknown>): boolean => {
    const data = candidate.data;
    if (isRecord(data) && isRecord(data.contains)) {
      const value = data.contains[field];
      if (typeof value === 'string' && value.length > 0) return true;
    }
    return Array.isArray(candidate.and) && candidate.and.some((nested) => isRecord(nested) && visit(nested));
  };
  return visit(filter);
};

const historySignaturePlanSupported = (filter: Record<string, unknown>): boolean => {
  const common = collectConjunctiveExactValues(filter);
  const branches = findConjunctiveOrBranches(filter) ?? [filter];
  return branches.every((branch) => {
    const values = collectConjunctiveExactValues(branch, new Map(common));
    const module = values.get('module');
    const method = values.get('method');
    const hasAddress = typeof values.get('address') === 'string';
    const hasAssetId = structuredContainsAnchor(filter, 'assetId') || structuredContainsAnchor(branch, 'assetId');
    const hasTo = structuredContainsAnchor(filter, 'to') || structuredContainsAnchor(branch, 'to');

    if (module === 'assets' && method === 'burn') return hasAddress || hasAssetId;
    if (module === 'ethBridge' && method === 'transferToSidechain') return hasAddress;
    if (module === 'bridgeMultisig' && method === 'asMulti') return hasTo;
    if (module === 'liquidityProxy' && method === 'swap') return hasAddress;
    if (module === 'poolXYK' && method === 'depositLiquidity') return hasAddress;
    if (module === 'poolXYK' && method === 'withdrawLiquidity') return hasAddress;
    return false;
  });
};

const GLOBAL_ORDERED_SOURCES: Partial<Record<PublicConnectionName, ReadonlySet<string>>> = {
  accountTrades: fieldSet('timestamp'),
  assetSnapshots: fieldSet('timestamp'),
  networkSnapshots: fieldSet('timestamp'),
  orderBookOrders: fieldSet('timestamp'),
  orderBookSnapshots: fieldSet('timestamp'),
};

const unfilteredOrderAllowed = (connectionName: PublicConnectionName, field: string): boolean =>
  field === 'id' || Boolean(GLOBAL_ORDERED_SOURCES[connectionName]?.has(field));

const planMatches = (
  candidate: PublicFilterPlan,
  orderField: string,
  filter: Record<string, unknown>,
  selectedFields: ReadonlySet<string>
): boolean => {
  if (candidate.orderField !== orderField) return false;
  if ([...selectedFields].some((field) => !candidate.allowedFields.has(field))) return false;
  if (candidate.requiredAll && [...candidate.requiredAll].some((field) => !hasConjunctiveField(filter, field))) {
    return false;
  }
  if (candidate.requiredAny && ![...candidate.requiredAny].some((field) => selectedFields.has(field))) {
    return false;
  }
  if (
    candidate.requiredExactAll &&
    [...candidate.requiredExactAll].some(
      (field) => !hasConjunctiveField(filter, field, (condition) => hasIndexedCondition(condition, false))
    )
  ) {
    return false;
  }
  if (candidate.requiredExactAny && !hasAnchoredSource(filter, candidate.requiredExactAny, false)) return false;
  if (
    candidate.requiredBranchExactAll &&
    [...candidate.requiredBranchExactAll].some(
      (field) => !hasAnchoredSource(filter, fieldSet(field), false)
    )
  ) {
    return false;
  }
  if (
    candidate.requiredIndexedAll &&
    [...candidate.requiredIndexedAll].some((field) => !hasAnchoredSource(filter, fieldSet(field), true))
  ) {
    return false;
  }
  if (
    candidate.requiredRangeFields &&
    [...candidate.requiredRangeFields].some(
      (field) => selectedFields.has(field) && !numericFieldUsesOnlyRangePredicates(filter, field)
    )
  ) {
    return false;
  }
  if (
    candidate.requiredBoundedRangeFields &&
    [...candidate.requiredBoundedRangeFields].some(
      (field) => selectedFields.has(field) && !numericFieldHasBoundedConjunctiveRange(filter, field)
    )
  ) {
    return false;
  }
  return true;
};

export const validatePublicConnectionQuery = (
  connectionName: PublicConnectionName,
  orderBy: unknown,
  filter: Record<string, unknown> | null | undefined
): void => {
  const policy = PUBLIC_QUERY_POLICIES[connectionName];
  if (!policy) throw new Error(`No public query policy is defined for ${connectionName}`);

  const { field } = getOrderField(orderBy);
  const boundedDirectId = Boolean(
    filter &&
      Object.keys(filter).length &&
      hasConjunctiveField(filter, 'id', (condition) => hasIndexedCondition(condition, true))
  );
  if (!policy.orderFields.has(field) && !boundedDirectId) {
    throw new Error(`${connectionName} orderBy field ${field} is not supported by the public query plan`);
  }
  if (!filter || !Object.keys(filter).length) {
    if (unfilteredOrderAllowed(connectionName, field)) return;
    throw new Error(`${connectionName} orderBy field ${field} requires an indexed public filter`);
  }

  validateFilter(connectionName, filter, policy);
  const selectedFields = filterFields(filter);
  if (selectedFields.size === 0) {
    if (unfilteredOrderAllowed(connectionName, field)) return;
    throw new Error(`${connectionName} orderBy field ${field} requires an indexed public filter`);
  }

  // Primary ID equality/IN is a bounded set of direct document reads for any
  // requested output order; residual predicates only reduce that set.
  if (boundedDirectId) return;

  if (
    connectionName === 'historyElements' &&
    field === 'id' &&
    selectedFields.has('blockHeight') &&
    !historySignaturePlanSupported(filter)
  ) {
    throw new Error('historyElements filter does not match a supported indexed operation signature');
  }

  if ((PUBLIC_FILTER_PLANS[connectionName] ?? []).some((candidate) => planMatches(candidate, field, filter, selectedFields))) {
    return;
  }

  throw new Error(`${connectionName} filter/orderBy combination is not backed by a bounded public storage plan`);
};
