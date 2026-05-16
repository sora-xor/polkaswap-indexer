import pg from 'pg';

import { readConfig } from '../config.js';

const { Pool } = pg;

const NUMERIC_TEXT_PATTERN = "^-?[0-9]+(\\.[0-9]+)?$";
const MIGRATION_LOCK_KEY = 4_350_435_000;

const isSafeJsonField = (field: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(field);

const numericJsonExpression = (field: string): string => {
  if (!isSafeJsonField(field)) {
    throw new Error(`Unsupported JSON field in migration index: ${field}`);
  }

  return `(case when jsonb_typeof(data->'${field}') in ('number', 'string') and nullif(data->>'${field}', '') ~ '${NUMERIC_TEXT_PATTERN}' then (data->>'${field}')::numeric else 0 end)`;
};

export async function migrate(databaseUrl = readConfig().databaseUrl): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  const createNumericIndex = (name: string, field: string) =>
    client.query(`create index if not exists ${name} on indexer_documents(collection, ${numericJsonExpression(field)}, id);`);

  try {
    await client.query('select pg_advisory_lock($1);', [MIGRATION_LOCK_KEY]);
    await client.query(`
      create table if not exists indexer_documents (
        collection text not null,
        id text not null,
        block_height bigint,
        timestamp bigint,
        data jsonb not null,
        updated_at timestamptz not null default now(),
        primary key (collection, id)
      );
    `);
    await client.query(
      'create index if not exists indexer_documents_collection_timestamp_idx on indexer_documents(collection, timestamp desc);'
    );
    await client.query(
      'create index if not exists indexer_documents_collection_block_idx on indexer_documents(collection, block_height desc);'
    );
    await client.query(
      'create index if not exists indexer_documents_data_gin_idx on indexer_documents using gin(data jsonb_path_ops);'
    );
    await client.query(
      'create index if not exists indexer_documents_collection_timestamp_id_idx on indexer_documents(collection, timestamp, id);'
    );
    await client.query(
      'create index if not exists indexer_documents_collection_type_timestamp_id_idx on indexer_documents(collection, (data->>\'type\'), timestamp, id);'
    );
    await client.query(
      'create index if not exists indexer_documents_collection_asset_id_idx on indexer_documents(collection, (data->>\'assetId\'));'
    );
    await client.query(
      'create index if not exists indexer_documents_collection_account_id_idx on indexer_documents(collection, (data->>\'accountId\'));'
    );
    await client.query(
      'create index if not exists indexer_documents_collection_address_idx on indexer_documents(collection, (data->>\'address\'));'
    );
    await client.query(
      'create index if not exists indexer_documents_collection_data_from_idx on indexer_documents(collection, (data->>\'dataFrom\'));'
    );
    await client.query(
      'create index if not exists indexer_documents_collection_data_to_idx on indexer_documents(collection, (data->>\'dataTo\'));'
    );
    await client.query(
      'create index if not exists indexer_documents_history_address_timestamp_idx on indexer_documents((data->>\'address\'), timestamp desc, id desc) where collection = \'historyElements\';'
    );
    await client.query(
      'create index if not exists indexer_documents_history_data_from_timestamp_idx on indexer_documents((data->>\'dataFrom\'), timestamp desc, id desc) where collection = \'historyElements\';'
    );
    await client.query(
      'create index if not exists indexer_documents_history_data_to_timestamp_idx on indexer_documents((data->>\'dataTo\'), timestamp desc, id desc) where collection = \'historyElements\';'
    );
    await client.query(
      'create index if not exists indexer_documents_collection_module_method_timestamp_id_idx on indexer_documents(collection, (data->>\'module\'), (data->>\'method\'), timestamp, id);'
    );
    await client.query(
      'create index if not exists indexer_documents_collection_order_book_id_idx on indexer_documents(collection, (data->>\'orderBookId\'));'
    );
    await client.query(
      'create index if not exists indexer_documents_collection_asset_type_timestamp_id_idx on indexer_documents(collection, (data->>\'assetId\'), (data->>\'type\'), timestamp, id);'
    );
    await client.query(
      'create index if not exists indexer_documents_collection_pool_type_timestamp_id_idx on indexer_documents(collection, (data->>\'poolId\'), (data->>\'type\'), timestamp, id);'
    );
    await client.query(
      'create index if not exists indexer_documents_collection_order_book_type_timestamp_id_idx on indexer_documents(collection, (data->>\'orderBookId\'), (data->>\'type\'), timestamp, id);'
    );
    await client.query(
      'create index if not exists indexer_documents_collection_status_idx on indexer_documents(collection, (data->>\'status\'));'
    );
    await createNumericIndex('indexer_documents_collection_updated_at_block_idx', 'updatedAtBlock');
    await createNumericIndex('indexer_documents_collection_created_at_block_idx', 'createdAtBlock');
    await createNumericIndex('indexer_documents_collection_price_change_day_idx', 'priceChangeDay');
    await createNumericIndex('indexer_documents_collection_liquidity_idx', 'liquidity');
    await createNumericIndex('indexer_documents_collection_liquidity_books_idx', 'liquidityBooks');
    await createNumericIndex('indexer_documents_collection_liquidity_usd_idx', 'liquidityUSD');
    await createNumericIndex('indexer_documents_collection_price_usd_idx', 'priceUSD');
    await createNumericIndex('indexer_documents_collection_pool_token_price_usd_idx', 'poolTokenPriceUSD');
    await createNumericIndex('indexer_documents_collection_price_change_week_idx', 'priceChangeWeek');
    await createNumericIndex('indexer_documents_collection_volume_day_usd_idx', 'volumeDayUSD');
    await createNumericIndex('indexer_documents_collection_volume_week_usd_idx', 'volumeWeekUSD');
    await createNumericIndex('indexer_documents_collection_volume_usd_idx', 'volumeUSD');
    await createNumericIndex('indexer_documents_collection_base_asset_reserves_idx', 'baseAssetReserves');
    await createNumericIndex('indexer_documents_collection_target_asset_reserves_idx', 'targetAssetReserves');
    await createNumericIndex('indexer_documents_collection_amount_idx', 'amount');
    await createNumericIndex('indexer_documents_collection_apy_idx', 'apy');
    await createNumericIndex('indexer_documents_collection_commission_idx', 'commission');
    await createNumericIndex('indexer_documents_collection_reward_points_idx', 'rewardPoints');
  } finally {
    await client.query('select pg_advisory_unlock($1);', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    client.release();
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
