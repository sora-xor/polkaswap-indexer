/**
 * Local-only bounded pre-fork replay: the shared history served as one exact snapshot at
 * block 28,191,816. An interim legacy-history rebuild, not recovery-policy admission or
 * entitlement certification. Nothing later than the cap is ever served.
 */
import { randomBytes } from 'node:crypto';
import { Agent as HttpAgent, createServer, request as httpRequest, type Server } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { WebSocket, WebSocketServer } from 'ws';

/** Finalized on the recovery chain and canonical on both chains. */
export const LEGACY_REPLAY_CAP = Object.freeze({
  height: 28_191_816,
  hash: '0x60b63e40ce4de9b9c1408bf7455a6f5ced796825f2437a0ee8496476d80c56d6',
});
export const LEGACY_REPLAY_GENESIS = '0x7e4e32d0feafd4f9c9414b0be86373f9a1efa904809b683453a9af6856d38ad5';

export type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

/** An RPC error safe to return to a caller without exposing transport details. */
export class ReplayRpcError extends Error {
  constructor(public readonly code: number, message: string) { super(message); }
}

const HASH = /^0x[0-9a-f]{64}$/;
const MAX_MESSAGE = 256 * 1024;
const MAX_RESPONSE = 64 * 1024 * 1024;
/** Position of the block-hash parameter for every historical read the replay may make. */
const AT_POSITION: Record<string, number> = {
  chain_getHeader: 0, chain_getBlock: 0,
  state_getStorage: 1, state_getStorageAt: 1, state_getStorageHash: 1, state_getStorageSize: 1,
  state_getKeys: 1, state_getKeysPaged: 3, state_queryStorageAt: 1, state_getReadProof: 1,
  state_getMetadata: 0, state_getRuntimeVersion: 0, chain_getRuntimeVersion: 0, state_call: 2,
};
/** Node identity reads that carry no chain data. */
const IDENTITY_METHODS = ['system_chain', 'system_chainType', 'system_name', 'system_properties', 'system_version', 'system_health'];
const HEAD_SUBSCRIPTIONS: Record<string, string> = {
  chain_subscribeNewHeads: 'chain_newHead', chain_subscribeNewHead: 'chain_newHead', subscribe_newHead: 'chain_newHead',
  chain_subscribeFinalizedHeads: 'chain_finalizedHead', chain_subscribeFinalisedHeads: 'chain_finalizedHead',
  chain_subscribeAllHeads: 'chain_allHead',
};
const VERSION_SUBSCRIPTIONS = ['state_subscribeRuntimeVersion', 'chain_subscribeRuntimeVersion'];
const STORAGE_SUBSCRIPTION = 'state_subscribeStorage';
const UNSUBSCRIBE = [
  'chain_unsubscribeNewHeads', 'chain_unsubscribeNewHead', 'unsubscribe_newHead', 'chain_unsubscribeFinalizedHeads',
  'chain_unsubscribeFinalisedHeads', 'chain_unsubscribeAllHeads', 'state_unsubscribeRuntimeVersion',
  'chain_unsubscribeRuntimeVersion', 'state_unsubscribeStorage',
];
export const LEGACY_REPLAY_METHODS = [
  ...IDENTITY_METHODS, 'rpc_methods', 'chain_getFinalizedHead', 'chain_getHead', 'chain_getBlockHash',
  ...Object.keys(AT_POSITION), ...Object.keys(HEAD_SUBSCRIPTIONS), ...VERSION_SUBSCRIPTIONS, STORAGE_SUBSCRIPTION, ...UNSUBSCRIBE,
];

function heightOf(header: unknown): number {
  const number = (header as { number?: unknown } | null)?.number;
  if (typeof number !== 'string' || !/^0x[0-9a-f]+$/i.test(number)) return -1;
  const height = Number(BigInt(number));
  return Number.isSafeInteger(height) ? height : -1;
}

/**
 * Serves canonical shared history at or below the cap. Default reads, heads and subscriptions
 * resolve to the cap, so a client's default registry is the original pre-fork runtime rather
 * than the recovery runtime that reuses its spec version.
 */
export class LegacyReplayAdapter {
  private admitted = false;
  private capHeader: unknown = null;
  private capVersion: unknown = null;
  private readonly heights = new Map<string, number>();
  private readonly hashes = new Map<number, string>();
  private readonly pendingReads = new Map<string, Promise<unknown>>();
  private readonly registryReads = new Map<string, unknown>();

  constructor(private readonly archive: Rpc, private readonly recovery: Rpc, private readonly crossCheck = true) {}

  get isAdmitted(): boolean { return this.admitted; }

  /** Both chains must agree on genesis and the cap, and the recovery chain must have finalized the cap. */
  async verify(): Promise<void> {
    try {
      for (const rpc of [this.archive, this.recovery]) {
        if (await rpc('chain_getBlockHash', [0]) !== LEGACY_REPLAY_GENESIS ||
            await rpc('chain_getBlockHash', [LEGACY_REPLAY_CAP.height]) !== LEGACY_REPLAY_CAP.hash) {
          throw new Error('Pre-fork replay cap identity mismatch');
        }
      }
      const finalized = await this.recovery('chain_getHeader', [await this.recovery('chain_getFinalizedHead', [])]);
      if (heightOf(finalized) < LEGACY_REPLAY_CAP.height) throw new Error('Recovery finality does not cover the replay cap');
      const header = await this.archive('chain_getHeader', [LEGACY_REPLAY_CAP.hash]);
      if (heightOf(header) !== LEGACY_REPLAY_CAP.height) throw new Error('Archive cap header mismatch');
      this.capHeader = header;
      this.capVersion = await this.archive('state_getRuntimeVersion', [LEGACY_REPLAY_CAP.hash]);
      this.remember(LEGACY_REPLAY_CAP.hash, LEGACY_REPLAY_CAP.height);
      this.admitted = true;
    } catch (error) {
      this.admitted = false;
      throw error;
    }
  }

  private remember(hash: string, height: number): void {
    if (this.heights.size >= 65_536 && !this.heights.has(hash)) {
      const oldest = this.heights.keys().next().value!;
      this.hashes.delete(this.heights.get(oldest)!);
      this.heights.delete(oldest);
    }
    this.heights.set(hash, height);
    this.hashes.set(height, hash);
  }

  /** Cross-check a pre-fork block identity against the recovery chain, which keeps every header. */
  private async confirmed(hash: string, height: number): Promise<void> {
    if (this.crossCheck && await this.recovery('chain_getBlockHash', [height]) !== hash) {
      throw new ReplayRpcError(-32001, 'Recovery chain disagrees on this pre-fork block');
    }
    this.remember(hash, height);
  }

  /** Resolve an explicit hash to a canonical height at or below the cap, or reject it. */
  private async canonicalHeight(hash: string): Promise<number> {
    const cached = this.heights.get(hash);
    if (cached !== undefined) return cached;
    const height = heightOf(await this.archive('chain_getHeader', [hash]));
    if (height < 0) throw new ReplayRpcError(-32001, 'Unknown pre-fork block');
    if (height > LEGACY_REPLAY_CAP.height) throw new ReplayRpcError(-32001, 'Block is beyond the pre-fork replay cap');
    if (await this.archive('chain_getBlockHash', [height]) !== hash) throw new ReplayRpcError(-32001, 'Noncanonical pre-fork block');
    await this.confirmed(hash, height);
    return height;
  }

  private async blockHash(params: unknown[]): Promise<unknown> {
    if (params.length > 1) throw new ReplayRpcError(-32602, 'Expected one block height');
    const input = params[0];
    if (input === undefined || input === null) return LEGACY_REPLAY_CAP.hash;
    const height = typeof input === 'number' ? input
      : typeof input === 'string' && /^0x[0-9a-f]+$/i.test(input) ? Number(BigInt(input)) : NaN;
    if (!Number.isSafeInteger(height) || height < 0) throw new ReplayRpcError(-32602, 'Expected one nonnegative block height');
    if (height > LEGACY_REPLAY_CAP.height) throw new ReplayRpcError(-32001, 'Block is beyond the pre-fork replay cap');
    // The verified finalized cap commits to this immutable historical prefix.
    const cached = this.hashes.get(height);
    if (cached !== undefined) return cached;
    const hash = await this.archive('chain_getBlockHash', [height]);
    if (typeof hash !== 'string' || !HASH.test(hash)) throw new ReplayRpcError(-32001, 'Archive has no canonical block at this height');
    await this.confirmed(hash, height);
    return hash;
  }

  /** One read at an explicit canonical pre-fork block, or at the cap when the block is omitted. */
  async call(method: string, params: unknown[]): Promise<unknown> {
    if (!this.admitted) throw new ReplayRpcError(-32002, 'Pre-fork replay identity is not verified');
    const key = JSON.stringify([method, params]);
    // Registries revisit these immutable parent headers/versions while indexing
    // a prefetched batch. Never cache events, balances, ranges or failures here.
    const cacheRegistry = ['chain_getHeader', 'state_getRuntimeVersion', 'chain_getRuntimeVersion'].includes(method);
    if (cacheRegistry && this.registryReads.has(key)) return this.registryReads.get(key);
    const pending = this.pendingReads.get(key);
    if (pending) return pending;
    const request = this.callOnce(method, params).then((result) => {
      if (cacheRegistry) {
        if (this.registryReads.size >= 8_192) this.registryReads.delete(this.registryReads.keys().next().value!);
        this.registryReads.set(key, result);
      }
      return result;
    }).finally(() => { this.pendingReads.delete(key); });
    this.pendingReads.set(key, request);
    return request;
  }

  /** Coalesced reads have no retained payload cache; failures are always retried afresh. */
  private async callOnce(method: string, params: unknown[]): Promise<unknown> {
    if (method === 'rpc_methods') return { version: 1, methods: LEGACY_REPLAY_METHODS };
    if (IDENTITY_METHODS.includes(method)) return this.archive(method, params);
    if (method === 'chain_getFinalizedHead' || method === 'chain_getHead') return LEGACY_REPLAY_CAP.hash;
    if (method === 'chain_getBlockHash') return this.blockHash(params);
    const position = AT_POSITION[method];
    if (position === undefined) throw new ReplayRpcError(-32601, 'Unsupported pre-fork replay method');
    if (params.length > position + 1) throw new ReplayRpcError(-32602, 'Unexpected block parameters');
    const at = params[position];
    const pinned = [...params];
    while (pinned.length <= position) pinned.push(null);
    if (at === undefined || at === null) pinned[position] = LEGACY_REPLAY_CAP.hash;
    else if (typeof at !== 'string' || !HASH.test(at)) throw new ReplayRpcError(-32602, 'Expected a canonical block hash');
    else await this.canonicalHeight(at);
    return this.archive(method, pinned);
  }

  /** A subscription's only notification: the cap never advances, so none follow. */
  async snapshot(method: string, params: unknown[]): Promise<{ notification: string; result: unknown }> {
    if (!this.admitted) throw new ReplayRpcError(-32002, 'Pre-fork replay identity is not verified');
    const head = HEAD_SUBSCRIPTIONS[method];
    if (head) return { notification: head, result: this.capHeader };
    if (VERSION_SUBSCRIPTIONS.includes(method)) return { notification: 'state_runtimeVersion', result: this.capVersion };
    if (method === STORAGE_SUBSCRIPTION) {
      const keys = params[0];
      if (params.length !== 1 || !Array.isArray(keys) || !keys.length || keys.length > 256 ||
          !keys.every((key) => typeof key === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(key))) {
        throw new ReplayRpcError(-32602, 'Expected a bounded list of storage keys');
      }
      const sets = await this.archive('state_queryStorageAt', [keys, LEGACY_REPLAY_CAP.hash]) as Array<{ changes?: unknown }>;
      return { notification: 'state_storage', result: { block: LEGACY_REPLAY_CAP.hash, changes: sets[0]?.changes ?? [] } };
    }
    throw new ReplayRpcError(-32601, 'Unsupported pre-fork replay subscription');
  }
}

/** Keep-alive JSON-RPC client for one upstream; a failure never falls back to another source. */
export function jsonRpcClient(url: string, maxSockets = 32): Rpc {
  const target = new URL(url);
  const secure = target.protocol === 'https:';
  if (!secure && target.protocol !== 'http:') throw new Error('Upstream must use HTTP or HTTPS');
  const agent = secure ? new HttpsAgent({ keepAlive: true, maxSockets }) : new HttpAgent({ keepAlive: true, maxSockets });
  const send = secure ? httpsRequest : httpRequest;
  let id = 0;
  return (method, params) => new Promise((resolve, reject) => {
    const request = send(target, {
      method: 'POST', agent, headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(60_000),
    }, (response) => {
      const chunks: Buffer[] = [];
      let length = 0;
      response.on('error', reject);
      response.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > MAX_RESPONSE) { request.destroy(new ReplayRpcError(-32003, 'Upstream response too large')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          if (response.statusCode !== 200) throw new ReplayRpcError(-32003, 'Upstream unavailable');
          const reply = JSON.parse(Buffer.concat(chunks).toString()) as { result?: unknown; error?: { code: number; message: string } };
          if (reply.error) throw new ReplayRpcError(reply.error.code, reply.error.message);
          if (!Object.hasOwn(reply, 'result')) throw new ReplayRpcError(-32003, 'Invalid upstream response');
          resolve(reply.result);
        } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.end(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }));
  });
}

type Request = { jsonrpc: '2.0'; id: string | number; method: string; params?: unknown[] };

function parseRequest(value: unknown): Request {
  const r = value as Request;
  if (!r || Array.isArray(r) || r.jsonrpc !== '2.0' ||
      !(typeof r.id === 'string' && r.id.length <= 128 || typeof r.id === 'number' && Number.isSafeInteger(r.id)) ||
      typeof r.method !== 'string' || r.method.length > 128 || r.params !== undefined && !Array.isArray(r.params)) {
    throw new ReplayRpcError(-32600, 'Invalid JSON-RPC request');
  }
  return r;
}

const failure = (id: unknown, error: unknown) => ({
  jsonrpc: '2.0', id: typeof id === 'string' || typeof id === 'number' ? id : null,
  error: { code: error instanceof ReplayRpcError ? error.code : -32003,
    message: error instanceof ReplayRpcError ? error.message : 'Upstream request failed' },
});

/** Loopback HTTP/WS server for a replay worker. Subscriptions are answered once from the cap. */
export function createLegacyReplayServer(adapter: LegacyReplayAdapter): {
  server: Server; closeClients: () => void; close: () => Promise<void>;
} {
  let active = 0;
  const answer = async (value: unknown): Promise<unknown> => {
    let request: Request | undefined;
    let acquired = false;
    try {
      request = parseRequest(value);
      // Each upstream HTTP agent still permits only 32 sockets. This bounded
      // local queue accommodates the deployed worker's two cross-check clients.
      if (active >= 256) throw new ReplayRpcError(-32004, 'Replay concurrency limit');
      active++; acquired = true;
      return { jsonrpc: '2.0', id: request.id, result: await adapter.call(request.method, request.params ?? []) };
    } catch (error) { return failure(request?.id, error); }
    finally { if (acquired) active--; }
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
        if (bytes > MAX_MESSAGE) { res.writeHead(413); res.end('{"error":"Request too large"}'); return; }
        chunks.push(data);
      }
      let parsed: unknown;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString()); } catch {
        res.end(JSON.stringify(failure(null, new ReplayRpcError(-32700, 'Invalid JSON')))); return;
      }
      if (Array.isArray(parsed)) {
        res.end(JSON.stringify(!parsed.length || parsed.length > 16
          ? failure(null, new ReplayRpcError(-32600, 'Unsupported batch'))
          : await Promise.all(parsed.map(answer))));
        return;
      }
      res.end(JSON.stringify(await answer(parsed)));
    } catch { if (!res.writableEnded) { res.writeHead(400); res.end('{"error":"Invalid request"}'); } }
  });
  server.requestTimeout = 65_000;
  server.headersTimeout = 10_000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    if (!adapter.isAdmitted || wss.clients.size >= 16) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });
  wss.on('connection', (client: WebSocket) => {
    let pending = 0;
    const send = (message: unknown) => {
      if (client.readyState !== WebSocket.OPEN) return;
      if (client.bufferedAmount > MAX_RESPONSE) { client.terminate(); return; }
      client.send(JSON.stringify(message));
    };
    client.on('message', (data, binary) => {
      if (binary || pending >= 128) { client.close(1008, 'Invalid payload or concurrency limit'); return; }
      pending++;
      void (async () => {
        let parsed: unknown;
        try { parsed = JSON.parse(data.toString()); } catch { send(failure(null, new ReplayRpcError(-32700, 'Invalid JSON'))); return; }
        if (Array.isArray(parsed)) { send(failure(null, new ReplayRpcError(-32600, 'Unsupported batch'))); return; }
        let request: Request;
        try { request = parseRequest(parsed); } catch (error) { send(failure(null, error)); return; }
        const params = request.params ?? [];
        if (UNSUBSCRIBE.includes(request.method)) { send({ jsonrpc: '2.0', id: request.id, result: true }); return; }
        if (request.method in HEAD_SUBSCRIPTIONS || VERSION_SUBSCRIPTIONS.includes(request.method) ||
            request.method === STORAGE_SUBSCRIPTION) {
          try {
            const { notification, result } = await adapter.snapshot(request.method, params);
            const subscription = randomBytes(8).toString('hex');
            send({ jsonrpc: '2.0', id: request.id, result: subscription });
            send({ jsonrpc: '2.0', method: notification, params: { subscription, result } });
          } catch (error) { send(failure(request.id, error)); }
          return;
        }
        send(await answer(request));
      })().finally(() => { pending--; });
    });
  });
  const closeClients = () => { for (const client of wss.clients) client.terminate(); };
  return {
    server, closeClients,
    close: async () => {
      closeClients();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
