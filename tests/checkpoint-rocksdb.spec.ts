import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RocksDatabase } from '@harperfast/rocksdb-js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ROCKSDB_FORMAT_METADATA_KEY, ROCKSDB_FORMAT_VERSION } from '../src/repository/rocksdb.js';
import { createRocksdbCheckpoint } from '../src/scripts/checkpoint-rocksdb.js';
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

describe('RocksDB checkpoint operation', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'polkaswap-checkpoint-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('rejects a live writer and creates a complete checkpoint after an offline handoff', async () => {
    const sourcePath = join(root, 'live.rocksdb');
    const targetPath = join(root, 'checkpoints', 'snapshot.rocksdb');
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
    try {
      await new Promise<void>((resolve, reject) => {
        writer.once('error', reject);
        writer.once('exit', (code) => reject(new Error(`Writer exited before ready with code ${String(code)}`)));
        writer.stdout.once('data', (chunk) => {
          if (String(chunk).includes('ready')) resolve();
          else reject(new Error(`Unexpected writer output: ${String(chunk)}`));
        });
      });

      await expect(createRocksdbCheckpoint(sourcePath, targetPath)).rejects.toThrow(/lock|temporarily unavailable/i);
    } finally {
      writer.stdin.end('\n');
      if (writer.exitCode === null) await once(writer, 'exit');
    }

    await expect(createRocksdbCheckpoint(sourcePath, targetPath)).resolves.toBeUndefined();
    const checkpoint = RocksDatabase.open(targetPath, { readOnly: true });
    try {
      expect(checkpoint.getSync(['d', 'assets', 'before'])).toEqual({ value: 1 });
      expect(checkpoint.getSync(['d', 'assets', 'after'])).toEqual({ value: 2 });
    } finally {
      checkpoint.close();
    }
  });

  it('rejects equal, nested, and pre-existing checkpoint targets without mutating the source', async () => {
    const sourcePath = join(root, 'live.rocksdb');
    const writer = RocksDatabase.open(sourcePath);
    await writer.put(['m', 'metadata', ROCKSDB_FORMAT_METADATA_KEY], ROCKSDB_FORMAT_VERSION);
    await writer.put(['d', 'assets', 'sentinel'], 'preserved');
    writer.close();

    await expect(createRocksdbCheckpoint(sourcePath, sourcePath)).rejects.toThrow(/must not contain/);
    await expect(createRocksdbCheckpoint(sourcePath, join(sourcePath, 'nested'))).rejects.toThrow(/must not contain/);

    const targetPath = join(root, 'existing.rocksdb');
    const existing = RocksDatabase.open(targetPath);
    existing.close();
    await expect(createRocksdbCheckpoint(sourcePath, targetPath)).rejects.toThrow(/target path exists/i);

    const source = RocksDatabase.open(sourcePath, { readOnly: true });
    try {
      expect(source.getSync(['d', 'assets', 'sentinel'])).toBe('preserved');
    } finally {
      source.close();
    }
  });

  it('rejects missing, empty, and unversioned source paths', async () => {
    const target = join(root, 'checkpoint.rocksdb');
    await expect(createRocksdbCheckpoint(join(root, 'missing.rocksdb'), target)).rejects.toThrow(/does not exist/);

    const empty = join(root, 'empty.rocksdb');
    await mkdir(empty);
    await expect(createRocksdbCheckpoint(empty, target)).rejects.toThrow(/unsupported format/);

    const unversioned = join(root, 'unversioned.rocksdb');
    const db = RocksDatabase.open(unversioned);
    await db.put(['d', 'assets', 'row'], true);
    db.close();
    await expect(createRocksdbCheckpoint(unversioned, target)).rejects.toThrow(/unsupported format/);
  });

  it('refuses to checkpoint an incomplete PostgreSQL migration destination', async () => {
    const sourcePath = join(root, 'partial-migration.rocksdb');
    const targetPath = join(root, 'checkpoint.rocksdb');
    const db = RocksDatabase.open(sourcePath);
    await db.put(['m', 'metadata', ROCKSDB_FORMAT_METADATA_KEY], ROCKSDB_FORMAT_VERSION);
    await db.put(['m', 'metadata', 'postgresToRocksdbMigration'], incompleteMigrationState());
    await db.put(['d', 'assets', 'sentinel'], true);
    db.close();

    await expect(createRocksdbCheckpoint(sourcePath, targetPath)).rejects.toThrow(
      /not a validated migration destination/
    );
  });
});
