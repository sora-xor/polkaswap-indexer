import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

import { estimateRetainedValueBytes } from '../src/cache-weight.js';
import { boundGraphQLExecutionResult, measureJsonUtf8Bytes, GRAPHQL_RESULT_TOO_LARGE_CODE } from '../src/graphql/result-size.js';

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

describe('retained binary storage budgets', () => {
  it.each(['typed array', 'data view', 'buffer', 'empty view'])('charges the backing allocation retained by a %s', (kind) => {
    const backing = new ArrayBuffer(16_384);
    const value = kind === 'typed array' ? new Uint8Array(backing, 1, 1)
      : kind === 'data view' ? new DataView(backing, 1, 1)
      : kind === 'buffer' ? Buffer.from(backing, 1, 1) : new Uint8Array(backing, 1, 0);
    expect(estimateRetainedValueBytes(value, 1_024)).toBe(1_025);
    expect(estimateRetainedValueBytes(value, 100_000)).toBeGreaterThanOrEqual(backing.byteLength);
  });

  it('counts a shared backing store once across views and a direct reference in either order', () => {
    const backing = new ArrayBuffer(16_384);
    const first = new Uint8Array(backing);
    const second = new DataView(backing);
    for (const values of [[backing, first, second], [first, second, backing]]) {
      const estimate = estimateRetainedValueBytes(values, 100_000);
      expect(estimate).toBeGreaterThan(backing.byteLength);
      expect(estimate).toBeLessThan(backing.byteLength * 2);
    }
  });

  it.each(['new SharedArrayBuffer(16384)', 'new ArrayBuffer(16384)'])('charges standalone cross-realm %s', (expression) => {
    const backing: unknown = runInNewContext(expression);
    expect(estimateRetainedValueBytes(backing, 1_024)).toBe(1_025);
  });

  it('does not inspect later properties after a binary allocation exhausts the budget', () => {
    const tail = vi.fn(() => { throw new Error('unreachable tail'); });
    const value = { first: new Uint8Array(new ArrayBuffer(16_384), 0, 1) };
    Object.defineProperty(value, 'tail', { enumerable: true, get: tail });
    expect(estimateRetainedValueBytes(value, 1_024)).toBe(1_025);
    expect(tail).not.toHaveBeenCalled();
  });

  it.each(['typed array', 'data view'])('ignores an own buffer property masking the allocation of a %s', (kind) => {
    const backing = new ArrayBuffer(16_384);
    const view = kind === 'typed array' ? new Uint8Array(backing, 0, 1) : new DataView(backing, 0, 1);
    Object.defineProperty(view, 'buffer', { value: new ArrayBuffer(0) });
    expect(estimateRetainedValueBytes(view, 1_024)).toBe(1_025);
  });

  it.each(['array', 'shared'])('ignores an own byteLength property masking an %s buffer allocation', (kind) => {
    const backing = kind === 'array' ? new ArrayBuffer(16_384) : new SharedArrayBuffer(16_384);
    Object.defineProperty(backing, 'byteLength', { value: 0 });
    expect(estimateRetainedValueBytes(backing, 1_024)).toBe(1_025);
  });

  it('never executes custom getters in place of intrinsic binary accessors', () => {
    const getter = vi.fn(() => { throw new Error('custom accessor'); });
    const backing = new ArrayBuffer(16_384);
    const view = new Uint8Array(backing, 0, 1);
    Object.defineProperty(backing, 'byteLength', { get: getter });
    Object.defineProperty(view, 'buffer', { get: getter });
    expect(estimateRetainedValueBytes(view, 1_024)).toBe(1_025);
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('JSON serialization compatibility at response limits', () => {
  it('counts function toJSON output and passes the property key just like JSON.stringify', () => {
    const toJSON = vi.fn((key: string) => `${key}:` + '界'.repeat(30));
    const callable = Object.assign(() => undefined, { toJSON });
    const result = { data: { callable } };
    const expected = jsonBytes(result);
    toJSON.mockClear();
    expect(measureJsonUtf8Bytes(result, expected)).toBe(expected);
    expect(toJSON).toHaveBeenCalledExactlyOnceWith('callable');
    expect(boundGraphQLExecutionResult(result, expected - 1).errors?.[0]?.extensions?.code)
      .toBe(GRAPHQL_RESULT_TOO_LARGE_CODE);
  });

  it.each(['new Number(123456789)', 'new String("界😀")', 'new Boolean(false)'])('unboxes cross-realm %s exactly', (expression) => {
    const result = { data: { boxed: runInNewContext(expression) } };
    const expected = jsonBytes(result);
    expect(measureJsonUtf8Bytes(result, expected)).toBe(expected);
    expect(measureJsonUtf8Bytes(result, expected - 1)).toBe(expected);
  });

  it('honors number and string conversion hooks used by JSON.stringify', () => {
    const number = Object.assign(new Number(1), { [Symbol.toPrimitive]: () => 123456789 });
    const string = Object.assign(new String('a'), { toString: () => '界😀' });
    const value = { data: { number, string } };
    expect(measureJsonUtf8Bytes(value, 10_000)).toBe(jsonBytes(value));
  });

  it('reads boxed booleans from their internal value rather than an overridden valueOf', () => {
    const value = { data: { flag: Object.assign(new Boolean(false), { valueOf: () => true }) } };
    expect(measureJsonUtf8Bytes(value, 10_000)).toBe(jsonBytes(value));
  });

  it.each(['Object(1n)', 'Object.setPrototypeOf(Object(1n), null)'])('rejects nonserializable cross-realm bigint boxes: %s', (expression) => {
    const value = { data: { invalid: runInNewContext(expression) } };
    expect(() => JSON.stringify(value)).toThrow(TypeError);
    expect(() => measureJsonUtf8Bytes(value, 10_000)).toThrow(TypeError);
  });

  it('matches JSON errors when a boxed number converts to a bigint', () => {
    const value = { data: { invalid: Object.assign(new Number(1), { [Symbol.toPrimitive]: () => 1n }) } };
    expect(() => JSON.stringify(value)).toThrow(TypeError);
    expect(() => measureJsonUtf8Bytes(value, 10_000)).toThrow(TypeError);
  });

  it('does not mistake objects with a boxed primitive prototype for primitive wrappers', () => {
    for (const prototype of [Number.prototype, String.prototype, Boolean.prototype, BigInt.prototype]) {
      const value = { data: { plain: Object.assign(Object.create(prototype), { property: 'present' }) } };
      expect(measureJsonUtf8Bytes(value, 10_000)).toBe(jsonBytes(value));
    }
  });
});
