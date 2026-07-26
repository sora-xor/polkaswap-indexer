import pg from 'pg';

import { readConfig } from '../config.js';
import { POSTGRES_TRUSTED_SESSION_OPTIONS } from '../postgres-session.js';
import { assertPostgresReclaimConfirmation, readStrictBoolean, readStrictEnum } from './env.js';

const { Pool } = pg;

type IndexRow = {
  schemaName: string;
  indexName: string;
  sizeBytes: string;
  sizePretty: string;
  definition: string;
  isPrimary: boolean;
};

const DEFAULT_DROP_INDEXES = new Set([
  'indexer_documents_collection_module_method_timestamp_id_idx',
  'indexer_documents_collection_asset_type_timestamp_id_idx',
  'indexer_documents_collection_pool_type_timestamp_id_idx',
  'indexer_documents_collection_order_book_type_timestamp_id_idx',
  'indexer_documents_collection_type_timestamp_id_idx',
  'indexer_documents_data_gin_idx',
  'indexer_documents_collection_liquidity_usd_idx',
  'indexer_documents_collection_volume_usd_idx',
  'indexer_documents_collection_target_asset_reserves_idx',
  'indexer_documents_collection_base_asset_reserves_idx',
  'indexer_documents_collection_pool_token_price_usd_idx',
]);

const DEFAULT_KEEP_INDEXES = new Set([
  'indexer_documents_pkey',
  'indexer_documents_collection_timestamp_idx',
  'indexer_documents_collection_block_idx',
  'indexer_documents_collection_timestamp_id_idx',
  'indexer_documents_collection_asset_id_idx',
  'indexer_documents_collection_account_id_idx',
  'indexer_documents_collection_address_idx',
  'indexer_documents_collection_data_from_idx',
  'indexer_documents_collection_data_to_idx',
  'indexer_documents_collection_order_book_id_idx',
  'indexer_documents_collection_status_idx',
]);

const readNameSet = (name: string): Set<string> =>
  new Set(
    (process.env[name] ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  );

const quoteIdentifier = (name: string): string => `"${name.replace(/"/g, '""')}"`;

const indexSqlName = (row: IndexRow): string => `${quoteIdentifier(row.schemaName)}.${quoteIdentifier(row.indexName)}`;

const mode = readStrictEnum(process.env, 'POSTGRES_RECLAIM_MODE', ['large', 'all-secondary'] as const, 'large');
const dryRun = readStrictBoolean(process.env, 'POSTGRES_RECLAIM_DRY_RUN', true);
assertPostgresReclaimConfirmation(process.env, dryRun);
const extraDropIndexes = readNameSet('POSTGRES_RECLAIM_EXTRA_DROP_INDEXES');
const extraKeepIndexes = readNameSet('POSTGRES_RECLAIM_KEEP_INDEXES');
const dropIndexes = new Set([...DEFAULT_DROP_INDEXES, ...extraDropIndexes]);
const keepIndexes = new Set([...DEFAULT_KEEP_INDEXES, ...extraKeepIndexes]);
const pool = new Pool({
  connectionString: readConfig().databaseUrl,
  options: POSTGRES_TRUSTED_SESSION_OPTIONS,
});

try {
  const result = await pool.query<IndexRow>(`
    select n.nspname as "schemaName",
           c.relname as "indexName",
           pg_relation_size(c.oid)::text as "sizeBytes",
           pg_size_pretty(pg_relation_size(c.oid)) as "sizePretty",
           pg_get_indexdef(c.oid) as definition,
           i.indisprimary as "isPrimary"
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    join pg_namespace n on n.oid = c.relnamespace
    where i.indrelid = 'indexer_documents'::regclass
    order by pg_relation_size(c.oid) desc;
  `);

  const selected = result.rows.filter((row) => {
    if (row.isPrimary || keepIndexes.has(row.indexName)) return false;
    return mode === 'all-secondary' || dropIndexes.has(row.indexName);
  });

  const totalBytes = selected.reduce((sum, row) => sum + Number(row.sizeBytes), 0);

  console.info(`Postgres index reclaim mode=${mode} dryRun=${dryRun}`);
  console.info(
    `Selected ${selected.length} index(es), estimated reclaim=${Math.round(totalBytes / 1024 / 1024 / 1024)} GiB`
  );

  for (const row of selected) {
    console.info(`${dryRun ? 'would drop' : 'dropping'} ${row.schemaName}.${row.indexName} (${row.sizePretty})`);
    if (dryRun) continue;

    await pool.query(`drop index concurrently if exists ${indexSqlName(row)};`);
  }
} finally {
  await pool.end();
}
