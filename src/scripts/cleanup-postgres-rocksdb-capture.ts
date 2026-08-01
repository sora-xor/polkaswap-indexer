import pg from 'pg';

import { readConfig } from '../config.js';
import { assertPostgresCaptureTableDropConfirmation, readStrictBoolean } from './env.js';
import {
  acquireMigrationProcessLock,
  CHANGE_APPEND_ONLY_FUNCTION,
  CHANGE_APPEND_ONLY_TRIGGER,
  CHANGE_FUNCTION,
  CHANGE_INSERT_GUARD_FUNCTION,
  CHANGE_INSERT_GUARD_TRIGGER,
  CHANGE_STATE_UPDATE_GUARD_FUNCTION,
  CHANGE_TABLE,
  CHANGE_TRIGGER,
  CHANGE_WRITER_GUARD_FUNCTION,
  readChangeCaptureDescriptor,
  releaseMigrationProcessLock,
} from './postgres-rocksdb-capture.js';

const { Pool } = pg;

export const cleanupPostgresRocksdbCapture = async (): Promise<void> => {
  const dropChangeTable = readStrictBoolean(process.env, 'ROCKSDB_DROP_CHANGE_TABLE', false);
  assertPostgresCaptureTableDropConfirmation(process.env, dropChangeTable);
  const pool = new Pool({ connectionString: readConfig().databaseUrl });
  let lockClient: pg.PoolClient | null = null;

  try {
    lockClient = await acquireMigrationProcessLock(pool);
    await lockClient.query('begin');
    await lockClient.query('lock table indexer_documents in access exclusive mode');
    const receipt = await readChangeCaptureDescriptor(lockClient);
    if (
      !receipt?.sealed ||
      receipt.sealedSeq === null ||
      receipt.sealedHash === null ||
      receipt.cutoverRunId === null ||
      receipt.cutoverDestinationId === null ||
      receipt.cutoverSeq !== receipt.sealedSeq ||
      receipt.cutoverHash !== receipt.sealedHash
    ) {
      throw new Error('Refusing capture cleanup before a sealed, validated RocksDB cutover receipt exists');
    }

    // Replace the state-dependent writer guard with a self-contained permanent
    // cutover fence before removing capture. Ordinary DML can no longer undo
    // the fence by corrupting or deleting the retained receipt.
    await lockClient.query(`
      create or replace function ${CHANGE_WRITER_GUARD_FUNCTION}()
      returns trigger
      language plpgsql
      as $$
      begin
        raise exception 'indexer_documents is permanently fenced after validated PostgreSQL-to-RocksDB cutover';
      end;
      $$;
    `);
    await lockClient.query(`
      create or replace function ${CHANGE_STATE_UPDATE_GUARD_FUNCTION}()
      returns trigger
      language plpgsql
      as $$
      begin
        raise exception 'PostgreSQL RocksDB validated cutover receipt is immutable';
      end;
      $$;
    `);
    await lockClient.query(`drop trigger if exists ${CHANGE_TRIGGER} on indexer_documents;`);
    await lockClient.query(`drop function if exists ${CHANGE_FUNCTION}();`);
    if (dropChangeTable) {
      const exists = await lockClient.query<{ exists: boolean }>('select to_regclass($1) is not null as exists', [
        CHANGE_TABLE,
      ]);
      if (exists.rows[0]?.exists) {
        await lockClient.query(`drop trigger if exists ${CHANGE_APPEND_ONLY_TRIGGER} on ${CHANGE_TABLE};`);
        await lockClient.query(`drop trigger if exists ${CHANGE_INSERT_GUARD_TRIGGER} on ${CHANGE_TABLE};`);
        await lockClient.query(`drop table ${CHANGE_TABLE};`);
      }
      await lockClient.query(`drop function if exists ${CHANGE_APPEND_ONLY_FUNCTION}();`);
      await lockClient.query(`drop function if exists ${CHANGE_INSERT_GUARD_FUNCTION}();`);
    }
    await lockClient.query('commit');

    console.info(
      dropChangeTable
        ? 'Removed committed change-log storage after validated cutover; persistent PostgreSQL write fence retained'
        : 'Stopped change-log capture after validated cutover; append-only log and persistent PostgreSQL write fence retained'
    );
  } catch (error) {
    await lockClient?.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    if (lockClient) await releaseMigrationProcessLock(lockClient);
    await pool.end();
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  cleanupPostgresRocksdbCapture().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
