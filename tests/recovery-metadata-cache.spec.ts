import { afterEach, describe, expect, it, vi } from 'vitest';
import { blake2AsHex } from '@polkadot/util-crypto';
import { RecoveryMetadataCache } from '../src/recovery-metadata-cache.js';
import { ChainIndexer } from '../src/worker/chain.js';
import { MemoryRepository } from '../src/repository/memory.js';

const origin = 'ws://127.0.0.1:9948';
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const raw = '0x01020304', witness = blake2AsHex(raw, 256);
const caches: RecoveryMetadataCache[] = [];
function cache(options: ConstructorParameters<typeof RecoveryMetadataCache>[0] = {}) {
  const c = new RecoveryMetadataCache(options); caches.push(c); return c;
}
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
afterEach(() => { for (const c of caches.splice(0)) c.close(); vi.useRealTimers(); });

describe('exact-state witnessed metadata single-flight', () => {
  it('coalesces active identical-origin reads and retains verified bytes for later execution/state consumers', async () => {
    const c = cache(), pending = deferred<string>(), load = vi.fn(() => pending.promise);
    const a = c.read(origin, hash(1), witness, load), b = c.read(origin + '/', hash(1), witness, load);
    await Promise.resolve(); expect(load).toHaveBeenCalledTimes(1);
    pending.resolve(raw); expect(await Promise.all([a, b])).toEqual([raw, raw]);
    expect(await c.read(origin, hash(1), witness, load)).toBe(raw); expect(load).toHaveBeenCalledTimes(1);
  });
  it('never reuses another origin, state, or witness, even when metadata/specVersion could be equal', async () => {
    const c = cache(), load = vi.fn(async () => raw);
    await c.read(origin, hash(1), witness, load);
    await c.read('ws://127.0.0.1:9944', hash(1), witness, load);
    await c.read(origin, hash(2), witness, load);
    await expect(c.read(origin, hash(1), hash(9), load)).rejects.toThrow('witness mismatch');
    expect(load).toHaveBeenCalledTimes(4);
    expect(await c.read(origin, hash(1), witness, load)).toBe(raw);
    expect(load).toHaveBeenCalledTimes(4);
  });
  it.each([null, 'garbage', '0x', '0x01020305', '0x0'])('rejects malformed or mismatched bytes %s and permits a fresh valid request', async (value) => {
    const c = cache(); await expect(c.read(origin, hash(1), witness, async () => value)).rejects.toThrow('witness mismatch');
    expect(await c.read(origin, hash(1), witness, async () => raw)).toBe(raw);
  });
  it('evicts rejection and timeout, ignores late values, and retains the 15000ms default', async () => {
    vi.useFakeTimers(); const c = cache(), pending = deferred<string>();
    const first = c.read(origin, hash(1), witness, () => pending.promise);
    const rejected = expect(first).rejects.toThrow('timed out after 15000ms');
    await vi.advanceTimersByTimeAsync(14999); expect((c as any).entries.size).toBe(1);
    await vi.advanceTimersByTimeAsync(1); await rejected;
    pending.resolve('0x9999'); await Promise.resolve(); await Promise.resolve();
    expect(await c.read(origin, hash(1), witness, async () => raw)).toBe(raw);
    await expect(c.read(origin, hash(2), witness, async () => { throw new Error('wire failed'); })).rejects.toThrow('wire failed');
    expect(await c.read(origin, hash(2), witness, async () => raw)).toBe(raw);
  });
  it('one borrower cancellation leaves the other live borrower intact', async () => {
    const c = cache(), p = deferred<string>(), abort = new AbortController(), load = vi.fn(() => p.promise);
    const a = c.read(origin, hash(1), witness, load, abort.signal), b = c.read(origin, hash(1), witness, load);
    const rejected = expect(a).rejects.toThrow('borrower cancelled'); abort.abort(); await rejected;
    p.resolve(raw); expect(await b).toBe(raw); expect(load).toHaveBeenCalledTimes(1);
    expect(await c.read(origin, hash(1), witness, load)).toBe(raw);
  });
  it('last-borrower cancellation and shutdown evict pending work and forbid late cache admission', async () => {
    const c = cache(), p = deferred<string>(), abort = new AbortController();
    const a = c.read(origin, hash(1), witness, () => p.promise, abort.signal);
    await Promise.resolve(); const rejected = expect(a).rejects.toThrow('borrower cancelled'); abort.abort(); await rejected;
    p.resolve(raw); await Promise.resolve();
    const load = vi.fn(async () => raw); expect(await c.read(origin, hash(1), witness, load)).toBe(raw); expect(load).toHaveBeenCalledTimes(1);
    const pending = c.read(origin, hash(2), witness, () => new Promise(() => undefined));
    const closed = expect(pending).rejects.toThrow('cache closed'); c.close(); await closed;
    await expect(c.read(origin, hash(1), witness, load)).rejects.toThrow('cancelled');
  });
  it('does not start a loader cancelled before its microtask and rejects already-cancelled borrowers', async () => {
    const c = cache(), abort = new AbortController(), load = vi.fn(async () => raw);
    const p = c.read(origin, hash(1), witness, load, abort.signal);
    const rejected = expect(p).rejects.toThrow('cancelled'); abort.abort(); await rejected;
    await expect(c.read(origin, hash(1), witness, load, abort.signal)).rejects.toThrow('cancelled');
    expect(load).not.toHaveBeenCalled();
  });
  it('bounds active entry count without evicting in-flight borrowers and evicts completed LRU entries', async () => {
    const c = cache({ maximumEntries: 1 }), p = deferred<string>();
    const a = c.read(origin, hash(1), witness, () => p.promise);
    await expect(c.read(origin, hash(2), witness, async () => raw)).rejects.toThrow('active-entry bound');
    p.resolve(raw); await a; await c.read(origin, hash(2), witness, async () => raw);
    const load = vi.fn(async () => raw); await c.read(origin, hash(1), witness, load); expect(load).toHaveBeenCalledTimes(1);
  });
  it('bounds retained bytes and serves but does not retain a valid larger entry', async () => {
    const c = cache({ maximumBytes: raw.length }), load = vi.fn(async () => raw);
    await c.read(origin, hash(1), witness, load); await c.read(origin, hash(2), witness, load);
    expect((c as any).retainedBytes).toBe(raw.length); expect((c as any).entries.size).toBe(1);
    const small = cache({ maximumBytes: 1 }); await small.read(origin, hash(1), witness, load);
    await small.read(origin, hash(1), witness, load); expect((small as any).retainedBytes).toBe(0);
    expect((small as any).entries.size).toBe(0); expect(load).toHaveBeenCalledTimes(4);
  });
  it('rejects excessive responses and unsafe identities without poisoning a valid cache entry', async () => {
    const c = cache(), load = vi.fn(async () => raw);
    for (const o of ['file:///tmp/x', 'ws://user:secret@host', origin + '#fragment', 'bad']) {
      await expect(c.read(o, hash(1), witness, load)).rejects.toThrow(/origin|identity/);
    }
    await expect(c.read(origin, '0x00', witness, load)).rejects.toThrow('identity');
    expect(load).not.toHaveBeenCalled();
    await expect(c.read(origin, hash(1), witness, async () => '0x' + '00'.repeat(8 * 1024 * 1024))).rejects.toThrow('witness mismatch');
  });
  it.each([{ timeoutMs: 0 }, { timeoutMs: 120001 }, { maximumEntries: 0 }, { maximumEntries: 129 }, { maximumBytes: 0 }, { maximumBytes: 33 * 1024 * 1024 }])('rejects invalid finite options %j', (options) => {
    expect(() => new RecoveryMetadataCache(options)).toThrow('bounds');
  });
  it('actual worker shares identical configured providers, separates distinct origins, and closes cache on stop', async () => {
    const make = (archive: string) => {
      const worker = new ChainIndexer({ soraWsEndpoint: origin, soraArchiveWsEndpoint: archive, chainRpcTimeoutMs: 1000 } as never, new MemoryRepository()) as any;
      worker.config.statsRecoveryAdmission = { policy: {} };
      const primary = { rpc: { state: { getMetadata: { raw: vi.fn(async () => raw) } } } };
      const secondary = { rpc: { state: { getMetadata: { raw: vi.fn(async () => raw) } } } };
      worker.api = primary; worker.legacyBlockApi = secondary; return { worker, primary, secondary };
    };
    const same = make(origin);
    expect(await Promise.all([same.worker.readRecoveryMetadata(same.primary, hash(1), witness), same.worker.readRecoveryMetadata(same.secondary, hash(1), witness)])).toEqual([raw, raw]);
    expect(same.primary.rpc.state.getMetadata.raw.mock.calls.length + same.secondary.rpc.state.getMetadata.raw.mock.calls.length).toBe(1);
    const other = make('ws://127.0.0.1:9944');
    await Promise.all([other.worker.readRecoveryMetadata(other.primary, hash(1), witness), other.worker.readRecoveryMetadata(other.secondary, hash(1), witness)]);
    expect(other.primary.rpc.state.getMetadata.raw).toHaveBeenCalledTimes(1); expect(other.secondary.rpc.state.getMetadata.raw).toHaveBeenCalledTimes(1);
    await same.worker.stop(); await other.worker.stop();
    await expect(same.worker.readRecoveryMetadata(same.primary, hash(1), witness)).rejects.toThrow(/owned|cancelled/);
  });
});
