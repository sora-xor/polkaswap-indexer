import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { ApiPromise } from '@polkadot/api';
import { TypeRegistry } from '@polkadot/types';
import type { Header } from '@polkadot/types/interfaces';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { blake2AsHex } from '@polkadot/util-crypto';
import { RecoveryQueryContexts } from '../src/recovery-query-context.js';
import { RecoveryMetadataCache } from '../src/recovery-metadata-cache.js';
import { ATTACKER_ACCOUNT, RECOVERY_CHECKPOINT, type BurnRecoveryPolicy } from '../src/burn-recovery.js';
import { SORA_MAINNET_GENESIS_HASH } from '../src/soraIdentity.js';
import { ChainIndexer, soraArchiveTypesBundle } from '../src/worker/chain.js';
import { MemoryRepository } from '../src/repository/memory.js';

const hex = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const original = `0x${gunzipSync(readFileSync(new URL('./fixtures/recovery-134/original-134.metadata.scale.gz', import.meta.url))).toString('hex')}`;
const substitute = `0x${gunzipSync(readFileSync(new URL('./fixtures/recovery-134/recovery-134.metadata.scale.gz', import.meta.url))).toString('hex')}`;
const version = (specVersion: number) => ({ specName: 'sora-substrate', implName: 'sora-substrate', specVersion,
  implVersion: 0, authoringVersion: 1, transactionVersion: 1, stateVersion: 0, apis: [] });
const policy: BurnRecoveryPolicy = { version: 1, policyHash: hex(1), releaseManifestHash: hex(2),
  genesisHash: SORA_MAINNET_GENESIS_HASH, checkpoint: RECOVERY_CHECKPOINT,
  postForkAnchor: { block: 28194043, hash: hex(3) }, substitutions: [], attackerAccounts: [ATTACKER_ACCOUNT],
  metadata: [
    { firstBlock: 28073393, lastBlock: 28191817, executionCodeHash: hex(4), metadataHash: blake2AsHex(original, 256) },
    { firstBlock: 28191818, lastBlock: 28194042, executionCodeHash: hex(5), metadataHash: blake2AsHex(substitute, 256) },
    // Synthetic version-138 context isolates version/caching behavior. The separate actual four-state
    // diagnostic must validate the real runtime-138 metadata; this fixture makes no live admission claim.
    { firstBlock: 28194043, lastBlock: Number.MAX_SAFE_INTEGER, executionCodeHash: hex(6), metadataHash: blake2AsHex(substitute, 256) },
  ] };
const managers: RecoveryQueryContexts[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map((m) => m.close())); vi.restoreAllMocks(); });

/** Real pinned 134 metadata and synthetic canonical headers over a fully offline raw RPC fixture. */
function fixture(options: { maximumClients?: number; timeoutMs?: number } = {}) {
  const registry = new TypeRegistry();
  const rows = [
    { height: 28191816, spec: 134, parentSpec: 134, metadata: original },
    { height: 28191817, spec: 134, parentSpec: 134, metadata: substitute },
    { height: 28191818, spec: 134, parentSpec: 134, metadata: substitute },
    { height: 28194042, spec: 138, parentSpec: 134, metadata: substitute },
    { height: 28194043, spec: 138, parentSpec: 138, metadata: substitute },
  ].map((row, index) => {
    const parentHash = hex(100 + index);
    const header = registry.createType<Header>('Header', { number: row.height, parentHash,
      stateRoot: hex(200 + index), extrinsicsRoot: hex(300 + index), digest: { logs: [] } });
    return { ...row, hash: header.hash.toHex(), parentHash, header: header.toJSON() };
  });
  const owner = { disconnect: vi.fn() };
  const rpc = vi.fn(async (method: string, params: unknown[]): Promise<unknown> => {
    if (method === 'chain_getBlockHash') return params[0] === 0 ? SORA_MAINNET_GENESIS_HASH : rows.find((r) => r.height === params[0])?.hash;
    if (method === 'system_chain') return 'SORA Mainnet';
    if (method === 'system_properties') return { ss58Format: 69, tokenDecimals: 18, tokenSymbol: 'XOR' };
    const row = rows.find((r) => r.hash === params.at(-1));
    if (method === 'chain_getHeader') return row?.header;
    if (method === 'state_getMetadata') return row?.metadata;
    if (method === 'state_getRuntimeVersion') {
      const parent = rows.find((r) => r.parentHash === params[0]);
      return row ? version(row.spec) : parent ? version(parent.parentSpec) : null;
    }
    if (method === 'state_getStorage') return registry.createType('u64', row?.height ?? 0).toHex(true);
    if (method === 'state_getStorageSize') return 8;
    if (method === 'state_getStorageHash') return hex(99);
    if (method === 'state_getKeysPaged') return [];
    throw new Error(`Unexpected fixture RPC ${method}`);
  });
  const manager = new RecoveryQueryContexts({ policy, rpc: rpc as never, execute: (request) => request(),
    typesBundle: soraArchiveTypesBundle, ...options });
  managers.push(manager);
  return { manager, rows, rpc, owner };
}

describe('exact-state recovery query contexts', () => {
  it('keeps original 134, substituted 134 and actual-version 138 registries separate with retained types and chain properties', async () => {
    const { manager, rows, rpc, owner } = fixture();
    const contexts = [];
    for (const row of rows) contexts.push(await manager.at(row.hash));
    expect(contexts.map((c) => c.evidence.storageEntries)).toEqual([491, 492, 492, 492, 492]);
    expect(contexts[0].registry).not.toBe(contexts[1].registry);
    expect(contexts[1].registry).toBe(contexts[2].registry);
    expect(contexts[3].registry).not.toBe(contexts[4].registry);
    expect(contexts.map((c) => c.evidence.fixedTransitionContext)).toEqual([false, false, false, true, false]);
    expect(contexts[0].query.substrateBridgeApp.deferredTransferResults).toBeUndefined();
    expect(typeof contexts[1].query.substrateBridgeApp.deferredTransferResults).toBe('function');
    expect(contexts[1].registry.knownTypes.typesBundle).toBe(soraArchiveTypesBundle);
    expect(contexts[1].registry.chainSS58).toBe(69);
    // Reenter old and transition contexts after another .at() has run, including overlapping reads.
    const values = await Promise.all(contexts.map((c) => c.query.timestamp.now()));
    expect(values.map(String)).toEqual(rows.map((r) => String(r.height)));
    expect(await contexts[1].query.assets.assetInfos.entriesPaged({ args: [], pageSize: 1000 })).toEqual([]);
    expect((await contexts[3].query.timestamp.now()).toString()).toBe(String(rows[3].height));
    expect(rpc.mock.calls.every(([method]) => !method.includes('subscribe') && !method.includes('author_') && method !== 'state_call')).toBe(true);
    await manager.close();
    expect(owner.disconnect).not.toHaveBeenCalled();
    await expect(contexts[0].query.timestamp.now()).rejects.toThrow('closed');
  }, 120_000);

  it('decodes core map size, paged entries and multi values with retained tuple/Option semantics', async () => {
    const { manager, rows, rpc } = fixture();
    const context = await manager.at(rows[1].hash);
    const storage = context.query.assets.assetInfos;
    const asset = { code: hex(50) };
    const key = storage.key(asset);
    const valueType = storage.creator.meta.type.asMap.value;
    const value = context.registry.createTypeUnsafe(`Lookup${valueType}`, [['XOR', 'SORA', 18, true, null, null]]).toHex();
    const originalRpc = rpc.getMockImplementation()!;
    rpc.mockImplementation(async (method, params) => {
      if (method === 'state_getKeysPaged') return [key];
      if (method === 'state_queryStorageAt') return [{ block: params[1], changes: [[key, value]] }];
      if (method === 'state_getStorage') return value;
      if (method === 'state_getStorageSize') return (value.length - 2) / 2;
      return originalRpc(method, params);
    });
    expect((await storage.size(asset)).toNumber()).toBe((value.length - 2) / 2);
    const page = await storage.entriesPaged({ args: [], pageSize: 1000 });
    expect(page).toHaveLength(1);
    expect(page[0][0].toHex()).toBe(key);
    expect(page[0][1].toHuman()).toEqual(['XOR', 'SORA', '18', true, null, null]);
    const multi = await storage.multi([asset]);
    expect(multi.map((v) => v.toHuman())).toEqual([['XOR', 'SORA', '18', true, null, null]]);
    expect((await storage(asset)).toHuman()).toEqual(['XOR', 'SORA', '18', true, null, null]);
    await expect(storage.entriesPaged({ args: [], pageSize: 1001 })).rejects.toThrow('pagination exceeds bound');
  }, 120_000);

  it.each(['block', 'bytes', 'key', 'duplicate'] as const)('rejects %s corruption in storage change sets', async (kind) => {
    const { manager, rows, rpc } = fixture();
    const context = await manager.at(rows[1].hash), storage = context.query.assets.assetInfos;
    const asset = { code: hex(50) }, key = storage.key(asset);
    const originalRpc = rpc.getMockImplementation()!;
    rpc.mockImplementation((method, params) => method === 'state_queryStorageAt' ? Promise.resolve([{
      block: kind === 'block' ? rows[0].hash : rows[1].hash,
      changes: kind === 'duplicate' ? [[key, null], [key, null]] : [[kind === 'key' ? hex(99) : key, kind === 'bytes' ? 'garbage' : null]],
    }]) : originalRpc(method, params));
    await expect(storage.multi([asset])).rejects.toThrow(/change-set/);
  }, 120_000);

  it('cleans a failed isolated client and allows only an explicit later independently verified retry', async () => {
    const { manager, rows, owner, rpc } = fixture();
    const creation = vi.spyOn(ApiPromise, 'create').mockRejectedValueOnce(new Error('fixture initialization failed'));
    await expect(manager.at(rows[0].hash)).rejects.toThrow('fixture initialization failed');
    const previousReads = rpc.mock.calls.filter(([m]) => m === 'state_getMetadata').length;
    const context = await manager.at(rows[0].hash);
    expect(context.evidence.storageEntries).toBe(491);
    expect(creation).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls.filter(([m]) => m === 'state_getMetadata')).toHaveLength(previousReads + 1);
    expect(owner.disconnect).not.toHaveBeenCalled();
  }, 120_000);

  it('retains clients instead of evicting an in-flight context and rejects cache overflow', async () => {
    const { manager, rows, rpc } = fixture({ maximumClients: 1 });
    const old = await manager.at(rows[0].hash);
    const originalRpc = rpc.getMockImplementation()!;
    let finish: ((value: unknown) => void) | undefined;
    rpc.mockImplementation((method, params) => method === 'state_getStorage'
      ? new Promise((resolve) => { finish = resolve; }) : originalRpc(method, params));
    const pending = old.query.timestamp.now();
    await vi.waitFor(() => expect(finish).toBeDefined());
    await expect(manager.at(rows[1].hash)).rejects.toThrow('cache bound');
    finish!('0x0100000000000000');
    expect((await pending).toString()).toBe('1');
  }, 120_000);

  it.each(['metadata', 'version', 'canonical', 'header'] as const)('fails closed on invalid %s evidence before constructing a client', async (kind) => {
    const { manager, rows, rpc } = fixture();
    const old = rpc.getMockImplementation()!;
    rpc.mockImplementation(async (method, params) => {
      if (kind === 'metadata' && method === 'state_getMetadata') return original;
      if (kind === 'version' && method === 'state_getRuntimeVersion') return { ...version(134), specVersion: '134' };
      if (kind === 'canonical' && method === 'chain_getBlockHash') return hex(99);
      if (kind === 'header' && method === 'chain_getHeader') return rows[0].header;
      return old(method, params);
    });
    await expect(manager.at(rows[1].hash)).rejects.toThrow(/metadata witness|runtime version|canonical header/);
    expect(rpc.mock.calls.some(([method]) => method === 'state_getStorage')).toBe(false);
  });

  it('refuses missing metadata and RPC writes without calling the owner', async () => {
    const { manager, rows, rpc } = fixture();
    const old = rpc.getMockImplementation()!;
    rpc.mockImplementation((method, params) => method === 'state_getMetadata' ? Promise.resolve(null) : old(method, params));
    await expect(manager.at(rows[0].hash)).rejects.toThrow('metadata witness');
    const calls = rpc.mock.calls.length;
    await expect(manager.raw('author_submitExtrinsic', ['0x00'])).rejects.toThrow('not allowed');
    expect(rpc).toHaveBeenCalledTimes(calls);
  });

  it('cancels pending evidence reads and rejects later work without disconnecting the owner', async () => {
    const { manager, rows, rpc, owner } = fixture();
    rpc.mockImplementation(() => new Promise(() => undefined));
    const pending = manager.at(rows[0].hash);
    await manager.close();
    await expect(pending).rejects.toThrow('cancelled');
    await expect(manager.at(rows[0].hash)).rejects.toThrow('cancelled');
    expect(owner.disconnect).not.toHaveBeenCalled();
  });

  it('does not start another evidence read when the capture deadline expires', async () => {
    const { manager, rows, rpc } = fixture({ timeoutMs: 20 });
    const originalRpc = rpc.getMockImplementation()!;
    rpc.mockImplementation(async (method, params) => {
      if (method === 'chain_getHeader') await new Promise((resolve) => setTimeout(resolve, 40));
      return originalRpc(method, params);
    });
    await expect(manager.at(rows[0].hash)).rejects.toThrow('deadline');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(rpc.mock.calls.map(([method]) => method)).toEqual(['chain_getHeader']);
  });

  it('rejects malformed storage bytes, oversized size and an unpinned metadata range', async () => {
    const { manager, rows, rpc } = fixture();
    const at = await manager.at(rows[0].hash);
    const originalRpc = rpc.getMockImplementation()!;
    rpc.mockImplementation((method, params) => method === 'state_getStorage' ? Promise.resolve({ invalid: true }) :
      method === 'state_getStorageSize' ? Promise.resolve(16 * 1024 * 1024 + 1) : originalRpc(method, params));
    await expect(at.query.timestamp.now()).rejects.toThrow('storage bytes');
    await expect(at.query.timestamp.now.size()).rejects.toThrow('storage size');
    const partial = structuredClone(policy);
    partial.metadata[0].firstBlock = RECOVERY_CHECKPOINT.block;
    const unpinned = new RecoveryQueryContexts({ policy: partial, rpc: rpc as never, execute: (read) => read() });
    managers.push(unpinned);
    // Prefix state's next execution is checkpoint, still pinned; use a lower synthetic canonical header.
    const header = new TypeRegistry().createType<Header>('Header', { number: 28073390, parentHash: hex(77),
      stateRoot: hex(78), extrinsicsRoot: hex(79), digest: { logs: [] } });
    rpc.mockImplementation(async (method) => method === 'chain_getHeader' ? header.toJSON() : header.hash.toHex());
    await expect(unpinned.at(header.hash.toHex())).rejects.toThrow('No pinned execution metadata');
  }, 120_000);

  it('bounds a stalled evidence request by a finite deadline', async () => {
    const { manager, rows, rpc } = fixture({ timeoutMs: 20 });
    rpc.mockImplementation(() => new Promise(() => undefined));
    await expect(manager.at(rows[0].hash)).rejects.toThrow('deadline');
  });

  it.each([true, false])('routes the actual stats selector through owned provider with legacy bundle gate=%s and closes its contexts', async (enabled) => {
    const { rows, rpc } = fixture();
    const worker = new ChainIndexer({ soraWsEndpoint: 'ws://127.0.0.1:9948', legacySoraBlockTypes: enabled, chainRpcTimeoutMs: 1000 } as never,
      new MemoryRepository()) as any;
    worker.config.statsRecoveryAdmission = { policy }; // Selector fixture; the constructor's real admission is independently covered.
    const api = { at: vi.fn(), rpc: { state: { getMetadata: { raw: (hash: string) => rpc('state_getMetadata', [hash]) } } } }, owner = { send: rpc, disconnect: vi.fn() };
    worker.api = api;
    worker.recoveryQueryProviders.set(api, owner);
    const context = await worker.fetchApiAtFrom(api, rows[1].hash, 'stats fixture');
    expect(context.registry.knownTypes.typesBundle).toBe(enabled ? soraArchiveTypesBundle : undefined);
    expect((await context.query.timestamp.now()).toString()).toBe(String(rows[1].height));
    expect(api.at).not.toHaveBeenCalled();
    await worker.stop();
    await expect(context.query.timestamp.now()).rejects.toThrow('closed');
    expect(owner.disconnect).not.toHaveBeenCalled();
    expect(worker.recoveryQueryContexts.size).toBe(0);
  }, 120_000);

  it('keeps ordinary/full-replay api.at behavior and requires the owned provider only in stats mode', async () => {
    const api = { at: vi.fn().mockResolvedValue({ query: { untouched: true } }) };
    const legacy = new ChainIndexer({ chainRpcTimeoutMs: 1000 } as never, new MemoryRepository()) as any;
    expect(await legacy.fetchApiAtFrom(api, hex(1), 'legacy')).toEqual({ query: { untouched: true } });
    const stats = new ChainIndexer({} as never, new MemoryRepository()) as any;
    stats.config.statsRecoveryAdmission = { policy }; // Exercise only the private context selector; admission has independent coverage.
    await expect(stats.fetchApiAtFrom(api, hex(1), 'stats')).rejects.toThrow('owned canonical provider');
    expect(api.at).toHaveBeenCalledTimes(1);
  });

  it('shared raw cache preserves canonical/version checks and same-spec metadata boundaries for every capture', async () => {
    const { rows, rpc } = fixture();
    const cache = new RecoveryMetadataCache();
    const metadata = vi.fn((hash: string, expected: string) => cache.read('ws://127.0.0.1:9948', hash, expected,
      () => rpc('state_getMetadata', [hash])));
    const manager = new RecoveryQueryContexts({ policy, rpc: rpc as never, execute: (request) => request(), readMetadata: metadata,
      typesBundle: soraArchiveTypesBundle }); managers.push(manager);
    try {
      // Simulate block prefetch having witnessed parent bytes before valuation asks for that state.
      await metadata(rows[0].hash, policy.metadata[0].metadataHash);
      const a = await manager.at(rows[0].hash), b = await manager.at(rows[1].hash);
      expect(a.evidence.metadataHash).not.toBe(b.evidence.metadataHash);
      expect(a.evidence.specVersion).toBe(b.evidence.specVersion);
      expect(rpc.mock.calls.filter(([method, params]) => method === 'state_getMetadata' && params[0] === rows[0].hash)).toHaveLength(1);
      const normal = rpc.getMockImplementation()!;
      rpc.mockImplementation((method, params) => method === 'chain_getBlockHash' && params[0] === rows[0].height
        ? Promise.resolve(hex(999)) : normal(method, params));
      await expect(manager.at(rows[0].hash)).rejects.toThrow('canonical header');
      rpc.mockImplementation((method, params) => method === 'state_getRuntimeVersion' && params[0] === rows[0].hash
        ? Promise.resolve(null) : normal(method, params));
      await expect(manager.at(rows[0].hash)).rejects.toThrow('runtime version');
      // A malformed injected cache is independently rejected by the adapter's witness validation.
      const bad = new RecoveryQueryContexts({ policy, rpc: normal as never, execute: (request) => request(), readMetadata: async () => original });
      managers.push(bad); await expect(bad.at(rows[1].hash)).rejects.toThrow('metadata witness');
    } finally { cache.close(); }
  }, 120_000);

  it('closing a context cancels a hung injected metadata read and forbids late proof continuation', async () => {
    const { rows, rpc } = fixture();
    let release!: (value: string) => void;
    const hook = vi.fn(() => new Promise<string>((resolve) => { release = resolve; }));
    const manager = new RecoveryQueryContexts({ policy, rpc: rpc as never, execute: (request) => request(), readMetadata: hook });
    managers.push(manager);
    const pending = manager.at(rows[0].hash), rejected = expect(pending).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(hook).toHaveBeenCalledTimes(1));
    const count = rpc.mock.calls.length;
    await manager.close(); await rejected; release(original); await Promise.resolve(); await Promise.resolve();
    expect(rpc.mock.calls).toHaveLength(count);
  });
});
