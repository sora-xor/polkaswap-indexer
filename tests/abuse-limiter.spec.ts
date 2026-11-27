import { describe, expect, it } from 'vitest';

import { AbuseLimiter } from '../src/http/abuseLimiter.js';

const options = {
  windowMs: 1_000, max: 2, maxKeys: 2, globalWindowMs: 10_000, globalMax: 100,
};

describe('HTTP limiter window boundaries', () => {
  it('resets client quota exactly at expiry and isolates client counts', () => {
    const limiter = new AbuseLimiter(options);
    expect(limiter.check('a', 100)).toMatchObject({ allowed: true, remaining: 1, resetAt: 1_100 });
    expect(limiter.check('a', 101)).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.check('a', 1_099)).toMatchObject({ allowed: false, scope: 'client', resetAt: 1_100 });
    expect(limiter.check('b', 1_099)).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.check('a', 1_100)).toMatchObject({ allowed: true, remaining: 1, resetAt: 2_100 });
  });

  it('reclaims expired identities at capacity immediately after a rejected request', () => {
    const limiter = new AbuseLimiter({ ...options, maxKeys: 1 });
    expect(limiter.check('expired', 100).allowed).toBe(true);
    // A cleanup just before expiry must not defer the next client's admission.
    expect(limiter.check('new', 1_099)).toMatchObject({ allowed: false, scope: 'capacity' });
    expect(limiter.check('new', 1_100)).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.trackedKeyCount).toBe(1);
  });

  it('reclaims only expired identities without resetting active clients', () => {
    const limiter = new AbuseLimiter(options);
    limiter.check('expired', 100);
    limiter.check('active', 500);
    limiter.check('active', 501);
    expect(limiter.check('new', 1_099).scope).toBe('capacity');
    expect(limiter.check('new', 1_100).allowed).toBe(true);
    expect(limiter.check('active', 1_101)).toMatchObject({ allowed: false, scope: 'client', resetAt: 1_500 });
    expect(limiter.trackedKeyCount).toBe(2);
  });

  it('counts client and capacity rejections toward the global backstop', () => {
    const limiter = new AbuseLimiter({ ...options, max: 1, maxKeys: 1, globalMax: 3 });
    expect(limiter.check('a', 100).allowed).toBe(true);
    expect(limiter.check('a', 101).scope).toBe('client');
    expect(limiter.check('b', 102).scope).toBe('capacity');
    expect(limiter.check('c', 103)).toMatchObject({ allowed: false, scope: 'global', resetAt: 10_100 });
    expect(limiter.trackedKeyCount).toBe(1);
    expect(limiter.check('c', 10_100)).toMatchObject({ allowed: true, remaining: 0 });
  });

  it('does not reset a client window when the shorter global window expires', () => {
    const limiter = new AbuseLimiter({ ...options, windowMs: 10_000, globalWindowMs: 1_000, globalMax: 2 });
    limiter.check('a', 100);
    limiter.check('a', 101);
    expect(limiter.check('b', 1_099)).toMatchObject({ allowed: false, scope: 'global' });
    expect(limiter.check('a', 1_100)).toMatchObject({ allowed: false, scope: 'client', resetAt: 10_100 });
    expect(limiter.check('b', 1_101).allowed).toBe(true);
  });

  it('expires clients in timestamp order after the wall clock moves backward', () => {
    const limiter = new AbuseLimiter({ ...options, maxKeys: 4 });
    // Deliberately insert out of expiry order, including two identical deadlines.
    for (const [client, now] of [['a', 500], ['b', 100], ['c', 300], ['d', 100]] as const) {
      expect(limiter.check(client, now).allowed).toBe(true);
    }
    expect(limiter.check('e', 1_099).scope).toBe('capacity');
    expect(limiter.check('e', 1_100).allowed).toBe(true);
    expect(limiter.trackedKeyCount).toBe(3);
    expect(limiter.check('a', 1_100)).toMatchObject({ remaining: 0, resetAt: 1_500 });
    expect(limiter.check('f', 1_300).allowed).toBe(true);
    expect(limiter.trackedKeyCount).toBe(3);
    expect(limiter.check('g', 1_500).allowed).toBe(true);
    expect(limiter.trackedKeyCount).toBe(3);
  });

  it('reclaims staggered identities across repeated full-capacity windows', () => {
    const capacity = 128;
    const limiter = new AbuseLimiter({ ...options, maxKeys: capacity, globalMax: 100_000 });
    for (let round = 0; round < 3; round += 1) {
      for (let index = 0; index < capacity; index += 1) {
        const now = 100 + round * options.windowMs + index;
        expect(limiter.check(`client-${round}-${index}`, now).allowed).toBe(true);
        expect(limiter.trackedKeyCount).toBe(round === 0 ? index + 1 : capacity);
      }
    }
    expect(limiter.check('after-idle', 10_000).allowed).toBe(true);
    expect(limiter.trackedKeyCount).toBe(1);
  });

  it('reclaims a full set of clients inserted in reverse deadline order', () => {
    const capacity = 128;
    const limiter = new AbuseLimiter({ ...options, maxKeys: capacity, globalMax: 100_000 });
    for (let index = capacity; index > 0; index -= 1) {
      expect(limiter.check(`old-${index}`, index).allowed).toBe(true);
    }
    for (let index = 1; index <= capacity; index += 1) {
      expect(limiter.check(`new-${index}`, options.windowMs + index).allowed).toBe(true);
      expect(limiter.trackedKeyCount).toBe(capacity);
    }
  });
});
