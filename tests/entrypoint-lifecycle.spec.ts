import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Import the actual process entry points with inert storage/network boundaries.
// Capture their signal callbacks without delivering signals to the test runner.
const fixture = vi.hoisted(() => ({
  config: {} as Record<string, unknown>, archive: '',
  explicit: vi.fn(), standalone: vi.fn(), preflight: vi.fn(), migrate: vi.fn(),
  shouldMigrate: vi.fn(), create: vi.fn(), acquire: vi.fn(), leaseLoss: vi.fn(),
  startServer: vi.fn(), startObservability: vi.fn(),
  start: vi.fn(), stop: vi.fn(), prepare: vi.fn(), close: vi.fn(), release: vi.fn(),
  stopAccepting: vi.fn(), stopHttp: vi.fn(), constructed: vi.fn(),
}));
vi.mock('../src/config.js', () => ({
  readConfig: () => fixture.config,
  assertExplicitProductionWorkerChainInputs: fixture.explicit,
  readSoraArchiveWsEndpoint: () => fixture.archive,
}));
vi.mock('../src/deployment.js', () => ({ assertStandaloneStorageMode: fixture.standalone }));
vi.mock('../src/db/migrate.js', () => ({ migrate: fixture.migrate }));
vi.mock('../src/repository/factory.js', () => ({ createRepository: fixture.create, shouldRunPostgresMigration: fixture.shouldMigrate }));
vi.mock('../src/server.js', () => ({ startServer: fixture.startServer }));
vi.mock('../src/worker/observability.js', () => ({ startWorkerObservabilityServer: fixture.startObservability }));
vi.mock('../src/worker/identityPreflight.js', () => ({ preflightSoraMainnetIdentity: fixture.preflight }));
vi.mock('../src/worker/lease.js', () => ({ acquirePostgresWorkerLease: fixture.acquire, stopOnWorkerLeaseLoss: fixture.leaseLoss }));
vi.mock('../src/worker/chain.js', () => ({
  ChainIndexer: class {
    start = fixture.start;
    stop = fixture.stop;
    constructor(...args: unknown[]) { fixture.constructed(...args); }
  },
}));

let signals: Map<string, (...args: any[]) => void>;
let priorExitCode: typeof process.exitCode;
const repository = { prepare: fixture.prepare, close: fixture.close };
const lease = { fencingToken: 'fixture-fence', release: fixture.release };
const http = { stopAccepting: fixture.stopAccepting, stop: fixture.stopHttp };
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };

beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  fixture.config = {
    storageEngine: 'postgres', skipPostgresMigration: false,
    soraWsEndpoint: 'wss://primary.invalid', databaseUrl: 'postgres://fixture',
    postgresConnectionTimeoutMs: 1, postgresQueryTimeoutMs: 2, postgresStatementTimeoutMs: 3,
  };
  fixture.archive = '';
  for (const fn of [fixture.preflight, fixture.migrate, fixture.start, fixture.stop, fixture.prepare, fixture.close, fixture.release, fixture.stopHttp]) fn.mockResolvedValue(undefined);
  fixture.shouldMigrate.mockReturnValue(true);
  fixture.create.mockResolvedValue(repository); fixture.acquire.mockResolvedValue(lease);
  fixture.startServer.mockResolvedValue(http); fixture.startObservability.mockResolvedValue(http);
  fixture.leaseLoss.mockReturnValue(undefined);
  signals = new Map();
  const once = process.once.bind(process);
  vi.spyOn(process, 'once').mockImplementation(((name: string, callback: (...args: any[]) => void) => {
    if (name === 'SIGINT' || name === 'SIGTERM') { signals.set(name, callback); return process; }
    return once(name, callback);
  }) as typeof process.once);
  priorExitCode = process.exitCode; process.exitCode = undefined;
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { process.exitCode = priorExitCode; vi.restoreAllMocks(); });

describe.each(['combined', 'worker'] as const)('%s process lifecycle', (kind) => {
  const boot = () => kind === 'combined' ? import('../src/combined.js') : import('../src/worker/index.js');
  const startHttp = () => kind === 'combined' ? fixture.startServer : fixture.startObservability;

  it('verifies identity before storage and passes the fenced repository to the worker', async () => {
    fixture.archive = 'wss://archive.invalid';
    await boot();
    expect(fixture.preflight.mock.calls).toEqual([
      ['wss://primary.invalid', { requireAnchorTimestamp: true, historicalEndpoint: 'wss://archive.invalid' }],
      ['wss://archive.invalid'],
    ]);
    expect(fixture.preflight.mock.invocationCallOrder[0]).toBeLessThan(fixture.migrate.mock.invocationCallOrder[0]!);
    expect(fixture.migrate.mock.invocationCallOrder[0]).toBeLessThan(fixture.acquire.mock.invocationCallOrder[0]!);
    expect(fixture.create).toHaveBeenCalledWith(fixture.config, { postgresWorkerFencingToken: lease.fencingToken });
    expect(fixture.constructed).toHaveBeenCalledWith(fixture.config, repository);
    expect(fixture.start).toHaveBeenCalledOnce();
    expect(signals.size).toBe(2);
    if (kind === 'combined') expect(fixture.startServer.mock.calls[0]?.[0].skipPostgresMigration).toBe(true);
    else expect(fixture.prepare).toHaveBeenCalledOnce();
  });

  it('stops before touching storage when identity admission fails', async () => {
    fixture.preflight.mockRejectedValue(new Error('wrong chain'));
    await expect(boot()).rejects.toThrow('wrong chain');
    expect(fixture.create).not.toHaveBeenCalled(); expect(fixture.acquire).not.toHaveBeenCalled();
  });

  it('honors the explicit migration skip', async () => {
    fixture.config.skipPostgresMigration = true;
    await boot(); expect(fixture.migrate).not.toHaveBeenCalled();
    expect(fixture.preflight).toHaveBeenCalledExactlyOnceWith('wss://primary.invalid', { requireAnchorTimestamp: true, historicalEndpoint: undefined });
  });

  it('does not migrate a repository that does not require PostgreSQL migration', async () => {
    fixture.shouldMigrate.mockReturnValue(false);
    fixture.config.storageEngine = 'rocksdb';
    await boot(); expect(fixture.migrate).not.toHaveBeenCalled(); expect(fixture.acquire).not.toHaveBeenCalled();
    expect(fixture.create).toHaveBeenCalledWith(fixture.config, { postgresWorkerFencingToken: undefined });
  });

  it('releases the lease when repository initialization fails, even if release fails too', async () => {
    fixture.create.mockRejectedValue(new Error('open failed')); fixture.release.mockRejectedValue(new Error('lease failed'));
    await expect(boot()).rejects.toThrow('open failed'); expect(fixture.release).toHaveBeenCalledOnce();
    expect(fixture.start).not.toHaveBeenCalled();
  });

  it('cleans up the worker and repository if HTTP startup fails', async () => {
    startHttp().mockRejectedValue(new Error('listen failed'));
    await expect(boot()).rejects.toThrow('listen failed');
    expect(fixture.stop).toHaveBeenCalledOnce(); expect(fixture.close).toHaveBeenCalledOnce(); expect(fixture.release).toHaveBeenCalledOnce();
  });

  it('preserves the startup error when cleanup also fails', async () => {
    startHttp().mockRejectedValue(new Error('listen failed'));
    fixture.stop.mockRejectedValue(new Error('stop failed')); fixture.release.mockRejectedValue(new Error('release failed'));
    await expect(boot()).rejects.toThrow('listen failed');
    expect(fixture.close).toHaveBeenCalledOnce(); expect(fixture.release).toHaveBeenCalledOnce();
  });

  it.each(['SIGINT', 'SIGTERM'])('handles %s with idempotent ordered shutdown', async signal => {
    await boot();
    signals.get(signal)!(signal); signals.get(signal)!(signal); await flush();
    expect(fixture.stopAccepting).toHaveBeenCalledOnce(); expect(fixture.stop).toHaveBeenCalledOnce();
    expect(fixture.stopHttp).toHaveBeenCalledOnce(); expect(fixture.release).toHaveBeenCalledOnce();
    expect(fixture.stop.mock.invocationCallOrder[0]).toBeLessThan(fixture.stopHttp.mock.invocationCallOrder[0]!);
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('preserves a prior failing exit code during shutdown', async () => {
    await boot(); process.exitCode = 7; signals.get('SIGTERM')!('SIGTERM'); await flush();
    expect(process.exit).toHaveBeenCalledWith(7);
  });

  it('reports shutdown failure and still attempts the remaining cleanup', async () => {
    await boot(); fixture.stop.mockRejectedValue(new Error('stop failed'));
    signals.get('SIGTERM')!('SIGTERM'); await flush();
    expect(process.exit).toHaveBeenCalledWith(1); expect(fixture.release).toHaveBeenCalledOnce();
  });

  it('marks a lost lease as failure', async () => {
    fixture.leaseLoss.mockImplementation((_lease, _stop, onLost) => { onLost(new Error('lease lost')); return Promise.resolve(); });
    await boot(); expect(process.exitCode).toBe(1); expect(console.error).toHaveBeenCalled();
  });

  it('reports failure to shut down after losing the lease', async () => {
    fixture.leaseLoss.mockRejectedValue(new Error('lease cleanup failed'));
    await boot(); await flush(); expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith('Failed to shut down after losing the PostgreSQL worker lease', expect.any(Error));
  });

  it.each([false, true])('cleans up after indexer start failure (cleanup failure: %s)', async cleanupFails => {
    fixture.start.mockRejectedValue(new Error('indexer failed'));
    if (cleanupFails) fixture.stopHttp.mockRejectedValue(new Error('http stop failed'));
    if (kind === 'combined') { await boot(); expect(process.exitCode).toBe(1); }
    else await expect(boot()).rejects.toThrow('indexer failed');
    expect(fixture.stop).toHaveBeenCalledOnce(); expect(fixture.release).toHaveBeenCalledOnce();
  });
});

describe('standalone worker preparation', () => {
  it('closes the repository and lease when preparation fails', async () => {
    fixture.prepare.mockRejectedValue(new Error('prepare failed'));
    fixture.close.mockRejectedValue(new Error('close failed'));
    await expect(import('../src/worker/index.js')).rejects.toThrow('prepare failed');
    expect(fixture.release).toHaveBeenCalledOnce(); expect(fixture.start).not.toHaveBeenCalled();
  });
  it('supports a repository without optional preparation', async () => {
    fixture.create.mockResolvedValue({ close: fixture.close });
    await import('../src/worker/index.js'); expect(fixture.start).toHaveBeenCalledOnce();
  });
});

describe('standalone API lifecycle', () => {
  it('checks the deployment mode, starts the API, and closes on a signal', async () => {
    await import('../src/index.js');
    expect(fixture.standalone).toHaveBeenCalledWith(fixture.config, 'api');
    signals.get('SIGINT')!('SIGINT'); await flush();
    expect(fixture.stopHttp).toHaveBeenCalledOnce(); expect(process.exit).toHaveBeenCalledWith(0);
  });
  it('reports API startup failure without invoking a missing server on shutdown', async () => {
    fixture.startServer.mockRejectedValue(new Error('listen failed'));
    await import('../src/index.js'); signals.get('SIGTERM')!('SIGTERM'); await flush();
    expect(process.exitCode).toBe(1); expect(fixture.stopHttp).not.toHaveBeenCalled();
  });
  it('exits unsuccessfully when API shutdown fails', async () => {
    fixture.stopHttp.mockRejectedValue(new Error('stop failed'));
    await import('../src/index.js'); signals.get('SIGTERM')!('SIGTERM'); await flush();
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
