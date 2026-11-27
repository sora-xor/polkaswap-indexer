import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { ApiPromise } from '@polkadot/api';
import { TypeRegistry } from '@polkadot/types';
import type { Header } from '@polkadot/types/interfaces';
import { blake2AsHex } from '@polkadot/util-crypto';
import { describe, expect, it, vi } from 'vitest';
import { decodeRecoveryHeader } from '../src/recovery-header.js';
import { ChainIndexer, soraArchiveTypesBundle } from '../src/worker/chain.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { RECOVERY_EVENTS_KEY, RECOVERY_TIMESTAMP_KEY } from '../src/recovery-metadata.js';
import { SORA_MAINNET_GENESIS_HASH } from '../src/soraIdentity.js';

const registry = new TypeRegistry();
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const metadata = `0x${gunzipSync(readFileSync(new URL('./fixtures/recovery-134/original-134.metadata.scale.gz', import.meta.url))).toString('hex')}`;
const runtime = (specVersion: number) => ({ specName: 'sora-substrate', implName: 'sora-substrate', specVersion,
  implVersion: 0, authoringVersion: 1, transactionVersion: 1, stateVersion: 0, apis: [] });

function fixture(height = 28191829) {
  const logs = [registry.createType('DigestItem', { PreRuntime: ['0x42414245', '0x01020304'] }).toHex(),
    registry.createType('DigestItem', { Seal: ['0x42414245', '0x05060708'] }).toHex()];
  const raw = { parentHash: hash(1), number: `0x${height.toString(16)}`, stateRoot: hash(2), extrinsicsRoot: hash(3), digest: { logs } };
  const header = registry.createType<Header>('Header', raw);
  return { raw, header, requestedHash: header.hash.toHex() };
}

describe('fixed-protocol raw recovery header', () => {
  it('preserves every canonical header field, SCALE digest byte and exact header hash', () => {
    const { raw, header, requestedHash } = fixture();
    const decoded = decodeRecoveryHeader(requestedHash, raw);
    expect(decoded.toHex()).toBe(header.toHex()); expect(decoded.hash.toHex()).toBe(requestedHash);
    expect(decoded.number.toNumber()).toBe(28191829);
    expect(decoded.digest.logs.map((log) => log.toHex())).toEqual(raw.digest.logs);
  });
  it.each([null, [], {}, '0x00'])('rejects missing or malformed header %j', (raw) => {
    expect(() => decodeRecoveryHeader(hash(8), raw)).toThrow(/header/);
  });
  it.each(['0x0', '0x100000000', '12', '-1', '0xgg', 1, null])('rejects invalid or overflowing wire height %j', (number) => {
    const { raw, requestedHash } = fixture();
    expect(() => decodeRecoveryHeader(requestedHash, { ...raw, number })).toThrow(/header/);
  });
  it('accepts the maximum u32 height and rejects another valid height/hash or parent/root substitution', () => {
    const max = fixture(0xffffffff); expect(decodeRecoveryHeader(max.requestedHash, max.raw).number.toNumber()).toBe(0xffffffff);
    const { raw, requestedHash } = fixture();
    for (const patch of [{ number: '0x1' }, { parentHash: hash(9) }, { parentHash: hash(0) }, { stateRoot: hash(9) },
      { extrinsicsRoot: hash(9) }, { stateRoot: '0x00' }, { extra: true }]) {
      expect(() => decodeRecoveryHeader(requestedHash, { ...raw, ...patch })).toThrow();
    }
    expect(() => decodeRecoveryHeader(hash(0), raw)).toThrow();
    expect(() => decodeRecoveryHeader(hash(9), raw)).toThrow(/identity/);
  });
  it('rejects malformed, truncated, trailing, unknown and noncanonical digest encodings', () => {
    const { raw, requestedHash } = fixture();
    for (const logs of [[raw.digest.logs[0] + '00'], [raw.digest.logs[0].slice(0, -2)], ['0xff'], ['0x0'],
      ['0x00050000'], [42], new Array(4097).fill('0x08')]) {
      const input = { ...raw, digest: { logs } };
      let parsedHash = requestedHash;
      try { parsedHash = registry.createType<Header>('Header', input).hash.toHex(); } catch { /* Invalid SCALE is already rejected. */ }
      // Even when the permissive SDK produces a matching header hash, noncanonical input is rejected.
      expect(() => decodeRecoveryHeader(parsedHash, input)).toThrow();
    }
    expect(() => decodeRecoveryHeader(requestedHash, { ...raw, digest: { logs: [], unexpected: true } })).toThrow();
    expect(() => decodeRecoveryHeader(requestedHash, { ...raw, digest: { logs: ['0x' + '00'.repeat(4 * 1024 * 1024)] } })).toThrow(/bound/);
  });
  it('uses raw headers only for stats recovery and keeps ordinary full-recovery decorated behavior', async () => {
    for (const stats of [true, false]) {
      const { raw, header, requestedHash } = fixture();
      const getHeader = Object.assign(vi.fn(async () => header), { raw: vi.fn(async () => raw) });
      const getMetadata = { raw: vi.fn(async () => metadata) };
      const getStorage = { raw: vi.fn(async (key: string) => key === RECOVERY_EVENTS_KEY ? '0x00'
        : key === RECOVERY_TIMESTAMP_KEY ? registry.createType('u64', 1793449134000).toHex(true) : null) };
      const api = { rpc: { chain: { getHeader, getBlock: { raw: vi.fn(async () => ({ block: { header: raw, extrinsics: [] }, justifications: null })) } },
        state: { getMetadata, getStorage } } };
      const worker = new ChainIndexer({ soraWsEndpoint: 'ws://127.0.0.1:9948', chainRpcTimeoutMs: 15000,
        burnRecoveryPolicy: { metadata: [{ firstBlock: 1, lastBlock: 0xffffffff, metadataHash: blake2AsHex(metadata, 256), executionCodeHash: hash(20) }] } } as never, new MemoryRepository()) as any;
      if (stats) worker.config.statsRecoveryAdmission = {};
      worker.api = api;
      try {
        const result = await worker.fetchBlockPayloadFromApi(requestedHash, api, true, (f: () => Promise<unknown>) => f());
        expect(result.fetchedBlock.signedBlock.block.header.hash.toHex()).toBe(requestedHash);
        expect(result.fetchedBlock.timestamp).toBe(1793449134);
        expect(getHeader).toHaveBeenCalledTimes(stats ? 0 : 1); expect(getHeader.raw).toHaveBeenCalledTimes(stats ? 1 : 0);
        expect(getMetadata.raw).toHaveBeenCalledTimes(1);
      } finally { worker.recoveryMetadataCache?.close(); }
    }
  });
  it('rejects aggregate oversized logs before serializing the header', () => {
    const { raw, requestedHash } = fixture();
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      const oversized = { ...raw, digest: { logs: new Array(1024).fill('0x' + '00'.repeat(4096)) } };
      expect(() => decodeRecoveryHeader(requestedHash, oversized)).toThrow('aggregate bound');
      expect(stringify).not.toHaveBeenCalled();
    } finally { stringify.mockRestore(); }
  });
  it('rejects an invalid raw header before fetching any metadata or block payload', async () => {
    const { raw, requestedHash } = fixture();
    const getHeader = Object.assign(vi.fn(), { raw: vi.fn(async () => ({ ...raw, number: '0x1' })) });
    const worker = new ChainIndexer({ burnRecoveryPolicy: { metadata: [{ firstBlock: 1 }] } } as never,
      new MemoryRepository()) as any;
    worker.config.statsRecoveryAdmission = {};
    const readMetadata = vi.spyOn(worker, 'readRecoveryMetadata');
    await expect(worker.fetchBlockPayloadFromApi(requestedHash, { rpc: { chain: { getHeader } } }, true, (f: () => Promise<unknown>) => f())).rejects.toThrow(/identity/);
    expect(getHeader).not.toHaveBeenCalled(); expect(readMetadata).not.toHaveBeenCalled();
  });
  it('leaves the ordinary no-policy block branch untouched and preserves the caller RPC failure', async () => {
    const { requestedHash } = fixture();
    const worker = new ChainIndexer({} as never, new MemoryRepository()) as any;
    const getHeader = Object.assign(vi.fn(), { raw: vi.fn() });
    const request = vi.fn(async () => { throw new Error('ordinary RPC failure'); });
    await expect(worker.fetchBlockPayloadFromApi(requestedHash, { rpc: { chain: { getHeader } } }, true, request)).rejects.toThrow('ordinary RPC failure');
    expect(getHeader).not.toHaveBeenCalled(); expect(getHeader.raw).not.toHaveBeenCalled();
    expect(request.mock.calls.length).toBeGreaterThan(0);
  });
});

describe('installed ApiPromise historical RPC wire behavior (fully offline)', () => {
  it('raw getHeader avoids real SDK parent-version/metadata registry work without changing returned header bytes', async () => {
    const rows = [fixture(), fixture(28191830), fixture(28191831)];
    const calls: string[] = [];
    // Synthetic default 138 and parent 134 exercise an uncached SDK version. Retained 134 metadata
    // supplies real declarations; this fixture proves transport behavior, not live runtime admission.
    const provider = { hasSubscriptions: false, isClonable: false, isConnected: true,
      connect: async () => undefined, disconnect: async () => undefined, on: () => () => undefined,
      send: async (method: string, params: unknown[]) => {
        calls.push(method);
        if (method === 'chain_getBlockHash') return SORA_MAINNET_GENESIS_HASH;
        if (method === 'system_chain') return 'SORA Mainnet';
        if (method === 'system_properties') return { ss58Format: 69, tokenDecimals: 18, tokenSymbol: 'XOR' };
        if (method === 'rpc_methods') return { version: 1, methods: ['chain_getHeader', 'chain_getBlockHash', 'state_getMetadata', 'state_getRuntimeVersion', 'system_chain', 'system_properties'] };
        if (method === 'state_getRuntimeVersion') return runtime(params.length ? 134 : 138);
        if (method === 'state_getMetadata') return metadata;
        if (method === 'chain_getHeader') return rows.find((row) => row.requestedHash === params[0])!.raw;
        throw new Error(`Unexpected offline wire method ${method}`);
      } };
    const api = await ApiPromise.create({ provider: provider as never, noInitWarn: true, throwOnConnect: true,
      typesBundle: soraArchiveTypesBundle, metadata: { [`${SORA_MAINNET_GENESIS_HASH}-138`]: metadata as `0x${string}` } });
    try {
      calls.length = 0;
      const decorated = await api.rpc.chain.getHeader(rows[0].requestedHash);
      expect(decorated.toHex()).toBe(rows[0].header.toHex());
      expect(calls).toEqual(['chain_getHeader', 'state_getRuntimeVersion', 'state_getMetadata', 'chain_getHeader']);
      calls.length = 0;
      const decoded = decodeRecoveryHeader(rows[1].requestedHash, await api.rpc.chain.getHeader.raw(rows[1].requestedHash));
      expect(decoded.toHex()).toBe(rows[1].header.toHex()); expect(calls).toEqual(['chain_getHeader']);
      calls.length = 0;
      await api.rpc.chain.getHeader(rows[2].requestedHash);
      // Known versions still cost a hidden header and runtime-version read for a different block.
      expect(calls).toEqual(['chain_getHeader', 'state_getRuntimeVersion', 'chain_getHeader']);
    } finally { await api.disconnect(); }
  }, 30_000);
});
