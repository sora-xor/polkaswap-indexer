import { describe, expect, it, vi } from 'vitest';

import { createSchema } from '../src/graphql/resolvers.js';
import { decodeRepositoryCursor } from '../src/repository/cursor.js';
import { MemoryRepository } from '../src/repository/memory.js';
import type { IndexerDocument, IndexerRepository, RepositoryWatchEvent } from '../src/repository/types.js';

const listRepository = (documents: IndexerDocument[]): IndexerRepository => ({
  list: async (collection) => documents.filter((document) => document.collection === collection),
  get: async (collection, id) => documents.find((document) => document.collection === collection && document.id === id) ?? null,
  getMany: async () => new Map(),
  upsert: async () => undefined,
  upsertMany: async () => undefined,
  deleteMany: async () => undefined,
  close: async () => undefined,
});

type Connection = {
  totalCount: number;
  edges: Array<{ cursor: string; node: { id: string } }>;
  pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean };
};

describe('GraphQL repository fallbacks', () => {
  it('honors offsets and page metadata for list-only asset repositories', async () => {
    const repository = listRepository(['a', 'b', 'c'].map((id) => ({
      collection: 'assets', id, data: { id },
    })));
    const field = createSchema().getQueryType()!.getFields().assets!;
    const result = await field.resolve!({}, { first: 1, offset: 1 }, { repository }, {} as never) as Connection;

    expect(result.edges.map(({ node }) => node.id)).toEqual(['b']);
    expect(result).toMatchObject({ totalCount: 3, pageInfo: { hasNextPage: true, hasPreviousPage: true } });
  });

  it.each([
    ['accountPositions', 'accountPositions', 'UPDATED_AT_DESC', 'account'],
    ['accountTrades', 'accountTransactions', 'TIMESTAMP_DESC', 'accountId'],
  ] as const)('paginates %s using original document positions and timestamps', async (fieldName, collection, orderBy, accountField) => {
    const documents: IndexerDocument[] = [
      { collection, id: 'old', data: { id: 'old', [accountField]: 'alice', timestamp: 10 } },
      { collection, id: 'middle', timestamp: 20, data: { id: 'middle', [accountField]: 'alice' } },
      { collection, id: 'new', data: { id: 'new', [accountField]: 'alice', timestamp: 30 } },
    ];
    const repository = listRepository(documents);
    const field = createSchema().getQueryType()!.getFields()[fieldName]!;
    const args = { first: 1, where: { account_eq: 'alice' }, orderBy: [orderBy] };
    const first = await field.resolve!({}, args, { repository }, {} as never) as Connection;
    expect(first.edges.map(({ node }) => node.id)).toEqual(['new']);
    expect(decodeRepositoryCursor(first.edges[0]!.cursor)?.value).toBe('30');

    documents.splice(documents.findIndex(({ id }) => id === 'new'), 1);
    const second = await field.resolve!({}, { ...args, after: first.edges[0]!.cursor }, { repository }, {} as never) as Connection;
    expect(second.edges.map(({ node }) => node.id)).toEqual(['middle']);
    expect(decodeRepositoryCursor(second.edges[0]!.cursor)?.value).toBe('20');
    expect(second).toMatchObject({ totalCount: 2, pageInfo: { hasNextPage: true, hasPreviousPage: true } });

    const third = await field.resolve!({}, { ...args, after: second.edges[0]!.cursor }, { repository }, {} as never) as Connection;
    expect(third.edges.map(({ node }) => node.id)).toEqual(['old']);
    expect(third.pageInfo).toMatchObject({ hasNextPage: false, hasPreviousPage: true });
  });

  it('reports newly observed polling documents as INSERT and later changes as UPDATE', async () => {
    vi.useFakeTimers();
    const memory = new MemoryRepository();
    const repository: IndexerRepository = {
      ...listRepository([]),
      get: memory.get.bind(memory),
    };
    const field = createSchema().getSubscriptionType()!.getFields().accounts!;
    const iterator = field.subscribe!({}, { id: ['alice'] }, { repository }, {} as never) as AsyncGenerator<RepositoryWatchEvent>;
    try {
      const inserted = iterator.next();
      await vi.advanceTimersByTimeAsync(0);
      await memory.upsert({ collection: 'accounts', id: 'alice', data: { id: 'alice', latestHistoryElementId: 'first' } });
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await inserted).value).toMatchObject({ id: 'alice', mutationType: 'INSERT' });

      const updated = iterator.next();
      await memory.upsert({ collection: 'accounts', id: 'alice', data: { id: 'alice', latestHistoryElementId: 'second' } });
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await updated).value).toMatchObject({ id: 'alice', mutationType: 'UPDATE' });

      const deleted = iterator.next();
      await memory.deleteMany('accounts', ['alice']);
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await deleted).value).toMatchObject({ id: 'alice', mutationType: 'DELETE' });

      const reinserted = iterator.next();
      await memory.upsert({ collection: 'accounts', id: 'alice', data: { id: 'alice' } });
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await reinserted).value).toMatchObject({ id: 'alice', mutationType: 'INSERT' });
    } finally {
      await iterator.return(undefined);
      vi.useRealTimers();
    }
  });
});
