import { makeExecutableSchema } from '@graphql-tools/schema';

import { matchesFilter, sortDocuments } from './filter.js';
import { CursorScalar, FilterScalars, JSONScalar, OrderByScalar } from './scalars.js';
import { typeDefs } from './schema.js';

import type { IndexerCollection, IndexerRepository } from '../repository/types.js';
import type { GraphQLSchema } from 'graphql';

type Context = {
  repository: IndexerRepository;
};

type ConnectionArgs = {
  first?: number | null;
  last?: number | null;
  offset?: number | null;
  after?: string | number | null;
  orderBy?: unknown;
  filter?: Record<string, unknown> | null;
};

type Edge = {
  cursor: string;
  node: Record<string, unknown>;
};

const emptyPageInfo = {
  hasNextPage: false,
  hasPreviousPage: false,
  startCursor: null,
  endCursor: null,
};

const collection = (name: IndexerCollection) => name;

const afterToOffset = (after: ConnectionArgs['after']): number => {
  if (after === null || after === undefined || after === '') return 0;

  const parsed = Number(after);
  return Number.isFinite(parsed) ? parsed + 1 : 0;
};

const buildConnection = (items: Record<string, unknown>[], args: ConnectionArgs) => {
  const filtered = sortDocuments(
    items.filter((item) => matchesFilter(item, args.filter)),
    args.orderBy
  );
  const totalCount = filtered.length;
  const baseOffset = args.offset ?? afterToOffset(args.after);
  const first = args.first ?? null;
  const last = args.last ?? null;
  const start = Math.max(baseOffset, 0);
  const end = first === null || first === undefined ? filtered.length : Math.min(start + Math.max(first, 0), filtered.length);
  const pageItems = last === null || last === undefined ? filtered.slice(start, end) : filtered.slice(Math.max(end - last, start), end);
  const edges: Edge[] = pageItems.map((node, index) => ({
    cursor: String(start + index),
    node,
  }));

  return {
    edges,
    totalCount,
    pageInfo: edges.length
      ? {
          hasNextPage: end < filtered.length,
          hasPreviousPage: start > 0,
          startCursor: edges[0]?.cursor ?? null,
          endCursor: edges[edges.length - 1]?.cursor ?? null,
        }
      : emptyPageInfo,
  };
};

const connectionResolver =
  (collectionName: IndexerCollection) =>
  async (_parent: unknown, args: ConnectionArgs, context: Context) => {
    if (context.repository.query) {
      const result = await context.repository.query(collectionName, args);
      const baseOffset = args.offset ?? afterToOffset(args.after);
      const edges: Edge[] = result.items.map((document, index) => ({
        cursor: String(baseOffset + index),
        node: document.data,
      }));

      return {
        edges,
        totalCount: result.totalCount,
        pageInfo: edges.length
          ? {
              hasNextPage: baseOffset + edges.length < result.totalCount,
              hasPreviousPage: baseOffset > 0,
              startCursor: edges[0]?.cursor ?? null,
              endCursor: edges[edges.length - 1]?.cursor ?? null,
            }
          : emptyPageInfo,
      };
    }

    const documents = await context.repository.list(collectionName);
    return buildConnection(
      documents.map((document) => document.data),
      args
    );
  };

type MutationPayload = {
  id: string;
  mutation_type: 'INSERT' | 'UPDATE';
  _entity: Record<string, unknown>;
};

const getSubscriptionIds = (id: unknown): string[] => {
  if (Array.isArray(id)) return id.map(String);
  if (id === undefined || id === null) return [];
  return [String(id)];
};

const snakeCase = (value: string): string => value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

const toMutationEntity = (collectionName: IndexerCollection, data: Record<string, unknown>): Record<string, unknown> => {
  if (collectionName === 'accounts') {
    return Object.fromEntries(Object.entries(data).map(([key, value]) => [snakeCase(key), value]));
  }

  if (collectionName === 'orderBooks') {
    return {
      price: data.price ?? null,
      price_change_day: data.priceChangeDay ?? null,
      volume_day_u_s_d: data.volumeDayUSD ?? null,
      status: data.status ?? null,
      last_deals: data.lastDeals ?? null,
    };
  }

  return data;
};

async function* pollSubscription(
  collectionName: IndexerCollection,
  args: { id?: string | string[] },
  context: Context
): AsyncGenerator<MutationPayload, void, unknown> {
  const ids = getSubscriptionIds(args.id);
  const snapshots = new Map<string, string>();

  while (true) {
    const candidates = ids.length
      ? await Promise.all(ids.map((id) => context.repository.get(collectionName, id)))
      : await context.repository.list(collectionName);

    for (const document of candidates) {
      if (!document) continue;

      const serialized = JSON.stringify(document.data);
      if (snapshots.get(document.id) === serialized) continue;

      snapshots.set(document.id, serialized);

      yield {
        id: document.id,
        mutation_type: 'UPDATE',
        _entity: toMutationEntity(collectionName, document.data),
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

const pollingSubscription = (collectionName: IndexerCollection) => ({
  subscribe: (_parent: unknown, args: { id?: string | string[] }, context: Context) =>
    pollSubscription(collectionName, args, context),
});

export function createSchema(): GraphQLSchema {
  return makeExecutableSchema({
    typeDefs,
    resolvers: {
      JSON: JSONScalar,
      Cursor: CursorScalar,
      OrderBy: OrderByScalar,
      ...FilterScalars,
      Query: {
        _health: () => ({ ok: true, service: 'polkaswap-indexer' }),
        account: async (_parent: unknown, args: { id: string }, context: Context) =>
          (await context.repository.get(collection('accounts'), args.id))?.data ?? null,
        assets: connectionResolver(collection('assets')),
        assetSnapshots: connectionResolver(collection('assetSnapshots')),
        accountLiquiditySnapshots: connectionResolver(collection('accountLiquiditySnapshots')),
        networkSnapshots: connectionResolver(collection('networkSnapshots')),
        poolXYKs: connectionResolver(collection('poolXYKs')),
        poolSnapshots: connectionResolver(collection('poolSnapshots')),
        orderBook: async (_parent: unknown, args: { id: string }, context: Context) =>
          (await context.repository.get(collection('orderBooks'), args.id))?.data ?? null,
        orderBooks: connectionResolver(collection('orderBooks')),
        orderBookOrders: connectionResolver(collection('orderBookOrders')),
        orderBookSnapshots: connectionResolver(collection('orderBookSnapshots')),
        historyElements: connectionResolver(collection('historyElements')),
        referrerRewards: connectionResolver(collection('referrerRewards')),
        stakingStakers: connectionResolver(collection('stakingStakers')),
        vaults: connectionResolver(collection('vaults')),
        vaultEvents: connectionResolver(collection('vaultEvents')),
        updatesStream: async (_parent: unknown, args: { id: string }, context: Context) =>
          (await context.repository.get(collection('updatesStreams'), args.id))?.data ?? null,
        accountMeta: async (_parent: unknown, args: { id: string }, context: Context) =>
          (await context.repository.get(collection('accountMeta'), args.id))?.data ?? null,
        accountPointSystems: connectionResolver(collection('accountPointSystems')),
      },
      HistoryElement: {
        calls: (parent: Record<string, unknown>) => ({
          nodes: Array.isArray(parent.calls) ? parent.calls : [],
        }),
      },
      Subscription: {
        updatesStreams: pollingSubscription(collection('updatesStreams')),
        accounts: pollingSubscription(collection('accounts')),
        orderBooks: pollingSubscription(collection('orderBooks')),
      },
    },
  });
}
