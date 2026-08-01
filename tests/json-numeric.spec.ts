import { describe, expect, it } from 'vitest';

import {
  assertExactlyRepresentableJsonNumber,
  assertExactlyRepresentableJsonNumbers,
  parseExactJsonObject,
} from '../src/repository/json-numeric.js';

describe('cross-engine JSON numeric domain', () => {
  it.each([
    '0',
    '-0',
    '9007199254740991',
    '-9007199254740991',
    '1.2300',
    '-0.125',
    '1.2e-3',
    '12e-1',
    '5e-324',
  ])('accepts an exact JSON number %s', (token) => {
    expect(() => assertExactlyRepresentableJsonNumber(token)).not.toThrow();
  });

  it.each([
    '9007199254740992',
    '-9007199254740992',
    '9.007199254740992e15',
    '9007199254740991.1',
    '0.1234567890123456789',
    '1.0000000000000001',
    '4e-324',
    '1.7976931348623157e308',
    '1e309',
    '1e-999999999',
    '0e9999999999',
    '1e000000000000000000000000000000001',
    `0.${'0'.repeat(1_025)}1`,
  ])('rejects a lossy, unsafe, or unbounded JSON number %s', (token) => {
    expect(() => assertExactlyRepresentableJsonNumber(token)).toThrow(/cannot be represented exactly/);
  });

  it('validates deeply nested arrays and objects but ignores number-like string contents', () => {
    const nested = JSON.stringify({
      text: '9007199254740992 and 0.1234567890123456789',
      escaped: 'quote: " 999999999999999999999',
      values: [{ next: [{ exact: 1.25 }] }],
    });
    expect(() => assertExactlyRepresentableJsonNumbers(nested)).not.toThrow();

    const unsafe = '{"text":"9007199254740992","values":[{"next":[{"unsafe":9007199254740992}]}]}';
    expect(() => assertExactlyRepresentableJsonNumbers(unsafe)).toThrow(/9007199254740992/);
  });

  it('bounds adversarial leading-zero exponents before normalization', () => {
    const exponent = `1e${'0'.repeat(100_000)}1`;
    expect(() => assertExactlyRepresentableJsonNumbers(`{"value":${exponent}}`)).toThrow(
      /cannot be represented exactly/
    );
  });

  it.each([
    '{"value":01}',
    '{"value":1x}',
    '{"value":-}',
    '{"value":1.}',
    '{"value":1e}',
  ])('rejects malformed numeric JSON %s', (json) => {
    expect(() => parseExactJsonObject(json)).toThrow(/malformed JSON|numeric syntax/);
  });

  it('requires the top-level value to be an object', () => {
    expect(() => parseExactJsonObject('[1,2,3]')).toThrow(/must be a JSON object/);
    expect(() => parseExactJsonObject('null')).toThrow(/must be a JSON object/);
  });
});
