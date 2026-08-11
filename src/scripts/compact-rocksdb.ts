import { RocksDatabase } from '@harperfast/rocksdb-js';

import { readConfig } from '../config.js';
import { rocksAvailableBytes } from '../repository/rocksdb-maintenance.js';
import { INDEXER_COLLECTIONS } from '../repository/types.js';
import {
  assertCurrentRocksdbArtifactSource,
  assertExistingRocksdbDirectory,
} from './rocksdb-artifact-source.js';

const config = readConfig();
const requestedPrefix = process.env.ROCKSDB_COMPACT_PREFIX?.trim();
const HIGH_KEY = Buffer.from([0xff]);
type RocksKeyPart = string | number | boolean | Buffer | null;
type RocksKey = RocksKeyPart[];

const compactRange = (prefix: string): { start: RocksKey; end: RocksKey } => {
  if (prefix === 'indexes') return { start: ['x'], end: ['x', HIGH_KEY] };
  if (prefix === 'documents') return { start: ['d'], end: ['d', HIGH_KEY] };
  if (prefix.startsWith('documents:') && prefix.length > 'documents:'.length) {
    const collection = prefix.slice('documents:'.length);
    if (!(INDEXER_COLLECTIONS as readonly string[]).includes(collection)) {
      throw new Error(`Unknown RocksDB document collection: ${collection}`);
    }
    return { start: ['d', collection], end: ['d', collection, HIGH_KEY] };
  }

  throw new Error(
    'ROCKSDB_COMPACT_PREFIX must be indexes, documents, or documents:<collection>'
  );
};

if (!requestedPrefix) {
  throw new Error(
    'ROCKSDB_COMPACT_PREFIX is required; use indexes, documents, documents:<collection>, or all'
  );
}

const range = requestedPrefix === 'all' ? null : compactRange(requestedPrefix);
await assertExistingRocksdbDirectory(config.rocksdbPath);
const minimumFreeBytes = config.rocksdbCompactionMinFreeGb * 1024 ** 3;
const availableBytes = await rocksAvailableBytes(config.rocksdbPath);
if (minimumFreeBytes > 0 && availableBytes < minimumFreeBytes) {
  throw new Error(
    `RocksDB compaction requires at least ${minimumFreeBytes} free bytes; only ${availableBytes} are available`
  );
}

const db = RocksDatabase.open(config.rocksdbPath);

try {
  assertCurrentRocksdbArtifactSource(db, config.rocksdbPath);
  if (range) {
    await db.compact(range);
    console.info(`Compacted RocksDB ${requestedPrefix} range at ${config.rocksdbPath}`);
  } else {
    await db.compact();
    console.info(`Compacted explicitly requested full RocksDB database at ${config.rocksdbPath}`);
  }
} finally {
  db.close();
}
