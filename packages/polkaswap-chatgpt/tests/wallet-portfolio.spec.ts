import { describe, expect, it, vi } from 'vitest';
import type { ApiPromise } from '@polkadot/api';
import { ChainReader, SORA_GENESIS, XOR_ID } from '../src/chain.js';

const VAL = '0x0200040000000000000000000000000000000000000000000000000000000000';
const PSWAP = '0x0200050000000000000000000000000000000000000000000000000000000000';
const BLOCK = `0x${'1'.repeat(64)}`;
const PREFIX = `0x${'a'.repeat(64)}`;
const codec = (value: unknown) => ({ toJSON: () => value, toHuman: () => value });
function fixture(options: { empty?: boolean; unknown?: boolean; badPrefix?: boolean; nativeUnavailable?: boolean } = {}) {
  const key = (index: number, id: string) => ({
    toHex: () => `${options.badPrefix ? `0x${'b'.repeat(64)}` : PREFIX}${index.toString(16).padStart(2, '0')}`,
    args: [codec('wallet-a'), codec({ code: id })],
  });
  const rows = options.empty ? [] : [
    [key(1, VAL), codec({ free: '12668921175418', reserved: '0', frozen: '0' })],
    [key(2, PSWAP), codec({ free: '2000000000000000000', reserved: '0', frozen: '0' })],
  ] as const;
  const entriesPaged = vi.fn(async (input: { args: string[]; pageSize: number; startKey?: string }) => {
    const start = input.startKey ? rows.findIndex(row => row[0].toHex() === input.startKey) + 1 : 0;
    return rows.slice(start, start + input.pageSize);
  });
  const accounts = Object.assign(async () => codec({ free: '0', reserved: '0', frozen: '0' }), {
    keyPrefix: (address: string) => { if (address === 'invalid-address') throw new Error('Invalid account codec'); return address === 'wallet-a' ? PREFIX : `0x${'b'.repeat(64)}`; }, entriesPaged,
  });
  const assetInfosV2 = Object.assign(async ({ code }: { code: string }) => codec({
    symbol: code === XOR_ID ? 'XOR' : code === VAL ? 'VAL' : 'PSWAP', name: 'Chain asset', precision: '18',
  }), { size: async ({ code }: { code: string }) => codec(options.unknown && code === VAL ? '0' : '64') });
  const getHeader = vi.fn(async () => ({ number: { toNumber: () => 123 } }));
  const at = vi.fn(async () => ({ query: {
    tokens: { accounts }, assets: { assetInfosV2 },
    system: { account: async () => { if (options.nativeUnavailable) throw new Error('Native storage unavailable'); return codec({ data: { free: '0', reserved: '0', frozen: '0' } }); } },
    referrals: { referrerBalances: async () => codec(null) },
    timestamp: { now: async () => codec('1790840610006') },
    denomination: { denominator: async () => codec('100000000000000000000000000000000000000') },
  } }));
  const disconnect = vi.fn(async () => undefined);
  const api = {
    isConnected: true, genesisHash: { toHex: () => SORA_GENESIS },
    rpc: { chain: { getFinalizedHead: async () => ({ toHex: () => BLOCK }), getHeader, getBlockHash: async () => ({ toHex: () => BLOCK }) } },
    at, disconnect,
  } as unknown as ApiPromise;
  const createApi = vi.fn(async () => api);
  return { reader: new ChainReader('wss://ws.mof.sora.org', createApi), entriesPaged, at, disconnect, createApi };
}

describe('authoritative wallet token pagination', () => {
  it('finds held VAL from account storage and includes observed native XOR exactly once', async () => {
    const { reader, entriesPaged, at } = fixture();
    const first = await reader.walletPortfolio('wallet-a', 1);
    expect(first.data.map(asset => asset.assetId)).toEqual([XOR_ID, VAL]);
    expect(first.data[0].atomic.total).toBe('0');
    expect(first.data[1].amounts.total).toBe('0.000012668921175418');
    expect(entriesPaged).toHaveBeenNthCalledWith(1, { args: ['wallet-a'], pageSize: 2 });
    expect(first.pagination).toMatchObject({ hasNextPage: true, scannedTokenEntries: 1, nativeIncluded: true });
    const second = await reader.walletPortfolio('wallet-a', 1, first.pagination.nextCursor!);
    expect(second.data.map(asset => asset.assetId)).toEqual([PSWAP]);
    expect(second.pagination).toEqual({ hasNextPage: false, nextCursor: null, scannedTokenEntries: 1, nativeIncluded: false });
    expect(second.provenance.blockHash).toBe(first.provenance.blockHash);
    expect(at).toHaveBeenLastCalledWith(BLOCK);
    expect(entriesPaged).toHaveBeenNthCalledWith(2, { args: ['wallet-a'], pageSize: 2, startKey: `${PREFIX}01` });
    await reader.close();
  });
  it('rejects a cursor for another wallet before reading token entries', async () => {
    const { reader, entriesPaged } = fixture();
    const first = await reader.walletPortfolio('wallet-a', 1);
    await expect(reader.walletPortfolio('wallet-b', 1, first.pagination.nextCursor!)).rejects.toThrow('does not match');
    expect(entriesPaged).toHaveBeenCalledTimes(1);
  });
  it('keeps an in-flight wallet read and shared RPC healthy when another request uses the wrong cursor address', async () => {
    const { reader, entriesPaged, disconnect, createApi } = fixture();
    const first = await reader.walletPortfolio('wallet-a', 1);
    const cursor = first.pagination.nextCursor!;
    const rows = await entriesPaged.mock.results[0].value;
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    entriesPaged.mockImplementationOnce(async () => {
      started();
      await waiting;
      if (disconnect.mock.calls.length) throw new Error('The shared RPC disconnected during the healthy read');
      return rows.slice(1);
    });
    const healthy = reader.walletPortfolio('wallet-a', 1, cursor);
    await entered;
    await expect(reader.walletPortfolio('wallet-b', 1, cursor)).rejects.toThrow('does not match');
    const disconnectedBeforeRelease = disconnect.mock.calls.length;
    release();
    const result = await healthy;
    expect(disconnectedBeforeRelease).toBe(0);
    expect(result.data.map(asset => asset.assetId)).toEqual([PSWAP]);
    await reader.walletPortfolio('wallet-a', 1, cursor);
    expect(createApi).toHaveBeenCalledTimes(1);
    expect(disconnect).not.toHaveBeenCalled();
    await reader.close();
  });
  it('does not discard a healthy connection for a malformed wallet address', async () => {
    const { reader, disconnect, createApi } = fixture();
    await reader.walletPortfolio('wallet-a', 1);
    await expect(reader.walletPortfolio('invalid-address', 1)).rejects.toThrow('Invalid public wallet address');
    await reader.walletPortfolio('wallet-a', 1);
    expect(disconnect).not.toHaveBeenCalled();
    expect(createApi).toHaveBeenCalledTimes(1);
    await reader.close();
  });
  it('still releases the connection after an upstream token read fails', async () => {
    const { reader, entriesPaged, disconnect, createApi } = fixture();
    entriesPaged.mockRejectedValueOnce(new Error('Upstream RPC unavailable'));
    await expect(reader.walletPortfolio('wallet-a', 1)).rejects.toThrow('Upstream RPC unavailable');
    expect(disconnect).toHaveBeenCalledTimes(1);
    await reader.walletPortfolio('wallet-a', 1);
    expect(createApi).toHaveBeenCalledTimes(2);
    await reader.close();
  });
  it('rejects altered or expired signed cursors', async () => {
    const { reader, entriesPaged } = fixture();
    const first = await reader.walletPortfolio('wallet-a', 1);
    const cursor = first.pagination.nextCursor!;
    const changed = cursor.slice(0, -1) + (cursor.endsWith('0') ? '1' : '0');
    await expect(reader.walletPortfolio('wallet-a', 1, changed)).rejects.toThrow('expired or invalid');
    await expect(fixture().reader.walletPortfolio('wallet-a', 1, cursor)).rejects.toThrow('expired or invalid');
    expect(entriesPaged).toHaveBeenCalledTimes(1);
    await reader.close();
  });
  it('preserves raw balances when asset registration is absent without inventing precision', async () => {
    const { reader } = fixture({ unknown: true });
    const result = await reader.walletPortfolio('wallet-a', 1);
    expect(result.data.map(asset => asset.assetId)).toEqual([XOR_ID]);
    expect(result.unresolvedAssets).toHaveLength(1);
    expect(result.unresolvedAssets[0]).toMatchObject({ assetId: VAL, atomic: { total: '12668921175418' } });
    expect(result.unresolvedAssets[0]).not.toHaveProperty('amounts');
    expect(result.warnings.join(' ')).toContain('no symbol or decimal amount was invented');
    await reader.close();
  });
  it('returns the verified native zero and complete empty token page for an empty wallet', async () => {
    const { reader } = fixture({ empty: true });
    const result = await reader.walletPortfolio('wallet-a', 25);
    expect(result.data.map(asset => asset.assetId)).toEqual([XOR_ID]);
    expect(result.data[0].amounts.total).toBe('0');
    expect(result.pagination).toEqual({ hasNextPage: false, nextCursor: null, scannedTokenEntries: 0, nativeIncluded: true });
    await reader.close();
  });
  it('refuses token rows outside the wallet prefix instead of exposing another account', async () => {
    const { reader } = fixture({ badPrefix: true });
    await expect(reader.walletPortfolio('wallet-a', 1)).rejects.toThrow('outside the requested wallet prefix');
  });
  it('keeps discovered tokens when native storage is unavailable without returning a native zero', async () => {
    const { reader } = fixture({ nativeUnavailable: true });
    const result = await reader.walletPortfolio('wallet-a', 1);
    expect(result.data.map(asset => asset.assetId)).toEqual([VAL]);
    expect(result.pagination.nativeIncluded).toBe(false);
    expect(result.warnings.join(' ')).toContain('Native XOR balance unavailable; no zero balance was inferred');
    await reader.close();
  });
  it('bounds page size and malformed cursors before making chain calls', async () => {
    const { reader, entriesPaged, at } = fixture();
    await expect(reader.walletPortfolio('wallet-a', 51)).rejects.toThrow('between 1 and 50');
    await expect(reader.walletPortfolio('wallet-a', 1, 'not-a-cursor')).rejects.toThrow('Invalid wallet cursor');
    expect(at).not.toHaveBeenCalled();
    expect(entriesPaged).not.toHaveBeenCalled();
  });
});
