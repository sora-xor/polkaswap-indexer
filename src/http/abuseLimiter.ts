export type AbuseLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  scope: 'client' | 'global' | 'capacity';
};

type Bucket = { count: number; resetAt: number };

export type AbuseLimiterOptions = {
  windowMs: number;
  max: number;
  maxKeys: number;
  globalWindowMs: number;
  globalMax: number;
};

/** In-process fixed-window limiter with bounded identity state and a global backstop. */
export class AbuseLimiter {
  private readonly clients = new Map<string, Bucket>();
  private global: Bucket = { count: 0, resetAt: 0 };
  private lastCleanup = 0;

  constructor(private readonly options: AbuseLimiterOptions) {}

  check(client: string, now = Date.now()): AbuseLimitResult {
    this.cleanup(now);
    if (this.global.resetAt <= now) {
      this.global = { count: 0, resetAt: now + this.options.globalWindowMs };
    }
    this.global.count += 1;
    if (this.global.count > this.options.globalMax) {
      return {
        allowed: false,
        limit: this.options.globalMax,
        remaining: 0,
        resetAt: this.global.resetAt,
        scope: 'global',
      };
    }

    let bucket = this.clients.get(client);
    if (!bucket || bucket.resetAt <= now) {
      if (!bucket && this.clients.size >= this.options.maxKeys) {
        return {
          allowed: false,
          limit: this.options.max,
          remaining: 0,
          resetAt: this.global.resetAt,
          scope: 'capacity',
        };
      }
      bucket = { count: 0, resetAt: now + this.options.windowMs };
      this.clients.set(client, bucket);
    }
    bucket.count += 1;
    return {
      allowed: bucket.count <= this.options.max,
      limit: this.options.max,
      remaining: Math.max(0, this.options.max - bucket.count),
      resetAt: bucket.resetAt,
      scope: 'client',
    };
  }

  get trackedKeyCount(): number {
    return this.clients.size;
  }

  private cleanup(now: number): void {
    const interval = Math.max(1_000, Math.min(this.options.windowMs, 10_000));
    if (now - this.lastCleanup < interval) return;
    this.lastCleanup = now;
    for (const [key, bucket] of this.clients) {
      if (bucket.resetAt <= now) this.clients.delete(key);
    }
  }
}
