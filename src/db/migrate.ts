import pg from 'pg';

import { readConfig } from '../config.js';

const { Pool } = pg;

const NUMERIC_TEXT_PATTERN = "^-?[0-9]+(\\.[0-9]+)?$";

const isSafeJsonField = (field: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(field);

const numericJsonExpression = (field: string): string => {
  if (!isSafeJsonField(field)) {
    throw new Error(`Unsupported JSON field in migration index: ${field}`);
  }

  return `(case when jsonb_typeof(data->'${field}') in ('number', 'string') and nullif(data->>'${field}', '') ~ '${NUMERIC_TEXT_PATTERN}' then (data->>'${field}')::numeric else 0 end)`;
};

export async function migrate(databaseUrl = readConfig().databaseUrl): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  const createNumericIndex = (name: string, field: string) =>
    pool.query(`create index if not exists ${name} on indexer_documents(collection, ${numericJsonExpression(field)}, id);`);

  try {
    await pool.query(`
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
    await pool.query(
      'create index if not exists indexer_documents_collection_timestamp_idx on indexer_documents(collection, timestamp desc);'
    );
    await pool.query(
      'create index if not exists indexer_documents_collection_block_idx on indexer_documents(collection, block_height desc);'
    );
    await pool.query(
      'create index if not exists indexer_documents_data_gin_idx on indexer_documents using gin(data jsonb_path_ops);'
    );
    await pool.query(
      'create index if not exists indexer_documents_collection_timestamp_id_idx on indexer_documents(collection, timestamp, id);'
    );
    await pool.query(
      'create index if not exists indexer_documents_collection_type_timestamp_id_idx on indexer_documents(collection, (data->>\'type\'), timestamp, id);'
    );
    await pool.query(
      'create index if not exists indexer_documents_collection_asset_id_idx on indexer_documents(collection, (data->>\'assetId\'));'
    );
    await pool.query(
      'create index if not exists indexer_documents_collection_account_id_idx on indexer_documents(collection, (data->>\'accountId\'));'
    );
    await pool.query(
      'create index if not exists indexer_documents_collection_address_idx on indexer_documents(collection, (data->>\'address\'));'
    );
    await pool.query(
      'create index if not exists indexer_documents_collection_order_book_id_idx on indexer_documents(collection, (data->>\'orderBookId\'));'
    );
    await pool.query(
      'create index if not exists indexer_documents_collection_asset_type_timestamp_id_idx on indexer_documents(collection, (data->>\'assetId\'), (data->>\'type\'), timestamp, id);'
    );
    await pool.query(
      'create index if not exists indexer_documents_collection_pool_type_timestamp_id_idx on indexer_documents(collection, (data->>\'poolId\'), (data->>\'type\'), timestamp, id);'
    );
    await pool.query(
      'create index if not exists indexer_documents_collection_order_book_type_timestamp_id_idx on indexer_documents(collection, (data->>\'orderBookId\'), (data->>\'type\'), timestamp, id);'
    );
    await pool.query(
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
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
