import { afterEach, describe, expect, it, vi } from 'vitest';

import { TtlCache } from '../src/graphql/resolvers.js';
afterEach(() => vi.useRealTimers());
const deferred = () => { let resolve!: (value: string) => void; const promise = new Promise<string>(yes => { resolve = yes; }); return { promise, resolve }; };

describe('GraphQL cache concurrent capacity admission', () => {
  it.each([{ ttlMs: 0 }, { maxEntries: 0 }, { maxBytes: 0 }])('bypasses caching when capacity is disabled by %j', patch => {
    const cache = new TtlCache({ ttlMs: 1000, maxEntries: 10, maxBytes: 1024, ...patch });
    const load = vi.fn(async () => 'value');
    return Promise.all([cache.getOrSet('test', 'a', load), cache.getOrSet('test', 'a', load)]).then(values => {
      expect(values).toEqual(['value', 'value']); expect(load).toHaveBeenCalledTimes(2); expect(cache.size()).toBe(0);
    });
  });
  it('coalesces a pending key but bypasses a new key at the entry limit', async () => {
    const cache = new TtlCache({ ttlMs: 1000, maxEntries: 1, maxBytes: 1024 }), pending = deferred();
    const load = vi.fn(() => pending.promise), a = cache.getOrSet('test', 'a', load), again = cache.getOrSet('test', 'a', load);
    expect(await cache.getOrSet('test', 'b', async () => 'b')).toBe('b');
    pending.resolve('a'); expect(await Promise.all([a, again])).toEqual(['a', 'a']); expect(load).toHaveBeenCalledOnce(); expect(cache.size()).toBe(1);
  });
  it('does not evict another in-flight load to admit a key or completed value', async () => {
    const cache = new TtlCache({ ttlMs: 1000, maxEntries: 10, maxBytes: 300 }), first = deferred(), second = deferred();
    const a = cache.getOrSet('test', 'a', () => first.promise), b = cache.getOrSet('test', 'b', () => second.promise);
    expect(await cache.getOrSet('test', 'c', async () => 'uncached')).toBe('uncached'); expect(cache.size()).toBe(2);
    first.resolve('x'.repeat(30)); expect(await a).toBe('x'.repeat(30)); expect(cache.size()).toBe(1);
    second.resolve('b'); await b; expect(cache.size()).toBe(1);
  });
  it('evicts a completed value to admit a new key while retaining its byte bound', async () => {
    const cache = new TtlCache({ ttlMs: 1000, maxEntries: 10, maxBytes: 400 });
    await cache.getOrSet('test', 'a', async () => 'x'.repeat(60));
    await cache.getOrSet('test', 'b', async () => 'b');
    const load = vi.fn(async () => 'new a'); expect(await cache.getOrSet('test', 'a', load)).toBe('new a'); expect(load).toHaveBeenCalledOnce();
  });
  it('evicts a completed peer when a pending value finishes larger than its key reservation', async () => {
    const cache = new TtlCache({ ttlMs: 1000, maxEntries: 10, maxBytes: 500 }), first = deferred(), second = deferred();
    const a = cache.getOrSet('test', 'a', () => first.promise), b = cache.getOrSet('test', 'b', () => second.promise);
    second.resolve('x'.repeat(60)); await b; first.resolve('y'.repeat(100)); await a;
    expect(cache.size()).toBe(1); const load = vi.fn(async () => 'new b'); await cache.getOrSet('test', 'b', load); expect(load).toHaveBeenCalledOnce();
  });
  it('expires completed values but retains pending work until it finishes', async () => {
    vi.useFakeTimers(); const cache = new TtlCache({ ttlMs: 10, maxEntries: 10, maxBytes: 1024 }), pending = deferred();
    const wait = cache.getOrSet('test', 'pending', () => pending.promise); await cache.getOrSet('test', 'ready', async () => 'ready');
    await vi.advanceTimersByTimeAsync(11); expect(cache.size()).toBe(1); pending.resolve('done'); await wait; expect(cache.size()).toBe(1);
  });
});

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
