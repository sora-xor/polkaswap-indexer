import { describe, expect, it } from 'vitest';

import { AbuseLimiter } from '../src/http/abuseLimiter.js';

describe('bounded HTTP limiter', () => {
  it('never exceeds its identity cap and does not evict active clients', () => {
    const limiter = new AbuseLimiter({ windowMs: 1_000, max: 2, maxKeys: 2, globalWindowMs: 1_000, globalMax: 100 });
    expect(limiter.check('a', 1).allowed).toBe(true);
    expect(limiter.check('b', 1).allowed).toBe(true);
    expect(limiter.check('c', 1).scope).toBe('capacity');
    expect(limiter.trackedKeyCount).toBe(2);
    expect(limiter.check('a', 2).allowed).toBe(true);
    expect(limiter.trackedKeyCount).toBe(2);
  });

  it('uses a global bucket against rotating identities', () => {
    const limiter = new AbuseLimiter({ windowMs: 1_000, max: 100, maxKeys: 10, globalWindowMs: 1_000, globalMax: 2 });
    expect(limiter.check('a', 1).allowed).toBe(true);
    expect(limiter.check('b', 1).allowed).toBe(true);
    expect(limiter.check('c', 1).scope).toBe('global');
    expect(limiter.trackedKeyCount).toBe(2);
  });
});
