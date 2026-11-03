import { afterEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({ preparing: false, closed: false, writes: 0, closes: 0,
  waitPrepare: true, rejectPrepare: undefined as undefined | ((error: Error) => void),
  closeError: false }));
const database = '/data/pi-indexer-stats-history-trial-20261101/candidate.rocksdb';
const source = '/data/polkaswap-indexer-recovery-20261101/legacy-db';
vi.mock('../src/config.js', () => ({ readConfig: () => ({ storageEngine: 'rocksdb',
  rocksdbPath: '/data/pi-indexer-stats-history-trial-20261101/candidate.rocksdb', rocksdbDocumentCompression: 'none' }) }));
vi.mock('../src/stats-recovery.js', () => ({ loadStatsRecoveryAdmission: () => ({
  databasePath: '/data/pi-indexer-stats-history-trial-20261101/candidate.rocksdb',
  sourceDatabasePath: '/data/polkaswap-indexer-recovery-20261101/legacy-db' }),
  requireStatsRecoveryState: async () => undefined, statsEvidenceDigest: () => 'a'.repeat(64) }));
vi.mock('../src/stats-recovery-admission.js', () => ({ validateStatsCloneQualification: () => ({ files: {} }),
  prepareStatsRecoverySeed: async () => [{ id: 'synthetic-seed' }] }));
vi.mock('node:fs/promises', () => ({ realpath: async (path: string) => path, readdir: async () => [],
  lstat: async () => { throw new Error('No synthetic file expected'); },
  open: async () => ({ stat: async () => ({ isFile: () => true, size: 2, mtimeMs: 1, ctimeMs: 1 }),
    read: async (raw: Buffer) => { raw.write('{}'); return { bytesRead: 2 }; }, close: async () => undefined }) }));
vi.mock('../src/repository/rocksdb.js', () => ({ RocksRepository: class {
  prepare() { f.preparing = true; return f.waitPrepare ? new Promise<void>((_resolve, reject) => { f.rejectPrepare = reject; }) : Promise.resolve(); }
  async upsertMany() { f.writes++; }
  close() { f.closes++; f.closed = true; f.rejectPrepare?.(new Error('Preparation stopped during close'));
    return f.closeError ? Promise.reject(new Error('Native close failed')) : Promise.resolve(); }
} }));
import { initializeStatsRecovery } from '../src/scripts/initialize-stats-recovery.js';
const args = [database, 'a'.repeat(64), source, source, source, '--apply-private-stats-copy'];
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); Object.assign(f, { preparing: false, closed: false,
  writes: 0, closes: 0, waitPrepare: true, rejectPrepare: undefined, closeError: false }); });

describe('private initializer cooperative shutdown', () => {
  it('SIGTERM closes an in-progress prepare immediately and never seeds afterwards', async () => {
    const before = process.listenerCount('SIGTERM');
    const running = initializeStatsRecovery(args);
    const rejected = expect(running).rejects.toThrow('Preparation stopped during close');
    await vi.waitFor(() => expect(f.preparing).toBe(true));
    process.emit('SIGTERM');
    expect(f.closed).toBe(true);
    await rejected;
    expect(f.writes).toBe(0);
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });
  it('the finite deadline requests close while preparation is still pending', async () => {
    vi.useFakeTimers();
    const running = initializeStatsRecovery(args), rejected = expect(running).rejects.toThrow('Preparation stopped during close');
    await vi.waitFor(() => expect(f.preparing).toBe(true));
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    await rejected;
    expect(f.closed).toBe(true); expect(f.writes).toBe(0);
  });
  it('ordinary successful initialization seeds once and awaits close', async () => {
    f.waitPrepare = false;
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await initializeStatsRecovery(args);
    expect(f.writes).toBe(1); expect(f.closes).toBe(1); expect(f.closed).toBe(true);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ workerStarted: false, entitlementsReady: false });
  });
  it('observes signal-time close rejection and preserves the final close error', async () => {
    f.closeError = true;
    const running = initializeStatsRecovery(args), rejected = expect(running).rejects.toThrow('Native close failed');
    await vi.waitFor(() => expect(f.preparing).toBe(true));
    process.emit('SIGTERM'); await rejected; expect(f.writes).toBe(0);
  });
});
