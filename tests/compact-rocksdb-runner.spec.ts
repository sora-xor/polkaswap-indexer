import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ open: vi.fn(), compact: vi.fn(), close: vi.fn(), exists: vi.fn(), current: vi.fn(), available: vi.fn() }));
vi.mock('@harperfast/rocksdb-js', () => ({ RocksDatabase: { open: f.open } }));
vi.mock('../src/repository/rocksdb-maintenance.js', () => ({ rocksAvailableBytes: f.available }));
vi.mock('../src/scripts/rocksdb-artifact-source.js', () => ({ assertExistingRocksdbDirectory: f.exists, assertCurrentRocksdbArtifactSource: f.current }));
beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  f.compact.mockResolvedValue(undefined); f.exists.mockResolvedValue(undefined); f.available.mockResolvedValue(20 * 1024 ** 3);
  f.open.mockReturnValue({ compact: f.compact, close: f.close });
  vi.stubEnv('ROCKSDB_PATH', '/isolated-mock-checkpoint'); vi.stubEnv('ROCKSDB_COMPACT_PREFIX', 'indexes'); vi.stubEnv('ROCKSDB_COMPACTION_MIN_FREE_GB', '1');
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const run = () => import('../src/scripts/compact-rocksdb.js');
describe('explicit RocksDB compaction command', () => {
  it.each(['', ' ', 'unknown', 'documents:', 'documents:unknown'])('rejects invalid range before storage access: %j', async prefix => {
    vi.stubEnv('ROCKSDB_COMPACT_PREFIX', prefix); await expect(run()).rejects.toThrow(); expect(f.open).not.toHaveBeenCalled();
  });
  it.each([
    ['indexes', ['x']], ['documents', ['d']], ['documents:assets', ['d', 'assets']],
  ])('compacts only the explicitly requested %s key range', async (prefix, start) => {
    vi.stubEnv('ROCKSDB_COMPACT_PREFIX', prefix as string); await run();
    expect(f.compact).toHaveBeenCalledWith({ start, end: [...start, Buffer.from([0xff])] });
    expect(f.current).toHaveBeenCalledOnce(); expect(f.close).toHaveBeenCalledOnce();
    expect(f.current.mock.invocationCallOrder[0]).toBeLessThan(f.compact.mock.invocationCallOrder[0]!);
  });
  it('requires an explicit all value to compact the entire database', async () => {
    vi.stubEnv('ROCKSDB_COMPACT_PREFIX', ' all '); await run(); expect(f.compact).toHaveBeenCalledWith(); expect(f.close).toHaveBeenCalledOnce();
  });
  it('refuses compaction when free storage is below the configured reserve', async () => {
    f.available.mockResolvedValue(1024 ** 3 - 1); await expect(run()).rejects.toThrow('free bytes'); expect(f.open).not.toHaveBeenCalled();
  });
  it.each(['exists', 'available'])('does not open RocksDB after %s preflight fails', async step => {
    f[step as 'exists' | 'available'].mockRejectedValue(new Error('preflight failed')); await expect(run()).rejects.toThrow('preflight failed'); expect(f.open).not.toHaveBeenCalled();
  });
  it('closes the opened database when artifact qualification fails', async () => {
    f.current.mockImplementation(() => { throw new Error('unqualified artifact'); }); await expect(run()).rejects.toThrow('unqualified artifact'); expect(f.compact).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledOnce();
  });
  it('closes the opened database when compaction fails', async () => {
    f.compact.mockRejectedValue(new Error('compaction failed')); await expect(run()).rejects.toThrow('compaction failed'); expect(f.close).toHaveBeenCalledOnce();
  });
  it('allows exactly the configured reserve', async () => {
    f.available.mockResolvedValue(1024 ** 3); await run(); expect(f.compact).toHaveBeenCalledOnce();
  });
});
