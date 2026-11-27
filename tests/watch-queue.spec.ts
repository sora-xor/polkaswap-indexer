import { describe, expect, it } from 'vitest';

import { LatestDocumentWatchQueue } from '../src/repository/watch-queue.js';

import type { RepositoryWatchEvent } from '../src/repository/types.js';

const event = (id: string, mutationType: RepositoryWatchEvent['mutationType'] = 'UPDATE'): RepositoryWatchEvent => ({
  collection: 'assets', id, mutationType,
});

describe('bounded document subscription queue', () => {
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid capacity %s', (capacity) => {
    expect(() => new LatestDocumentWatchQueue(capacity)).toThrow(/positive safe integer/);
  });

  it('coalesces mutations to the latest value and latest event order', () => {
    const queue = new LatestDocumentWatchQueue(2);
    expect(queue.push(event('a', 'INSERT'))).toBe(false);
    expect(queue.push(event('b'))).toBe(false);
    expect(queue.push(event('a', 'DELETE'))).toBe(false);
    expect(queue.length).toBe(2);
    expect(queue.shift()).toEqual(event('b'));
    expect(queue.shift()).toEqual(event('a', 'DELETE'));
    expect(queue.shift()).toBeUndefined();
    expect(queue.length).toBe(0);
  });

  it('evicts the oldest distinct identity after coalescing and reports only actual drops', () => {
    const queue = new LatestDocumentWatchQueue(2);
    queue.push(event('a'));
    queue.push(event('b'));
    queue.push(event('a', 'DELETE'));
    expect(queue.push(event('c', 'INSERT'))).toBe(true);
    expect(queue.shift()).toEqual(event('a', 'DELETE'));
    expect(queue.shift()).toEqual(event('c', 'INSERT'));
  });

  it('allows reinsertion after delivery and clears all queued state', () => {
    const queue = new LatestDocumentWatchQueue(1);
    queue.push(event('a', 'DELETE'));
    expect(queue.shift()).toEqual(event('a', 'DELETE'));
    expect(queue.push(event('a', 'INSERT'))).toBe(false);
    queue.clear();
    queue.clear();
    expect(queue.length).toBe(0);
    expect(queue.shift()).toBeUndefined();
    expect(queue.push(event('b'))).toBe(false);
    expect(queue.shift()).toEqual(event('b'));
  });
});
