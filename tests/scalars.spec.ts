import { parseValue } from 'graphql';
import { describe, expect, it } from 'vitest';

import { CursorScalar, FilterScalars, JSONScalar, OrderByScalar } from '../src/graphql/scalars.js';

describe('GraphQL scalar compatibility', () => {
  it('parses nested JSON literals', () => {
    const literal = parseValue('{ amount: "1.5", count: 2, active: true, values: [LOW, 3.25, null] }');

    expect(JSONScalar.parseLiteral(literal, {})).toEqual({
      active: true,
      amount: '1.5',
      count: 2,
      values: ['LOW', 3.25, null],
    });
  });

  it('parses SubQuery-style filter literals through opaque filter scalars', () => {
    const literal = parseValue('{ or: [{ id: { equalTo: "asset-a" } }, { liquidity: { greaterThan: "0" } }] }');

    expect(FilterScalars.AssetFilter.parseLiteral(literal, {})).toEqual({
      or: [{ id: { equalTo: 'asset-a' } }, { liquidity: { greaterThan: '0' } }],
    });
  });

  it('resolves variables inside opaque filter scalar literals', () => {
    const literal = parseValue(
      '{ and: [{ type: { equalTo: $type } }, { assetId: { equalTo: $id } }, { timestamp: { lessThanOrEqualTo: $from } }] }'
    );

    expect(
      FilterScalars.AssetSnapshotFilter.parseLiteral(literal, {
        type: 'DAY',
        id: 'xor',
        from: null,
      })
    ).toEqual({
      and: [
        { type: { equalTo: 'DAY' } },
        { assetId: { equalTo: 'xor' } },
        { timestamp: { lessThanOrEqualTo: null } },
      ],
    });
  });

  it('round-trips opaque scalar values and null JSON literals', () => {
    const filter = { id: { eq: 'vault-1' } };
    const json = { amount: '10', nested: { ok: true } };

    expect(FilterScalars.VaultFilter.parseValue(filter)).toBe(filter);
    expect(JSONScalar.serialize(json)).toBe(json);
    expect(JSONScalar.parseLiteral(parseValue('null'), {})).toBeNull();
  });

  it('passes cursor and order-by values through unchanged', () => {
    expect(CursorScalar.parseValue('12')).toBe('12');
    expect(OrderByScalar.parseValue(['TIMESTAMP_DESC', 'ID_DESC'])).toEqual(['TIMESTAMP_DESC', 'ID_DESC']);
  });
});
