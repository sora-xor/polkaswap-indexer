import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ChainReader } from './chain.js';
import { IndexerReader } from './indexer.js';
import { createMcpServer } from './app.js';
import { RateLimiter, ConcurrencyLimit } from './limits.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const publicBase = process.env.PUBLIC_BASE_URL ?? 'https://pi.soramitsu.io/polkaswap-chatgpt';
const publicUrl = new URL(publicBase);
if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password) throw new Error('Public URL must be HTTPS without credentials');
const widget = await readFile(path.join(root, 'dist/widget.html'), 'utf8');
const readers = { indexer: new IndexerReader(), chain: new ChainReader(process.env.SORA_WS_ENDPOINT) };
const rate = new RateLimiter();
const jobs = new ConcurrencyLimit();
let activeRequests = 0;
const staticFiles: Record<string, [string, string]> = { '/': ['dist/widget.html', 'text/html'], '/preview': ['dist/widget.html', 'text/html'], '/privacy': ['public/privacy.html', 'text/html'], '/support': ['public/support.html', 'text/html'], '/terms': ['public/terms.html', 'text/html'], '/logo.svg': ['plugin/assets/logo.svg', 'image/svg+xml'] };

/** Isolated loopback HTTP service. Proxy access logs are disabled for this prefix. */
const http = createServer(async (request, response) => {
  const started = Date.now();
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
  response.on('finish', () => console.info(JSON.stringify({ method: request.method, route: request.url === '/mcp' ? 'mcp' : 'other', status: response.statusCode, durationMs: Date.now() - started })));
  const host = request.headers.host?.split(':')[0];
  if (![publicUrl.hostname, '127.0.0.1', 'localhost'].includes(host ?? '')) { response.writeHead(403).end(); return; }
  const origin = request.headers.origin;
  if (origin && !['https://chatgpt.com', 'https://www.chatgpt.com', publicUrl.origin].includes(origin)) { response.writeHead(403).end(); return; }
  const peer = request.socket.remoteAddress ?? 'unknown';
  const trustedProxy = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer) && host === publicUrl.hostname;
  const forwarded = request.headers['x-real-ip'];
  const clientAddress = trustedProxy && typeof forwarded === 'string' ? forwarded : peer;
  if (!rate.allow(clientAddress)) { response.writeHead(429, { 'retry-after': '60' }).end(); return; }
  if (request.url === '/health' && request.method === 'GET') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: true, service: 'polkaswap-evidence', version: '0.1.0', readOnly: true, commit: process.env.RELEASE_COMMIT ?? null })); return; }
  const staticFile = staticFiles[request.url ?? ''];
  if (staticFile && request.method === 'GET') {
    response.setHeader('content-type', `${staticFile[1]}; charset=utf-8`);
    response.setHeader('content-security-policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
    try { response.end(await readFile(path.join(root, staticFile[0]))); } catch { response.writeHead(404).end(); }
    return;
  }
  if (request.url !== '/mcp') { response.writeHead(404).end(); return; }
  if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }).end(); return; }
  if (activeRequests >= 20) { response.writeHead(503).end(); return; }
  activeRequests++;
  const server = createMcpServer(widget, readers, publicBase, jobs);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  response.on('close', () => { activeRequests--; void transport.close(); void server.close(); });
  try {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) { size += chunk.length; if (size > 64 * 1024) { response.writeHead(413).end(); return; } chunks.push(Buffer.from(chunk)); }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { response.writeHead(400).end(); return; }
    await server.connect(transport);
    await transport.handleRequest(request, response, body);
  } catch { if (!response.headersSent) response.writeHead(500); if (!response.writableEnded) response.end(); }
});
http.requestTimeout = 40_000;
http.headersTimeout = 10_000;
const port = Number(process.env.PORT ?? 4380);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
http.listen(port, process.env.HOST ?? '127.0.0.1', () => console.info(`Polkaswap Evidence listening on loopback port ${port}`));
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { http.close(); void readers.chain.close().finally(() => process.exit()); });
