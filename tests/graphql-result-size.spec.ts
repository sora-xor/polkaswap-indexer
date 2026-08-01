import { describe, expect, it } from 'vitest';

import {
  boundGraphQLExecutionResult,
  GRAPHQL_RESULT_NOT_SERIALIZABLE_CODE,
  GRAPHQL_RESULT_TOO_LARGE_CODE,
  measureJsonUtf8Bytes,
} from '../src/graphql/result-size.js';

describe('GraphQL result byte bounds', () => {
  it.each([
    { data: { text: 'plain ASCII' } },
    { data: { text: '\u0000\b\t\n\f\r"\\' } },
    { data: { text: 'مرحبا 世界 😀' } },
    { data: { text: '\ud800 lone \udc00 and pair \ud83d\ude00' } },
    { data: { values: [undefined, Number.NaN, Number.POSITIVE_INFINITY, -0, true, null] } },
    (() => {
      const values = new Array(2);
      values[1] = 'present';
      return { data: { omitted: undefined, values } };
    })(),
    { data: { value: { toJSON: () => ({ encoded: 'yes' }) } } },
    (() => {
      const shared = { value: 'twice' };
      return { data: { left: shared, right: shared } };
    })(),
  ])('matches JSON.stringify UTF-8 bytes exactly', (value) => {
    const encoded = JSON.stringify(value);
    expect(measureJsonUtf8Bytes(value, 1_000_000)).toBe(Buffer.byteLength(encoded, 'utf8'));
  });

  it('fails closed for cycles and primitive or boxed BigInt values', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => measureJsonUtf8Bytes(cyclic, 1_000)).toThrow(/circular/i);
    expect(() => measureJsonUtf8Bytes({ data: 1n }, 1_000)).toThrow(/BigInt/);
    expect(() => measureJsonUtf8Bytes({ data: Object(1n) }, 1_000)).toThrow(/BigInt/);

    expect(boundGraphQLExecutionResult({ data: cyclic }, 1_000).errors?.[0]?.extensions?.code).toBe(
      GRAPHQL_RESULT_NOT_SERIALIZABLE_CODE
    );
  });

  it('counts JSON escaping before transport serialization and exits at the cap', () => {
    const result = { data: { text: '\u0000'.repeat(1_000) } };
    expect(measureJsonUtf8Bytes(result, 1_000)).toBe(1_001);
    expect(boundGraphQLExecutionResult(result, 1_000).errors?.[0]?.extensions?.code).toBe(
      GRAPHQL_RESULT_TOO_LARGE_CODE
    );
  });
});
