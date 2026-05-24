import { describe, expect, it, vi } from 'vitest';
import type { GraphQLResolveInfo } from 'graphql';

import { createSchema } from '../src/graphql/resolvers.js';
import { MemoryRepository } from '../src/repository/memory.js';

import type { IndexerRepository, RepositoryQueryArgs } from '../src/repository/types.js';

type QueryFunction = NonNullable<IndexerRepository['query']>;

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const ss58FixtureAccount = (index: number): string => {
  let value = index + 1;
  let encoded = '';

  while (value > 0) {
    encoded = BASE58_ALPHABET[value % BASE58_ALPHABET.length] + encoded;
    value = Math.floor(value / BASE58_ALPHABET.length);
  }

  return encoded.padStart(48, '1');
};

const completedAccountActivityBackfillData = JSON.stringify({
  processedDocuments: 1,
  writtenDocuments: 1,
  lastIndexedBlock: 1,
  lastTimestamp: 1,
});

const repositoryWithQuery = (query: QueryFunction): IndexerRepository => ({
  list: async () => [],
  query,
  get: async () => null,
  getMany: async () => new Map(),
  upsert: async () => undefined,
  upsertMany: async () => undefined,
  deleteMany: async () => undefined,
  close: async () => undefined,
});

const repositoryWithoutQuery = (items: Awaited<ReturnType<IndexerRepository['list']>>): IndexerRepository => ({
  list: async (collection) => items.filter((item) => item.collection === collection),
  get: async () => null,
  getMany: async () => new Map(),
  upsert: async () => undefined,
  upsertMany: async () => undefined,
  deleteMany: async () => undefined,
  close: async () => undefined,
});

describe('Polkaswap indexer schema', () => {
  it('exposes a repository-backed health resolver', async () => {
    const schema = createSchema();
    const healthField = schema.getQueryType()?.getFields()._health;

    await expect(healthField?.resolve?.({}, {}, { repository: new MemoryRepository() }, {} as never)).resolves.toEqual({
      ok: true,
      service: 'polkaswap-indexer',
    });
  });

  it('reports unhealthy when the repository health check fails', async () => {
    const schema = createSchema();
    const healthField = schema.getQueryType()?.getFields()._health;
    const repository = {
      ...repositoryWithoutQuery([]),
      healthCheck: async () => false,
    };

    await expect(healthField?.resolve?.({}, {}, { repository }, {} as never)).resolves.toEqual({
      ok: false,
      service: 'polkaswap-indexer',
    });
  });

  it('exposes Polkamarkt market and market orderbook data', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([
      {
        collection: 'markets',
        id: '3',
        timestamp: 200,
        data: {
          id: '3',
          marketId: 3,
          title: 'Will KUSD stay at peg?',
          volumeUSD: '250',
          governancePallet: 'democracy',
          governanceBody: 'Democracy',
          governanceKind: 'Referendum',
          governanceReferendumIndex: 124,
        },
      },
      {
        collection: 'marketOrderbooks',
        id: '3',
        timestamp: 200,
        data: {
          id: '3',
          marketId: 3,
          bids: [{ price: 0.59, quantity: 100 }],
          asks: [{ price: 0.61, quantity: 80 }],
        },
      },
    ]);
    const schema = createSchema();
    const marketsField = schema.getQueryType()?.getFields().markets;
    const marketOrderbookField = schema.getQueryType()?.getFields().marketOrderbook;

    const markets = await marketsField?.resolve?.(
      {},
      { first: 10, orderBy: ['VOLUME_USD_DESC'] },
      { repository },
      {} as GraphQLResolveInfo
    );
    const orderbook = await marketOrderbookField?.resolve?.({}, { marketId: 3 }, { repository }, {} as never);

    expect(markets).toMatchObject({
      edges: [
        {
          node: {
            id: '3',
            marketId: 3,
            title: 'Will KUSD stay at peg?',
            volumeUSD: '250',
            governancePallet: 'democracy',
            governanceBody: 'Democracy',
            governanceKind: 'Referendum',
            governanceReferendumIndex: 124,
          },
        },
      ],
      totalCount: 1,
    });
    expect(orderbook).toMatchObject({
      id: '3',
      marketId: 3,
      bids: [{ price: 0.59, quantity: 100 }],
      asks: [{ price: 0.61, quantity: 80 }],
    });
  });

  it('serves mobile app config for SORA iOS', async () => {
    const schema = createSchema();
    const mobileConfigField = schema.getQueryType()?.getFields().mobileConfig;

    expect(mobileConfigField?.resolve?.({}, {}, { repository: new MemoryRepository() }, {} as never)).toEqual({
      blockExplorerUrl: 'https://sorametrics.org/sorav2?tab=extrinsics&q={transaction}',
      substrateTypesUrl:
        'https://raw.githubusercontent.com/sora-xor/sora2-substrate-js-library/metadata14ios/packages/types/src/metadata/prod/types_scalecodec_mobile.json',
      soracard: false,
      nodes: [{ name: 'Sora', address: 'wss://mof2.sora.org' }],
    });
  });

  it('derives Explore stats from active market documents and the latest day network snapshot', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([
      {
        collection: 'assets',
        id: 'asset-a',
        data: { id: 'asset-a', liquidity: '10', liquidityBooks: '0' },
      },
      {
        collection: 'assets',
        id: 'asset-b',
        data: { id: 'asset-b', liquidity: '0', liquidityBooks: '5' },
      },
      {
        collection: 'assets',
        id: 'asset-c',
        data: { id: 'asset-c', liquidity: '0', liquidityBooks: '0' },
      },
      {
        collection: 'poolXYKs',
        id: 'pool-a',
        data: { id: 'pool-a', baseAssetReserves: '1', targetAssetReserves: '2' },
      },
      {
        collection: 'poolXYKs',
        id: 'pool-b',
        data: { id: 'pool-b', baseAssetReserves: '0', targetAssetReserves: '2' },
      },
      {
        collection: 'orderBooks',
        id: 'book-a',
        data: { id: 'book-a' },
      },
      {
        collection: 'networkSnapshots',
        id: 'network-old',
        timestamp: 100,
        data: { id: 'network-old', type: 'DAY', timestamp: 100, liquidityUSD: '100.25', volumeUSD: '10.5' },
      },
      {
        collection: 'networkSnapshots',
        id: 'network-latest',
        timestamp: 200,
        data: { id: 'network-latest', type: 'DAY', timestamp: 200, liquidityUSD: '250.75', volumeUSD: '45.125' },
      },
    ]);

    const schema = createSchema();
    const exploreStatsField = schema.getQueryType()?.getFields().exploreStats;

    await expect(exploreStatsField?.resolve?.({}, {}, { repository }, {} as never)).resolves.toEqual({
      id: 'global',
      tokenCount: 2,
      poolCount: 1,
      orderBookCount: 1,
      liquidityUSD: '250.75',
      volumeDayUSD: '45.125',
      updatedAtTimestamp: 200,
    });
  });

  it('serves the stats page GraphQL data from network snapshots', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([
      {
        collection: 'assets',
        id: 'asset-a',
        data: { id: 'asset-a', liquidity: '10', liquidityBooks: '0' },
      },
      {
        collection: 'assets',
        id: 'asset-b',
        data: { id: 'asset-b', liquidity: '0', liquidityBooks: '5' },
      },
      {
        collection: 'assets',
        id: 'asset-c',
        data: { id: 'asset-c', liquidity: '0', liquidityBooks: '0' },
      },
      {
        collection: 'poolXYKs',
        id: 'pool-a',
        data: { id: 'pool-a', baseAssetReserves: '1', targetAssetReserves: '2' },
      },
      {
        collection: 'orderBooks',
        id: 'book-a',
        data: { id: 'book-a' },
      },
      {
        collection: 'networkSnapshots',
        id: 'network-day-old',
        timestamp: 100,
        data: {
          id: 'network-day-old',
          type: 'DAY',
          timestamp: 100,
          liquidityUSD: '100.25',
          volumeUSD: '10.5',
        },
      },
      {
        collection: 'networkSnapshots',
        id: 'network-hour',
        timestamp: 150,
        data: {
          id: 'network-hour',
          type: 'HOUR',
          timestamp: 150,
          accounts: 20,
          transactions: 30,
          fees: '123456789',
          liquidityUSD: '250.75',
          poolLiquidityUSD: '200.5',
          orderBookLiquidityUSD: '50.25',
          volumeUSD: '45.125',
          swaps: 7,
          activePools: 4,
          activeOrderBooks: 3,
          listedAssets: 9,
          bridgeIncomingTransactions: 1,
          bridgeOutgoingTransactions: 2,
        },
      },
    ]);

    const schema = createSchema();
    const exploreStatsField = schema.getQueryType()?.getFields().exploreStats;
    const networkSnapshotsField = schema.getQueryType()?.getFields().networkSnapshots;
    const exploreStats = await exploreStatsField?.resolve?.({}, {}, { repository }, {} as never);
    const networkSnapshots = await networkSnapshotsField?.resolve?.(
      {},
      {
        first: 10,
        orderBy: ['TIMESTAMP_DESC'],
        filter: {
          type: { equalTo: 'HOUR' },
          timestamp: { lessThanOrEqualTo: 200, greaterThanOrEqualTo: 120 },
        },
      },
      { repository },
      {} as never
    );

    expect(exploreStats).toEqual({
      id: 'global',
      tokenCount: 2,
      poolCount: 1,
      orderBookCount: 1,
      liquidityUSD: '100.25',
      volumeDayUSD: '10.5',
      updatedAtTimestamp: 100,
    });
    expect(networkSnapshots).toMatchObject({
      edges: [
        {
          cursor: '0',
          node: {
            id: 'network-hour',
            type: 'HOUR',
            timestamp: 150,
            accounts: 20,
            transactions: 30,
            fees: '123456789',
            liquidityUSD: '250.75',
            poolLiquidityUSD: '200.5',
            orderBookLiquidityUSD: '50.25',
            volumeUSD: '45.125',
            swaps: 7,
            activePools: 4,
            activeOrderBooks: 3,
            listedAssets: 9,
            bridgeIncomingTransactions: 1,
            bridgeOutgoingTransactions: 2,
          },
        },
      ],
      totalCount: 1,
      pageInfo: {
        endCursor: '0',
        hasNextPage: false,
        hasPreviousPage: false,
        startCursor: '0',
      },
    });
  });

  it('counts unique transaction-active accounts over a stats range', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([
      {
        collection: 'accountTransactions',
        id: 'tx-a-alice',
        timestamp: 100,
        data: { id: 'tx-a-alice', accountId: 'alice', historyElementId: 'tx-a', timestamp: 100 },
      },
      {
        collection: 'accountTransactions',
        id: 'tx-b-alice',
        timestamp: 150,
        data: { id: 'tx-b-alice', accountId: 'alice', historyElementId: 'tx-b', timestamp: 150 },
      },
      {
        collection: 'accountTransactions',
        id: 'tx-c-bob',
        timestamp: 200,
        data: { id: 'tx-c-bob', accountId: 'bob', historyElementId: 'tx-c', timestamp: 200 },
      },
      {
        collection: 'accountTransactions',
        id: 'tx-d-old',
        timestamp: 50,
        data: { id: 'tx-d-old', accountId: 'old', historyElementId: 'tx-d', timestamp: 50 },
      },
      {
        collection: 'accountTransactions',
        id: 'tx-e-external',
        timestamp: 160,
        data: { id: 'tx-e-external', accountId: '0xexternal', historyElementId: 'tx-e', timestamp: 160 },
      },
      {
        collection: 'accountTransactions',
        id: 'tx-f-malformed',
        timestamp: 170,
        data: { id: 'tx-f-malformed', accountId: '<script>alert(1)</script>', historyElementId: 'tx-f', timestamp: 170 },
      },
      {
        collection: 'historyElements',
        id: 'legacy-carol',
        timestamp: 180,
        data: {
          id: 'legacy-carol',
          timestamp: 180,
          address: 'carol',
          dataFrom: '0xexternal',
          dataTo: 'dave',
        },
      },
      {
        collection: 'historyElements',
        id: 'legacy-malformed',
        timestamp: 190,
        data: {
          id: 'legacy-malformed',
          timestamp: 190,
          address: 'not an account',
          dataFrom: { account: 'eve' },
          dataTo: '0XABCDEF',
        },
      },
    ]);

    const schema = createSchema();
    const activityField = schema.getQueryType()?.getFields().networkAccountActivity;

    await expect(activityField?.resolve?.({}, { from: 220, to: 90 }, { repository }, {} as never)).resolves.toEqual({
      id: 'network-account-activity-90-220',
      from: 90,
      to: 220,
      activeAccounts: 4,
    });
  });

  it('falls back to legacy history when the activity backfill marker is corrupt', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([
      {
        collection: 'accountTransactions',
        id: 'tx-a-alice',
        timestamp: 100,
        data: { id: 'tx-a-alice', accountId: 'alice', historyElementId: 'tx-a', timestamp: 100 },
      },
      {
        collection: 'historyElements',
        id: 'legacy-bob',
        timestamp: 120,
        data: { id: 'legacy-bob', timestamp: 120, address: 'bob', dataFrom: '0xexternal', dataTo: 'carol' },
      },
      {
        collection: 'updatesStreams',
        id: 'accountTransactionsBackfill-v1',
        data: { id: 'accountTransactionsBackfill-v1', data: 'not-json' },
      },
    ]);

    const schema = createSchema();
    const activityField = schema.getQueryType()?.getFields().networkAccountActivity;

    await expect(activityField?.resolve?.({}, { from: 90, to: 130 }, { repository }, {} as never)).resolves.toMatchObject({
      activeAccounts: 3,
    });
  });

  it('counts active accounts across seek-paginated account activity pages without duplicates', async () => {
    const repository = new MemoryRepository();
    const accounts = Array.from({ length: 1_005 }, (_item, index) => ss58FixtureAccount(index));

    await repository.upsertMany([
      ...accounts.map((accountId, index) => ({
        collection: 'accountTransactions' as const,
        id: `paged-${String(index).padStart(4, '0')}`,
        timestamp: 120,
        data: { id: `paged-${String(index).padStart(4, '0')}`, accountId, historyElementId: `paged-${index}`, timestamp: 120 },
      })),
      {
        collection: 'accountTransactions',
        id: 'paged-duplicate',
        timestamp: 120,
        data: { id: 'paged-duplicate', accountId: accounts[0], historyElementId: 'paged-duplicate', timestamp: 120 },
      },
      {
        collection: 'accountTransactions',
        id: 'paged-malformed',
        timestamp: 120,
        data: { id: 'paged-malformed', accountId: 'attacker', historyElementId: 'paged-malformed', timestamp: 120 },
      },
      {
        collection: 'accountTransactions',
        id: 'paged-before-range',
        timestamp: 89,
        data: { id: 'paged-before-range', accountId: ss58FixtureAccount(1_006), historyElementId: 'paged-before-range', timestamp: 89 },
      },
      {
        collection: 'accountTransactions',
        id: 'paged-after-range',
        timestamp: 131,
        data: { id: 'paged-after-range', accountId: ss58FixtureAccount(1_007), historyElementId: 'paged-after-range', timestamp: 131 },
      },
      {
        collection: 'historyElements',
        id: 'legacy-ignored-after-valid-backfill',
        timestamp: 120,
        data: { id: 'legacy-ignored-after-valid-backfill', address: 'bob', timestamp: 120 },
      },
      {
        collection: 'updatesStreams',
        id: 'accountTransactionsBackfill-v1',
        data: { id: 'accountTransactionsBackfill-v1', data: completedAccountActivityBackfillData },
      },
    ]);

    const schema = createSchema();
    const activityField = schema.getQueryType()?.getFields().networkAccountActivity;

    await expect(activityField?.resolve?.({}, { from: 90, to: 130 }, { repository }, {} as never)).resolves.toMatchObject({
      activeAccounts: 1_005,
    });
  });

  it('does not scan account activity collections for invalid timestamp ranges', async () => {
    const repository = new MemoryRepository();
    await repository.upsert({
      collection: 'accountTransactions',
      id: 'tx-a-alice',
      timestamp: 100,
      data: { id: 'tx-a-alice', accountId: 'alice', historyElementId: 'tx-a', timestamp: 100 },
    });
    const querySpy = vi.spyOn(repository, 'query');
    const getSpy = vi.spyOn(repository, 'get');
    const schema = createSchema();
    const activityField = schema.getQueryType()?.getFields().networkAccountActivity;

    await expect(activityField?.resolve?.({}, { from: -1, to: 130 }, { repository }, {} as never)).resolves.toEqual({
      id: 'network-account-activity-invalid',
      from: 0,
      to: 0,
      activeAccounts: 0,
    });
    await expect(activityField?.resolve?.({}, { from: Number.NaN, to: 130 }, { repository }, {} as never)).resolves.toEqual({
      id: 'network-account-activity-invalid',
      from: 0,
      to: 0,
      activeAccounts: 0,
    });
    expect(querySpy).not.toHaveBeenCalled();
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('normalizes reversed active-account ranges before cache lookup', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([
      {
        collection: 'accountTransactions',
        id: 'tx-a-alice',
        timestamp: 100,
        data: { id: 'tx-a-alice', accountId: 'alice', historyElementId: 'tx-a', timestamp: 100 },
      },
      {
        collection: 'updatesStreams',
        id: 'accountTransactionsBackfill-v1',
        data: { id: 'accountTransactionsBackfill-v1', data: completedAccountActivityBackfillData },
      },
    ]);
    const querySpy = vi.spyOn(repository, 'query');
    const schema = createSchema();
    const activityField = schema.getQueryType()?.getFields().networkAccountActivity;

    await expect(activityField?.resolve?.({}, { from: 130, to: 90 }, { repository }, {} as never)).resolves.toMatchObject({
      id: 'network-account-activity-90-130',
      activeAccounts: 1,
    });
    await expect(activityField?.resolve?.({}, { from: 90, to: 130 }, { repository }, {} as never)).resolves.toMatchObject({
      id: 'network-account-activity-90-130',
      activeAccounts: 1,
    });
    expect(querySpy).toHaveBeenCalledTimes(1);
  });

  it('uses account transaction rows only after the legacy activity backfill is marked complete', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([
      {
        collection: 'accountTransactions',
        id: 'tx-a-alice',
        timestamp: 100,
        data: { id: 'tx-a-alice', accountId: 'alice', historyElementId: 'tx-a', timestamp: 100 },
      },
      {
        collection: 'historyElements',
        id: 'legacy-bob',
        timestamp: 120,
        data: { id: 'legacy-bob', timestamp: 120, address: 'bob', dataFrom: 'bob', dataTo: 'carol' },
      },
      {
        collection: 'updatesStreams',
        id: 'accountTransactionsBackfill-v1',
        data: {
          id: 'accountTransactionsBackfill-v1',
          data: completedAccountActivityBackfillData,
        },
      },
    ]);

    const schema = createSchema();
    const activityField = schema.getQueryType()?.getFields().networkAccountActivity;

    await expect(activityField?.resolve?.({}, { from: 90, to: 130 }, { repository }, {} as never)).resolves.toMatchObject({
      activeAccounts: 1,
    });
  });

  it('keeps legacy Polkamarkt account activity fields schema-compatible', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([
      {
        collection: 'accountTransactions',
        id: 'history-a-alice',
        blockHeight: 12,
        timestamp: 200,
        data: {
          id: 'history-a-alice',
          accountId: 'alice',
          historyElementId: 'history-a',
          blockHeight: 12,
          timestamp: 200,
        },
      },
      {
        collection: 'historyElements',
        id: 'history-a',
        blockHeight: 12,
        timestamp: 200,
        data: {
          id: 'history-a',
          timestamp: 200,
          blockHash: '0xabc',
          blockHeight: 12,
          module: 'polkamarkt',
          method: 'buy',
          address: 'alice',
          data: {
            marketId: 7,
            outcome: 'YES',
            collateralUsd: '5',
            shares: '10',
            price: '0.5',
          },
        },
      },
    ]);
    const schema = createSchema();
    const queryFields = schema.getQueryType()?.getFields();
    const positionsField = queryFields?.accountPositions;
    const tradesField = queryFields?.accountTrades;

    expect(positionsField?.args.map((arg) => arg.name)).toContain('where');
    expect(tradesField?.args.map((arg) => arg.name)).toContain('where');

    const positions = await positionsField?.resolve?.(
      {},
      { where: { account_eq: 'alice' }, first: 10, orderBy: ['UPDATED_AT_DESC'] },
      { repository },
      {} as never
    );
    const trades = (await tradesField?.resolve?.(
      {},
      { where: { account_eq: 'alice' }, first: 10, orderBy: ['TIMESTAMP_DESC'] },
      { repository },
      {} as never
    )) as { edges: Array<{ node: Record<string, unknown> }>; totalCount: number };

    expect(positions).toMatchObject({ edges: [], totalCount: 0 });
    expect(trades.totalCount).toBe(1);
    expect(trades.edges[0]?.node).toMatchObject({
      id: 'history-a-alice',
      account: 'alice',
      marketId: 7,
      side: 'buy',
      outcome: 'YES',
      collateralUsd: '5',
      shares: '10',
      price: '0.5',
      timestamp: '1970-01-01T00:03:20.000Z',
      blockNumber: 12,
      blockHash: '0xabc',
      extrinsicHash: 'history-a',
      market: { id: '7', marketId: 7 },
    });
  });

  it('serves SubQuery-compatible asset connections', async () => {
    const repository = new MemoryRepository();
    await repository.upsert({
      collection: 'assets',
      id: 'asset-a',
      data: {
        id: 'asset-a',
        priceUSD: '2',
        liquidity: '1000000000000000000',
        liquidityBooks: '0',
      },
    });

    const schema = createSchema();
    const assetsField = schema.getQueryType()?.getFields().assets;
    const result = await assetsField?.resolve?.(
      {},
      {
        filter: { liquidity: { greaterThan: '0' } },
        orderBy: ['ID_ASC'],
      },
      { repository },
      {} as never
    );

    expect(result).toMatchObject({
      totalCount: 1,
      edges: [
        {
          cursor: '0',
          node: {
            id: 'asset-a',
            priceUSD: '2',
            liquidity: '1000000000000000000',
            liquidityBooks: '0',
          },
        },
      ],
      pageInfo: {
        endCursor: '0',
        hasNextPage: false,
        hasPreviousPage: false,
        startCursor: '0',
      },
    });
  });

  it('caches repeated hot connection resolver queries within the TTL window', async () => {
    const row = {
      collection: 'assets',
      id: 'asset-a',
      data: { id: 'asset-a', liquidity: '10' },
    } as const;
    const query = vi.fn<QueryFunction>().mockResolvedValue({
      items: [row],
      totalCount: 1,
      pageStart: 0,
      hasNextPage: false,
      hasPreviousPage: false,
    });
    const repository = repositoryWithQuery(query);
    const schema = createSchema();
    const assetsField = schema.getQueryType()?.getFields().assets;
    const args = { first: 10, orderBy: ['ID_ASC'] };

    await expect(assetsField?.resolve?.({}, args, { repository }, undefined as never)).resolves.toMatchObject({
      totalCount: 1,
    });
    await expect(assetsField?.resolve?.({}, args, { repository }, undefined as never)).resolves.toMatchObject({
      totalCount: 1,
    });

    expect(query).toHaveBeenCalledTimes(1);
  });

  it('caches repeated hot singleton resolver queries within the TTL window', async () => {
    const get = vi.fn<IndexerRepository['get']>().mockResolvedValue({
      collection: 'updatesStreams',
      id: 'chainState',
      data: { id: 'chainState', block: 123, data: '{"lastIndexedBlock":123}' },
    });
    const repository: IndexerRepository = {
      list: async () => [],
      query: async () => ({ items: [], totalCount: 0 }),
      get,
      getMany: async () => new Map(),
      upsert: async () => undefined,
      upsertMany: async () => undefined,
      deleteMany: async () => undefined,
      close: async () => undefined,
    };
    const schema = createSchema();
    const updatesStreamField = schema.getQueryType()?.getFields().updatesStream;
    const args = { id: 'chainState' };

    await expect(updatesStreamField?.resolve?.({}, args, { repository }, undefined as never)).resolves.toMatchObject({
      block: 123,
    });
    await expect(updatesStreamField?.resolve?.({}, args, { repository }, undefined as never)).resolves.toMatchObject({
      block: 123,
    });

    expect(get).toHaveBeenCalledTimes(1);
  });

  it('falls back to list-based filtering, sorting, and pagination when query is unavailable', async () => {
    const repository = repositoryWithoutQuery([
      {
        collection: 'assets',
        id: 'asset-a',
        data: { id: 'asset-a', timestamp: 10, priceUSD: '1', liquidity: '0', liquidityBooks: '0' },
      },
      {
        collection: 'assets',
        id: 'asset-b',
        data: { id: 'asset-b', timestamp: 20, priceUSD: '2', liquidity: '5', liquidityBooks: '0' },
      },
      {
        collection: 'assets',
        id: 'asset-c',
        data: { id: 'asset-c', timestamp: 30, priceUSD: '3', liquidity: '10', liquidityBooks: '0' },
      },
    ]);
    const schema = createSchema();
    const assetsField = schema.getQueryType()?.getFields().assets;

    const result = await assetsField?.resolve?.(
      {},
      {
        first: 1,
        offset: 1,
        filter: { liquidity: { greaterThan: '0' } },
        orderBy: ['TIMESTAMP_ASC'],
      },
      { repository },
      {} as never
    );

    expect(result).toMatchObject({
      totalCount: 2,
      edges: [
        {
          cursor: '1',
          node: {
            id: 'asset-c',
            timestamp: 30,
            priceUSD: '3',
            liquidity: '10',
            liquidityBooks: '0',
          },
        },
      ],
      pageInfo: {
        endCursor: '1',
        hasNextPage: false,
        hasPreviousPage: true,
        startCursor: '1',
      },
    });
  });

  it('reports stable cursors for last windows within a first page', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany(
      ['asset-a', 'asset-b', 'asset-c', 'asset-d'].map((id) => ({
        collection: 'assets',
        id,
        data: {
          id,
          priceUSD: '1',
          liquidity: '1',
          liquidityBooks: '0',
        },
      }))
    );

    const schema = createSchema();
    const assetsField = schema.getQueryType()?.getFields().assets;
    const result = await assetsField?.resolve?.(
      {},
      {
        first: 3,
        last: 2,
        orderBy: ['ID_ASC'],
      },
      { repository },
      {} as never
    );

    expect(result).toMatchObject({
      totalCount: 4,
      edges: [
        {
          cursor: '1',
          node: {
            id: 'asset-b',
            priceUSD: '1',
            liquidity: '1',
            liquidityBooks: '0',
          },
        },
        {
          cursor: '2',
          node: {
            id: 'asset-c',
            priceUSD: '1',
            liquidity: '1',
            liquidityBooks: '0',
          },
        },
      ],
      pageInfo: {
        endCursor: '2',
        hasNextPage: true,
        hasPreviousPage: true,
        startCursor: '1',
      },
    });
  });

  it('returns empty page info for filtered-out connection results', async () => {
    const repository = new MemoryRepository();
    await repository.upsert({
      collection: 'assets',
      id: 'asset-a',
      data: {
        id: 'asset-a',
        priceUSD: '1',
        liquidity: '0',
        liquidityBooks: '0',
      },
    });

    const schema = createSchema();
    const assetsField = schema.getQueryType()?.getFields().assets;
    const result = await assetsField?.resolve?.(
      {},
      { filter: { liquidity: { greaterThan: '0' } } },
      { repository },
      {} as never
    );

    expect(result).toMatchObject({
      edges: [],
      totalCount: 0,
      pageInfo: {
        endCursor: null,
        hasNextPage: false,
        hasPreviousPage: false,
        startCursor: null,
      },
    });
  });

  it('skips repository total counts when connection selections omit totalCount', async () => {
    const queryArgs: RepositoryQueryArgs[] = [];
    const repository = repositoryWithQuery(async (_collection, args) => {
      queryArgs.push(args);

      return {
        items: [
          {
            collection: 'assets',
            id: 'asset-c',
            data: { id: 'asset-c', priceUSD: '1', liquidity: '1', liquidityBooks: '0' },
          },
        ],
        totalCount: null,
        pageStart: 2,
        hasNextPage: true,
        hasPreviousPage: true,
      };
    });
    const info = {
      fieldNodes: [
        {
          selectionSet: {
            selections: [
              { kind: 'Field', name: { value: 'edges' } },
              { kind: 'Field', name: { value: 'pageInfo' } },
            ],
          },
        },
      ],
      fragments: {},
    } as unknown as GraphQLResolveInfo;
    const schema = createSchema();
    const assetsField = schema.getQueryType()?.getFields().assets;

    const result = await assetsField?.resolve?.({}, { first: 1, after: '1' }, { repository }, info);

    expect(queryArgs).toHaveLength(1);
    expect(queryArgs[0]?.includeTotalCount).toBe(false);
    expect(result).toMatchObject({
      edges: [{ cursor: '2', node: { id: 'asset-c' } }],
      pageInfo: {
        endCursor: '2',
        hasNextPage: true,
        hasPreviousPage: true,
        startCursor: '2',
      },
    });
  });

  it('requests repository total counts when selected through inline fragments', async () => {
    const queryArgs: RepositoryQueryArgs[] = [];
    const repository = repositoryWithQuery(async (_collection, args) => {
      queryArgs.push(args);

      return {
        items: [
          {
            collection: 'assets',
            id: 'asset-a',
            data: { id: 'asset-a', priceUSD: '1', liquidity: '1', liquidityBooks: '0' },
          },
        ],
        totalCount: 1,
      };
    });
    const info = {
      fieldNodes: [
        {
          selectionSet: {
            selections: [
              {
                kind: 'InlineFragment',
                selectionSet: {
                  selections: [{ kind: 'Field', name: { value: 'totalCount' } }],
                },
              },
            ],
          },
        },
      ],
      fragments: {},
    } as unknown as GraphQLResolveInfo;
    const schema = createSchema();
    const assetsField = schema.getQueryType()?.getFields().assets;

    const result = await assetsField?.resolve?.({}, {}, { repository }, info);

    expect(queryArgs).toHaveLength(1);
    expect(queryArgs[0]?.includeTotalCount).toBe(true);
    expect(result).toMatchObject({
      edges: [{ node: { id: 'asset-a' } }],
      totalCount: 1,
    });
  });

  it('requests repository total counts when selected through fragments', async () => {
    const queryArgs: RepositoryQueryArgs[] = [];
    const repository = repositoryWithQuery(async (_collection, args) => {
      queryArgs.push(args);

      return {
        items: [
          {
            collection: 'assets',
            id: 'asset-a',
            data: { id: 'asset-a', priceUSD: '1', liquidity: '1', liquidityBooks: '0' },
          },
        ],
        totalCount: 1,
      };
    });
    const info = {
      fieldNodes: [
        {
          selectionSet: {
            selections: [{ kind: 'FragmentSpread', name: { value: 'AssetConnectionFields' } }],
          },
        },
      ],
      fragments: {
        AssetConnectionFields: {
          selectionSet: {
            selections: [
              { kind: 'Field', name: { value: 'totalCount' } },
              { kind: 'Field', name: { value: 'edges' } },
            ],
          },
        },
      },
    } as unknown as GraphQLResolveInfo;
    const schema = createSchema();
    const assetsField = schema.getQueryType()?.getFields().assets;

    const result = await assetsField?.resolve?.({}, {}, { repository }, info);

    expect(queryArgs).toHaveLength(1);
    expect(queryArgs[0]?.includeTotalCount).toBe(true);
    expect(result).toMatchObject({
      edges: [{ node: { id: 'asset-a' } }],
      totalCount: 1,
    });
  });

  it('accepts the UI history order enum and account point-system queries', async () => {
    const repository = new MemoryRepository();
    await repository.upsert({
      collection: 'historyElements',
      id: 'history-a',
      data: {
        id: 'history-a',
        type: 'CALL',
        timestamp: 10,
        blockHash: '0xabc',
        blockHeight: 1,
        module: 'assets',
        method: 'transfer',
        address: 'alice',
        networkFee: '0',
        execution: { success: true },
        data: { assetId: 'xor' },
        calls: [],
      },
    });
    await repository.upsert({
      collection: 'accountMeta',
      id: 'alice',
      data: {
        id: 'alice',
        accountId: 'alice',
        createdAtTimestamp: 10,
        createdAtBlock: 1,
        xorFees: { amount: '0', amountUSD: '0' },
        xorBurned: { amount: '0', amountUSD: '0' },
        xorStakingValRewards: { amount: '0', amountUSD: '0' },
        orderBook: { created: 0, closed: 0, amountUSD: '0' },
        vault: { created: 0, closed: 0, amountUSD: '0' },
        governance: { votes: 0, amount: '0', amountUSD: '0' },
        deposit: { incomingUSD: '0', outgoingUSD: '0' },
      },
    });

    const schema = createSchema();
    const historyOrderType = schema.getType('HistoryElementsOrderBy');
    const historyField = schema.getQueryType()?.getFields().historyElements;
    const accountMetaField = schema.getQueryType()?.getFields().accountMeta;
    const history = await historyField?.resolve?.(
      {},
      { orderBy: ['TIMESTAMP_DESC', 'ID_DESC'] },
      { repository },
      {} as never
    );
    const accountMeta = await accountMetaField?.resolve?.({}, { id: 'alice' }, { repository }, {} as never);

    expect(historyOrderType?.toString()).toBe('HistoryElementsOrderBy');
    expect(history).toMatchObject({
      totalCount: 1,
      edges: [{ node: { id: 'history-a' } }],
    });
    expect(accountMeta).toMatchObject({
      createdAtBlock: 1,
      xorFees: { amount: '0', amountUSD: '0' },
    });
  });

  it('accepts the Fearless iOS SORA history filter shape', async () => {
    const repository = new MemoryRepository();
    await repository.upsert({
      collection: 'historyElements',
      id: 'history-transfer',
      data: {
        id: 'history-transfer',
        timestamp: 20,
        method: 'transfer',
        address: 'alice',
        dataTo: 'bob',
        execution: { success: true },
      },
    });
    await repository.upsert({
      collection: 'historyElements',
      id: 'history-swap',
      data: {
        id: 'history-swap',
        timestamp: 10,
        method: 'swap',
        address: 'alice',
        dataTo: 'bob',
        execution: { success: true },
      },
    });

    const schema = createSchema();
    const historyField = schema.getQueryType()?.getFields().historyElements;
    const history = await historyField?.resolve?.(
      {},
      {
        first: 100,
        orderBy: ['TIMESTAMP_DESC'],
        filter: {
          or: [
            { address: 'alice', method: { notIn: ['swap', 'rewarded'] } },
            { dataTo: 'alice', method: { notIn: ['swap', 'rewarded'] } },
          ],
        },
      },
      { repository },
      {} as never
    );

    expect(history).toMatchObject({
      totalCount: 1,
      nodes: [{ id: 'history-transfer', execution: { success: true } }],
      edges: [{ node: { id: 'history-transfer', execution: { success: true } } }],
    });
  });

  it('does not let adversarial filter paths match inherited Object properties', async () => {
    Object.defineProperty(Object.prototype, 'polkaswapIndexerPolluted', {
      configurable: true,
      value: 'owned',
    });

    try {
      const repository = new MemoryRepository();
      await repository.upsert({
        collection: 'assets',
        id: 'asset-a',
        data: { id: 'asset-a', symbol: 'XOR', liquidity: '10' },
      });

      const schema = createSchema();
      const assetsField = schema.getQueryType()?.getFields().assets;
      const assets = await assetsField?.resolve?.(
        {},
        {
          first: 10,
          filter: {
            '__proto__.polkaswapIndexerPolluted': { equalTo: 'owned' },
          },
        },
        { repository },
        {} as never
      );

      expect(assets).toMatchObject({
        totalCount: 0,
        nodes: [],
        edges: [],
      });
    } finally {
      delete (Object.prototype as { polkaswapIndexerPolluted?: unknown }).polkaswapIndexerPolluted;
    }
  });

  it('serves SubQuery-style nodes and mobile metadata for referrer rewards', async () => {
    const repository = new MemoryRepository();
    await repository.upsert({
      collection: 'referrerRewards',
      id: 'alice-bob',
      blockHeight: 42,
      timestamp: 1234,
      data: {
        id: 'alice-bob',
        referral: 'bob',
        referrer: 'alice',
        updated: 1234,
        amount: '0',
      },
    });

    const schema = createSchema();
    const rewardsField = schema.getQueryType()?.getFields().referrerRewards;
    const rewards = await rewardsField?.resolve?.(
      {},
      { first: 10, filter: { referrer: { equalTo: 'alice' } } },
      { repository },
      {} as never
    );

    expect(rewards).toMatchObject({
      totalCount: 1,
      nodes: [{ id: 'alice-bob', blockHeight: '42', timestamp: 1234 }],
      edges: [{ node: { id: 'alice-bob', blockHeight: '42', timestamp: 1234 } }],
    });
  });

  it('serves singleton query fields and normalizes history call nodes', async () => {
    const repository = new MemoryRepository();
    await repository.upsert({
      collection: 'accounts',
      id: 'alice',
      data: { id: 'alice', latestHistoryElementId: 'history-a' },
    });
    await repository.upsert({
      collection: 'orderBooks',
      id: '0-xor-kusd',
      data: { id: '0-xor-kusd', status: 'Trading', price: '2' },
    });
    await repository.upsert({
      collection: 'updatesStreams',
      id: 'chainState',
      data: { id: 'chainState', block: 123, data: 'synced' },
    });

    const schema = createSchema();
    const queryFields = schema.getQueryType()?.getFields();
    const historyElementType = schema.getType('HistoryElement') as { getFields: () => Record<string, { resolve?: (...args: unknown[]) => unknown }> };
    const account = await queryFields?.account.resolve?.({}, { id: 'alice' }, { repository }, {} as never);
    const missingAccount = await queryFields?.account.resolve?.({}, { id: 'missing' }, { repository }, {} as never);
    const orderBook = await queryFields?.orderBook.resolve?.({}, { id: '0-xor-kusd' }, { repository }, {} as never);
    const updatesStream = await queryFields?.updatesStream.resolve?.({}, { id: 'chainState' }, { repository }, {} as never);
    const calls = historyElementType.getFields().calls.resolve?.(
      { calls: [{ module: 'assets', method: 'transfer', data: { amount: '1' } }] },
      {},
      {},
      {} as never
    );
    const missingCalls = historyElementType.getFields().calls.resolve?.({ calls: null }, {}, {}, {} as never);

    expect(account).toEqual({ id: 'alice', latestHistoryElementId: 'history-a' });
    expect(missingAccount).toBeNull();
    expect(orderBook).toEqual({ id: '0-xor-kusd', status: 'Trading', price: '2' });
    expect(updatesStream).toEqual({ id: 'chainState', block: 123, data: 'synced' });
    expect(calls).toEqual({ nodes: [{ module: 'assets', method: 'transfer', data: { amount: '1' } }] });
    expect(missingCalls).toEqual({ nodes: [] });
  });

  it('accepts entity-specific staking validator filter variables', () => {
    const schema = createSchema();
    const stakingValidatorFilter = schema.getType('StakingValidatorFilter');
    const stakingValidatorsField = schema.getQueryType()?.getFields().stakingValidators;
    const filterArg = stakingValidatorsField?.args.find((arg) => arg.name === 'filter');

    expect(stakingValidatorFilter?.toString()).toBe('StakingValidatorFilter');
    expect(String(filterArg?.type)).toBe('StakingValidatorFilter');
  });

  it('keeps SubQuery JSON fields selectable as scalar values', async () => {
    const repository = new MemoryRepository();
    await repository.upsert({
      collection: 'historyElements',
      id: 'history-a',
      data: {
        id: 'history-a',
        type: 'CALL',
        timestamp: 10,
        blockHash: '0xabc',
        blockHeight: 1,
        module: 'liquidityProxy',
        method: 'swap',
        address: 'alice',
        networkFee: '0',
        execution: { success: true },
        data: { assetId: 'xor' },
        dataAssets: ['xor'],
        calls: [],
      },
    });
    await repository.upsert({
      collection: 'assetSnapshots',
      id: 'asset-snapshot-a',
      data: {
        id: 'asset-snapshot-a',
        assetId: 'asset-a',
        timestamp: 10,
        type: 'DAY',
        supply: '100',
        priceUSD: { open: '1', high: '2', low: '1', close: '2' },
        volume: { amount: '5', amountUSD: '10' },
      },
    });
    await repository.upsert({
      collection: 'orderBookSnapshots',
      id: 'order-book-snapshot-a',
      data: {
        id: 'order-book-snapshot-a',
        orderBookId: '0-base-quote',
        timestamp: 10,
        type: 'DAY',
        price: { open: '1', high: '2', low: '1', close: '2' },
        volumeUSD: '10',
      },
    });
    await repository.upsert({
      collection: 'accountMeta',
      id: 'alice',
      data: {
        id: 'alice',
        accountId: 'alice',
        createdAtTimestamp: 10,
        createdAtBlock: 1,
        xorFees: { amount: '1', amountUSD: '2' },
        xorBurned: { amount: '0', amountUSD: '0' },
        xorStakingValRewards: { amount: '0', amountUSD: '0' },
        orderBook: { created: 1, closed: 0, amountUSD: '2' },
        vault: { created: 0, closed: 0, amountUSD: '0' },
        governance: { votes: 1, amount: '3', amountUSD: '4' },
        deposit: { incomingUSD: '5', outgoingUSD: '6' },
      },
    });

    const schema = createSchema();
    const assetSnapshotType = schema.getType('AssetSnapshot') as { getFields: () => Record<string, { type: unknown }> };
    const orderBookSnapshotType = schema.getType('OrderBookSnapshot') as { getFields: () => Record<string, { type: unknown }> };
    const accountMetaType = schema.getType('AccountMeta') as { getFields: () => Record<string, { type: unknown }> };
    const historyElementType = schema.getType('HistoryElement') as { getFields: () => Record<string, { type: unknown }> };
    const assetSnapshotsField = schema.getQueryType()?.getFields().assetSnapshots;
    const orderBookSnapshotsField = schema.getQueryType()?.getFields().orderBookSnapshots;
    const accountMetaField = schema.getQueryType()?.getFields().accountMeta;
    const historyElementsField = schema.getQueryType()?.getFields().historyElements;
    const assetSnapshots = await assetSnapshotsField?.resolve?.({}, {}, { repository }, {} as never);
    const orderBookSnapshots = await orderBookSnapshotsField?.resolve?.({}, {}, { repository }, {} as never);
    const accountMeta = await accountMetaField?.resolve?.({}, { id: 'alice' }, { repository }, {} as never);
    const historyElements = await historyElementsField?.resolve?.(
      {},
      {
        first: 1,
        filter: {
          and: [{ dataAssets: { contains: 'xor' } }, { timestamp: { greaterThan: 1 } }],
        },
      },
      { repository },
      {} as never
    );

    expect(String(assetSnapshotType.getFields().priceUSD.type)).toBe('JSON');
    expect(String(assetSnapshotType.getFields().volume.type)).toBe('JSON');
    expect(String(orderBookSnapshotType.getFields().price.type)).toBe('JSON');
    expect(String(accountMetaType.getFields().xorFees.type)).toBe('JSON');
    expect(String(historyElementType.getFields().execution.type)).toBe('JSON');
    expect(assetSnapshots).toMatchObject({
      edges: [{ node: { priceUSD: { close: '2' }, volume: { amountUSD: '10' } } }],
    });
    expect(orderBookSnapshots).toMatchObject({
      edges: [{ node: { price: { close: '2' } } }],
    });
    expect(accountMeta).toMatchObject({
      xorFees: { amount: '1', amountUSD: '2' },
      orderBook: { created: 1, closed: 0, amountUSD: '2' },
      governance: { votes: 1, amount: '3', amountUSD: '4' },
      deposit: { incomingUSD: '5', outgoingUSD: '6' },
    });
    expect(historyElements).toMatchObject({
      edges: [{ node: { id: 'history-a', execution: { success: true } } }],
      totalCount: 1,
    });
  });

  it('exposes extended DeFi fields on network snapshots', () => {
    const schema = createSchema();
    const networkSnapshotType = schema.getType('NetworkSnapshot') as { getFields: () => Record<string, { type: unknown }> };

    expect(Object.keys(networkSnapshotType.getFields())).toEqual(
      expect.arrayContaining([
        'liquidityUSD',
        'poolLiquidityUSD',
        'orderBookLiquidityUSD',
        'volumeUSD',
        'swaps',
        'activePools',
        'activeOrderBooks',
        'listedAssets',
        'bridgeIncomingTransactions',
        'bridgeOutgoingTransactions',
        'accounts',
        'transactions',
        'fees',
      ])
    );
  });

  it('validates SubQuery-style subscription payload entity scalars', () => {
    const schema = createSchema();
    const updatesStreamMutationType = schema.getType('UpdatesStreamMutation') as {
      getFields: () => Record<string, { type: unknown }>;
    };
    const accountMutationType = schema.getType('AccountMutation') as { getFields: () => Record<string, { type: unknown }> };
    const orderBookMutationType = schema.getType('OrderBookMutation') as { getFields: () => Record<string, { type: unknown }> };

    expect(String(updatesStreamMutationType.getFields()._entity.type)).toBe('JSON!');
    expect(String(accountMutationType.getFields()._entity.type)).toBe('JSON!');
    expect(String(orderBookMutationType.getFields()._entity.type)).toBe('JSON!');
  });

  it('emits account subscription payloads with SubQuery entity field names', async () => {
    const repository = new MemoryRepository();
    const schema = createSchema();
    const accountsField = schema.getSubscriptionType()?.getFields().accounts;
    const iterator = accountsField?.subscribe?.({}, { id: ['alice'] }, { repository }, {} as never) as AsyncGenerator<
      unknown,
      void,
      unknown
    >;
    const next = iterator.next();

    await repository.upsert({
      collection: 'accounts',
      id: 'bob',
      data: { id: 'bob', latestHistoryElementId: 'history-b' },
    });
    await repository.upsert({
      collection: 'accounts',
      id: 'alice',
      data: { id: 'alice', latestHistoryElementId: 'history-a' },
    });

    await expect(next).resolves.toEqual({
      done: false,
      value: {
        id: 'alice',
        mutation_type: 'UPDATE',
        _entity: {
          id: 'alice',
          latest_history_element_id: 'history-a',
        },
      },
    });
    await iterator.return(undefined);
  });

  it('emits order book subscription payloads with UI-compatible entity keys', async () => {
    const repository = new MemoryRepository();
    const schema = createSchema();
    const orderBooksField = schema.getSubscriptionType()?.getFields().orderBooks;
    const iterator = orderBooksField?.subscribe?.({}, { id: ['0-xor-kusd'] }, { repository }, {} as never) as AsyncGenerator<
      unknown,
      void,
      unknown
    >;
    const next = iterator.next();

    await repository.upsert({
      collection: 'orderBooks',
      id: '0-xor-kusd',
      data: {
        id: '0-xor-kusd',
        price: '2',
        priceChangeDay: 0.5,
        volumeDayUSD: '100',
        status: 'Trading',
        lastDeals: '[]',
        updatedAtBlock: 20,
      },
    });

    await expect(next).resolves.toEqual({
      done: false,
      value: {
        id: '0-xor-kusd',
        mutation_type: 'UPDATE',
        _entity: {
          price: '2',
          price_change_day: 0.5,
          volume_day_u_s_d: '100',
          status: 'Trading',
          last_deals: '[]',
        },
      },
    });
    await iterator.return(undefined);
  });
});
