import { describe, expect, it, vi } from 'vitest';
import { estimateRetainedValueBytes } from '../src/cache-weight.js';
import { createMaterializationBudgetedRepository, GraphQLMaterializationBudget } from '../src/graphql/materialization-budget.js';
import type { IndexerRepository } from '../src/repository/types.js';

describe('per-operation repository materialization budget', () => {
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid allowance %s', value => {
    expect(() => new GraphQLMaterializationBudget(value)).toThrow('positive safe integer');
  });
  it('serializes concurrent readers and charges the exact retained values', async () => {
    const budget = new GraphQLMaterializationBudget(1000);
    let release!: (value: string) => void;
    const first = budget.materialize(() => new Promise<string>(resolve => { release = resolve; }));
    const secondLoader = vi.fn(async () => 'two');
    const second = budget.materialize(secondLoader);
    await Promise.resolve(); expect(secondLoader).not.toHaveBeenCalled();
    release('one'); expect(await first).toBe('one'); expect(await second).toBe('two');
    expect(secondLoader).toHaveBeenCalledWith(1000 - estimateRetainedValueBytes('one', 1000));
    expect(budget.usedBytes).toBe(estimateRetainedValueBytes('one', 1000) + estimateRetainedValueBytes('two', 1000));
  });
  it('does not charge rejected reads or poison the following reader', async () => {
    const budget = new GraphQLMaterializationBudget(100);
    await expect(budget.materialize(async () => { throw new Error('read failed'); })).rejects.toThrow('read failed');
    expect(budget.remainingBytes).toBe(100);
    await expect(budget.materialize(async () => 'next')).resolves.toBe('next');
  });
  it('permits one oversized document for pagination progress and rejects later reads before loading', async () => {
    const budget = new GraphQLMaterializationBudget(10);
    const value = 'x'.repeat(100);
    expect(await budget.materialize(async () => value)).toBe(value);
    expect(budget.remainingBytes).toBe(0); expect(budget.usedBytes).toBe(10);
    const load = vi.fn();
    await expect(budget.materialize(load)).rejects.toMatchObject({ extensions: { code: 'GRAPHQL_EXECUTION_MEMORY_LIMIT_EXCEEDED' } });
    expect(load).not.toHaveBeenCalled();
  });
  const base = () => ({
    list: vi.fn(async () => []), get: vi.fn(async () => null), getMany: vi.fn(async () => []),
    upsert: vi.fn(async () => undefined), upsertMany: vi.fn(async () => undefined),
    deleteMany: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
  });
  it('wraps all mandatory reads and forwards writes without charging them', async () => {
    const original = base();
    const { repository, budget } = createMaterializationBudgetedRepository(original as unknown as IndexerRepository, 1000);
    await repository.list('assets'); await repository.get('assets', 'a'); await repository.getMany('assets', ['a']);
    expect(original.list).toHaveBeenCalledWith('assets'); expect(original.get).toHaveBeenCalledWith('assets', 'a'); expect(original.getMany).toHaveBeenCalledWith('assets', ['a']);
    const before = budget.usedBytes; const document = { collection: 'assets' as const, id: 'a', blockHeight: 1, timestamp: 2, data: { id: 'a' } };
    await repository.upsert(document); await repository.upsertMany([document]); await repository.deleteMany('assets', ['a']); await repository.close();
    expect(original.upsert).toHaveBeenCalledWith(document); expect(original.upsertMany).toHaveBeenCalledWith([document]);
    expect(original.deleteMany).toHaveBeenCalledWith('assets', ['a']); expect(original.close).toHaveBeenCalledOnce(); expect(budget.usedBytes).toBe(before);
    for (const name of ['query', 'watch', 'prepare', 'metricsSnapshot', 'healthCheck']) expect(repository).not.toHaveProperty(name);
  });
  it.each([undefined, null, 2000, 500, 0, -1, 1.5, NaN])('clamps query bytes while preserving invalid values for repository validation: %s', async maxBytes => {
    const query = vi.fn(async () => ({ nodes: [], totalCount: 0 }));
    const { repository } = createMaterializationBudgetedRepository({ ...base(), query } as unknown as IndexerRepository, 1000);
    await repository.query!('assets', { maxBytes });
    const expected = maxBytes == null || maxBytes === 2000 ? 1000 : maxBytes;
    expect(query).toHaveBeenCalledWith('assets', { maxBytes: expected });
  });
  it('preserves optional maintenance and watch APIs outside the read budget', async () => {
    const signal = new AbortController().signal; const iterator = { async *[Symbol.asyncIterator]() { yield { id: 'a' }; } };
    const original = { ...base(), watch: vi.fn(() => iterator), prepare: vi.fn(async () => undefined), metricsSnapshot: vi.fn(() => ({ rows: 3 })), healthCheck: vi.fn(async () => true) };
    const { repository, budget } = createMaterializationBudgetedRepository(original as unknown as IndexerRepository, 1000);
    expect(repository.watch!('assets', ['a'], signal)).toBe(iterator); await repository.prepare!();
    expect(repository.metricsSnapshot!()).toEqual({ rows: 3 }); expect(await repository.healthCheck!()).toBe(true);
    expect(original.watch).toHaveBeenCalledWith('assets', ['a'], signal); expect(original.prepare).toHaveBeenCalledOnce(); expect(budget.usedBytes).toBe(0);
  });
});
