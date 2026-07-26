import { isDeepStrictEqual } from 'node:util';

import pg from 'pg';

import { readConfig } from '../config.js';
import { POSTGRES_TRUSTED_SESSION_OPTIONS } from '../postgres-session.js';
import { decodePostgresDocumentText } from '../repository/postgres-document.js';
import { RocksRepository } from '../repository/rocksdb.js';
import { INDEXER_COLLECTIONS } from '../repository/types.js';
import { readPositiveSafeInteger, readStrictBoolean } from './env.js';
import { verifyPostgresRocksdbLogicalEquality } from './verify-postgres-rocksdb-logical.js';

import type { IndexerCollection, IndexerDocument } from '../repository/types.js';

const { Pool } = pg;

type PostgresDocumentRow = {
  collection: IndexerCollection;
  id: string;
  blockHeight: number | string | null;
  timestamp: number | string | null;
  dataText: string;
};

const documentsEqual = (left: IndexerDocument | null, right: IndexerDocument): boolean =>
  Boolean(
    left &&
      left.collection === right.collection &&
      left.id === right.id &&
      (left.blockHeight ?? null) === (right.blockHeight ?? null) &&
      (left.timestamp ?? null) === (right.timestamp ?? null) &&
      isDeepStrictEqual(left.data, right.data)
  );

const selectSample = async (
  client: pg.PoolClient,
  collection: IndexerCollection,
  limit: number,
  direction: 'asc' | 'desc'
): Promise<PostgresDocumentRow[]> => {
  const result = await client.query<PostgresDocumentRow>(
    `select collection, id, block_height as "blockHeight", timestamp, data::text as "dataText"
       from indexer_documents
      where collection collate "C" = $1::text collate "C"
      order by id collate "C" ${direction}
      limit $2::int`,
    [collection, limit]
  );
  return result.rows;
};

const verifySample = async (
  client: pg.PoolClient,
  repository: RocksRepository,
  sampleSize: number
): Promise<number> => {
  let compared = 0;
  for (const collection of INDEXER_COLLECTIONS) {
    const headLimit = Math.ceil(sampleSize / 2);
    const tailLimit = Math.floor(sampleSize / 2);
    const [head, tail] = await Promise.all([
      selectSample(client, collection, headLimit, 'asc'),
      tailLimit ? selectSample(client, collection, tailLimit, 'desc') : Promise.resolve([]),
    ]);
    const rows = [...new Map([...head, ...tail].map((row) => [row.id, row])).values()];
    const actual = await repository.getMany(collection, rows.map((row) => row.id));
    for (const row of rows) {
      const expected = decodePostgresDocumentText(row);
      if (!documentsEqual(actual.get(row.id) ?? null, expected)) {
        throw new Error(`${collection}/${row.id}: sampled PostgreSQL/RocksDB document mismatch`);
      }
    }
    compared += rows.length;
  }
  return compared;
};

export const runRocksdbVerification = async (): Promise<void> => {
  const config = readConfig();
  const fullVerification = readStrictBoolean(process.env, 'ROCKSDB_VERIFY_FULL', true);
  const sampleSize = readPositiveSafeInteger(process.env, 'ROCKSDB_VERIFY_SAMPLE_SIZE', 100);
  const batchSize = readPositiveSafeInteger(process.env, 'ROCKSDB_VERIFY_BATCH_SIZE', 5_000);
  const pool = new Pool({
    connectionString: config.databaseUrl,
    options: POSTGRES_TRUSTED_SESSION_OPTIONS,
  });
  const client = await pool.connect();
  const repository = new RocksRepository({ ...config, storageEngine: 'rocksdb' });
  let committed = false;

  try {
    await client.query('begin isolation level repeatable read');
    await client.query('lock table indexer_documents in share mode');
    await repository.prepare();
    await repository.validateCompactIndexes();
    const compared = fullVerification
      ? await verifyPostgresRocksdbLogicalEquality(client, repository, batchSize)
      : await verifySample(client, repository, sampleSize);
    await client.query('commit');
    committed = true;
    console.info(
      `RocksDB verification passed: compact indexes valid; ${fullVerification ? 'exhaustively verified' : 'sampled'} ${compared} document(s)`
    );
  } finally {
    if (!committed) await client.query('rollback').catch(() => undefined);
    client.release();
    await repository.close().catch(() => undefined);
    await pool.end();
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  runRocksdbVerification().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
