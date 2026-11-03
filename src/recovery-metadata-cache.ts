import { blake2AsHex } from '@polkadot/util-crypto';
import { isNonzeroCanonicalSubstrateHash } from './soraIdentity.js';

type Entry = {
  promise: Promise<string>; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout>;
  settled: boolean; borrowers: number; bytes: number;
};

/**
 * Worker-owned raw metadata single-flight, keyed by origin, exact state hash and release witness.
 * It never substitutes a runtime/specVersion or height range for an observed state. Each caller
 * still validates its canonical header and selects its own execution/state metadata witness.
 */
export class RecoveryMetadataCache {
  private readonly entries = new Map<string, Entry>();
  private retainedBytes = 0;
  private closed = false;
  constructor(private readonly options: { timeoutMs?: number; maximumEntries?: number; maximumBytes?: number } = {}) {
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 1 || this.timeout > 120_000 ||
        !Number.isSafeInteger(this.maximumEntries) || this.maximumEntries < 1 || this.maximumEntries > 128 ||
        !Number.isSafeInteger(this.maximumBytes) || this.maximumBytes < 1 || this.maximumBytes > 32 * 1024 * 1024) {
      throw new Error('Invalid recovery metadata cache bounds');
    }
  }
  private get timeout(): number { return this.options.timeoutMs ?? 15_000; }
  private get maximumEntries(): number { return this.options.maximumEntries ?? 32; }
  private get maximumBytes(): number { return this.options.maximumBytes ?? 16 * 1024 * 1024; }

  private remove(key: string, entry: Entry): void {
    if (this.entries.get(key) !== entry) return;
    this.entries.delete(key); this.retainedBytes -= entry.bytes;
  }

  /** Evict only completed entries; active RPCs remain counted until completion or finite failure. */
  private evict(): boolean {
    for (const [key, entry] of this.entries) {
      if (entry.settled) { this.remove(key, entry); return true; }
    }
    return false;
  }

  /** Validate before cache admission, with bounded ownership and independent borrower cancellation. */
  read(origin: string, stateHash: string, metadataHash: string, load: () => Promise<unknown>, signal?: AbortSignal): Promise<string> {
    if (this.closed || signal?.aborted) return Promise.reject(new Error('Recovery metadata read cancelled'));
    let endpoint: URL;
    try { endpoint = new URL(origin); } catch { return Promise.reject(new Error('Invalid recovery metadata origin')); }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash ||
        !isNonzeroCanonicalSubstrateHash(stateHash) || !isNonzeroCanonicalSubstrateHash(metadataHash)) {
      return Promise.reject(new Error('Invalid recovery metadata identity'));
    }
    const key = JSON.stringify([endpoint.href, 'state_getMetadata', stateHash, metadataHash]);
    let entry = this.entries.get(key);
    if (entry) { this.entries.delete(key); this.entries.set(key, entry); }
    else {
      while (this.entries.size >= this.maximumEntries && this.evict()) { /* bounded LRU */ }
      if (this.entries.size >= this.maximumEntries) return Promise.reject(new Error('Recovery metadata active-entry bound exceeded'));
      let resolve!: (value: string) => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
      entry = { promise, reject, settled: false, borrowers: 0, bytes: 0 };
      this.entries.set(key, entry);
      const captured = entry;
      const fail = (error: unknown) => {
        if (captured.settled) return;
        captured.settled = true; clearTimeout(captured.timer); this.remove(key, captured);
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      captured.reject = fail;
      captured.timer = setTimeout(() => fail(new Error(`Recovery metadata read timed out after ${this.timeout}ms`)), this.timeout);
      captured.timer.unref?.();
      void Promise.resolve().then(() => captured.settled ? undefined : load()).then((raw) => {
        if (captured.settled) return; // A late completion cannot populate an abandoned/expired entry.
        if (typeof raw !== 'string' || raw.length > 16 * 1024 * 1024 || !/^0x(?:[0-9a-f]{2})+$/i.test(raw) ||
            blake2AsHex(raw, 256) !== metadataHash) throw new Error('Recovery metadata cache witness mismatch');
        const bytes = Buffer.byteLength(raw);
        while (this.retainedBytes + bytes > this.maximumBytes && this.evict()) { /* byte-bounded LRU */ }
        captured.settled = true; clearTimeout(captured.timer);
        if (bytes <= this.maximumBytes && this.retainedBytes + bytes <= this.maximumBytes) {
          captured.bytes = bytes; this.retainedBytes += bytes;
        } else this.remove(key, captured); // Valid large responses may be used, but never retained above the bound.
        resolve(raw);
      }).catch(fail);
    }
    const captured = entry;
    captured.borrowers++;
    return new Promise<string>((resolve, reject) => {
      let done = false;
      const finish = (error: unknown, value?: string) => {
        if (done) return; done = true; signal?.removeEventListener('abort', cancel);
        captured.borrowers--;
        if (!captured.settled && captured.borrowers === 0) captured.reject(new Error('Recovery metadata read abandoned'));
        if (error) reject(error); else resolve(value!);
      };
      const cancel = () => finish(new Error('Recovery metadata borrower cancelled'));
      signal?.addEventListener('abort', cancel, { once: true });
      void captured.promise.then((value) => finish(null, value), (error: unknown) => finish(error));
    });
  }

  /** Worker shutdown cancels pending borrowers and prevents all late cache admission. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.entries.values()) if (!entry.settled) entry.reject(new Error('Recovery metadata cache closed'));
    this.entries.clear(); this.retainedBytes = 0;
  }
}
