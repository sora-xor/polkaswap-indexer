import pg from 'pg';

import { readConfig } from '../config.js';

const { Pool } = pg;

const CHANGE_SCHEMA = 'polkaswap_indexer_migration';
const CHANGE_TABLE = `${CHANGE_SCHEMA}.rocksdb_changes`;
const CHANGE_TRIGGER = 'indexer_documents_rocksdb_changes_trigger';
const CHANGE_FUNCTION = `${CHANGE_SCHEMA}.capture_indexer_documents_change`;

const dropChangeTable = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.ROCKSDB_DROP_CHANGE_TABLE ?? '').toLowerCase()
);
const pool = new Pool({ connectionString: readConfig().databaseUrl });

try {
  await pool.query(`drop trigger if exists ${CHANGE_TRIGGER} on indexer_documents;`);
  await pool.query(`drop function if exists ${CHANGE_FUNCTION}();`);

  if (dropChangeTable) {
    await pool.query(`drop table if exists ${CHANGE_TABLE};`);
    await pool.query(`drop schema if exists ${CHANGE_SCHEMA};`);
  }

  console.info(
    dropChangeTable
      ? 'Dropped Postgres RocksDB change capture trigger, function, and table'
      : 'Dropped Postgres RocksDB change capture trigger and function; change table retained'
  );
} finally {
  await pool.end();
}
