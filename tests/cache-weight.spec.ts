import { describe, expect, it, vi } from 'vitest';

import { estimateRetainedValueBytes } from '../src/cache-weight.js';

describe('bounded retained-value estimation', () => {
  it('counts cycles, maps, sets, and binary views without recursion or double-counting', () => {
    const cyclic: Record<string, unknown> = { text: 'hello', bytes: new Uint8Array(32) };
    cyclic.self = cyclic;
    cyclic.map = new Map([['same', cyclic]]);
    cyclic.set = new Set([cyclic]);

    const estimate = estimateRetainedValueBytes(cyclic, 1_000_000);
    expect(estimate).toBeGreaterThan(32);
    expect(estimate).toBeLessThan(1_000_000);
  });

  it('stops traversal immediately after the budget and never evaluates a hostile tail', () => {
    const tail = vi.fn(() => {
      throw new Error('tail must not be visited');
    });
    const values: unknown[] = ['x'.repeat(2_000), undefined];
    Object.defineProperty(values, 1, { enumerable: true, configurable: true, get: tail });

    expect(estimateRetainedValueBytes(values, 1_000)).toBe(1_001);
    expect(tail).not.toHaveBeenCalled();
  });

  it('does not trust a user JSON encodedLength field as the object size', () => {
    const document = { encodedLength: 1, payload: 'x'.repeat(10_000) };
    expect(estimateRetainedValueBytes(document, 2_000)).toBe(2_001);
  });

  it('uses codec encodedLength without invoking an allocating encoder', () => {
    class CodecLike {
      encodedLength = 256;
      toU8a = vi.fn(() => {
        throw new Error('must not allocate an encoded copy');
      });
    }
    const codec = new CodecLike();

    expect(estimateRetainedValueBytes(codec, 10_000)).toBeGreaterThanOrEqual(1_024);
    expect(codec.toU8a).not.toHaveBeenCalled();
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid byte budget %s',
    (maximumBytes) => {
      expect(() => estimateRetainedValueBytes({}, maximumBytes)).toThrow(/byte budget/);
    }
  );
});
