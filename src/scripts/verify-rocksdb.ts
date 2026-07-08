import pg from 'pg';

import { readConfig } from '../config.js';
import { INDEXER_COLLECTIONS } from '../repository/types.js';
import { RocksRepository } from '../repository/rocksdb.js';

import type { IndexerCollection, IndexerDocument } from '../repository/types.js';

const { Pool } = pg;

const readPositiveInteger = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);

  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
};

const documentsEqual = (left: IndexerDocument | null, right: IndexerDocument): boolean =>
  Boolean(
    left &&
      left.collection === right.collection &&
      left.id === right.id &&
      (left.blockHeight ?? null) === (right.blockHeight ?? null) &&
      (left.timestamp ?? null) === (right.timestamp ?? null) &&
      JSON.stringify(left.data) === JSON.stringify(right.data)
  );

const config = readConfig();
const sampleSize = readPositiveInteger('ROCKSDB_VERIFY_SAMPLE_SIZE', 20);
const pool = new Pool({ connectionString: config.databaseUrl });
const repository = new RocksRepository({ ...config, storageEngine: 'rocksdb' });
let failures = 0;

try {
  for (const collection of INDEXER_COLLECTIONS) {
    const countResult = await pool.query<{ count: number }>(
      `select count(*)::int as count from indexer_documents where collection = $1`,
      [collection]
    );
    const postgresCount = countResult.rows[0]?.count ?? 0;
    const rocksCount = repository.count(collection);

    if (postgresCount !== rocksCount) {
      failures += 1;
      console.error(`${collection}: count mismatch postgres=${postgresCount} rocksdb=${rocksCount}`);
      continue;
    }

    const sample = await pool.query<{
      collection: IndexerCollection;
      id: string;
      blockHeight: number | null;
      timestamp: number | null;
      data: Record<string, unknown>;
    }>(
      `select collection,
              id,
              block_height as "blockHeight",
              timestamp,
              data
       from indexer_documents
       where collection = $1
       order by id
       limit $2::int`,
      [collection, sampleSize]
    );

    for (const row of sample.rows) {
      const expected: IndexerDocument = {
        collection: row.collection,
        id: row.id,
        blockHeight: row.blockHeight,
        timestamp: row.timestamp,
        data: row.data,
      };
      const actual = await repository.get(collection, row.id);

      if (!documentsEqual(actual, expected)) {
        failures += 1;
        console.error(`${collection}/${row.id}: document mismatch`);
      }
    }

    console.info(`${collection}: ok (${postgresCount} rows)`);
  }
} finally {
  await repository.close().catch(() => undefined);
  await pool.end();
}

if (failures > 0) {
  console.error(`RocksDB verification failed with ${failures} mismatch(es)`);
  process.exitCode = 1;
} else {
  console.info('RocksDB verification passed');
}
