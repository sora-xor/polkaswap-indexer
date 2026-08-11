import { createServer } from 'node:http';

import type { AppConfig } from '../config.js';
import { HttpRequestLimiter } from '../graphql/transport.js';
import { metrics } from '../metrics.js';
import { evaluateServiceReadiness } from '../readiness.js';
import type { IndexerRepository } from '../repository/types.js';
import { idempotentShutdown } from '../shutdown.js';
import { publishChainIndexerStatusMetrics, type ChainIndexerStatusProvider } from './status.js';

import type { IncomingMessage, ServerResponse } from 'node:http';

export type WorkerObservabilityHandle = {
  stopAccepting(): void;
  stop(): Promise<void>;
};

export type WorkerObservabilityResponse = {
  statusCode: number;
  contentType: string;
  body: string;
  headers?: Record<string, string>;
};

const jsonResponse = (
  statusCode: number,
  body: unknown,
  headers?: Record<string, string>
): WorkerObservabilityResponse => ({
  statusCode,
  contentType: 'application/json; charset=utf-8',
  body: `${JSON.stringify(body)}\n`,
  ...(headers ? { headers } : {}),
});

const publishRepositoryMetrics = (repository: IndexerRepository): void => {
  for (const [name, value] of Object.entries(repository.metricsSnapshot?.() ?? {})) {
    metrics.setGauge(name, {}, value);
  }
};

export async function buildWorkerObservabilityResponse(
  method: string,
  pathname: string,
  config: AppConfig,
  repository: IndexerRepository,
  workerStatusProvider: ChainIndexerStatusProvider
): Promise<WorkerObservabilityResponse> {
  if (method !== 'GET') {
    return jsonResponse(405, { ok: false, error: 'method-not-allowed' }, {
      allow: 'GET',
      connection: 'close',
    });
  }

  if (pathname === '/health') {
    const readiness = await evaluateServiceReadiness(
      repository,
      workerStatusProvider,
      {
        maxLagBlocks: config.workerReadinessMaxLagBlocks,
        maxStalenessSeconds: config.workerReadinessMaxStalenessSeconds,
      }
    );
    return jsonResponse(readiness.ok ? 200 : 503, {
      ok: readiness.ok,
      repositoryReady: readiness.repositoryReady,
      workerAvailable: readiness.worker.available,
      workerReady: readiness.worker.ready,
      workerReadinessReason: readiness.worker.reason,
      worker: readiness.worker.status,
    });
  }

  if (pathname === '/metrics') {
    publishRepositoryMetrics(repository);
    publishChainIndexerStatusMetrics(workerStatusProvider.getStatus());
    return {
      statusCode: 200,
      contentType: 'text/plain; version=0.0.4; charset=utf-8',
      body: metrics.render(),
    };
  }

  return jsonResponse(404, { ok: false, error: 'not-found' });
}

const sendResponse = (response: ServerResponse, result: WorkerObservabilityResponse): void => {
  response.writeHead(result.statusCode, {
    'content-type': result.contentType,
    'cache-control': 'no-store',
    ...result.headers,
  });
  response.end(result.body);
};

export function createWorkerObservabilityServer(
  config: AppConfig,
  repository: IndexerRepository,
  workerStatusProvider: ChainIndexerStatusProvider
): ReturnType<typeof createServer> {
  const requestLimiter = new HttpRequestLimiter<ServerResponse>(config.workerMetricsMaxInFlight);
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (!requestLimiter.acquire(response)) {
      response.shouldKeepAlive = false;
      metrics.increment('indexer_worker_observability_admission_rejections_total');
      sendResponse(
        response,
        jsonResponse(503, { ok: false, error: 'too-many-in-flight-requests' }, {
          connection: 'close',
          'retry-after': '1',
        })
      );
      return;
    }
    metrics.setGauge(
      'indexer_worker_observability_in_flight_requests',
      {},
      requestLimiter.activeRequests
    );
    const release = (): void => {
      if (!requestLimiter.release(response)) return;
      metrics.setGauge(
        'indexer_worker_observability_in_flight_requests',
        {},
        requestLimiter.activeRequests
      );
    };
    response.once('finish', release);
    response.once('close', release);

    let pathname = '/';
    try {
      pathname = new URL(request.url ?? '/', 'http://worker.local').pathname;
    } catch {
      sendResponse(response, jsonResponse(400, { ok: false, error: 'invalid-url' }));
      return;
    }

    void buildWorkerObservabilityResponse(
      request.method ?? 'UNKNOWN',
      pathname,
      config,
      repository,
      workerStatusProvider
    ).then(
      (result) => sendResponse(response, result),
      () => sendResponse(response, jsonResponse(500, { ok: false, error: 'observability-failed' }))
    );
  });
  server.maxConnections = config.httpMaxConnections;
  server.keepAliveTimeout = config.httpKeepAliveTimeoutMs;
  server.headersTimeout = config.httpHeadersTimeoutMs;
  server.requestTimeout = config.httpRequestTimeoutMs;
  server.on('drop', () => {
    metrics.increment('indexer_worker_observability_connection_rejections_total');
  });
  return server;
}

const listen = (server: ReturnType<typeof createServer>, config: AppConfig): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({
      host: config.workerMetricsHost,
      port: config.workerMetricsPort,
      backlog: config.httpListenBacklog,
    });
  });

const close = (server: ReturnType<typeof createServer>, timeoutMs: number): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => server.closeAllConnections?.(), timeoutMs);
    timeout.unref?.();
    server.close((error) => {
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections?.();
  });

export async function startWorkerObservabilityServer(
  config: AppConfig,
  repository: IndexerRepository,
  workerStatusProvider: ChainIndexerStatusProvider
): Promise<WorkerObservabilityHandle> {
  const server = createWorkerObservabilityServer(config, repository, workerStatusProvider);
  try {
    await listen(server, config);
  } catch (error) {
    server.close();
    throw error;
  }

  const displayHost = config.workerMetricsHost.includes(':') ? `[${config.workerMetricsHost}]` : config.workerMetricsHost;
  console.info(`Polkaswap worker observability listening on http://${displayHost}:${config.workerMetricsPort}`);
  let closePromise: Promise<void> | null = null;
  const stopAccepting = (): void => {
    closePromise ??= close(server, config.chainShutdownTimeoutMs);
    void closePromise.catch(() => undefined);
  };
  return {
    stopAccepting,
    stop: idempotentShutdown(() => {
      stopAccepting();
      return closePromise!;
    }),
  };
}
