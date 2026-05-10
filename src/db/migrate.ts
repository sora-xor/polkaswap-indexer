import pg from 'pg';

import { readConfig } from '../config.js';

const { Pool } = pg;

export async function migrate(databaseUrl = readConfig().databaseUrl): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });

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
    await pool.query(
      'create index if not exists indexer_documents_collection_updated_at_block_idx on indexer_documents(collection, ((coalesce(nullif(data->>\'updatedAtBlock\', \'\'), \'0\'))::numeric), id);'
    );
    await pool.query(
      'create index if not exists indexer_documents_collection_created_at_block_idx on indexer_documents(collection, ((coalesce(nullif(data->>\'createdAtBlock\', \'\'), \'0\'))::numeric), id);'
    );
    await pool.query(
      'create index if not exists indexer_documents_collection_price_change_day_idx on indexer_documents(collection, ((coalesce(nullif(data->>\'priceChangeDay\', \'\'), \'0\'))::numeric), id);'
    );
    await pool.query(
      'create index if not exists indexer_documents_collection_liquidity_idx on indexer_documents(collection, ((coalesce(nullif(data->>\'liquidity\', \'\'), \'0\'))::numeric), id);'
    );
    await pool.query(
      'create index if not exists indexer_documents_collection_liquidity_books_idx on indexer_documents(collection, ((coalesce(nullif(data->>\'liquidityBooks\', \'\'), \'0\'))::numeric), id);'
    );
    await pool.query(
      'create index if not exists indexer_documents_collection_volume_day_usd_idx on indexer_documents(collection, ((coalesce(nullif(data->>\'volumeDayUSD\', \'\'), \'0\'))::numeric), id);'
    );
    await pool.query(
      'create index if not exists indexer_documents_collection_volume_week_usd_idx on indexer_documents(collection, ((coalesce(nullif(data->>\'volumeWeekUSD\', \'\'), \'0\'))::numeric), id);'
    );
    await pool.query(
      'create index if not exists indexer_documents_collection_amount_idx on indexer_documents(collection, ((coalesce(nullif(data->>\'amount\', \'\'), \'0\'))::numeric), id);'
    );
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
