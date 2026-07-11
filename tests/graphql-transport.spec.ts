import { makeExecutableSchema } from '@graphql-tools/schema';
import { parse } from 'graphql';
import { createYoga } from 'graphql-yoga';
import { describe, expect, it } from 'vitest';

import {
  hasWebSocketOperationCapacity,
  createEmissionScopedSubscribe,
  GraphQLExecutionMemoryBudget,
  HttpRequestLimiter,
  WebSocketOperationBudget,
  parseContentLength,
  readBoundedRequestBody,
  useBoundedGraphQLHttpBody,
  WebSocketConnectionLimiter,
} from '../src/graphql/transport.js';

import type { ExecutionArgs, ExecutionResult } from 'graphql';

const streamingRequest = (chunks: readonly Uint8Array[], onCancel?: () => void): Request => {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      if (!chunk) {
        controller.close();
        return;
      }
      index += 1;
      controller.enqueue(chunk);
    },
    cancel() {
      onCancel?.();
    },
  });
  return new Request('http://localhost/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    duplex: 'half',
  } as RequestInit);
};

describe('bounded GraphQL HTTP bodies', () => {
  it('accepts absent, zero, leading-zero, and exact-limit Content-Length values', () => {
    expect(parseContentLength(null, 10)).toBeNull();
    expect(parseContentLength('0', 10)).toBe(0);
    expect(parseContentLength('0009', 10)).toBe(9);
    expect(parseContentLength('10', 10)).toBe(10);
  });

  it.each(['', '-1', '+1', '1.5', '1e3', ' 1', '1 ', 'NaN', '9007199254740992'])(
    'rejects malformed or unsafe Content-Length %j',
    (value) => {
      expect(() => parseContentLength(value, Number.MAX_SAFE_INTEGER)).toThrow(/Content-Length/);
    }
  );

  it('rejects a declared body above the maximum before reading', () => {
    try {
      parseContentLength('11', 10);
      throw new Error('expected parseContentLength to throw');
    } catch (error) {
      expect(error).toMatchObject({ extensions: { code: 'PAYLOAD_TOO_LARGE', http: { status: 413 } } });
    }
  });

  it('collects chunked bodies up to the exact byte limit', async () => {
    const body = await readBoundedRequestBody(
      streamingRequest([new TextEncoder().encode('1234'), new TextEncoder().encode('567890')]),
      10
    );
    expect(new TextDecoder().decode(body)).toBe('1234567890');
  });

  it('cancels a chunked body immediately after it crosses the byte limit', async () => {
    let cancelled = false;
    const request = streamingRequest(
      [new TextEncoder().encode('1234'), new TextEncoder().encode('5678')],
      () => {
        cancelled = true;
      }
    );

    await expect(readBoundedRequestBody(request, 7)).rejects.toMatchObject({
      extensions: { code: 'PAYLOAD_TOO_LARGE', http: { status: 413 } },
    });
    expect(cancelled).toBe(true);
  });

  it('enforces bounded JSON, disabled batching, disabled multipart, and GET mutation rejection through Yoga', async () => {
    const yoga = createYoga({
      schema: makeExecutableSchema({
        typeDefs: /* GraphQL */ `
          type Query { ok: Boolean! }
          type Mutation { change: Boolean! }
        `,
        resolvers: {
          Query: { ok: () => true },
          Mutation: { change: () => true },
        },
      }),
      plugins: [useBoundedGraphQLHttpBody(64)],
      batching: false,
      multipart: false,
      graphiql: false,
    });

    const valid = await yoga.fetch('http://localhost/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ ok }' }),
    });
    expect(valid.status).toBe(200);

    const batch = await yoga.fetch('http://localhost/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ query: '{ ok }' }]),
    });
    expect(batch.status).toBe(400);
    expect(await batch.text()).toContain('batching is disabled');

    const multipart = await yoga.fetch('http://localhost/graphql', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=test' },
      body: '--test--',
    });
    expect(multipart.status).toBe(415);

    const graphqlString = await yoga.fetch('http://localhost/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/graphql' },
      body: '{ ok }',
    });
    expect(graphqlString.status).toBe(415);

    const oversized = await yoga.fetch(streamingRequest([new Uint8Array(40), new Uint8Array(40)]));
    expect(oversized.status).toBe(413);
    expect(oversized.headers.get('connection')).toBe('close');

    const declaredOversized = await yoga.fetch(
      new Request('http://localhost/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '65' },
        body: '{}',
      })
    );
    expect(declaredOversized.status).toBe(413);
    expect(declaredOversized.headers.get('connection')).toBe('close');

    const getMutation = await yoga.fetch(
      `http://localhost/graphql?query=${encodeURIComponent('mutation { change }')}`,
      { method: 'GET' }
    );
    expect(getMutation.status).toBe(405);
    expect(getMutation.headers.get('allow')).toBe('POST');
  });
});

describe('WebSocket resource bookkeeping', () => {
  const subscriptionArgs = (): ExecutionArgs => ({
    schema: makeExecutableSchema({
      typeDefs: 'type Query { ok: Boolean! } type Subscription { update: String! }',
      resolvers: { Query: { ok: () => true } },
    }),
    document: parse('subscription { update }'),
  });

  it('does not reserve execution memory while a subscription waits for an event', async () => {
    let resolveEvent!: (result: IteratorResult<unknown>) => void;
    let acquired = 0;
    let released = 0;
    let sourceReturns = 0;
    const source: AsyncIterableIterator<unknown> = {
      next: () => new Promise<IteratorResult<unknown>>((resolve) => {
        resolveEvent = resolve;
      }),
      return: async () => {
        sourceReturns += 1;
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    const subscribe = createEmissionScopedSubscribe({
      acquire: () => {
        acquired += 1;
        return true;
      },
      release: () => {
        released += 1;
      },
      createSourceEventStream: async () => source,
      execute: async ({ rootValue }) => ({ data: { update: rootValue } }),
    });
    const result = await subscribe(subscriptionArgs());
    expect(Symbol.asyncIterator in result).toBe(true);
    const iterator = (result as AsyncIterable<ExecutionResult>)[Symbol.asyncIterator]();
    const pending = iterator.next();

    await Promise.resolve();
    expect({ acquired, released }).toEqual({ acquired: 0, released: 0 });

    resolveEvent({ done: false, value: 'one' });
    await expect(pending).resolves.toMatchObject({ done: false, value: { data: { update: 'one' } } });
    expect({ acquired, released }).toEqual({ acquired: 1, released: 0 });

    await iterator.return?.();
    expect({ released, sourceReturns }).toEqual({ released: 1, sourceReturns: 1 });
  });

  it('releases emission reservations when execution fails', async () => {
    let released = 0;
    let sourceReturns = 0;
    const source: AsyncIterableIterator<unknown> = {
      next: async () => ({ done: false, value: 'event' }),
      return: async () => {
        sourceReturns += 1;
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    const subscribe = createEmissionScopedSubscribe({
      acquire: () => true,
      release: () => {
        released += 1;
      },
      createSourceEventStream: async () => source,
      execute: async () => {
        throw new Error('execution failed');
      },
    });
    const result = await subscribe(subscriptionArgs());
    const iterator = (result as AsyncIterable<ExecutionResult>)[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toThrow('execution failed');
    expect({ released, sourceReturns }).toEqual({ released: 1, sourceReturns: 1 });
  });

  it('keeps a cancelled in-flight execution reserved until execution settles', async () => {
    let acquired = 0;
    let released = 0;
    let finishExecution!: (result: ExecutionResult) => void;
    const execution = new Promise<ExecutionResult>((resolve) => {
      finishExecution = resolve;
    });
    let emitted = false;
    const source: AsyncIterableIterator<unknown> = {
      next: async () => {
        if (emitted) return { done: true, value: undefined };
        emitted = true;
        return { done: false, value: 'event' };
      },
      return: async () => ({ done: true, value: undefined }),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    const subscribe = createEmissionScopedSubscribe({
      acquire: () => {
        acquired += 1;
        return true;
      },
      release: () => {
        released += 1;
      },
      createSourceEventStream: async () => source,
      execute: async () => execution,
    });
    const result = await subscribe(subscriptionArgs());
    const iterator = (result as AsyncIterable<ExecutionResult>)[Symbol.asyncIterator]();
    const pending = iterator.next();
    while (acquired === 0) await Promise.resolve();

    const cancellation = iterator.return?.();
    expect({ acquired, released }).toEqual({ acquired: 1, released: 0 });
    finishExecution({ data: { update: 'ignored' } });

    await expect(pending).resolves.toMatchObject({ done: true });
    await cancellation;
    expect(released).toBe(1);
  });

  it('terminates an event stream with a coded result when emission memory is unavailable', async () => {
    let rejected = 0;
    let sourceReturns = 0;
    const source: AsyncIterableIterator<unknown> = {
      next: async () => ({ done: false, value: 'event' }),
      return: async () => {
        sourceReturns += 1;
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    const subscribe = createEmissionScopedSubscribe({
      acquire: () => false,
      release: () => {
        throw new Error('a rejected reservation must not be released');
      },
      onRejected: () => {
        rejected += 1;
      },
      createSourceEventStream: async () => source,
    });
    const result = await subscribe(subscriptionArgs());
    const iterator = (result as AsyncIterable<ExecutionResult>)[Symbol.asyncIterator]();

    const emission = await iterator.next();
    expect(emission.value).toMatchObject({
      errors: [{ extensions: { code: 'GRAPHQL_EXECUTION_MEMORY_LIMIT_EXCEEDED' } }],
    });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    expect({ rejected, sourceReturns }).toEqual({ rejected: 1, sourceReturns: 1 });
  });

  it('enforces the global connection limit with idempotent acquire/release', () => {
    const limiter = new WebSocketConnectionLimiter<object>(2);
    const first = {};
    const second = {};
    const rejected = {};

    expect(limiter.acquire(first)).toBe(true);
    expect(limiter.acquire(first)).toBe(true);
    expect(limiter.acquire(second)).toBe(true);
    expect(limiter.activeConnections).toBe(2);
    expect(limiter.hasCapacity).toBe(false);
    expect(limiter.acquire(rejected)).toBe(false);

    expect(limiter.release(first)).toBe(true);
    expect(limiter.release(first)).toBe(false);
    expect(limiter.activeConnections).toBe(1);
    expect(limiter.acquire(rejected)).toBe(true);
    expect(limiter.activeConnections).toBe(2);
  });

  it('uses graphql-ws operation reservations and ignores inherited object keys', () => {
    const withinLimit = Object.assign(Object.create({ inherited: null }) as Record<string, unknown>, {
      one: null,
      two: null,
    });
    expect(hasWebSocketOperationCapacity(withinLimit, 2)).toBe(true);
    expect(hasWebSocketOperationCapacity({ one: null, two: null, three: null }, 2)).toBe(false);
  });

  it('shares one leak-free operation budget across modern and legacy protocols', () => {
    const budget = new WebSocketOperationBudget<{ subscriptions: Record<string, unknown> }>(3);
    const modern: { subscriptions: Record<string, unknown> } = {
      subscriptions: { one: null, two: null },
    };
    const legacy = {};
    const rejected = {};

    expect(budget.hasModernCapacity(modern)).toBe(true);
    expect(budget.acquireLegacy(legacy)).toBe(true);
    expect(budget.activeOperations).toBe(3);
    expect(budget.acquireLegacy(rejected)).toBe(false);

    delete modern.subscriptions.two;
    expect(budget.activeOperations).toBe(2);
    expect(budget.acquireLegacy(rejected)).toBe(true);
    expect(budget.releaseLegacy(legacy)).toBe(true);
    expect(budget.releaseLegacy(legacy)).toBe(false);
    budget.unregisterModern(modern);
    expect(budget.activeOperations).toBe(1);
  });
});

describe('HTTP request admission bookkeeping', () => {
  it('bounds distinct requests and releases capacity idempotently', () => {
    const limiter = new HttpRequestLimiter<object>(2);
    const first = {};
    const second = {};
    const rejected = {};

    expect(limiter.acquire(first)).toBe(true);
    expect(limiter.acquire(first)).toBe(true);
    expect(limiter.acquire(second)).toBe(true);
    expect(limiter.activeRequests).toBe(2);
    expect(limiter.acquire(rejected)).toBe(false);
    expect(limiter.release(first)).toBe(true);
    expect(limiter.release(first)).toBe(false);
    expect(limiter.acquire(rejected)).toBe(true);
    expect(limiter.activeRequests).toBe(2);
  });

  it('shares weighted execution reservations across transport tokens', () => {
    const budget = new GraphQLExecutionMemoryBudget<object>(100);
    const http = {};
    const modern = {};
    const legacy = {};

    expect(budget.acquire(http, 40)).toBe(true);
    expect(budget.acquire(http, 40)).toBe(true);
    expect(budget.acquire(modern, 40)).toBe(true);
    expect(budget.acquire(legacy, 40)).toBe(false);
    expect(budget).toMatchObject({ reservedBytes: 80, activeReservations: 2 });
    expect(budget.release(http)).toBe(true);
    expect(budget.release(http)).toBe(false);
    expect(budget.acquire(legacy, 40)).toBe(true);
    expect(budget).toMatchObject({ reservedBytes: 80, activeReservations: 2 });
  });
});
