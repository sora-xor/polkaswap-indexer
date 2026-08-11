import { createServer } from 'node:http';

import { getOperationAST, GraphQLError, parse, specifiedRules, validate } from 'graphql';
import { GRAPHQL_TRANSPORT_WS_PROTOCOL } from 'graphql-ws';
import { createYoga } from 'graphql-yoga';
import { useServer } from 'graphql-ws/use/ws';
import { WebSocketServer } from 'ws';

import {
  readConfig,
  type AppConfig,
  type RuntimeSecurityConfig,
} from './config.js';
import { migrate } from './db/migrate.js';
import { createSchema } from './graphql/resolvers.js';
import {
  hasWebSocketOperationCapacity,
  createEmissionScopedSubscribe,
  GraphQLExecutionMemoryBudget,
  HttpRequestLimiter,
  useBoundedGraphQLHttpBody,
  WebSocketConnectionLimiter,
  WebSocketOperationBudget,
} from './graphql/transport.js';
import { createGraphQLQueryLimitsRule, useGraphQLQueryLimits } from './graphql/validation.js';
import {
  boundGraphQLExecutionResult,
  boundGraphQLExecutionResults,
} from './graphql/result-size.js';
import { createMaterializationBudgetedRepository } from './graphql/materialization-budget.js';
import {
  LEGACY_GRAPHQL_WS_PROTOCOL,
  useLegacyGraphqlWebSocketServer,
} from './graphql/legacy-websocket.js';
import { AbuseLimiter } from './http/abuseLimiter.js';
import { metrics } from './metrics.js';
import { createRepository, shouldRunPostgresMigration } from './repository/factory.js';
import { idempotentShutdown, runShutdownSteps } from './shutdown.js';

import type { IndexerRepository } from './repository/types.js';
import type { ChainIndexerStatusProvider } from './worker/status.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type WebSocket from 'ws';

export type ServerHandle = {
  stopAccepting: () => void;
  stop: () => Promise<void>;
};

const secondsSince = (startedAt: number): number => (Date.now() - startedAt) / 1000;

export const normalizeRequestPath = (url: string | undefined, graphqlPath: string): string => {
  let path: string;
  try {
    path = new URL(url ?? '/', 'http://localhost').pathname;
  } catch {
    // Request targets are untrusted. A malformed absolute-form target must be
    // rejected as an unknown route instead of escaping the request handler.
    return 'other';
  }

  if (path === graphqlPath) return graphqlPath;
  if (path === '/metrics') return '/metrics';

  return 'other';
};

const BOUNDED_HTTP_METHOD_LABELS = new Set([
  'CONNECT',
  'DELETE',
  'GET',
  'HEAD',
  'OPTIONS',
  'PATCH',
  'POST',
  'PUT',
  'TRACE',
]);

/** Prevents attacker-selected HTTP methods from creating unbounded metric series. */
export const normalizeHttpMethodLabel = (method: string | undefined): string => {
  const normalized = method?.toUpperCase() ?? 'UNKNOWN';
  return BOUNDED_HTTP_METHOD_LABELS.has(normalized) ? normalized : 'OTHER';
};

const writeMetrics = (response: ServerResponse, repository: IndexerRepository): void => {
  const snapshot = repository.metricsSnapshot?.() ?? {};

  for (const [name, value] of Object.entries(snapshot)) {
    metrics.setGauge(name, {}, value);
  }

  response.writeHead(200, {
    'content-type': 'text/plain; version=0.0.4; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(metrics.render());
};

const writeJsonError = (
  response: ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {}
): void => {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'access-control-allow-origin': '*',
    ...headers,
  });
  response.end(JSON.stringify({ errors: [{ message }] }));
};

const listen = (server: ReturnType<typeof createServer>, config: AppConfig): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({
      port: config.port,
      host: config.host,
      backlog: config.httpListenBacklog,
    });
  });

const closeHttpServer = (server: ReturnType<typeof createServer>, timeoutMs: number): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const forceShutdownTimer = setTimeout(() => {
      server.closeAllConnections?.();
    }, timeoutMs);
    forceShutdownTimer.unref();

    server.close((error) => {
      clearTimeout(forceShutdownTimer);
      if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections?.();
  });

const closeWebSocketServer = (server: WebSocketServer, timeoutMs: number): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(forceShutdownTimer);
      if (
        error &&
        (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' &&
        error.message !== 'The server is not running'
      ) {
        reject(error);
      }
      else resolve();
    };
    const forceShutdownTimer = setTimeout(() => {
      for (const socket of server.clients) socket.terminate();
      // Do not let an upgraded client hold process shutdown open after the
      // configured grace period. The server is already closed to new clients.
      finish();
    }, timeoutMs);
    forceShutdownTimer.unref();

    for (const socket of server.clients) socket.close(1001, 'Server shutting down');
    server.close((error) => finish(error));
  });

const throwFirstRejected = (results: readonly PromiseSettledResult<unknown>[]): void => {
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (rejected) throw rejected.reason;
};

const disposeWebSocketServer = async (
  dispose: () => void | Promise<void>,
  timeoutMs: number,
  label: string
): Promise<void> => {
  const disposal = Promise.resolve().then(dispose);
  // Attach a handler immediately so a disposal that rejects while the timeout
  // wins cannot become an unhandled rejection.
  void disposal.catch(() => undefined);

  let timer: ReturnType<typeof setTimeout> | null = null;
  const result = await Promise.race([
    disposal.then(
      () => ({ completed: true as const }),
      (error: unknown) => ({ completed: true as const, error })
    ),
    new Promise<{ completed: false }>((resolve) => {
      timer = setTimeout(() => resolve({ completed: false }), Math.max(timeoutMs, 1));
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);

  if (!result.completed) {
    console.warn(`${label} disposal did not settle before the HTTP shutdown deadline`);
    return;
  }
  if ('error' in result) {
    const error = result.error as NodeJS.ErrnoException;
    if (
      error?.code !== 'ERR_SERVER_NOT_RUNNING' &&
      error?.message !== 'The server is not running'
    ) {
      throw error;
    }
  }
};

const websocketProtocols = (header: string | string[] | undefined): string[] =>
  (Array.isArray(header) ? header : header?.split(',') ?? [])
    .map((protocol) => protocol.trim())
    .filter((protocol) => protocol.length > 0);

const rejectWebSocketUpgrade = (
  socket: import('node:stream').Duplex,
  status: 404 | 429 | 503,
  retryAfterSeconds = 1
): void => {
  if (socket.destroyed) return;
  const reason =
    status === 429 ? 'Too Many Requests' : status === 503 ? 'Service Unavailable' : 'Not Found';
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\nRetry-After: ${retryAfterSeconds}\r\n\r\n`
  );
};

const queryLimitsFromConfig = (config: AppConfig) => ({
  maxDepth: config.graphqlMaxDepth,
  maxDocumentNodes: config.graphqlMaxDocumentNodes,
  maxFields: config.graphqlMaxFields,
  maxAliases: config.graphqlMaxAliases,
  maxFragmentSpreads: config.graphqlMaxFragmentSpreads,
  maxOperationCost: config.graphqlMaxOperationCost,
  allowIntrospection: config.graphqlAllowIntrospection,
});

const isAsyncIterable = (value: unknown): value is AsyncIterable<import('graphql').ExecutionResult> =>
  value !== null &&
  typeof value === 'object' &&
  typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function';

const useBoundedGraphQLResults = (maximumBytes: number) => ({
  onExecutionResult({ result, setResult }: {
    result: import('graphql').ExecutionResult | AsyncIterable<import('graphql').ExecutionResult> | undefined;
    setResult: (
      result: import('graphql').ExecutionResult | AsyncIterable<import('graphql').ExecutionResult>
    ) => void;
  }): void {
    if (!result) return;
    setResult(
      isAsyncIterable(result)
        ? boundGraphQLExecutionResults(result, maximumBytes)
        : boundGraphQLExecutionResult(result, maximumBytes)
    );
  },
});

const createGraphQLExecutionContext = (
  config: AppConfig,
  repository: IndexerRepository,
  workerStatusProvider?: ChainIndexerStatusProvider
) => ({
  repository: createMaterializationBudgetedRepository(
    repository,
    config.graphqlMaxResultBytes
  ).repository,
  // Bounded streaming reducers and subscription source streams use the raw
  // repository. A fresh aggregate wrapper covers each retained execution.
  streamingRepository: repository,
  workerStatusProvider,
  workerReadinessThresholds: {
    maxLagBlocks: config.workerReadinessMaxLagBlocks,
    maxStalenessSeconds: config.workerReadinessMaxStalenessSeconds,
  },
  graphqlQueryMaxBytes: config.graphqlMaxResultBytes,
});

export const createGraphQLHandler = (
  config: AppConfig,
  repository: IndexerRepository,
  workerStatusProvider?: ChainIndexerStatusProvider
) => {
  const schema = createSchema(config);
  const queryLimits = queryLimitsFromConfig(config);
  const yoga = createYoga({
    schema,
    graphqlEndpoint: config.graphqlPath,
    context: () => createGraphQLExecutionContext(config, repository, workerStatusProvider),
    plugins: [
      useBoundedGraphQLHttpBody(config.graphqlHttpMaxBodyBytes),
      useGraphQLQueryLimits(queryLimits),
      useBoundedGraphQLResults(config.graphqlMaxResultBytes),
    ],
    batching: false,
    multipart: false,
    graphiql: false,
    landingPage: false,
    cors: {
      origin: '*',
      credentials: false,
    },
  });

  return { schema, queryLimits, yoga };
};

const runtimeSecurityFromAppConfig = (config: AppConfig): RuntimeSecurityConfig => ({
  httpMaxBodyBytes: config.graphqlHttpMaxBodyBytes,
  httpMaxHeaderBytes: config.httpMaxHeaderBytes,
  httpListenBacklog: config.httpListenBacklog,
  httpShutdownTimeoutMs: config.httpShutdownTimeoutMs,
  httpKeepAliveTimeoutMs: config.httpKeepAliveTimeoutMs,
  httpHeadersTimeoutMs: config.httpHeadersTimeoutMs,
  httpRequestTimeoutMs: config.httpRequestTimeoutMs,
  httpMaxConnections: config.httpMaxConnections,
  httpMaxRequestsPerSocket: config.httpMaxRequestsPerSocket,
  rateLimitWindowMs: config.rateLimitWindowMs,
  rateLimitMax: config.rateLimitMax,
  rateLimitMaxKeys: config.rateLimitMaxKeys,
  rateLimitGlobalWindowMs: config.rateLimitGlobalWindowMs,
  rateLimitGlobalMax: config.rateLimitGlobalMax,
  graphqlMaxDepth: config.graphqlMaxDepth,
  graphqlMaxFields: config.graphqlMaxFields,
  graphqlMaxAliases: config.graphqlMaxAliases,
  graphqlAllowIntrospection: config.graphqlAllowIntrospection,
  graphqlWsMaxPayloadBytes: config.graphqlWsMaxPayloadBytes,
  graphqlWsMaxConnections: config.graphqlWsMaxConnections,
  graphqlWsMaxConnectionsPerClient: config.graphqlWsMaxConnectionsPerClient,
  graphqlWsMaxOperationsPerConnection: config.graphqlWsMaxOperationsPerConnection,
  graphqlWsConnectionInitTimeoutMs: config.graphqlWsConnectionInitTimeoutMs,
});

/**
 * Starts the Polkaswap indexer GraphQL API.
 */
export async function startServer(
  config: AppConfig = readConfig(),
  repository: IndexerRepository = createRepository(config),
  workerStatusProvider?: ChainIndexerStatusProvider,
  security?: RuntimeSecurityConfig
): Promise<ServerHandle> {
  if (!config.skipPostgresMigration && shouldRunPostgresMigration(config)) await migrate(config);
  await repository.prepare?.();

  const runtimeSecurity = security ?? runtimeSecurityFromAppConfig(config);
  const { schema, queryLimits, yoga } = createGraphQLHandler(config, repository, workerStatusProvider);
  const httpRequestLimiter = new HttpRequestLimiter<ServerResponse>(config.graphqlHttpMaxInFlight);
  const abuseLimiter = new AbuseLimiter({
    windowMs: runtimeSecurity.rateLimitWindowMs,
    max: runtimeSecurity.rateLimitMax,
    maxKeys: runtimeSecurity.rateLimitMaxKeys,
    globalWindowMs: runtimeSecurity.rateLimitGlobalWindowMs,
    globalMax: runtimeSecurity.rateLimitGlobalMax,
  });
  const checkWebSocketRate = (request: IncomingMessage) =>
    abuseLimiter.check(`ws:${request.socket.remoteAddress ?? 'unknown'}`);
  const webSocketRateLimitError = (): GraphQLError =>
    new GraphQLError('WebSocket rate limit exceeded.', {
      extensions: { code: 'GRAPHQL_WS_RATE_LIMITED' },
    });
  const executionMemoryBudget = new GraphQLExecutionMemoryBudget<object>(
    config.graphqlExecutionMemoryMaxBytes
  );
  const updateExecutionMemoryMetrics = (): void => {
    metrics.setGauge('indexer_graphql_execution_memory_reserved_bytes', {}, executionMemoryBudget.reservedBytes);
    metrics.setGauge('indexer_graphql_execution_memory_reservations', {}, executionMemoryBudget.activeReservations);
  };
  const emissionScopedSubscribe = (protocol: 'modern' | 'legacy') =>
    createEmissionScopedSubscribe({
      acquire: (reservation) => {
        const acquired = executionMemoryBudget.acquire(reservation, config.graphqlMaxResultBytes);
        if (acquired) updateExecutionMemoryMetrics();
        return acquired;
      },
      release: (reservation) => {
        if (executionMemoryBudget.release(reservation)) updateExecutionMemoryMetrics();
      },
      onRejected: () => {
        metrics.increment('indexer_graphql_execution_memory_rejections_total', { protocol });
      },
      contextValueForEvent: () =>
        createGraphQLExecutionContext(config, repository, workerStatusProvider),
    });

  const handleRequest = (request: IncomingMessage, response: ServerResponse): void => {
    const startedAt = Date.now();
    const path = normalizeRequestPath(request.url, config.graphqlPath);
    const method = normalizeHttpMethodLabel(request.method);

    response.setHeader('x-content-type-options', 'nosniff');

    response.once('finish', () => {
      const labels = { method, path, status: response.statusCode };

      metrics.increment('indexer_http_requests_total', labels);
      metrics.observe('indexer_http_request_duration_seconds', labels, secondsSince(startedAt));
    });

    const now = Date.now();
    const client = request.socket.remoteAddress ?? 'unknown';
    const limited = abuseLimiter.check(`http:${client}`, now);
    response.setHeader('x-ratelimit-limit', String(limited.limit));
    response.setHeader('x-ratelimit-remaining', String(limited.remaining));
    response.setHeader('x-ratelimit-reset', String(Math.ceil(limited.resetAt / 1_000)));
    if (!limited.allowed) {
      request.resume();
      writeJsonError(response, 429, 'Too many requests.', {
        'retry-after': String(Math.max(1, Math.ceil((limited.resetAt - now) / 1_000))),
      });
      return;
    }

    if (path === '/metrics' && method !== 'GET' && method !== 'HEAD') {
      response.shouldKeepAlive = false;
      response.writeHead(405, {
        allow: 'GET, HEAD',
        'cache-control': 'no-store',
        connection: 'close',
        'content-length': '0',
      });
      response.end();
      return;
    }

    if (path === '/metrics') {
      writeMetrics(response, repository);
      return;
    }

    if (path === 'other') {
      response.shouldKeepAlive = false;
      response.writeHead(404, {
        'cache-control': 'no-store',
        connection: 'close',
        'content-length': '0',
      });
      response.end();
      return;
    }

    if (path === config.graphqlPath) {
      if (!httpRequestLimiter.acquire(response)) {
        metrics.increment('indexer_http_admission_rejections_total', { method, path });
        response.shouldKeepAlive = false;
        response.writeHead(503, {
          'content-type': 'application/graphql-response+json; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'close',
          'retry-after': '1',
        });
        response.end(
          JSON.stringify({
            errors: [
              {
                message: 'GraphQL server is at its concurrent request limit. Retry later.',
                extensions: { code: 'SERVICE_UNAVAILABLE' },
              },
            ],
          })
        );
        return;
      }
      if (!executionMemoryBudget.acquire(response, config.graphqlMaxResultBytes)) {
        httpRequestLimiter.release(response);
        metrics.increment('indexer_graphql_execution_memory_rejections_total', { protocol: 'http' });
        response.shouldKeepAlive = false;
        response.writeHead(503, {
          'content-type': 'application/graphql-response+json; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'close',
          'retry-after': '1',
        });
        response.end(
          JSON.stringify({
            errors: [
              {
                message: 'GraphQL execution memory is at capacity. Retry later.',
                extensions: { code: 'GRAPHQL_EXECUTION_MEMORY_LIMIT_EXCEEDED' },
              },
            ],
          })
        );
        return;
      }

      metrics.setGauge('indexer_http_in_flight_requests', {}, httpRequestLimiter.activeRequests);
      updateExecutionMemoryMetrics();
      const release = (): void => {
        const releasedRequest = httpRequestLimiter.release(response);
        const releasedMemory = executionMemoryBudget.release(response);
        if (!releasedRequest && !releasedMemory) return;
        metrics.setGauge('indexer_http_in_flight_requests', {}, httpRequestLimiter.activeRequests);
        updateExecutionMemoryMetrics();
      };
      response.once('finish', release);
      response.once('close', release);
    }

    yoga(request, response);
  };
  const server = createServer({ maxHeaderSize: runtimeSecurity.httpMaxHeaderBytes }, handleRequest);
  server.maxConnections = runtimeSecurity.httpMaxConnections;
  server.maxRequestsPerSocket = runtimeSecurity.httpMaxRequestsPerSocket;
  server.on('drop', () => {
    metrics.increment('indexer_http_connection_rejections_total');
  });
  const webSocketLimiter = new WebSocketConnectionLimiter<WebSocket>(config.graphqlWsMaxConnections);
  const activeWebSocketsByClient = new Map<string, number>();
  const webSocketOperationBudget = new WebSocketOperationBudget(config.graphqlWsMaxOperations);
  const commonWebSocketOptions = {
    noServer: true as const,
    maxPayload: config.graphqlWsMaxPayloadBytes,
    perMessageDeflate: false,
  };
  const modernWsServer = new WebSocketServer({
    ...commonWebSocketOptions,
    handleProtocols: (protocols) =>
      protocols.has(GRAPHQL_TRANSPORT_WS_PROTOCOL) ? GRAPHQL_TRANSPORT_WS_PROTOCOL : false,
  });
  const legacyWsServer = new WebSocketServer({
    ...commonWebSocketOptions,
    handleProtocols: (protocols) =>
      protocols.has(LEGACY_GRAPHQL_WS_PROTOCOL) ? LEGACY_GRAPHQL_WS_PROTOCOL : false,
  });
  const trackWebSocketConnection = (protocol: 'modern' | 'legacy') => (
    socket: WebSocket,
    request: IncomingMessage
  ): void => {
    const client = request.socket.remoteAddress ?? 'unknown';
    if (
      (activeWebSocketsByClient.get(client) ?? 0) >=
        runtimeSecurity.graphqlWsMaxConnectionsPerClient
    ) {
      metrics.increment('indexer_websocket_admission_rejections_total', {
        reason: 'per-client-connection-limit',
      });
      socket.close(4429, 'Too many WebSocket connections');
      return;
    }
    if (!webSocketLimiter.acquire(socket)) {
      metrics.increment('indexer_websocket_admission_rejections_total', {
        reason: 'global-connection-limit',
      });
      socket.close(4429, 'Too many WebSocket connections');
      return;
    }
    activeWebSocketsByClient.set(client, (activeWebSocketsByClient.get(client) ?? 0) + 1);
    metrics.increment('indexer_websocket_connections_total', { protocol });
    metrics.setGauge('indexer_websocket_connections', {}, webSocketLimiter.activeConnections);
    socket.once('close', () => {
      webSocketLimiter.release(socket);
      const remaining = Math.max((activeWebSocketsByClient.get(client) ?? 1) - 1, 0);
      if (remaining === 0) activeWebSocketsByClient.delete(client);
      else activeWebSocketsByClient.set(client, remaining);
      metrics.setGauge('indexer_websocket_connections', {}, webSocketLimiter.activeConnections);
    });
  };
  modernWsServer.on('connection', trackWebSocketConnection('modern'));
  legacyWsServer.on('connection', trackWebSocketConnection('legacy'));

  const validationRules = [...specifiedRules, createGraphQLQueryLimitsRule(queryLimits)];
  const wsCleanup = useServer(
    {
      schema,
      validate: (validationSchema, document) =>
        validate(validationSchema, document, validationRules),
      context: () => createGraphQLExecutionContext(config, repository, workerStatusProvider),
      subscribe: emissionScopedSubscribe('modern'),
      connectionInitWaitTimeout: config.graphqlWsConnectionInitTimeoutMs,
      onSubscribe: (context, _id, payload) => {
        if (!checkWebSocketRate(context.extra.request).allowed) {
          return [webSocketRateLimitError()];
        }
        try {
          const operation = getOperationAST(parse(payload.query), payload.operationName);
          if (operation && operation.operation !== 'subscription') {
            return [
              new GraphQLError('Only GraphQL subscriptions are accepted over WebSocket.', {
                extensions: { code: 'GRAPHQL_WS_SUBSCRIPTION_ONLY' },
              }),
            ];
          }
        } catch {
          // The maintained graphql-ws parser reports malformed documents using
          // its standard protocol error path after this admission hook.
        }
        if (!webSocketOperationBudget.hasModernCapacity(context)) {
          return [
            new GraphQLError(
              `WebSocket server exceeds the ${config.graphqlWsMaxOperations} global operation limit.`,
              { extensions: { code: 'GRAPHQL_WS_GLOBAL_OPERATION_LIMIT_EXCEEDED' } }
            ),
          ];
        }
        if (
          hasWebSocketOperationCapacity(
            context.subscriptions,
            config.graphqlWsMaxOperationsPerConnection
          )
        ) {
          return;
        }
        return [
          new GraphQLError(
            `WebSocket connection exceeds the ${config.graphqlWsMaxOperationsPerConnection} operation limit.`,
            { extensions: { code: 'GRAPHQL_WS_OPERATION_LIMIT_EXCEEDED' } }
          ),
        ];
      },
      onClose: (context) => {
        webSocketOperationBudget.unregisterModern(context);
      },
      onNext: (_context, _id, _payload, _args, result) =>
        boundGraphQLExecutionResult(result, config.graphqlMaxResultBytes),
    },
    modernWsServer
  );
  const legacyWsCleanup = useLegacyGraphqlWebSocketServer(
    {
      schema,
      validate: (document) => validate(schema, document, validationRules),
      subscribe: emissionScopedSubscribe('legacy'),
      connectionInitWaitTimeoutMs: config.graphqlWsConnectionInitTimeoutMs,
      maxOperationsPerConnection: config.graphqlWsMaxOperationsPerConnection,
      maxPendingMessagesPerConnection: config.graphqlWsMaxPendingMessagesPerConnection,
      maxResultBytes: config.graphqlMaxResultBytes,
      admitOperation: (request) =>
        checkWebSocketRate(request).allowed ? true : webSocketRateLimitError(),
      acquireOperation: (operation) => webSocketOperationBudget.acquireLegacy(operation),
      releaseOperation: (operation) => {
        webSocketOperationBudget.releaseLegacy(operation);
      },
      context: () => createGraphQLExecutionContext(config, repository, workerStatusProvider),
    },
    legacyWsServer
  );

  server.on('upgrade', (request, socket, head) => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    } catch {
      rejectWebSocketUpgrade(socket, 404);
      return;
    }
    if (pathname !== config.graphqlPath) {
      rejectWebSocketUpgrade(socket, 404);
      return;
    }
    const client = request.socket.remoteAddress ?? 'unknown';
    const limited = checkWebSocketRate(request);
    if (!limited.allowed) {
      metrics.increment('indexer_websocket_admission_rejections_total', { reason: 'rate-limit' });
      rejectWebSocketUpgrade(
        socket,
        429,
        Math.max(1, Math.ceil((limited.resetAt - Date.now()) / 1_000))
      );
      return;
    }
    if (
      !webSocketLimiter.hasCapacity ||
      (activeWebSocketsByClient.get(client) ?? 0) >=
        runtimeSecurity.graphqlWsMaxConnectionsPerClient
    ) {
      metrics.increment('indexer_websocket_admission_rejections_total', { reason: 'capacity' });
      rejectWebSocketUpgrade(socket, 503);
      return;
    }

    const protocols = websocketProtocols(request.headers['sec-websocket-protocol']);
    if (
      !protocols.includes(LEGACY_GRAPHQL_WS_PROTOCOL) &&
      !protocols.includes(GRAPHQL_TRANSPORT_WS_PROTOCOL)
    ) {
      metrics.increment('indexer_websocket_admission_rejections_total', {
        reason: 'unsupported-protocol',
      });
      rejectWebSocketUpgrade(socket, 404);
      return;
    }
    const selected =
      protocols.includes(LEGACY_GRAPHQL_WS_PROTOCOL) && !protocols.includes(GRAPHQL_TRANSPORT_WS_PROTOCOL)
        ? legacyWsServer
        : modernWsServer;
    selected.handleUpgrade(request, socket, head, (webSocket) => {
      selected.emit('connection', webSocket, request);
    });
  });

  server.keepAliveTimeout = config.httpKeepAliveTimeoutMs;
  server.headersTimeout = config.httpHeadersTimeoutMs;
  server.requestTimeout = config.httpRequestTimeoutMs;

  try {
    await listen(server, config);
  } catch (error) {
    await Promise.resolve(wsCleanup.dispose()).catch(() => undefined);
    await legacyWsCleanup.dispose().catch(() => undefined);
    modernWsServer.close();
    legacyWsServer.close();
    await repository.close().catch(() => undefined);
    throw error;
  }

  console.info(`Polkaswap indexer listening on http://${config.host}:${config.port}${config.graphqlPath}`);

  let httpClosePromise: Promise<void> | null = null;
  const stopAccepting = (): void => {
    httpClosePromise ??= closeHttpServer(server, config.httpShutdownTimeoutMs);
    // The ordered shutdown owns the eventual rejection. Attach an observer at
    // admission-stop time so a close failure cannot become unhandled while the
    // worker is still draining.
    void httpClosePromise.catch(() => undefined);
  };
  const stop = idempotentShutdown(async () => {
    const shutdownDeadline = Date.now() + config.httpShutdownTimeoutMs;
    // Stop accepting HTTP requests and upgrades before waiting on any client
    // cleanup. Observe the promise immediately; it is awaited below after the
    // WebSocket transports have been drained.
    stopAccepting();
    const httpClose = httpClosePromise!;

    await runShutdownSteps([
      async () => {
        const results = await Promise.allSettled([
          closeWebSocketServer(modernWsServer, config.httpShutdownTimeoutMs),
          closeWebSocketServer(legacyWsServer, config.httpShutdownTimeoutMs),
        ]);
        throwFirstRejected(results);
      },
      async () => {
        const remainingMs = Math.max(shutdownDeadline - Date.now(), 1);
        const results = await Promise.allSettled([
          disposeWebSocketServer(() => wsCleanup.dispose(), remainingMs, 'Modern GraphQL WebSocket'),
          disposeWebSocketServer(() => legacyWsCleanup.dispose(), remainingMs, 'Legacy GraphQL WebSocket'),
        ]);
        throwFirstRejected(results);
      },
      () => httpClose,
      () => repository.close(),
    ]);
  });
  return {
    stopAccepting,
    stop,
  };
}
