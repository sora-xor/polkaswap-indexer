import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, expect, it } from 'vitest';
import { ARCHIVE_CHECKPOINT as C, ARCHIVE_GENESIS as G, RECOVERY_FIRST_CHILD, ArchiveRouter } from '../src/archive-router.js';
import { createArchiveGateway, httpRpc } from '../src/archive-gateway.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
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
