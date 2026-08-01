import { lstat } from 'node:fs/promises';

import {
  ROCKSDB_FORMAT_METADATA_KEY,
  ROCKSDB_FORMAT_VERSION,
} from '../repository/rocksdb.js';
import {
  assertServeablePostgresRocksdbMigrationState,
  POSTGRES_ROCKSDB_MIGRATION_STATE_KEY,
} from './rocksdb-migration-state.js';

import type { RocksReadView } from '../repository/rocksdb.js';

/** Rejects a typo before RocksDB's writable open can create an empty source. */
export const assertExistingRocksdbDirectory = async (sourcePath: string): Promise<void> => {
  let source;
  try {
    source = await lstat(sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`RocksDB artifact source does not exist: ${sourcePath}`);
    }
    throw error;
  }
  if (!source.isDirectory() || source.isSymbolicLink()) {
    throw new Error(`RocksDB artifact source must be a real database directory: ${sourcePath}`);
  }
};

/** Validates the first-release marker and refuses a useless document-empty artifact. */
export const assertCurrentRocksdbArtifactSource = (db: RocksReadView, sourcePath: string): void => {
  const formatVersion = db.getSync(['m', 'metadata', ROCKSDB_FORMAT_METADATA_KEY]);
  if (formatVersion !== ROCKSDB_FORMAT_VERSION) {
    throw new Error(
      `RocksDB artifact source ${sourcePath} has unsupported format ${String(formatVersion)}; expected ${ROCKSDB_FORMAT_VERSION}`
    );
  }
  for (const _entry of db.getRange({ start: ['i'], end: ['i', Buffer.from([0xff])], limit: 1, values: false })) {
    throw new Error(`RocksDB artifact source ${sourcePath} contains unsupported index namespace keys`);
  }
  try {
    assertServeablePostgresRocksdbMigrationState(
      db.getSync(['m', 'metadata', POSTGRES_ROCKSDB_MIGRATION_STATE_KEY])
    );
  } catch (error) {
    throw new Error(`RocksDB artifact source ${sourcePath} is not a validated migration destination`, {
      cause: error,
    });
  }
  let hasDocument = false;
  for (const _entry of db.getRange({ start: ['d'], end: ['d', Buffer.from([0xff])], limit: 1, values: false })) {
    hasDocument = true;
  }
  if (!hasDocument) {
    throw new Error(`RocksDB artifact source ${sourcePath} contains no indexed documents`);
  }
};
