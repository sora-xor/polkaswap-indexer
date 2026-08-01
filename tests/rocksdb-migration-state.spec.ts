import { describe, expect, it } from 'vitest';

import {
  capturedChangeHash,
  captureSentinelHash,
} from '../src/scripts/postgres-rocksdb-capture.js';
import {
  assertChangeCaptureContinuity,
  createPostgresRocksdbMigrationState,
  parsePostgresRocksdbMigrationState,
  validateCapturedChangeBatch,
} from '../src/scripts/rocksdb-migration-state.js';

import type { ChangeCaptureDescriptor } from '../src/scripts/postgres-rocksdb-capture.js';
import type { ValidatedCapturedChange } from '../src/scripts/rocksdb-migration-state.js';

const SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const DESTINATION_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const SOURCE_DATABASE_IDENTITY = 'a'.repeat(64);

const descriptor = (overrides: Partial<ChangeCaptureDescriptor> = {}): ChangeCaptureDescriptor => ({
  version: 1,
  sourceId: SOURCE_ID,
  sourceDatabaseIdentity: SOURCE_DATABASE_IDENTITY,
  headSeq: '0',
  headHash: captureSentinelHash(SOURCE_ID),
  sealed: false,
  sealedSeq: null,
  sealedHash: null,
  cutoverRunId: null,
  cutoverDestinationId: null,
  cutoverSeq: null,
  cutoverHash: null,
  ...overrides,
});

describe('Postgres-to-RocksDB migration state', () => {
  it('creates and strictly parses a versioned generation/source/destination checkpoint', () => {
    const state = createPostgresRocksdbMigrationState(descriptor(), {
      destinationId: DESTINATION_ID,
      runId: RUN_ID,
    });
    expect(parsePostgresRocksdbMigrationState(state)).toEqual(state);
    expect(() => parsePostgresRocksdbMigrationState({ ...state, unexpected: true })).toThrow(/unexpected or missing/);
    expect(() => parsePostgresRocksdbMigrationState({ ...state, version: 2 })).toThrow(/version/);
    expect(() => parsePostgresRocksdbMigrationState({ ...state, lastReplayedHash: 'f'.repeat(32) })).toThrow(/SHA-256/);
    expect(() => parsePostgresRocksdbMigrationState({ ...state, status: 'failed', lastError: null })).toThrow(
      /missing error/
    );
    expect(() => parsePostgresRocksdbMigrationState({ ...state, status: 'in_progress', lastError: 'stale' })).toThrow(
      /error is already populated/
    );
    expect(() => parsePostgresRocksdbMigrationState({ ...state, rows: 1 })).toThrow(/row count.*keyset cursor/);
    expect(() =>
      parsePostgresRocksdbMigrationState({ ...state, lastReplayedHash: 'f'.repeat(64) })
    ).toThrow(/unreplayed checkpoint hash/);
    expect(() =>
      parsePostgresRocksdbMigrationState({ ...state, status: 'failed', lastError: 'x'.repeat(4_097) })
    ).toThrow(/migration error/);
  });

  it('binds continuity to the capture generation, source database, sequence, and hash', () => {
    const state = createPostgresRocksdbMigrationState(descriptor(), {
      destinationId: DESTINATION_ID,
      runId: RUN_ID,
    });
    expect(() => assertChangeCaptureContinuity(descriptor(), state)).not.toThrow();
    expect(() =>
      assertChangeCaptureContinuity(descriptor({ sourceId: '44444444-4444-4444-8444-444444444444' }), state)
    ).toThrow(/generation or source/);
    expect(() =>
      assertChangeCaptureContinuity(descriptor({ sourceDatabaseIdentity: 'b'.repeat(64) }), state)
    ).toThrow(/generation or source/);
    expect(() => assertChangeCaptureContinuity(descriptor({ headHash: 'c'.repeat(64) }), state)).toThrow(/hash/);
    expect(() =>
      assertChangeCaptureContinuity(
        descriptor(),
        { ...state, captureStartSeq: '2', lastReplayedSeq: '1' }
      )
    ).toThrow(/precedes capture start/);
  });

  it('validates every predecessor and SHA-256 row hash before replay advancement', () => {
    const sentinelHash = captureSentinelHash(SOURCE_ID);
    const base = {
      sourceId: SOURCE_ID,
      seq: '1',
      previousSeq: '0',
      previousHash: sentinelHash,
      operation: 'I' as const,
      collection: 'assets' as const,
      id: 'xor',
      blockHeight: '10',
      timestamp: '20',
      data: { id: 'xor' },
      dataText: '{"id": "xor"}',
    };
    const row: ValidatedCapturedChange = { ...base, rowHash: capturedChangeHash(base) };
    const state = { sourceId: SOURCE_ID, lastReplayedSeq: '0', lastReplayedHash: sentinelHash };
    expect(validateCapturedChangeBatch([row], state)).toEqual({ lastSeq: '1', lastHash: row.rowHash });
    expect(() => validateCapturedChangeBatch([{ ...row, previousSeq: '9' }], state)).toThrow(/discontinuous/);
    expect(() => validateCapturedChangeBatch([{ ...row, rowHash: 'f'.repeat(64) }], state)).toThrow(/hash mismatch/);
    expect(() => validateCapturedChangeBatch([{ ...row, data: null }], state)).toThrow(/Malformed/);
    expect(() => validateCapturedChangeBatch([row], state, '0')).toThrow(/Malformed/);
  });

  it('requires a matching durable source receipt before accepting validated_complete', () => {
    const sentinelHash = captureSentinelHash(SOURCE_ID);
    const state = {
      ...createPostgresRocksdbMigrationState(descriptor(), {
        destinationId: DESTINATION_ID,
        runId: RUN_ID,
      }),
      status: 'validated_complete' as const,
      exportCompleted: true,
      sealedSeq: '0',
      sealedHash: sentinelHash,
      validatedAt: new Date(0).toISOString(),
    };
    const completed = descriptor({
      sealed: true,
      sealedSeq: '0',
      sealedHash: sentinelHash,
      cutoverRunId: RUN_ID,
      cutoverDestinationId: DESTINATION_ID,
      cutoverSeq: '0',
      cutoverHash: sentinelHash,
    });
    expect(() => assertChangeCaptureContinuity(completed, state)).not.toThrow();
    expect(() => assertChangeCaptureContinuity({ ...completed, cutoverHash: 'f'.repeat(64) }, state)).toThrow(
      /cutover receipt/
    );
    expect(parsePostgresRocksdbMigrationState(state)).toEqual(state);
    expect(() => parsePostgresRocksdbMigrationState({ ...state, exportCompleted: false })).toThrow(
      /export, seal, validation/
    );
    expect(() => parsePostgresRocksdbMigrationState({ ...state, lastError: 'ignored failure' })).toThrow(
      /export, seal, validation/
    );
  });
});
