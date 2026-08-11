import { buildSchema, parse, specifiedRules, validate } from 'graphql';
import { describe, expect, it } from 'vitest';

import {
  createGraphQLQueryLimitsRule,
  type GraphQLQueryLimits,
} from '../src/graphql/validation.js';

const schema = buildSchema(/* GraphQL */ `
  type Query {
    asset: Asset
    assets(first: Int): AssetConnection!
    exploreStats: ExpensiveResult!
    networkAccountActivity(from: Int!, to: Int!): ExpensiveResult!
    polkamarktSignals: ExpensiveResult!
  }

  type ExpensiveResult {
    value: Int!
  }

  type AssetConnection {
    nodes: [Asset!]!
    totalCount: Int!
  }

  type Asset {
    id: ID!
    symbol: String
    related(first: Int): AssetConnection!
  }
`);

const permissiveLimits: GraphQLQueryLimits = {
  maxDepth: 20,
  maxDocumentNodes: 10_000,
  maxFields: 1_000,
  maxAliases: 100,
  maxFragmentSpreads: 100,
  maxOperationCost: 1_000_000,
  allowIntrospection: false,
};

const errorsFor = (source: string, overrides: Partial<GraphQLQueryLimits> = {}) =>
  validate(schema, parse(source), [
    ...specifiedRules,
    createGraphQLQueryLimitsRule({ ...permissiveLimits, ...overrides }),
  ]);

describe('GraphQL query resource validation', () => {
  it('accepts a normal bounded connection query', () => {
    expect(errorsFor('{ assets(first: 10) { nodes { id symbol } totalCount } }')).toEqual([]);
  });

  it('rejects excessive direct field depth', () => {
    const errors = errorsFor('{ asset { related(first: 1) { nodes { related(first: 1) { nodes { id } } } } } }', {
      maxDepth: 5,
    });
    expect(errors.map((error) => error.message)).toContainEqual(expect.stringContaining('has depth'));
  });

  it('counts depth hidden behind fragment spreads', () => {
    const errors = errorsFor(
      `
        query { asset { ...LevelOne } }
        fragment LevelOne on Asset { related(first: 1) { nodes { ...LevelTwo } } }
        fragment LevelTwo on Asset { related(first: 1) { nodes { id } } }
      `,
      { maxDepth: 5 }
    );
    expect(errors.map((error) => error.message)).toContainEqual(expect.stringContaining('has depth'));
  });

  it('handles cyclic fragments without recursive overflow and rejects the cycle', () => {
    const errors = errorsFor(`
      query { asset { ...A } }
      fragment A on Asset { id ...B }
      fragment B on Asset { symbol ...A }
    `);
    expect(errors.map((error) => error.message)).toContainEqual(expect.stringContaining('Cannot spread fragment'));
  });

  it('rejects alias amplification', () => {
    const aliases = Array.from({ length: 6 }, (_, index) => `a${index}: asset { id }`).join('\n');
    const errors = errorsFor(`query { ${aliases} }`, { maxAliases: 5 });
    expect(errors.map((error) => error.message)).toContainEqual(expect.stringContaining('6 aliases'));
  });

  it('charges expensive root resolvers enough to reject alias amplification', () => {
    expect(errorsFor('{ networkAccountActivity(from: 1, to: 2) { value } }', { maxOperationCost: 100_000 })).toEqual(
      []
    );

    const activityAliases = Array.from(
      { length: 2 },
      (_, index) => `a${index}: networkAccountActivity(from: ${index}, to: ${index + 1}) { value }`
    ).join('\n');
    expect(
      errorsFor(`query { ${activityAliases} }`, { maxOperationCost: 100_000 }).map((error) => error.message)
    ).toContainEqual(expect.stringContaining('estimated cost'));

    expect(
      errorsFor(
        'query { first: polkamarktSignals { value } second: polkamarktSignals { value } }',
        { maxOperationCost: 100_000 }
      ).map((error) => error.message)
    ).toContainEqual(expect.stringContaining('estimated cost'));
  });

  it('rejects excessive total AST nodes even when field depth is shallow', () => {
    const fields = Array.from({ length: 30 }, (_, index) => `a${index}: asset { id }`).join('\n');
    const errors = errorsFor(`query { ${fields} }`, {
      maxAliases: 100,
      maxDocumentNodes: 40,
    });
    expect(errors.map((error) => error.message)).toContainEqual(expect.stringContaining('AST nodes'));
  });

  it('rejects excessive fragment-spread syntax', () => {
    const spreads = Array.from({ length: 6 }, () => '...AssetId').join('\n');
    const errors = errorsFor(
      `query { asset { ${spreads} } } fragment AssetId on Asset { id }`,
      { maxFragmentSpreads: 5 }
    );
    expect(errors.map((error) => error.message)).toContainEqual(expect.stringContaining('6 fragment spreads'));
  });

  it('counts fields expanded repeatedly through fragments', () => {
    const spreads = Array.from({ length: 8 }, () => '...AssetFields').join('\n');
    const errors = errorsFor(
      `query { asset { ${spreads} } } fragment AssetFields on Asset { id symbol }`,
      { maxFields: 10 }
    );
    expect(errors.map((error) => error.message)).toContainEqual(expect.stringContaining('expands to'));
  });

  it('rejects a huge literal connection page through estimated cost', () => {
    const errors = errorsFor('{ assets(first: 1000000000) { nodes { id } } }', {
      maxOperationCost: 10_000,
    });
    expect(errors.map((error) => error.message)).toContainEqual(expect.stringContaining('estimated cost'));
  });

  it('multiplies nested connection costs instead of adding page sizes', () => {
    const errors = errorsFor(
      '{ assets(first: 100) { nodes { related(first: 100) { nodes { id symbol } } } } }',
      { maxOperationCost: 25_000 }
    );
    expect(errors.map((error) => error.message)).toContainEqual(expect.stringContaining('estimated cost'));
  });

  it('charges variable connection page sizes at the API maximum', () => {
    const errors = errorsFor('query Assets($first: Int) { assets(first: $first) { nodes { id } } }', {
      maxOperationCost: 1_500,
    });
    expect(errors.map((error) => error.message)).toContainEqual(expect.stringContaining('estimated cost'));
  });

  it('does not allow repeated unaliased fields to evade the expanded field limit', () => {
    const fields = Array.from({ length: 20 }, () => 'id').join('\n');
    const errors = errorsFor(`query { asset { ${fields} } }`, { maxFields: 10 });
    expect(errors.map((error) => error.message)).toContainEqual(expect.stringContaining('expands to'));
  });

  it('blocks schema introspection while retaining __typename for normal clients', () => {
    expect(errorsFor('{ asset { __typename id } }')).toEqual([]);
    expect(errorsFor('{ __schema { queryType { name } } }').map((error) => error.message)).toContain(
      'GraphQL schema introspection is disabled.'
    );
    expect(errorsFor('{ __type(name: "Asset") { name } }').map((error) => error.message)).toContain(
      'GraphQL schema introspection is disabled.'
    );
  });

  it('allows introspection only when explicitly configured', () => {
    expect(errorsFor('{ __schema { queryType { name } } }', { allowIntrospection: true })).toEqual([]);
  });

  it('saturates adversarial fragment DAG cost without exponential traversal', () => {
    const fragments = ['fragment F0 on Asset { id }'];
    for (let index = 1; index < 30; index += 1) {
      fragments.push(`fragment F${index} on Asset { ...F${index - 1} ...F${index - 1} }`);
    }
    const errors = errorsFor(`query { asset { ...F29 } } ${fragments.join('\n')}`, {
      maxFields: 100,
      maxOperationCost: 100,
      maxFragmentSpreads: 100,
    });
    expect(errors.map((error) => error.message)).toContainEqual(expect.stringContaining('estimated cost'));
  });
});
