import { createServer, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARCHIVE_CHECKPOINT as C, ARCHIVE_GENESIS as G, RECOVERY_FIRST_CHILD, ArchiveRouter } from '../src/archive-router.js';
import { createArchiveGateway, httpRpc } from '../src/archive-gateway.js';

const cleanup: Array<() => Promise<void>> = [];
/** Held upstream gates are opened before any server closes, whatever the test outcome. */
const gates: Array<() => void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const release of gates.splice(0)) release();
  for (const close of cleanup.splice(0).reverse()) await close();
});
/** Waits poll for up to 10 s; tests that use them get a 30 s budget instead of the 5 s default. */
const WAIT = { timeout: 10_000 };
const SLOW = 30_000;
/** Resolve with `promise`, or fail with `message` if it has not settled within `ms`. */
async function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]);
  } finally { clearTimeout(timer); }
}

/** Start a disposable loopback service; no external connections are used. */
async function listen(server: Server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
it('preserves the native RPC Host allowlist across a loopback namespace bridge', async () => {
  const server = createServer((req, res) => res.end(JSON.stringify({ result: req.headers.host })));
  const url = await listen(server);
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  expect(await httpRpc(url, '127.0.0.1:9946')('system_health', [])).toBe('127.0.0.1:9946');
});
/** Independent fake chain servers expose different current/storage responses. */
async function upstream(name: string) {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const data of req) chunks.push(data);
    const r = JSON.parse(Buffer.concat(chunks).toString());
    let result: unknown = name;
    if (r.method === 'chain_getBlockHash') result = Number(r.params[0]) === 0 ? G : Number(r.params[0]) === C.height + 1 ? RECOVERY_FIRST_CHILD : C.hash;
    if (r.method === 'chain_getHeader') result = { number: `0x${(r.params[0] === RECOVERY_FIRST_CHILD ? C.height + 1 : C.height).toString(16)}`, parentHash: C.hash };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, result }));
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (client) => client.on('message', (body) => {
    const r = JSON.parse(body.toString());
    client.send(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: `${name}-subscription` }));
    client.send(JSON.stringify({ jsonrpc: '2.0', method: 'chain_finalizedHead', params: { subscription: `${name}-subscription`, result: name } }));
  }));
  const url = await listen(server);
  cleanup.push(async () => { for (const ws of wss.clients) ws.terminate(); wss.close(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  return url;
}
/** Exercise the actual gateway transports with independently admitted upstreams. */
async function fixture() {
  const live = await upstream('live'), archive = await upstream('archive');
  const router = new ArchiveRouter(httpRpc(live), httpRpc(archive)); await router.verify();
  const gateway = createArchiveGateway(router, live.replace('http:', 'ws:'));
  const url = await listen(gateway.server); cleanup.push(gateway.close);
  const call = async (method: string, params: unknown[] = []) => (await fetch(url, {
    method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 4, method, params }),
  })).json();
  return { url, call };
}
it('serves admitted historical state over HTTP while retaining live heads and checkpoint execution metadata', async () => {
  const { call } = await fixture();
  expect((await call('state_getStorage', ['0x00', C.hash])).result).toBe('archive');
  expect((await call('state_getMetadata', [C.hash])).result).toBe('live');
  expect((await call('chain_getFinalizedHead')).result).toBe('live');
  expect((await call('author_submitExtrinsic', ['0x00'])).error.code).toBe(-32601);
});
it('forwards WebSocket subscriptions only to the live node and retains request identities', async () => {
  const { url } = await fixture(); const ws = new WebSocket(url.replace('http:', 'ws:'));
  await once(ws, 'open');
  const received: unknown[] = [];
  const finished = new Promise<void>((resolve) => ws.on('message', (data) => {
    received.push(JSON.parse(data.toString())); if (received.length === 2) resolve();
  }));
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'subscribe', method: 'chain_subscribeFinalizedHeads', params: [] }));
  await finished;
  expect(received).toEqual([
    { jsonrpc: '2.0', id: 'subscribe', result: 'live-subscription' },
    { jsonrpc: '2.0', method: 'chain_finalizedHead', params: { subscription: 'live-subscription', result: 'live' } },
  ]);
  ws.close(); await once(ws, 'close');
});
it('rejects malformed requests, notifications, invalid batches and oversized payloads', async () => {
  const { url } = await fixture();
  for (const body of ['garbage', '[]', JSON.stringify({ jsonrpc: '2.0', method: 'system_health' })]) {
    const result = await (await fetch(url, { method: 'POST', body })).json(); expect(result.error).toBeTruthy();
  }
  expect((await fetch(url, { method: 'POST', body: 'a'.repeat(300_000) })).status).toBe(413);
  expect((await fetch(url)).status).toBe(405);
});

/** Loopback upstream whose reply is chosen by the JSON-RPC method name. */
async function scripted(reply: (method: string, res: ServerResponse) => void) {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const data of req) chunks.push(data);
    res.on('error', () => undefined);
    reply(JSON.parse(Buffer.concat(chunks).toString()).method, res);
  });
  const url = await listen(server);
  cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return url;
}
describe('bounded upstream transport', () => {
  it('accepts only the local HTTP transport', () => {
    expect(() => httpRpc('https://127.0.0.1:1/')).toThrow('Upstream must use the local HTTP transport');
    expect(() => httpRpc('ws://127.0.0.1:1/')).toThrow('Upstream must use the local HTTP transport');
  });
  it('maps non-200, upstream errors and result-less replies to JSON-RPC errors', async () => {
    const rpc = httpRpc(await scripted((method, res) => {
      if (method === 'unavailable') { res.writeHead(503); res.end('{"result":"stale"}'); return; }
      if (method === 'rejected') { res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid params' } })); return; }
      if (method === 'empty') { res.end(JSON.stringify({ jsonrpc: '2.0', id: 1 })); return; }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }));
    }));
    await expect(rpc('unavailable', [])).rejects.toMatchObject({ code: -32003, message: 'Upstream unavailable' });
    await expect(rpc('rejected', [])).rejects.toMatchObject({ code: -32602, message: 'Invalid params' });
    await expect(rpc('empty', [])).rejects.toMatchObject({ code: -32003, message: 'Invalid upstream response' });
    expect(await rpc('nullable', [])).toBeNull();
  });
  it('aborts an upstream response larger than 32 MiB and drops the upstream connection', async () => {
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    let upstreamClosed!: Promise<void>;
    const rpc = httpRpc(await scripted((_method, res) => {
      upstreamClosed = new Promise<void>((resolve) => res.socket!.once('close', () => resolve()));
      // Write past the limit and never end the response: only an active client abort closes the socket.
      let sent = 0;
      const pump = () => { while (sent < 33) { sent++; if (!res.write(chunk)) { res.once('drain', pump); return; } } };
      pump();
    }));
    await expect(rpc('state_getMetadata', [])).rejects.toMatchObject({ code: -32003, message: 'Upstream response too large' });
    await within(upstreamClosed, 5_000, 'Upstream socket still open 5 s after the caller rejected');
  }, SLOW);
});

const read = (id: number, method = 'system_health') => ({ jsonrpc: '2.0', id, method, params: [id] });
/** Gateway in front of a scripted router and a loopback live node; nothing leaves 127.0.0.1. */
async function stubGateway(call: (method: string, params: unknown[]) => Promise<unknown>) {
  const liveServer = createServer();
  const live = new WebSocketServer({ server: liveServer });
  live.on('connection', (socket) => socket.on('message', (body) => {
    const r = JSON.parse(body.toString());
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: 'live-subscription' }));
  }));
  const liveUrl = await listen(liveServer);
  cleanup.push(async () => { for (const ws of live.clients) ws.terminate(); live.close(); await new Promise<void>((resolve) => liveServer.close(() => resolve())); });
  const router = { call: vi.fn(call) };
  const gateway = createArchiveGateway(router as unknown as ArchiveRouter, liveUrl.replace('http:', 'ws:'));
  const url = await listen(gateway.server); cleanup.push(gateway.close);
  // Every request is bounded so that a mistakenly held reply fails the test instead of hanging it.
  const post = async (body: unknown) => fetch(url, {
    method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  });
  return { ws: url.replace('http:', 'ws:'), router, live, post };
}
async function open(url: string) {
  const ws = new WebSocket(url); await once(ws, 'open');
  cleanup.push(async () => { ws.terminate(); });
  return ws;
}
const closed = (ws: WebSocket) => new Promise<[number, string]>((resolve) => ws.on('close', (code, reason) => resolve([code, reason.toString()])));
/** Resolve with the close code of a WebSocket that the server refuses to upgrade. */
async function refused(url: string) {
  const ws = new WebSocket(url); const opened = vi.fn();
  ws.on('error', () => undefined); ws.on('open', opened);
  const [code] = await closed(ws);
  expect(opened).not.toHaveBeenCalled();
  return code;
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  gates.push(release);
  return { promise, release };
}

describe('archive gateway HTTP surface', () => {
  it('defaults omitted parameters and hides non-RPC upstream failures', async () => {
    const g = await stubGateway(async (method) => {
      if (method === 'system_health') return { peers: 3 };
      throw new Error('connect ECONNREFUSED 10.0.0.7:9933');
    });
    expect(await (await g.post({ jsonrpc: '2.0', id: 1, method: 'system_health' })).json())
      .toEqual({ jsonrpc: '2.0', id: 1, result: { peers: 3 } });
    expect(g.router.call).toHaveBeenLastCalledWith('system_health', []);
    expect(await (await g.post({ jsonrpc: '2.0', id: 'storage', method: 'state_getStorage', params: ['0x00'] })).json())
      .toEqual({ jsonrpc: '2.0', id: 'storage', error: { code: -32003, message: 'Upstream request failed' } });
  });
  it('answers bounded batches entry by entry and rejects batches over 16 requests', async () => {
    const g = await stubGateway(async (method, params) => ({ method, params }));
    expect(await (await g.post([read(1), { jsonrpc: '2.0', method: 'system_health' }, read(2)])).json()).toEqual([
      { jsonrpc: '2.0', id: 1, result: { method: 'system_health', params: [1] } },
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid JSON-RPC request' } },
      { jsonrpc: '2.0', id: 2, result: { method: 'system_health', params: [2] } },
    ]);
    expect(await (await g.post(Array.from({ length: 17 }, (_, i) => read(i)))).json())
      .toEqual({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Unsupported batch' } });
    expect(g.router.call).toHaveBeenCalledTimes(2);
  });
  it('returns HTTP 400 when a routed result cannot be encoded as JSON', async () => {
    const g = await stubGateway(async () => 1n);
    const response = await g.post(read(1));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid request' });
  });
  it('refuses requests beyond 64 in flight with -32004 and recovers once they finish', async () => {
    const hold = gate();
    const g = await stubGateway(async (_method, params) => { await hold.promise; return params[0]; });
    // Settlement is observed from creation, so an early transport failure is never unhandled.
    const settled = Promise.allSettled(Array.from({ length: 4 }, (_, b) =>
      g.post(Array.from({ length: 16 }, (_, i) => read(b * 16 + i))).then((response) => response.json() as Promise<unknown[]>)));
    let outcomes: Array<PromiseSettledResult<unknown[]>> = [];
    try {
      await vi.waitFor(() => expect(g.router.call).toHaveBeenCalledTimes(64), WAIT);
      expect(await (await g.post(read(64))).json())
        .toEqual({ jsonrpc: '2.0', id: 64, error: { code: -32004, message: 'Archive concurrency limit' } });
    } finally {
      hold.release();
      outcomes = await settled;
    }
    expect(outcomes.map((outcome) => outcome.status)).toEqual(Array(4).fill('fulfilled'));
    // Every submitted request is answered with its own id and result, in submission order.
    expect(outcomes.flatMap((outcome) => outcome.status === 'fulfilled' ? outcome.value : []))
      .toEqual(Array.from({ length: 64 }, (_, id) => ({ jsonrpc: '2.0', id, result: id })));
    expect(await (await g.post(read(65))).json()).toEqual({ jsonrpc: '2.0', id: 65, result: 65 });
  }, SLOW);
});

describe('archive gateway WebSocket surface', () => {
  it('answers reads directly and rejects batches and malformed JSON', async () => {
    const g = await stubGateway(async (method) => method);
    const ws = await open(g.ws);
    const replies: unknown[] = [];
    ws.on('message', (data) => replies.push(JSON.parse(data.toString())));
    ws.send(JSON.stringify(read(1))); ws.send(JSON.stringify([read(2)])); ws.send('{');
    await vi.waitFor(() => expect(replies).toHaveLength(3), WAIT);
    expect(replies).toEqual(expect.arrayContaining([
      { jsonrpc: '2.0', id: 1, result: 'system_health' },
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Unsupported batch' } },
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } },
    ]));
    expect(g.router.call).toHaveBeenCalledTimes(1);
  }, SLOW);
  it('closes with 1008 on a binary frame', async () => {
    const g = await stubGateway(async () => null);
    const ws = await open(g.ws);
    const done = closed(ws);
    ws.send(Buffer.from(JSON.stringify(read(1))), { binary: true });
    expect(await done).toEqual([1008, 'Invalid payload or concurrency limit']);
    expect(g.router.call).not.toHaveBeenCalled();
  });
  it('closes with 1008 beyond 16 pending requests and attempts no send to the closed client', async () => {
    const hold = gate();
    const g = await stubGateway(async (_method, params) => { await hold.promise; return params[0]; });
    const ws = await open(g.ws);
    const replies: unknown[] = [];
    ws.on('message', (data) => replies.push(data.toString()));
    const done = closed(ws);
    // Every WebSocket in this process shares this prototype, so the server-side client's sends are seen here too.
    const sends = vi.spyOn(WebSocket.prototype, 'send');
    let outcomes: Array<PromiseSettledResult<unknown>> = [];
    try {
      for (let id = 0; id < 17; id++) ws.send(JSON.stringify(read(id)));
      expect(await done).toEqual([1008, 'Invalid payload or concurrency limit']);
      expect(g.router.call).toHaveBeenCalledTimes(16);
    } finally {
      hold.release();
      outcomes = await Promise.allSettled(g.router.call.mock.results.map((result) => result.value));
    }
    expect(outcomes).toEqual(Array.from({ length: 16 }, (_, id) => ({ status: 'fulfilled', value: id })));
    for (let turn = 0; turn < 3; turn++) await new Promise((resolve) => setImmediate(resolve));
    // The 17 sends are the test client's own; the server attempted none of the 16 late replies.
    expect(sends.mock.contexts.filter((socket) => socket === ws)).toHaveLength(17);
    expect(sends.mock.contexts.filter((socket) => socket !== ws)).toEqual([]);
    expect(replies).toEqual([]);
  });
  it('closes with 1009 on an oversized frame and drops that client\'s live connection', async () => {
    const g = await stubGateway(async () => null);
    const ws = await open(g.ws);
    await vi.waitFor(() => expect(g.live.clients.size).toBe(1), WAIT);
    const done = closed(ws);
    ws.send('x'.repeat(256 * 1024 + 1));
    expect((await done)[0]).toBe(1009);
    await vi.waitFor(() => expect(g.live.clients.size).toBe(0), WAIT);
    expect(g.router.call).not.toHaveBeenCalled();
  }, SLOW);
  it('terminates a client whose outbound buffer exceeds 32 MiB', async () => {
    const g = await stubGateway(async () => 'reply');
    const ws = await open(g.ws);
    const replies: unknown[] = [];
    ws.on('message', (data) => replies.push(data.toString()));
    const done = closed(ws);
    vi.spyOn(WebSocket.prototype, 'bufferedAmount', 'get').mockReturnValue(32 * 1024 * 1024 + 1);
    ws.send(JSON.stringify(read(1)));
    expect((await done)[0]).toBe(1006);
    expect(replies).toEqual([]);
    expect(g.router.call).toHaveBeenCalledOnce();
  });
  it('refuses a 65th concurrent client', async () => {
    const g = await stubGateway(async () => null);
    await Promise.all(Array.from({ length: 64 }, () => open(g.ws)));
    expect(await refused(g.ws)).toBe(1006);
    await vi.waitFor(() => expect(g.live.clients.size).toBe(64), WAIT);
  }, SLOW);
});
