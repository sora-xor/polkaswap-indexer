import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { POSTGRES_SECONDARY_INDEX_DEFINITIONS } from '../src/db/migrate.js';
import { validatePublicConnectionQuery } from '../src/graphql/query-policy.js';
import { RocksRepository } from '../src/repository/rocksdb.js';
import { createPinnedWalletHistoryFilter } from './pinned-wallet-history-fixture.js';

import type { AppConfig } from '../src/config.js';
import type { RepositoryQueryArgs } from '../src/repository/types.js';

type OfficialConnectionShape = {
  source: string;
  collection: Parameters<typeof validatePublicConnectionQuery>[0];
  orderBy?: unknown;
  filter?: Record<string, unknown>;
};

type OfficialPhysicalPlan = {
  rocks: string;
  rocksIndexCodes?: readonly string[];
  postgres: readonly string[];
};

const PUBLIC_PAGE_SIZE = 100;

const boundedBlockRange = {
  blockHeight: { greaterThanOrEqualTo: 14_000_000, lessThanOrEqualTo: 15_000_000 },
};
const boundedTimestampRange = {
  timestamp: { greaterThanOrEqualTo: 1_700_000_000, lessThanOrEqualTo: 1_800_000_000 },
};

/**
 * Every reachable SubQuery connection in polkaswap-exchange-web@edfac7b plus
 * @soramitsu/soraneo-wallet-web@1.46.3. Duplicate documents that intentionally
 * use the same physical shape are listed so source additions cannot silently
 * escape the compatibility audit.
 */
const OFFICIAL_CONNECTION_SHAPES: readonly OfficialConnectionShape[] = [
  {
    source: 'src/indexer/queries/accountLiquidity/liquidity.ts (intended query; upstream omits $ before filter)',
    collection: 'accountLiquiditySnapshots',
    orderBy: ['TIMESTAMP_DESC'],
    filter: { accountLiquidityId: { equalTo: 'alice-pool' } },
  },
  {
    source: 'src/indexer/queries/asset/assets.ts (selected assets)',
    collection: 'assets',
    orderBy: ['ID_ASC'],
    filter: {
      or: [{ liquidity: { greaterThan: '0' } }, { liquidityBooks: { greaterThan: '0' } }],
      id: { in: ['xor', 'val'] },
    },
  },
  {
    source: 'src/indexer/queries/asset/assets.ts (all active assets)',
    collection: 'assets',
    orderBy: ['ID_ASC'],
    filter: { or: [{ liquidity: { greaterThan: '0' } }, { liquidityBooks: { greaterThan: '0' } }] },
  },
  {
    source: 'src/indexer/queries/asset/price.ts',
    collection: 'assetSnapshots',
    orderBy: ['TIMESTAMP_DESC'],
    filter: { assetId: { equalTo: 'xor' }, type: { equalTo: 'DAY' } },
  },
  {
    source: 'src/indexer/queries/asset/supply.ts',
    collection: 'assetSnapshots',
    orderBy: ['TIMESTAMP_DESC'],
    filter: {
      and: [
        { type: { equalTo: 'DAY' } },
        { assetId: { equalTo: 'xor' } },
        { timestamp: { lessThanOrEqualTo: 1_800_000_000 } },
        { timestamp: { greaterThanOrEqualTo: 1_700_000_000 } },
      ],
    },
  },
  {
    source: 'src/indexer/queries/burnXor.ts (global)',
    collection: 'historyElements',
    orderBy: ['ID_ASC'],
    filter: {
      and: [
        { blockHeight: { greaterThanOrEqualTo: 14_000_000 } },
        { blockHeight: { lessThanOrEqualTo: 15_000_000 } },
        { module: { equalTo: 'assets' } },
        { method: { equalTo: 'burn' } },
        { data: { contains: { assetId: 'xor' } } },
      ],
    },
  },
  {
    source: 'src/indexer/queries/burnXor.ts (account)',
    collection: 'historyElements',
    orderBy: ['ID_ASC'],
    filter: {
      and: [
        boundedBlockRange,
        { module: { equalTo: 'assets' } },
        { method: { equalTo: 'burn' } },
        { data: { contains: { assetId: 'xor' } } },
        { address: { equalTo: 'alice' } },
      ],
    },
  },
  {
    source: 'src/indexer/queries/network/stats.ts',
    collection: 'networkSnapshots',
    orderBy: ['TIMESTAMP_DESC'],
    filter: { and: [{ type: { equalTo: 'DAY' } }, boundedTimestampRange] },
  },
  {
    source: 'src/indexer/queries/network/tvl.ts',
    collection: 'networkSnapshots',
    orderBy: ['TIMESTAMP_DESC'],
    filter: {
      and: [{ type: { equalTo: 'DAY' } }, boundedTimestampRange, { liquidityUSD: { greaterThan: '0' } }],
    },
  },
  {
    source: 'src/indexer/queries/network/volume.ts',
    collection: 'networkSnapshots',
    orderBy: ['TIMESTAMP_DESC'],
    filter: { and: [{ type: { equalTo: 'DAY' } }, boundedTimestampRange] },
  },
  {
    source: 'src/indexer/queries/orderBook/orderBooks.ts (all)',
    collection: 'orderBooks',
    orderBy: ['ID_ASC'],
  },
  {
    source: 'src/indexer/queries/orderBook/orderBooks.ts (selected base assets)',
    collection: 'orderBooks',
    orderBy: ['ID_ASC'],
    filter: { baseAssetId: { in: ['xor', 'val'] } },
  },
  {
    source: 'src/indexer/queries/orderBook/orders.ts',
    collection: 'orderBookOrders',
    orderBy: ['TIMESTAMP_DESC'],
    filter: {
      and: [{ accountId: { equalTo: 'alice' } }, { status: { notEqualTo: 'Active' } }],
    },
  },
  {
    source: 'src/indexer/queries/orderBook/orders.ts (one book)',
    collection: 'orderBookOrders',
    orderBy: ['TIMESTAMP_DESC'],
    filter: {
      and: [
        { accountId: { equalTo: 'alice' } },
        { status: { notEqualTo: 'Active' } },
        { orderBookId: { equalTo: '0-xor-val' } },
      ],
    },
  },
  {
    source: 'src/indexer/queries/orderBook/price.ts',
    collection: 'orderBookSnapshots',
    orderBy: ['TIMESTAMP_DESC'],
    filter: { orderBookId: { equalTo: '0-xor-val' }, type: { equalTo: 'DAY' } },
  },
  {
    source: 'src/indexer/queries/pointSystem.ts BridgeQuery',
    collection: 'historyElements',
    orderBy: ['ID_ASC'],
    filter: {
      and: [
        boundedBlockRange,
        {
          or: [
            {
              and: [
                { data: { contains: { to: 'alice' } } },
                { module: { equalTo: 'bridgeMultisig' } },
                { method: { equalTo: 'asMulti' } },
              ],
            },
            {
              and: [
                { address: { equalTo: 'alice' } },
                { module: { equalTo: 'ethBridge' } },
                { method: { equalTo: 'transferToSidechain' } },
              ],
            },
          ],
        },
      ],
    },
  },
  ...(['swap', 'depositLiquidity', 'withdrawLiquidity'] as const).map((method) => ({
    source: `src/indexer/queries/pointSystem.ts CountQuery (${method})`,
    collection: 'historyElements' as const,
    orderBy: ['ID_ASC'],
    filter: {
      and: [
        boundedBlockRange,
        { address: { equalTo: 'alice' } },
        { module: { equalTo: method === 'swap' ? 'liquidityProxy' : 'poolXYK' } },
        { method: { equalTo: method } },
      ],
    },
  })),
  {
    source: 'src/indexer/queries/pointSystem.ts AccountPointSystemsQuery',
    collection: 'accountPointSystems',
    orderBy: ['ID_ASC'],
    filter: { accountId: { equalTo: 'alice' } },
  },
  {
    source: 'src/indexer/queries/pool/apy.ts',
    collection: 'poolXYKs',
    orderBy: ['ID_ASC'],
    filter: { strategicBonusApy: { greaterThan: '0' } },
  },
  {
    source: 'src/indexer/queries/pool/pools.ts (selected targets)',
    collection: 'poolXYKs',
    orderBy: ['ID_ASC'],
    filter: {
      baseAssetReserves: { greaterThan: '0' },
      targetAssetReserves: { greaterThan: '0' },
      targetAssetId: { in: ['xor', 'val'] },
    },
  },
  {
    source: 'src/indexer/queries/pool/pools.ts (all active)',
    collection: 'poolXYKs',
    orderBy: ['ID_ASC'],
    filter: {
      baseAssetReserves: { greaterThan: '0' },
      targetAssetReserves: { greaterThan: '0' },
    },
  },
  {
    source: 'src/indexer/queries/pool/price.ts',
    collection: 'poolSnapshots',
    orderBy: ['TIMESTAMP_DESC'],
    filter: { poolId: { equalTo: '0-xor-val' }, type: { equalTo: 'DAY' } },
  },
  {
    source: 'src/indexer/queries/pool/tvl.ts',
    collection: 'poolSnapshots',
    orderBy: ['TIMESTAMP_DESC'],
    filter: { poolId: { equalTo: '0-xor-val' }, type: { equalTo: 'DAY' } },
  },
  {
    source: 'src/indexer/queries/referrals.ts (one referrer)',
    collection: 'referrerRewards',
    orderBy: ['ID_ASC'],
    filter: { referrer: { equalTo: 'alice' } },
  },
  {
    source: 'src/indexer/queries/referrals.ts (all)',
    collection: 'referrerRewards',
    orderBy: ['ID_ASC'],
  },
  {
    source: 'src/indexer/queries/staking/nominators.ts',
    collection: 'stakingStakers',
    orderBy: ['ID_DESC'],
  },
  {
    source: 'src/indexer/queries/vault/events.ts',
    collection: 'vaultEvents',
    orderBy: ['TIMESTAMP_DESC', 'ID_DESC'],
    filter: { vaultId: { equalTo: '7' } },
  },
  {
    source: 'src/indexer/queries/vault/events.ts (incremental)',
    collection: 'vaultEvents',
    orderBy: ['TIMESTAMP_DESC', 'ID_DESC'],
    filter: { vaultId: { equalTo: '7' }, timestamp: { greaterThan: 1_700_000_000 } },
  },
  {
    source: 'src/indexer/queries/vault/vaults.ts',
    collection: 'vaults',
    orderBy: ['UPDATED_AT_BLOCK_DESC'],
    filter: { ownerId: { equalTo: 'alice' }, status: { in: ['Closed', 'Liquidated'] } },
  },
  {
    source: '@soramitsu/soraneo-wallet-web@1.46.3 FiatPriceQuery',
    collection: 'assets',
    orderBy: ['ID_ASC'],
    filter: { priceUSD: { greaterThan: '0' } },
  },
  {
    source: '@soramitsu/soraneo-wallet-web@1.46.3 HistoryElementsQuery',
    collection: 'historyElements',
    orderBy: ['TIMESTAMP_DESC', 'ID_DESC'],
    filter: createPinnedWalletHistoryFilter({ address: 'alice' }),
  },
  {
    source: '@soramitsu/soraneo-wallet-web@1.46.3 history subscription hydration',
    collection: 'historyElements',
    orderBy: ['TIMESTAMP_DESC', 'ID_DESC'],
    filter: { id: { equalTo: 'history-id' } },
  },
];

const OFFICIAL_PHYSICAL_PLANS: readonly OfficialPhysicalPlan[] = [
  { rocks: 'x:a-t', postgres: ['indexer_documents_account_liquidity_id_timestamp_idx'] },
  { rocks: 'x:id-set', postgres: ['indexer_documents_pkey'] },
  {
    rocks: 'x:assets-active-id',
    postgres: ['indexer_documents_collection_liquidity_idx', 'indexer_documents_collection_liquidity_books_idx'],
  },
  { rocks: 'x:a-t', postgres: ['indexer_documents_asset_snapshots_asset_type_timestamp_idx'] },
  { rocks: 'x:a-t', postgres: ['indexer_documents_asset_snapshots_asset_type_timestamp_idx'] },
  {
    rocks: 'x:history-signature-block-id',
    rocksIndexCodes: ['xb-b'],
    postgres: ['indexer_documents_history_assets_burn_asset_block_idx'],
  },
  {
    rocks: 'x:history-signature-block-id',
    rocksIndexCodes: ['ab-b'],
    postgres: ['indexer_documents_history_assets_burn_address_block_idx'],
  },
  { rocks: 'x:y-t', postgres: ['indexer_documents_network_snapshots_type_timestamp_idx'] },
  { rocks: 'x:y-t', postgres: ['indexer_documents_network_snapshots_type_timestamp_idx'] },
  { rocks: 'x:y-t', postgres: ['indexer_documents_network_snapshots_type_timestamp_idx'] },
  { rocks: 'document', postgres: ['indexer_documents_pkey'] },
  { rocks: 'x:b-i', postgres: ['indexer_documents_order_books_base_id_idx'] },
  { rocks: 'x:a-t', postgres: ['indexer_documents_order_book_orders_account_timestamp_idx'] },
  { rocks: 'x:a-t', postgres: ['indexer_documents_order_book_orders_account_timestamp_idx'] },
  { rocks: 'x:o-t', postgres: ['indexer_documents_order_book_snapshots_book_type_timestamp_idx'] },
  {
    rocks: 'x:history-signature-block-id',
    rocksIndexCodes: ['bi-b', 'bo-b'],
    postgres: [
      'indexer_documents_history_bridge_in_to_block_idx',
      'indexer_documents_history_eth_bridge_out_address_block_idx',
    ],
  },
  {
    rocks: 'x:history-signature-block-id',
    rocksIndexCodes: ['as-b'],
    postgres: ['indexer_documents_history_liquidity_swap_address_block_idx'],
  },
  {
    rocks: 'x:history-signature-block-id',
    rocksIndexCodes: ['ad-b'],
    postgres: ['indexer_documents_history_pool_deposit_address_block_idx'],
  },
  {
    rocks: 'x:history-signature-block-id',
    rocksIndexCodes: ['aw-b'],
    postgres: ['indexer_documents_history_pool_withdraw_address_block_idx'],
  },
  { rocks: 'x:a-i', postgres: ['indexer_documents_account_points_account_id_idx'] },
  { rocks: 'x:pools-apy-id', postgres: ['indexer_documents_collection_strategic_bonus_apy_idx'] },
  { rocks: 'x:t-i', postgres: ['indexer_documents_pool_target_asset_id_idx'] },
  { rocks: 'x:pools-active-id', postgres: ['indexer_documents_collection_base_asset_reserves_idx'] },
  { rocks: 'x:p-t', postgres: ['indexer_documents_pool_snapshots_pool_type_timestamp_idx'] },
  { rocks: 'x:p-t', postgres: ['indexer_documents_pool_snapshots_pool_type_timestamp_idx'] },
  { rocks: 'x:r-i', postgres: ['indexer_documents_referrer_rewards_referrer_id_idx'] },
  { rocks: 'document', postgres: ['indexer_documents_pkey'] },
  { rocks: 'document', postgres: ['indexer_documents_pkey'] },
  { rocks: 'x:v-t', postgres: ['indexer_documents_vault_events_vault_timestamp_idx'] },
  { rocks: 'x:v-t', postgres: ['indexer_documents_vault_events_vault_timestamp_idx'] },
  { rocks: 'x:o-u', postgres: ['indexer_documents_vault_owner_updated_block_idx'] },
  { rocks: 'x:assets-price-id', postgres: ['indexer_documents_collection_price_usd_idx'] },
  { rocks: 'x:a-t', postgres: ['indexer_documents_history_address_timestamp_idx'] },
  { rocks: 'id', postgres: ['indexer_documents_pkey'] },
];

const postgresPhysicalIndexes = new Set([
  'indexer_documents_pkey',
  ...POSTGRES_SECONDARY_INDEX_DEFINITIONS.map(({ name }) => name),
]);

describe('pinned official UI public query plans', () => {
  it.each(OFFICIAL_CONNECTION_SHAPES)('$source', ({ collection, orderBy, filter }) => {
    expect(() => validatePublicConnectionQuery(collection, orderBy, filter)).not.toThrow();
  });

  it('keeps the inventory explicit and complete', () => {
    expect(OFFICIAL_CONNECTION_SHAPES).toHaveLength(34);
    expect(new Set(OFFICIAL_CONNECTION_SHAPES.map(({ source }) => source)).size).toBe(34);
    expect(OFFICIAL_PHYSICAL_PLANS).toHaveLength(OFFICIAL_CONNECTION_SHAPES.length);
  });

  it('retains only the broad JSON containment indexes still required by wallet filters', () => {
    expect([...postgresPhysicalIndexes]).toEqual(
      expect.arrayContaining([
        'indexer_documents_history_data_assets_gin_idx',
        'indexer_documents_history_call_names_gin_idx',
      ])
    );
    expect(postgresPhysicalIndexes).not.toContain('indexer_documents_history_data_gin_idx');
  });

  it('binds every admitted shape to a compact RocksDB source and an audited Postgres index', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'official-query-plan-'));
    const repository = new RocksRepository({
      rocksdbPath: join(tempDir, 'indexer.rocksdb'),
      rocksdbBlockCacheMb: 1,
      rocksdbWriteBufferManagerMb: 1,
      rocksdbParallelism: 1,
      rocksdbEnableStats: false,
      rocksdbDocumentCacheMax: 10,
    } as AppConfig);
    const planner = repository as unknown as {
      selectQuerySource(
        collection: OfficialConnectionShape['collection'],
        args: RepositoryQueryArgs
      ): {
        reason: string;
        ranges: Array<{ options: Record<string, unknown> }>;
        preservesOrder: boolean;
        boundedSort?: boolean;
      };
    };

    try {
      OFFICIAL_CONNECTION_SHAPES.forEach(({ source, collection, orderBy, filter }, index) => {
        const expected = OFFICIAL_PHYSICAL_PLANS[index];
        expect(expected, source).toBeDefined();
        const plan = planner.selectQuerySource(collection, {
          first: PUBLIC_PAGE_SIZE,
          orderBy,
          filter,
          includeTotalCount: false,
        });
        expect(plan.reason, source).toBe(expected?.rocks);
        expect(plan.ranges.length, source).toBeGreaterThan(0);
        expect(plan.preservesOrder || plan.boundedSort, source).toBe(true);
        expect(['x:scan-id', 'x:scan-sort', 'x:missing-t', 'x:missing-b'], source).not.toContain(plan.reason);
        if (expected?.rocksIndexCodes) {
          expect(
            plan.ranges.map(({ options }) =>
              Array.isArray(options.start) ? options.start[2] : undefined
            ),
            source
          ).toEqual(expected.rocksIndexCodes);
        }
        for (const indexName of expected?.postgres ?? []) {
          expect(postgresPhysicalIndexes.has(indexName), `${source}: ${indexName}`).toBe(true);
        }
      });
    } finally {
      await repository.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
