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

  it('keeps SubQuery JSON fields selectable as scalar values', async () => {
    const repository = new MemoryRepository();
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
    const assetSnapshotsField = schema.getQueryType()?.getFields().assetSnapshots;
    const orderBookSnapshotsField = schema.getQueryType()?.getFields().orderBookSnapshots;
    const accountMetaField = schema.getQueryType()?.getFields().accountMeta;
    const assetSnapshots = await assetSnapshotsField?.resolve?.({}, {}, { repository }, {} as never);
    const orderBookSnapshots = await orderBookSnapshotsField?.resolve?.({}, {}, { repository }, {} as never);
    const accountMeta = await accountMetaField?.resolve?.({}, { id: 'alice' }, { repository }, {} as never);

    expect(String(assetSnapshotType.getFields().priceUSD.type)).toBe('JSON');
    expect(String(assetSnapshotType.getFields().volume.type)).toBe('JSON');
    expect(String(orderBookSnapshotType.getFields().price.type)).toBe('JSON');
    expect(String(accountMetaType.getFields().xorFees.type)).toBe('JSON');
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
});
