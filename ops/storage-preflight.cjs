'use strict';

/**
 * Independent disk preflight for direct indexer maintenance entrypoints.
 *
 * Install with NODE_OPTIONS=--require=/absolute/path/storage-preflight.cjs, or
 * import it before a deployed maintenance entrypoint's other imports. The
 * inherited NODE_OPTIONS also reaches tsx's child Node process. Only argv[1]
 * selects a command: importing repair helpers into the API never gates the API.
 *
 * INDEXER_STORAGE_RESERVE_BYTES defaults to, and cannot fall below, 75 GiB.
 * INDEXER_STORAGE_EXPECTED_WRITE_BYTES is an explicit peak additional disk
 * estimate INCLUDING WAL, copies and write amplification, not logical row size.
 * Every guarded command requires this estimate. Only a checkpoint can use zero
 * after verifying same-filesystem hardlinks and accounting for flushed WAL.
 * This read-only check does not replace exclusive locks, native integrity checks,
 * repair-specific estimates, or monitoring during a long-running operation.
 */
const fs = require('node:fs');
const path = require('node:path');

const MINIMUM_RESERVE_BYTES = 75n * 1024n ** 3n;
const MAXIMUM_SETTING_BYTES = BigInt(Number.MAX_SAFE_INTEGER);
const ENTRYPOINTS = new Set([
  'backup-rocksdb',
  'checkpoint-rocksdb',
  'restore-rocksdb',
  'migrate-postgres-to-rocksdb',
  'repair-network-volume',
  'network-stock-repair',
  'compact-rocksdb',
  'repair-rocksdb-legacy-checkpoint',
]);

/** Error text is fixed or numeric; paths, credentials and underlying errors are never printed. */
class StoragePreflightError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StoragePreflightError';
  }
}

/** Match only a direct supported .js/.ts entrypoint, never an argument or import. */
function maintenanceEntrypoint(argv) {
  if (!Array.isArray(argv) || typeof argv[1] !== 'string') return null;
  const filename = path.basename(argv[1]);
  const extension = path.extname(filename);
  if (extension !== '.js' && extension !== '.ts') return null;
  const command = filename.slice(0, -extension.length);
  return ENTRYPOINTS.has(command) ? command : null;
}

/** Parse bounded decimal bytes without floating-point arithmetic or echoing untrusted input. */
function readBytes(env, name, fallback) {
  const value = env[name];
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new StoragePreflightError(`${name} is required; provide a measured peak write estimate including amplification.`);
  }
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(value.trim())) {
    throw new StoragePreflightError(`${name} must be a nonnegative decimal safe integer.`);
  }
  const bytes = BigInt(value.trim());
  if (bytes > MAXIMUM_SETTING_BYTES) {
    throw new StoragePreflightError(`${name} must be a nonnegative decimal safe integer.`);
  }
  return bytes;
}

/** Resolve exactly the path spelling used by a maintenance CLI, before any directory creation. */
function configuredPath(env, name, fallback, cwd, trim = false) {
  const raw = env[name] === undefined ? fallback : env[name];
  if (typeof raw !== 'string' || !raw.trim() || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new StoragePreflightError(`${name} must identify a nonempty filesystem path.`);
  }
  return path.resolve(cwd, trim ? raw.trim() : raw);
}

/** Build a pure plan; API startup ignores even malformed maintenance-only environment settings. */
function createStoragePlan(argv, env, cwd) {
  const command = maintenanceEntrypoint(argv);
  if (!command) return null;

  const reserveBytes = readBytes(env, 'INDEXER_STORAGE_RESERVE_BYTES', MINIMUM_RESERVE_BYTES);
  if (reserveBytes < MINIMUM_RESERVE_BYTES) {
    throw new StoragePreflightError('INDEXER_STORAGE_RESERVE_BYTES cannot be lower than 80530636800 (75 GiB).');
  }
  const expectedWriteBytes = readBytes(env, 'INDEXER_STORAGE_EXPECTED_WRITE_BYTES');
  if (expectedWriteBytes === 0n && command !== 'checkpoint-rocksdb') {
    throw new StoragePreflightError('INDEXER_STORAGE_EXPECTED_WRITE_BYTES must be positive for this maintenance command.');
  }
  if (reserveBytes + expectedWriteBytes > MAXIMUM_SETTING_BYTES) {
    throw new StoragePreflightError('The reserve plus expected write bytes exceeds the safe integer range.');
  }

  const databasePath = configuredPath(env, 'ROCKSDB_PATH', './data/polkaswap-indexer.rocksdb', cwd);
  let targetPath = databasePath;
  if (command === 'backup-rocksdb') {
    targetPath = configuredPath(env, 'ROCKSDB_BACKUP_DIR', './data/polkaswap-indexer-rocksdb-backups', cwd);
  } else if (command === 'checkpoint-rocksdb') {
    // The CLI adds a timestamp below this default directory, on the same volume.
    targetPath = configuredPath(env, 'ROCKSDB_CHECKPOINT_PATH', './data/polkaswap-indexer-rocksdb-checkpoints', cwd);
  } else if (command === 'restore-rocksdb') {
    targetPath = configuredPath(env, 'ROCKSDB_RESTORE_PARENT_PATH', undefined, cwd, true);
  }

  const volumes = [{ role: 'target', path: targetPath, expectedWriteBytes }];
  if (databasePath !== targetPath) {
    volumes.push({ role: 'source or active database', path: databasePath, expectedWriteBytes: 0n });
  }
  if (command === 'restore-rocksdb') {
    const backupPath = configuredPath(env, 'ROCKSDB_BACKUP_DIR', './data/polkaswap-indexer-rocksdb-backups', cwd, true);
    volumes.push({ role: 'backup source', path: backupPath, expectedWriteBytes: 0n });
  }
  if (command === 'repair-rocksdb-legacy-checkpoint') {
    const receiptPath = configuredPath(env, 'ROCKSDB_CHECKPOINT_REPAIR_RECEIPT', undefined, cwd, true);
    // Receipt files may be replaced on resume. Inspect their parent, not the file itself.
    volumes.push({ role: 'repair receipt', path: path.dirname(receiptPath), expectedWriteBytes });
  }
  return { command, reserveBytes, expectedWriteBytes, volumes };
}

/** Locate the nearest real directory, following existing symlinks but rejecting broken ones. */
function nearestExistingDirectory(targetPath, filesystem = fs) {
  let candidate = targetPath;
  for (;;) {
    try {
      filesystem.lstatSync(candidate);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new StoragePreflightError('Cannot inspect a maintenance filesystem.');
      const parent = path.dirname(candidate);
      if (parent === candidate) throw new StoragePreflightError('Cannot locate an existing maintenance directory.');
      candidate = parent;
      continue;
    }
    try {
      const existing = filesystem.realpathSync(candidate);
      if (!filesystem.statSync(existing).isDirectory()) {
        throw new StoragePreflightError('A maintenance filesystem ancestor is not a directory.');
      }
      return existing;
    } catch (error) {
      if (error instanceof StoragePreflightError) throw error;
      throw new StoragePreflightError('Cannot resolve a maintenance directory; check access and symlinks.');
    }
  }
}

/** Compare exact byte counts; equality preserves the complete required reserve. */
function evaluateSpace(availableBytes, expectedWriteBytes, reserveBytes) {
  if ([availableBytes, expectedWriteBytes, reserveBytes].some((value) => typeof value !== 'bigint' || value < 0n)) {
    throw new StoragePreflightError('Filesystem space measurements must be nonnegative integer bytes.');
  }
  const requiredBytes = expectedWriteBytes + reserveBytes;
  return { availableBytes, requiredBytes, sufficient: availableBytes >= requiredBytes };
}

/** Inspect available blocks on each actual filesystem without opening or mutating RocksDB. */
function checkStorage({ argv = process.argv, env = process.env, cwd = process.cwd(), filesystem = fs } = {}) {
  const plan = createStoragePlan(argv, env, cwd);
  if (!plan) return null;
  const measurements = [];
  for (const volume of plan.volumes) {
    const existing = nearestExistingDirectory(volume.path, filesystem);
    let status;
    try {
      status = filesystem.statfsSync(existing, { bigint: true });
    } catch {
      throw new StoragePreflightError('Cannot measure free space on a maintenance filesystem.');
    }
    if (typeof status.bavail !== 'bigint' || status.bavail < 0n ||
        typeof status.bsize !== 'bigint' || status.bsize <= 0n) {
      throw new StoragePreflightError('Filesystem free-space measurements are invalid.');
    }
    const result = evaluateSpace(status.bavail * status.bsize, volume.expectedWriteBytes, plan.reserveBytes);
    if (!result.sufficient) {
      throw new StoragePreflightError(
        `Insufficient free space for ${volume.role}; availableBytes=${result.availableBytes} ` +
        `requiredBytes=${result.requiredBytes} reserveBytes=${plan.reserveBytes} ` +
        `expectedWriteBytes=${volume.expectedWriteBytes}.`
      );
    }
    measurements.push({ role: volume.role, ...result });
  }
  return { ...plan, measurements };
}

module.exports = {
  MINIMUM_RESERVE_BYTES,
  StoragePreflightError,
  maintenanceEntrypoint,
  createStoragePlan,
  nearestExistingDirectory,
  evaluateSpace,
  checkStorage,
};

// Also runs for a normal import inserted into a deployed maintenance entrypoint.
// Only the approved direct entrypoint can trigger a gate; dependencies cannot.
try {
  checkStorage();
} catch (error) {
  const message = error instanceof StoragePreflightError ? error.message : 'Cannot complete the maintenance disk preflight.';
  process.stderr.write(`[indexer-storage-preflight] blocked: ${message}\n`);
  process.exit(78);
}
