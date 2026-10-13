import { graphql } from 'graphql';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { currentCheckpointView } from '../src/graphql/checkpoint-view.js';
import { createMaterializationBudgetedRepository } from '../src/graphql/materialization-budget.js';
import { createSchema } from '../src/graphql/resolvers.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { SORA_LEGACY_IDENTITY_ANCHOR, SORA_MAINNET_GENESIS_HASH } from '../src/soraIdentity.js';
import { createPersistedWorkerStatusDocument } from '../src/worker/status.js';

import type { IndexerDocument } from '../src/repository/types.js';

const NOW = 2_000_000_000;
const HEIGHT = 30_000_000;
const HASH = `0x${'ab'.repeat(32)}`;
const OTHER_HASH = `0x${'cd'.repeat(32)}`;
const identity: IndexerDocument = {
  collection: 'updatesStreams', id: 'chainIdentity',
  blockHeight: SORA_LEGACY_IDENTITY_ANCHOR.block,
  timestamp: SORA_LEGACY_IDENTITY_ANCHOR.timestamp,
  data: {
    id: 'chainIdentity', block: SORA_LEGACY_IDENTITY_ANCHOR.block,
    data: JSON.stringify({
      schemaVersion: 1, genesisHash: SORA_MAINNET_GENESIS_HASH,
      verificationBlock: SORA_LEGACY_IDENTITY_ANCHOR.block,
      verificationBlockHash: SORA_LEGACY_IDENTITY_ANCHOR.hash,
      verificationBlockTimestamp: SORA_LEGACY_IDENTITY_ANCHOR.timestamp,
      migration: 'fresh-database',
    }),
  },
};
const checkpoint = (height: number, hash = HASH, workerHeight = height): IndexerDocument[] => {
  const timestamp = NOW - 10 + height - HEIGHT;
  return [
    identity,
    {
      collection: 'updatesStreams', id: 'chainState', blockHeight: height, timestamp,
      data: { id: 'chainState', block: height, data: JSON.stringify({
        lastIndexedBlock: height, genesisHash: SORA_MAINNET_GENESIS_HASH,
        blockHash: hash, blockTimestamp: timestamp,
      }) },
    },
    {
      collection: 'networkSnapshots', id: `block-${height}`, blockHeight: height, timestamp,
      data: { id: `block-${height}`, type: 'BLOCK', timestamp },
    },
    createPersistedWorkerStatusDocument({
      lifecycle: 'running', startupComplete: true,
      latestFinalizedBlock: workerHeight, latestIndexedBlock: workerHeight, lag: 0,
      lastSuccessfulIndexTimestamp: NOW, lastError: null, lastErrorTimestamp: null,
    }, NOW),
  ];
};
const query = `{
  _health { ok workerLatestIndexedBlock latestIndexedBlock latestIndexedBlockHash latestIndexedAt }
  chainState: updatesStream(id: "chainState") { id block data }
  networkSnapshots(first: 1, orderBy: ["TIMESTAMP_DESC"], filter: {type: {equalTo: "BLOCK"}}) {
    nodes { id type timestamp } totalCount pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
  }
}`;
const setup = async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW * 1_000);
  const repository = new MemoryRepository();
  await repository.upsertMany(checkpoint(HEIGHT));
  const schema = createSchema();
  const execute = (source = query) => graphql({ schema, source, contextValue: {
    repository: createMaterializationBudgetedRepository(repository, 64 * 1_024 * 1_024).repository,
  } });
  return { repository, execute };
};
const expectTuple = (data: Awaited<ReturnType<typeof graphql>>['data'], height: number, hash = HASH) => {
  expect(data?._health).toMatchObject({ ok: true, latestIndexedBlock: height, workerLatestIndexedBlock: height, latestIndexedBlockHash: hash });
  const state = data?.chainState as { block: number; data: string };
  expect(state.block).toBe(height);
  expect(JSON.parse(state.data)).toMatchObject({ lastIndexedBlock: height, blockHash: hash });
  expect(data?.networkSnapshots).toMatchObject({ nodes: [{ id: `block-${height}`, type: 'BLOCK', timestamp: NOW - 10 + height - HEIGHT }] });
};

describe('request checkpoint view', () => {
  afterEach(() => vi.restoreAllMocks());

  it('bypasses warm chainState and latest BLOCK TTL entries without relaxing equality', async () => {
    const { repository, execute } = await setup();
    expectTuple((await execute()).data, HEIGHT);
    await repository.upsertMany(checkpoint(HEIGHT + 1));
    const fresh = await execute();
    expect(fresh.errors).toBeUndefined();
    expectTuple(fresh.data, HEIGHT + 1);
    expect(fresh.data?.networkSnapshots).toMatchObject({ totalCount: 2, pageInfo: { hasNextPage: true, hasPreviousPage: false } });
  });

  it('retries a proven commit between serialized reads and returns one exact tuple', async () => {
    const { repository, execute } = await setup();
    const original = repository.query.bind(repository);
    let calls = 0;
    vi.spyOn(repository, 'query').mockImplementation(async (collection, args) => {
      const result = await original(collection, args);
      if (++calls === 1) await repository.upsertMany(checkpoint(HEIGHT + 1));
      return result;
    });
    const result = await execute();
    expect(result.errors).toBeUndefined();
    expectTuple(result.data, HEIGHT + 1);
    expect(calls).toBe(2);
  });

  it('fences the entire state document, including a changed hash at the same height', async () => {
    const { repository, execute } = await setup();
    const original = repository.query.bind(repository);
    let calls = 0;
    vi.spyOn(repository, 'query').mockImplementation(async (collection, args) => {
      const result = await original(collection, args);
      if (++calls === 1) await repository.upsertMany(checkpoint(HEIGHT, OTHER_HASH));
      return result;
    });
    expectTuple((await execute()).data, HEIGHT, OTHER_HASH);
    expect(calls).toBe(2);
  });

  it('fails after three moving fences instead of silently retrying indefinitely', async () => {
    const { repository, execute } = await setup();
    const original = repository.query.bind(repository);
    let calls = 0;
    vi.spyOn(repository, 'query').mockImplementation(async (collection, args) => {
      const result = await original(collection, args);
      await repository.upsertMany(checkpoint(HEIGHT + ++calls));
      return result;
    });
    const result = await execute();
    expect(result.errors?.some((error) => error.extensions.code === 'CHECKPOINT_VIEW_UNAVAILABLE')).toBe(true);
    expect(calls).toBe(3);
  });

  it('preserves a persistent worker/state mismatch as unhealthy without retries or invented heights', async () => {
    const { repository, execute } = await setup();
    await repository.upsertMany(checkpoint(HEIGHT, HASH, HEIGHT + 1));
    const read = vi.spyOn(repository, 'query');
    const result = await execute();
    expect(result.errors).toBeUndefined();
    expect(result.data?._health).toMatchObject({ ok: false, latestIndexedBlock: HEIGHT, workerLatestIndexedBlock: HEIGHT + 1 });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('rejects a persistent latest BLOCK mismatch without replacing it with the state height', async () => {
    const { repository, execute } = await setup();
    await repository.upsertMany(checkpoint(HEIGHT + 1).filter((document) => document.collection === 'networkSnapshots'));
    const read = vi.spyOn(repository, 'query');
    const result = await execute();
    expect(result.errors?.some((error) => error.extensions.code === 'CHECKPOINT_VIEW_INCONSISTENT')).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each(['missing', 'wrong-height', 'wrong-envelope'] as const)(
    'keeps health-only requests unhealthy for a %s persisted BLOCK', async (kind) => {
      const { repository, execute } = await setup();
      if (kind === 'missing') await repository.deleteMany('networkSnapshots', [`block-${HEIGHT}`]);
      if (kind === 'wrong-height') {
        await repository.upsertMany(checkpoint(HEIGHT + 1).filter((row) => row.collection === 'networkSnapshots'));
      }
      if (kind === 'wrong-envelope') {
        const read = repository.query.bind(repository);
        vi.spyOn(repository, 'query').mockImplementation(async (collection, args) => {
          const result = await read(collection, args);
          result.items[0]!.blockHeight = HEIGHT + 1;
          return result;
        });
      }
      const result = await execute('{_health{ok latestIndexedBlock workerLatestIndexedBlock}}');
      expect(result.errors).toBeUndefined();
      expect(result.data?._health).toMatchObject({ ok: false, latestIndexedBlock: HEIGHT, workerLatestIndexedBlock: HEIGHT });
    }
  );

  it('fences the live in-memory worker provider used by the combined service', async () => {
    const { repository } = await setup();
    const persisted = checkpoint(HEIGHT).at(-1)!.data.status;
    let status = structuredClone(persisted) as import('../src/worker/status.js').ChainIndexerStatus;
    const read = repository.query.bind(repository);
    let calls = 0;
    vi.spyOn(repository, 'query').mockImplementation(async (collection, args) => {
      const result = await read(collection, args);
      if (++calls === 1) status = { ...status, latestFinalizedBlock: HEIGHT + 1, lag: 1 };
      return result;
    });
    const result = await graphql({ schema: createSchema(), source: query, contextValue: {
      repository: createMaterializationBudgetedRepository(repository, 64 * 1_024 * 1_024).repository,
      workerStatusProvider: { getStatus: () => status },
    } });
    expect(result.errors).toBeUndefined();
    expectTuple(result.data, HEIGHT);
    expect(calls).toBe(2);
  });

  it('shares one capture across reverse field order and aliases', async () => {
    const { repository, execute } = await setup();
    const read = vi.spyOn(repository, 'query');
    const result = await execute(`{
      networkSnapshots(first:1,orderBy:["TIMESTAMP_DESC"],filter:{type:{equalTo:"BLOCK"}}){nodes{id type timestamp}}
      chainState: updatesStream(id:"chainState"){id block data}
      repeated: updatesStream(id:"chainState"){id block data}
      _health {ok workerLatestIndexedBlock latestIndexedBlock latestIndexedBlockHash latestIndexedAt}
    }`);
    expectTuple(result.data, HEIGHT);
    expect(result.data?.repeated).toEqual(result.data?.chainState);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('charges all retry reads against the existing aggregate materialization budget', async () => {
    const { repository } = await setup();
    const bounded = createMaterializationBudgetedRepository(repository, 100);
    await expect(currentCheckpointView({ repository: bounded.repository })).rejects.toMatchObject({
      extensions: { code: 'GRAPHQL_EXECUTION_MEMORY_LIMIT_EXCEEDED' },
    });
    expect(bounded.budget.usedBytes).toBe(100);
  });

  it('preserves unrelated historical connection cache behavior', async () => {
    const { repository, execute } = await setup();
    const history = '{ networkSnapshots(first:2,orderBy:["TIMESTAMP_DESC"],filter:{type:{equalTo:"BLOCK"}}){nodes{id}} }';
    const before = await execute(history);
    await repository.upsertMany(checkpoint(HEIGHT + 1));
    expect((await execute(history)).data).toEqual(before.data);
  });
});
