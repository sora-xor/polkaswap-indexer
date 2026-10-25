import { setImmediate as nextEventLoopTurn } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { ChainIndexer } from '../src/worker/chain.js';
import type { IndexerDocument, IndexerRepository, RepositoryQueryArgs } from '../src/repository/types.js';

type Paginator = {
  repository: Pick<IndexerRepository, 'query' | 'list'>;
  analyticsInputCacheMetrics: { documentsRead: number };
  queryPages: (name: 'historyElements', args?: RepositoryQueryArgs) => AsyncGenerator<IndexerDocument[]>;
  streamAnalyticsInputDocuments: (name: 'historyElements', since: number, timestamp: number, sourceVersion: number) => AsyncGenerator<IndexerDocument>;
  queryAllWithinAnalyticsBudget: (name: 'historyElements', args: RepositoryQueryArgs, budget: { maximumBytes: number; retainedBytes: number }) => Promise<IndexerDocument[]>;
};

function documents(count: number): IndexerDocument[] {
  return Array.from({ length: count }, (_,index) => ({
    collection: 'historyElements', id: String(index).padStart(6, '0'), timestamp: index, blockHeight: index,
    data: { id: String(index).padStart(6, '0'), timestamp: index, module: 'system', method: 'remark', data: {} },
  }));
}

function paginator(rows: IndexerDocument[]) {
  const calls: RepositoryQueryArgs[] = [];
  const query = vi.fn(async (_name, args: RepositoryQueryArgs) => {
    calls.push(args);
    const start = args.seek ? rows.findIndex((row) => row.id === args.seek!.id) + 1 : 0;
    return { items: rows.slice(start, start + 2), totalCount: null, pageStart: start,
      hasNextPage: start + 2 < rows.length, hasPreviousPage: start > 0 };
  });
  // Exercise the real paging methods without starting a worker, network client or database.
  const indexer = Object.create(ChainIndexer.prototype) as Paginator;
  indexer.repository = { query, list: async () => rows };
  indexer.analyticsInputCacheMetrics = { documentsRead: 0 };
  return { indexer, query, calls };
}

describe('worker repository page scheduling', () => {
  it.each(['pages', 'cold retained load', 'streaming fallback'] as const)(
    'serves an event-loop turn between immediately resolved %s pages without changing results', async (mode) => {
      const rows = documents(5);
      const { indexer, calls } = paginator(rows);
      let callsAtTurn: number | null = null;
      const turn = nextEventLoopTurn().then(() => { callsAtTurn = calls.length; });
      const output: IndexerDocument[] = [];
      const args: RepositoryQueryArgs = { orderBy: ['TIMESTAMP_ASC'], filter: { blockHeight: { lessThanOrEqualTo: 4 } } };
      const budget = { maximumBytes: 8 * 1024 * 1024, retainedBytes: 0 };
      try {
        if (mode === 'pages') for await (const page of indexer.queryPages('historyElements', args)) output.push(...page);
        else if (mode === 'cold retained load') output.push(...await indexer.queryAllWithinAnalyticsBudget('historyElements', args, budget));
        else for await (const row of indexer.streamAnalyticsInputDocuments('historyElements', 0, 4, 4)) output.push(row);
        expect(callsAtTurn).toBe(1);
        expect(output).toEqual(rows);
        expect(calls).toHaveLength(3);
        expect(calls.map((call) => call.seek?.id)).toEqual([undefined, '000001', '000003']);
        expect(calls.every((call) => call.first === 1000 && call.includeTotalCount === false && Number(call.maxBytes) <= 8 * 1024 * 1024)).toBe(true);
        if (mode === 'streaming fallback') {
          expect(calls.every((call) => JSON.stringify(call.filter).includes('"blockHeight":{"lessThanOrEqualTo":4}'))).toBe(true);
          expect(indexer.analyticsInputCacheMetrics.documentsRead).toBe(5);
        } else expect(calls.every((call) => call.filter === args.filter)).toBe(true);
        if (mode === 'cold retained load') expect(budget.retainedBytes).toBeGreaterThan(0);
      } finally { await turn; }
    }
  );

  it('also schedules between pages when the optional query method is absent', async () => {
    const rows = documents(2001);
    const { indexer } = paginator(rows);
    indexer.repository.query = undefined;
    let consumed = 0;
    let consumedAtTurn: number | null = null;
    const turn = nextEventLoopTurn().then(() => { consumedAtTurn = consumed; });
    const output: IndexerDocument[] = [];
    try {
      for await (const page of indexer.queryPages('historyElements', { orderBy: ['TIMESTAMP_ASC'] })) {
        output.push(...page); consumed += page.length;
      }
      expect(consumedAtTurn).toBe(1000);
      expect(output).toEqual(rows);
    } finally { await turn; }
  });

  it('propagates the original repository failure after yielding without publishing a partial result', async () => {
    const { indexer, query } = paginator(documents(5));
    const failure = new Error('repository unavailable');
    query.mockResolvedValueOnce({ items: documents(2), totalCount: null, pageStart: 0, hasNextPage: true, hasPreviousPage: false }).mockRejectedValueOnce(failure);
    await expect(indexer.queryAllWithinAnalyticsBudget('historyElements', { orderBy: ['TIMESTAMP_ASC'] },
      { maximumBytes: 8 * 1024 * 1024, retainedBytes: 0 })).rejects.toBe(failure);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('still rejects an overlapping continuation page', async () => {
    const rows = documents(5);
    const { indexer, query } = paginator(rows);
    query.mockImplementation(async () => ({ items: rows.slice(0, 2), totalCount: null, pageStart: 0, hasNextPage: true, hasPreviousPage: false }));
    await expect(indexer.queryAllWithinAnalyticsBudget('historyElements', { orderBy: ['TIMESTAMP_ASC'] },
      { maximumBytes: 8 * 1024 * 1024, retainedBytes: 0 })).rejects.toThrow('page did not advance');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('does not fetch another page when the consumer closes the generator', async () => {
    const { indexer, query } = paginator(documents(5));
    for await (const page of indexer.queryPages('historyElements', { orderBy: ['TIMESTAMP_ASC'] })) {
      expect(page).toHaveLength(2);
      break;
    }
    await nextEventLoopTurn();
    expect(query).toHaveBeenCalledTimes(1);
  });
});
