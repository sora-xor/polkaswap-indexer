import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SORA_MAINNET_GENESIS_HASH } from '../src/soraIdentity.js';

// Import the real entry point with inert storage and HTTP boundaries; signal callbacks are
// captured instead of being registered on the test runner. The hold status is the real
// verifier (observed through a spy), so the manifest must be one the service accepts.
const fixture = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  open: vi.fn(), prepare: vi.fn(), close: vi.fn(), get: vi.fn(), status: vi.fn(),
  startServer: vi.fn(), stopAccepting: vi.fn(), stop: vi.fn(),
}));
vi.mock('../src/config.js', () => ({ readConfig: () => fixture.config }));
vi.mock('../src/recovery-hold.js', () => ({ createRecoveryHoldStatus: fixture.status }));
vi.mock('../src/repository/rocksdb.js', () => ({ RocksRepository: { openReadOnly: fixture.open } }));
vi.mock('../src/server.js', () => ({ startServer: fixture.startServer }));

const { createRecoveryHoldStatus, PRE_FORK_HISTORY_HOLD_CHECKPOINT: PREFIX } =
  await vi.importActual<typeof import('../src/recovery-hold.js')>('../src/recovery-hold.js');
const rocksdbPath = '/srv/polkaswap/hold.rocksdb';
/** The complete verified pre-fork prefix checkpoint, as in tests/recovery-hold.spec.ts. */
const checkpoint = { genesisHash: SORA_MAINNET_GENESIS_HASH, lastIndexedBlock: PREFIX.block, blockHash: PREFIX.hash, blockTimestamp: PREFIX.timestamp };
type ChainState = { genesisHash: string; lastIndexedBlock: number; blockHash: string; blockTimestamp: number };
const chainState = (state: ChainState) => ({
  collection: 'updatesStreams', id: 'chainState', blockHeight: state.lastIndexedBlock, timestamp: state.blockTimestamp,
  data: { id: 'chainState', block: state.lastIndexedBlock, data: JSON.stringify(state) },
});
const repository = { prepare: fixture.prepare, close: fixture.close, get: fixture.get };
const server = { stopAccepting: fixture.stopAccepting, stop: fixture.stop };
/** A stop() call that stays pending until the test settles it. */
const pendingStop = () => {
  const settle = {} as { resolve: () => void; reject: (error: Error) => void };
  fixture.stop.mockReturnValueOnce(new Promise<void>((resolve, reject) => Object.assign(settle, { resolve, reject })));
  return settle;
};
let directory: string, argv: string[], signals: Map<string, () => void>;
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
const boot = (...args: string[]) => {
  process.argv = [process.execPath, resolve('src/scripts/serve-recovery-hold.ts'), ...args];
  return import('../src/scripts/serve-recovery-hold.js');
};
const manifest = async (value: Record<string, unknown>) => {
  const file = join(directory, 'hold-manifest.json');
  await writeFile(file, JSON.stringify(value));
  return file;
};
const valid = { schemaVersion: 1, rocksdbPath, checkpoint, observedFinalizedBlock: 28_193_000, dataStatus: 'pre-fork-prefix' };

beforeEach(async () => {
  vi.resetModules(); vi.resetAllMocks();
  argv = process.argv;
  directory = await mkdtemp(join(tmpdir(), 'recovery-hold-entry-'));
  fixture.config = { storageEngine: 'rocksdb', rocksdbPath };
  fixture.open.mockReturnValue(repository);
  fixture.prepare.mockResolvedValue(undefined);
  fixture.close.mockResolvedValue(undefined);
  fixture.get.mockResolvedValue(chainState(checkpoint));
  fixture.status.mockImplementation(createRecoveryHoldStatus);
  fixture.startServer.mockResolvedValue(server);
  fixture.stop.mockResolvedValue(undefined);
  signals = new Map();
  const once = process.once.bind(process);
  vi.spyOn(process, 'once').mockImplementation(((name: string, callback: () => void) => {
    if (name === 'SIGINT' || name === 'SIGTERM') { signals.set(name, callback); return process; }
    return once(name, callback);
  }) as typeof process.once);
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(async () => {
  process.argv = argv;
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

describe('recovery hold entry point', () => {
  it.each([
    ['no manifest', []],
    ['an empty path', ['']],
    ['a relative path', ['hold-manifest.json']],
    ['two manifests', ['/srv/a.json', '/srv/b.json']],
  ])('requires exactly one absolute manifest path (%s)', async (_label, args) => {
    await expect(boot(...args)).rejects.toThrow('One absolute hold manifest is required');
    expect(fixture.open).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown schema version', { ...valid, schemaVersion: 2 }, {}],
    ['a PostgreSQL configuration', valid, { storageEngine: 'postgres' }],
    ['a different database path', { ...valid, rocksdbPath: '/srv/polkaswap/live.rocksdb' }, {}],
  ])('refuses %s before opening storage', async (_label, value, config) => {
    Object.assign(fixture.config, config);
    await expect(boot(await manifest(value))).rejects.toThrow('Recovery hold storage target mismatch');
    expect(fixture.open).not.toHaveBeenCalled();
  });

  it('serves the pinned hold read-only and exits 0 only after the server has stopped on SIGTERM', async () => {
    await boot(await manifest(valid));
    expect(fixture.open).toHaveBeenCalledWith(fixture.config);
    expect(fixture.prepare).toHaveBeenCalledOnce();
    expect(fixture.status).toHaveBeenCalledWith(repository, checkpoint, 28_193_000, undefined, 'pre-fork-prefix');
    const status = await fixture.status.mock.results[0].value;
    expect(status.getStatus()).toMatchObject({ lifecycle: 'stopped', latestIndexedBlock: PREFIX.block, latestFinalizedBlock: 28_193_000 });
    expect(status.getStatus().lastError).toContain('legacy history through block 28191816');
    expect(fixture.startServer).toHaveBeenCalledWith(fixture.config, repository, status);
    expect(console.info).toHaveBeenCalledWith('Recovery hold API started with native read-only RocksDB; indexing is stopped');
    expect([...signals.keys()].sort()).toEqual(['SIGINT', 'SIGTERM']);
    const stop = pendingStop();
    signals.get('SIGTERM')!(); await flush();
    expect(fixture.stopAccepting).toHaveBeenCalledOnce();
    expect(fixture.stopAccepting.mock.invocationCallOrder[0]).toBeLessThan(fixture.stop.mock.invocationCallOrder[0]);
    expect(process.exit).not.toHaveBeenCalled();
    stop.resolve(); await flush();
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(fixture.close).not.toHaveBeenCalled();
  });

  it('exits 1 only after stopping the server fails', async () => {
    await boot(await manifest(valid));
    const stop = pendingStop();
    signals.get('SIGINT')!(); await flush();
    expect(process.exit).not.toHaveBeenCalled();
    stop.reject(new Error('stop failed')); await flush();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('closes the database when the retained checkpoint does not verify', async () => {
    fixture.get.mockResolvedValueOnce(chainState({ ...checkpoint, blockHash: `0x${'cd'.repeat(32)}` }));
    await expect(boot(await manifest(valid))).rejects.toThrow('Recovery hold database checkpoint changed');
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(fixture.startServer).not.toHaveBeenCalled();
    expect(signals.size).toBe(0);
  });
});
