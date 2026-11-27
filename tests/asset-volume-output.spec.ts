import { graphql, type GraphQLObjectType, type GraphQLResolveInfo } from 'graphql';
import { describe, expect, it } from 'vitest';

import { createSchema } from '../src/graphql/resolvers.js';
import { MemoryRepository } from '../src/repository/memory.js';

describe('deployed Asset volume Float output compatibility', () => {
  it('serializes numeric and decimal-string documents to numeric GraphQL wire values', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([
      { collection: 'assets', id: 'numeric', data: { id: 'numeric', volumeDayUSD: 12.5, volumeWeekUSD: 0.125 } },
      { collection: 'assets', id: 'string', data: { id: 'string', volumeDayUSD: '45.125', volumeWeekUSD: '0.0000001' } },
      { collection: 'assets', id: 'unset', data: { id: 'unset', volumeDayUSD: null } },
    ]);
    const schema = createSchema();
    const fields = (schema.getType('Asset') as GraphQLObjectType).getFields();
    expect(String(fields.volumeDayUSD?.type)).toBe('Float');
    expect(String(fields.volumeWeekUSD?.type)).toBe('Float');

    const result = await graphql({
      schema,
      source: '{ assets(first: 3, orderBy: [ID_ASC]) { nodes { id volumeDayUSD volumeWeekUSD } } }',
      contextValue: { repository },
    });
    expect(result.errors).toBeUndefined();
    // Round-trip through JSON to verify the actual response scalar types.
    expect(JSON.parse(JSON.stringify(result.data))).toEqual({
      assets: { nodes: [
        { id: 'numeric', volumeDayUSD: 12.5, volumeWeekUSD: 0.125 },
        { id: 'string', volumeDayUSD: 45.125, volumeWeekUSD: 0.0000001 },
        { id: 'unset', volumeDayUSD: null, volumeWeekUSD: null },
      ] },
    });
    expect((await repository.get('assets', 'numeric'))?.data.volumeDayUSD).toBe(12.5);
    expect((await repository.get('assets', 'string'))?.data.volumeDayUSD).toBe('45.125');
  });

  it('preserves exact internal decimal strings while the Float API serializes them', async () => {
    const repository = new MemoryRepository();
    const volumeDayUSD = '999999999999999999999.123456789';
    const volumeWeekUSD = '0.000000000000000000123456789';
    await repository.upsert({ collection: 'assets', id: 'precise', data: { id: 'precise', volumeDayUSD, volumeWeekUSD } });
    const before = await repository.get('assets', 'precise');
    const schema = createSchema();
    const fields = (schema.getType('Asset') as GraphQLObjectType).getFields();
    for (const [field, expected] of Object.entries({ volumeDayUSD, volumeWeekUSD })) {
      expect(fields[field]?.resolve?.(before?.data, {}, { repository }, {} as GraphQLResolveInfo)).toBe(expected);
    }

    const result = await graphql({
      schema,
      source: '{ assets(first: 1, filter: { id: { equalTo: "precise" } }) { nodes { id volumeDayUSD volumeWeekUSD } } }',
      contextValue: { repository },
    });
    expect(result.errors).toBeUndefined();
    expect(JSON.parse(JSON.stringify(result.data))).toEqual({
      assets: { nodes: [{ id: 'precise', volumeDayUSD: Number(volumeDayUSD), volumeWeekUSD: Number(volumeWeekUSD) }] },
    });
    expect(await repository.get('assets', 'precise')).toEqual(before);
    expect((await repository.get('assets', 'precise'))?.data).toEqual({ id: 'precise', volumeDayUSD, volumeWeekUSD });
  });
});
