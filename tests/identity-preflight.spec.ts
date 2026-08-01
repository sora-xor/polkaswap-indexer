import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SORA_LEGACY_IDENTITY_ANCHOR, SORA_MAINNET_GENESIS_HASH } from '../src/soraIdentity.js';

const polkadotMocks = vi.hoisted(() => ({
  create: vi.fn(),
  providers: [] as Array<{ endpoint: string; disconnect: ReturnType<typeof vi.fn> }>,
}));

vi.mock('@polkadot/api', () => ({
  ApiPromise: { create: polkadotMocks.create },
  WsProvider: class MockWsProvider {
    readonly disconnect = vi.fn(async () => undefined);

    constructor(readonly endpoint: string) {
      polkadotMocks.providers.push(this);
    }
  },
}));

const { preflightSoraMainnetIdentity } = await import('../src/worker/identityPreflight.js');

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const codec = (value: unknown) => ({ toString: () => String(value) });
const hash = (byte: string): string => `0x${byte.repeat(64)}`;
const MISSING_ANCHOR = Symbol('missing-anchor');

const apiWithIdentity = (
  genesis: unknown | Error,
  anchor: unknown | Error | typeof MISSING_ANCHOR = SORA_LEGACY_IDENTITY_ANCHOR.hash,
) => ({
  disconnect: vi.fn(async () => undefined),
  rpc: {
    chain: {
      getBlockHash: vi.fn(async (block: number) => {
        const value = block === 0
          ? genesis
          : block === SORA_LEGACY_IDENTITY_ANCHOR.block
            ? anchor === MISSING_ANCHOR ? undefined : anchor
            : new Error(`unexpected block ${block}`);
        if (value instanceof Error) throw value;
        return value === null || value === undefined ? value : codec(value);
      }),
    },
  },
  query: {
    timestamp: {
      now: {
        at: vi.fn(async () => codec(SORA_LEGACY_IDENTITY_ANCHOR.timestamp * 1_000)),
      },
    },
  },
});

describe('database-free SORA identity preflight', () => {
  afterEach(() => {
    vi.useRealTimers();
    polkadotMocks.create.mockReset();
    polkadotMocks.providers.length = 0;
  });

  it('accepts only the reviewed canonical genesis and disconnects both API and provider', async () => {
    const api = apiWithIdentity(SORA_MAINNET_GENESIS_HASH);
    polkadotMocks.create.mockResolvedValue(api);

    await expect(preflightSoraMainnetIdentity('wss://mof2.sora.org')).resolves.toBeUndefined();

    expect(polkadotMocks.create).toHaveBeenCalledOnce();
    expect(api.rpc.chain.getBlockHash).toHaveBeenCalledWith(0);
    expect(api.rpc.chain.getBlockHash).toHaveBeenCalledWith(SORA_LEGACY_IDENTITY_ANCHOR.block);
    expect(api.disconnect).toHaveBeenCalledOnce();
    expect(polkadotMocks.providers).toHaveLength(1);
    expect(polkadotMocks.providers[0].endpoint).toBe('wss://mof2.sora.org');
    expect(polkadotMocks.providers[0].disconnect).toHaveBeenCalledOnce();
  });

  it('requires the exact audited anchor timestamp for the primary preflight', async () => {
    const api = apiWithIdentity(SORA_MAINNET_GENESIS_HASH);
    polkadotMocks.create.mockResolvedValue(api);

    await expect(preflightSoraMainnetIdentity('wss://mof2.sora.org', {
      requireAnchorTimestamp: true,
    })).resolves.toBeUndefined();

    expect(api.query.timestamp.now.at).toHaveBeenCalledWith(SORA_LEGACY_IDENTITY_ANCHOR.hash);
  });

  it.each([
    ['missing timestamp API', null],
    ['wrong anchor timestamp', SORA_LEGACY_IDENTITY_ANCHOR.timestamp * 1_000 + 1],
    ['zero anchor timestamp', 0],
    ['fractional anchor timestamp', `${SORA_LEGACY_IDENTITY_ANCHOR.timestamp * 1_000}.5`],
    ['unsafe anchor timestamp', '9007199254740992'],
  ])('rejects a primary preflight with %s', async (_label, timestamp) => {
    const api = apiWithIdentity(SORA_MAINNET_GENESIS_HASH) as any;
    if (timestamp === null) {
      api.query = undefined;
    } else {
      api.query.timestamp.now.at.mockResolvedValue(codec(timestamp));
    }
    polkadotMocks.create.mockResolvedValue(api);

    await expect(preflightSoraMainnetIdentity('wss://mof2.sora.org', {
      requireAnchorTimestamp: true,
    })).rejects.toThrow(/cannot verify|does not contain the reviewed SORA mainnet history anchor timestamp/);
  });

  it('allows a hash-only archive preflight when historical timestamp state is pruned', async () => {
    const api = apiWithIdentity(SORA_MAINNET_GENESIS_HASH);
    api.query.timestamp.now.at.mockRejectedValue(new Error('State already discarded'));
    polkadotMocks.create.mockResolvedValue(api);

    await expect(preflightSoraMainnetIdentity('wss://archive.sora.org')).resolves.toBeUndefined();
    expect(api.query.timestamp.now.at).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong/testnet canonical hash', hash('1'), /does not match the reviewed SORA mainnet genesis hash/],
    ['zero hash', hash('0'), /missing, zero, or malformed genesis hash/],
    ['short malformed hash', '0x1234', /missing, zero, or malformed genesis hash/],
    ['convincing text label', 'SORA mainnet', /missing, zero, or malformed genesis hash/],
    ['missing null hash', null, /missing, zero, or malformed genesis hash/],
    ['missing undefined hash', undefined, /missing, zero, or malformed genesis hash/],
    ['rejected genesis query', new Error('genesis unavailable'), /genesis unavailable/],
  ])('rejects %s and always disconnects', async (_label, genesis, expected) => {
    const api = apiWithIdentity(genesis);
    polkadotMocks.create.mockResolvedValue(api);

    await expect(preflightSoraMainnetIdentity('wss://mainnet-label.invalid')).rejects.toThrow(expected as RegExp);

    expect(api.disconnect).toHaveBeenCalledOnce();
    expect(polkadotMocks.providers[0].disconnect).toHaveBeenCalledOnce();
  });

  it.each([
    ['wrong canonical anchor', hash('2'), /does not contain the reviewed SORA mainnet history anchor/],
    ['zero anchor', hash('0'), /does not contain the reviewed SORA mainnet history anchor/],
    ['malformed anchor', '0x1234', /does not contain the reviewed SORA mainnet history anchor/],
    ['missing null anchor', null, /does not contain the reviewed SORA mainnet history anchor/],
    ['missing undefined anchor', MISSING_ANCHOR, /does not contain the reviewed SORA mainnet history anchor/],
    ['rejected anchor query', new Error('anchor unavailable'), /anchor unavailable/],
  ])('rejects %s and always disconnects', async (_label, anchor, expected) => {
    const api = apiWithIdentity(SORA_MAINNET_GENESIS_HASH, anchor);
    polkadotMocks.create.mockResolvedValue(api);

    await expect(preflightSoraMainnetIdentity('wss://mainnet-label.invalid')).rejects.toThrow(expected as RegExp);

    expect(api.disconnect).toHaveBeenCalledOnce();
    expect(polkadotMocks.providers[0].disconnect).toHaveBeenCalledOnce();
  });

  it('disconnects the provider when API construction rejects', async () => {
    polkadotMocks.create.mockRejectedValue(new Error('websocket handshake failed'));

    await expect(preflightSoraMainnetIdentity('wss://mof2.sora.org')).rejects.toThrow('websocket handshake failed');

    expect(polkadotMocks.providers[0].disconnect).toHaveBeenCalledOnce();
  });

  it('bounds a hanging genesis query and cleans up the API and provider', async () => {
    vi.useFakeTimers();
    const api = apiWithIdentity(SORA_MAINNET_GENESIS_HASH);
    api.rpc.chain.getBlockHash.mockImplementation(async () => new Promise(() => undefined));
    polkadotMocks.create.mockResolvedValue(api);

    const preflight = preflightSoraMainnetIdentity('wss://mof2.sora.org');
    const rejection = expect(preflight).rejects.toThrow(
      'SORA identity preflight chain.getBlockHash(0) timed out after 15000ms',
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;

    expect(api.disconnect).toHaveBeenCalledOnce();
    expect(polkadotMocks.providers[0].disconnect).toHaveBeenCalledOnce();
  });

  it('bounds a hanging history-anchor query and cleans up the API and provider', async () => {
    vi.useFakeTimers();
    const api = apiWithIdentity(SORA_MAINNET_GENESIS_HASH);
    api.rpc.chain.getBlockHash.mockImplementation(async (block: number) => {
      if (block === 0) return codec(SORA_MAINNET_GENESIS_HASH);
      return new Promise(() => undefined);
    });
    polkadotMocks.create.mockResolvedValue(api);

    const preflight = preflightSoraMainnetIdentity('wss://mof2.sora.org');
    const rejection = expect(preflight).rejects.toThrow(
      `SORA identity preflight chain.getBlockHash(${SORA_LEGACY_IDENTITY_ANCHOR.block}) timed out after 15000ms`,
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;

    expect(api.disconnect).toHaveBeenCalledOnce();
    expect(polkadotMocks.providers[0].disconnect).toHaveBeenCalledOnce();
  });

  it('bounds a hanging API connection and disconnects a late API completion', async () => {
    vi.useFakeTimers();
    let resolveApi!: (api: ReturnType<typeof apiWithIdentity>) => void;
    const creation = new Promise<ReturnType<typeof apiWithIdentity>>((resolveCreation) => {
      resolveApi = resolveCreation;
    });
    polkadotMocks.create.mockReturnValue(creation);

    const preflight = preflightSoraMainnetIdentity('wss://mof2.sora.org');
    const rejection = expect(preflight).rejects.toThrow('SORA identity preflight connection timed out after 15000ms');
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
    expect(polkadotMocks.providers[0].disconnect).toHaveBeenCalledOnce();

    const lateApi = apiWithIdentity(SORA_MAINNET_GENESIS_HASH);
    resolveApi(lateApi);
    await vi.waitFor(() => expect(lateApi.disconnect).toHaveBeenCalledOnce());
    expect(lateApi.rpc.chain.getBlockHash).not.toHaveBeenCalled();
  });

  it('bounds never-resolving API and provider disconnects without leaking timers', async () => {
    vi.useFakeTimers();
    const api = apiWithIdentity(SORA_MAINNET_GENESIS_HASH);
    api.disconnect.mockImplementation(async () => new Promise<undefined>(() => undefined));
    polkadotMocks.create.mockResolvedValue(api);

    const preflight = preflightSoraMainnetIdentity('wss://mof2.sora.org');
    polkadotMocks.providers[0].disconnect.mockImplementation(async () => new Promise<undefined>(() => undefined));
    const completion = expect(preflight).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(2_000);
    await completion;

    expect(api.disconnect).toHaveBeenCalledOnce();
    expect(polkadotMocks.providers[0].disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps both endpoint proofs before repository construction and migration in the worker entrypoint', async () => {
    const source = await readFile(resolve(repoRoot, 'src/worker/index.ts'), 'utf8');
    const topology = source.indexOf('assertIndependentSoraRpcEndpoints(baseConfig.soraWsEndpoint, archiveSoraWsEndpoint)');
    const preflight = source.indexOf('await Promise.all([');
    const primary = source.indexOf('preflightSoraMainnetIdentity(config.soraWsEndpoint, { requireAnchorTimestamp: true })');
    const archive = source.indexOf('preflightSoraMainnetIdentity(archiveSoraWsEndpoint)');
    const migration = source.indexOf('await migrate(config)');
    const repository = source.indexOf('createRepository(config, {');

    expect(topology).toBeGreaterThan(-1);
    expect(preflight).toBeGreaterThan(-1);
    expect(preflight).toBeGreaterThan(topology);
    expect(primary).toBeGreaterThan(preflight);
    expect(archive).toBeGreaterThan(primary);
    expect(migration).toBeGreaterThan(archive);
    expect(repository).toBeGreaterThan(migration);
  });
});
