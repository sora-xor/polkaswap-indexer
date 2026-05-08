import { describe, expect, it } from 'vitest';

import { createSchema } from '../src/graphql/resolvers.js';
import { MemoryRepository } from '../src/repository/memory.js';

describe('Polkaswap indexer schema', () => {
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
});
