import { GraphQLScalarType, Kind, type ValueNode } from 'graphql';

const parseObjectLiteral = (ast: ValueNode): unknown => {
  switch (ast.kind) {
    case Kind.STRING:
    case Kind.ENUM:
    case Kind.BOOLEAN:
      return ast.value;
    case Kind.INT:
      return Number.parseInt(ast.value, 10);
    case Kind.FLOAT:
      return Number.parseFloat(ast.value);
    case Kind.LIST:
      return ast.values.map(parseObjectLiteral);
    case Kind.OBJECT:
      return Object.fromEntries(ast.fields.map((field) => [field.name.value, parseObjectLiteral(field.value)]));
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

export const CursorScalar = opaqueScalar('Cursor', 'Opaque pagination cursor.');
export const OrderByScalar = opaqueScalar('OrderBy', 'SubQuery-compatible order-by token.');

export const FilterScalars = {
  AccountFilter: opaqueScalar('AccountFilter', 'Account filter object.'),
  AccountLiquiditySnapshotFilter: opaqueScalar(
    'AccountLiquiditySnapshotFilter',
    'Account liquidity snapshot filter object.'
  ),
  AssetFilter: opaqueScalar('AssetFilter', 'Asset filter object.'),
  AssetSnapshotFilter: opaqueScalar('AssetSnapshotFilter', 'Asset snapshot filter object.'),
  HistoryElementFilter: opaqueScalar('HistoryElementFilter', 'History element filter object.'),
  NetworkSnapshotFilter: opaqueScalar('NetworkSnapshotFilter', 'Network snapshot filter object.'),
  OrderBookFilter: opaqueScalar('OrderBookFilter', 'Order book filter object.'),
  OrderBookOrderFilter: opaqueScalar('OrderBookOrderFilter', 'Order book order filter object.'),
  OrderBookSnapshotFilter: opaqueScalar('OrderBookSnapshotFilter', 'Order book snapshot filter object.'),
  PoolSnapshotFilter: opaqueScalar('PoolSnapshotFilter', 'Pool snapshot filter object.'),
  PoolXYKFilter: opaqueScalar('PoolXYKFilter', 'Pool XYK filter object.'),
  ReferrerRewardFilter: opaqueScalar('ReferrerRewardFilter', 'Referrer reward filter object.'),
  VaultEventFilter: opaqueScalar('VaultEventFilter', 'Vault event filter object.'),
  VaultFilter: opaqueScalar('VaultFilter', 'Vault filter object.'),
};
