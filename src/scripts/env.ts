import { realpath } from 'node:fs/promises';
import path from 'node:path';

const INTEGER_PATTERN = /^[0-9]+$/;
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

export const readStrictBoolean = (
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean
): boolean => {
  const raw = env[name];
  if (raw === undefined) return fallback;

  const value = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;

  throw new Error(`${name} must be one of: 1, true, yes, on, 0, false, no, off`);
};

export const readPositiveSafeInteger = (
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number
): number => {
  const raw = env[name];
  if (raw === undefined) return fallback;

  const value = raw.trim();
  if (!INTEGER_PATTERN.test(value)) throw new Error(`${name} must be a positive integer`);

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }

  return parsed;
};

export const readOptionalPositiveSafeInteger = (
  env: NodeJS.ProcessEnv,
  name: string
): number | undefined => {
  if (env[name] === undefined) return undefined;
  return readPositiveSafeInteger(env, name, 1);
};

export const readNonNegativeSafeInteger = (
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number
): number => {
  const raw = env[name];
  if (raw === undefined) return fallback;

  const value = raw.trim();
  if (!INTEGER_PATTERN.test(value)) throw new Error(`${name} must be a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a non-negative safe integer`);
  return parsed;
};

export const readStrictEnum = <T extends string>(
  env: NodeJS.ProcessEnv,
  name: string,
  values: readonly T[],
  fallback: T
): T => {
  const raw = env[name];
  if (raw === undefined) return fallback;

  const normalized = raw.trim().toLowerCase();
  const value = values.find((candidate) => candidate.toLowerCase() === normalized);
  if (!value) throw new Error(`${name} must be one of: ${values.join(', ')}`);

  return value;
};

const isPathInside = (parent: string, candidate: string): boolean => {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

export const assertDisjointPaths = (
  firstName: string,
  firstPath: string,
  secondName: string,
  secondPath: string,
  cwd: string = process.cwd()
): void => {
  const first = path.resolve(cwd, firstPath);
  const second = path.resolve(cwd, secondPath);
  if (isPathInside(first, second) || isPathInside(second, first)) {
    throw new Error(`${firstName} and ${secondName} must not contain one another`);
  }
};

const canonicalizeThroughExistingAncestor = async (candidate: string, cwd: string): Promise<string> => {
  const missingSegments: string[] = [];
  let existingCandidate = path.resolve(cwd, candidate);

  while (true) {
    try {
      return path.join(await realpath(existingCandidate), ...missingSegments);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(existingCandidate);
      if (parent === existingCandidate) return path.resolve(cwd, candidate);
      missingSegments.unshift(path.basename(existingCandidate));
      existingCandidate = parent;
    }
  }
};

/** Resolves symlinked ancestors before applying the destructive-path guard. */
export const assertCanonicalDisjointPaths = async (
  firstName: string,
  firstPath: string,
  secondName: string,
  secondPath: string,
  cwd: string = process.cwd()
): Promise<void> => {
  const [first, second] = await Promise.all([
    canonicalizeThroughExistingAncestor(firstPath, cwd),
    canonicalizeThroughExistingAncestor(secondPath, cwd),
  ]);
  assertDisjointPaths(firstName, first, secondName, second, cwd);
};

export type RocksdbRestorePlan = {
  backupDir: string;
  targetPath: string;
  backupId: number;
};

/**
 * Creates a fresh, unpredictable staging target. Restore never accepts an
 * operator-selected database target because the native purge mode does not
 * lock out a live writer.
 */
export const createRocksdbRestorePlan = (
  env: NodeJS.ProcessEnv,
  cwd: string = process.cwd(),
  uniqueSuffix = 'generated'
): RocksdbRestorePlan => {
  const rawParent = env.ROCKSDB_RESTORE_PARENT_PATH?.trim();
  if (!rawParent) {
    throw new Error('ROCKSDB_RESTORE_PARENT_PATH is required for a fresh staging restore');
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uniqueSuffix)) {
    throw new Error('The generated RocksDB restore suffix is invalid');
  }

  const restoreParent = path.resolve(cwd, rawParent);
  const backupDir = path.resolve(
    cwd,
    env.ROCKSDB_BACKUP_DIR?.trim() || './data/polkaswap-indexer-rocksdb-backups'
  );
  const filesystemRoot = path.parse(restoreParent).root;
  const backupId = readOptionalPositiveSafeInteger(env, 'ROCKSDB_RESTORE_BACKUP_ID');
  if (backupId === undefined) throw new Error('ROCKSDB_RESTORE_BACKUP_ID is required');

  if (restoreParent === filesystemRoot || restoreParent === path.resolve(cwd)) {
    throw new Error('ROCKSDB_RESTORE_PARENT_PATH must be a dedicated staging directory');
  }
  assertDisjointPaths('The RocksDB restore staging directory', restoreParent, 'backup directory', backupDir, cwd);

  const targetPath = path.join(restoreParent, `backup-${backupId}-${uniqueSuffix}.rocksdb`);
  const livePath = env.ROCKSDB_PATH?.trim();
  if (livePath) {
    assertDisjointPaths('The generated RocksDB restore target', targetPath, 'the live ROCKSDB_PATH', livePath, cwd);
    assertDisjointPaths('The RocksDB backup directory', backupDir, 'the live ROCKSDB_PATH', livePath, cwd);
  }

  return {
    backupDir,
    targetPath,
    backupId,
  };
};

export const assertPostgresReclaimConfirmation = (
  env: NodeJS.ProcessEnv,
  dryRun: boolean
): void => {
  if (dryRun) return;

  const expected = 'DROP:indexer_documents-secondary-indexes';
  if (env.POSTGRES_RECLAIM_CONFIRM !== expected) {
    throw new Error(`POSTGRES_RECLAIM_CONFIRM must exactly equal ${expected} when dry-run mode is disabled`);
  }
};

export const assertPostgresCaptureTableDropConfirmation = (
  env: NodeJS.ProcessEnv,
  dropChangeTable: boolean
): void => {
  if (!dropChangeTable) return;

  const expected = 'DROP:polkaswap_indexer_migration.rocksdb_changes';
  if (env.ROCKSDB_DROP_CHANGE_TABLE_CONFIRM !== expected) {
    throw new Error(`ROCKSDB_DROP_CHANGE_TABLE_CONFIRM must exactly equal ${expected}`);
  }
};
