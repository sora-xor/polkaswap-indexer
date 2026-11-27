import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

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

const originalArchiveEndpoint = process.env.SORA_ARCHIVE_WS_ENDPOINT;
process.env.SORA_ARCHIVE_WS_ENDPOINT = 'wss://archive.sora.invalid';

const [
  { ChainIndexer },
  { MemoryRepository },
  { SORA_LEGACY_IDENTITY_ANCHOR, SORA_MAINNET_GENESIS_HASH },
] = await Promise.all([
  import('../src/worker/chain.js'),
  import('../src/repository/memory.js'),
  import('../src/soraIdentity.js'),
]);

const config = {
  host: '0.0.0.0',
  port: 4350,
  graphqlPath: '/graphql',
  databaseUrl: '',
  soraWsEndpoint: 'wss://primary.sora.invalid',
  chainStartBlock: 0,
  chainBatchSize: 25,
  stateRefreshIntervalBlocks: 250,
  snapshotIntervalBlocks: 250,
};

type TimeoutIndexer = {
  api: unknown;
  primaryProvider: unknown;
  legacyBlockApi: unknown;
  unsubscribeFinalizedHeads: (() => void) | null;
  finalizedHeadRetryTimer: ReturnType<typeof setTimeout> | null;
  finalizedHeadPollTimer: ReturnType<typeof setInterval> | null;
  derivedStateRefreshRetryTimer: ReturnType<typeof setTimeout> | null;
  priceStreamRefreshRetryTimer: ReturnType<typeof setTimeout> | null;
  polkamarktStateRefreshRetryTimer: ReturnType<typeof setTimeout> | null;
  xorBurnBackfillRetryTimer: ReturnType<typeof setTimeout> | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  refreshIndexingState: () => Promise<void>;
  backfill: () => Promise<boolean>;
  subscribeFinalizedHeads: () => Promise<void>;
  runStartupMaintenance: () => Promise<void>;
  getBlockDataApi: () => Promise<unknown>;
};

const codec = (value: unknown) => ({ toString: () => String(value) });

describe('PI chain API connection deadlines', () => {
  afterEach(() => {
    vi.useRealTimers();
    polkadotMocks.create.mockReset();
    polkadotMocks.providers.length = 0;
  });

  afterAll(() => {
    if (originalArchiveEndpoint === undefined) delete process.env.SORA_ARCHIVE_WS_ENDPOINT;
    else process.env.SORA_ARCHIVE_WS_ENDPOINT = originalArchiveEndpoint;
  });

  it('bounds the primary API connection and disconnects a completion that arrives after timeout', async () => {
    vi.useFakeTimers();
    let resolveApi!: (api: { disconnect: ReturnType<typeof vi.fn> }) => void;
    const connection = new Promise<{ disconnect: ReturnType<typeof vi.fn> }>((resolveConnection) => {
      resolveApi = resolveConnection;
    });
    polkadotMocks.create.mockReturnValue(connection);
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as TimeoutIndexer;
    indexer.refreshIndexingState = vi.fn(async () => undefined);
    indexer.backfill = vi.fn(async () => false);
    indexer.subscribeFinalizedHeads = vi.fn(async () => undefined);
    indexer.runStartupMaintenance = vi.fn(async () => undefined);

    const startup = indexer.start();
    const rejection = expect(startup).rejects.toThrow('primary SORA endpoint connection timed out after 15000ms');
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
    expect(polkadotMocks.providers[0].disconnect).toHaveBeenCalledOnce();

    const lateApi = { disconnect: vi.fn(async () => undefined) };
    resolveApi(lateApi);
    await vi.advanceTimersByTimeAsync(0);
    expect(lateApi.disconnect).toHaveBeenCalledOnce();
    await expect(repository.list('updatesStreams')).resolves.toEqual([]);
  });

  it('bounds the archive API connection and disconnects a completion that arrives after timeout', async () => {
    vi.useFakeTimers();
    type ArchiveApi = {
      disconnect: ReturnType<typeof vi.fn>;
      rpc: { chain: { getBlockHash: ReturnType<typeof vi.fn> } };
    };
    let resolveArchive!: (api: ArchiveApi) => void;
    const connection = new Promise<ArchiveApi>((resolveConnection) => {
      resolveArchive = resolveConnection;
    });
    polkadotMocks.create.mockReturnValue(connection);
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as TimeoutIndexer;
    indexer.api = {};

    const request = indexer.getBlockDataApi();
    const rejection = expect(request).rejects.toThrow('SORA block data endpoint connection timed out after 15000ms');
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
    expect(polkadotMocks.providers[0].disconnect).toHaveBeenCalledOnce();

    const lateArchive = {
      disconnect: vi.fn(async () => undefined),
      rpc: {
        chain: {
          getBlockHash: vi.fn(async (block: number) => codec(
            block === 0 ? SORA_MAINNET_GENESIS_HASH : SORA_LEGACY_IDENTITY_ANCHOR.hash,
          )),
        },
      },
    };
    resolveArchive(lateArchive);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(lateArchive.disconnect).toHaveBeenCalledOnce();
  });

  it('bounds all never-resolving chain disconnects and leaves no deadline timers behind', async () => {
    vi.useFakeTimers();
    const disconnect = () => vi.fn(async () => new Promise<void>(() => undefined));
    const primary = { disconnect: disconnect() };
    const archive = { disconnect: disconnect() };
    const provider = { disconnect: disconnect() };
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as TimeoutIndexer;
    indexer.api = primary;
    indexer.legacyBlockApi = archive;
    indexer.primaryProvider = provider;

    const stopping = indexer.stop();
    const completion = expect(stopping).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(5_000);
    await completion;

    expect(primary.disconnect).toHaveBeenCalledOnce();
    expect(archive.disconnect).toHaveBeenCalledOnce();
    expect(provider.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('continues disconnecting and clears lifecycle timers when unsubscribe throws', async () => {
    vi.useFakeTimers();
    const primary = { disconnect: vi.fn(async () => undefined) };
    const provider = { disconnect: vi.fn(async () => undefined) };
    const unsubscribe = vi.fn(() => {
      throw new Error('unsubscribe failed');
    });
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as TimeoutIndexer;
    indexer.api = primary;
    indexer.primaryProvider = provider;
    indexer.unsubscribeFinalizedHeads = unsubscribe;
    indexer.finalizedHeadRetryTimer = setTimeout(() => undefined, 60_000);
    indexer.finalizedHeadPollTimer = setInterval(() => undefined, 60_000);
    indexer.derivedStateRefreshRetryTimer = setTimeout(() => undefined, 60_000);
    indexer.priceStreamRefreshRetryTimer = setTimeout(() => undefined, 60_000);
    indexer.polkamarktStateRefreshRetryTimer = setTimeout(() => undefined, 60_000);
    indexer.xorBurnBackfillRetryTimer = setTimeout(() => undefined, 60_000);

    await expect(indexer.stop()).resolves.toBeUndefined();

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(primary.disconnect).toHaveBeenCalledOnce();
    expect(provider.disconnect).toHaveBeenCalledOnce();
    expect(indexer.unsubscribeFinalizedHeads).toBeNull();
    expect(indexer.finalizedHeadRetryTimer).toBeNull();
    expect(indexer.finalizedHeadPollTimer).toBeNull();
    expect(indexer.derivedStateRefreshRetryTimer).toBeNull();
    expect(indexer.priceStreamRefreshRetryTimer).toBeNull();
    expect(indexer.polkamarktStateRefreshRetryTimer).toBeNull();
    expect(indexer.xorBurnBackfillRetryTimer).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
