import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiPromise } from '@polkadot/api';
import { ChainIndexer } from '../src/worker/chain.js';
import { MemoryRepository } from '../src/repository/memory.js';
import {
  SORA_LEGACY_IDENTITY_ANCHOR,
  SORA_MAINNET_GENESIS_HASH,
} from '../src/soraIdentity.js';

import type { IndexerDocument } from '../src/repository/types.js';

const config = {
  host: '0.0.0.0',
  port: 4350,
  graphqlPath: '/graphql',
  databaseUrl: '',
  soraWsEndpoint: 'wss://this-hostname-claims-mainnet.invalid',
  chainStartBlock: 0,
  chainBatchSize: 25,
  stateRefreshIntervalBlocks: 250,
  snapshotIntervalBlocks: 250,
};

const hash = (byte: string): string => `0x${byte.repeat(64)}`;
const FINALIZED_HASH = hash('a');
const CHECKPOINT_HASH = hash('b');
const FINALIZED_BLOCK = 30_000_000;
const FINALIZED_TIMESTAMP = 2_000_000_000;
const STATE_BLOCK = SORA_LEGACY_IDENTITY_ANCHOR.block + 100;
const STATE_HASH = hash('c');
const STATE_TIMESTAMP = SORA_LEGACY_IDENTITY_ANCHOR.timestamp + 600;

type TestIndexer = {
  api: unknown;
  legacyBlockApi: unknown;
  observedGenesisHash: string | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  refreshIndexingState: () => Promise<void>;
  backfill: () => Promise<boolean>;
  subscribeFinalizedHeads: () => Promise<void>;
  runStartupMaintenance: () => Promise<void>;
  requireMainnetIdentity: (api: unknown, label: string) => Promise<string>;
  ensureChainIdentity: (finalizedBlock: number) => Promise<void>;
  createChainStateDocument: (block: number, blockHash: string, timestamp: number) => IndexerDocument;
  getBlockDataApi: () => Promise<unknown>;
  fetchBlockByNumber: (block: number) => Promise<unknown>;
  fetchBlockTimestamp: (blockHash: string, api?: unknown) => Promise<number>;
  indexFetchedBlock: (fetched: unknown) => Promise<void>;
};

const testIndexer = (repository = new MemoryRepository()): TestIndexer =>
  new ChainIndexer(config, repository) as unknown as TestIndexer;

const codec = (value: unknown) => ({ toString: () => String(value) });

const startApi = (genesis: unknown, order: string[] = []) => ({
  disconnect: vi.fn(async () => undefined),
  rpc: {
    chain: {
      getBlockHash: vi.fn(async (block: number) => {
        if (block === 0) {
          order.push('genesis-preflight');
          if (genesis instanceof Error) throw genesis;
          return genesis === null || genesis === undefined ? genesis : codec(genesis);
        }
        if (block === SORA_LEGACY_IDENTITY_ANCHOR.block) return codec(SORA_LEGACY_IDENTITY_ANCHOR.hash);
        throw new Error(`unexpected block ${block}`);
      }),
      getFinalizedHead: vi.fn(async () => codec(FINALIZED_HASH)),
      getHeader: vi.fn(async () => ({
        number: { toNumber: () => FINALIZED_BLOCK },
        hash: codec(FINALIZED_HASH),
      })),
    },
  },
  query: {
    timestamp: {
      now: {
        at: vi.fn(async (blockHash: string) => codec(
          (blockHash === SORA_LEGACY_IDENTITY_ANCHOR.hash
            ? SORA_LEGACY_IDENTITY_ANCHOR.timestamp
            : FINALIZED_TIMESTAMP) * 1_000,
        )),
      },
    },
  },
});

const stubPostPreflightWork = (indexer: TestIndexer): void => {
  indexer.refreshIndexingState = vi.fn(async () => undefined);
  indexer.backfill = vi.fn(async () => false);
  indexer.subscribeFinalizedHeads = vi.fn(async () => undefined);
  indexer.runStartupMaintenance = vi.fn(async () => undefined);
};

const chainIdentityDocument = (overrides: Record<string, unknown> = {}): IndexerDocument => ({
  collection: 'updatesStreams',
  id: 'chainIdentity',
  blockHeight: SORA_LEGACY_IDENTITY_ANCHOR.block,
  timestamp: SORA_LEGACY_IDENTITY_ANCHOR.timestamp,
  data: {
    id: 'chainIdentity',
    block: SORA_LEGACY_IDENTITY_ANCHOR.block,
    data: JSON.stringify({
      schemaVersion: 1,
      genesisHash: SORA_MAINNET_GENESIS_HASH,
      verificationBlock: SORA_LEGACY_IDENTITY_ANCHOR.block,
      verificationBlockHash: SORA_LEGACY_IDENTITY_ANCHOR.hash,
      verificationBlockTimestamp: SORA_LEGACY_IDENTITY_ANCHOR.timestamp,
      migration: 'fresh-database',
      ...overrides,
    }),
  },
});

const liveApiForCheckpoint = (block: number, blockHash: string, timestamp: number) => ({
  rpc: {
    chain: {
      getBlockHash: vi.fn(async (requested: number) => {
        if (requested !== block) throw new Error(`unexpected checkpoint ${requested}`);
        return codec(blockHash);
      }),
    },
  },
  query: {
    timestamp: {
      now: {
        at: vi.fn(async () => codec(timestamp * 1_000)),
      },
    },
  },
});

const currentChainStateDocument = (
  block = STATE_BLOCK,
  blockHash = STATE_HASH,
  blockTimestamp = STATE_TIMESTAMP,
): IndexerDocument => ({
  collection: 'updatesStreams',
  id: 'chainState',
  blockHeight: block,
  timestamp: blockTimestamp,
  data: {
    id: 'chainState',
    block,
    data: JSON.stringify({
      lastIndexedBlock: block,
      genesisHash: SORA_MAINNET_GENESIS_HASH,
      blockHash,
      blockTimestamp,
    }),
  },
});

const legacyChainStateDocument = (
  block = STATE_BLOCK,
  timestamp = STATE_TIMESTAMP,
): IndexerDocument => ({
  collection: 'updatesStreams',
  id: 'chainState',
  blockHeight: block,
  timestamp,
  data: {
    id: 'chainState',
    block,
    data: JSON.stringify({ lastIndexedBlock: block }),
  },
});

const blockSnapshotDocument = (
  block = STATE_BLOCK,
  timestamp = STATE_TIMESTAMP,
  overrides: Partial<IndexerDocument> = {},
): IndexerDocument => ({
  collection: 'networkSnapshots',
  id: `block-${block}`,
  blockHeight: block,
  timestamp,
  data: { id: `block-${block}`, type: 'BLOCK', timestamp },
  ...overrides,
});

const liveApiForIdentityAndState = ({
  stateBlock = STATE_BLOCK,
  stateHash = STATE_HASH,
  stateTimestamp = STATE_TIMESTAMP,
}: {
  stateBlock?: number;
  stateHash?: string;
  stateTimestamp?: number;
} = {}) => ({
  rpc: {
    chain: {
      getBlockHash: vi.fn(async (block: number) => codec(
        block === SORA_LEGACY_IDENTITY_ANCHOR.block
          ? SORA_LEGACY_IDENTITY_ANCHOR.hash
          : block === stateBlock
            ? stateHash
            : hash('f'),
      )),
    },
  },
  query: {
    timestamp: {
      now: {
        at: vi.fn(async (blockHash: string) => codec(
          (blockHash === SORA_LEGACY_IDENTITY_ANCHOR.hash
            ? SORA_LEGACY_IDENTITY_ANCHOR.timestamp
            : stateTimestamp) * 1_000,
        )),
      },
    },
  },
});

describe('PI worker exact SORA mainnet identity', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('checks the canonical genesis before the first repository read or write', async () => {
    const repository = new MemoryRepository();
    const order: string[] = [];
    const actualGet = repository.get.bind(repository);
    const actualList = repository.list.bind(repository);
    const actualUpsert = repository.upsert.bind(repository);
    vi.spyOn(repository, 'get').mockImplementation(async (...args) => {
      order.push('repository-get');
      return actualGet(...args);
    });
    vi.spyOn(repository, 'list').mockImplementation(async (...args) => {
      order.push('repository-list');
      return actualList(...args);
    });
    vi.spyOn(repository, 'upsert').mockImplementation(async (...args) => {
      order.push('repository-upsert');
      return actualUpsert(...args);
    });
    const api = startApi(SORA_MAINNET_GENESIS_HASH, order);
    vi.spyOn(ApiPromise, 'create').mockResolvedValue(api as never);
    const indexer = testIndexer(repository);
    stubPostPreflightWork(indexer);

    await expect(indexer.start()).resolves.toBeUndefined();

    expect(order[0]).toBe('genesis-preflight');
    expect(order.findIndex((entry) => entry.startsWith('repository-'))).toBeGreaterThan(0);
    expect(api.rpc.chain.getBlockHash).toHaveBeenCalledWith(0);
    await expect(repository.get('updatesStreams', 'chainIdentity')).resolves.toMatchObject({
      id: 'chainIdentity',
      blockHeight: SORA_LEGACY_IDENTITY_ANCHOR.block,
      timestamp: SORA_LEGACY_IDENTITY_ANCHOR.timestamp,
      data: {
        block: SORA_LEGACY_IDENTITY_ANCHOR.block,
        data: JSON.stringify({
          schemaVersion: 1,
          genesisHash: SORA_MAINNET_GENESIS_HASH,
          verificationBlock: SORA_LEGACY_IDENTITY_ANCHOR.block,
          verificationBlockHash: SORA_LEGACY_IDENTITY_ANCHOR.hash,
          verificationBlockTimestamp: SORA_LEGACY_IDENTITY_ANCHOR.timestamp,
          migration: 'fresh-database',
        }),
      },
    });
  });

  it.each([
    ['wrong/testnet canonical hash', hash('1'), /does not match the reviewed SORA mainnet identity/],
    ['zero hash', hash('0'), /missing, zero, or malformed genesis hash/],
    ['short malformed hash', '0x1234', /missing, zero, or malformed genesis hash/],
    ['non-hash mainnet label', 'SORA mainnet', /missing, zero, or malformed genesis hash/],
    ['missing null hash', null, /missing, zero, or malformed genesis hash/],
    ['missing undefined hash', undefined, /missing, zero, or malformed genesis hash/],
    ['rejected genesis RPC', new Error('genesis RPC unavailable'), /genesis RPC unavailable/],
  ])('rejects %s without touching the database', async (_label, genesis, expected) => {
    const repository = new MemoryRepository();
    const get = vi.spyOn(repository, 'get');
    const list = vi.spyOn(repository, 'list');
    const upsert = vi.spyOn(repository, 'upsert');
    const upsertMany = vi.spyOn(repository, 'upsertMany');
    const api = startApi(genesis);
    vi.spyOn(ApiPromise, 'create').mockResolvedValue(api as never);
    const indexer = testIndexer(repository);
    stubPostPreflightWork(indexer);

    await expect(indexer.start()).rejects.toThrow(expected as RegExp);

    expect(api.rpc.chain.getFinalizedHead).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(upsertMany).not.toHaveBeenCalled();
  });

  it('does not trust a convincing endpoint hostname when its genesis is wrong', async () => {
    const repository = new MemoryRepository();
    const api = startApi(hash('9'));
    vi.spyOn(ApiPromise, 'create').mockResolvedValue(api as never);
    const indexer = testIndexer(repository);
    stubPostPreflightWork(indexer);

    await expect(indexer.start()).rejects.toThrow('does not match the reviewed SORA mainnet identity');
    await expect(repository.list('updatesStreams')).resolves.toEqual([]);
  });

  it.each([
    ['wrong canonical anchor', hash('2'), /does not contain the reviewed SORA mainnet history anchor/],
    ['zero anchor', hash('0'), /does not contain the reviewed SORA mainnet history anchor/],
    ['malformed anchor', '0x1234', /does not contain the reviewed SORA mainnet history anchor/],
    ['missing anchor', null, /does not contain the reviewed SORA mainnet history anchor/],
    ['rejected anchor RPC', new Error('anchor RPC unavailable'), /anchor RPC unavailable/],
  ])('rejects a primary endpoint with %s before touching the database', async (_label, anchor, expected) => {
    const repository = new MemoryRepository();
    const get = vi.spyOn(repository, 'get');
    const list = vi.spyOn(repository, 'list');
    const upsert = vi.spyOn(repository, 'upsert');
    const api = startApi(SORA_MAINNET_GENESIS_HASH);
    api.rpc.chain.getBlockHash.mockImplementation(async (block: number) => {
      if (block === 0) return codec(SORA_MAINNET_GENESIS_HASH);
      if (block === SORA_LEGACY_IDENTITY_ANCHOR.block) {
        if (anchor instanceof Error) throw anchor;
        return anchor === null ? anchor : codec(anchor);
      }
      throw new Error(`unexpected block ${block}`);
    });
    vi.spyOn(ApiPromise, 'create').mockResolvedValue(api as never);
    const indexer = testIndexer(repository);
    stubPostPreflightWork(indexer);

    await expect(indexer.start()).rejects.toThrow(expected as RegExp);
    expect(get).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('rejects a finalized header hash that does not match getFinalizedHead before database access', async () => {
    const repository = new MemoryRepository();
    const get = vi.spyOn(repository, 'get');
    const api = startApi(SORA_MAINNET_GENESIS_HASH);
    api.rpc.chain.getHeader.mockResolvedValue({
      number: { toNumber: () => FINALIZED_BLOCK },
      hash: codec(hash('e')),
    });
    vi.spyOn(ApiPromise, 'create').mockResolvedValue(api as never);
    const indexer = testIndexer(repository);
    stubPostPreflightWork(indexer);

    await expect(indexer.start()).rejects.toThrow('malformed finalized block identity');
    expect(get).not.toHaveBeenCalled();
  });

  it('accepts an exact immutable stored identity', async () => {
    const repository = new MemoryRepository();
    await repository.upsert(chainIdentityDocument());
    const indexer = testIndexer(repository);
    indexer.api = liveApiForCheckpoint(
      SORA_LEGACY_IDENTITY_ANCHOR.block,
      SORA_LEGACY_IDENTITY_ANCHOR.hash,
      SORA_LEGACY_IDENTITY_ANCHOR.timestamp,
    );

    await expect(indexer.ensureChainIdentity(FINALIZED_BLOCK)).resolves.toBeUndefined();
  });

  it.each([
    ['wrong genesis', { genesisHash: hash('7') }],
    ['zero genesis', { genesisHash: hash('0') }],
    ['wrong verification hash', { verificationBlockHash: hash('8') }],
    ['zero verification hash', { verificationBlockHash: hash('0') }],
    ['malformed verification hash', { verificationBlockHash: '0xbeef' }],
    ['wrong verification height', { verificationBlock: FINALIZED_BLOCK + 1 }],
    ['wrong verification time', { verificationBlockTimestamp: FINALIZED_TIMESTAMP + 1 }],
    ['unknown migration', { migration: 'operator-assertion' }],
    ['unsupported field', { claimedNetwork: 'mainnet' }],
  ])('rejects immutable stored identity mismatch: %s', async (_label, overrides) => {
    const repository = new MemoryRepository();
    await repository.upsert(chainIdentityDocument(overrides));
    const indexer = testIndexer(repository);
    indexer.api = liveApiForCheckpoint(
      SORA_LEGACY_IDENTITY_ANCHOR.block,
      SORA_LEGACY_IDENTITY_ANCHOR.hash,
      SORA_LEGACY_IDENTITY_ANCHOR.timestamp,
    );

    await expect(indexer.ensureChainIdentity(FINALIZED_BLOCK)).rejects.toThrow();
  });

  it('re-verifies a persisted identity checkpoint against the live primary chain', async () => {
    const repository = new MemoryRepository();
    await repository.upsert(chainIdentityDocument());
    const indexer = testIndexer(repository);
    indexer.api = liveApiForCheckpoint(
      SORA_LEGACY_IDENTITY_ANCHOR.block,
      hash('e'),
      SORA_LEGACY_IDENTITY_ANCHOR.timestamp,
    );

    await expect(indexer.ensureChainIdentity(FINALIZED_BLOCK)).rejects.toThrow(
      /stored PI chain identity checkpoint.*primary SORA chain/i,
    );
  });

  it.each(['fresh-database', 'legacy-production-anchor-v1'] as const)(
    'accepts %s identity only at the fixed audited anchor',
    async (migration) => {
      const repository = new MemoryRepository();
      await repository.upsert(chainIdentityDocument({ migration }));
      const indexer = testIndexer(repository);
      indexer.api = liveApiForIdentityAndState();

      await expect(indexer.ensureChainIdentity(FINALIZED_BLOCK)).resolves.toBeUndefined();
    },
  );

  it.each(['fresh-database', 'legacy-production-anchor-v1'] as const)(
    'rejects %s identity at any non-anchor checkpoint',
    async (migration) => {
      const repository = new MemoryRepository();
      await repository.upsert(chainIdentityDocument({
        migration,
        verificationBlock: SORA_LEGACY_IDENTITY_ANCHOR.block + 1,
        verificationBlockHash: hash('d'),
        verificationBlockTimestamp: SORA_LEGACY_IDENTITY_ANCHOR.timestamp + 1,
      }));
      const indexer = testIndexer(repository);
      indexer.api = liveApiForIdentityAndState();

      await expect(indexer.ensureChainIdentity(FINALIZED_BLOCK)).rejects.toThrow(
        'Stored PI chain identity checkpoint is malformed',
      );
    },
  );

  it('accepts an exact current chainState at or below the finalized primary checkpoint', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([
      chainIdentityDocument(),
      currentChainStateDocument(),
      blockSnapshotDocument(),
    ]);
    const indexer = testIndexer(repository);
    indexer.api = liveApiForIdentityAndState();

    await expect(indexer.ensureChainIdentity(STATE_BLOCK)).resolves.toBeUndefined();
  });

  it('accepts an exact legacy chainState at or below the finalized primary checkpoint', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([
      chainIdentityDocument(),
      legacyChainStateDocument(),
      blockSnapshotDocument(),
    ]);
    const indexer = testIndexer(repository);
    indexer.api = liveApiForIdentityAndState();

    await expect(indexer.ensureChainIdentity(STATE_BLOCK)).resolves.toBeUndefined();
  });

  const currentStateMismatchCases: Array<[
    string,
    {
      finalized?: number;
      stateHash?: string;
      stateTimestamp?: number;
      omitSnapshot?: boolean;
      snapshot?: Partial<IndexerDocument>;
      snapshotData?: Record<string, unknown>;
    },
    RegExp,
  ]> = [
    ['ahead of finalized', { finalized: STATE_BLOCK - 1 }, /ahead of the primary finalized/],
    ['wrong live block hash', { stateHash: hash('d') }, /block hash does not match/],
    ['wrong live timestamp', { stateTimestamp: STATE_TIMESTAMP + 1 }, /timestamp does not match/],
    ['missing BLOCK snapshot', { omitSnapshot: true }, /exact matching BLOCK snapshot/],
    ['snapshot height mismatch', { snapshot: { blockHeight: STATE_BLOCK + 1 } }, /exact matching BLOCK snapshot/],
    ['snapshot timestamp mismatch', { snapshot: { timestamp: STATE_TIMESTAMP + 1 } }, /exact matching BLOCK snapshot/],
    ['snapshot id mismatch', { snapshotData: { id: 'block-mainnet' } }, /exact matching BLOCK snapshot/],
    ['snapshot type mismatch', { snapshotData: { type: 'DEFAULT' } }, /exact matching BLOCK snapshot/],
    ['snapshot data timestamp mismatch', { snapshotData: { timestamp: STATE_TIMESTAMP + 1 } }, /exact matching BLOCK snapshot/],
  ];

  it.each(currentStateMismatchCases)('rejects current chainState with %s', async (_label, mutation, expected) => {
    const repository = new MemoryRepository();
    const snapshot = blockSnapshotDocument();
    if (mutation.snapshot) Object.assign(snapshot, mutation.snapshot);
    if (mutation.snapshotData) Object.assign(snapshot.data, mutation.snapshotData);
    const documents = [chainIdentityDocument(), currentChainStateDocument()];
    if (!mutation.omitSnapshot) documents.push(snapshot);
    await repository.upsertMany(documents);
    const indexer = testIndexer(repository);
    indexer.api = liveApiForIdentityAndState({
      stateHash: mutation.stateHash ?? STATE_HASH,
      stateTimestamp: mutation.stateTimestamp ?? STATE_TIMESTAMP,
    });

    await expect(indexer.ensureChainIdentity(mutation.finalized ?? FINALIZED_BLOCK)).rejects.toThrow(expected as RegExp);
  });

  const legacyStateMismatchCases: Array<[
    string,
    { finalized?: number; omitSnapshot?: boolean; stateHash?: string; stateTimestamp?: number },
    RegExp,
  ]> = [
    ['ahead of finalized', { finalized: STATE_BLOCK - 1 }, /ahead of the primary finalized/],
    ['missing BLOCK snapshot', { omitSnapshot: true }, /timestamped BLOCK snapshot/],
    ['malformed live block hash', { stateHash: hash('0') }, /block hash does not match/],
    ['wrong live timestamp', { stateTimestamp: STATE_TIMESTAMP + 1 }, /timestamp does not match/],
  ];

  it.each(legacyStateMismatchCases)('rejects legacy chainState with %s', async (_label, mutation, expected) => {
    const repository = new MemoryRepository();
    const documents = [chainIdentityDocument(), legacyChainStateDocument()];
    if (!mutation.omitSnapshot) documents.push(blockSnapshotDocument());
    await repository.upsertMany(documents);
    const indexer = testIndexer(repository);
    indexer.api = liveApiForIdentityAndState({
      stateHash: mutation.stateHash ?? STATE_HASH,
      stateTimestamp: mutation.stateTimestamp ?? STATE_TIMESTAMP,
    });

    await expect(indexer.ensureChainIdentity(mutation.finalized ?? FINALIZED_BLOCK)).rejects.toThrow(expected as RegExp);
  });

  it('allows an identity-only crash state before the first chainState write', async () => {
    const repository = new MemoryRepository();
    await repository.upsert(chainIdentityDocument());
    const indexer = testIndexer(repository);
    indexer.api = liveApiForIdentityAndState();

    await expect(indexer.ensureChainIdentity(FINALIZED_BLOCK)).resolves.toBeUndefined();
  });

  it('rejects any non-identity data when chainState is missing', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([
      chainIdentityDocument(),
      {
        collection: 'markets',
        id: 'unexpected-market',
        blockHeight: STATE_BLOCK,
        timestamp: STATE_TIMESTAMP,
        data: { id: 'unexpected-market' },
      },
    ]);
    const indexer = testIndexer(repository);
    indexer.api = liveApiForIdentityAndState();

    await expect(indexer.ensureChainIdentity(FINALIZED_BLOCK)).rejects.toThrow(
      'indexed data but no chainState checkpoint',
    );
  });

  it('migrates a legacy database only through the exact audited anchor', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([
      {
        collection: 'updatesStreams',
        id: 'chainState',
        blockHeight: SORA_LEGACY_IDENTITY_ANCHOR.block,
        timestamp: SORA_LEGACY_IDENTITY_ANCHOR.timestamp,
        data: {
          id: 'chainState',
          block: SORA_LEGACY_IDENTITY_ANCHOR.block,
          data: JSON.stringify({ lastIndexedBlock: SORA_LEGACY_IDENTITY_ANCHOR.block }),
        },
      },
      {
        collection: 'networkSnapshots',
        id: `block-${SORA_LEGACY_IDENTITY_ANCHOR.block}`,
        blockHeight: SORA_LEGACY_IDENTITY_ANCHOR.block,
        timestamp: SORA_LEGACY_IDENTITY_ANCHOR.timestamp,
        data: {
          id: `block-${SORA_LEGACY_IDENTITY_ANCHOR.block}`,
          type: 'BLOCK',
          timestamp: SORA_LEGACY_IDENTITY_ANCHOR.timestamp,
        },
      },
    ]);
    const indexer = testIndexer(repository);
    indexer.api = liveApiForCheckpoint(
      SORA_LEGACY_IDENTITY_ANCHOR.block,
      SORA_LEGACY_IDENTITY_ANCHOR.hash,
      SORA_LEGACY_IDENTITY_ANCHOR.timestamp,
    );

    await expect(indexer.ensureChainIdentity(FINALIZED_BLOCK)).resolves.toBeUndefined();
    const identity = await repository.get('updatesStreams', 'chainIdentity');
    expect(identity?.data.data).toBe(JSON.stringify({
      schemaVersion: 1,
      genesisHash: SORA_MAINNET_GENESIS_HASH,
      verificationBlock: SORA_LEGACY_IDENTITY_ANCHOR.block,
      verificationBlockHash: SORA_LEGACY_IDENTITY_ANCHOR.hash,
      verificationBlockTimestamp: SORA_LEGACY_IDENTITY_ANCHOR.timestamp,
      migration: 'legacy-production-anchor-v1',
    }));
  });

  const legacyMismatchCases: Array<[
    string,
    {
      stateBlock?: number;
      omitSnapshot?: boolean;
      snapshotBlock?: number;
      snapshotTimestamp?: number;
      snapshotId?: string;
      snapshotType?: string;
      liveHash?: string;
      liveTimestamp?: number;
    },
  ]> = [
    ['state below anchor', { stateBlock: SORA_LEGACY_IDENTITY_ANCHOR.block - 1 }],
    ['missing anchor snapshot', { omitSnapshot: true }],
    ['wrong snapshot height', { snapshotBlock: SORA_LEGACY_IDENTITY_ANCHOR.block + 1 }],
    ['wrong snapshot timestamp', { snapshotTimestamp: SORA_LEGACY_IDENTITY_ANCHOR.timestamp + 1 }],
    ['wrong snapshot id', { snapshotId: 'block-mainnet' }],
    ['wrong snapshot type', { snapshotType: 'DEFAULT' }],
    ['wrong live anchor hash', { liveHash: hash('f') }],
    ['wrong live anchor timestamp', { liveTimestamp: SORA_LEGACY_IDENTITY_ANCHOR.timestamp + 1 }],
  ];

  it.each(legacyMismatchCases)('rejects legacy migration with %s', async (_label, mutation) => {
    const stateBlock = mutation.stateBlock ?? SORA_LEGACY_IDENTITY_ANCHOR.block;
    const snapshotBlock = mutation.snapshotBlock ?? SORA_LEGACY_IDENTITY_ANCHOR.block;
    const snapshotTimestamp = mutation.snapshotTimestamp ?? SORA_LEGACY_IDENTITY_ANCHOR.timestamp;
    const snapshotId = mutation.snapshotId ?? `block-${SORA_LEGACY_IDENTITY_ANCHOR.block}`;
    const snapshotType = mutation.snapshotType ?? 'BLOCK';
    const repository = new MemoryRepository();
    await repository.upsert({
      collection: 'updatesStreams',
      id: 'chainState',
      blockHeight: stateBlock,
      timestamp: SORA_LEGACY_IDENTITY_ANCHOR.timestamp,
      data: {
        id: 'chainState',
        block: stateBlock,
        data: JSON.stringify({ lastIndexedBlock: stateBlock }),
      },
    });
    if (!mutation.omitSnapshot) {
      await repository.upsert({
        collection: 'networkSnapshots',
        id: `block-${SORA_LEGACY_IDENTITY_ANCHOR.block}`,
        blockHeight: snapshotBlock,
        timestamp: snapshotTimestamp,
        data: { id: snapshotId, type: snapshotType, timestamp: snapshotTimestamp },
      });
    }
    const indexer = testIndexer(repository);
    indexer.api = liveApiForCheckpoint(
      SORA_LEGACY_IDENTITY_ANCHOR.block,
      mutation.liveHash ?? SORA_LEGACY_IDENTITY_ANCHOR.hash,
      mutation.liveTimestamp ?? SORA_LEGACY_IDENTITY_ANCHOR.timestamp,
    );

    await expect(indexer.ensureChainIdentity(FINALIZED_BLOCK)).rejects.toThrow();
    await expect(repository.get('updatesStreams', 'chainIdentity')).resolves.toBeNull();
  });

  it('does not bless nonempty data in another collection as a fresh database', async () => {
    const repository = new MemoryRepository();
    await repository.upsert({
      collection: 'markets',
      id: 'legacy-market',
      blockHeight: SORA_LEGACY_IDENTITY_ANCHOR.block,
      timestamp: SORA_LEGACY_IDENTITY_ANCHOR.timestamp,
      data: { id: 'legacy-market' },
    });
    const indexer = testIndexer(repository);
    indexer.api = liveApiForCheckpoint(
      SORA_LEGACY_IDENTITY_ANCHOR.block,
      SORA_LEGACY_IDENTITY_ANCHOR.hash,
      SORA_LEGACY_IDENTITY_ANCHOR.timestamp,
    );

    await expect(indexer.ensureChainIdentity(FINALIZED_BLOCK)).rejects.toThrow(
      'database is nonempty',
    );
    await expect(repository.get('updatesStreams', 'chainIdentity')).resolves.toBeNull();
  });

  it('persists chainState with exact genesis, requested block hash, and block timestamp', () => {
    const indexer = testIndexer();
    indexer.observedGenesisHash = SORA_MAINNET_GENESIS_HASH;

    expect(indexer.createChainStateDocument(42, CHECKPOINT_HASH, FINALIZED_TIMESTAMP)).toMatchObject({
      collection: 'updatesStreams',
      id: 'chainState',
      blockHeight: 42,
      data: {
        id: 'chainState',
        block: 42,
        data: JSON.stringify({
          lastIndexedBlock: 42,
          genesisHash: SORA_MAINNET_GENESIS_HASH,
          blockHash: CHECKPOINT_HASH,
          blockTimestamp: FINALIZED_TIMESTAMP,
        }),
      },
    });
  });

  it.each([
    ['missing observed genesis', null, 42, CHECKPOINT_HASH, FINALIZED_TIMESTAMP],
    ['wrong observed genesis', hash('1'), 42, CHECKPOINT_HASH, FINALIZED_TIMESTAMP],
    ['zero block height', SORA_MAINNET_GENESIS_HASH, 0, CHECKPOINT_HASH, FINALIZED_TIMESTAMP],
    ['fractional block height', SORA_MAINNET_GENESIS_HASH, 1.5, CHECKPOINT_HASH, FINALIZED_TIMESTAMP],
    ['zero block hash', SORA_MAINNET_GENESIS_HASH, 42, hash('0'), FINALIZED_TIMESTAMP],
    ['malformed block hash', SORA_MAINNET_GENESIS_HASH, 42, '0x1234', FINALIZED_TIMESTAMP],
    ['uppercase block hash', SORA_MAINNET_GENESIS_HASH, 42, CHECKPOINT_HASH.toUpperCase(), FINALIZED_TIMESTAMP],
    ['zero block timestamp', SORA_MAINNET_GENESIS_HASH, 42, CHECKPOINT_HASH, 0],
    ['fractional block timestamp', SORA_MAINNET_GENESIS_HASH, 42, CHECKPOINT_HASH, FINALIZED_TIMESTAMP + 0.5],
  ])('refuses chainState with %s', (_label, genesis, block, blockHash, timestamp) => {
    const indexer = testIndexer();
    indexer.observedGenesisHash = genesis as string | null;
    expect(() => indexer.createChainStateDocument(block as number, blockHash as string, timestamp as number)).toThrow(
      'validated SORA mainnet block identity',
    );
  });

  it.each([
    ['zero milliseconds', '0'],
    ['sub-second value that truncates to zero', '999'],
    ['negative milliseconds', '-1000'],
    ['fractional milliseconds', '1700000000000.5'],
    ['scientific notation', '1e12'],
    ['unsafe integer milliseconds', '9007199254740992'],
    ['missing timestamp', ''],
    ['non-numeric timestamp', 'now'],
  ])('rejects %s from timestamp.now.at', async (_label, timestampValue) => {
    const indexer = testIndexer();
    const api = {
      query: {
        timestamp: {
          now: {
            at: vi.fn(async () => codec(timestampValue)),
          },
        },
      },
    };
    indexer.api = api;

    await expect(indexer.fetchBlockTimestamp(CHECKPOINT_HASH, api)).rejects.toThrow('Invalid timestamp.now');
  });

  it('bounds a hanging timestamp.now.at call', async () => {
    vi.useFakeTimers();
    const indexer = testIndexer();
    const api = {
      query: {
        timestamp: {
          now: {
            at: vi.fn(async () => new Promise(() => undefined)),
          },
        },
      },
    };
    indexer.api = api;

    const request = indexer.fetchBlockTimestamp(CHECKPOINT_HASH, api);
    const rejection = expect(request).rejects.toThrow(`timestamp.now.at(${CHECKPOINT_HASH}) timed out after 15000ms`);
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
  });

  it('rejects a returned block height that differs from the requested height', async () => {
    const indexer = testIndexer();
    const api = {
      rpc: {
        chain: {
          getBlockHash: vi.fn(async () => codec(CHECKPOINT_HASH)),
          getBlock: vi.fn(async () => ({
            block: {
              header: { number: { toNumber: () => 43 }, hash: codec(CHECKPOINT_HASH) },
              extrinsics: [],
            },
          })),
        },
      },
      query: {
        system: { events: { at: vi.fn(async () => []) } },
        timestamp: { now: { at: vi.fn(async () => codec(FINALIZED_TIMESTAMP * 1_000)) } },
      },
    };
    indexer.api = api;

    await expect(indexer.fetchBlockByNumber(42)).rejects.toThrow(
      'block data endpoint returned block 43 for requested height 42',
    );
  });

  it('rejects a returned block whose header hash differs from the requested hash', async () => {
    const indexer = testIndexer();
    indexer.observedGenesisHash = SORA_MAINNET_GENESIS_HASH;
    await expect(indexer.indexFetchedBlock({
      requestedHash: CHECKPOINT_HASH,
      signedBlock: {
        block: {
          header: { number: { toNumber: () => 42 }, hash: codec(hash('c')) },
          extrinsics: [],
        },
      },
      events: [],
      timestamp: FINALIZED_TIMESTAMP,
    })).rejects.toThrow('does not match requested hash');
  });
});

describe('PI archive endpoint identity', () => {
  const originalArchiveEndpoint = process.env.SORA_ARCHIVE_WS_ENDPOINT;

  afterEach(() => {
    vi.useRealTimers();
    if (originalArchiveEndpoint === undefined) delete process.env.SORA_ARCHIVE_WS_ENDPOINT;
    else process.env.SORA_ARCHIVE_WS_ENDPOINT = originalArchiveEndpoint;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  const loadArchiveWorker = async () => {
    process.env.SORA_ARCHIVE_WS_ENDPOINT = 'wss://archive-mainnet-label.invalid';
    vi.resetModules();
    const [{ ApiPromise: RuntimeApiPromise }, { ChainIndexer: RuntimeChainIndexer }, { MemoryRepository: RuntimeMemoryRepository }] =
      await Promise.all([
        import('@polkadot/api'),
        import('../src/worker/chain.js'),
        import('../src/repository/memory.js'),
      ]);
    return { RuntimeApiPromise, RuntimeChainIndexer, RuntimeMemoryRepository };
  };

  it('rejects an archive endpoint whose convincing label hides the wrong genesis', async () => {
    const { RuntimeApiPromise, RuntimeChainIndexer, RuntimeMemoryRepository } = await loadArchiveWorker();
    const archiveApi = { rpc: { chain: { getBlockHash: vi.fn(async () => codec(hash('4'))) } } };
    vi.spyOn(RuntimeApiPromise, 'create').mockResolvedValue(archiveApi as never);
    const indexer = new RuntimeChainIndexer(config, new RuntimeMemoryRepository()) as unknown as TestIndexer;
    indexer.api = {};

    await expect(indexer.getBlockDataApi()).rejects.toThrow('does not match the reviewed SORA mainnet identity');
  });

  it.each([
    ['wrong canonical anchor', hash('7')],
    ['zero anchor', hash('0')],
    ['malformed anchor', '0x1234'],
    ['missing anchor', null],
  ])('rejects an archive endpoint with %s and disconnects it', async (_label, anchor) => {
    const { RuntimeApiPromise, RuntimeChainIndexer, RuntimeMemoryRepository } = await loadArchiveWorker();
    const archiveApi = {
      disconnect: vi.fn(async () => undefined),
      rpc: {
        chain: {
          getBlockHash: vi.fn(async (block: number) => block === 0
            ? codec(SORA_MAINNET_GENESIS_HASH)
            : anchor === null
              ? null
              : codec(anchor)),
        },
      },
    };
    vi.spyOn(RuntimeApiPromise, 'create').mockResolvedValue(archiveApi as never);
    const indexer = new RuntimeChainIndexer(config, new RuntimeMemoryRepository()) as unknown as TestIndexer;
    indexer.api = {};

    await expect(indexer.getBlockDataApi()).rejects.toThrow('does not contain the reviewed SORA mainnet history anchor');
    expect(archiveApi.disconnect).toHaveBeenCalledOnce();
  });

  it('accepts an archive only after both exact genesis and history-anchor proofs', async () => {
    const { RuntimeApiPromise, RuntimeChainIndexer, RuntimeMemoryRepository } = await loadArchiveWorker();
    const archiveApi = {
      disconnect: vi.fn(async () => undefined),
      rpc: {
        chain: {
          getBlockHash: vi.fn(async (block: number) => codec(
            block === 0 ? SORA_MAINNET_GENESIS_HASH : SORA_LEGACY_IDENTITY_ANCHOR.hash,
          )),
        },
      },
    };
    vi.spyOn(RuntimeApiPromise, 'create').mockResolvedValue(archiveApi as never);
    const indexer = new RuntimeChainIndexer(config, new RuntimeMemoryRepository()) as unknown as TestIndexer;
    indexer.api = {};

    await expect(indexer.getBlockDataApi()).resolves.toBe(archiveApi);
    expect(archiveApi.rpc.chain.getBlockHash).toHaveBeenCalledWith(0);
    expect(archiveApi.rpc.chain.getBlockHash).toHaveBeenCalledWith(SORA_LEGACY_IDENTITY_ANCHOR.block);
    await indexer.stop();
    expect(archiveApi.disconnect).toHaveBeenCalledOnce();
  });

  it('rejects a block-height hash divergence between the primary and archive APIs', async () => {
    const { RuntimeChainIndexer, RuntimeMemoryRepository } = await loadArchiveWorker();
    const primaryHash = hash('5');
    const archiveHash = hash('6');
    const primary = { rpc: { chain: { getBlockHash: vi.fn(async () => codec(primaryHash)) } } };
    const archive = { rpc: { chain: { getBlockHash: vi.fn(async () => codec(archiveHash)) } } };
    const indexer = new RuntimeChainIndexer(config, new RuntimeMemoryRepository()) as unknown as TestIndexer;
    indexer.api = primary;
    indexer.legacyBlockApi = archive;

    await expect(indexer.fetchBlockByNumber(42)).rejects.toThrow(
      'block data endpoint hash diverges from the primary endpoint at block 42',
    );
    expect(primary.rpc.chain.getBlockHash).toHaveBeenCalledWith(42);
    expect(archive.rpc.chain.getBlockHash).toHaveBeenCalledWith(42);
  });
});
