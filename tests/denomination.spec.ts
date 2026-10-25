import { buildSchema, GraphQLObjectType } from 'graphql';
import { describe, expect, it } from 'vitest';
import { readSnapshotDenominator } from '../src/worker/denomination.js';
import { typeDefs } from '../src/graphql/schema.js';

describe('snapshot denomination evidence', () => {
  it('preserves the cumulative coefficient as an exact decimal string', async () => {
    const value = '100000000000000000000000000000000000001';
    expect(await readSnapshotDenominator({ denomination: { denominator: async () => ({ toString: () => value }) } })).toBe(value);
  });
  it('leaves absent, invalid and pruned historical storage unknown', async () => {
    expect(await readSnapshotDenominator({})).toBeNull();
    for (const value of ['0', '-1', 'NaN', '1e6', '1.5', ' 1']) {
      expect(await readSnapshotDenominator({ denomination: { denominator: async () => ({ toString: () => value }) } })).toBeNull();
    }
    expect(await readSnapshotDenominator({ denomination: { denominator: async () => { throw new Error('pruned'); } } })).toBeNull();
  });
  it('adds a nullable GraphQL field so old snapshots are not falsely normalized', () => {
    const snapshot = buildSchema(typeDefs).getType('AssetSnapshot') as GraphQLObjectType;
    expect(String(snapshot.getFields().denominator?.type)).toBe('String');
  });
});
