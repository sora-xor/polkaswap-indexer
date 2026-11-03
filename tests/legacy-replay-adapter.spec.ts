import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLegacyReplayServer, LEGACY_REPLAY_CAP as CAP, LEGACY_REPLAY_GENESIS as G, LegacyReplayAdapter,
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
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

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
