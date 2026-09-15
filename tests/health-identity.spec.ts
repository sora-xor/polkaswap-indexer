import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSchema } from '../src/graphql/resolvers.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { SORA_LEGACY_IDENTITY_ANCHOR, SORA_MAINNET_GENESIS_HASH } from '../src/soraIdentity.js';
import { createPersistedWorkerStatusDocument } from '../src/worker/status.js';

import type { IndexerDocument } from '../src/repository/types.js';

const NOW = 2_000_000_000;
const CHECKPOINT_BLOCK = 30_000_000;
const VERIFICATION_BLOCK = SORA_LEGACY_IDENTITY_ANCHOR.block;
const CHECKPOINT_HASH = `0x${'ab'.repeat(32)}`;
const VERIFICATION_HASH = SORA_LEGACY_IDENTITY_ANCHOR.hash;

type IdentityFixtureOptions = {
  identity?: Record<string, unknown>;
  state?: Record<string, unknown>;
  identityEnvelope?: Record<string, unknown>;
  stateEnvelope?: Record<string, unknown>;
};

const identityFixture = (options: IdentityFixtureOptions = {}): IndexerDocument[] => {
  const identity = {
    schemaVersion: 1,
    genesisHash: SORA_MAINNET_GENESIS_HASH,
    verificationBlock: VERIFICATION_BLOCK,
    verificationBlockHash: VERIFICATION_HASH,
    verificationBlockTimestamp: SORA_LEGACY_IDENTITY_ANCHOR.timestamp,
    migration: 'fresh-database',
    ...options.identity,
  };
  const state = {
    lastIndexedBlock: CHECKPOINT_BLOCK,
    genesisHash: SORA_MAINNET_GENESIS_HASH,
    blockHash: CHECKPOINT_HASH,
    blockTimestamp: NOW,
    ...options.state,
  };

  return [
    {
      collection: 'updatesStreams',
      id: 'chainIdentity',
      blockHeight: VERIFICATION_BLOCK,
      timestamp: SORA_LEGACY_IDENTITY_ANCHOR.timestamp,
      data: {
        id: 'chainIdentity',
        block: VERIFICATION_BLOCK,
        data: JSON.stringify(identity),
        ...options.identityEnvelope,
      },
    },
    {
      collection: 'updatesStreams',
      id: 'chainState',
      blockHeight: CHECKPOINT_BLOCK,
      timestamp: typeof state.blockTimestamp === 'number' ? state.blockTimestamp : NOW,
      data: {
        id: 'chainState',
        block: CHECKPOINT_BLOCK,
        data: JSON.stringify(state),
        ...options.stateEnvelope,
      },
    },
    createPersistedWorkerStatusDocument({
      lifecycle: 'running',
      startupComplete: true,
      latestFinalizedBlock: CHECKPOINT_BLOCK,
      latestIndexedBlock: CHECKPOINT_BLOCK,
      lag: 0,
      lastSuccessfulIndexTimestamp: NOW,
      lastError: null,
      lastErrorTimestamp: null,
    }, NOW),
  ];
};

const resolveHealth = async (documents: IndexerDocument[]) => {
  const repository = new MemoryRepository();
  const documentsByKey = new Map(
    documents.map((document) => [`${document.collection}\u0000${document.id}`, document])
  );
  vi.spyOn(repository, 'get').mockImplementation(async (collection, id) =>
    documentsByKey.get(`${collection}\u0000${id}`) ?? null
  );
  const healthField = createSchema().getQueryType()?.getFields()._health;
  return healthField?.resolve?.({}, {}, { repository }, {} as never);
};

describe('PI GraphQL mainnet identity health', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is healthy only for the exact persisted SORA identity and coherent checkpoint', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW * 1_000);

    await expect(resolveHealth(identityFixture())).resolves.toEqual({
      ok: true,
      repositoryReady: true,
      service: 'polkaswap-indexer',
      serviceId: 'pi.soramitsu.io',
      schemaVersion: 1,
      ecosystem: 'sora2',
      chainId: 'sora:mainnet',
      network: 'mainnet',
      publicBaseUrl: 'https://pi.soramitsu.io/graphql',
      readOnly: true,
      genesisHash: SORA_MAINNET_GENESIS_HASH,
      latestIndexedBlock: CHECKPOINT_BLOCK,
      latestIndexedBlockHash: CHECKPOINT_HASH,
      latestIndexedAt: NOW,
      workerAvailable: true,
      workerReady: true,
      workerReadinessReason: null,
      workerLifecycle: 'running',
      workerStartupComplete: true,
      workerLatestFinalizedBlock: CHECKPOINT_BLOCK,
      workerLatestIndexedBlock: CHECKPOINT_BLOCK,
      workerLag: 0,
      workerLastSuccessfulIndexTimestamp: NOW,
      workerLastError: null,
      workerLastErrorTimestamp: null,
    });
  });

  it.each([
    ['maximum stale age', NOW - 300],
    ['maximum future skew', NOW + 30],
  ])('accepts the inclusive %s boundary', async (_label, blockTimestamp) => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW * 1_000);
    await expect(resolveHealth(identityFixture({ state: { blockTimestamp } }))).resolves.toMatchObject({ ok: true });
  });

  it.each([
    ['one second too stale', NOW - 301],
    ['one second too far in the future', NOW + 31],
    ['zero timestamp', 0],
    ['fractional timestamp', NOW - 0.5],
    ['string timestamp', String(NOW)],
  ])('rejects a checkpoint with %s', async (_label, blockTimestamp) => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW * 1_000);
    await expect(resolveHealth(identityFixture({ state: { blockTimestamp } }))).resolves.toMatchObject({ ok: false });
  });

  it.each([
    ['wrong/testnet genesis', { state: { genesisHash: `0x${'11'.repeat(32)}` } }],
    ['convincing mainnet label with wrong identity', { state: { genesisHash: 'sora:mainnet' } }],
    ['missing checkpoint genesis', { state: { genesisHash: undefined } }],
    ['zero checkpoint hash', { state: { blockHash: `0x${'0'.repeat(64)}` } }],
    ['malformed checkpoint hash', { state: { blockHash: '0x1234' } }],
    ['uppercase checkpoint hash', { state: { blockHash: CHECKPOINT_HASH.toUpperCase() } }],
    ['zero checkpoint height', { state: { lastIndexedBlock: 0 } }],
    ['fractional checkpoint height', { state: { lastIndexedBlock: 1.5 } }],
    ['string checkpoint height', { state: { lastIndexedBlock: String(CHECKPOINT_BLOCK) } }],
  ])('rejects %s', async (_label, options) => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW * 1_000);
    await expect(resolveHealth(identityFixture(options))).resolves.toMatchObject({ ok: false });
  });

  it('rejects an equal-height checkpoint unless its hash and timestamp exactly match the identity', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(SORA_LEGACY_IDENTITY_ANCHOR.timestamp * 1_000);
    const documents = identityFixture({
      state: {
        lastIndexedBlock: VERIFICATION_BLOCK,
        blockHash: CHECKPOINT_HASH,
        blockTimestamp: SORA_LEGACY_IDENTITY_ANCHOR.timestamp,
      },
    });
    documents[1].blockHeight = VERIFICATION_BLOCK;
    documents[1].timestamp = SORA_LEGACY_IDENTITY_ANCHOR.timestamp;
    documents[1].data.block = VERIFICATION_BLOCK;
    documents[2] = createPersistedWorkerStatusDocument({
      lifecycle: 'running',
      startupComplete: true,
      latestFinalizedBlock: VERIFICATION_BLOCK,
      latestIndexedBlock: VERIFICATION_BLOCK,
      lag: 0,
      lastSuccessfulIndexTimestamp: SORA_LEGACY_IDENTITY_ANCHOR.timestamp,
      lastError: null,
      lastErrorTimestamp: null,
    }, SORA_LEGACY_IDENTITY_ANCHOR.timestamp);

    await expect(resolveHealth(documents)).resolves.toMatchObject({ ok: false });
  });

  it('rejects a ready heartbeat that does not identify the persisted chainState', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW * 1_000);
    const documents = identityFixture();
    documents[2] = createPersistedWorkerStatusDocument({
      lifecycle: 'running',
      startupComplete: true,
      latestFinalizedBlock: CHECKPOINT_BLOCK + 1,
      latestIndexedBlock: CHECKPOINT_BLOCK + 1,
      lag: 0,
      lastSuccessfulIndexTimestamp: NOW,
      lastError: null,
      lastErrorTimestamp: null,
    }, NOW);

    await expect(resolveHealth(documents)).resolves.toMatchObject({ ok: false });
  });

  it.each([
    ['wrong/testnet identity genesis', { genesisHash: `0x${'22'.repeat(32)}` }],
    ['zero verification hash', { verificationBlockHash: `0x${'0'.repeat(64)}` }],
    ['malformed verification hash', { verificationBlockHash: '0xdeadbeef' }],
    ['unknown migration method', { migration: 'trust-the-label' }],
    ['missing migration method', { migration: undefined }],
    ['unsupported identity field', { operatorClaimedMainnet: true }],
  ])('rejects an immutable identity record with %s', async (_label, identity) => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW * 1_000);
    await expect(resolveHealth(identityFixture({ identity }))).resolves.toMatchObject({ ok: false });
  });

  const envelopeMismatchCases: Array<[
    string,
    IdentityFixtureOptions,
    { identityBlockHeight?: number; stateBlockHeight?: number },
  ]> = [
    ['identity id', { identityEnvelope: { id: 'mainnet-chainIdentity' } }, {}],
    ['identity block', { identityEnvelope: { block: VERIFICATION_BLOCK + 1 } }, {}],
    ['identity document height', {}, { identityBlockHeight: VERIFICATION_BLOCK + 1 }],
    ['checkpoint id', { stateEnvelope: { id: 'mainnet-chainState' } }, {}],
    ['checkpoint block', { stateEnvelope: { block: CHECKPOINT_BLOCK + 1 } }, {}],
    ['checkpoint document height', {}, { stateBlockHeight: CHECKPOINT_BLOCK + 1 }],
  ];

  it.each(envelopeMismatchCases)('rejects a persisted %s envelope mismatch', async (_label, options, documentMutation) => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW * 1_000);
    const documents = identityFixture(options as IdentityFixtureOptions);
    if (documentMutation.identityBlockHeight !== undefined) documents[0].blockHeight = documentMutation.identityBlockHeight;
    if (documentMutation.stateBlockHeight !== undefined) documents[1].blockHeight = documentMutation.stateBlockHeight;
    await expect(resolveHealth(documents)).resolves.toMatchObject({ ok: false });
  });

  it('stays unhealthy when repository health fails despite exact stored identity', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW * 1_000);
    const documents = identityFixture();
    const repository = new MemoryRepository();
    await repository.upsertMany(documents);
    vi.spyOn(repository, 'healthCheck').mockResolvedValue(false);
    const healthField = createSchema().getQueryType()?.getFields()._health;

    await expect(healthField?.resolve?.({}, {}, { repository }, {} as never)).resolves.toMatchObject({
      ok: false,
      genesisHash: SORA_MAINNET_GENESIS_HASH,
      latestIndexedBlock: CHECKPOINT_BLOCK,
    });
  });
});
