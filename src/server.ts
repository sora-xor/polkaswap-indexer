import { createServer } from 'node:http';

import { createYoga } from 'graphql-yoga';
import { parse as parseGraphql, type ValidationRule } from 'graphql';
import { useServer } from 'graphql-ws/use/ws';
import { WebSocketServer } from 'ws';

import { readConfig, readRuntimeSecurityConfig, type AppConfig, type RuntimeSecurityConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { analyzeGraphqlDocument, createBoundedGraphqlBodyPlugin, createGraphqlSecurityRule } from './graphql/security.js';
import { createSchema } from './graphql/resolvers.js';
import { AbuseLimiter } from './http/abuseLimiter.js';
import { metrics } from './metrics.js';
import { PostgresRepository } from './repository/postgres.js';

import type { IndexerRepository } from './repository/types.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

export type ServerHandle = {
  stop: () => Promise<void>;
};

const secondsSince = (startedAt: number): number => (Date.now() - startedAt) / 1000;

const normalizeRequestPath = (url: string | undefined, graphqlPath: string): string => {
  const path = new URL(url ?? '/', 'http://localhost').pathname;

  if (path === graphqlPath) return graphqlPath;
  if (path === '/metrics') return '/metrics';

  return 'other';
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

const writeJsonError = (response: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void => {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'access-control-allow-origin': '*',
    ...headers,
  });
  response.end(JSON.stringify({ errors: [{ message }] }));
};

const listen = (
  server: ReturnType<typeof createServer>,
  config: AppConfig,
  security: RuntimeSecurityConfig
): Promise<void> =>
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
      backlog: security.httpListenBacklog,
    });
  });

const closeHttpServer = (server: ReturnType<typeof createServer>, shutdownTimeoutMs: number): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const forceShutdownTimer = setTimeout(() => {
      server.closeAllConnections?.();
    }, shutdownTimeoutMs);
    forceShutdownTimer.unref();

    server.close((error) => {
      clearTimeout(forceShutdownTimer);
      if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections?.();
  });

/**
 * Starts the Polkaswap indexer GraphQL API.
 */
export async function startServer(
  config: AppConfig = readConfig(),
  repository: IndexerRepository = new PostgresRepository(config.databaseUrl),
  security: RuntimeSecurityConfig = readRuntimeSecurityConfig()
): Promise<ServerHandle> {
  await migrate(config.databaseUrl);

  const schema = createSchema();
  const graphqlSecurityLimits = {
    maxDepth: security.graphqlMaxDepth,
    maxFields: security.graphqlMaxFields,
    maxAliases: security.graphqlMaxAliases,
    allowIntrospection: security.graphqlAllowIntrospection,
  };
  const graphqlSecurityRule = createGraphqlSecurityRule(graphqlSecurityLimits);
  const yoga = createYoga({
    schema,
    graphqlEndpoint: config.graphqlPath,
    context: () => ({ repository }),
    cors: {
      origin: '*',
      credentials: false,
    },
    batching: false,
    multipart: false,
    graphiql: security.graphqlAllowIntrospection,
    landingPage: false,
    plugins: [
      createBoundedGraphqlBodyPlugin(security.httpMaxBodyBytes),
      {
        onValidate({ addValidationRule }: { addValidationRule: (rule: ValidationRule) => void }) {
          addValidationRule(graphqlSecurityRule);
        },
      },
    ],
  });

  let activeWebSockets = 0;
  const activeWebSocketsByClient = new Map<string, number>();
  const wsOperations = new WeakMap<object, Set<string>>();
  const abuseLimiter = new AbuseLimiter({
    windowMs: security.rateLimitWindowMs,
    max: security.rateLimitMax,
    maxKeys: security.rateLimitMaxKeys,
    globalWindowMs: security.rateLimitGlobalWindowMs,
    globalMax: security.rateLimitGlobalMax,
  });
  const server = createServer({ maxHeaderSize: security.httpMaxHeaderBytes }, (request: IncomingMessage, response: ServerResponse) => {
    const startedAt = Date.now();
    const path = normalizeRequestPath(request.url, config.graphqlPath);
    const method = request.method ?? 'UNKNOWN';
    response.setHeader('x-content-type-options', 'nosniff');

    response.once('finish', () => {
      const labels = { method, path, status: response.statusCode };

      metrics.increment('indexer_http_requests_total', labels);
      metrics.observe('indexer_http_request_duration_seconds', labels, secondsSince(startedAt));
    });

    const now = Date.now();
    const client = request.socket.remoteAddress ?? 'unknown';
    const limited = abuseLimiter.check(client, now);
    response.setHeader('x-ratelimit-limit', String(limited.limit));
    response.setHeader('x-ratelimit-remaining', String(limited.remaining));
    response.setHeader('x-ratelimit-reset', String(Math.ceil(limited.resetAt / 1000)));
    if (!limited.allowed) {
      request.resume();
      writeJsonError(response, 429, 'Too many requests.', {
        'retry-after': String(Math.max(1, Math.ceil((limited.resetAt - now) / 1000))),
      });
      return;
    }

    if (path === '/metrics') {
      if (method !== 'GET' && method !== 'HEAD') {
        request.resume();
        writeJsonError(response, 405, 'Method not allowed.', { allow: 'GET, HEAD' });
        return;
      }
      writeMetrics(response, repository);
      return;
    }

    const contentLength = request.headers['content-length'];
    if (
      path === config.graphqlPath &&
      method === 'POST' &&
      (Array.isArray(contentLength) ||
        (contentLength !== undefined &&
          (!/^(0|[1-9][0-9]*)$/.test(contentLength) || Number(contentLength) > security.httpMaxBodyBytes)))
    ) {
      request.resume();
      writeJsonError(response, 413, 'Payload too large.');
      return;
    }

    yoga(request, response);
  });
  server.maxConnections = security.httpMaxConnections;
  server.maxRequestsPerSocket = security.httpMaxRequestsPerSocket;
  const wsServer = new WebSocketServer({
    server,
    path: config.graphqlPath,
    maxPayload: security.graphqlWsMaxPayloadBytes,
    perMessageDeflate: false,
    verifyClient(info, done) {
      const client = info.req.socket.remoteAddress ?? 'unknown';
      const limited = abuseLimiter.check(`ws:${client}`);
      if (!limited.allowed) {
        done(false, 429, 'WebSocket rate limit exceeded');
        return;
      }
      const clientConnections = activeWebSocketsByClient.get(client) ?? 0;
      if (
        activeWebSockets >= security.graphqlWsMaxConnections ||
        clientConnections >= security.graphqlWsMaxConnectionsPerClient
      ) {
        done(false, 503, 'WebSocket connection limit exceeded');
        return;
      }
      done(true);
    },
  });
  wsServer.on('connection', (socket, request) => {
    const client = request.socket.remoteAddress ?? 'unknown';
    activeWebSockets += 1;
    activeWebSocketsByClient.set(client, (activeWebSocketsByClient.get(client) ?? 0) + 1);
    metrics.setGauge('indexer_websocket_connections', {}, activeWebSockets);
    socket.once('close', () => {
      activeWebSockets = Math.max(activeWebSockets - 1, 0);
      const remaining = Math.max((activeWebSocketsByClient.get(client) ?? 1) - 1, 0);
      if (remaining === 0) activeWebSocketsByClient.delete(client);
      else activeWebSocketsByClient.set(client, remaining);
      wsOperations.delete(socket);
      metrics.setGauge('indexer_websocket_connections', {}, activeWebSockets);
    });
  });
  const wsCleanup = useServer(
    {
      schema,
      context: () => ({ repository }),
      connectionInitWaitTimeout: security.graphqlWsConnectionInitTimeoutMs,
      onSubscribe(ctx, id, payload) {
        const client = ctx.extra.request.socket.remoteAddress ?? 'unknown';
        if (!abuseLimiter.check(`ws:${client}`).allowed) {
          throw new Error('WebSocket rate limit exceeded.');
        }
        let operations = wsOperations.get(ctx.extra.socket);
        if (!operations) {
          operations = new Set();
          wsOperations.set(ctx.extra.socket, operations);
        }
        if (operations.size >= security.graphqlWsMaxOperationsPerConnection) {
          throw new Error('WebSocket operation limit exceeded.');
        }
        try {
          const securityErrors = analyzeGraphqlDocument(parseGraphql(payload.query), graphqlSecurityLimits);
          if (securityErrors.length > 0) throw new Error(securityErrors[0].message);
        } catch (error) {
          if (error instanceof Error && /^(GraphQL query|GraphQL schema)/.test(error.message)) throw error;
          return;
        }
        operations.add(id);
      },
      onError(ctx, id) {
        wsOperations.get(ctx.extra.socket)?.delete(id);
      },
      onComplete(ctx, id) {
        wsOperations.get(ctx.extra.socket)?.delete(id);
      },
    },
    wsServer
  );
  server.keepAliveTimeout = security.httpKeepAliveTimeoutMs;
  server.headersTimeout = security.httpHeadersTimeoutMs;
  server.requestTimeout = security.httpRequestTimeoutMs;

  try {
    await listen(server, config, security);
  } catch (error) {
    await Promise.resolve(wsCleanup.dispose()).catch(() => undefined);
    wsServer.close();
    await repository.close().catch(() => undefined);
    throw error;
  }

  console.info(`Polkaswap indexer listening on http://${config.host}:${config.port}${config.graphqlPath}`);

  return {
    stop: async () => {
      await Promise.resolve(wsCleanup.dispose());
      wsServer.close();
      await closeHttpServer(server, security.httpShutdownTimeoutMs);
      await repository.close();
    },
  };
}
