import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { RocksDatabase } from '@harperfast/rocksdb-js';

import { readConfig } from '../config.js';

const config = readConfig();
const timestamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '');
const targetPath =
  process.env.ROCKSDB_CHECKPOINT_PATH ?? join('./data/polkaswap-indexer-rocksdb-checkpoints', timestamp);
const db = RocksDatabase.open(config.rocksdbPath);

try {
  mkdirSync(dirname(targetPath), { recursive: true });
  await db.createCheckpoint(targetPath);
  console.info(`Created RocksDB checkpoint at ${targetPath}`);
} finally {
  db.close();
}
