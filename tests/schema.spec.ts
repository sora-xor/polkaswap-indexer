import { describe, expect, it, vi } from 'vitest';
import type { GraphQLResolveInfo } from 'graphql';

import { createSchema } from '../src/graphql/resolvers.js';
import { MemoryRepository } from '../src/repository/memory.js';

import type { IndexerRepository, RepositoryQueryArgs } from '../src/repository/types.js';

type QueryFunction = NonNullable<IndexerRepository['query']>;

const repositoryWithQuery = (query: QueryFunction): IndexerRepository => ({
  list: async () => [],
  query,
  get: async () => null,
  getMany: async () => new Map(),
  upsert: async () => undefined,
  upsertMany: async () => undefined,
  close: async () => undefined,
});

const repositoryWithoutQuery = (items: Awaited<ReturnType<IndexerRepository['list']>>): IndexerRepository => ({
  list: async (collection) => items.filter((item) => item.collection === collection),
  get: async () => null,
  getMany: async () => new Map(),
  upsert: async () => undefined,
  upsertMany: async () => undefined,
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
    expect(networkSnapshots).toEqual({
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

    expect(result).toEqual({
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

    expect(result).toEqual({
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

    expect(result).toEqual({
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

    expect(result).toEqual({
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
