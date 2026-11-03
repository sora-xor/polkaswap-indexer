import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ preparing: false, closed: false, writes: 0, closes: 0, parentLost: false,
  waitPrepare: true, rejectPrepare: undefined as undefined | ((error: Error) => void), closeError: false }));
const base = '/Users/administrator/apps/pi-indexer-recovery-20261009';
const database = `${base}/restores/pi-stats-history-private-20261101`;
const source = `${base}/restores/pi-canonical-prefix-20261101-return-01`;
const evidence = `${base}/pi-stats-initialization-20261101/evidence`;
vi.mock('../src/config.js', () => ({ readConfig: () => ({ storageEngine: 'rocksdb',
  rocksdbPath: '/Users/administrator/apps/pi-indexer-recovery-20261009/restores/pi-stats-history-private-20261101', rocksdbDocumentCompression: 'none' }) }));
vi.mock('../src/stats-recovery.js', () => ({ loadStatsRecoveryAdmission: () => ({
  databasePath: '/Users/administrator/apps/pi-indexer-recovery-20261009/restores/pi-stats-history-private-20261101',
  sourceDatabasePath: '/Users/administrator/apps/pi-indexer-recovery-20261009/restores/pi-canonical-prefix-20261101-return-01' }),
  requireStatsRecoveryState: async () => undefined, statsEvidenceDigest: () => 'a'.repeat(64) }));
vi.mock('../src/pi-stats-recovery-admission.js', () => ({
  PI_STATS_DATABASE: '/Users/administrator/apps/pi-indexer-recovery-20261009/restores/pi-stats-history-private-20261101',
  PI_STATS_SOURCE_DATABASE: '/Users/administrator/apps/pi-indexer-recovery-20261009/restores/pi-canonical-prefix-20261101-return-01',
  validatePiStatsQualification: () => ({ files: {} }), preparePiStatsRecoverySeed: async () => [{ id: 'synthetic-seed' }] }));
vi.mock('../src/scripts/initialize-stats-recovery.js', () => ({ readStatsQualificationFile: async () => Buffer.from('{}'),
  verifyStatsCandidateFiles: async (_database: string, _source: string, _files: unknown, check: () => void) => check() }));
vi.mock('../src/scripts/pi-stats-parent.js', () => ({ parsePiParentIdentity: () => ({}), piParentGuard: () => () => {
  if (f.parentLost) throw new Error('Original parent disappeared');
} }));
vi.mock('node:fs/promises', () => ({ realpath: async (path: string) => path }));
vi.mock('../src/repository/rocksdb.js', () => ({ RocksRepository: class {
  prepare() { f.preparing = true; return f.waitPrepare ? new Promise<void>((_resolve, reject) => { f.rejectPrepare = reject; }) : Promise.resolve(); }
  async upsertMany() { f.writes++; }
  close() { f.closes++; f.closed = true; f.rejectPrepare?.(new Error('Preparation stopped during close'));
    return f.closeError ? Promise.reject(new Error('Native close failed')) : Promise.resolve(); }
} }));
import { initializePiStatsRecovery } from '../src/scripts/initialize-pi-stats-recovery.js';
const args = [`${evidence}/stats-admission.json`, 'a'.repeat(64), `${evidence}/qualification`,
  `${evidence}/initializer-parent.json`, 'b'.repeat(64), '--apply-private-pi-stats-copy'];
const realProcess = process;
beforeEach(() => vi.stubGlobal('process', new Proxy(realProcess, { get(target, key) {
  if (key === 'platform') return 'darwin';
  if (key === 'getuid') return () => 501;
  if (key === 'getgid') return () => 20;
  const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
} })));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); Object.assign(f, { preparing: false,
  closed: false, writes: 0, closes: 0, parentLost: false, waitPrepare: true, rejectPrepare: undefined, closeError: false }); });
describe('Pi initializer cooperative close', () => {
  it('closes preparation immediately on SIGTERM without seeding', async () => {
    const listeners = process.listenerCount('SIGTERM'), running = initializePiStatsRecovery(args);
    const rejected = expect(running).rejects.toThrow('Preparation stopped');
    await vi.waitFor(() => expect(f.preparing).toBe(true)); process.emit('SIGTERM'); await rejected;
    expect(f.closed).toBe(true); expect(f.writes).toBe(0); expect(process.listenerCount('SIGTERM')).toBe(listeners);
  });
  it('closes pending preparation when its parent disappears', async () => {
    vi.useFakeTimers(); const running = initializePiStatsRecovery(args), rejected = expect(running).rejects.toThrow('Preparation stopped');
    await vi.waitFor(() => expect(f.preparing).toBe(true)); f.parentLost = true; await vi.advanceTimersByTimeAsync(1000); await rejected;
    expect(f.writes).toBe(0); expect(f.closed).toBe(true);
  });
  it('closes pending preparation at its finite deadline', async () => {
    vi.useFakeTimers(); const running = initializePiStatsRecovery(args), rejected = expect(running).rejects.toThrow('Preparation stopped');
    await vi.waitFor(() => expect(f.preparing).toBe(true)); await vi.advanceTimersByTimeAsync(30 * 60 * 1000); await rejected;
    expect(f.writes).toBe(0); expect(f.closed).toBe(true);
  });
  it('seeds once and awaits close on ordinary success', async () => {
    f.waitPrepare = false; const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await initializePiStatsRecovery(args); expect(f.writes).toBe(1); expect(f.closes).toBe(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ database, workerStarted: false, entitlementsReady: false });
  });
  it('retains a native close failure after interrupted preparation', async () => {
    f.closeError = true; const running = initializePiStatsRecovery(args), rejected = expect(running).rejects.toThrow('Native close failed');
    await vi.waitFor(() => expect(f.preparing).toBe(true)); process.emit('SIGTERM'); await rejected; expect(f.writes).toBe(0);
  });
  it('refuses another proof path before any native construction', async () => {
    await expect(initializePiStatsRecovery([args[0]!, args[1]!, source, ...args.slice(3)])).rejects.toThrow('input paths');
    expect(f.preparing).toBe(false);
  });
});
