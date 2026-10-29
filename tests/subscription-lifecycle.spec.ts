import { makeExecutableSchema } from '@graphql-tools/schema';
import { parse } from 'graphql';
import { describe, expect, it, vi } from 'vitest';

import { createEmissionScopedSubscribe } from '../src/graphql/transport.js';

import type { ExecutionArgs, ExecutionResult } from 'graphql';

const args: ExecutionArgs = {
  schema: makeExecutableSchema({ typeDefs: 'type Query { ok: Boolean! } type Subscription { update: String! }' }),
  document: parse('subscription { update }'),
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const done = { done: true as const, value: undefined };
const event = { done: false as const, value: 'event' };

const harness = async (overrides: Partial<AsyncIterableIterator<unknown>> = {},
  hooks: Partial<Parameters<typeof createEmissionScopedSubscribe>[0]> = {}) => {
  const source: AsyncIterableIterator<unknown> = {
    next: vi.fn(async () => event),
    return: vi.fn(async () => done),
    [Symbol.asyncIterator]() { return this; },
    ...overrides,
  };
  const acquire = vi.fn(() => true);
  const release = vi.fn();
  const execute = vi.fn(async (): Promise<ExecutionResult> => ({ data: { update: 'event' } }));
  const subscribe = createEmissionScopedSubscribe({
    acquire, release, execute, createSourceEventStream: async () => source, ...hooks,
  });
  const result = await subscribe(args);
  return { iterator: (result as AsyncIterable<ExecutionResult>)[Symbol.asyncIterator](), source, acquire, release, execute };
};

describe('subscription terminal failures and cancellation races', () => {
  it.each(['synchronous', 'asynchronous'])('closes a source after a %s read failure and never resumes it', async (kind) => {
    const error = new Error('source failed');
    const next = vi.fn(() => {
      if (kind === 'synchronous') throw error;
      return Promise.reject(error);
    });
    const { iterator, source, acquire, execute } = await harness({ next });
    await expect(iterator.next()).rejects.toBe(error);
    expect(source.return).toHaveBeenCalledOnce();
    await expect(iterator.next()).resolves.toEqual(done);
    expect(next).toHaveBeenCalledOnce();
    expect(acquire).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    await iterator.return?.();
    expect(source.return).toHaveBeenCalledOnce();
  });

  it('releases a delivered result before a subsequent source failure', async () => {
    const error = new Error('database watch failed');
    const next = vi.fn().mockResolvedValueOnce(event).mockRejectedValueOnce(error);
    const { iterator, source, release } = await harness({ next });
    await iterator.next();
    expect(release).not.toHaveBeenCalled();
    await expect(iterator.next()).rejects.toBe(error);
    expect(release).toHaveBeenCalledOnce();
    expect(source.return).toHaveBeenCalledOnce();
  });

  it.each(['resolve', 'reject'])('ignores a late source %s after cancellation', async (settlement) => {
    const read = deferred<IteratorResult<unknown>>();
    const next = vi.fn(() => read.promise);
    const { iterator, source, acquire, execute } = await harness({ next });
    const pending = iterator.next();
    await Promise.resolve();
    await iterator.return?.();
    if (settlement === 'resolve') read.resolve(event);
    else read.reject(new Error('late read error'));
    await expect(pending).resolves.toEqual(done);
    expect(acquire).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(source.return).toHaveBeenCalledOnce();
  });

  it('closes the source when admission itself throws', async () => {
    const error = new Error('admission failed');
    const { iterator, source, release } = await harness({}, { acquire: () => { throw error; } });
    await expect(iterator.next()).rejects.toBe(error);
    expect(source.return).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    await expect(iterator.next()).resolves.toEqual(done);
  });

  it('closes rejected subscriptions even if the rejection observer throws', async () => {
    const error = new Error('metrics callback failed');
    const { iterator, source, release } = await harness({}, {
      acquire: () => false, onRejected: () => { throw error; },
    });
    await expect(iterator.next()).rejects.toBe(error);
    expect(source.return).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    await expect(iterator.next()).resolves.toEqual(done);
  });

  it('preserves the original read failure when cleanup also fails', async () => {
    const error = new Error('read failed');
    const close = vi.fn(async () => { throw new Error('close failed'); });
    const { iterator } = await harness({ next: async () => { throw error; }, return: close });
    await expect(iterator.next()).rejects.toBe(error);
    expect(close).toHaveBeenCalledOnce();
    await expect(iterator.return?.()).resolves.toEqual(done);
    expect(close).toHaveBeenCalledOnce();
  });

  it('finishes a source that handles throw by yielding another value', async () => {
    const sourceThrow = vi.fn(async () => event);
    const { iterator, source, release } = await harness({ throw: sourceThrow });
    await iterator.next();
    const error = new Error('transport stopped');
    await expect(iterator.throw?.(error)).rejects.toBe(error);
    expect(sourceThrow).toHaveBeenCalledWith(error);
    expect(source.return).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    await expect(iterator.next()).resolves.toEqual(done);
    await iterator.return?.();
    expect(source.return).toHaveBeenCalledOnce();
  });

  it.each(['resolve', 'reject'])('retains execution memory until a cancelled execution %ss', async (settlement) => {
    const execution = deferred<ExecutionResult>();
    const started = deferred<void>();
    const { iterator, source, release } = await harness({}, {
      execute: () => { started.resolve(); return execution.promise; },
    });
    const pending = iterator.next();
    await started.promise;
    const close = iterator.return?.();
    expect(release).not.toHaveBeenCalled();
    if (settlement === 'resolve') execution.resolve({ data: { update: 'late' } });
    else execution.reject(new Error('late execution failure'));
    await expect(pending).resolves.toEqual(done);
    await close;
    expect(source.return).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it('a synchronous source throw failure cannot strand an in-flight reservation', async () => {
    const execution = deferred<ExecutionResult>();
    const started = deferred<void>();
    const sourceThrow = vi.fn(() => { throw new Error('source throw failed'); });
    const { iterator, source, release } = await harness({ throw: sourceThrow }, {
      execute: () => { started.resolve(); return execution.promise; },
    });
    const pending = iterator.next();
    await started.promise;
    const error = new Error('transport stopped');
    const closing = iterator.throw!(error).catch((failure: unknown) => failure);
    await Promise.resolve();
    expect(release).not.toHaveBeenCalled();
    execution.resolve({ data: { update: 'late' } });
    await expect(pending).resolves.toEqual(done);
    expect(await closing).toBe(error);
    expect(release).toHaveBeenCalledOnce();
    expect(source.return).toHaveBeenCalledOnce();
  });

  it('serializes queued next calls and prevents queued work after a failure', async () => {
    const read = deferred<IteratorResult<unknown>>();
    const error = new Error('read failed');
    const next = vi.fn(() => read.promise);
    const { iterator, source } = await harness({ next });
    const first = iterator.next().catch((failure: unknown) => failure);
    const second = iterator.next();
    const secondResult = second.catch((failure: unknown) => failure);
    await Promise.resolve();
    read.reject(error);
    expect(await first).toBe(error);
    expect(await secondResult).toEqual(done);
    expect(next).toHaveBeenCalledOnce();
    expect(source.return).toHaveBeenCalledOnce();
  });

  it('uses real GraphQL execution and closes its generator on cancellation', async () => {
    let closed = 0;
    const release = vi.fn();
    const schema = makeExecutableSchema({
      typeDefs: 'type Query { ok: Boolean! } type Subscription { update: String! }',
      resolvers: { Subscription: { update: { subscribe: async function* () {
        try { yield { update: 'one' }; yield { update: 'two' }; } finally { closed++; }
      } } } },
    });
    const result = await createEmissionScopedSubscribe({ acquire: () => true, release })({ ...args, schema });
    const iterator = (result as AsyncIterable<ExecutionResult>)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { data: { update: 'one' } } });
    await iterator.return?.();
    expect(closed).toBe(1);
    expect(release).toHaveBeenCalledOnce();
  });
});
