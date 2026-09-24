import { describe, expect, it, vi } from 'vitest';
import { graphql } from 'graphql';
import { decodeAddress, encodeAddress } from '@polkadot/util-crypto';
import { isExcludedTonswapBurnAccount, SORA_TRUST_BURN_ADDRESS } from '../src/tonswap-burn.js';

import { createSchema } from '../src/graphql/resolvers.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { SORA_LEGACY_IDENTITY_ANCHOR, SORA_MAINNET_GENESIS_HASH } from '../src/soraIdentity.js';
import { createTonswapBurnCoverage, isTonswapBurnRemark, parseTonswapBurnCoverage, TONSWAP_START_BLOCK } from '../src/tonswap-burn.js';

type SnapshotResult = { fresh: boolean; nodes: unknown[]; indexedThroughBlock: number; pageInfo: { hasNextPage: boolean; endCursor: string | null } };

const hash = `0x${'ab'.repeat(32)}`;
const marker = JSON.stringify({ app: 'polkaswap', kind: 'tonswap-xor-burn', version: 1 });

/** Seeds coherent finalized identity and dedicated campaign coverage without external services. */
const contextFixture = async (age = 0) => {
  const repository = new MemoryRepository();
  const now = Math.floor(Date.now() / 1_000) - age;
  const block = TONSWAP_START_BLOCK + 2;
  await repository.upsertMany([
    {
      collection: 'updatesStreams', id: 'chainIdentity', blockHeight: SORA_LEGACY_IDENTITY_ANCHOR.block,
      timestamp: SORA_LEGACY_IDENTITY_ANCHOR.timestamp,
      data: { id: 'chainIdentity', block: SORA_LEGACY_IDENTITY_ANCHOR.block, data: JSON.stringify({
        schemaVersion: 1, genesisHash: SORA_MAINNET_GENESIS_HASH,
        verificationBlock: SORA_LEGACY_IDENTITY_ANCHOR.block,
        verificationBlockHash: SORA_LEGACY_IDENTITY_ANCHOR.hash,
        verificationBlockTimestamp: SORA_LEGACY_IDENTITY_ANCHOR.timestamp, migration: 'fresh-database',
      }) },
    },
    {
      collection: 'updatesStreams', id: 'chainState', blockHeight: block, timestamp: now,
      data: { id: 'chainState', block, data: JSON.stringify({
        lastIndexedBlock: block, genesisHash: SORA_MAINNET_GENESIS_HASH, blockHash: hash, blockTimestamp: now,
      }) },
    },
    createTonswapBurnCoverage(block, hash, now),
  ]);
  return {
    repository,
    workerStatusProvider: { getStatus: () => ({
      lifecycle: 'running' as const, startupComplete: true,
      latestFinalizedBlock: block, latestIndexedBlock: block, lag: 0,
      lastSuccessfulIndexTimestamp: now, lastError: null, lastErrorTimestamp: null,
    }) },
  };
};

describe('TONSWAP protocol and finalized snapshots', () => {
  it('recognizes only the exact destination-free marker', () => {
    expect(isTonswapBurnRemark(marker)).toBe(true);
    expect(isTonswapBurnRemark(`0x${Buffer.from(marker).toString('hex')}`)).toBe(true);
    for (const value of ['', '{}', '[]', '{', marker.replace('1', '2'), marker.replace('polkaswap', 'other'),
      JSON.stringify({ ...JSON.parse(marker), recipient: 'destination' })]) {
      expect(isTonswapBurnRemark(value)).toBe(false);
    }
  });

  it('validates the coverage envelope and chain identity', () => {
    const document = createTonswapBurnCoverage(TONSWAP_START_BLOCK, hash, 1_800_000_000);
    expect(parseTonswapBurnCoverage(document)?.indexedThroughBlock).toBe(TONSWAP_START_BLOCK);
    expect(parseTonswapBurnCoverage(null)).toBeNull();
    expect(parseTonswapBurnCoverage({ ...document, blockHeight: TONSWAP_START_BLOCK + 1 })).toBeNull();
    expect(parseTonswapBurnCoverage({ ...document, data: { ...document.data, data: '{}' } })).toBeNull();
  });

  it('paginates through non-campaign rows without counting them and freezes the snapshot block', async () => {
    const context = await contextFixture();
    await context.repository.upsertMany([
      { collection: 'xorBurns', id: 'a', blockHeight: TONSWAP_START_BLOCK,
        data: { id: 'a', address: 'alice', amount: '1', blockHeight: TONSWAP_START_BLOCK } },
      { collection: 'xorBurns', id: 'b', blockHeight: TONSWAP_START_BLOCK + 1,
        data: { id: 'b', address: 'bob', amount: '2', blockHeight: TONSWAP_START_BLOCK + 1,
          campaign: 'tonswap', extrinsicIndex: 1, txHash: hash } },
    ]);
    const resolver = createSchema().getQueryType()!.getFields().tonswapBurnSnapshot.resolve!;
    const first = await resolver({}, { first: 1 }, context, undefined as never) as SnapshotResult;
    expect(first.nodes).toEqual([]);
    expect(first.pageInfo.hasNextPage).toBe(true);
    expect(first.pageInfo.endCursor).toBeTruthy();
    const second = await resolver({}, {
      first: 1, after: first.pageInfo.endCursor, atBlock: first.indexedThroughBlock,
    }, context, undefined as never) as SnapshotResult;
    expect(second.nodes).toEqual([expect.objectContaining({ id: 'b', campaign: 'tonswap', extrinsicIndex: 1 })]);
    expect(second.pageInfo.hasNextPage).toBe(false);
    expect(second.indexedThroughBlock).toBe(first.indexedThroughBlock);
    const earlier = await resolver({}, { atBlock: TONSWAP_START_BLOCK }, context, undefined as never) as SnapshotResult;
    expect(earlier.nodes).toEqual([]);
  });

  it('fails closed for stale, missing, incomplete, and future coverage', async () => {
    const resolver = createSchema().getQueryType()!.getFields().tonswapBurnSnapshot.resolve!;
    await expect(resolver({}, {}, await contextFixture(90), undefined as never)).rejects.toThrow('coverage is unavailable');
    const context = await contextFixture();
    await expect(resolver({}, { atBlock: TONSWAP_START_BLOCK + 3 }, context, undefined as never)).rejects.toThrow('snapshot block');
    await context.repository.deleteMany('updatesStreams', ['tonswapBurnCoverage-v1']);
    await expect(resolver({}, {}, context, undefined as never)).rejects.toThrow('coverage is unavailable');
    await context.repository.upsert(createTonswapBurnCoverage(TONSWAP_START_BLOCK + 1, hash, Math.floor(Date.now() / 1_000)));
    await expect(resolver({}, {}, context, undefined as never)).rejects.toThrow('coverage is unavailable');
  });
  it('serves the campaign snapshot through the public GraphQL field', async () => {
    const result = await graphql({ schema: createSchema(), contextValue: await contextFixture(),
      source: '{ tonswapBurnSnapshot(first: 100) { fresh genesisHash startBlock indexedThroughBlock nodes { campaign extrinsicIndex } pageInfo { hasNextPage endCursor } } }' });
    expect(result.errors).toBeUndefined();
    expect(result.data?.tonswapBurnSnapshot).toMatchObject({ fresh: true, startBlock: TONSWAP_START_BLOCK, nodes: [] });
  });

  it('excludes SORA Trust by decoded AccountId32 across SS58 and hex encodings', () => {
    const trustKey = decodeAddress(SORA_TRUST_BURN_ADDRESS);
    const trustHex = `0x${Buffer.from(trustKey).toString('hex')}`;
    expect(trustHex).toBe('0x12bed8da37e42af92986e9c0988b588da0e23422c287aa81a4bec9bb1e82db02');
    for (const address of [SORA_TRUST_BURN_ADDRESS, encodeAddress(trustKey, 0), encodeAddress(trustKey, 42),
      trustHex, `0x${trustHex.slice(2).toUpperCase()}`, ` ${SORA_TRUST_BURN_ADDRESS} `]) {
      expect(isExcludedTonswapBurnAccount(address)).toBe(true);
    }
    expect(isExcludedTonswapBurnAccount(encodeAddress(new Uint8Array(32).fill(1), 69))).toBe(false);
    for (const invalid of [undefined, null, '', 'alice', '0x12', 'x'.repeat(129)]) {
      expect(isExcludedTonswapBurnAccount(invalid)).toBe(false);
    }
  });

  it('advances over Trust-only pages without deleting raw burns or changing finalized coverage', async () => {
    const context = await contextFixture();
    const trustKey = decodeAddress(SORA_TRUST_BURN_ADDRESS);
    const trustForms = [SORA_TRUST_BURN_ADDRESS, encodeAddress(trustKey, 42), `0x${Buffer.from(trustKey).toString('hex')}`];
    const records = [...trustForms, encodeAddress(new Uint8Array(32).fill(1), 69)].map((address, index) => ({
      collection: 'xorBurns' as const, id: `trust-filter-${index}`, blockHeight: TONSWAP_START_BLOCK + 1,
      data: { id: `trust-filter-${index}`, address, amount: index < 3 ? '1753357' : '1',
        blockHeight: TONSWAP_START_BLOCK + 1, campaign: 'tonswap', extrinsicIndex: index, txHash: `0x${String(index + 1).repeat(64)}` },
    }));
    await context.repository.upsertMany(records);
    const coverageBefore = await context.repository.get('updatesStreams', 'tonswapBurnCoverage-v1');
    const schema = createSchema();
    const resolver = schema.getQueryType()!.getFields().tonswapBurnSnapshot.resolve!;
    let after: string | null = null;
    let through: number | undefined;
    const seen = new Set<string>();
    for (let index = 0; index < records.length; index += 1) {
      const result = await resolver({}, { first: 1, after, atBlock: through }, context, undefined as never) as SnapshotResult;
      through ??= result.indexedThroughBlock;
      expect(result.indexedThroughBlock).toBe(through);
      expect(result.nodes).toEqual(index < 3 ? [] : [expect.objectContaining({ id: 'trust-filter-3', amount: '1' })]);
      expect(result.pageInfo.hasNextPage).toBe(index < records.length - 1);
      expect(result.pageInfo.endCursor).toBeTruthy();
      expect(seen.has(result.pageInfo.endCursor!)).toBe(false);
      seen.add(result.pageInfo.endCursor!);
      after = result.pageInfo.endCursor;
    }
    const raw = await graphql({ schema, contextValue: context,
      source: '{ xorBurns(first: 100, orderBy: [ID_ASC]) { nodes { id address amount campaign } } }' });
    expect(raw.errors).toBeUndefined();
    expect((raw.data?.xorBurns as { nodes: unknown[] }).nodes).toHaveLength(4);
    expect(await context.repository.list('xorBurns')).toEqual(records);
    expect(await context.repository.get('updatesStreams', 'tonswapBurnCoverage-v1')).toEqual(coverageBefore);
  });

  it.each([90, 3_600])('only opts into complete historical snapshots aged %i seconds', async (age) => {
    const context = await contextFixture(age);
    const schema = createSchema();
    const resolver = schema.getQueryType()!.getFields().tonswapBurnSnapshot.resolve!;
    for (const args of [{}, { allowStale: false }, { allowStale: null }]) {
      await expect(resolver({}, args, context, undefined as never)).rejects.toThrow('coverage is unavailable');
    }
    const result = await graphql({ schema, contextValue: context,
      source: '{ tonswapBurnSnapshot(allowStale: true) { fresh indexedThroughBlock checkpointBlock checkpointTimestamp nodes { id } } }' });
    expect(result.errors).toBeUndefined();
    expect(result.data?.tonswapBurnSnapshot).toMatchObject({ fresh: false,
      indexedThroughBlock: TONSWAP_START_BLOCK + 2, checkpointBlock: TONSWAP_START_BLOCK + 2, nodes: [] });
  });

  it('keeps worker readiness and excessive lag separate from complete historical evidence', async () => {
    const context = await contextFixture();
    const status = context.workerStatusProvider.getStatus();
    const resolver = createSchema().getQueryType()!.getFields().tonswapBurnSnapshot.resolve!;
    for (const workerStatusProvider of [undefined,
      { getStatus: () => ({ ...status, startupComplete: false }) },
      { getStatus: () => ({ ...status, latestFinalizedBlock: status.latestFinalizedBlock + 3, lag: 3 }) },
      { getStatus: () => ({ ...status, latestIndexedBlock: status.latestIndexedBlock - 1, lag: 1 }) }]) {
      const unavailable = { ...context, workerStatusProvider };
      await expect(resolver({}, {}, unavailable, undefined as never)).rejects.toThrow('coverage is unavailable');
      expect(await resolver({}, { allowStale: true }, unavailable, undefined as never)).toMatchObject({ fresh: false });
    }
    expect(await resolver({}, { allowStale: true }, context, undefined as never)).toMatchObject({ fresh: true });
  });

  it('never serves an unreadable repository, even with valid historical proof', async () => {
    const context = await contextFixture(3_600);
    vi.spyOn(context.repository, 'healthCheck').mockResolvedValue(false);
    const resolver = createSchema().getQueryType()!.getFields().tonswapBurnSnapshot.resolve!;
    await expect(resolver({}, { allowStale: true }, context, undefined as never)).rejects.toThrow('coverage is unavailable');
  });

  it('still rejects incomplete or mismatched coverage and future timestamps in display mode', async () => {
    const resolver = createSchema().getQueryType()!.getFields().tonswapBurnSnapshot.resolve!;
    for (const mutation of ['missing', 'incomplete', 'genesis', 'hash', 'timestamp', 'envelope', 'checkpoint']) {
      const context = await contextFixture(3_600);
      const document = (await context.repository.get('updatesStreams', 'tonswapBurnCoverage-v1'))!;
      const value = JSON.parse(document.data.data as string);
      if (mutation === 'missing') await context.repository.deleteMany('updatesStreams', [document.id]);
      else if (mutation === 'checkpoint') await context.repository.deleteMany('updatesStreams', ['chainState']);
      else {
        if (mutation === 'incomplete') value.indexedThroughBlock -= 1;
        if (mutation === 'genesis') value.genesisHash = `0x${'cd'.repeat(32)}`;
        if (mutation === 'hash') value.blockHash = `0x${'0'.repeat(64)}`;
        if (mutation === 'timestamp') value.blockTimestamp = 0;
        if (mutation === 'envelope') document.blockHeight = TONSWAP_START_BLOCK;
        if (mutation === 'envelope') {
          const originalGet = context.repository.get.bind(context.repository);
          vi.spyOn(context.repository, 'get').mockImplementation(async (collection, id) =>
            id === document.id ? document : originalGet(collection, id));
        } else await context.repository.upsert({ ...document, data: { ...document.data, data: JSON.stringify(value) } });
      }
      await expect(resolver({}, { allowStale: true }, context, undefined as never)).rejects.toThrow('coverage is unavailable');
    }
    await expect(resolver({}, { allowStale: true }, await contextFixture(-120), undefined as never))
      .rejects.toThrow('coverage is unavailable');
  });

  it('retries a checkpoint read that straddles one atomic finalized commit', async () => {
    const context = await contextFixture(3_600);
    const originalGet = context.repository.get.bind(context.repository);
    let coverageReads = 0;
    vi.spyOn(context.repository, 'get').mockImplementation(async (collection, id) => {
      if (id === 'tonswapBurnCoverage-v1' && ++coverageReads === 1) {
        return createTonswapBurnCoverage(TONSWAP_START_BLOCK + 1, hash, Math.floor(Date.now() / 1_000) - 3_600);
      }
      return originalGet(collection, id);
    });
    const resolver = createSchema().getQueryType()!.getFields().tonswapBurnSnapshot.resolve!;
    expect(await resolver({}, { allowStale: true }, context, undefined as never))
      .toMatchObject({ fresh: false, indexedThroughBlock: TONSWAP_START_BLOCK + 2 });
    expect(coverageReads).toBe(2);
  });

  it('keeps historical pagination frozen and ordered across empty unrelated pages', async () => {
    const context = await contextFixture(3_600);
    const block = TONSWAP_START_BLOCK + 1;
    await context.repository.upsertMany([
      { collection: 'xorBurns', id: 'a', blockHeight: block,
        data: { id: 'a', address: 'alice', amount: '1', blockHeight: block, campaign: 'tonswap', extrinsicIndex: 0, txHash: hash } },
      { collection: 'xorBurns', id: 'b', blockHeight: block,
        data: { id: 'b', address: 'alice', amount: '9', blockHeight: block } },
      { collection: 'xorBurns', id: 'c', blockHeight: block,
        data: { id: 'c', address: 'bob', amount: '2', blockHeight: block, campaign: 'tonswap', extrinsicIndex: 1, txHash: `0x${'cd'.repeat(32)}` } },
    ]);
    const resolver = createSchema().getQueryType()!.getFields().tonswapBurnSnapshot.resolve!;
    let after: string | null = null;
    for (const expectedId of ['a', null, 'c']) {
      const page = await resolver({}, { first: 1, after, atBlock: block, allowStale: true }, context, undefined as never) as SnapshotResult;
      expect(page.fresh).toBe(false);
      expect(page.indexedThroughBlock).toBe(block);
      expect(page.nodes).toEqual(expectedId ? [expect.objectContaining({ id: expectedId })] : []);
      expect(page.pageInfo.endCursor).not.toBe(after);
      expect(page.pageInfo.hasNextPage).toBe(expectedId !== 'c');
      after = page.pageInfo.endCursor;
    }
    await expect(resolver({}, { first: 1, after, allowStale: true }, context, undefined as never)).rejects.toThrow('snapshot block');
  });

  it('preserves strict mainnet identity and hash/timestamp checkpoint coherence in display mode', async () => {
    const resolver = createSchema().getQueryType()!.getFields().tonswapBurnSnapshot.resolve!;
    for (const mutation of ['identity', 'genesis', 'hash', 'timestamp', 'envelope']) {
      const context = await contextFixture(3_600);
      if (mutation === 'identity') await context.repository.deleteMany('updatesStreams', ['chainIdentity']);
      else {
        const document = (await context.repository.get('updatesStreams', 'chainState'))!;
        const value = JSON.parse(document.data.data as string);
        if (mutation === 'genesis') value.genesisHash = `0x${'cd'.repeat(32)}`;
        if (mutation === 'hash') value.blockHash = `0x${'cd'.repeat(32)}`;
        if (mutation === 'timestamp') value.blockTimestamp -= 1;
        if (mutation === 'envelope') document.data.id = 'other';
        if (mutation === 'envelope') {
          const originalGet = context.repository.get.bind(context.repository);
          vi.spyOn(context.repository, 'get').mockImplementation(async (collection, id) =>
            id === document.id ? document : originalGet(collection, id));
        } else await context.repository.upsert({ ...document, data: { ...document.data, data: JSON.stringify(value) } });
      }
      await expect(resolver({}, { allowStale: true }, context, undefined as never)).rejects.toThrow('coverage is unavailable');
    }
  });

});
