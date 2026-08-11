import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertCanonicalDisjointPaths,
  assertDisjointPaths,
  assertPostgresCaptureTableDropConfirmation,
  assertPostgresReclaimConfirmation,
  createRocksdbRestorePlan,
  readNonNegativeSafeInteger,
  readOptionalPositiveSafeInteger,
  readPositiveSafeInteger,
  readStrictBoolean,
  readStrictEnum,
} from '../src/scripts/env.js';

describe('operational script environment validation', () => {
  it.each([
    ['1', true],
    ['true', true],
    ['YES', true],
    ['on', true],
    ['0', false],
    ['false', false],
    ['NO', false],
    ['off', false],
  ] as const)('parses the explicit boolean spelling %s', (raw, expected) => {
    expect(readStrictBoolean({ FLAG: raw }, 'FLAG', !expected)).toBe(expected);
  });

  it.each(['', 'flase', 'truthy', '2', '-1'])('rejects ambiguous boolean input %j', (raw) => {
    expect(() => readStrictBoolean({ FLAG: raw }, 'FLAG', true)).toThrow(/FLAG/);
  });

  it('uses boolean and integer defaults only when variables are absent', () => {
    expect(readStrictBoolean({}, 'FLAG', true)).toBe(true);
    expect(readPositiveSafeInteger({}, 'COUNT', 12)).toBe(12);
    expect(readOptionalPositiveSafeInteger({}, 'COUNT')).toBeUndefined();
  });

  it.each(['', '0', '-1', '1.5', '1e3', 'Infinity', '9007199254740992']) (
    'rejects unsafe positive integer input %j',
    (raw) => {
      expect(() => readPositiveSafeInteger({ COUNT: raw }, 'COUNT', 1)).toThrow(/COUNT/);
      expect(() => readOptionalPositiveSafeInteger({ COUNT: raw }, 'COUNT')).toThrow(/COUNT/);
    }
  );

  it('parses a positive safe integer without rounding', () => {
    expect(readPositiveSafeInteger({ COUNT: '9007199254740991' }, 'COUNT', 1)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('accepts zero only for explicitly non-negative integer settings', () => {
    expect(readNonNegativeSafeInteger({ COUNT: '0' }, 'COUNT', 1)).toBe(0);
    expect(() => readNonNegativeSafeInteger({ COUNT: '-1' }, 'COUNT', 1)).toThrow(/COUNT/);
    expect(() => readNonNegativeSafeInteger({ COUNT: '1.5' }, 'COUNT', 1)).toThrow(/COUNT/);
  });

  it('validates enums case-insensitively and rejects typos', () => {
    expect(readStrictEnum({ MODE: 'ALL-SECONDARY' }, 'MODE', ['large', 'all-secondary'] as const, 'large')).toBe(
      'all-secondary'
    );
    expect(() => readStrictEnum({ MODE: 'all_secondary' }, 'MODE', ['large', 'all-secondary'] as const, 'large')).toThrow(
      /MODE/
    );
  });

  it('generates a fresh staging restore target instead of accepting a live database path', () => {
    const cwd = '/srv/indexer';
    const restoreParent = path.resolve(cwd, '../restore-staging');
    const env = {
      ROCKSDB_BACKUP_DIR: '../backups',
      ROCKSDB_RESTORE_PARENT_PATH: '../restore-staging',
      ROCKSDB_RESTORE_BACKUP_ID: '42',
    };

    expect(createRocksdbRestorePlan(env, cwd, 'test-run')).toEqual({
      backupDir: path.resolve(cwd, '../backups'),
      targetPath: path.join(restoreParent, 'backup-42-test-run.rocksdb'),
      backupId: 42,
    });
  });

  it('rejects operational paths that are equal or nested in either direction', () => {
    expect(() => assertDisjointPaths('database', 'data/db', 'backup', 'data/backups', '/srv')).not.toThrow();
    expect(() => assertDisjointPaths('database', 'data/db', 'backup', 'data/db', '/srv')).toThrow(/contain/);
    expect(() => assertDisjointPaths('database', 'data/db', 'backup', 'data/db/backups', '/srv')).toThrow(
      /contain/
    );
    expect(() => assertDisjointPaths('database', 'data/db', 'backup', 'data', '/srv')).toThrow(/contain/);
  });

  it('rejects disjoint-looking paths whose symlinked ancestors resolve inside one another', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'polkaswap-path-guard-'));
    try {
      const databasePath = path.join(tempDir, 'live', 'indexer.rocksdb');
      await mkdir(databasePath, { recursive: true });
      const aliasPath = path.join(tempDir, 'apparently-separate');
      await symlink(databasePath, aliasPath, 'dir');

      await expect(
        assertCanonicalDisjointPaths('database', databasePath, 'backup', path.join(aliasPath, 'backups'))
      ).rejects.toThrow(/must not contain/);
      await expect(
        assertCanonicalDisjointPaths(
          'database',
          path.join(tempDir, 'safe-db'),
          'backup',
          path.join(tempDir, 'safe-backups')
        )
      ).resolves.toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    [{}, /PARENT_PATH/],
    [{ ROCKSDB_RESTORE_PARENT_PATH: '.', ROCKSDB_RESTORE_BACKUP_ID: '1' }, /dedicated/],
    [{ ROCKSDB_RESTORE_PARENT_PATH: '/', ROCKSDB_RESTORE_BACKUP_ID: '1' }, /dedicated/],
    [
      {
        ROCKSDB_RESTORE_PARENT_PATH: 'data/restores',
        ROCKSDB_BACKUP_DIR: 'data/restores/backups',
        ROCKSDB_RESTORE_BACKUP_ID: '1',
      },
      /must not contain/,
    ],
    [
      {
        ROCKSDB_RESTORE_PARENT_PATH: 'data/restores',
        ROCKSDB_BACKUP_DIR: 'data',
        ROCKSDB_RESTORE_BACKUP_ID: '1',
      },
      /must not contain/,
    ],
    [
      {
        ROCKSDB_RESTORE_PARENT_PATH: 'data/restores',
        ROCKSDB_BACKUP_DIR: 'backups',
      },
      /BACKUP_ID is required/,
    ],
    [
      {
        ROCKSDB_RESTORE_PARENT_PATH: 'data/restores',
        ROCKSDB_BACKUP_DIR: 'backups',
        ROCKSDB_RESTORE_BACKUP_ID: '1',
        ROCKSDB_PATH: 'data/restores/backup-1-test-run.rocksdb',
      },
      /must not contain/,
    ],
  ] as Array<[NodeJS.ProcessEnv, RegExp]>)('rejects unsafe restore plan %#', (env, error) => {
    expect(() => createRocksdbRestorePlan(env, '/srv/indexer', 'test-run')).toThrow(error);
  });

  it('rejects a malformed generated restore suffix', () => {
    expect(() =>
      createRocksdbRestorePlan(
        { ROCKSDB_RESTORE_PARENT_PATH: 'restore', ROCKSDB_RESTORE_BACKUP_ID: '1' },
        '/srv/indexer',
        '../escape'
      )
    ).toThrow(/suffix/);
  });

  it('keeps Postgres reclaim in dry-run mode without a confirmation', () => {
    expect(() => assertPostgresReclaimConfirmation({}, true)).not.toThrow();
  });

  it('requires an exact second acknowledgement before destructive Postgres reclaim', () => {
    expect(() => assertPostgresReclaimConfirmation({}, false)).toThrow(/POSTGRES_RECLAIM_CONFIRM/);
    expect(() =>
      assertPostgresReclaimConfirmation(
        { POSTGRES_RECLAIM_CONFIRM: 'DROP:indexer_documents-secondary-indexes ' },
        false
      )
    ).toThrow(/must exactly equal/);
    expect(() =>
      assertPostgresReclaimConfirmation(
        { POSTGRES_RECLAIM_CONFIRM: 'DROP:indexer_documents-secondary-indexes' },
        false
      )
    ).not.toThrow();
  });

  it('requires an exact acknowledgement before deleting the retained migration change log', () => {
    expect(() => assertPostgresCaptureTableDropConfirmation({}, false)).not.toThrow();
    expect(() => assertPostgresCaptureTableDropConfirmation({}, true)).toThrow(
      /ROCKSDB_DROP_CHANGE_TABLE_CONFIRM/
    );
    expect(() =>
      assertPostgresCaptureTableDropConfirmation(
        { ROCKSDB_DROP_CHANGE_TABLE_CONFIRM: 'DROP:polkaswap_indexer_migration.rocksdb_changes' },
        true
      )
    ).not.toThrow();
  });
});
