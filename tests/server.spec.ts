import { createServer } from 'node:http';

import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { MemoryRepository } from '../src/repository/memory.js';
import {
  normalizeHttpMethodLabel,
  normalizeRequestPath,
  startServer,
} from '../src/server.js';

import type { AppConfig } from '../src/config.js';

vi.mock('../src/db/migrate.js', () => ({
  migrate: vi.fn().mockResolvedValue(undefined),
}));

const LEGACY_GRAPHQL_WS_PROTOCOL = 'graphql-ws';

const baseConfig = (port: number): AppConfig => ({
  host: '127.0.0.1',
  port,
  graphqlPath: '/graphql',
  httpListenBacklog: 4_096,
  httpShutdownTimeoutMs: 30_000,
  httpKeepAliveTimeoutMs: 75_000,
  httpHeadersTimeoutMs: 80_000,
  httpRequestTimeoutMs: 120_000,
  httpMaxConnections: 10_000,
  httpMaxHeaderBytes: 16_384,
  httpMaxRequestsPerSocket: 1_000,
  rateLimitWindowMs: 60_000,
  rateLimitMax: 600,
  rateLimitMaxKeys: 20_000,
  rateLimitGlobalWindowMs: 60_000,
  rateLimitGlobalMax: 50_000,
  graphqlHttpMaxBodyBytes: 262_144,
  graphqlHttpMaxInFlight: 100,
  graphqlMaxDepth: 12,
  graphqlMaxDocumentNodes: 2_000,
  graphqlMaxFields: 500,
  graphqlMaxAliases: 50,
  graphqlMaxFragmentSpreads: 100,
  graphqlMaxOperationCost: 100_000,
  graphqlAllowIntrospection: false,
  graphqlWsMaxPayloadBytes: 65_536,
  graphqlWsConnectionInitTimeoutMs: 30_000,
  graphqlWsMaxConnections: 1_000,
  graphqlWsMaxConnectionsPerClient: 16,
  graphqlWsMaxOperations: 2_000,
  graphqlWsMaxOperationsPerConnection: 20,
  graphqlWsMaxPendingMessagesPerConnection: 64,
  graphqlCacheMaxEntries: 1_000,
  graphqlCacheMaxBytes: 67_108_864,
  graphqlCacheTtlMs: 2_000,
  graphqlMaxResultBytes: 67_108_864,
  graphqlExecutionMemoryMaxBytes: 536_870_912,
  storageEngine: 'postgres',
  databaseUrl: 'postgres://polkaswap:polkaswap@localhost:5432/polkaswap_indexer',
  skipPostgresMigration: false,
  postgresPoolMax: 20,
  postgresListenPoolMax: 2,
  postgresConnectionTimeoutMs: 10_000,
  postgresQueryTimeoutMs: 120_000,
  postgresStatementTimeoutMs: 120_000,
  postgresMigrationQueryTimeoutMs: 0,
  postgresMigrationStatementTimeoutMs: 0,
  postgresWatchQueueMax: 1_000,
  postgresWatchReconnectMinDelayMs: 100,
  postgresWatchReconnectMaxDelayMs: 10_000,
  rocksdbPath: './data/polkaswap-indexer.rocksdb',
  rocksdbBlockCacheMb: 512,
  rocksdbWriteBufferManagerMb: 256,
  rocksdbParallelism: 4,
  rocksdbEnableStats: false,
  rocksdbDocumentCacheMax: 10_000,
  rocksdbDocumentCacheMaxBytes: 268_435_456,
  rocksdbWatchQueueMax: 1_000,
  rocksdbQueryMaxScannedRows: 100_000,
  rocksdbCompactionMinFreeGb: 10,
  soraWsEndpoint: 'wss://mof2.sora.org',
  chainStartBlock: 0,
  chainBatchSize: 25,
  stateRefreshIntervalBlocks: 250,
  snapshotIntervalBlocks: 250,
  fullReconciliationIntervalBlocks: 250,
  chainShutdownTimeoutMs: 30_000,
  chainRpcTimeoutMs: 15_000,
  chainRpcMaxInFlight: 256,
  derivedStorageLoadMaxBytes: 268_435_456,
  derivedStorageCacheMaxBytes: 67_108_864,
  analyticsInputCacheMaxBytes: 134_217_728,
  backfillPrefetchConcurrency: 1,
  finalizedCatchupPrefetchConcurrency: 1,
  priceStreamRefreshIntervalBlocks: 0,
  legacySoraBlockTypes: false,
  archiveSoraWsEndpoint: '',
  workerReadinessMaxLagBlocks: 25,
  workerReadinessMaxStalenessSeconds: 120,
  workerMetricsHost: '127.0.0.1',
  workerMetricsPort: 9464,
  workerMetricsMaxInFlight: 10,
});

const listenOnEphemeralPort = async (): Promise<{ port: number; close: () => Promise<void> }> => {
  const server = createServer((_request, response) => {
    response.end('busy');
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('Expected TCP listener address'));
    });
  });

  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
};

const readyWorker = () => {
  const now = Math.floor(Date.now() / 1_000);
  return {
    getStatus: () => ({
      lifecycle: 'running' as const,
      startupComplete: true,
      latestFinalizedBlock: 1_000,
      latestIndexedBlock: 995,
      lag: 5,
      lastSuccessfulIndexTimestamp: now,
      lastError: null,
      lastErrorTimestamp: null,
    }),
  };
};

const graphqlRequest = (port: number, signal?: AbortSignal): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: '{ _health { ok } }' }),
    signal,
  });

type WebSocketMessage = { id?: string; type: string; payload?: unknown };

const waitForWebSocketMessage = (
  socket: WebSocket,
  predicate: (message: WebSocketMessage) => boolean,
  timeoutMs = 2_000
): Promise<WebSocketMessage> =>
  new Promise<WebSocketMessage>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for WebSocket message'));
    }, timeoutMs);
    const onMessage = (raw: WebSocket.RawData) => {
      let message: WebSocketMessage;
      try {
        message = JSON.parse(raw.toString()) as WebSocketMessage;
      } catch {
        return;
      }
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onClose = (code: number) => {
      cleanup();
      reject(new Error(`WebSocket closed with code ${code} before the expected message`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('message', onMessage);
      socket.off('close', onClose);
    };
    socket.on('message', onMessage);
    socket.once('close', onClose);
  });

const openWebSocket = (url: string, protocol: string): Promise<WebSocket> =>
  new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url, protocol);
    const onOpen = () => {
      socket.off('error', onError);
      resolve(socket);
    };
    const onError = (error: Error) => {
      socket.off('open', onOpen);
      reject(error);
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
  });

describe('startServer', () => {
  it('caps oversized HTTP, modern WS, and legacy WS results before serialization', async ({ skip }) => {
    let reservation: Awaited<ReturnType<typeof listenOnEphemeralPort>>;
    try {
      reservation = await listenOnEphemeralPort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        skip('The execution sandbox does not permit loopback listeners; CI runs this transport assertion.');
        return;
      }
      throw error;
    }
    const port = reservation.port;
    await reservation.close();
    const repository = new MemoryRepository();
    await repository.upsert({
      collection: 'updatesStreams',
      id: 'oversized',
      data: { id: 'oversized', data: 'x'.repeat(16_000) },
    });
    const server = await startServer(
      { ...baseConfig(port), graphqlMaxResultBytes: 4_096 },
      repository,
      readyWorker()
    );
    let modern: WebSocket | null = null;
    let legacy: WebSocket | null = null;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ updatesStream(id: "oversized") { id data } }' }),
      });
      const body = await response.json() as {
        errors?: Array<{ extensions?: { code?: string } }>;
      };
      expect(body.errors?.[0]?.extensions?.code).toBe('GRAPHQL_RESULT_TOO_LARGE');

      modern = await openWebSocket(`ws://127.0.0.1:${port}/graphql`, 'graphql-transport-ws');
      legacy = await openWebSocket(`ws://127.0.0.1:${port}/graphql`, LEGACY_GRAPHQL_WS_PROTOCOL);
      const modernAck = waitForWebSocketMessage(modern, (message) => message.type === 'connection_ack');
      const legacyAck = waitForWebSocketMessage(legacy, (message) => message.type === 'connection_ack');
      modern.send(JSON.stringify({ type: 'connection_init' }));
      legacy.send(JSON.stringify({ type: 'connection_init' }));
      await Promise.all([modernAck, legacyAck]);

      const subscription = 'subscription { updatesStreams(id: ["oversized"]) { _entity } }';
      modern.send(JSON.stringify({ id: 'modern-cap', type: 'subscribe', payload: { query: subscription } }));
      legacy.send(JSON.stringify({ id: 'legacy-cap', type: 'start', payload: { query: subscription } }));
      const modernResult = waitForWebSocketMessage(
        modern,
        (message) => message.id === 'modern-cap' && message.type === 'next'
      );
      const legacyResult = waitForWebSocketMessage(
        legacy,
        (message) => message.id === 'legacy-cap' && message.type === 'data'
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      await repository.upsert({
        collection: 'updatesStreams',
        id: 'oversized',
        data: { id: 'oversized', data: 'y'.repeat(16_000) },
      });

      for (const message of await Promise.all([modernResult, legacyResult])) {
        const payload = message.payload as { errors?: Array<{ extensions?: { code?: string } }> };
        expect(payload.errors?.[0]?.extensions?.code).toBe('GRAPHQL_RESULT_TOO_LARGE');
      }
    } finally {
      modern?.close();
      legacy?.close();
      await server.stop();
    }
  });

  it('shares execution memory across HTTP and modern/legacy emissions without charging idle subscriptions', async ({ skip }) => {
    let reservation: Awaited<ReturnType<typeof listenOnEphemeralPort>>;
    try {
      reservation = await listenOnEphemeralPort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        skip('The execution sandbox does not permit loopback listeners; CI runs this contention assertion.');
        return;
      }
      throw error;
    }
    const port = reservation.port;
    await reservation.close();
    const repository = new MemoryRepository();
    await repository.upsertMany([
      { collection: 'updatesStreams', id: 'held', data: { id: 'held', data: 'held' } },
      { collection: 'updatesStreams', id: 'contended', data: { id: 'contended', data: 'before' } },
    ]);

    const originalGet = repository.get.bind(repository);
    let releaseHeldGet!: () => void;
    const heldGetGate = new Promise<void>((resolve) => {
      releaseHeldGet = resolve;
    });
    let notifyHeldGet!: () => void;
    const heldGetEntered = new Promise<void>((resolve) => {
      notifyHeldGet = resolve;
    });
    repository.get = async (collectionName, id) => {
      if (collectionName === 'updatesStreams' && id === 'held') {
        notifyHeldGet();
        await heldGetGate;
      }
      return originalGet(collectionName, id);
    };

    const originalWatch = repository.watch.bind(repository);
    let watcherCount = 0;
    let notifyWatchersReady!: () => void;
    const watchersReady = new Promise<void>((resolve) => {
      notifyWatchersReady = resolve;
    });
    repository.watch = async function* (collectionName, ids, signal) {
      watcherCount += 1;
      if (watcherCount === 2) notifyWatchersReady();
      yield* originalWatch(collectionName, ids, signal);
    };

    const maximumResultBytes = baseConfig(port).graphqlMaxResultBytes;
    const server = await startServer(
      {
        ...baseConfig(port),
        graphqlExecutionMemoryMaxBytes: maximumResultBytes,
      },
      repository,
      readyWorker()
    );
    let modern: WebSocket | null = null;
    let legacy: WebSocket | null = null;
    let httpRequest: Promise<Response> | null = null;

    try {
      modern = await openWebSocket(`ws://127.0.0.1:${port}/graphql`, 'graphql-transport-ws');
      legacy = await openWebSocket(`ws://127.0.0.1:${port}/graphql`, LEGACY_GRAPHQL_WS_PROTOCOL);
      const modernAck = waitForWebSocketMessage(modern, (message) => message.type === 'connection_ack');
      const legacyAck = waitForWebSocketMessage(legacy, (message) => message.type === 'connection_ack');
      modern.send(JSON.stringify({ type: 'connection_init' }));
      legacy.send(JSON.stringify({ type: 'connection_init' }));
      await Promise.all([modernAck, legacyAck]);

      const subscription = 'subscription { updatesStreams(id: ["contended"]) { id _entity } }';
      modern.send(JSON.stringify({ id: 'modern-memory', type: 'subscribe', payload: { query: subscription } }));
      legacy.send(JSON.stringify({ id: 'legacy-memory', type: 'start', payload: { query: subscription } }));
      await watchersReady;

      // If either idle subscription reserved result memory, this HTTP request
      // would be rejected before reaching the deliberately blocked resolver.
      httpRequest = fetch(`http://127.0.0.1:${port}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ updatesStream(id: "held") { id data } }' }),
      });
      await heldGetEntered;

      const modernRejected = waitForWebSocketMessage(
        modern,
        (message) => message.id === 'modern-memory' && message.type === 'next'
      );
      const legacyRejected = waitForWebSocketMessage(
        legacy,
        (message) => message.id === 'legacy-memory' && message.type === 'data'
      );
      await repository.upsert({
        collection: 'updatesStreams',
        id: 'contended',
        data: { id: 'contended', data: 'after' },
      });

      for (const message of await Promise.all([modernRejected, legacyRejected])) {
        expect(message.payload).toMatchObject({
          errors: [{ extensions: { code: 'GRAPHQL_EXECUTION_MEMORY_LIMIT_EXCEEDED' } }],
        });
      }

      releaseHeldGet();
      const response = await httpRequest;
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ data: { updatesStream: { id: 'held' } } });
    } finally {
      releaseHeldGet();
      await httpRequest?.catch(() => undefined);
      modern?.close();
      legacy?.close();
      await server.stop();
    }
  });

  it('rejects unscoped subscriptions on modern and legacy WebSocket protocols', async ({ skip }) => {
    let reservation: Awaited<ReturnType<typeof listenOnEphemeralPort>>;
    try {
      reservation = await listenOnEphemeralPort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        skip('The execution sandbox does not permit loopback listeners; CI runs this transport assertion.');
        return;
      }
      throw error;
    }
    const port = reservation.port;
    await reservation.close();
    const server = await startServer(baseConfig(port), new MemoryRepository(), readyWorker());
    let modern: WebSocket | null = null;
    let legacy: WebSocket | null = null;
    try {
      modern = await openWebSocket(`ws://127.0.0.1:${port}/graphql`, 'graphql-transport-ws');
      legacy = await openWebSocket(`ws://127.0.0.1:${port}/graphql`, LEGACY_GRAPHQL_WS_PROTOCOL);
      const modernAck = waitForWebSocketMessage(modern, (message) => message.type === 'connection_ack');
      const legacyAck = waitForWebSocketMessage(legacy, (message) => message.type === 'connection_ack');
      modern.send(JSON.stringify({ type: 'connection_init' }));
      legacy.send(JSON.stringify({ type: 'connection_init' }));
      await Promise.all([modernAck, legacyAck]);

      const modernRejected = waitForWebSocketMessage(
        modern,
        (message) =>
          message.id === 'modern-unscoped' && (message.type === 'next' || message.type === 'error')
      );
      const legacyRejected = waitForWebSocketMessage(
        legacy,
        (message) =>
          message.id === 'legacy-unscoped' && (message.type === 'data' || message.type === 'error')
      );
      modern.send(JSON.stringify({
        id: 'modern-unscoped',
        type: 'subscribe',
        payload: { query: 'subscription { updatesStreams { id } }' },
      }));
      legacy.send(JSON.stringify({
        id: 'legacy-unscoped',
        type: 'start',
        payload: { query: 'subscription { updatesStreams(id: []) { id } }' },
      }));
      const messages = await Promise.all([modernRejected, legacyRejected]);
      for (const message of messages) {
        const payload = message.payload as
          | Array<{ extensions?: { code?: string } }>
          | { errors?: Array<{ extensions?: { code?: string } }> };
        const errors = Array.isArray(payload) ? payload : payload.errors;
        expect(errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
      }
    } finally {
      modern?.close();
      legacy?.close();
      await server.stop();
    }
  });

  it('fails closed for malformed request targets and bounds attacker-selected metric labels', () => {
    expect(normalizeRequestPath('http://[::1', '/graphql')).toBe('other');
    expect(normalizeRequestPath('https://example.invalid/graphql', '/graphql')).toBe('/graphql');
    expect(normalizeRequestPath('/metrics?format=prometheus', '/graphql')).toBe('/metrics');

    const attackerLabels = new Set(
      Array.from({ length: 10_000 }, (_item, index) => normalizeHttpMethodLabel(`ATTACK-${index}`))
    );
    expect(attackerLabels).toEqual(new Set(['OTHER']));
    expect(normalizeHttpMethodLabel('get')).toBe('GET');
    expect(normalizeHttpMethodLabel(undefined)).toBe('OTHER');
  });

  it('rejects non-GET metrics requests and unknown paths before GraphQL body parsing', async ({ skip }) => {
    let reservation: Awaited<ReturnType<typeof listenOnEphemeralPort>>;
    try {
      reservation = await listenOnEphemeralPort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        skip('The execution sandbox does not permit loopback listeners; CI runs this socket-level assertion.');
        return;
      }
      throw error;
    }
    const port = reservation.port;
    await reservation.close();
    const repository = new MemoryRepository();
    const server = await startServer(baseConfig(port), repository, readyWorker());

    try {
      const metricsPost = await fetch(`http://127.0.0.1:${port}/metrics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"query":"{ _health { ok } }"}',
      });
      expect(metricsPost.status).toBe(405);
      expect(metricsPost.headers.get('allow')).toBe('GET, HEAD');

      const unknown = await fetch(`http://127.0.0.1:${port}/not-graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not-json',
      });
      expect(unknown.status).toBe(404);
      expect(unknown.headers.get('connection')).toBe('close');
    } finally {
      await server.stop();
    }
  });

  it('ignores spoofed forwarding headers and enforces bounded raw-peer request rates', async ({ skip }) => {
    let reservation: Awaited<ReturnType<typeof listenOnEphemeralPort>>;
    try {
      reservation = await listenOnEphemeralPort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        skip('The execution sandbox does not permit loopback listeners; CI runs this edge-limit assertion.');
        return;
      }
      throw error;
    }
    const port = reservation.port;
    await reservation.close();
    const server = await startServer(
      {
        ...baseConfig(port),
        rateLimitMax: 1,
        rateLimitGlobalMax: 10,
      },
      new MemoryRepository(),
      readyWorker()
    );

    try {
      const request = (spoofedClient: string) =>
        fetch(`http://127.0.0.1:${port}/graphql`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-forwarded-for': spoofedClient,
            forwarded: `for=${spoofedClient}`,
          },
          body: JSON.stringify({ query: '{ _health { ok } }' }),
        });
      expect((await request('198.51.100.1')).status).toBe(200);
      const rejected = await request('198.51.100.2');
      expect(rejected.status).toBe(429);
      expect(rejected.headers.get('retry-after')).toBe('60');
      expect(rejected.headers.get('x-ratelimit-remaining')).toBe('0');
      await expect(rejected.json()).resolves.toMatchObject({
        errors: [{ message: 'Too many requests.' }],
      });
    } finally {
      await server.stop();
    }
  });

  it('bounds concurrent WebSockets per raw peer independently of spoofed headers', async ({ skip }) => {
    let reservation: Awaited<ReturnType<typeof listenOnEphemeralPort>>;
    try {
      reservation = await listenOnEphemeralPort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        skip('The execution sandbox does not permit loopback listeners; CI runs this edge-limit assertion.');
        return;
      }
      throw error;
    }
    const port = reservation.port;
    await reservation.close();
    const server = await startServer(
      {
        ...baseConfig(port),
        graphqlWsMaxConnectionsPerClient: 1,
      },
      new MemoryRepository(),
      readyWorker()
    );
    let first: WebSocket | null = null;

    try {
      first = await openWebSocket(
        `ws://127.0.0.1:${port}/graphql`,
        'graphql-transport-ws'
      );
      const rejectedStatus = await new Promise<number>((resolve, reject) => {
        const second = new WebSocket(
          `ws://127.0.0.1:${port}/graphql`,
          'graphql-transport-ws',
          { headers: { 'x-forwarded-for': '198.51.100.99' } }
        );
        second.once('unexpected-response', (_request, response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
        second.once('open', () => reject(new Error('second WebSocket unexpectedly opened')));
        second.once('error', () => undefined);
      });
      expect(rejectedStatus).toBe(503);
    } finally {
      first?.close();
      await server.stop();
    }
  });

  it('rejects WebSocket upgrades that do not offer a supported GraphQL protocol', async ({ skip }) => {
    let reservation: Awaited<ReturnType<typeof listenOnEphemeralPort>>;
    try {
      reservation = await listenOnEphemeralPort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        skip('The execution sandbox does not permit loopback listeners; CI runs this protocol assertion.');
        return;
      }
      throw error;
    }
    const port = reservation.port;
    await reservation.close();
    const server = await startServer(baseConfig(port), new MemoryRepository(), readyWorker());

    try {
      const rejectedStatus = await new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/graphql`, 'unsupported-protocol');
        socket.once('unexpected-response', (_request, response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
        socket.once('open', () => reject(new Error('unsupported WebSocket protocol unexpectedly opened')));
        socket.once('error', () => undefined);
      });
      expect(rejectedStatus).toBe(404);
    } finally {
      await server.stop();
    }
  });

  it('rejects cleanly and closes the repository when the listen port is already in use', async ({ skip }) => {
    let blocker: Awaited<ReturnType<typeof listenOnEphemeralPort>>;
    try {
      blocker = await listenOnEphemeralPort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        skip('The execution sandbox does not permit loopback listeners; CI runs this socket-level assertion.');
        return;
      }
      throw error;
    }
    const repository = new MemoryRepository();
    const close = vi.spyOn(repository, 'close');

    try {
      await expect(startServer(baseConfig(blocker.port), repository)).rejects.toHaveProperty('code', 'EADDRINUSE');
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await blocker.close();
    }
  });

  it('rejects excess concurrent GraphQL work and releases admission on response finish', async ({ skip }) => {
    let reservation: Awaited<ReturnType<typeof listenOnEphemeralPort>>;
    try {
      reservation = await listenOnEphemeralPort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        skip('The execution sandbox does not permit loopback listeners; CI runs this socket-level assertion.');
        return;
      }
      throw error;
    }
    const port = reservation.port;
    await reservation.close();
    const repository = new MemoryRepository();
    let releaseHealth: (() => void) | undefined;
    const blockedHealth = new Promise<void>((resolve) => {
      releaseHealth = resolve;
    });
    const healthCheck = vi.fn(async () => {
      if (healthCheck.mock.calls.length === 1) await blockedHealth;
      return true;
    });
    repository.healthCheck = healthCheck;
    const server = await startServer(
      { ...baseConfig(port), graphqlHttpMaxInFlight: 1 },
      repository,
      readyWorker()
    );

    try {
      const first = graphqlRequest(port);
      await vi.waitFor(() => expect(healthCheck).toHaveBeenCalledOnce());

      const rejected = await graphqlRequest(port);
      expect(rejected.status).toBe(503);
      expect(rejected.headers.get('retry-after')).toBe('1');
      expect(rejected.headers.get('connection')).toBe('close');
      await expect(rejected.json()).resolves.toMatchObject({
        errors: [{ extensions: { code: 'SERVICE_UNAVAILABLE' } }],
      });

      releaseHealth?.();
      expect((await first).status).toBe(200);
      const admittedAgain = await graphqlRequest(port);
      expect(admittedAgain.status).toBe(200);
      expect(healthCheck).toHaveBeenCalledTimes(2);
    } finally {
      releaseHealth?.();
      await server.stop();
    }
  });

  it('releases HTTP admission when a client aborts an in-flight response', async ({ skip }) => {
    let reservation: Awaited<ReturnType<typeof listenOnEphemeralPort>>;
    try {
      reservation = await listenOnEphemeralPort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        skip('The execution sandbox does not permit loopback listeners; CI runs this socket-level assertion.');
        return;
      }
      throw error;
    }
    const port = reservation.port;
    await reservation.close();
    const repository = new MemoryRepository();
    let releaseHealth: (() => void) | undefined;
    const blockedHealth = new Promise<void>((resolve) => {
      releaseHealth = resolve;
    });
    const healthCheck = vi.fn(async () => {
      if (healthCheck.mock.calls.length === 1) await blockedHealth;
      return true;
    });
    repository.healthCheck = healthCheck;
    const server = await startServer(
      { ...baseConfig(port), graphqlHttpMaxInFlight: 1 },
      repository,
      readyWorker()
    );
    const abort = new AbortController();

    try {
      const abandoned = graphqlRequest(port, abort.signal).catch((error: unknown) => error);
      await vi.waitFor(() => expect(healthCheck).toHaveBeenCalledOnce());
      abort.abort();
      await abandoned;

      let admitted: Response | null = null;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const response = await graphqlRequest(port);
        if (response.status !== 503) {
          admitted = response;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(admitted?.status).toBe(200);
    } finally {
      releaseHealth?.();
      await server.stop();
    }
  });

  it('serves official-wallet subscriptions over bounded legacy graphql-ws framing', async ({ skip }) => {
    let reservation: Awaited<ReturnType<typeof listenOnEphemeralPort>>;
    try {
      reservation = await listenOnEphemeralPort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        skip('The execution sandbox does not permit loopback listeners; CI runs this socket-level assertion.');
        return;
      }
      throw error;
    }
    const port = reservation.port;
    await reservation.close();
    const repository = new MemoryRepository();
    const server = await startServer(baseConfig(port), repository, readyWorker());
    let socket: WebSocket | null = null;

    try {
      socket = await openWebSocket(`ws://127.0.0.1:${port}/graphql`, LEGACY_GRAPHQL_WS_PROTOCOL);
      expect(socket.protocol).toBe(LEGACY_GRAPHQL_WS_PROTOCOL);

      const acknowledgement = waitForWebSocketMessage(socket, (message) => message.type === 'connection_ack');
      socket.send(JSON.stringify({ type: 'connection_init', payload: {} }));
      await expect(acknowledgement).resolves.toMatchObject({ type: 'connection_ack' });

      socket.send(
        JSON.stringify({
          id: 'price-stream',
          type: 'start',
          payload: {
            query: `subscription OfficialWalletPriceStream {
              updatesStreams(id: ["price"], mutation: [UPDATE, INSERT]) {
                id
                mutation_type
                _entity
              }
            }`,
          },
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      const update = waitForWebSocketMessage(
        socket,
        (message) => message.id === 'price-stream' && message.type === 'data'
      );
      await repository.upsert({
        collection: 'updatesStreams',
        id: 'price',
        blockHeight: 1,
        timestamp: 1,
        data: { id: 'price', block: 1, data: '{"xor":"1"}' },
      });

      await expect(update).resolves.toMatchObject({
        id: 'price-stream',
        type: 'data',
        payload: {
          data: {
            updatesStreams: {
              id: 'price',
                mutation_type: 'INSERT',
              _entity: { id: 'price', block: 1, data: '{"xor":"1"}' },
            },
          },
        },
      });
      socket.send(JSON.stringify({ id: 'price-stream', type: 'stop' }));
    } finally {
      socket?.close(1000);
      await server.stop();
    }
  });

  it('keeps the maintained graphql-transport-ws protocol working beside the legacy adapter', async ({ skip }) => {
    let reservation: Awaited<ReturnType<typeof listenOnEphemeralPort>>;
    try {
      reservation = await listenOnEphemeralPort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        skip('The execution sandbox does not permit loopback listeners; CI runs this socket-level assertion.');
        return;
      }
      throw error;
    }
    const port = reservation.port;
    await reservation.close();
    const repository = new MemoryRepository();
    const server = await startServer(baseConfig(port), repository, readyWorker());
    let socket: WebSocket | null = null;

    try {
      socket = await openWebSocket(`ws://127.0.0.1:${port}/graphql`, 'graphql-transport-ws');
      expect(socket.protocol).toBe('graphql-transport-ws');
      const acknowledgement = waitForWebSocketMessage(socket, (message) => message.type === 'connection_ack');
      socket.send(JSON.stringify({ type: 'connection_init' }));
      await acknowledgement;

      socket.send(
        JSON.stringify({
          id: 'asset-registration',
          type: 'subscribe',
          payload: {
            query: 'subscription { updatesStreams(id: ["assetRegistration"]) { id mutation_type _entity } }',
          },
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      const update = waitForWebSocketMessage(
        socket,
        (message) => message.id === 'asset-registration' && message.type === 'next'
      );
      await repository.upsert({
        collection: 'updatesStreams',
        id: 'assetRegistration',
        blockHeight: 2,
        timestamp: 2,
        data: { id: 'assetRegistration', block: 2, data: '["xor"]' },
      });
      await expect(update).resolves.toMatchObject({
        id: 'asset-registration',
        type: 'next',
        payload: {
          data: {
            updatesStreams: {
              id: 'assetRegistration',
                mutation_type: 'INSERT',
              _entity: { id: 'assetRegistration', block: 2, data: '["xor"]' },
            },
          },
        },
      });
      socket.send(JSON.stringify({ id: 'asset-registration', type: 'complete' }));
    } finally {
      socket?.close(1000);
      await server.stop();
    }
  });

  it('rejects non-subscription operations on the modern WebSocket transport before execution', async ({ skip }) => {
    let reservation: Awaited<ReturnType<typeof listenOnEphemeralPort>>;
    try {
      reservation = await listenOnEphemeralPort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        skip('The execution sandbox does not permit loopback listeners; CI runs this socket-level assertion.');
        return;
      }
      throw error;
    }
    const port = reservation.port;
    await reservation.close();
    const repository = new MemoryRepository();
    const getSpy = vi.spyOn(repository, 'get');
    const server = await startServer(baseConfig(port), repository, readyWorker());
    let socket: WebSocket | null = null;

    try {
      socket = await openWebSocket(`ws://127.0.0.1:${port}/graphql`, 'graphql-transport-ws');
      const acknowledgement = waitForWebSocketMessage(socket, (message) => message.type === 'connection_ack');
      socket.send(JSON.stringify({ type: 'connection_init' }));
      await acknowledgement;

      const rejected = waitForWebSocketMessage(
        socket,
        (message) => message.id === 'ws-query' && message.type === 'error'
      );
      socket.send(JSON.stringify({
        id: 'ws-query',
        type: 'subscribe',
        payload: { query: 'query { updatesStream(id: "never-read") { id } }' },
      }));
      await expect(rejected).resolves.toMatchObject({
        payload: [{ extensions: { code: 'GRAPHQL_WS_SUBSCRIPTION_ONLY' } }],
      });
      expect(getSpy).not.toHaveBeenCalled();
    } finally {
      socket?.close(1000);
      await server.stop();
    }
  });

  it('enforces legacy initialization, subscription-only, and per-connection operation limits', async ({ skip }) => {
    let reservation: Awaited<ReturnType<typeof listenOnEphemeralPort>>;
    try {
      reservation = await listenOnEphemeralPort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        skip('The execution sandbox does not permit loopback listeners; CI runs this socket-level assertion.');
        return;
      }
      throw error;
    }
    const port = reservation.port;
    await reservation.close();
    const repository = new MemoryRepository();
    const server = await startServer(
      { ...baseConfig(port), graphqlWsMaxOperationsPerConnection: 1 },
      repository,
      readyWorker()
    );
    let socket: WebSocket | null = null;

    try {
      socket = await openWebSocket(`ws://127.0.0.1:${port}/graphql`, LEGACY_GRAPHQL_WS_PROTOCOL);
      const acknowledgement = waitForWebSocketMessage(socket, (message) => message.type === 'connection_ack');
      socket.send(JSON.stringify({ type: 'connection_init' }));
      await acknowledgement;

      socket.send(
        JSON.stringify({
          id: 'first',
          type: 'start',
          payload: { query: 'subscription { updatesStreams(id: ["price"]) { id } }' },
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 20));

      const limited = waitForWebSocketMessage(socket, (message) => message.id === 'second' && message.type === 'error');
      socket.send(
        JSON.stringify({
          id: 'second',
          type: 'start',
          payload: { query: 'subscription { updatesStreams(id: ["apy"]) { id } }' },
        })
      );
      await expect(limited).resolves.toMatchObject({
        id: 'second',
        type: 'error',
        payload: [{ message: expect.stringContaining('operation limit') }],
      });

      socket.send(JSON.stringify({ id: 'first', type: 'stop' }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      const queryRejected = waitForWebSocketMessage(socket, (message) => message.id === 'query' && message.type === 'error');
      socket.send(
        JSON.stringify({
          id: 'query',
          type: 'start',
          payload: { query: 'query { mobileConfig { soracard } }' },
        })
      );
      await expect(queryRejected).resolves.toMatchObject({
        payload: [{ message: expect.stringContaining('Only GraphQL subscriptions') }],
      });
    } finally {
      socket?.close(1000);
      await server.stop();
    }
  });

  it('enforces the global WebSocket operation budget on legacy protocol operations', async ({ skip }) => {
    let reservation: Awaited<ReturnType<typeof listenOnEphemeralPort>>;
    try {
      reservation = await listenOnEphemeralPort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        skip('The execution sandbox does not permit loopback listeners; CI runs this socket-level assertion.');
        return;
      }
      throw error;
    }
    const port = reservation.port;
    await reservation.close();
    const repository = new MemoryRepository();
    const server = await startServer(
      { ...baseConfig(port), graphqlWsMaxOperations: 1, graphqlWsMaxOperationsPerConnection: 20 },
      repository,
      readyWorker()
    );
    let socket: WebSocket | null = null;

    try {
      socket = await openWebSocket(`ws://127.0.0.1:${port}/graphql`, LEGACY_GRAPHQL_WS_PROTOCOL);
      const acknowledgement = waitForWebSocketMessage(socket, (message) => message.type === 'connection_ack');
      socket.send(JSON.stringify({ type: 'connection_init' }));
      await acknowledgement;
      socket.send(
        JSON.stringify({
          id: 'first-global',
          type: 'start',
          payload: { query: 'subscription { updatesStreams(id: ["price"]) { id } }' },
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 20));

      const rejected = waitForWebSocketMessage(
        socket,
        (message) => message.id === 'second-global' && message.type === 'error'
      );
      socket.send(
        JSON.stringify({
          id: 'second-global',
          type: 'start',
          payload: { query: 'subscription { updatesStreams(id: ["apy"]) { id } }' },
        })
      );
      await expect(rejected).resolves.toMatchObject({
        payload: [{ message: expect.stringContaining('global operation limit') }],
      });
      socket.send(JSON.stringify({ id: 'first-global', type: 'stop' }));
    } finally {
      socket?.close(1000);
      await server.stop();
    }
  });

  it('closes a legacy client that floods the serialized message queue', async ({ skip }) => {
    let reservation: Awaited<ReturnType<typeof listenOnEphemeralPort>>;
    try {
      reservation = await listenOnEphemeralPort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        skip('The execution sandbox does not permit loopback listeners; CI runs this socket-level assertion.');
        return;
      }
      throw error;
    }
    const port = reservation.port;
    await reservation.close();
    const repository = new MemoryRepository();
    const server = await startServer(
      { ...baseConfig(port), graphqlWsMaxPendingMessagesPerConnection: 1 },
      repository,
      readyWorker()
    );
    let socket: WebSocket | null = null;

    try {
      socket = await openWebSocket(`ws://127.0.0.1:${port}/graphql`, LEGACY_GRAPHQL_WS_PROTOCOL);
      const closeCode = new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Flooded legacy socket remained open')), 2_000);
        socket!.once('close', (code) => {
          clearTimeout(timeout);
          resolve(code);
        });
      });
      for (let index = 0; index < 100; index += 1) {
        socket.send(JSON.stringify({ type: 'unsupported', id: String(index) }));
      }
      await expect(closeCode).resolves.toBe(4429);
    } finally {
      socket?.terminate();
      await server.stop();
    }
  });

  it('closes idle legacy sockets that never initialize', async ({ skip }) => {
    let reservation: Awaited<ReturnType<typeof listenOnEphemeralPort>>;
    try {
      reservation = await listenOnEphemeralPort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        skip('The execution sandbox does not permit loopback listeners; CI runs this socket-level assertion.');
        return;
      }
      throw error;
    }
    const port = reservation.port;
    await reservation.close();
    const repository = new MemoryRepository();
    const server = await startServer(
      { ...baseConfig(port), graphqlWsConnectionInitTimeoutMs: 20 },
      repository,
      readyWorker()
    );
    let socket: WebSocket | null = null;

    try {
      socket = await openWebSocket(`ws://127.0.0.1:${port}/graphql`, LEGACY_GRAPHQL_WS_PROTOCOL);
      const closeCode = await new Promise<number>((resolve) => socket!.once('close', resolve));
      expect(closeCode).toBe(4408);
    } finally {
      socket?.terminate();
      await server.stop();
    }
  });
});
