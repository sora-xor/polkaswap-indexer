import { createHash } from 'node:crypto';

import pg from 'pg';

import { readConfig } from '../config.js';
import { POSTGRES_WORKER_LEASE_FENCE_TABLE_SQL } from '../postgres-worker-fence.js';
import { INDEXER_COLLECTIONS } from '../repository/types.js';
import {
  INDEXED_EQUALITY_DATA_FIELDS,
  QUERYABLE_DECIMAL_FIELDS_BY_COLLECTION,
} from '../repository/validation.js';

const { Pool } = pg;

const NUMERIC_TEXT_PATTERN = "^-?[0-9]+(\\.[0-9]+)?$";
const MIGRATION_LOCK_KEY = 4_350_435_000;

export type MigrationRuntimeConfig = Pick<
  import('../config.js').AppConfig,
  | 'databaseUrl'
  | 'postgresConnectionTimeoutMs'
  | 'postgresMigrationQueryTimeoutMs'
  | 'postgresMigrationStatementTimeoutMs'
>;

const migrationRuntimeConfig = (input: string | MigrationRuntimeConfig): MigrationRuntimeConfig =>
  typeof input === 'string'
    ? {
        databaseUrl: input,
        postgresConnectionTimeoutMs: 10_000,
        postgresMigrationQueryTimeoutMs: 0,
        postgresMigrationStatementTimeoutMs: 0,
      }
    : input;

const isSafeJsonField = (field: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(field);

const numericJsonExpression = (field: string): string => {
  if (!isSafeJsonField(field)) {
    throw new Error(`Unsupported JSON field in migration index: ${field}`);
  }

  return `(case when jsonb_typeof(data->'${field}') in ('number', 'string') and nullif(data->>'${field}', '') ~ '${NUMERIC_TEXT_PATTERN}' then (data->>'${field}')::numeric else null end)`;
};

const numericIndexCollections = {
  liquidity: ['assets'],
  liquidityBooks: ['assets'],
  priceUSD: ['assets'],
  baseAssetReserves: ['poolXYKs'],
  strategicBonusApy: ['poolXYKs'],
} satisfies Record<string, string[]>;

const collectionPredicate = (collections: string[]): string => {
  if (!collections.length) {
    throw new Error('Numeric index must be scoped to at least one collection');
  }

  const quotedCollections = collections.map((collection) => `'${collection.replace(/'/g, "''")}'`).join(', ');

  return `collection in (${quotedCollections})`;
};

export type PostgresQueryIndexDefinition = {
  name: string;
  definition: string;
  predicate: string;
  using?: 'btree' | 'gin';
};

export type PostgresDocumentCheckConstraint = {
  name: string;
  expression: string;
};

/**
 * PostgreSQL JSONB can hold arbitrary-precision numeric values while the Node
 * and RocksDB representations use IEEE-754 numbers. These immutable helpers
 * reject a direct-SQL value unless converting it to the shortest float8 decimal
 * preserves its exact numeric value. Integer-valued numbers are restricted to
 * the JavaScript safe-integer domain shared by both engines.
 */
export const POSTGRES_EXACT_JSON_NUMERIC_FUNCTIONS_SQL = `
  create or replace function indexer_json_number_is_exact_v1(candidate numeric)
  returns boolean
  language plpgsql
  immutable
  strict
  parallel safe
  set extra_float_digits = 1
  as $$
  declare rendered text;
  begin
    if trunc(candidate) = candidate then
      return candidate between -9007199254740991 and 9007199254740991;
    end if;

    begin
      rendered := (candidate::double precision)::text;
    exception when numeric_value_out_of_range then
      return false;
    end;
    if rendered in ('Infinity', '-Infinity', 'NaN') then return false; end if;
    return rendered::numeric = candidate;
  exception when numeric_value_out_of_range then
    return false;
  end;
  $$;

  create or replace function indexer_json_numbers_are_exact_v1(candidate jsonb)
  returns boolean
  language sql
  immutable
  strict
  parallel safe
  as $$
    select not exists (
      select 1
        from jsonb_path_query(
               candidate,
               'strict $.** ? (@.type() == "number")'
             ) as numeric_values(value)
       where case
         when octet_length(value #>> '{}') > 1024 then true
         else not indexer_json_number_is_exact_v1((value #>> '{}')::numeric)
       end
    )
  $$;
`;

const quotedIndexerCollections = INDEXER_COLLECTIONS.map(
  (collection) => `'${collection.replace(/'/g, "''")}'`
).join(', ');

/** Database-level backstop for the repository write contract. */
export const POSTGRES_DOCUMENT_CHECK_CONSTRAINTS: readonly PostgresDocumentCheckConstraint[] = [
  {
    name: 'indexer_documents_collection_v1_check',
    expression: `collection in (${quotedIndexerCollections})`,
  },
  {
    name: 'indexer_documents_id_v1_check',
    expression: `char_length(id) between 1 and 1024 and id collate "C" ~ '^[!-~]+$'`,
  },
  {
    name: 'indexer_documents_block_height_v1_check',
    expression: `block_height is null or block_height between 0 and 9007199254740991`,
  },
  {
    name: 'indexer_documents_timestamp_v1_check',
    expression: `timestamp is null or timestamp between 0 and 9007199254740991`,
  },
  {
    name: 'indexer_documents_data_v1_check',
    expression: `jsonb_typeof(data) = 'object' and octet_length(data::text) <= 33554432`,
  },
  {
    name: 'indexer_documents_data_id_v1_check',
    expression: `case when data ? 'id' then jsonb_typeof(data->'id') = 'string' and data->>'id' = id else true end`,
  },
  {
    name: 'indexer_documents_data_block_height_v1_check',
    expression: `case when not data ? 'blockHeight' then true when jsonb_typeof(data->'blockHeight') = 'null' then block_height is null when jsonb_typeof(data->'blockHeight') <> 'number' then false else block_height is not null and (data->>'blockHeight')::numeric = block_height end`,
  },
  {
    name: 'indexer_documents_data_timestamp_v1_check',
    expression: `case when not data ? 'timestamp' then true when jsonb_typeof(data->'timestamp') = 'null' then timestamp is null when jsonb_typeof(data->'timestamp') <> 'number' then false else timestamp is not null and (data->>'timestamp')::numeric = timestamp end`,
  },
  {
    name: 'indexer_documents_json_numbers_v1_check',
    expression: `indexer_json_numbers_are_exact_v1(data)`,
  },
  {
    name: 'indexer_documents_indexed_strings_v1_check',
    expression: `(${[
      ...[...INDEXED_EQUALITY_DATA_FIELDS].filter((field) => field !== 'marketId').map(
        (field) =>
          `(not data ? '${field}' or jsonb_typeof(data->'${field}') = 'null' or (jsonb_typeof(data->'${field}') = 'string' and octet_length(data->>'${field}') <= 256))`
      ),
      `(not data ? 'marketId' or jsonb_typeof(data->'marketId') = 'null' or (jsonb_typeof(data->'marketId') in ('string', 'number') and octet_length(data->>'marketId') <= 256))`,
      ...['to', 'assetId'].map(
        (field) =>
          `(jsonb_typeof(data->'data') <> 'object' or not (data->'data') ? '${field}' or jsonb_typeof(data->'data'->'${field}') = 'null' or (jsonb_typeof(data->'data'->'${field}') = 'string' and octet_length(data->'data'->>'${field}') <= 256))`
      ),
    ].join(' and ')})`,
  },
  {
    name: 'indexer_documents_indexed_decimals_v1_check',
    expression: `(${Object.entries(QUERYABLE_DECIMAL_FIELDS_BY_COLLECTION).flatMap(
      ([collection, fields]) =>
        (fields ?? []).map(
          (field) =>
            `(collection <> '${collection}' or not data ? '${field}' or (octet_length(data->>'${field}') between 1 and 256 and data->>'${field}' collate "C" ~ '^-?[0-9]+(\\.[0-9]+)?$'))`
        )
    ).join(' and ')})`,
  },
] as const;

/**
 * Composite/partial indexes that mirror the equality-prefix RocksDB plans.
 * Keeping this manifest explicit makes the public GraphQL policy auditable and
 * avoids broad JSON indexes whose entries would be written for unrelated
 * collections.
 */
export const POSTGRES_QUERY_INDEX_DEFINITIONS: readonly PostgresQueryIndexDefinition[] = [
  {
    name: 'indexer_documents_bounded_timestamp_id_idx',
    definition: `collection collate "C", timestamp, id collate "C"`,
    predicate: collectionPredicate([
      'accountTransactions',
      'assetSnapshots',
      'networkSnapshots',
      'orderBookOrders',
      'orderBookSnapshots',
    ]),
  },
  {
    name: 'indexer_documents_history_assets_burn_address_block_idx',
    definition: `(data->>'address'), block_height, id collate "C"`,
    predicate: `collection = 'historyElements' and data->>'module' = 'assets' and data->>'method' = 'burn' and data->>'address' is not null`,
  },
  {
    name: 'indexer_documents_history_eth_bridge_out_address_block_idx',
    definition: `(data->>'address'), block_height, id collate "C"`,
    predicate: `collection = 'historyElements' and data->>'module' = 'ethBridge' and data->>'method' = 'transferToSidechain' and data->>'address' is not null`,
  },
  {
    name: 'indexer_documents_history_bridge_in_to_block_idx',
    definition: `(data->'data'->>'to'), block_height, id collate "C"`,
    predicate: `collection = 'historyElements' and data->>'module' = 'bridgeMultisig' and data->>'method' = 'asMulti' and data->'data'->>'to' is not null`,
  },
  {
    name: 'indexer_documents_history_liquidity_swap_address_block_idx',
    definition: `(data->>'address'), block_height, id collate "C"`,
    predicate: `collection = 'historyElements' and data->>'module' = 'liquidityProxy' and data->>'method' = 'swap' and data->>'address' is not null`,
  },
  {
    name: 'indexer_documents_history_pool_deposit_address_block_idx',
    definition: `(data->>'address'), block_height, id collate "C"`,
    predicate: `collection = 'historyElements' and data->>'module' = 'poolXYK' and data->>'method' = 'depositLiquidity' and data->>'address' is not null`,
  },
  {
    name: 'indexer_documents_history_pool_withdraw_address_block_idx',
    definition: `(data->>'address'), block_height, id collate "C"`,
    predicate: `collection = 'historyElements' and data->>'module' = 'poolXYK' and data->>'method' = 'withdrawLiquidity' and data->>'address' is not null`,
  },
  {
    name: 'indexer_documents_history_assets_burn_asset_block_idx',
    definition: `(data->'data'->>'assetId'), block_height, id collate "C"`,
    predicate: `collection = 'historyElements' and data->>'module' = 'assets' and data->>'method' = 'burn' and data->'data'->>'assetId' is not null`,
  },
  {
    name: 'indexer_documents_account_liquidity_id_timestamp_idx',
    definition: `(data->>'accountLiquidityId'), timestamp, id collate "C"`,
    predicate: `collection = 'accountLiquiditySnapshots'`,
  },
  {
    name: 'indexer_documents_account_liquidity_type_timestamp_idx',
    definition: `(data->>'type'), timestamp, id collate "C"`,
    predicate: `collection = 'accountLiquiditySnapshots'`,
  },
  {
    name: 'indexer_documents_account_positions_account_timestamp_idx',
    definition: `(data->>'account'), timestamp, id collate "C"`,
    predicate: `collection = 'accountPositions'`,
  },
  {
    name: 'indexer_documents_account_transactions_account_timestamp_idx',
    definition: `(data->>'accountId'), timestamp, id collate "C"`,
    predicate: `collection = 'accountTransactions'`,
  },
  {
    name: 'indexer_documents_account_points_account_id_idx',
    definition: `(data->>'accountId'), id collate "C"`,
    predicate: `collection = 'accountPointSystems'`,
  },
  {
    name: 'indexer_documents_asset_snapshots_asset_type_timestamp_idx',
    definition: `(data->>'assetId'), (data->>'type'), timestamp, id collate "C"`,
    predicate: `collection = 'assetSnapshots'`,
  },
  {
    name: 'indexer_documents_asset_snapshots_type_timestamp_idx',
    definition: `(data->>'type'), timestamp, id collate "C"`,
    predicate: `collection = 'assetSnapshots'`,
  },
  {
    name: 'indexer_documents_asset_snapshots_asset_block_idx',
    definition: `(data->>'assetId'), block_height, id collate "C"`,
    predicate: `collection = 'assetSnapshots'`,
  },
  {
    name: 'indexer_documents_history_address_timestamp_idx',
    definition: `(data->>'address'), timestamp, id collate "C"`,
    predicate: `collection = 'historyElements'`,
  },
  {
    name: 'indexer_documents_history_timestamp_idx',
    definition: `timestamp, id collate "C"`,
    predicate: `collection = 'historyElements'`,
  },
  {
    name: 'indexer_documents_history_polkamarkt_timestamp_idx',
    definition: `timestamp, id collate "C"`,
    predicate: `collection = 'historyElements' and data->>'module' = 'polkamarkt'`,
  },
  {
    name: 'indexer_documents_market_snapshots_market_type_timestamp_idx',
    definition: `${numericJsonExpression('marketId')}, (data->>'type'), timestamp, id collate "C"`,
    predicate: `collection = 'marketSnapshots'`,
  },
  {
    name: 'indexer_documents_market_snapshots_type_timestamp_idx',
    definition: `(data->>'type'), timestamp, id collate "C"`,
    predicate: `collection = 'marketSnapshots'`,
  },
  {
    name: 'indexer_documents_market_snapshots_market_type_block_idx',
    definition: `${numericJsonExpression('marketId')}, (data->>'type'), block_height, id collate "C"`,
    predicate: `collection = 'marketSnapshots'`,
  },
  {
    name: 'indexer_documents_network_snapshots_type_timestamp_idx',
    definition: `(data->>'type'), timestamp, id collate "C"`,
    predicate: `collection = 'networkSnapshots'`,
  },
  {
    name: 'indexer_documents_network_snapshots_type_block_idx',
    definition: `(data->>'type'), block_height, id collate "C"`,
    predicate: `collection = 'networkSnapshots'`,
  },
  {
    name: 'indexer_documents_order_books_base_id_idx',
    definition: `(data->>'baseAssetId'), id collate "C"`,
    predicate: `collection = 'orderBooks'`,
  },
  {
    name: 'indexer_documents_order_books_quote_id_idx',
    definition: `(data->>'quoteAssetId'), id collate "C"`,
    predicate: `collection = 'orderBooks'`,
  },
  {
    name: 'indexer_documents_order_book_orders_account_timestamp_idx',
    definition: `(data->>'accountId'), timestamp, id collate "C"`,
    predicate: `collection = 'orderBookOrders'`,
  },
  {
    name: 'indexer_documents_order_book_orders_book_timestamp_idx',
    definition: `(data->>'orderBookId'), timestamp, id collate "C"`,
    predicate: `collection = 'orderBookOrders'`,
  },
  {
    name: 'indexer_documents_order_book_snapshots_book_type_timestamp_idx',
    definition: `(data->>'orderBookId'), (data->>'type'), timestamp, id collate "C"`,
    predicate: `collection = 'orderBookSnapshots'`,
  },
  {
    name: 'indexer_documents_order_book_snapshots_type_timestamp_idx',
    definition: `(data->>'type'), timestamp, id collate "C"`,
    predicate: `collection = 'orderBookSnapshots'`,
  },
  {
    name: 'indexer_documents_pool_base_asset_id_idx',
    definition: `(data->>'baseAssetId'), id collate "C"`,
    predicate: `collection = 'poolXYKs'`,
  },
  {
    name: 'indexer_documents_pool_target_asset_id_idx',
    definition: `(data->>'targetAssetId'), id collate "C"`,
    predicate: `collection = 'poolXYKs'`,
  },
  {
    name: 'indexer_documents_pool_snapshots_pool_type_timestamp_idx',
    definition: `(data->>'poolId'), (data->>'type'), timestamp, id collate "C"`,
    predicate: `collection = 'poolSnapshots'`,
  },
  {
    name: 'indexer_documents_pool_snapshots_type_timestamp_idx',
    definition: `(data->>'type'), timestamp, id collate "C"`,
    predicate: `collection = 'poolSnapshots'`,
  },
  {
    name: 'indexer_documents_referrer_rewards_referrer_id_idx',
    definition: `(data->>'referrer'), id collate "C"`,
    predicate: `collection = 'referrerRewards'`,
  },
  {
    name: 'indexer_documents_staking_validators_address_id_idx',
    definition: `(data->>'address'), id collate "C"`,
    predicate: `collection = 'stakingValidators'`,
  },
  {
    name: 'indexer_documents_vault_owner_id_idx',
    definition: `(data->>'ownerId'), id collate "C"`,
    predicate: `collection = 'vaults'`,
  },
  {
    name: 'indexer_documents_vault_owner_updated_block_idx',
    definition: `(data->>'ownerId'), ${numericJsonExpression('updatedAtBlock')}, id collate "C"`,
    predicate: `collection = 'vaults'`,
  },
  {
    name: 'indexer_documents_vault_events_vault_timestamp_idx',
    definition: `(data->>'vaultId'), timestamp, id collate "C"`,
    predicate: `collection = 'vaultEvents'`,
  },
] as const;

const numericIndexNames = {
  liquidity: 'indexer_documents_collection_liquidity_idx',
  liquidityBooks: 'indexer_documents_collection_liquidity_books_idx',
  priceUSD: 'indexer_documents_collection_price_usd_idx',
  baseAssetReserves: 'indexer_documents_collection_base_asset_reserves_idx',
  strategicBonusApy: 'indexer_documents_collection_strategic_bonus_apy_idx',
} satisfies Record<keyof typeof numericIndexCollections, string>;

export const POSTGRES_NUMERIC_INDEX_DEFINITIONS: readonly PostgresQueryIndexDefinition[] = Object.entries(
  numericIndexCollections
).map(([field, collections]) => ({
  name: numericIndexNames[field as keyof typeof numericIndexCollections],
  definition: `${numericJsonExpression(field)}, id collate "C"`,
  predicate: collectionPredicate(collections),
}));

export const POSTGRES_HISTORY_GIN_INDEX_DEFINITIONS: readonly PostgresQueryIndexDefinition[] = [
  {
    name: 'indexer_documents_history_data_assets_gin_idx',
    definition: `(data->'dataAssets') jsonb_path_ops`,
    predicate: `collection = 'historyElements'`,
    using: 'gin',
  },
  {
    name: 'indexer_documents_history_call_names_gin_idx',
    definition: `(data->'callNames') jsonb_path_ops`,
    predicate: `collection = 'historyElements'`,
    using: 'gin',
  },
] as const;

export const POSTGRES_SECONDARY_INDEX_DEFINITIONS: readonly PostgresQueryIndexDefinition[] = [
  ...POSTGRES_QUERY_INDEX_DEFINITIONS,
  ...POSTGRES_NUMERIC_INDEX_DEFINITIONS,
  ...POSTGRES_HISTORY_GIN_INDEX_DEFINITIONS,
];

const quoteIdentifier = (value: string): string => `"${value.replace(/"/g, '""')}"`;

const indexManifestComment = ({ definition, predicate, using = 'btree' }: PostgresQueryIndexDefinition): string => {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ table: 'indexer_documents', using, definition, predicate }))
    .digest('hex');
  return `polkaswap-indexer:index-v1:${fingerprint}`;
};

const constraintManifestComment = ({ expression }: PostgresDocumentCheckConstraint): string => {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ table: 'indexer_documents', kind: 'check', expression }))
    .digest('hex');
  return `polkaswap-indexer:constraint-v1:${fingerprint}`;
};

const OBSOLETE_BROAD_QUERY_INDEXES = [
  'indexer_documents_collection_id_c_idx',
  'indexer_documents_collection_type_timestamp_id_idx',
  'indexer_documents_collection_asset_id_idx',
  'indexer_documents_collection_account_id_idx',
  'indexer_documents_collection_address_idx',
  'indexer_documents_collection_data_from_idx',
  'indexer_documents_collection_data_to_idx',
  'indexer_documents_collection_module_method_timestamp_id_idx',
  'indexer_documents_collection_order_book_id_idx',
  'indexer_documents_collection_asset_type_timestamp_id_idx',
  'indexer_documents_collection_pool_type_timestamp_id_idx',
  'indexer_documents_collection_order_book_type_timestamp_id_idx',
  'indexer_documents_collection_status_idx',
  'indexer_documents_collection_timestamp_id_idx',
  'indexer_documents_collection_block_id_idx',
  'indexer_documents_history_block_id_idx',
  'indexer_documents_history_module_method_block_id_idx',
  'indexer_documents_history_address_module_method_block_id_idx',
  'indexer_documents_history_payload_to_module_method_block_id_idx',
  'indexer_documents_history_payload_asset_module_method_block_id_idx',
  'indexer_documents_history_data_from_timestamp_idx',
  'indexer_documents_history_data_to_timestamp_idx',
  'indexer_documents_history_module_timestamp_idx',
  'indexer_documents_account_transactions_history_id_idx',
  'indexer_documents_data_gin_idx',
  'indexer_documents_history_data_gin_idx',
  'indexer_documents_collection_updated_at_block_idx',
  'indexer_documents_collection_created_at_block_idx',
  'indexer_documents_collection_price_change_day_idx',
  'indexer_documents_collection_liquidity_usd_idx',
  'indexer_documents_collection_pool_token_price_usd_idx',
  'indexer_documents_collection_price_change_week_idx',
  'indexer_documents_collection_volume_day_usd_idx',
  'indexer_documents_collection_volume_week_usd_idx',
  'indexer_documents_collection_volume_usd_idx',
  'indexer_documents_collection_target_asset_reserves_idx',
  'indexer_documents_collection_amount_idx',
  'indexer_documents_collection_apy_idx',
  'indexer_documents_collection_commission_idx',
  'indexer_documents_collection_reward_points_idx',
] as const;

export async function migrate(input: string | MigrationRuntimeConfig = readConfig()): Promise<void> {
  const config = migrationRuntimeConfig(input);
  const pool = new Pool({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: config.postgresConnectionTimeoutMs,
    query_timeout: config.postgresMigrationQueryTimeoutMs,
    statement_timeout: config.postgresMigrationStatementTimeoutMs,
  });
  pool.on('error', () => {
    console.error('PostgreSQL migration pool reported an idle client error');
  });
  const client = await pool.connect();
  const ensureAuditedIndex = async (definition: PostgresQueryIndexDefinition) => {
    const { name, predicate, using = 'btree' } = definition;
    const expectedComment = indexManifestComment(definition);
    const existing = await client.query<{
      indexdef: string;
      manifestComment: string | null;
      isValid: boolean;
    }>(
      `select pg_get_indexdef(i.indexrelid) as indexdef,
              obj_description(i.indexrelid, 'pg_class') as "manifestComment",
              i.indisvalid as "isValid"
       from pg_index i
       where i.indexrelid = to_regclass($1)`,
      [name]
    );
    const current = existing.rows[0];
    if (current && (current.manifestComment !== expectedComment || current.isValid !== true)) {
      await client.query(`drop index concurrently ${quoteIdentifier(name)};`);
    }
    if (!current || current.manifestComment !== expectedComment || current.isValid !== true) {
      await client.query(
        `create index concurrently ${quoteIdentifier(name)} on indexer_documents using ${using} (${definition.definition}) where ${predicate};`
      );
      await client.query(`comment on index ${quoteIdentifier(name)} is '${expectedComment}';`);
    }
  };
  const ensureDocumentCheckConstraint = async ({
    name,
    expression,
  }: PostgresDocumentCheckConstraint): Promise<boolean> => {
    const expectedComment = constraintManifestComment({ name, expression });
    const existing = await client.query<{
      manifestComment: string | null;
      isValid: boolean;
    }>(
      `select obj_description(c.oid, 'pg_constraint') as "manifestComment",
              c.convalidated as "isValid"
       from pg_constraint c
       where c.conrelid = 'indexer_documents'::regclass
         and c.conname = $1
         and c.contype = 'c'`,
      [name]
    );
    let current: (typeof existing.rows)[number] | undefined = existing.rows[0];

    if (current && current.manifestComment !== expectedComment) {
      await client.query(`alter table indexer_documents drop constraint ${quoteIdentifier(name)};`);
      current = undefined;
    }
    if (!current) {
      await client.query(
        `alter table indexer_documents add constraint ${quoteIdentifier(name)} check (${expression}) not valid;`
      );
      await client.query(
        `comment on constraint ${quoteIdentifier(name)} on indexer_documents is '${expectedComment}';`
      );
      return false;
    }

    return current.isValid === true;
  };

  try {
    await client.query('select pg_advisory_lock($1);', [MIGRATION_LOCK_KEY]);
    await client.query(POSTGRES_EXACT_JSON_NUMERIC_FUNCTIONS_SQL);
    await client.query(`
      create table if not exists indexer_documents (
        collection text collate "C" not null,
        id text collate "C" not null,
        block_height bigint,
        timestamp bigint,
        data jsonb not null,
        updated_at timestamptz not null default now(),
        primary key (collection, id)
      );
    `);
    // The migration owner provisions the worker fence so the runtime worker
    // role needs DML, not schema-creation privileges, during normal startup.
    await client.query(POSTGRES_WORKER_LEASE_FENCE_TABLE_SQL);
    await client.query(`
      do $$
      begin
        if exists (
          select 1
          from pg_attribute
          where attrelid = 'indexer_documents'::regclass
            and attname in ('collection', 'id')
            and attcollation <> '"C"'::regcollation
        ) then
          raise exception 'indexer_documents collection/id collation drift: rebuild the first-release database with C collation';
        end if;
      end
      $$;
    `);
    const pendingConstraintValidation: PostgresDocumentCheckConstraint[] = [];
    for (const constraint of POSTGRES_DOCUMENT_CHECK_CONSTRAINTS) {
      if (!(await ensureDocumentCheckConstraint(constraint))) pendingConstraintValidation.push(constraint);
    }
    for (const { name } of pendingConstraintValidation) {
      await client.query(
        `alter table indexer_documents validate constraint ${quoteIdentifier(name)};`
      );
    }
    await client.query('drop index if exists indexer_documents_collection_timestamp_idx;');
    await client.query('drop index if exists indexer_documents_collection_block_idx;');
    for (const name of OBSOLETE_BROAD_QUERY_INDEXES) {
      await client.query(`drop index if exists ${quoteIdentifier(name)};`);
    }
    for (const definition of POSTGRES_SECONDARY_INDEX_DEFINITIONS) {
      await ensureAuditedIndex(definition);
    }
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
