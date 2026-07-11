import { mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { RocksDatabase, backups } from '@harperfast/rocksdb-js';

import { readConfig } from '../config.js';
import { assertCanonicalDisjointPaths } from './env.js';
import {
  assertCurrentRocksdbArtifactSource,
  assertExistingRocksdbDirectory,
} from './rocksdb-artifact-source.js';
import {
  rocksdbBackupIntegrityManifestPath,
  verifyRocksdbBackupSha256,
  writeRocksdbBackupSha256Manifest,
} from './rocksdb-backup-integrity.js';

/**
 * Creates a verified backup while holding RocksDB's exclusive writer lock.
 * A second read-only handle can omit the live process' unflushed memtable/WAL,
 * so the standalone backup command intentionally requires an offline handoff.
 */
export const createRocksdbBackup = async (
  sourcePath: string,
  backupDir: string
): Promise<number> => {
  await assertExistingRocksdbDirectory(sourcePath);
  await assertCanonicalDisjointPaths('ROCKSDB_PATH', sourcePath, 'ROCKSDB_BACKUP_DIR', backupDir);
  const db = RocksDatabase.open(sourcePath);

  try {
    assertCurrentRocksdbArtifactSource(db, sourcePath);
    mkdirSync(backupDir, { recursive: true });
    let backupId: number | null = null;
    try {
      backupId = await db.backup(backupDir, {
        backupLogFiles: true,
        flushBeforeBackup: true,
        metadata: JSON.stringify({
          createdAt: new Date().toISOString(),
          rocksdbPath: sourcePath,
          integrity: 'sha256',
        }),
        sync: true,
      });

      await backups.verify(backupDir, backupId, { verifyWithChecksum: true });
      await writeRocksdbBackupSha256Manifest(backupDir, backupId);
      await verifyRocksdbBackupSha256(backupDir, backupId);
      return backupId;
    } catch (error) {
      if (backupId !== null) {
        const cleanupErrors: unknown[] = [];
        await rm(rocksdbBackupIntegrityManifestPath(backupDir, backupId), { force: true }).catch((failure) => {
          cleanupErrors.push(failure);
        });
        await backups.delete(backupDir, backupId).catch((failure) => {
          cleanupErrors.push(failure);
        });
        if (cleanupErrors.length) {
          throw new AggregateError(
            [error, ...cleanupErrors],
            `RocksDB backup ${backupId} failed integrity publication and could not be fully removed`
          );
        }
      }
      throw error;
    }
  } finally {
    db.close();
  }
};

export const runRocksdbBackup = async (): Promise<{ backupDir: string; backupId: number }> => {
  const config = readConfig();
  const backupDir = path.resolve(process.env.ROCKSDB_BACKUP_DIR ?? './data/polkaswap-indexer-rocksdb-backups');
  const backupId = await createRocksdbBackup(config.rocksdbPath, backupDir);
  return { backupDir, backupId };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { backupDir, backupId } = await runRocksdbBackup();
  console.info(`Created RocksDB backup ${backupId} in ${backupDir}`);
  console.info(`Verified RocksDB backup ${backupId} with native checksums and a complete SHA-256 manifest`);
}
