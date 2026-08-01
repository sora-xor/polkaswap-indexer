import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { backups } from '@harperfast/rocksdb-js';

import { readConfig } from '../config.js';
import { RocksRepository } from '../repository/rocksdb.js';
import {
  assertCanonicalDisjointPaths,
  assertDisjointPaths,
  createRocksdbRestorePlan,
} from './env.js';
import { verifyRocksdbBackupSha256 } from './rocksdb-backup-integrity.js';

import type { AppConfig } from '../config.js';
import type { RocksdbRestorePlan } from './env.js';

const assertPathDoesNotExist = async (targetPath: string): Promise<void> => {
  await lstat(targetPath).then(
    () => Promise.reject(new Error(`Generated restore target unexpectedly already exists: ${targetPath}`)),
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    }
  );
};

const canonicalizePath = async (candidate: string): Promise<string> => {
  const absolute = resolve(candidate);
  try {
    return await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      return join(await realpath(dirname(absolute)), basename(absolute));
    } catch (parentError) {
      if ((parentError as NodeJS.ErrnoException).code !== 'ENOENT') throw parentError;
      return absolute;
    }
  }
};

export type RocksdbRestoreResult = {
  backupId: number;
  targetPath: string;
};

/**
 * Restores only into the fresh path from a prevalidated plan. The destination
 * is never accepted from an operator as the live database path.
 */
export const restoreRocksdbBackup = async (
  config: AppConfig,
  plan: RocksdbRestorePlan
): Promise<RocksdbRestoreResult> => {
  const { backupId } = plan;

  if (!Number.isSafeInteger(backupId) || backupId <= 0) {
    throw new Error('The RocksDB restore backup id must be a positive safe integer');
  }

  // Resolve every existing symlinked ancestor before creating even the
  // staging parent. This keeps a path that merely looks separate from
  // creating directories inside the live database or backup repository.
  await Promise.all([
    assertCanonicalDisjointPaths(
      'The RocksDB restore target',
      plan.targetPath,
      'the backup directory',
      plan.backupDir
    ),
    assertCanonicalDisjointPaths(
      'The RocksDB restore target',
      plan.targetPath,
      'the live ROCKSDB_PATH',
      config.rocksdbPath
    ),
    assertCanonicalDisjointPaths(
      'The RocksDB backup directory',
      plan.backupDir,
      'the live ROCKSDB_PATH',
      config.rocksdbPath
    ),
  ]);

  await mkdir(dirname(plan.targetPath), { recursive: true, mode: 0o700 });
  const [backupDir, targetPath, livePath] = await Promise.all([
    canonicalizePath(plan.backupDir),
    canonicalizePath(plan.targetPath),
    canonicalizePath(config.rocksdbPath),
  ]);
  assertDisjointPaths('The canonical restore target', targetPath, 'the canonical backup directory', backupDir);
  assertDisjointPaths('The canonical restore target', targetPath, 'the canonical live ROCKSDB_PATH', livePath);
  await assertPathDoesNotExist(targetPath);

  await verifyRocksdbBackupSha256(backupDir, backupId);
  await backups.verify(backupDir, backupId, { verifyWithChecksum: true });
  let claimedTarget = false;
  try {
    // Atomically claim the unpredictable target after verification. If
    // another process creates it first, mkdir fails instead of following a
    // replacement symlink into an operator-controlled location.
    await mkdir(targetPath, { mode: 0o700 });
    claimedTarget = true;
    const claimedPath = await lstat(targetPath);
    if (!claimedPath.isDirectory() || claimedPath.isSymbolicLink()) {
      throw new Error(`Generated RocksDB restore target is not a real directory: ${targetPath}`);
    }

    // purgeAllFiles is safe here because targetPath is the empty staging
    // directory claimed immediately above and is separate from the live DB.
    await backups.restore(backupDir, targetPath, {
      backupId,
      mode: 'purgeAllFiles',
    });

    // Re-read both receipts after native restore so concurrent corruption or
    // replacement of a shared backup file cannot publish a staging artifact
    // based only on checks performed before the copy/hard-link operation.
    await verifyRocksdbBackupSha256(backupDir, backupId);
    await backups.verify(backupDir, backupId, { verifyWithChecksum: true });

    const restoredPath = await lstat(targetPath);
    if (!restoredPath.isDirectory() || restoredPath.isSymbolicLink()) {
      throw new Error(`Restored RocksDB target is not a real directory: ${targetPath}`);
    }

    const repository = RocksRepository.openReadOnly({
      ...config,
      storageEngine: 'rocksdb',
      rocksdbPath: targetPath,
    });
    try {
      await repository.prepare?.();
      await repository.validateCompactIndexes();
    } finally {
      await repository.close();
    }
  } catch (error) {
    // A failed native restore or logical validation must never leave a
    // plausible-looking candidate for an operator to switch into service.
    if (claimedTarget) {
      try {
        await rm(targetPath, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `RocksDB restore failed and its invalid staging target could not be removed: ${targetPath}`
        );
      }
    }
    throw error;
  }

  return { backupId, targetPath };
};

export const runRocksdbRestore = async (): Promise<RocksdbRestoreResult> => {
  const plan = createRocksdbRestorePlan(process.env, process.cwd(), randomUUID());
  return restoreRocksdbBackup(readConfig(), plan);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { backupId, targetPath } = await runRocksdbRestore();
  console.info(`Restored and validated RocksDB backup ${backupId} into fresh staging path ${targetPath}`);
  console.info(
    'Stop the combined service, point ROCKSDB_PATH at this staging path, then restart; no live path was purged.'
  );
}
