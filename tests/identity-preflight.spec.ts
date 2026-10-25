import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SORA_LEGACY_IDENTITY_ANCHOR, SORA_MAINNET_GENESIS_HASH } from '../src/soraIdentity.js';

const polkadotMocks = vi.hoisted(() => ({
  createProvider: vi.fn(),
  createApi: vi.fn(() => { throw new Error('identity preflight must not download runtime metadata'); }),
}));

vi.mock('@polkadot/api', () => ({
  ApiPromise: { create: polkadotMocks.createApi },
  WsProvider: class MockWsProvider {
    constructor(...args: unknown[]) {
      return polkadotMocks.createProvider(...args);
    }
  },
}));

const { preflightSoraMainnetIdentity } = await import('../src/worker/identityPreflight.js');

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = (byte: string): string => `0x${byte.repeat(64)}`;
const TIMESTAMP_KEY = '0xf0c365c3cf59d671eb72da0e7a4113c49f1f0515f462cdcf84e0f1d6045dfcbb';
const scaleTimestamp = (value: bigint): string => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return `0x${bytes.toString('hex')}`;
};
const TIMESTAMP = scaleTimestamp(BigInt(SORA_LEGACY_IDENTITY_ANCHOR.timestamp) * 1000n);
const pending = <T>(): Promise<T> => new Promise(() => undefined);

const providerWithIdentity = (
  genesis: unknown = SORA_MAINNET_GENESIS_HASH,
  anchor: unknown = SORA_LEGACY_IDENTITY_ANCHOR.hash,
  timestamp: unknown = TIMESTAMP,
) => {
  const listeners = new Map<string, (value?: unknown) => void>();
  return {
    isReady: Promise.resolve() as Promise<void>,
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    on: vi.fn((event: string, listener: (value?: unknown) => void) => {
      listeners.set(event, listener);
      return () => { listeners.delete(event); };
    }),
    emit: (event: string, value?: unknown) => listeners.get(event)?.(value),
    listeners,
    send: vi.fn(async (method: string, params: unknown[], _cache: boolean): Promise<unknown> => {
      let value: unknown;
      if (method === 'chain_getBlockHash' && params[0] === 0) value = genesis;
      else if (method === 'chain_getBlockHash' && params[0] === SORA_LEGACY_IDENTITY_ANCHOR.block) value = anchor;
      else if (method === 'state_getStorage' && params[0] === TIMESTAMP_KEY && params[1] === SORA_LEGACY_IDENTITY_ANCHOR.hash) value = timestamp;
      else throw new Error(`unexpected RPC ${method}`);
      if (value instanceof Error) throw value;
      return value;
    }),
  };
};

const useProvider = (provider = providerWithIdentity()) => {
  polkadotMocks.createProvider.mockReturnValueOnce(provider);
  return provider;
};

const expectClosed = (...providers: ReturnType<typeof providerWithIdentity>[]) => {
  for (const provider of providers) {
    expect(provider.disconnect).toHaveBeenCalledOnce();
    expect(provider.listeners.size).toBe(0);
  }
};

describe('database-free SORA identity preflight', () => {
  afterEach(() => {
    expect(polkadotMocks.createApi).not.toHaveBeenCalled();
    vi.useRealTimers();
    polkadotMocks.createProvider.mockReset();
  });

  it('proves both pinned hashes without runtime metadata, retries, or timestamp reads', async () => {
    const provider = useProvider();
    await expect(preflightSoraMainnetIdentity('wss://mof2.sora.org')).resolves.toBeUndefined();
    expect(polkadotMocks.createProvider).toHaveBeenCalledExactlyOnceWith('wss://mof2.sora.org', false, {}, 15_000);
    expect(provider.connect).toHaveBeenCalledOnce();
    expect(provider.send.mock.calls).toEqual([
      ['chain_getBlockHash', [0], false],
      ['chain_getBlockHash', [SORA_LEGACY_IDENTITY_ANCHOR.block], false],
    ]);
    expectClosed(provider);
  });

  it('reads exactly Timestamp.Now at the pinned hash and decodes unsigned little-endian milliseconds', async () => {
    const provider = useProvider();
    await expect(preflightSoraMainnetIdentity('ws://127.0.0.1:9944', { requireAnchorTimestamp: true })).resolves.toBeUndefined();
    expect(provider.send.mock.calls).toEqual([
      ['chain_getBlockHash', [0], false],
      ['chain_getBlockHash', [SORA_LEGACY_IDENTITY_ANCHOR.block], false],
      ['state_getStorage', [TIMESTAMP_KEY, SORA_LEGACY_IDENTITY_ANCHOR.hash], false],
    ]);
    expectClosed(provider);
  });

  it('accepts uppercase hexadecimal payloads without coercing non-string RPC values', async () => {
    const provider = useProvider(providerWithIdentity(SORA_MAINNET_GENESIS_HASH.toUpperCase(),
      SORA_LEGACY_IDENTITY_ANCHOR.hash.toUpperCase(), `0x${TIMESTAMP.slice(2).toUpperCase()}`));
    await expect(preflightSoraMainnetIdentity('wss://mainnet.invalid', { requireAnchorTimestamp: true })).resolves.toBeUndefined();
    expectClosed(provider);
  });

  it.each([
    ['missing null', null], ['missing undefined', undefined], ['empty bytes', '0x'],
    ['short SCALE', TIMESTAMP.slice(0, -2)], ['trailing SCALE', `${TIMESTAMP}00`],
    ['nonhex', `0x${'g'.repeat(16)}`], ['missing prefix', TIMESTAMP.slice(2)],
    ['decimal text', String(SORA_LEGACY_IDENTITY_ANCHOR.timestamp * 1000)],
    ['number', SORA_LEGACY_IDENTITY_ANCHOR.timestamp * 1000], ['object coercion', { toString: (): string => TIMESTAMP }],
    ['wrong timestamp', scaleTimestamp(BigInt(SORA_LEGACY_IDENTITY_ANCHOR.timestamp) * 1000n + 1n)],
    ['seconds instead of milliseconds', scaleTimestamp(BigInt(SORA_LEGACY_IDENTITY_ANCHOR.timestamp))],
    ['zero', scaleTimestamp(0n)], ['maximum u64', scaleTimestamp(0xffff_ffff_ffff_ffffn)],
    ['wrong byte order', `0x${Buffer.from(TIMESTAMP.slice(2), 'hex').reverse().toString('hex')}`],
    ['whitespace', ` ${TIMESTAMP}`],
  ])('rejects %s timestamp storage without archive fallback', async (_label, timestamp) => {
    const provider = useProvider();
    provider.send.mockImplementation(async (method, params) => method === 'state_getStorage'
      ? timestamp : params[0] === 0 ? SORA_MAINNET_GENESIS_HASH : SORA_LEGACY_IDENTITY_ANCHOR.hash);
    await expect(preflightSoraMainnetIdentity('ws://127.0.0.1:9944', {
      requireAnchorTimestamp: true, historicalEndpoint: 'wss://mof2.sora.org',
    })).rejects.toThrow('does not contain the reviewed SORA mainnet history anchor timestamp');
    expect(polkadotMocks.createProvider).toHaveBeenCalledOnce();
    expectClosed(provider);
  });

  it('uses a separately verified archive only after primary hashes and explicit discarded timestamp state', async () => {
    const primary = useProvider(providerWithIdentity(SORA_MAINNET_GENESIS_HASH, SORA_LEGACY_IDENTITY_ANCHOR.hash,
      new Error('4003: State already discarded')));
    const archive = useProvider();
    await expect(preflightSoraMainnetIdentity('ws://127.0.0.1:9944', {
      requireAnchorTimestamp: true, historicalEndpoint: 'wss://mof2.sora.org',
    })).resolves.toBeUndefined();
    expect(polkadotMocks.createProvider.mock.calls.map(([endpoint]) => endpoint))
      .toEqual(['ws://127.0.0.1:9944', 'wss://mof2.sora.org']);
    expect(primary.send.mock.calls).toEqual(archive.send.mock.calls);
    expect(primary.send).toHaveBeenCalledTimes(3);
    expectClosed(primary, archive);
  });

  it.each(['wrong genesis', 'wrong anchor', 'wrong timestamp', 'pruned archive'])(
    'rejects historical fallback with %s', async (failure) => {
      const primary = useProvider(providerWithIdentity(SORA_MAINNET_GENESIS_HASH, SORA_LEGACY_IDENTITY_ANCHOR.hash,
        new Error('State already discarded')));
      const archive = useProvider(providerWithIdentity(
        failure === 'wrong genesis' ? hash('1') : SORA_MAINNET_GENESIS_HASH,
        failure === 'wrong anchor' ? hash('2') : SORA_LEGACY_IDENTITY_ANCHOR.hash,
        failure === 'wrong timestamp' ? scaleTimestamp(123n) : failure === 'pruned archive' ? new Error('State already discarded') : TIMESTAMP,
      ));
      await expect(preflightSoraMainnetIdentity('ws://127.0.0.1:9944', {
        requireAnchorTimestamp: true, historicalEndpoint: 'wss://mof2.sora.org',
      })).rejects.toThrow();
      expect(polkadotMocks.createProvider).toHaveBeenCalledTimes(2);
      expectClosed(primary, archive);
    },
  );

  it.each(['transport unavailable', 'unknown Block'])(
    'does not hide a primary %s error with archive fallback', async (failure) => {
      const provider = useProvider(providerWithIdentity(SORA_MAINNET_GENESIS_HASH, SORA_LEGACY_IDENTITY_ANCHOR.hash, new Error(failure)));
      await expect(preflightSoraMainnetIdentity('ws://127.0.0.1:9944', {
        requireAnchorTimestamp: true, historicalEndpoint: 'wss://mof2.sora.org',
      })).rejects.toThrow(failure);
      expect(polkadotMocks.createProvider).toHaveBeenCalledOnce();
      expectClosed(provider);
    },
  );

  it.each([undefined, 'ws://127.0.0.1:9944'])('does not recurse into an absent or identical fallback %s', async (historicalEndpoint) => {
    const provider = useProvider(providerWithIdentity(SORA_MAINNET_GENESIS_HASH, SORA_LEGACY_IDENTITY_ANCHOR.hash,
      new Error('State already discarded')));
    await expect(preflightSoraMainnetIdentity('ws://127.0.0.1:9944', {
      requireAnchorTimestamp: true, historicalEndpoint,
    })).rejects.toThrow('State already discarded');
    expect(polkadotMocks.createProvider).toHaveBeenCalledOnce();
    expectClosed(provider);
  });

  it.each([
    ['wrong/testnet canonical hash', hash('1'), /does not match/],
    ['zero hash', hash('0'), /missing, zero, or malformed/],
    ['short malformed hash', '0x1234', /missing, zero, or malformed/],
    ['convincing text label', 'SORA mainnet', /missing, zero, or malformed/],
    ['missing null hash', null, /missing, zero, or malformed/],
    ['missing undefined hash', undefined, /missing, zero, or malformed/],
    ['coercible object', { toString: (): string => SORA_MAINNET_GENESIS_HASH }, /missing, zero, or malformed/],
    ['rejected query', new Error('genesis unavailable'), /genesis unavailable/],
  ])('rejects %s before anchor or fallback queries', async (_label, genesis, expected) => {
    const provider = useProvider();
    provider.send.mockImplementation(async () => { if (genesis instanceof Error) throw genesis; return genesis; });
    await expect(preflightSoraMainnetIdentity('wss://mainnet-label.invalid', {
      requireAnchorTimestamp: true, historicalEndpoint: 'wss://archive.invalid',
    })).rejects.toThrow(expected as RegExp);
    expect(provider.send).toHaveBeenCalledOnce();
    expect(polkadotMocks.createProvider).toHaveBeenCalledOnce();
    expectClosed(provider);
  });

  it.each([
    ['wrong canonical anchor', hash('2')], ['zero anchor', hash('0')],
    ['malformed anchor', '0x1234'], ['missing null anchor', null], ['missing undefined anchor', undefined],
    ['coercible object', { toString: (): string => SORA_LEGACY_IDENTITY_ANCHOR.hash }],
    ['rejected query', new Error('anchor unavailable')],
  ])('rejects %s before timestamp or fallback queries', async (_label, anchor) => {
    const provider = useProvider();
    provider.send.mockImplementation(async (_method, params) => {
      if (params[0] === 0) return SORA_MAINNET_GENESIS_HASH;
      if (anchor instanceof Error) throw anchor;
      return anchor;
    });
    await expect(preflightSoraMainnetIdentity('wss://mainnet-label.invalid', {
      requireAnchorTimestamp: true, historicalEndpoint: 'wss://archive.invalid',
    })).rejects.toThrow(/does not contain the reviewed SORA mainnet history anchor|anchor unavailable/);
    expect(provider.send).toHaveBeenCalledTimes(2);
    expect(polkadotMocks.createProvider).toHaveBeenCalledOnce();
    expectClosed(provider);
  });

  it.each(['genesis', 'anchor', 'timestamp', 'archive timestamp'])(
    'bounds a hanging %s query, does not replace it, and disconnects every provider', async (phase) => {
      vi.useFakeTimers();
      const primary = useProvider(phase === 'archive timestamp'
        ? providerWithIdentity(SORA_MAINNET_GENESIS_HASH, SORA_LEGACY_IDENTITY_ANCHOR.hash, new Error('State already discarded'))
        : providerWithIdentity());
      const queried = phase === 'archive timestamp' ? useProvider() : primary;
      const original = queried.send.getMockImplementation()!;
      queried.send.mockImplementation((method, params, cache) =>
        (phase === 'genesis' && params[0] === 0) || (phase === 'anchor' && params[0] === SORA_LEGACY_IDENTITY_ANCHOR.block) ||
        (phase.endsWith('timestamp') && method === 'state_getStorage') ? pending() : original(method, params, cache));
      const result = preflightSoraMainnetIdentity('ws://127.0.0.1:9944', {
        requireAnchorTimestamp: true, historicalEndpoint: 'wss://archive.invalid',
      });
      const rejection = expect(result).rejects.toThrow('timed out after 15000ms');
      await vi.advanceTimersByTimeAsync(15_000);
      await rejection;
      expectClosed(...(queried === primary ? [primary] : [primary, queried]));
      expect(polkadotMocks.createProvider).toHaveBeenCalledTimes(queried === primary ? 1 : 2);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('rejects a failed connect and cleans up without any RPC', async () => {
    const provider = useProvider();
    provider.connect.mockRejectedValue(new Error('websocket handshake failed'));
    await expect(preflightSoraMainnetIdentity('wss://mainnet.invalid')).rejects.toThrow('websocket handshake failed');
    expect(provider.send).not.toHaveBeenCalled();
    expectClosed(provider);
  });

  it.each(['error', 'disconnected'])('rejects socket %s during a pending handshake without waiting for its deadline', async (event) => {
    const provider = useProvider();
    provider.isReady = pending();
    const result = preflightSoraMainnetIdentity('wss://mainnet.invalid');
    const rejection = expect(result).rejects.toThrow(/handshake failure|websocket disconnected/);
    provider.emit(event, new Error('handshake failure'));
    await rejection;
    expect(provider.send).not.toHaveBeenCalled();
    expectClosed(provider);
  });

  it('bounds a hanging handshake and disconnects its late completion without running RPC', async () => {
    vi.useFakeTimers();
    const provider = useProvider();
    let ready!: () => void;
    provider.isReady = new Promise<void>((resolveReady) => { ready = resolveReady; });
    const result = preflightSoraMainnetIdentity('wss://mainnet.invalid');
    const rejection = expect(result).rejects.toThrow('SORA identity preflight connection timed out after 15000ms');
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
    expectClosed(provider);
    ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.disconnect).toHaveBeenCalledTimes(2);
    expect(provider.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a never-resolving disconnect without leaking timers', async () => {
    vi.useFakeTimers();
    const provider = useProvider();
    provider.disconnect.mockImplementation(() => pending());
    const completion = expect(preflightSoraMainnetIdentity('wss://mainnet.invalid')).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(2_000);
    await completion;
    expectClosed(provider);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps both endpoint proofs before repository construction and migration in the worker entrypoint', async () => {
    const source = await readFile(resolve(repoRoot, 'src/worker/index.ts'), 'utf8');
    const archiveConfig = source.indexOf("readSoraArchiveWsEndpoint(process.env.NODE_ENV === 'production')");
    const preflight = source.indexOf('await Promise.all([');
    const primary = source.indexOf('requireAnchorTimestamp: true, historicalEndpoint: archiveSoraWsEndpoint || undefined,');
    const archive = source.indexOf('preflightSoraMainnetIdentity(archiveSoraWsEndpoint)');
    const migration = source.indexOf('await migrate(config)');
    const repository = source.indexOf('createRepository(config');

    expect(archiveConfig).toBeGreaterThan(-1);
    expect(preflight).toBeGreaterThan(-1);
    expect(preflight).toBeGreaterThan(archiveConfig);
    expect(primary).toBeGreaterThan(preflight);
    expect(archive).toBeGreaterThan(primary);
    expect(migration).toBeGreaterThan(archive);
    expect(repository).toBeGreaterThan(migration);
  });

  it('keeps both endpoint proofs before repository construction and migration in the combined entrypoint', async () => {
    const source = await readFile(resolve(repoRoot, 'src/combined.ts'), 'utf8');
    const archiveConfig = source.indexOf("readSoraArchiveWsEndpoint(process.env.NODE_ENV === 'production')");
    const preflight = source.indexOf('await Promise.all([');
    const primary = source.indexOf(
      'requireAnchorTimestamp: true, historicalEndpoint: archiveSoraWsEndpoint || undefined,'
    );
    const archive = source.indexOf('preflightSoraMainnetIdentity(archiveSoraWsEndpoint)');
    const migration = source.indexOf('await migrate(config)');
    const repository = source.indexOf('createRepository(config');

    expect(archiveConfig).toBeGreaterThan(-1);
    expect(preflight).toBeGreaterThan(archiveConfig);
    expect(primary).toBeGreaterThan(preflight);
    expect(archive).toBeGreaterThan(primary);
    expect(migration).toBeGreaterThan(archive);
    expect(repository).toBeGreaterThan(migration);
  });
});
