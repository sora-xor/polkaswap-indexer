import { createServer } from 'node:http';

import { createYoga } from 'graphql-yoga';
import { useServer } from 'graphql-ws/use/ws';
import { WebSocketServer } from 'ws';

import { readConfig, type AppConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createSchema } from './graphql/resolvers.js';
import { metrics } from './metrics.js';
import { createRepository, shouldRunPostgresMigration } from './repository/factory.js';

import type { IndexerRepository } from './repository/types.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

export type ServerHandle = {
  stop: () => Promise<void>;
};

const readPositiveInteger = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);

  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
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
      backlog: readPositiveInteger('HTTP_LISTEN_BACKLOG', 4_096),
    });
  });

const closeHttpServer = (server: ReturnType<typeof createServer>): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const forceShutdownTimer = setTimeout(() => {
      server.closeAllConnections?.();
    }, readPositiveInteger('HTTP_SHUTDOWN_TIMEOUT_MS', 30_000));
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
  repository: IndexerRepository = createRepository(config)
): Promise<ServerHandle> {
  if (process.env.SKIP_POSTGRES_MIGRATION !== 'true' && shouldRunPostgresMigration(config)) await migrate(config.databaseUrl);
  await repository.prepare?.();

  const schema = createSchema();
  const yoga = createYoga({
    schema,
    graphqlEndpoint: config.graphqlPath,
    context: () => ({ repository }),
    cors: {
      origin: '*',
      credentials: false,
    },
  });

  let activeWebSockets = 0;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const startedAt = Date.now();
    const path = normalizeRequestPath(request.url, config.graphqlPath);
    const method = request.method ?? 'UNKNOWN';

    response.once('finish', () => {
      const labels = { method, path, status: response.statusCode };

      metrics.increment('indexer_http_requests_total', labels);
      metrics.observe('indexer_http_request_duration_seconds', labels, secondsSince(startedAt));
    });

    if (path === '/metrics') {
      writeMetrics(response, repository);
      return;
    }

    yoga(request, response);
  });
  const wsServer = new WebSocketServer({
    server,
    path: config.graphqlPath,
    maxPayload: readPositiveInteger('GRAPHQL_WS_MAX_PAYLOAD_BYTES', 64 * 1024),
    perMessageDeflate: false,
  });
  wsServer.on('connection', (socket) => {
    activeWebSockets += 1;
    metrics.setGauge('indexer_websocket_connections', {}, activeWebSockets);
    socket.once('close', () => {
      activeWebSockets = Math.max(activeWebSockets - 1, 0);
      metrics.setGauge('indexer_websocket_connections', {}, activeWebSockets);
    });
  });
  const wsCleanup = useServer(
    {
      schema,
      context: () => ({ repository }),
      connectionInitWaitTimeout: readPositiveInteger('GRAPHQL_WS_CONNECTION_INIT_TIMEOUT_MS', 30_000),
    },
    wsServer
  );
  const keepAliveTimeoutMs = readPositiveInteger('HTTP_KEEP_ALIVE_TIMEOUT_MS', 75_000);

  server.keepAliveTimeout = keepAliveTimeoutMs;
  server.headersTimeout = readPositiveInteger('HTTP_HEADERS_TIMEOUT_MS', keepAliveTimeoutMs + 5_000);
  server.requestTimeout = readPositiveInteger('HTTP_REQUEST_TIMEOUT_MS', 120_000);

  try {
    await listen(server, config);
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
      await closeHttpServer(server);
      await repository.close();
    },
  };
}
