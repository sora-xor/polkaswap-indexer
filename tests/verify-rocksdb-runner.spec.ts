import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexerDocument } from '../src/repository/types.js';

const f = vi.hoisted(() => ({
  query: vi.fn(), connect: vi.fn(), release: vi.fn(), end: vi.fn(),
  construct: vi.fn(), prepare: vi.fn(), validate: vi.fn(), close: vi.fn(), getMany: vi.fn(), verify: vi.fn(),
}));
vi.mock('pg', () => ({ default: { Pool: class { connect = f.connect; end = f.end; } } }));
vi.mock('../src/repository/rocksdb.js', () => ({ RocksRepository: class {
  constructor() { f.construct(); }
  prepare = f.prepare; validateCompactIndexes = f.validate; close = f.close; getMany = f.getMany;
} }));
vi.mock('../src/scripts/verify-postgres-rocksdb-logical.js', () => ({ verifyPostgresRocksdbLogicalEquality: f.verify }));
import { runRocksdbVerification } from '../src/scripts/verify-rocksdb.js';

beforeEach(() => {
  vi.resetAllMocks();
  for (const fn of [f.end, f.prepare, f.validate, f.close]) fn.mockResolvedValue(undefined);
  f.connect.mockResolvedValue({ query: f.query, release: f.release });
  f.query.mockResolvedValue({ rows: [] }); f.getMany.mockResolvedValue(new Map()); f.verify.mockResolvedValue(12);
  vi.stubEnv('ROCKSDB_VERIFY_FULL', 'true'); vi.stubEnv('ROCKSDB_VERIFY_BATCH_SIZE', '17');
  vi.stubEnv('ROCKSDB_VERIFY_SAMPLE_SIZE', '3'); vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('RocksDB verification command', () => {
  it('closes the PostgreSQL pool when acquiring a client fails', async () => {
    f.connect.mockRejectedValue(new Error('connection failed'));
    await expect(runRocksdbVerification()).rejects.toThrow('connection failed');
    expect(f.end).toHaveBeenCalledOnce(); expect(f.construct).not.toHaveBeenCalled();
  });
  it('releases the database client if the RocksDB handle cannot be created', async () => {
    f.construct.mockImplementation(() => { throw new Error('RocksDB locked'); });
    await expect(runRocksdbVerification()).rejects.toThrow('RocksDB locked');
    expect(f.release).toHaveBeenCalledOnce(); expect(f.end).toHaveBeenCalledOnce(); expect(f.close).not.toHaveBeenCalled();
  });
  it('verifies under a repeatable-read snapshot and commits before releasing resources', async () => {
    await runRocksdbVerification();
    expect(f.query.mock.calls.map(call => call[0])).toEqual(['begin isolation level repeatable read', 'lock table indexer_documents in share mode', 'commit']);
    expect(f.verify).toHaveBeenCalledWith(expect.anything(), expect.anything(), 17);
    expect(f.validate).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledOnce(); expect(f.close).toHaveBeenCalledOnce(); expect(f.end).toHaveBeenCalledOnce();
    expect(f.query.mock.invocationCallOrder[2]).toBeLessThan(f.release.mock.invocationCallOrder[0]!);
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('exhaustively verified 12'));
  });
  it('samples both ends in canonical ordering and deduplicates overlapping rows', async () => {
    vi.stubEnv('ROCKSDB_VERIFY_FULL', 'false');
    const row = { collection: 'assets', id: 'a', blockHeight: '42', timestamp: '84', dataText: '{"id":"a","supply":"9007199254740993"}' };
    const doc: IndexerDocument = { collection: 'assets', id: 'a', blockHeight: 42, timestamp: 84, data: { id: 'a', supply: '9007199254740993' } };
    f.query.mockImplementation(async (_sql, args) => ({ rows: args?.[0] === 'assets' ? [row] : [] }));
    f.getMany.mockImplementation(async (collection, ids) => new Map(collection === 'assets' ? ids.map((id: string) => [id, doc]) : []));
    await runRocksdbVerification();
    const selects = f.query.mock.calls.filter(call => call[1]?.[0] === 'assets');
    expect(selects.map(call => call[1])).toEqual([['assets', 2], ['assets', 1]]);
    expect(selects[0]?.[0]).toContain('order by id collate "C" asc'); expect(selects[1]?.[0]).toContain('order by id collate "C" desc');
    expect(f.getMany).toHaveBeenCalledWith('assets', ['a']); expect(f.verify).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('sampled 1'));
  });
  it('does not run a tail query for a one-document sample', async () => {
    vi.stubEnv('ROCKSDB_VERIFY_FULL', 'false'); vi.stubEnv('ROCKSDB_VERIFY_SAMPLE_SIZE', '1');
    await runRocksdbVerification();
    expect(f.query.mock.calls.filter(call => call[1]?.[0] === 'assets')).toHaveLength(1);
  });
  it.each(['missing', 'collection', 'id', 'blockHeight', 'timestamp', 'data'])('rejects a sampled %s mismatch and rolls back', async field => {
    vi.stubEnv('ROCKSDB_VERIFY_FULL', 'false');
    const row = { collection: 'assets', id: 'a', blockHeight: null, timestamp: null, dataText: '{"id":"a"}' };
    f.query.mockImplementation(async (_sql, args) => ({ rows: args?.[0] === 'assets' ? [row] : [] }));
    const document: Record<string, unknown> = { collection: 'assets', id: 'a', blockHeight: null, timestamp: null, data: { id: 'a' } };
    document[field] = field === 'data' ? { id: 'b' } : 'different';
    f.getMany.mockResolvedValue(new Map(field === 'missing' ? [] : [['a', document]]));
    await expect(runRocksdbVerification()).rejects.toThrow('assets/a: sampled PostgreSQL/RocksDB document mismatch');
    expect(f.query).toHaveBeenCalledWith('rollback'); expect(f.query).not.toHaveBeenCalledWith('commit'); expect(f.end).toHaveBeenCalledOnce();
  });
  it('treats omitted optional document coordinates as SQL null', async () => {
    vi.stubEnv('ROCKSDB_VERIFY_FULL', 'false');
    f.query.mockImplementation(async (_sql, args) => ({ rows: args?.[0] === 'assets' ? [{ collection: 'assets', id: 'a', blockHeight: null, timestamp: null, dataText: '{"id":"a"}' }] : [] }));
    f.getMany.mockResolvedValue(new Map([['a', { collection: 'assets', id: 'a', data: { id: 'a' } }]]));
    await runRocksdbVerification(); expect(f.query).toHaveBeenCalledWith('commit');
  });
  it.each(['prepare', 'validate', 'verify'])('rolls back and preserves %s failure when cleanup also fails', async step => {
    f[step as 'prepare' | 'validate' | 'verify'].mockRejectedValue(new Error('verification failed'));
    f.query.mockImplementation(async sql => { if (sql === 'rollback') throw new Error('rollback failed'); return { rows: [] }; });
    f.close.mockRejectedValue(new Error('close failed'));
    await expect(runRocksdbVerification()).rejects.toThrow('verification failed');
    expect(f.query).toHaveBeenCalledWith('rollback'); expect(f.release).toHaveBeenCalledOnce(); expect(f.end).toHaveBeenCalledOnce();
  });
  it('rolls back when the database commit fails', async () => {
    f.query.mockImplementation(async sql => { if (sql === 'commit') throw new Error('commit failed'); return { rows: [] }; });
    await expect(runRocksdbVerification()).rejects.toThrow('commit failed'); expect(f.query).toHaveBeenCalledWith('rollback');
  });
});
