import { GraphQLError, GraphQLScalarType, Kind, type ValueNode } from 'graphql';

import { MAX_REPOSITORY_CURSOR_LENGTH } from '../repository/cursor.js';

type ScalarVariables = Record<string, unknown> | null | undefined;

const parseObjectLiteral = (ast: ValueNode, variables?: ScalarVariables): unknown => {
  switch (ast.kind) {
    case Kind.STRING:
    case Kind.ENUM:
    case Kind.BOOLEAN:
      return ast.value;
    case Kind.INT:
      return Number.parseInt(ast.value, 10);
    case Kind.FLOAT:
      return Number.parseFloat(ast.value);
    case Kind.VARIABLE:
      return variables?.[ast.name.value] ?? null;
    case Kind.LIST:
      return ast.values.map((value) => parseObjectLiteral(value, variables));
    case Kind.OBJECT:
      return Object.fromEntries(
        ast.fields.map((field) => [field.name.value, parseObjectLiteral(field.value, variables)])
      );
    case Kind.NULL:
      return null;
    default:
      return null;
  }
};

export const JSONScalar = new GraphQLScalarType({
  name: 'JSON',
  description: 'Arbitrary JSON value.',
  serialize: (value) => value,
  parseValue: (value) => value,
  parseLiteral: parseObjectLiteral,
});

const opaqueScalar = (name: string, description: string) =>
  new GraphQLScalarType({
    name,
    description,
    serialize: (value) => value,
    parseValue: (value) => value,
    parseLiteral: parseObjectLiteral,
  });

const parseCursor = (value: unknown): string => {
  if (typeof value !== 'string') throw new GraphQLError('Cursor must be an opaque string');
  // SubQuery clients use the empty string as their first-page sentinel.
  if (value.length > MAX_REPOSITORY_CURSOR_LENGTH) {
    throw new GraphQLError(`Cursor must contain at most ${MAX_REPOSITORY_CURSOR_LENGTH} characters`);
  }
  return value;
};

export const CursorScalar = new GraphQLScalarType({
  name: 'Cursor',
  description: 'Opaque, connection-scoped keyset pagination cursor.',
  serialize: parseCursor,
  parseValue: parseCursor,
  parseLiteral: (ast) => {
    if (ast.kind !== Kind.STRING) throw new GraphQLError('Cursor literal must be a string');
    return parseCursor(ast.value);
  },
});
export const OrderByScalar = opaqueScalar('OrderBy', 'SubQuery-compatible order-by token.');

export const FilterScalars = {
  AccountFilter: opaqueScalar('AccountFilter', 'Account filter object.'),
  AccountLiquiditySnapshotFilter: opaqueScalar(
    'AccountLiquiditySnapshotFilter',
    'Account liquidity snapshot filter object.'
  ),
  AccountPositionFilter: opaqueScalar('AccountPositionFilter', 'Account position filter object.'),
  AccountTradeFilter: opaqueScalar('AccountTradeFilter', 'Account trade filter object.'),
  AssetFilter: opaqueScalar('AssetFilter', 'Asset filter object.'),
  AssetSnapshotFilter: opaqueScalar('AssetSnapshotFilter', 'Asset snapshot filter object.'),
  HistoryElementFilter: opaqueScalar('HistoryElementFilter', 'History element filter object.'),
  MarketFilter: opaqueScalar('MarketFilter', 'Polkamarkt market filter object.'),
  MarketSnapshotFilter: opaqueScalar('MarketSnapshotFilter', 'Polkamarkt market snapshot filter object.'),
  NetworkSnapshotFilter: opaqueScalar('NetworkSnapshotFilter', 'Network snapshot filter object.'),
  OrderBookFilter: opaqueScalar('OrderBookFilter', 'Order book filter object.'),
  OrderBookOrderFilter: opaqueScalar('OrderBookOrderFilter', 'Order book order filter object.'),
  OrderBookSnapshotFilter: opaqueScalar('OrderBookSnapshotFilter', 'Order book snapshot filter object.'),
  PoolSnapshotFilter: opaqueScalar('PoolSnapshotFilter', 'Pool snapshot filter object.'),
  PoolXYKFilter: opaqueScalar('PoolXYKFilter', 'Pool XYK filter object.'),
  ReferrerRewardFilter: opaqueScalar('ReferrerRewardFilter', 'Referrer reward filter object.'),
  StakingValidatorFilter: opaqueScalar('StakingValidatorFilter', 'Staking validator filter object.'),
  VaultEventFilter: opaqueScalar('VaultEventFilter', 'Vault event filter object.'),
  VaultFilter: opaqueScalar('VaultFilter', 'Vault filter object.'),
  XorBurnFilter: opaqueScalar('XorBurnFilter', 'XOR burn filter object.'),
};
