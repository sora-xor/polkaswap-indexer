import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const MANIFEST_VERSION = 1;
const MANIFEST_ALGORITHM = 'sha256';
const MAX_NATIVE_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_INTEGRITY_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_BACKUP_FILES = 1_000_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;

type BackupFileDigest = {
  path: string;
  size: number;
  sha256: string;
};

type BackupIntegrityManifest = {
  version: 1;
  algorithm: 'sha256';
  backupId: number;
  files: BackupFileDigest[];
};

const assertBackupId = (backupId: number): void => {
  if (!Number.isSafeInteger(backupId) || backupId <= 0) {
    throw new Error('The RocksDB backup integrity id must be a positive safe integer');
  }
};

export const rocksdbBackupIntegrityManifestPath = (backupDir: string, backupId: number): string => {
  assertBackupId(backupId);
  return join(resolve(backupDir), 'polkaswap-indexer-sha256', `${backupId}.json`);
};

const isInside = (parent: string, candidate: string): boolean => {
  const child = relative(parent, candidate);
  return child !== '' && !child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child);
};

const assertSafeRelativeBackupPath = (value: string): string => {
  if (
    !value ||
    value.includes('\\') ||
    value.includes('\0') ||
    isAbsolute(value) ||
    value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`Invalid path in RocksDB native backup metadata: ${JSON.stringify(value)}`);
  }
  return value;
};

/** Parses the exact file set referenced by a RocksDB BackupEngine receipt. */
const readNativeBackupFileSet = async (backupDir: string, backupId: number): Promise<string[]> => {
  assertBackupId(backupId);
  const metaRelative = `meta/${backupId}`;
  const metaPath = join(backupDir, metaRelative);
  const metadataStats = await lstat(metaPath);
  if (metadataStats.isSymbolicLink() || !metadataStats.isFile() || metadataStats.size > MAX_NATIVE_METADATA_BYTES) {
    throw new Error(`Invalid RocksDB native backup metadata for backup ${backupId}`);
  }
  const lines = (await readFile(metaPath, 'utf8')).split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length < 3 || !DECIMAL_PATTERN.test(lines[0]!) || !DECIMAL_PATTERN.test(lines[1]!)) {
    throw new Error(`Malformed RocksDB native backup metadata header for backup ${backupId}`);
  }

  let cursor = 2;
  if (lines[cursor]?.startsWith('metadata ')) {
    if (!/^metadata (?:[0-9A-Fa-f]{2})*$/.test(lines[cursor]!)) {
      throw new Error(`Malformed RocksDB application metadata for backup ${backupId}`);
    }
    cursor += 1;
  }
  const rawCount = lines[cursor++];
  if (!rawCount || !DECIMAL_PATTERN.test(rawCount)) {
    throw new Error(`Malformed RocksDB native file count for backup ${backupId}`);
  }
  const count = Number(rawCount);
  if (!Number.isSafeInteger(count) || count <= 0 || count > MAX_BACKUP_FILES || lines.length !== cursor + count) {
    throw new Error(`Inconsistent RocksDB native file count for backup ${backupId}`);
  }

  const paths = [metaRelative];
  for (const line of lines.slice(cursor)) {
    const match = /^(\S+)\s+[A-Za-z0-9_-]+\s+[0-9]+$/.exec(line);
    if (!match) throw new Error(`Malformed RocksDB native file receipt for backup ${backupId}`);
    paths.push(assertSafeRelativeBackupPath(match[1]!));
  }
  if (new Set(paths).size !== paths.length) {
    throw new Error(`Duplicate file in RocksDB native backup metadata for backup ${backupId}`);
  }
  return paths.sort();
};

const hashBackupFile = async (backupDir: string, relativePath: string): Promise<BackupFileDigest> => {
  const root = await realpath(backupDir);
  const candidate = resolve(root, relativePath);
  if (!isInside(root, candidate)) throw new Error(`RocksDB backup file escapes its repository: ${relativePath}`);
  const details = await lstat(candidate);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`RocksDB backup receipt references a non-regular file: ${relativePath}`);
  }
  const canonical = await realpath(candidate);
  if (!isInside(root, canonical)) throw new Error(`RocksDB backup file resolves outside its repository: ${relativePath}`);

  const hash = createHash('sha256');
  for await (const chunk of createReadStream(canonical)) hash.update(chunk as Buffer);
  if (!Number.isSafeInteger(details.size) || details.size < 0) {
    throw new Error(`RocksDB backup file size is outside the safe range: ${relativePath}`);
  }
  return { path: relativePath, size: details.size, sha256: hash.digest('hex') };
};

const parseIntegrityManifest = (value: unknown, backupId: number): BackupIntegrityManifest => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid SHA-256 integrity manifest for RocksDB backup ${backupId}`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'algorithm,backupId,files,version') {
    throw new Error(`Unexpected fields in SHA-256 integrity manifest for RocksDB backup ${backupId}`);
  }
  if (
    record.version !== MANIFEST_VERSION ||
    record.algorithm !== MANIFEST_ALGORITHM ||
    record.backupId !== backupId ||
    !Array.isArray(record.files) ||
    record.files.length === 0 ||
    record.files.length > MAX_BACKUP_FILES
  ) {
    throw new Error(`Invalid SHA-256 integrity manifest header for RocksDB backup ${backupId}`);
  }
  const files: BackupFileDigest[] = record.files.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Invalid file receipt in SHA-256 manifest for RocksDB backup ${backupId}`);
    }
    const file = entry as Record<string, unknown>;
    if (Object.keys(file).sort().join(',') !== 'path,sha256,size') {
      throw new Error(`Unexpected file receipt fields in SHA-256 manifest for RocksDB backup ${backupId}`);
    }
    if (
      typeof file.path !== 'string' ||
      !Number.isSafeInteger(file.size) ||
      (file.size as number) < 0 ||
      typeof file.sha256 !== 'string' ||
      !SHA256_PATTERN.test(file.sha256)
    ) {
      throw new Error(`Invalid file receipt in SHA-256 manifest for RocksDB backup ${backupId}`);
    }
    return {
      path: assertSafeRelativeBackupPath(file.path),
      size: file.size as number,
      sha256: file.sha256,
    };
  });
  if (new Set(files.map(({ path }) => path)).size !== files.length) {
    throw new Error(`Duplicate file receipt in SHA-256 manifest for RocksDB backup ${backupId}`);
  }
  return { version: 1, algorithm: 'sha256', backupId, files };
};

export const writeRocksdbBackupSha256Manifest = async (
  backupDir: string,
  backupId: number
): Promise<string> => {
  const filePaths = await readNativeBackupFileSet(resolve(backupDir), backupId);
  const files: BackupFileDigest[] = [];
  for (const filePath of filePaths) files.push(await hashBackupFile(backupDir, filePath));
  const manifest: BackupIntegrityManifest = {
    version: 1,
    algorithm: 'sha256',
    backupId,
    files,
  };
  const target = rocksdbBackupIntegrityManifestPath(backupDir, backupId);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const directory = await lstat(dirname(target));
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error(`RocksDB SHA-256 manifest directory is not a real directory: ${dirname(target)}`);
  }
  await writeFile(target, `${JSON.stringify(manifest)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true });
  return target;
};

export const verifyRocksdbBackupSha256 = async (backupDir: string, backupId: number): Promise<void> => {
  const manifestPath = rocksdbBackupIntegrityManifestPath(backupDir, backupId);
  const details = await lstat(manifestPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      throw new Error(`Missing mandatory SHA-256 integrity manifest for RocksDB backup ${backupId}`, { cause: error });
    }
    throw error;
  });
  if (!details.isFile() || details.isSymbolicLink() || details.size > MAX_INTEGRITY_MANIFEST_BYTES) {
    throw new Error(`Invalid SHA-256 integrity manifest file for RocksDB backup ${backupId}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Malformed SHA-256 integrity manifest JSON for RocksDB backup ${backupId}`, { cause: error });
  }
  const manifest = parseIntegrityManifest(parsed, backupId);
  const nativePaths = await readNativeBackupFileSet(resolve(backupDir), backupId);
  const manifestPaths = manifest.files.map(({ path }) => path).sort();
  if (nativePaths.join('\0') !== manifestPaths.join('\0')) {
    throw new Error(`SHA-256 manifest file set does not match RocksDB backup ${backupId}`);
  }

  const byPath = new Map(manifest.files.map((file) => [file.path, file]));
  for (const path of nativePaths) {
    const expected = byPath.get(path)!;
    const actual = await hashBackupFile(backupDir, path);
    if (
      actual.size !== expected.size ||
      !timingSafeEqual(Buffer.from(actual.sha256, 'hex'), Buffer.from(expected.sha256, 'hex'))
    ) {
      throw new Error(`SHA-256 verification failed for RocksDB backup ${backupId} file ${path}`);
    }
  }
};
