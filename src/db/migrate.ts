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
