import { describe, expect, it } from 'vitest';

import {
  assertMigrationFollowModeAllowed,
  exportPostgresRows,
  migrationCheckpointErrorMessage,
  readBoundedPositiveInteger,
  selectByteBoundedMigrationPrefix,
} from '../src/scripts/migrate-postgres-to-rocksdb.js';

import type pg from 'pg';
import type { RocksRepository } from '../src/repository/rocksdb.js';
import type { PostgresRocksdbMigrationState } from '../src/scripts/rocksdb-migration-state.js';

describe('PostgreSQL-to-RocksDB byte-bounded fetch planning', () => {
  it('selects the longest ordered prefix that fits the exact byte budget', () => {
    const candidates = [
      { id: 'a', estimatedBytes: '10' },
      { id: 'b', estimatedBytes: 20 },
      { id: 'c', estimatedBytes: '1' },
    ];
    expect(selectByteBoundedMigrationPrefix(candidates, 30).map(({ id }) => id)).toEqual(['a', 'b']);
    expect(selectByteBoundedMigrationPrefix(candidates, 31).map(({ id }) => id)).toEqual(['a', 'b', 'c']);
  });

  it('never skips an oversized middle row to select a later row', () => {
    const candidates = [
      { id: 'a', estimatedBytes: 10 },
      { id: 'blocking', estimatedBytes: 100 },
      { id: 'must-not-skip', estimatedBytes: 1 },
    ];
    expect(selectByteBoundedMigrationPrefix(candidates, 20).map(({ id }) => id)).toEqual(['a']);
  });

  it('fails closed when one row cannot fit, so a migration cannot loop without progress', () => {
    expect(() => selectByteBoundedMigrationPrefix([{ estimatedBytes: 65 }], 64)).toThrow(
      /exceeding the 64-byte batch limit/
    );
  });

  it.each([
    { estimatedBytes: 0 },
    { estimatedBytes: -1 },
    { estimatedBytes: 1.5 },
    { estimatedBytes: '01' },
    { estimatedBytes: 'not-a-size' },
    { estimatedBytes: String(Number.MAX_SAFE_INTEGER + 1) },
  ])('rejects malformed or unsafe row-size estimate %#', (candidate) => {
    expect(() => selectByteBoundedMigrationPrefix([candidate], 100)).toThrow(/Invalid PostgreSQL migration row-size/);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe byte limit %s', (limit) => {
    expect(() => selectByteBoundedMigrationPrefix([], limit)).toThrow(/positive safe integer/);
  });

  it('bounds follow polling instead of allowing timer overflow to become a busy loop', () => {
    expect(readBoundedPositiveInteger('POLL', 2_000, 60_000, {})).toBe(2_000);
    expect(readBoundedPositiveInteger('POLL', 2_000, 60_000, { POLL: '60000' })).toBe(60_000);
    expect(() => readBoundedPositiveInteger('POLL', 2_000, 60_000, { POLL: '60001' })).toThrow(/at most 60000/);
    expect(() => readBoundedPositiveInteger('POLL', 2_000, 60_000, { POLL: '1.5' })).toThrow(/positive integer/);
  });

  it('refuses follow mode after the source is sealed while allowing final recovery', () => {
    expect(() => assertMigrationFollowModeAllowed(false, true)).not.toThrow();
    expect(() => assertMigrationFollowModeAllowed(true, false)).not.toThrow();
    expect(() => assertMigrationFollowModeAllowed(true, true)).toThrow(/cannot resume a sealed source/);
  });

  it('keeps persisted failure receipts non-empty and within the strict state bound', () => {
    expect(migrationCheckpointErrorMessage('')).toBe('Unknown PostgreSQL-to-RocksDB migration failure');
    expect(migrationCheckpointErrorMessage(new Error('x'.repeat(10_000)))).toHaveLength(4_096);
  });

  it('rejects an oversized source candidate before selecting or materializing its raw JSON text', async () => {
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes('estimatedBytes')) {
          return {
            rows: [{ collection: 'assets', id: 'oversized', estimatedBytes: '4097' }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    };
    const pool = { connect: async () => client } as unknown as pg.Pool;
    const state = {
      exportCompleted: false,
      collection: '',
      id: '',
      rows: 0,
    } as PostgresRocksdbMigrationState;

    await expect(
      exportPostgresRows(pool, {} as RocksRepository, state, 100, 4_096)
    ).rejects.toThrow(/requires 4097 bytes, exceeding the 4096-byte batch limit/);
    expect(queries.some((sql) => sql.includes('document.data::text'))).toBe(false);
    expect(queries.at(-1)).toMatch(/rollback/);
  });

  it('rejects a precision-losing raw JSONB row before the destination receives any write', async () => {
    let writes = 0;
    const client = {
      query: async (sql: string) => {
        if (sql.includes('estimatedBytes')) {
          return { rows: [{ collection: 'assets', id: 'lossy', estimatedBytes: '5000' }], rowCount: 1 };
        }
        if (sql.includes('document.data::text')) {
          return {
            rows: [
              {
                collection: 'assets',
                id: 'lossy',
                blockHeight: '1',
                timestamp: '1',
                dataText: '{"id":"lossy","nested":[9007199254740992]}',
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    };
    const pool = { connect: async () => client } as unknown as pg.Pool;
    const repository = {
      upsertMany: async () => {
        writes += 1;
      },
    } as unknown as RocksRepository;
    const state = {
      exportCompleted: false,
      collection: '',
      id: '',
      rows: 0,
    } as PostgresRocksdbMigrationState;

    await expect(exportPostgresRows(pool, repository, state, 100, 10_000)).rejects.toThrow(
      /cannot be represented exactly/
    );
    expect(writes).toBe(0);
  });
});
