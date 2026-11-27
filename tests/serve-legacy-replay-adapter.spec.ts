import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Import the real entry point with an inert replay module: no socket is opened and no
// upstream is contacted, so the default public URLs are only observed as arguments.
const fixture = vi.hoisted(() => ({
  client: vi.fn(), constructed: vi.fn(), verify: vi.fn(), listen: vi.fn(), close: vi.fn(), create: vi.fn(),
}));
vi.mock('../src/legacy-replay-adapter.js', () => ({
  LEGACY_REPLAY_CAP: { height: 28_191_816 },
  jsonRpcClient: fixture.client,
  createLegacyReplayServer: fixture.create,
  LegacyReplayAdapter: class {
    verify = fixture.verify;
    constructor(...args: unknown[]) { fixture.constructed(...args); }
  },
}));

const keys = ['LEGACY_REPLAY_PORT', 'LEGACY_REPLAY_ARCHIVE_URL', 'LEGACY_REPLAY_RECOVERY_URL'] as const;
let saved: Record<string, string | undefined>;
let ticks: Array<() => void>;
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
/** A close() call that stays pending until the test settles it. */
const pendingClose = () => {
  const settle = {} as { resolve: () => void; reject: (error: Error) => void };
  fixture.close.mockReturnValueOnce(new Promise<void>((resolve, reject) => Object.assign(settle, { resolve, reject })));
  return settle;
};
const boot = (env: Partial<Record<(typeof keys)[number], string>> = {}) => {
  for (const key of keys) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; }
  return import('../src/scripts/serve-legacy-replay-adapter.js');
};

beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  fixture.client.mockImplementation((url: string) => ({ url }));
  fixture.verify.mockResolvedValue(undefined);
  fixture.close.mockResolvedValue(undefined);
  fixture.create.mockReturnValue({ server: { listen: fixture.listen }, close: fixture.close });
  // Capture only the 30 s identity recheck; it is never scheduled on the real clock.
  ticks = [];
  const setInterval = globalThis.setInterval;
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, delay?: number, ...args: unknown[]) => {
    if (delay === 30_000) { ticks.push(callback); return 'recheck' as unknown as NodeJS.Timeout; }
    return setInterval(callback, delay, ...args);
  }) as typeof globalThis.setInterval);
  vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  vi.restoreAllMocks();
});

describe('pre-fork replay entry point', () => {
  it.each(['not-a-port', '', '0', '-1', '1.5', '65536'])('rejects LEGACY_REPLAY_PORT=%j before building upstream clients', async (port) => {
    await expect(boot({ LEGACY_REPLAY_PORT: port })).rejects.toThrow('LEGACY_REPLAY_PORT must be a TCP port');
    expect(fixture.client).not.toHaveBeenCalled();
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it('defaults to the reviewed archive and recovery endpoints on loopback port 9955', async () => {
    await boot();
    expect(fixture.client.mock.calls).toEqual([['https://mof2.sora.org/archive'], ['https://mof2.sora.org']]);
    expect(fixture.constructed).toHaveBeenCalledWith({ url: 'https://mof2.sora.org/archive' }, { url: 'https://mof2.sora.org' });
    expect(fixture.listen).toHaveBeenCalledWith(9955, '127.0.0.1', expect.any(Function));
    fixture.listen.mock.calls[0][2]();
    expect(console.log).toHaveBeenCalledWith('pre-fork replay through block 28191816 on ws://127.0.0.1:9955');
  });

  it('uses explicit endpoints and port, verifying identity before serving', async () => {
    await boot({ LEGACY_REPLAY_PORT: '19955', LEGACY_REPLAY_ARCHIVE_URL: 'http://127.0.0.1:9944', LEGACY_REPLAY_RECOVERY_URL: 'http://127.0.0.1:9945' });
    expect(fixture.client.mock.calls).toEqual([['http://127.0.0.1:9944'], ['http://127.0.0.1:9945']]);
    expect(fixture.verify.mock.invocationCallOrder[0]).toBeLessThan(fixture.create.mock.invocationCallOrder[0]);
    expect(fixture.listen).toHaveBeenCalledWith(19955, '127.0.0.1', expect.any(Function));
  });

  it('never listens when the initial identity check fails', async () => {
    fixture.verify.mockRejectedValueOnce(new Error('Pre-fork replay cap identity mismatch'));
    await expect(boot()).rejects.toThrow('cap identity mismatch');
    expect(fixture.create).not.toHaveBeenCalled();
    expect(ticks).toEqual([]);
  });

  it('keeps serving after a passing recheck and exits 1 only after clients close following a failing one', async () => {
    await boot();
    expect(ticks).toHaveLength(1);
    ticks[0](); await flush();
    expect(fixture.verify).toHaveBeenCalledTimes(2);
    expect(fixture.close).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalled();
    fixture.verify.mockRejectedValueOnce(new Error('Recovery finality does not cover the replay cap'));
    const close = pendingClose();
    ticks[0](); await flush();
    expect(console.error).toHaveBeenCalledWith('Pre-fork replay identity check failed; closing clients');
    expect(clearInterval).toHaveBeenCalledWith('recheck');
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(process.exit).not.toHaveBeenCalled();
    close.resolve(); await flush();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('still exits 1, after the attempt settles, when closing clients fails following a failing recheck', async () => {
    await boot();
    fixture.verify.mockRejectedValueOnce(new Error('identity changed'));
    const close = pendingClose();
    ticks[0](); await flush();
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(process.exit).not.toHaveBeenCalled();
    close.reject(new Error('close failed')); await flush();
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
