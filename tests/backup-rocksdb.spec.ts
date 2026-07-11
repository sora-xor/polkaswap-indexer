import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RocksDatabase, backups } from '@harperfast/rocksdb-js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ROCKSDB_FORMAT_METADATA_KEY, ROCKSDB_FORMAT_VERSION } from '../src/repository/rocksdb.js';
import { createRocksdbBackup } from '../src/scripts/backup-rocksdb.js';
import {
  rocksdbBackupIntegrityManifestPath,
  verifyRocksdbBackupSha256,
  writeRocksdbBackupSha256Manifest,
} from '../src/scripts/rocksdb-backup-integrity.js';
import { captureSentinelHash } from '../src/scripts/postgres-rocksdb-capture.js';
import { createPostgresRocksdbMigrationState } from '../src/scripts/rocksdb-migration-state.js';

const incompleteMigrationState = () => {
  const sourceId = '11111111-1111-4111-8111-111111111111';
  return createPostgresRocksdbMigrationState({
    version: 1,
    sourceId,
    sourceDatabaseIdentity: 'a'.repeat(64),
    headSeq: '0',
    headHash: captureSentinelHash(sourceId),
    sealed: false,
    sealedSeq: null,
    sealedHash: null,
    cutoverRunId: null,
    cutoverDestinationId: null,
    cutoverSeq: null,
    cutoverHash: null,
  });
};

const startWriter = async (sourcePath: string): Promise<ChildProcessWithoutNullStreams> => {
  const script = `
    import { RocksDatabase } from '@harperfast/rocksdb-js';
    const db = RocksDatabase.open(${JSON.stringify(sourcePath)});
    await db.put(['m', 'metadata', ${JSON.stringify(ROCKSDB_FORMAT_METADATA_KEY)}], ${ROCKSDB_FORMAT_VERSION});
    await db.put(['d', 'assets', 'before'], { value: 1 });
    await db.put(['d', 'assets', 'after'], { value: 2 });
    process.stdout.write('ready\\n');
    process.stdin.once('data', () => { db.close(); process.exit(0); });
  `;
  const writer: ChildProcessWithoutNullStreams = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    writer.once('error', reject);
    writer.once('exit', (code) => reject(new Error(`Writer exited before ready with code ${String(code)}`)));
    writer.stdout.once('data', (chunk) => {
      if (String(chunk).includes('ready')) resolve();
      else reject(new Error(`Unexpected writer output: ${String(chunk)}`));
    });
  });
  return writer;
};

const stopWriter = async (writer: ChildProcessWithoutNullStreams): Promise<void> => {
  writer.stdin.end('\n');
  if (writer.exitCode === null) await once(writer, 'exit');
};

describe('RocksDB backup operation', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'polkaswap-backup-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('rejects a live writer, then checksum-verifies and restores every committed row offline', async () => {
    const sourcePath = join(root, 'live.rocksdb');
    const backupDir = join(root, 'backups');
    const restorePath = join(root, 'restored.rocksdb');
    const writer = await startWriter(sourcePath);

    try {
      await expect(createRocksdbBackup(sourcePath, backupDir)).rejects.toThrow(/lock|temporarily unavailable/i);
    } finally {
      await stopWriter(writer);
    }

    const backupId = await createRocksdbBackup(sourcePath, backupDir);
    await expect(backups.verify(backupDir, backupId, { verifyWithChecksum: true })).resolves.toBeUndefined();
    await expect(verifyRocksdbBackupSha256(backupDir, backupId)).resolves.toBeUndefined();
    await backups.restore(backupDir, restorePath, { backupId, mode: 'purgeAllFiles' });

    const restored = RocksDatabase.open(restorePath, { readOnly: true });
    try {
      expect(restored.getSync(['d', 'assets', 'before'])).toEqual({ value: 1 });
      expect(restored.getSync(['d', 'assets', 'after'])).toEqual({ value: 2 });
    } finally {
      restored.close();
    }
  });

  it('detects a forged SHA-256 receipt even when native CRC verification still passes', async () => {
    const sourcePath = join(root, 'source.rocksdb');
    const backupDir = join(root, 'backups');
    const db = RocksDatabase.open(sourcePath);
    await db.put(['m', 'metadata', ROCKSDB_FORMAT_METADATA_KEY], ROCKSDB_FORMAT_VERSION);
    await db.put(['d', 'assets', 'sentinel'], true);
    db.close();

    const backupId = await createRocksdbBackup(sourcePath, backupDir);
    const manifestPath = rocksdbBackupIntegrityManifestPath(backupDir, backupId);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      files: Array<{ sha256: string }>;
    };
    manifest.files[0]!.sha256 = manifest.files[0]!.sha256 === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
    await writeFile(manifestPath, JSON.stringify(manifest));

    await expect(backups.verify(backupDir, backupId, { verifyWithChecksum: true })).resolves.toBeUndefined();
    await expect(verifyRocksdbBackupSha256(backupDir, backupId)).rejects.toThrow(/SHA-256 verification failed/);
  });

  it('binds separate SHA-256 manifests to each incremental backup file set', async () => {
    const sourcePath = join(root, 'source.rocksdb');
    const backupDir = join(root, 'backups');
    const firstRestore = join(root, 'first-restored.rocksdb');
    const secondRestore = join(root, 'second-restored.rocksdb');
    let db = RocksDatabase.open(sourcePath);
    await db.put(['m', 'metadata', ROCKSDB_FORMAT_METADATA_KEY], ROCKSDB_FORMAT_VERSION);
    await db.put(['d', 'assets', 'first'], 1);
    db.close();
    const firstId = await createRocksdbBackup(sourcePath, backupDir);

    db = RocksDatabase.open(sourcePath);
    await db.put(['d', 'assets', 'second'], 2);
    db.close();
    const secondId = await createRocksdbBackup(sourcePath, backupDir);
    expect(secondId).toBeGreaterThan(firstId);

    await expect(verifyRocksdbBackupSha256(backupDir, firstId)).resolves.toBeUndefined();
    await expect(verifyRocksdbBackupSha256(backupDir, secondId)).resolves.toBeUndefined();
    await backups.restore(backupDir, firstRestore, { backupId: firstId, mode: 'purgeAllFiles' });
    await backups.restore(backupDir, secondRestore, { backupId: secondId, mode: 'purgeAllFiles' });
    const first = RocksDatabase.open(firstRestore, { readOnly: true });
    const second = RocksDatabase.open(secondRestore, { readOnly: true });
    try {
      expect(first.getSync(['d', 'assets', 'first'])).toBe(1);
      expect(first.getSync(['d', 'assets', 'second'])).toBeUndefined();
      expect(second.getSync(['d', 'assets', 'first'])).toBe(1);
      expect(second.getSync(['d', 'assets', 'second'])).toBe(2);
    } finally {
      first.close();
      second.close();
    }
  });

  it('rejects path traversal and inconsistent file counts in native backup metadata', async () => {
    const traversalDir = join(root, 'traversal-backup');
    await mkdir(join(traversalDir, 'meta'), { recursive: true });
    await writeFile(join(traversalDir, 'meta', '1'), '1\n1\n1\n../escape crc32 0\n');
    await expect(writeRocksdbBackupSha256Manifest(traversalDir, 1)).rejects.toThrow(/Invalid path/);

    const countDir = join(root, 'bad-count-backup');
    await mkdir(join(countDir, 'meta'), { recursive: true });
    await writeFile(join(countDir, 'meta', '1'), '1\n1\n2\nprivate/1/CURRENT crc32 0\n');
    await expect(writeRocksdbBackupSha256Manifest(countDir, 1)).rejects.toThrow(/file count/);
  });

  it('rejects equal or nested backup paths before opening the database', async () => {
    const sourcePath = join(root, 'live.rocksdb');
    const source = RocksDatabase.open(sourcePath);
    await source.put(['m', 'metadata', ROCKSDB_FORMAT_METADATA_KEY], ROCKSDB_FORMAT_VERSION);
    await source.put(['d', 'assets', 'sentinel'], true);
    source.close();

    await expect(createRocksdbBackup(sourcePath, sourcePath)).rejects.toThrow(/must not contain/);
    await expect(createRocksdbBackup(sourcePath, join(sourcePath, 'backups'))).rejects.toThrow(/must not contain/);
  });

  it('rejects missing, empty, and unversioned sources instead of creating a successful empty backup', async () => {
    const backupDir = join(root, 'backups');
    const missing = join(root, 'missing.rocksdb');
    await expect(createRocksdbBackup(missing, backupDir)).rejects.toThrow(/does not exist/);

    const empty = join(root, 'empty.rocksdb');
    await mkdir(empty);
    await expect(createRocksdbBackup(empty, backupDir)).rejects.toThrow(/unsupported format/);

    const unversioned = join(root, 'unversioned.rocksdb');
    const db = RocksDatabase.open(unversioned);
    await db.put(['d', 'assets', 'row'], true);
    db.close();
    await expect(createRocksdbBackup(unversioned, backupDir)).rejects.toThrow(/unsupported format/);

    const wrongVersion = join(root, 'wrong-version.rocksdb');
    const wrong = RocksDatabase.open(wrongVersion);
    await wrong.put(['m', 'metadata', ROCKSDB_FORMAT_METADATA_KEY], ROCKSDB_FORMAT_VERSION + 1);
    await wrong.put(['d', 'assets', 'row'], true);
    wrong.close();
    await expect(createRocksdbBackup(wrongVersion, backupDir)).rejects.toThrow(/unsupported format/);

    const formatOnly = join(root, 'format-only.rocksdb');
    const noDocuments = RocksDatabase.open(formatOnly);
    await noDocuments.put(['m', 'metadata', ROCKSDB_FORMAT_METADATA_KEY], ROCKSDB_FORMAT_VERSION);
    noDocuments.close();
    await expect(createRocksdbBackup(formatOnly, backupDir)).rejects.toThrow(/no indexed documents/);

    const unsupportedIndex = join(root, 'unsupported-index.rocksdb');
    const unsupported = RocksDatabase.open(unsupportedIndex);
    await unsupported.put(['m', 'metadata', ROCKSDB_FORMAT_METADATA_KEY], ROCKSDB_FORMAT_VERSION);
    await unsupported.put(['d', 'assets', 'row'], true);
    await unsupported.put(['i', 'old-shape', 'assets', 'row'], true);
    unsupported.close();
    await expect(createRocksdbBackup(unsupportedIndex, backupDir)).rejects.toThrow(/unsupported index namespace/);
  }, 15_000);

  it('refuses to copy a valid but incomplete PostgreSQL migration destination', async () => {
    const sourcePath = join(root, 'partial-migration.rocksdb');
    const backupDir = join(root, 'backups');
    const db = RocksDatabase.open(sourcePath);
    await db.put(['m', 'metadata', ROCKSDB_FORMAT_METADATA_KEY], ROCKSDB_FORMAT_VERSION);
    await db.put(['m', 'metadata', 'postgresToRocksdbMigration'], incompleteMigrationState());
    await db.put(['d', 'assets', 'sentinel'], true);
    db.close();

    await expect(createRocksdbBackup(sourcePath, backupDir)).rejects.toThrow(/not a validated migration destination/);
  });
});
