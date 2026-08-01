import { createServer, request as httpRequest } from 'node:http';

import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { MemoryRepository } from '../src/repository/memory.js';

import type { AppConfig, RuntimeSecurityConfig } from '../src/config.js';

vi.mock('../src/db/migrate.js', () => ({
  migrate: vi.fn().mockResolvedValue(undefined),
}));

const { startServer } = await import('../src/server.js');

const baseConfig = (port: number): AppConfig => ({
  host: '127.0.0.1',
  port,
  graphqlPath: '/graphql',
  databaseUrl: 'postgres://polkaswap:polkaswap@localhost:5432/polkaswap_indexer',
  soraWsEndpoint: 'wss://mof2.sora.org',
  chainStartBlock: 0,
  chainBatchSize: 25,
  stateRefreshIntervalBlocks: 250,
  snapshotIntervalBlocks: 250,
});

const baseSecurity = (overrides: Partial<RuntimeSecurityConfig> = {}): RuntimeSecurityConfig => ({
  httpMaxBodyBytes: 64 * 1024,
  httpMaxHeaderBytes: 16 * 1024,
  httpListenBacklog: 128,
  httpShutdownTimeoutMs: 2_000,
  httpKeepAliveTimeoutMs: 5_000,
  httpHeadersTimeoutMs: 6_000,
  httpRequestTimeoutMs: 5_000,
  httpMaxConnections: 128,
  httpMaxRequestsPerSocket: 100,
  rateLimitWindowMs: 60_000,
  rateLimitMax: 100,
  rateLimitMaxKeys: 100,
  rateLimitGlobalWindowMs: 60_000,
  rateLimitGlobalMax: 1_000,
  graphqlMaxDepth: 12,
  graphqlMaxFields: 300,
  graphqlMaxAliases: 50,
  graphqlAllowIntrospection: false,
  graphqlWsMaxPayloadBytes: 64 * 1024,
  graphqlWsMaxConnections: 16,
  graphqlWsMaxConnectionsPerClient: 8,
  graphqlWsMaxOperationsPerConnection: 8,
  graphqlWsConnectionInitTimeoutMs: 2_000,
  ...overrides,
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

const availablePort = async (): Promise<number> => {
  const reservation = await listenOnEphemeralPort();
  await reservation.close();
  return reservation.port;
};

const postChunked = (port: number, chunks: string[]): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/graphql',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
      },
      (response) => {
        const body: Buffer[] = [];
        response.on('data', (chunk) => body.push(Buffer.from(chunk)));
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(body).toString('utf8') })
        );
      }
    );
    request.once('error', reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });

describe('startServer', () => {
  it('rejects cleanly and closes the repository when the listen port is already in use', async () => {
    const blocker = await listenOnEphemeralPort();
    const repository = new MemoryRepository();
    const close = vi.spyOn(repository, 'close');

    try {
      await expect(startServer(baseConfig(blocker.port), repository)).rejects.toHaveProperty('code', 'EADDRINUSE');
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await blocker.close();
    }
  });

  it('bounds declared and chunked GraphQL bodies, rejects batching, and disables introspection', async () => {
    const port = await availablePort();
    const handle = await startServer(baseConfig(port), new MemoryRepository(), baseSecurity({ httpMaxBodyBytes: 1_024 }));
    try {
      const oversized = await fetch(`http://127.0.0.1:${port}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ _health { ok } }', padding: 'x'.repeat(2_000) }),
      });
      expect(oversized.status).toBe(413);
      expect(oversized.headers.get('access-control-allow-origin')).toBe('*');
      expect(await oversized.text()).toContain('Payload too large');

      const chunked = await postChunked(port, [
        '{"query":"{ _health { ok } }","padding":"',
        'x'.repeat(2_000),
        '"}',
      ]);
      expect(chunked.status).toBe(413);
      expect(chunked.body).toContain('Payload too large');

      const batched = await fetch(`http://127.0.0.1:${port}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([{ query: '{ _health { ok } }' }]),
      });
      expect(batched.status).toBe(400);
      expect(await batched.text()).toContain('batching is disabled');

      const legacyGraphql = await fetch(`http://127.0.0.1:${port}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/graphql' },
        body: '{ _health { ok } }',
      });
      expect(legacyGraphql.status).toBe(200);
      expect((await legacyGraphql.json()).data._health.ok).toBe(false);

      const invalidUtf8 = await fetch(`http://127.0.0.1:${port}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: new Uint8Array([0xc3, 0x28]),
      });
      expect(invalidUtf8.status).toBe(400);
      expect(await invalidUtf8.text()).toContain('Invalid UTF-8 body');

      const compressed = await fetch(`http://127.0.0.1:${port}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
        body: '{}',
      });
      expect(compressed.status).toBe(415);
      expect(await compressed.text()).toContain('Unsupported content encoding');

      const formEncoded = await fetch(`http://127.0.0.1:${port}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'query=%7B_health%7Bok%7D%7D',
      });
      expect(formEncoded.status).toBe(415);
      expect(await formEncoded.text()).toContain('Unsupported media type');

      const introspection = await fetch(`http://127.0.0.1:${port}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ __schema { queryType { name } } }' }),
      });
      expect(introspection.status).toBe(400);
      expect(await introspection.text()).toContain('introspection is disabled');
    } finally {
      await handle.stop();
    }
  });

  it('ignores spoofed forwarding headers and enforces the per-client HTTP limit', async () => {
    const port = await availablePort();
    const handle = await startServer(baseConfig(port), new MemoryRepository(), baseSecurity({ rateLimitMax: 1 }));
    try {
      const request = (spoofedIp: string) =>
        fetch(`http://127.0.0.1:${port}/graphql`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': spoofedIp },
          body: JSON.stringify({ query: '{ _health { ok } }' }),
        });
      expect((await request('198.51.100.1')).status).toBe(200);
      const limited = await request('198.51.100.2');
      expect(limited.status).toBe(429);
      expect(limited.headers.get('access-control-allow-origin')).toBe('*');
      expect(await limited.text()).toContain('Too many requests');
    } finally {
      await handle.stop();
    }
  });

  it('rejects WebSocket handshakes beyond the global and per-client connection cap', async () => {
    const port = await availablePort();
    const handle = await startServer(
      baseConfig(port),
      new MemoryRepository(),
      baseSecurity({ graphqlWsMaxConnections: 1, graphqlWsMaxConnectionsPerClient: 1 })
    );
    const first = new WebSocket(`ws://127.0.0.1:${port}/graphql`, 'graphql-transport-ws');
    await new Promise<void>((resolve, reject) => {
      first.once('open', resolve);
      first.once('error', reject);
    });
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const second = new WebSocket(`ws://127.0.0.1:${port}/graphql`, 'graphql-transport-ws');
        second.once('unexpected-response', (_request, response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
        second.once('open', () => reject(new Error('second WebSocket unexpectedly opened')));
        second.once('error', () => undefined);
      });
      expect(status).toBe(503);
    } finally {
      first.close();
      await new Promise((resolve) => first.once('close', resolve));
      await handle.stop();
    }
  });

  it('rate-limits WebSocket handshake churn by raw socket identity', async () => {
    const port = await availablePort();
    const handle = await startServer(baseConfig(port), new MemoryRepository(), baseSecurity({ rateLimitMax: 1 }));
    const first = new WebSocket(`ws://127.0.0.1:${port}/graphql`, 'graphql-transport-ws');
    await new Promise<void>((resolve, reject) => {
      first.once('open', resolve);
      first.once('error', reject);
    });
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const second = new WebSocket(`ws://127.0.0.1:${port}/graphql`, 'graphql-transport-ws');
        second.once('unexpected-response', (_request, response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
        second.once('open', () => reject(new Error('rate-limited WebSocket unexpectedly opened')));
        second.once('error', () => undefined);
      });
      expect(status).toBe(429);
    } finally {
      first.close();
      await new Promise((resolve) => first.once('close', resolve));
      await handle.stop();
    }
  });

  it('closes WebSocket clients that exceed the configured message payload ceiling', async () => {
    const port = await availablePort();
    const handle = await startServer(
      baseConfig(port),
      new MemoryRepository(),
      baseSecurity({ graphqlWsMaxPayloadBytes: 1_024 })
    );
    const socket = new WebSocket(`ws://127.0.0.1:${port}/graphql`, 'graphql-transport-ws');
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    let expectedSocketError: ReturnType<typeof vi.spyOn> | undefined;
    try {
      expectedSocketError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
      socket.send(JSON.stringify({ type: 'connection_init', payload: { padding: 'x'.repeat(2_000) } }));
      expect(await closed).toBe(1009);
    } finally {
      if (socket.readyState !== WebSocket.CLOSED) socket.close();
      await handle.stop();
      expectedSocketError?.mockRestore();
    }
  });

  it('rejects concurrent WebSocket operations above the per-connection cap', async () => {
    const port = await availablePort();
    const handle = await startServer(
      baseConfig(port),
      new MemoryRepository(),
      baseSecurity({ graphqlWsMaxOperationsPerConnection: 1 })
    );
    const socket = new WebSocket(`ws://127.0.0.1:${port}/graphql`, 'graphql-transport-ws');
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    try {
      socket.send(JSON.stringify({ type: 'connection_init' }));
      await new Promise<void>((resolve, reject) => {
        const onMessage = (payload: WebSocket.RawData) => {
          const message = JSON.parse(payload.toString()) as { type?: string };
          if (message.type === 'connection_ack') {
            socket.off('message', onMessage);
            resolve();
          }
        };
        socket.on('message', onMessage);
        socket.once('error', reject);
      });
      const payload = { query: 'subscription { accounts { id mutation_type } }' };
      socket.send(JSON.stringify({ id: 'first', type: 'subscribe', payload }));
      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
      });
      socket.send(JSON.stringify({ id: 'second', type: 'subscribe', payload }));
      const rejected = await closed;
      expect(rejected.code).toBe(4500);
      expect(rejected.reason).toContain('operation limit exceeded');
    } finally {
      if (socket.readyState !== WebSocket.CLOSED) {
        socket.close();
        await new Promise((resolve) => socket.once('close', resolve));
      }
      await handle.stop();
    }
  });

  it('applies the GraphQL introspection policy to WebSocket operations', async () => {
    const port = await availablePort();
    const handle = await startServer(baseConfig(port), new MemoryRepository(), baseSecurity());
    const socket = new WebSocket(`ws://127.0.0.1:${port}/graphql`, 'graphql-transport-ws');
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    try {
      socket.send(JSON.stringify({ type: 'connection_init' }));
      await new Promise<void>((resolve, reject) => {
        const onMessage = (payload: WebSocket.RawData) => {
          const message = JSON.parse(payload.toString()) as { type?: string };
          if (message.type === 'connection_ack') {
            socket.off('message', onMessage);
            resolve();
          }
        };
        socket.on('message', onMessage);
        socket.once('error', reject);
      });
      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
      });
      socket.send(
        JSON.stringify({
          id: 'introspection',
          type: 'subscribe',
          payload: { query: '{ __schema { queryType { name } } }' },
        })
      );
      const rejected = await closed;
      expect(rejected.code).toBe(4500);
      expect(rejected.reason).toContain('introspection is disabled');
    } finally {
      if (socket.readyState !== WebSocket.CLOSED) socket.close();
      await handle.stop();
    }
  });
});
