import { RocksDatabase } from '@harperfast/rocksdb-js';

import { readConfig } from '../config.js';

const config = readConfig();
const db = RocksDatabase.open(config.rocksdbPath);

try {
  await db.compact();
  console.info(`Compacted RocksDB database at ${config.rocksdbPath}`);
} finally {
  db.close();
}
