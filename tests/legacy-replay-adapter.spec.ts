import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLegacyReplayServer, jsonRpcClient, LEGACY_REPLAY_CAP as CAP, LEGACY_REPLAY_GENESIS as G, LEGACY_REPLAY_METHODS,
  LegacyReplayAdapter, type Rpc,
} from '../src/legacy-replay-adapter.js';

const hex = (n: number) => `0x${n.toString(16)}`;
const old = `0x${'1'.repeat(64)}`, child = `0x${'2'.repeat(64)}`, abandoned = `0x${'3'.repeat(64)}`;
const forked = `0x${'4'.repeat(64)}`, other = `0x${'5'.repeat(64)}`;
const checkpoint = '0x7f7c253fa72f32e7b03f32bdc9ae456fd7174fb131b689be6d876006124129f0';
const capHeader = { number: hex(CAP.height), parentHash: other };
const capVersion = { specName: 'sora-substrate', specVersion: 134 };

/** Old archive and recovery chain sharing history through 817, with conflicting first children. */
function fixture({ finalized = CAP.height as number, archiveCap = CAP.hash as string, recoveryAtOne = old }:
  { finalized?: number; archiveCap?: string; recoveryAtOne?: string } = {}) {
  const archive = vi.fn(async (method: string, params: unknown[]): Promise<unknown> => {
    if (method === 'chain_getBlockHash') {
      return ({ 0: G, 1: old, [CAP.height]: archiveCap, [CAP.height + 1]: checkpoint, [CAP.height + 2]: abandoned } as Record<number, string>)[Number(params[0])] ?? null;
    }
    if (method === 'chain_getHeader') {
      return ({ [old]: { number: '0x1' }, [forked]: { number: '0x1' }, [CAP.hash]: capHeader,
        [checkpoint]: { number: hex(CAP.height + 1) }, [abandoned]: { number: hex(CAP.height + 2) } } as Record<string, unknown>)[String(params[0])] ?? null;
    }
    if (method === 'state_getRuntimeVersion' && params[0] === CAP.hash) return capVersion;
    if (method === 'state_queryStorageAt') return [{ block: params[1], changes: [['0x01', '0xff']] }];
    return { upstream: 'archive', method, params };
  });
  const recovery = vi.fn(async (method: string, params: unknown[]): Promise<unknown> => {
    if (method === 'chain_getBlockHash') {
      return ({ 0: G, 1: recoveryAtOne, [CAP.height]: CAP.hash, [CAP.height + 1]: checkpoint, [CAP.height + 2]: child } as Record<number, string>)[Number(params[0])] ?? null;
    }
    if (method === 'chain_getFinalizedHead') return other;
    if (method === 'chain_getHeader' && params[0] === other) return { number: hex(finalized) };
    return { upstream: 'recovery', method, params };
  });
  return { archive, recovery, adapter: new LegacyReplayAdapter(archive, recovery) };
}

describe('bounded pre-fork replay admission', () => {
  it('admits only a cap shared by both chains and finalized on the recovery chain', async () => {
    const good = fixture();
    await expect(good.adapter.call('system_health', [])).rejects.toThrow('not verified');
    await good.adapter.verify();
    expect(good.adapter.isAdmitted).toBe(true);
    await expect(fixture({ finalized: CAP.height - 1 }).adapter.verify()).rejects.toThrow('finality');
    await expect(fixture({ archiveCap: other }).adapter.verify()).rejects.toThrow('identity mismatch');
  });

  it('fails closed after a failed recheck', async () => {
    const { adapter, recovery } = fixture();
    await adapter.verify();
    recovery.mockResolvedValueOnce('wrong genesis');
    await expect(adapter.verify()).rejects.toThrow('identity mismatch');
    await expect(adapter.call('chain_getFinalizedHead', [])).rejects.toThrow('not verified');
  });
});

describe('bounded pre-fork replay reads', () => {
  it('caches admitted historical registry reads without caching mutable or failed payloads', async () => {
    const { adapter, archive } = fixture();
    await adapter.verify(); archive.mockClear();
    expect(await adapter.call('state_getRuntimeVersion', [CAP.hash])).toEqual(capVersion);
    expect(await adapter.call('state_getRuntimeVersion', [CAP.hash])).toEqual(capVersion);
    expect(archive).toHaveBeenCalledTimes(1);
    await adapter.call('state_getStorage', ['0x01', CAP.hash]);
    await adapter.call('state_getStorage', ['0x01', CAP.hash]);
    expect(archive).toHaveBeenCalledTimes(3);
    archive.mockRejectedValueOnce(new Error('temporary header failure'));
    await expect(adapter.call('chain_getHeader', [CAP.hash])).rejects.toThrow('temporary');
    expect(await adapter.call('chain_getHeader', [CAP.hash])).toEqual(capHeader);
    expect(await adapter.call('chain_getHeader', [CAP.hash])).toEqual(capHeader);
    expect(archive).toHaveBeenCalledTimes(5);
  });

  it('coalesces simultaneous identical reads but never retains a failed payload', async () => {
    const { adapter, archive } = fixture();
    await adapter.verify();
    archive.mockClear();
    const results = await Promise.all([
      adapter.call('state_getMetadata', [CAP.hash]),
      adapter.call('state_getMetadata', [CAP.hash]),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(archive).toHaveBeenCalledTimes(1);
    archive.mockRejectedValueOnce(new Error('temporary archive failure'));
    const failures = await Promise.allSettled([
      adapter.call('state_getMetadata', [CAP.hash]),
      adapter.call('state_getMetadata', [CAP.hash]),
    ]);
    expect(failures.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(archive).toHaveBeenCalledTimes(2);
    await expect(adapter.call('state_getMetadata', [CAP.hash])).resolves.toBeDefined();
    expect(archive).toHaveBeenCalledTimes(3);
  });

  it('reuses only independently verified historical hashes and still fails closed after recheck', async () => {
    const { adapter, archive, recovery } = fixture();
    await adapter.verify();
    archive.mockClear(); recovery.mockClear();
    expect(await adapter.call('chain_getBlockHash', [1])).toBe(old);
    expect(await adapter.call('chain_getBlockHash', [1])).toBe(old);
    expect(archive).toHaveBeenCalledTimes(1);
    expect(recovery).toHaveBeenCalledTimes(1);
    recovery.mockResolvedValueOnce('wrong genesis');
    await expect(adapter.verify()).rejects.toThrow('identity mismatch');
    await expect(adapter.call('chain_getBlockHash', [1])).rejects.toThrow('not verified');
  });

  it('resolves heads, the finalized head and every omitted block to the cap', async () => {
    const { adapter, archive } = fixture();
    await adapter.verify();
    for (const [method, params] of [['chain_getFinalizedHead', []], ['chain_getHead', []], ['chain_getBlockHash', []], ['chain_getBlockHash', [null]]] as const) {
      expect(await adapter.call(method, [...params])).toBe(CAP.hash);
    }
    const pinned: Array<[string, unknown[], unknown[]]> = [
      ['state_getStorage', ['0x01'], ['0x01', CAP.hash]],
      ['state_getMetadata', [], [CAP.hash]],
      ['state_getRuntimeVersion', [null], [CAP.hash]],
      ['state_call', ['Core_version', '0x'], ['Core_version', '0x', CAP.hash]],
      ['state_getKeysPaged', ['0x01', 10], ['0x01', 10, null, CAP.hash]],
      ['chain_getHeader', [], [CAP.hash]],
      ['chain_getBlock', [], [CAP.hash]],
    ];
    for (const [method, params, upstreamParams] of pinned) {
      await adapter.call(method, params);
      expect(archive).toHaveBeenLastCalledWith(method, upstreamParams);
    }
  });

  it('serves explicit canonical pre-fork blocks after a recovery-chain identity cross-check', async () => {
    const { adapter, recovery } = fixture();
    await adapter.verify();
    expect(await adapter.call('chain_getBlockHash', [1])).toBe(old);
    expect(await adapter.call('chain_getBlockHash', ['0x1'])).toBe(old);
    expect(recovery).toHaveBeenCalledWith('chain_getBlockHash', [1]);
    expect(await adapter.call('state_getStorage', ['0x01', old])).toEqual({ upstream: 'archive', method: 'state_getStorage', params: ['0x01', old] });
    expect(await adapter.call('state_getMetadata', [CAP.hash])).toEqual({ upstream: 'archive', method: 'state_getMetadata', params: [CAP.hash] });
  });

  it('never serves the checkpoint, either first child or anything later than the cap', async () => {
    const { adapter } = fixture();
    await adapter.verify();
    for (const height of [CAP.height + 1, hex(CAP.height + 1), CAP.height + 2]) {
      await expect(adapter.call('chain_getBlockHash', [height])).rejects.toThrow('beyond the pre-fork replay cap');
    }
    for (const hash of [checkpoint, abandoned]) {
      await expect(adapter.call('state_getStorage', ['0x01', hash])).rejects.toThrow('beyond the pre-fork replay cap');
      await expect(adapter.call('state_getMetadata', [hash])).rejects.toThrow('beyond the pre-fork replay cap');
    }
    await expect(adapter.call('chain_getBlock', [child])).rejects.toThrow('Unknown pre-fork block');
  });

  it('rejects noncanonical, disputed and malformed blocks and every unsupported method', async () => {
    const { adapter } = fixture();
    await adapter.verify();
    await expect(adapter.call('state_getStorage', ['0x01', forked])).rejects.toThrow('Noncanonical');
    await expect(adapter.call('state_getStorage', ['0x01', 'bad'])).rejects.toThrow('block hash');
    await expect(adapter.call('state_getStorage', ['0x01', old, old])).rejects.toThrow('Unexpected');
    for (const height of [-1, Number.MAX_SAFE_INTEGER + 1, [], '1']) {
      await expect(adapter.call('chain_getBlockHash', [height])).rejects.toThrow('block height');
    }
    for (const method of ['author_submitExtrinsic', 'state_queryStorage', 'state_getPairs', 'system_addReservedPeer']) {
      await expect(adapter.call(method, [])).rejects.toThrow('Unsupported');
    }
    const disputed = fixture({ recoveryAtOne: other });
    await disputed.adapter.verify();
    await expect(disputed.adapter.call('chain_getBlockHash', [1])).rejects.toThrow('disagrees');
    await expect(disputed.adapter.call('state_getStorage', ['0x01', old])).rejects.toThrow('disagrees');
  });
});

describe('bounded pre-fork replay subscriptions', () => {
  it('answers heads, runtime version and storage from the cap', async () => {
    const { adapter, archive } = fixture();
    await adapter.verify();
    expect(await adapter.snapshot('chain_subscribeNewHeads', [])).toEqual({ notification: 'chain_newHead', result: capHeader });
    expect(await adapter.snapshot('chain_subscribeFinalizedHeads', [])).toEqual({ notification: 'chain_finalizedHead', result: capHeader });
    expect(await adapter.snapshot('state_subscribeRuntimeVersion', [])).toEqual({ notification: 'state_runtimeVersion', result: capVersion });
    expect(await adapter.snapshot('state_subscribeStorage', [['0x01']]))
      .toEqual({ notification: 'state_storage', result: { block: CAP.hash, changes: [['0x01', '0xff']] } });
    expect(archive).toHaveBeenLastCalledWith('state_queryStorageAt', [['0x01'], CAP.hash]);
    await expect(adapter.snapshot('state_subscribeStorage', [[]])).rejects.toThrow('storage keys');
    await expect(adapter.snapshot('state_subscribeStorage', [])).rejects.toThrow('storage keys');
  });
});

const closers: Array<() => Promise<void>> = [];
/** Held upstream gates are opened before any server closes, whatever the test outcome. */
const gates: Array<() => void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const release of gates.splice(0)) release();
  for (const close of closers.splice(0).reverse()) await close();
});
/** Waits poll for up to 10 s; tests that use them, or loop heavily, get a 30 s budget instead of the 5 s default. */
const WAIT = { timeout: 10_000 };
const SLOW = 30_000;

it('sends one subscription notification over WebSocket and nothing after it', async () => {
  const { adapter } = fixture();
  await adapter.verify();
  const replay = createLegacyReplayServer(adapter);
  replay.server.listen(0, '127.0.0.1'); await once(replay.server, 'listening');
  closers.push(replay.close);
  const url = `127.0.0.1:${(replay.server.address() as AddressInfo).port}`;
  const ws = new WebSocket(`ws://${url}`);
  await once(ws, 'open');
  const received: Array<{ id?: unknown; method?: string; result?: unknown; params?: { subscription: string; result: unknown } }> = [];
  ws.on('message', (data) => received.push(JSON.parse(data.toString())));
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'heads', method: 'chain_subscribeFinalizedHeads', params: [] }));
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'chain_getFinalizedHead', params: [] }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const subscribed = received.find((message) => message.id === 'heads');
  expect(typeof subscribed?.result).toBe('string');
  const notifications = received.filter((message) => message.method === 'chain_finalizedHead');
  expect(notifications).toEqual([{ jsonrpc: '2.0', method: 'chain_finalizedHead', params: { subscription: subscribed!.result, result: capHeader } }]);
  expect(received.find((message) => message.id === 2)?.result).toBe(CAP.hash);
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'chain_unsubscribeFinalizedHeads', params: [subscribed!.result] }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(received.find((message) => message.id === 3)?.result).toBe(true);
  ws.close(); await once(ws, 'close');
  const http = await (await fetch(`http://${url}`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'chain_getBlockHash', params: [CAP.height + 1] }) })).json();
  expect(http.error.message).toContain('beyond the pre-fork replay cap');
});

describe('bounded pre-fork replay edge cases', () => {
  it('refuses an archive whose cap header does not carry the cap height', async () => {
    const { adapter, archive } = fixture();
    const base = archive.getMockImplementation()!;
    archive.mockImplementation(async (method, params) =>
      method === 'chain_getHeader' && params[0] === CAP.hash ? { number: '0x1' } : base(method, params));
    await expect(adapter.verify()).rejects.toThrow('Archive cap header mismatch');
    expect(adapter.isAdmitted).toBe(false);
  });

  it('lists its methods and passes node identity reads to the archive', async () => {
    const { adapter, archive, recovery } = fixture();
    await adapter.verify(); recovery.mockClear();
    expect(await adapter.call('rpc_methods', [])).toEqual({ version: 1, methods: LEGACY_REPLAY_METHODS });
    expect(await adapter.call('system_chain', [])).toEqual({ upstream: 'archive', method: 'system_chain', params: [] });
    expect(archive).toHaveBeenLastCalledWith('system_chain', []);
    expect(recovery).not.toHaveBeenCalled();
  });

  it('rejects extra height parameters, missing archive hashes and unsafe header numbers', async () => {
    const { adapter, archive } = fixture();
    await adapter.verify();
    await expect(adapter.call('chain_getBlockHash', [1, 2])).rejects.toMatchObject({ code: -32602, message: 'Expected one block height' });
    await expect(adapter.call('chain_getBlockHash', [2])).rejects.toMatchObject({ code: -32001, message: 'Archive has no canonical block at this height' });
    const base = archive.getMockImplementation()!;
    archive.mockImplementation(async (method, params) =>
      method === 'chain_getHeader' && params[0] === other ? { number: `0x${'f'.repeat(20)}` } : base(method, params));
    await expect(adapter.call('state_getStorage', ['0x01', other])).rejects.toMatchObject({ code: -32001, message: 'Unknown pre-fork block' });
  });

  it('refuses subscriptions before admission and unsupported subscriptions after it', async () => {
    const { adapter, archive } = fixture();
    await expect(adapter.snapshot('chain_subscribeNewHeads', [])).rejects.toMatchObject({ code: -32002 });
    await adapter.verify();
    await expect(adapter.snapshot('state_subscribeStorageHash', [])).rejects.toMatchObject({ code: -32601, message: 'Unsupported pre-fork replay subscription' });
    archive.mockResolvedValueOnce([]);
    expect(await adapter.snapshot('state_subscribeStorage', [['0x02']]))
      .toEqual({ notification: 'state_storage', result: { block: CAP.hash, changes: [] } });
  });

  it('evicts the oldest remembered block identity once 65,536 are held', async () => {
    const { adapter, calls, record } = syntheticHistory();
    await adapter.verify();
    // The cap is remembered first; 65,535 more heights fill the bounded map exactly.
    for (let height = 2; height <= 65_536; height++) await adapter.call('chain_getBlockHash', [height]);
    record();
    expect(await adapter.call('chain_getBlockHash', [CAP.height])).toBe(CAP.hash);
    expect(calls).toEqual([]);
    expect(await adapter.call('chain_getBlockHash', [65_537])).toBe(syntheticHash(65_537));
    expect(await adapter.call('chain_getBlockHash', [CAP.height])).toBe(CAP.hash);
    expect(await adapter.call('chain_getBlockHash', [65_536])).toBe(syntheticHash(65_536));
    expect(calls).toEqual([['chain_getBlockHash', [65_537]], ['chain_getBlockHash', [CAP.height]]]);
  }, SLOW);

  it('evicts the oldest cached registry read once 8,192 are held', async () => {
    const { adapter, calls, record } = syntheticHistory();
    await adapter.verify();
    for (let height = 2; height < 8_194; height++) await adapter.call('chain_getHeader', [syntheticHash(height)]);
    record();
    expect(await adapter.call('chain_getHeader', [syntheticHash(2)])).toEqual({ number: '0x2' });
    expect(calls).toEqual([]);
    expect(await adapter.call('chain_getHeader', [syntheticHash(8_194)])).toEqual({ number: hex(8_194) });
    record();
    // The first entry was evicted and is fetched again; a recent entry is still cached.
    expect(await adapter.call('chain_getHeader', [syntheticHash(2)])).toEqual({ number: '0x2' });
    expect(await adapter.call('chain_getHeader', [syntheticHash(8_193)])).toEqual({ number: hex(8_193) });
    expect(calls).toEqual([['chain_getHeader', [syntheticHash(2)]]]);
  }, SLOW);
});

const syntheticHash = (height: number) => `0x${height.toString(16).padStart(64, '0')}`;
/**
 * Plain (unmocked) upstreams agreeing on the cap and on a synthetic canonical history below it,
 * so cache-bound tests stay fast. Archive calls are kept only after `record()`.
 */
function syntheticHistory() {
  const calls: unknown[][] = [];
  let recording = false;
  const answer = (method: string, params: unknown[]): unknown => {
    if (method === 'chain_getBlockHash') {
      const height = Number(params[0]);
      return height === 0 ? G : height === CAP.height ? CAP.hash : syntheticHash(height);
    }
    if (method === 'chain_getFinalizedHead') return other;
    if (method === 'chain_getHeader') {
      if (params[0] === CAP.hash) return capHeader;
      if (params[0] === other) return { number: hex(CAP.height) };
      return { number: hex(Number.parseInt(String(params[0]).slice(2), 16)) };
    }
    return capVersion;
  };
  const archive: Rpc = async (method, params) => { if (recording) calls.push([method, params]); return answer(method, params); };
  const recovery: Rpc = async (method, params) => answer(method, params);
  return { adapter: new LegacyReplayAdapter(archive, recovery), calls, record: () => { recording = true; calls.length = 0; } };
}

/** Loopback upstream whose reply is chosen by the JSON-RPC method name. */
async function scripted(reply: (method: string, res: ServerResponse) => void) {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const data of req) chunks.push(data);
    res.on('error', () => undefined);
    reply(JSON.parse(Buffer.concat(chunks).toString()).method, res);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  closers.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('replay upstream JSON-RPC client', () => {
  it('accepts only HTTP or HTTPS upstreams', () => {
    expect(() => jsonRpcClient('ws://127.0.0.1:1/')).toThrow('Upstream must use HTTP or HTTPS');
    expect(() => jsonRpcClient('file:///tmp/archive')).toThrow('Upstream must use HTTP or HTTPS');
  });

  it('maps non-200, upstream errors and result-less replies to JSON-RPC errors', async () => {
    const host = await scripted((method, res) => {
      if (method === 'unavailable') { res.writeHead(502); res.end('{"result":"stale"}'); return; }
      if (method === 'rejected') { res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'State already discarded' } })); return; }
      if (method === 'empty') { res.end(JSON.stringify({ jsonrpc: '2.0', id: 1 })); return; }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: method }));
    });
    const rpc = jsonRpcClient(`http://${host}/archive`);
    expect(await rpc('system_chain', [])).toBe('system_chain');
    await expect(rpc('unavailable', [])).rejects.toMatchObject({ code: -32003, message: 'Upstream unavailable' });
    await expect(rpc('rejected', [])).rejects.toMatchObject({ code: -32000, message: 'State already discarded' });
    await expect(rpc('empty', [])).rejects.toMatchObject({ code: -32003, message: 'Invalid upstream response' });
  });

  it('never downgrades an HTTPS upstream to plaintext', async () => {
    // A raw loopback TCP peer records what the client sends first, then answers in plaintext HTTP.
    const received: Buffer[] = [];
    const sockets = new Set<Socket>();
    const server = createTcpServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => undefined);
      socket.once('data', (data: Buffer) => {
        received.push(data);
        const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'plaintext' });
        socket.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n${body}`);
      });
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    closers.push(() => new Promise<void>((resolve) => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }));
    const port = (server.address() as AddressInfo).port;
    await expect(jsonRpcClient(`https://127.0.0.1:${port}/`, 1)('system_chain', [])).rejects.toMatchObject({
      code: expect.stringMatching(/^(EPROTO|ERR_SSL_)/), message: expect.stringMatching(/SSL|TLS|wrong version number/i),
    });
    expect(received).toHaveLength(1);
    // TLS handshake record (0x16) carrying a ClientHello (handshake type 0x01), never an HTTP request line.
    expect(received[0][0]).toBe(0x16);
    expect(received[0][5]).toBe(0x01);
    expect(received[0].subarray(0, 5).toString('latin1')).not.toBe('POST ');
  });

  it('aborts an upstream response larger than 64 MiB and drops the upstream connection', async () => {
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    let upstreamClosed!: Promise<void>;
    const host = await scripted((_method, res) => {
      upstreamClosed = new Promise<void>((resolve) => res.socket!.once('close', () => resolve()));
      let sent = 0;
      const pump = () => {
        while (sent < 65) { sent++; if (!res.write(chunk)) { res.once('drain', pump); return; } }
        res.end();
      };
      pump();
    });
    await expect(jsonRpcClient(`http://${host}/`)('state_getMetadata', [])).rejects
      .toMatchObject({ code: -32003, message: 'Upstream response too large' });
    // A keep-alive socket would stay open until teardown had the transfer been read to the end.
    await upstreamClosed;
  }, SLOW);
});

type Reply = { jsonrpc: '2.0'; id?: unknown; result?: unknown; error?: { code: number; message: string }; method?: string; params?: { subscription: string; result: unknown } };
const request = (id: number, method = 'system_health', params: unknown[] = [id]) => ({ jsonrpc: '2.0', id, method, params });
/** Serve an adapter on an ephemeral loopback port. */
async function serve(adapter: LegacyReplayAdapter) {
  const replay = createLegacyReplayServer(adapter);
  replay.server.listen(0, '127.0.0.1'); await once(replay.server, 'listening');
  closers.push(replay.close);
  const host = `127.0.0.1:${(replay.server.address() as AddressInfo).port}`;
  const post = async (body: unknown) => fetch(`http://${host}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { ws: `ws://${host}`, post };
}
async function open(url: string) {
  const ws = new WebSocket(url); await once(ws, 'open');
  closers.push(async () => { ws.terminate(); });
  const replies: Reply[] = [];
  ws.on('message', (data) => replies.push(JSON.parse(data.toString())));
  return { ws, replies };
}
const closed = (ws: WebSocket) => new Promise<[number, string]>((resolve) => ws.on('close', (code, reason) => resolve([code, reason.toString()])));
async function refused(url: string) {
  const ws = new WebSocket(url); const opened = vi.fn();
  ws.on('error', () => undefined); ws.on('open', opened);
  const [code] = await closed(ws);
  expect(opened).not.toHaveBeenCalled();
  return code;
}
/** Hold every archive identity read until released, answering with its first parameter. */
function hold(archive: ReturnType<typeof fixture>['archive']) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  archive.mockClear();
  archive.mockImplementation(async (_method, params) => { await gate; return params[0]; });
  gates.push(release);
  return release;
}

describe('bounded pre-fork replay HTTP server', () => {
  it('rejects non-POST, oversized, malformed and invalid requests and unsupported batches', async () => {
    const { adapter } = fixture();
    await adapter.verify();
    const s = await serve(adapter);
    const get = await fetch(s.ws.replace('ws:', 'http:'));
    expect(get.status).toBe(405);
    expect(await get.json()).toEqual({ error: 'POST required' });
    const large = await s.post('a'.repeat(300_000));
    expect(large.status).toBe(413);
    expect(await large.json()).toEqual({ error: 'Request too large' });
    const invalid = { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid JSON-RPC request' } };
    expect(await (await s.post('{')).json()).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } });
    expect(await (await s.post({ jsonrpc: '2.0', method: 'system_health' })).json()).toEqual(invalid);
    expect(await (await s.post({ jsonrpc: '1.0', id: 1, method: 'system_health' })).json()).toEqual(invalid);
    const unsupported = { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Unsupported batch' } };
    expect(await (await s.post([])).json()).toEqual(unsupported);
    expect(await (await s.post(Array.from({ length: 17 }, (_, i) => request(i, 'chain_getHead')))).json()).toEqual(unsupported);
  });

  it('answers bounded batches, defaults omitted parameters and hides transport failures', async () => {
    const { adapter, archive } = fixture();
    await adapter.verify();
    const s = await serve(adapter);
    expect(await (await s.post([{ jsonrpc: '2.0', id: 'head', method: 'chain_getFinalizedHead' }, request(2, 'chain_getBlockHash', [CAP.height + 1])])).json()).toEqual([
      { jsonrpc: '2.0', id: 'head', result: CAP.hash },
      { jsonrpc: '2.0', id: 2, error: { code: -32001, message: 'Block is beyond the pre-fork replay cap' } },
    ]);
    archive.mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.7:9933'));
    expect(await (await s.post(request(3))).json())
      .toEqual({ jsonrpc: '2.0', id: 3, error: { code: -32003, message: 'Upstream request failed' } });
    archive.mockResolvedValueOnce(1n);
    const unencodable = await s.post(request(4));
    expect(unencodable.status).toBe(400);
    expect(await unencodable.json()).toEqual({ error: 'Invalid request' });
  });

  it('refuses requests beyond 256 in flight with -32004 and recovers once they finish', async () => {
    const { adapter, archive } = fixture();
    await adapter.verify();
    const s = await serve(adapter);
    const release = hold(archive);
    const batches = Array.from({ length: 16 }, (_, b) =>
      s.post(Array.from({ length: 16 }, (_, i) => request(b * 16 + i))).then((response) => response.json() as Promise<Reply[]>));
    try {
      await vi.waitFor(() => expect(archive).toHaveBeenCalledTimes(256), WAIT);
      expect(await (await s.post(request(256))).json())
        .toEqual({ jsonrpc: '2.0', id: 256, error: { code: -32004, message: 'Replay concurrency limit' } });
    } finally {
      release();
      await Promise.allSettled(batches);
    }
    // Every submitted request is answered with its own id and result, in submission order.
    expect((await Promise.all(batches)).flat()).toEqual(Array.from({ length: 256 }, (_, id) => ({ jsonrpc: '2.0', id, result: id })));
    expect(await (await s.post(request(257))).json()).toEqual({ jsonrpc: '2.0', id: 257, result: 257 });
  }, SLOW);
});

describe('bounded pre-fork replay WebSocket server', () => {
  it('refuses upgrades before admission and beyond 16 clients', async () => {
    const unverified = await serve(fixture().adapter);
    expect(await refused(unverified.ws)).toBe(1006);
    expect(await (await unverified.post(request(1))).json())
      .toEqual({ jsonrpc: '2.0', id: 1, error: { code: -32002, message: 'Pre-fork replay identity is not verified' } });
    const { adapter } = fixture();
    await adapter.verify();
    const s = await serve(adapter);
    await Promise.all(Array.from({ length: 16 }, () => open(s.ws)));
    expect(await refused(s.ws)).toBe(1006);
  });

  it('rejects malformed JSON, batches, invalid requests and bad subscriptions, and defaults omitted parameters', async () => {
    const { adapter } = fixture();
    await adapter.verify();
    const { ws, replies } = await open((await serve(adapter)).ws);
    ws.send('{');
    ws.send(JSON.stringify([request(1)]));
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: {}, method: 'system_health' }));
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'storage', method: 'state_subscribeStorage', params: [[]] }));
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'version', method: 'chain_subscribeRuntimeVersion' }));
    await vi.waitFor(() => expect(replies).toHaveLength(6), WAIT);
    expect(replies).toEqual(expect.arrayContaining([
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } },
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Unsupported batch' } },
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid JSON-RPC request' } },
      { jsonrpc: '2.0', id: 'storage', error: { code: -32602, message: 'Expected a bounded list of storage keys' } },
    ]));
    const subscribed = replies.find((reply) => reply.id === 'version');
    expect(subscribed?.result).toMatch(/^[0-9a-f]{16}$/);
    expect(replies.find((reply) => reply.method === 'state_runtimeVersion'))
      .toEqual({ jsonrpc: '2.0', method: 'state_runtimeVersion', params: { subscription: subscribed!.result, result: capVersion } });
  }, SLOW);

  it('closes with 1008 on a binary frame', async () => {
    const { adapter, archive } = fixture();
    await adapter.verify(); archive.mockClear();
    const { ws } = await open((await serve(adapter)).ws);
    const done = closed(ws);
    ws.send(Buffer.from(JSON.stringify(request(1))), { binary: true });
    expect(await done).toEqual([1008, 'Invalid payload or concurrency limit']);
    expect(archive).not.toHaveBeenCalled();
  });

  it('closes with 1008 beyond 128 pending requests and drops replies for the closed client', async () => {
    const { adapter, archive } = fixture();
    await adapter.verify();
    const { ws, replies } = await open((await serve(adapter)).ws);
    const release = hold(archive);
    const done = closed(ws);
    try {
      for (let id = 0; id < 129; id++) ws.send(JSON.stringify(request(id)));
      expect(await done).toEqual([1008, 'Invalid payload or concurrency limit']);
      expect(archive).toHaveBeenCalledTimes(128);
    } finally {
      release();
      await Promise.allSettled(archive.mock.results.map((result) => result.value));
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(replies).toEqual([]);
  });

  it('terminates a client whose outbound buffer exceeds 64 MiB', async () => {
    const { adapter } = fixture();
    await adapter.verify();
    const { ws, replies } = await open((await serve(adapter)).ws);
    const done = closed(ws);
    vi.spyOn(WebSocket.prototype, 'bufferedAmount', 'get').mockReturnValue(64 * 1024 * 1024 + 1);
    ws.send(JSON.stringify(request(1, 'chain_getFinalizedHead', [])));
    expect((await done)[0]).toBe(1006);
    expect(replies).toEqual([]);
  });
});
