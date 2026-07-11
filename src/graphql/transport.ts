import { createSourceEventStream, execute, GraphQLError } from 'graphql';

import type { GraphQLParams, Plugin } from 'graphql-yoga';
import type { ExecutionArgs, ExecutionResult } from 'graphql';

const transportError = (message: string, status: number, code: string): GraphQLError =>
  new GraphQLError(message, {
    extensions: {
      code,
      http: { status },
    },
  });

export const parseContentLength = (raw: string | null, maximumBytes: number): number | null => {
  if (raw === null) return null;
  if (!/^[0-9]+$/.test(raw)) {
    throw transportError('Content-Length must be a non-negative decimal integer.', 400, 'BAD_REQUEST');
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw transportError('Content-Length is too large to process safely.', 400, 'BAD_REQUEST');
  }
  if (value > maximumBytes) {
    throw transportError(
      `GraphQL request body exceeds the ${maximumBytes} byte limit.`,
      413,
      'PAYLOAD_TOO_LARGE'
    );
  }
  return value;
};

export const readBoundedRequestBody = async (request: Request, maximumBytes: number): Promise<Uint8Array> => {
  parseContentLength(request.headers.get('content-length'), maximumBytes);
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw transportError(
          `GraphQL request body exceeds the ${maximumBytes} byte limit.`,
          413,
          'PAYLOAD_TOO_LARGE'
        );
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

const parseBoundedJsonRequest = async (request: Request, maximumBytes: number): Promise<GraphQLParams> => {
  const bytes = await readBoundedRequestBody(request, maximumBytes);
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw transportError('GraphQL POST body must be valid UTF-8.', 400, 'BAD_REQUEST');
  }

  let body: unknown;
  try {
    body = JSON.parse(source);
  } catch {
    throw transportError('GraphQL POST body must be valid JSON.', 400, 'BAD_REQUEST');
  }

  if (Array.isArray(body)) {
    throw transportError('GraphQL request batching is disabled.', 400, 'BAD_REQUEST');
  }
  if (body === null || typeof body !== 'object') {
    throw transportError('GraphQL POST body must be a JSON object.', 400, 'BAD_REQUEST');
  }
  return body as GraphQLParams;
};

const jsonMediaType = (request: Request): boolean => {
  const contentType = request.headers.get('content-type');
  if (!contentType) return false;
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === 'application/json' || mediaType === 'application/graphql+json';
};

/** Restricts GraphQL POST ingress to bounded JSON documents. */
export const useBoundedGraphQLHttpBody = (maximumBytes: number): Plugin => ({
  onRequestParse({ request, setRequestParser, endResponse, fetchAPI }) {
    if (request.method !== 'POST') return;

    if (!jsonMediaType(request)) {
      endResponse(
        new fetchAPI.Response(null, {
          status: 415,
          statusText: 'Unsupported Media Type',
        })
      );
      return;
    }

    setRequestParser(async (incomingRequest) => {
      try {
        return await parseBoundedJsonRequest(incomingRequest, maximumBytes);
      } catch (error) {
        const candidate = error as {
          message?: unknown;
          extensions?: { code?: unknown; http?: { status?: unknown } };
        };
        const status =
          typeof candidate.extensions?.http?.status === 'number' ? candidate.extensions.http.status : 400;
        const code = typeof candidate.extensions?.code === 'string' ? candidate.extensions.code : 'BAD_REQUEST';
        const message = typeof candidate.message === 'string' ? candidate.message : 'Invalid GraphQL request body.';
        return new fetchAPI.Response(JSON.stringify({ errors: [{ message, extensions: { code } }] }), {
          status,
          headers: {
            'content-type': 'application/graphql-response+json; charset=utf-8',
            'cache-control': 'no-store',
            ...(status === 413 ? { connection: 'close' } : {}),
          },
        });
      }
    });
  },
});

/** Idempotent global WebSocket admission bookkeeping. */
export class WebSocketConnectionLimiter<T extends object = object> {
  readonly #connections = new Set<T>();

  constructor(readonly maximumConnections: number) {}

  get activeConnections(): number {
    return this.#connections.size;
  }

  get hasCapacity(): boolean {
    return this.#connections.size < this.maximumConnections;
  }

  acquire(connection: T): boolean {
    if (this.#connections.has(connection)) return true;
    if (!this.hasCapacity) return false;
    this.#connections.add(connection);
    return true;
  }

  release(connection: T): boolean {
    return this.#connections.delete(connection);
  }
}

type ModernWebSocketContext = {
  subscriptions: Readonly<Record<string, unknown>>;
};

/**
 * One operation budget shared by modern and legacy WebSocket protocols.
 * Modern graphql-ws reservations are read from their authoritative contexts,
 * avoiding leaked counters when validation fails or a client sends Complete.
 */
export class WebSocketOperationBudget<T extends ModernWebSocketContext = ModernWebSocketContext> {
  readonly #modernContexts = new Set<T>();
  readonly #legacyOperations = new Set<object>();

  constructor(readonly maximumOperations: number) {}

  get activeOperations(): number {
    let active = this.#legacyOperations.size;
    for (const context of this.#modernContexts) active += Object.keys(context.subscriptions).length;
    return active;
  }

  registerModern(context: T): void {
    this.#modernContexts.add(context);
  }

  unregisterModern(context: T): void {
    this.#modernContexts.delete(context);
  }

  /** graphql-ws reserves the current operation before invoking onSubscribe. */
  hasModernCapacity(context: T): boolean {
    this.registerModern(context);
    return this.activeOperations <= this.maximumOperations;
  }

  acquireLegacy(operation: object): boolean {
    if (this.#legacyOperations.has(operation)) return true;
    if (this.activeOperations >= this.maximumOperations) return false;
    this.#legacyOperations.add(operation);
    return true;
  }

  releaseLegacy(operation: object): boolean {
    return this.#legacyOperations.delete(operation);
  }
}

/** Idempotent admission bookkeeping for concurrently executing HTTP requests. */
export class HttpRequestLimiter<T extends object = object> {
  readonly #requests = new Set<T>();

  constructor(readonly maximumRequests: number) {}

  get activeRequests(): number {
    return this.#requests.size;
  }

  acquire(request: T): boolean {
    if (this.#requests.has(request)) return true;
    if (this.#requests.size >= this.maximumRequests) return false;
    this.#requests.add(request);
    return true;
  }

  release(request: T): boolean {
    return this.#requests.delete(request);
  }
}

/** Shared weighted reservations for results being executed or serialized. */
export class GraphQLExecutionMemoryBudget<T extends object = object> {
  readonly #reservations = new Map<T, number>();
  #reservedBytes = 0;

  constructor(readonly maximumBytes: number) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
      throw new Error('GraphQL execution memory budget must be a positive safe integer');
    }
  }

  get reservedBytes(): number {
    return this.#reservedBytes;
  }

  get activeReservations(): number {
    return this.#reservations.size;
  }

  acquire(reservation: T, bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > this.maximumBytes) return false;
    const existing = this.#reservations.get(reservation);
    if (existing !== undefined) return existing === bytes;
    if (this.#reservedBytes > this.maximumBytes - bytes) return false;
    this.#reservations.set(reservation, bytes);
    this.#reservedBytes += bytes;
    return true;
  }

  release(reservation: T): boolean {
    const bytes = this.#reservations.get(reservation);
    if (bytes === undefined || !this.#reservations.delete(reservation)) return false;
    this.#reservedBytes -= bytes;
    return true;
  }
}

type EmissionScopedSubscribeOptions = {
  acquire: (reservation: object) => boolean;
  release: (reservation: object) => void;
  onRejected?: () => void;
  contextValueForEvent?: (contextValue: unknown) => unknown;
  createSourceEventStream?: (
    args: ExecutionArgs
  ) => Promise<AsyncIterable<unknown> | ExecutionResult>;
  execute?: (args: ExecutionArgs) => ExecutionResult | Promise<ExecutionResult>;
};

const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown> =>
  value !== null &&
  typeof value === 'object' &&
  typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function';

const executionMemoryLimitError = (): GraphQLError =>
  new GraphQLError('GraphQL execution memory is at capacity. Retry later.', {
    extensions: { code: 'GRAPHQL_EXECUTION_MEMORY_LIMIT_EXCEEDED' },
  });

/**
 * Splits a GraphQL subscription into source waiting and event execution.
 *
 * The source iterator is intentionally awaited without a memory reservation:
 * an idle subscription must not consume execution capacity. Once an event is
 * available, one weighted reservation covers field execution and remains held
 * while the yielded result is serialized and sent. The iterator releases it
 * only when the transport asks for the next event (after its send promise
 * settles), or when cancellation/error closes the iterator.
 */
export const createEmissionScopedSubscribe = (options: EmissionScopedSubscribeOptions) =>
  async (args: ExecutionArgs): Promise<AsyncIterable<ExecutionResult> | ExecutionResult> => {
    const source = await (options.createSourceEventStream ?? createSourceEventStream)(args);
    if (!isAsyncIterable(source)) return source;
    const sourceIterator = source[Symbol.asyncIterator]();
    let activeReservation: object | null = null;
    let activeExecution: Promise<ExecutionResult> | null = null;
    let closed = false;
    let closeSourcePromise: Promise<unknown> | null = null;
    let nextTail = Promise.resolve();

    const releaseActive = (): void => {
      if (!activeReservation) return;
      const reservation = activeReservation;
      activeReservation = null;
      options.release(reservation);
    };
    const closeSource = (): Promise<unknown> => {
      closeSourcePromise ??= Promise.resolve()
        .then(() => sourceIterator.return?.())
        .catch(() => undefined);
      return closeSourcePromise;
    };
    const runNext = async (): Promise<IteratorResult<ExecutionResult>> => {
      // The transport asks for the next value only after its previous send
      // settles, so this release covers both onNext and socket backpressure.
      releaseActive();
      if (closed) return { done: true, value: undefined };

      const event = await sourceIterator.next();
      if (closed) return { done: true, value: undefined };
      if (event.done) {
        closed = true;
        return { done: true, value: undefined };
      }

      const reservation = {};
      if (!options.acquire(reservation)) {
        options.onRejected?.();
        closed = true;
        await closeSource();
        return { done: false, value: { errors: [executionMemoryLimitError()] } };
      }
      activeReservation = reservation;

      const execution = Promise.resolve().then(() =>
        (options.execute ?? execute)({
          ...args,
          rootValue: event.value,
          contextValue: options.contextValueForEvent
            ? options.contextValueForEvent(args.contextValue)
            : args.contextValue,
        })
      );
      activeExecution = execution;
      try {
        const result = await execution;
        if (closed) {
          releaseActive();
          return { done: true, value: undefined };
        }
        return { done: false, value: result };
      } catch (error) {
        closed = true;
        releaseActive();
        await closeSource();
        throw error;
      } finally {
        if (activeExecution === execution) activeExecution = null;
      }
    };
    const iterator: AsyncIterableIterator<ExecutionResult> = {
      next: () => {
        const result = nextTail.then(runNext, runNext);
        nextTail = result.then(() => undefined, () => undefined);
        return result;
      },
      return: async () => {
        closed = true;
        const execution = activeExecution;
        if (!execution) releaseActive();
        await closeSource();
        await execution?.catch(() => undefined);
        releaseActive();
        return { done: true, value: undefined };
      },
      throw: async (error?: unknown) => {
        closed = true;
        const execution = activeExecution;
        if (!execution) releaseActive();
        if (sourceIterator.throw) await sourceIterator.throw(error).catch(() => undefined);
        else await closeSource();
        await execution?.catch(() => undefined);
        releaseActive();
        throw error;
      },
      [Symbol.asyncIterator]() {
        return iterator;
      },
    };
    return iterator;
  };

/** graphql-ws reserves the current operation ID before invoking onSubscribe. */
export const hasWebSocketOperationCapacity = (
  subscriptions: Readonly<Record<string, unknown>>,
  maximumOperations: number
): boolean => Object.keys(subscriptions).length <= maximumOperations;
