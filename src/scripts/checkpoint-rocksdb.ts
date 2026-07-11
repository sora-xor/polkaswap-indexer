import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { RocksDatabase } from '@harperfast/rocksdb-js';

import { readConfig } from '../config.js';
import { assertCanonicalDisjointPaths } from './env.js';
import {
  assertCurrentRocksdbArtifactSource,
  assertExistingRocksdbDirectory,
} from './rocksdb-artifact-source.js';

/**
 * Creates a complete checkpoint under the database's exclusive writer lock.
 * A second read-only process cannot flush the live writer's memtable and can
 * therefore produce an incomplete checkpoint even though the native call
 * succeeds; this operation intentionally requires the service to be stopped.
 */
export const createRocksdbCheckpoint = async (sourcePath: string, targetPath: string): Promise<void> => {
  await assertExistingRocksdbDirectory(sourcePath);
  await assertCanonicalDisjointPaths('ROCKSDB_PATH', sourcePath, 'ROCKSDB_CHECKPOINT_PATH', targetPath);
  const db = RocksDatabase.open(sourcePath);

  try {
    assertCurrentRocksdbArtifactSource(db, sourcePath);
    mkdirSync(dirname(targetPath), { recursive: true });
    await db.createCheckpoint(targetPath);
  } finally {
    db.close();
  }
};

export const runRocksdbCheckpoint = async (): Promise<string> => {
  const config = readConfig();
  const timestamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '');
  const targetPath = resolve(
    process.env.ROCKSDB_CHECKPOINT_PATH ?? join('./data/polkaswap-indexer-rocksdb-checkpoints', timestamp)
  );
  await createRocksdbCheckpoint(config.rocksdbPath, targetPath);
  return targetPath;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const targetPath = await runRocksdbCheckpoint();
  console.info(`Created RocksDB checkpoint at ${targetPath}`);
}
