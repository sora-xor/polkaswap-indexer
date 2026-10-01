import { createHash, randomBytes } from 'node:crypto';

/** Ephemeral hashed-IP buckets bound memory and query volume; never persisted or logged. */
export class RateLimiter {
  private buckets = new Map<string, { count: number; expires: number }>();
  private salt = randomBytes(32);
  constructor(private maximum = 60, private windowMs = 60_000, private maximumBuckets = 10_000) {}
  allow(address: string, now = Date.now()): boolean {
    for (const [key, bucket] of this.buckets) if (bucket.expires <= now) this.buckets.delete(key);
    const key = createHash('sha256').update(this.salt).update(address).digest('hex');
    const bucket = this.buckets.get(key);
    if (bucket) { if (bucket.count >= this.maximum) return false; bucket.count++; return true; }
    if (this.buckets.size >= this.maximumBuckets) return false;
    this.buckets.set(key, { count: 1, expires: now + this.windowMs }); return true;
  }
}

/** Bound expensive upstream work, releasing capacity even on error. */
export class ConcurrencyLimit {
  private active = 0;
  constructor(private maximum = 6) {}
  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.active >= this.maximum) throw new Error('Service busy');
    this.active++;
    try { return await job(); } finally { this.active--; }
  }
}
