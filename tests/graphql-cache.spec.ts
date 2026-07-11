import { describe, expect, it, vi } from 'vitest';

import { TtlCache } from '../src/graphql/resolvers.js';

describe('GraphQL retained cache bounds', () => {
  it('does not retain an oversized cache key', async () => {
    const cache = new TtlCache({ maxEntries: 10, maxBytes: 256, ttlMs: 10_000 });
    const load = vi.fn(async () => ({ ok: true }));
    const key = 'k'.repeat(1_000);

    await cache.getOrSet('test', key, load);
    await cache.getOrSet('test', key, load);

    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.size()).toBe(0);
  });

  it('accounts for retained key and entry overhead together with the value', async () => {
    const cache = new TtlCache({ maxEntries: 10, maxBytes: 1_024, ttlMs: 10_000 });
    const load = vi.fn(async () => ({ text: 'v'.repeat(1_000) }));

    await cache.getOrSet('test', 'bounded-key', load);
    await cache.getOrSet('test', 'bounded-key', load);

    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.size()).toBe(0);
  });
});
