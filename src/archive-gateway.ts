import { Agent, createServer, request as httpRequest, type Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { ArchiveRouter, ArchiveRpcError, LIVE_SUBSCRIPTIONS } from './archive-router.js';

const MAX_REQUEST = 256 * 1024;
const MAX_RESPONSE = 32 * 1024 * 1024;
const upstreamAgent = new Agent({ keepAlive: true, maxSockets: 64 });

/** Bounded upstream JSON-RPC transport; failures never fall back to another fork. */
export function httpRpc(url: string, hostHeader?: string) {
  if (new URL(url).protocol !== 'http:') throw new Error('Upstream must use the local HTTP transport');
  return (method: string, params: unknown[]): Promise<unknown> => new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      method: 'POST', agent: upstreamAgent,
      headers: { 'content-type': 'application/json', ...(hostHeader ? { host: hostHeader } : {}) },
      signal: AbortSignal.timeout(30_000),
    }, (response) => {
      const chunks: Buffer[] = [];
      let length = 0;
      response.on('error', reject);
      response.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > MAX_RESPONSE) { request.destroy(new ArchiveRpcError(-32003, 'Upstream response too large')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          if (response.statusCode !== 200) throw new ArchiveRpcError(-32003, 'Upstream unavailable');
          const result = JSON.parse(Buffer.concat(chunks).toString()) as { result?: unknown; error?: { code: number; message: string } };
          if (result.error) throw new ArchiveRpcError(result.error.code, result.error.message);
          if (!Object.hasOwn(result, 'result')) throw new ArchiveRpcError(-32003, 'Invalid upstream response');
          resolve(result.result);
        } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
  });
}

type Request = { jsonrpc: '2.0'; id: string | number; method: string; params?: unknown[] };
/** Reject notifications, oversized batches, object parameters and invalid identifiers. */
function parseRequest(value: unknown): Request {
  const r = value as Request;
  if (!r || Array.isArray(r) || r.jsonrpc !== '2.0' ||
      !(typeof r.id === 'string' && r.id.length <= 128 || typeof r.id === 'number' && Number.isSafeInteger(r.id)) ||
      typeof r.method !== 'string' || r.method.length > 128 || r.params !== undefined && !Array.isArray(r.params)) {
    throw new ArchiveRpcError(-32600, 'Invalid JSON-RPC request');
  }
  return r;
}

/** HTTP/WS adapter; subscriptions exclusively follow the live recovery node. */
export function createArchiveGateway(router: ArchiveRouter, liveWsUrl: string): { server: Server; close: () => Promise<void> } {
  let active = 0;
  const failure = (id: unknown, error: unknown) => ({ jsonrpc: '2.0', id: typeof id === 'string' || typeof id === 'number' ? id : null,
    error: { code: error instanceof ArchiveRpcError ? error.code : -32003,
      message: error instanceof ArchiveRpcError ? error.message : 'Upstream request failed' } });
  const dispatch = async (value: unknown, subscribe?: (r: Request) => Promise<void>): Promise<unknown> => {
    let request: Request | undefined;
    let acquired = false;
    try {
      request = parseRequest(value);
      if (active >= 64) throw new ArchiveRpcError(-32004, 'Archive concurrency limit');
      active++; acquired = true;
      if (LIVE_SUBSCRIPTIONS.has(request.method) && subscribe) {
        await router.call('rpc_methods', []); // Admission applies to subscriptions too.
        await subscribe(request);
        return undefined;
      }
      return { jsonrpc: '2.0', id: request.id, result: await router.call(request.method, request.params ?? []) };
    } catch (error) { return failure(request?.id, error); }
    finally { if (acquired) active--; }
  };
  const payload = async (body: string, subscribe?: (r: Request) => Promise<void>) => {
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { return failure(null, new ArchiveRpcError(-32700, 'Invalid JSON')); }
    if (Array.isArray(parsed)) {
      if (!parsed.length || parsed.length > 16 || subscribe) return failure(null, new ArchiveRpcError(-32600, 'Unsupported batch'));
      return Promise.all(parsed.map((r) => dispatch(r)));
    }
    return dispatch(parsed, subscribe);
  };
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    if (req.method !== 'POST') { res.writeHead(405); res.end('{"error":"POST required"}'); return; }
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      for await (const data of req) {
        bytes += data.length;
        if (bytes > MAX_REQUEST) { res.writeHead(413); res.end('{"error":"Request too large"}'); return; }
        chunks.push(data);
      }
      res.end(JSON.stringify(await payload(Buffer.concat(chunks).toString())));
    } catch { if (!res.writableEnded) { res.writeHead(400); res.end('{"error":"Invalid request"}'); } }
  });
  server.requestTimeout = 35_000;
  server.headersTimeout = 10_000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_REQUEST, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    if (wss.clients.size >= 64) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });
  wss.on('connection', (client: WebSocket) => {
    const live = new WebSocket(liveWsUrl, { maxPayload: MAX_RESPONSE, handshakeTimeout: 10_000, perMessageDeflate: false });
    const opened = new Promise<void>((resolve, reject) => {
      live.once('open', resolve);
      live.once('error', reject);
      live.once('close', () => reject(new Error('Live WebSocket closed')));
    });
    void opened.catch(() => {});
    let pending = 0;
    const send = (message: string) => {
      if (client.readyState !== WebSocket.OPEN) return;
      if (client.bufferedAmount > MAX_RESPONSE) { client.terminate(); return; }
      client.send(message);
    };
    live.on('message', (data) => send(data.toString()));
    live.on('error', () => client.close(1011, 'Live upstream unavailable'));
    live.on('close', () => client.close(1011, 'Live upstream closed'));
    client.on('error', () => live.terminate());
    client.on('close', () => live.terminate());
    client.on('message', (data, binary) => {
      if (binary || pending >= 16) { client.close(1008, 'Invalid payload or concurrency limit'); return; }
      pending++;
      void payload(data.toString(), async (request) => { await opened; live.send(JSON.stringify(request)); })
        .then((result) => { if (result !== undefined) send(JSON.stringify(result)); })
        .finally(() => { pending--; });
    });
  });
  return { server, close: async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}
