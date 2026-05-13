import { describe, expect, it } from 'vitest';

import { createSchema } from '../src/graphql/resolvers.js';
import { MemoryRepository } from '../src/repository/memory.js';
import {
  DAI_ASSET_ID,
  SOLSWAP_LEGACY_BURN_BLOCK,
  SOLSWAP_NEXUS_BURN_BLOCK,
  XOR_ASSET_ID,
  XOR_DAI_POOL_ID,
  createSwapChartFixtureDocuments,
} from '../src/dev/swapChartFixture.js';

type ConnectionResult = {
  edges: Array<{ node: Record<string, unknown> }>;
  pageInfo: Record<string, unknown>;
  totalCount: number;
};

type StreamResult = {
  data?: string | null;
};

describe('swap chart fixture data', () => {
  it('builds the asset snapshots consumed by the exchange price chart', async () => {
    const repository = new MemoryRepository();
    const now = 1_700_000_000;

    await repository.upsertMany(createSwapChartFixtureDocuments(now, 88));

    const schema = createSchema();
    const assetSnapshotsField = schema.getQueryType()?.getFields().assetSnapshots;
    const result = (await assetSnapshotsField?.resolve?.(
      {},
      {
        first: 48,
        orderBy: ['TIMESTAMP_DESC'],
        filter: {
          assetId: { equalTo: XOR_ASSET_ID },
          type: { equalTo: 'DEFAULT' },
        },
      },
      { repository },
      undefined as never
    )) as ConnectionResult | undefined;

    expect(result).toMatchObject({
      totalCount: 48,
      pageInfo: {
        hasNextPage: false,
        hasPreviousPage: false,
      },
    });
    expect(result?.edges).toHaveLength(48);
    expect(result?.edges[0]?.node).toMatchObject({
      assetId: XOR_ASSET_ID,
      timestamp: now,
      type: 'DEFAULT',
      priceUSD: {
        close: expect.any(String),
        high: expect.any(String),
        low: expect.any(String),
        open: expect.any(String),
      },
      volume: {
        amountUSD: expect.any(String),
      },
    });
    expect(result?.edges[1]?.node.timestamp).toBe(now - 5 * 60);
  });

  it('includes price stream, registration stream, and pool context for XOR/DAI', async () => {
    const repository = new MemoryRepository();
    const now = 1_700_000_000;

    await repository.upsertMany(createSwapChartFixtureDocuments(now, 88));

    const schema = createSchema();
    const updatesStreamField = schema.getQueryType()?.getFields().updatesStream;
    const poolField = schema.getQueryType()?.getFields().poolXYKs;
    const priceStream = (await updatesStreamField?.resolve?.(
      {},
      { id: 'price' },
      { repository },
      undefined as never
    )) as StreamResult | undefined;
    const registrationStream = (await updatesStreamField?.resolve?.(
      {},
      { id: 'assetRegistration' },
      { repository },
      undefined as never
    )) as StreamResult | undefined;
    const pools = (await poolField?.resolve?.(
      {},
      { filter: { id: { equalTo: XOR_DAI_POOL_ID } } },
      { repository },
      undefined as never
    )) as ConnectionResult | undefined;

    expect(JSON.parse(priceStream?.data ?? '{}')).toMatchObject({
      [XOR_ASSET_ID]: '362.29',
      [DAI_ASSET_ID]: '1',
    });
    expect(JSON.parse(JSON.parse(registrationStream?.data ?? '{}')[XOR_ASSET_ID])).toMatchObject({
      address: XOR_ASSET_ID,
      symbol: 'XOR',
      decimals: 18,
    });
    expect(pools?.edges).toHaveLength(1);
    expect(pools?.edges[0]?.node).toMatchObject({
      id: XOR_DAI_POOL_ID,
      baseAssetId: XOR_ASSET_ID,
      targetAssetId: DAI_ASSET_ID,
    });
  });

  it('includes network snapshots consumed by the stats page', async () => {
    const repository = new MemoryRepository();
    const now = 1_700_000_000;

    await repository.upsertMany(createSwapChartFixtureDocuments(now, 88));

    const schema = createSchema();
    const networkSnapshotsField = schema.getQueryType()?.getFields().networkSnapshots;
    const result = (await networkSnapshotsField?.resolve?.(
      {},
      {
        first: 4,
        orderBy: ['TIMESTAMP_DESC'],
        filter: {
          and: [
            { type: { equalTo: 'HOUR' } },
            { timestamp: { lessThanOrEqualTo: now } },
            { timestamp: { greaterThanOrEqualTo: now - 24 * 60 * 60 } },
          ],
        },
      },
      { repository },
      undefined as never
    )) as ConnectionResult | undefined;

    expect(result).toMatchObject({
      totalCount: 25,
      pageInfo: {
        hasNextPage: true,
        hasPreviousPage: false,
      },
    });
    expect(result?.edges).toHaveLength(4);
    expect(result?.edges[0]?.node).toMatchObject({
      type: 'HOUR',
      timestamp: now,
      liquidityUSD: expect.any(String),
      volumeUSD: expect.any(String),
      bridgeIncomingTransactions: expect.any(Number),
      bridgeOutgoingTransactions: expect.any(Number),
    });
    expect(Number(result?.edges[0]?.node.liquidityUSD)).toBeGreaterThan(0);
    expect(Number(result?.edges[0]?.node.volumeUSD)).toBeGreaterThan(0);
  });

  it('includes SOLSWAP burn history consumed by the burn page stats query', async () => {
    const repository = new MemoryRepository();
    const now = 1_700_000_000;

    await repository.upsertMany(createSwapChartFixtureDocuments(now, 88));

    const schema = createSchema();
    const historyField = schema.getQueryType()?.getFields().historyElements;
    const result = (await historyField?.resolve?.(
      {},
      {
        first: 100,
        filter: {
          and: [
            { blockHeight: { greaterThanOrEqualTo: SOLSWAP_LEGACY_BURN_BLOCK } },
            { blockHeight: { lessThanOrEqualTo: SOLSWAP_NEXUS_BURN_BLOCK } },
            {
              or: [
                {
                  and: [
                    { module: { equalTo: 'assets' } },
                    { method: { equalTo: 'burn' } },
                    { data: { contains: { assetId: XOR_ASSET_ID } } },
                  ],
                },
                {
                  and: [
                    { module: { equalTo: 'utility' } },
                    { method: { equalTo: 'batchAll' } },
                    { callNames: { contains: ['assets.burn'] } },
                  ],
                },
              ],
            },
          ],
        },
      },
      { repository },
      undefined as never
    )) as ConnectionResult | undefined;

    const nodes = result?.edges.map((edge) => edge.node) ?? [];
    const batchBurn = nodes.find((node) => node.method === 'batchAll');

    expect(nodes).toHaveLength(2);
    expect(nodes.map((node) => node.blockHeight)).toEqual([SOLSWAP_LEGACY_BURN_BLOCK, SOLSWAP_NEXUS_BURN_BLOCK]);
    expect(batchBurn).toMatchObject({
      callNames: ['assets.burn', 'system.remark'],
      calls: [
        {
          module: 'assets',
          method: 'burn',
          data: { args: { assetId: XOR_ASSET_ID, amount: '850000000000000000000' } },
        },
        {
          module: 'system',
          method: 'remark',
        },
      ],
    });
  });

  it('includes compact XOR burn documents for the burn page fast path', async () => {
    const repository = new MemoryRepository();
    const now = 1_700_000_000;

    await repository.upsertMany(createSwapChartFixtureDocuments(now, 88));

    const schema = createSchema();
    const xorBurnsField = schema.getQueryType()?.getFields().xorBurns;
    const result = (await xorBurnsField?.resolve?.(
      {},
      {
        first: 100,
        orderBy: ['BLOCK_HEIGHT_ASC'],
        filter: {
          blockHeight: { greaterThanOrEqualTo: SOLSWAP_LEGACY_BURN_BLOCK },
        },
      },
      { repository },
      undefined as never
    )) as ConnectionResult | undefined;

    expect(result?.edges.map((edge) => edge.node)).toEqual([
      expect.objectContaining({
        amount: '1250',
        assetId: XOR_ASSET_ID,
        blockHeight: SOLSWAP_LEGACY_BURN_BLOCK,
      }),
      expect.objectContaining({
        amount: '850',
        assetId: XOR_ASSET_ID,
        blockHeight: SOLSWAP_NEXUS_BURN_BLOCK,
        nexusRecipient: expect.stringMatching(/^sora/),
      }),
    ]);
  });
});
