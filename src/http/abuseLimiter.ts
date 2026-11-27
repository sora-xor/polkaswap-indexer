export type AbuseLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  scope: 'client' | 'global' | 'capacity';
};

type Bucket = { count: number; resetAt: number };
type ClientExpiry = { client: string; resetAt: number };

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
  // One heap entry per tracked client, bounded by maxKeys. A heap also handles
  // wall-clock adjustments without assuming creation order is expiry order.
  private readonly expirations: ClientExpiry[] = [];
  private global: Bucket = { count: 0, resetAt: 0 };

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
      this.trackExpiry({ client, resetAt: bucket.resetAt });
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

  private trackExpiry(expiry: ClientExpiry): void {
    let index = this.expirations.length;
    this.expirations.push(expiry);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const parentExpiry = this.expirations[parent]!;
      if (parentExpiry.resetAt <= expiry.resetAt) break;
      this.expirations[index] = parentExpiry;
      index = parent;
    }
    this.expirations[index] = expiry;
  }

  private cleanup(now: number): void {
    // Remove only expired clients: staggered expirations must not cause a full
    // map scan on every request, including requests rejected by the global cap.
    while (this.expirations.length > 0 && this.expirations[0]!.resetAt <= now) {
      this.clients.delete(this.expirations[0]!.client);
      const last = this.expirations.pop()!;
      if (this.expirations.length === 0) break;

      let index = 0;
      while (index * 2 + 1 < this.expirations.length) {
        let child = index * 2 + 1;
        if (child + 1 < this.expirations.length &&
            this.expirations[child + 1]!.resetAt < this.expirations[child]!.resetAt) child += 1;
        if (last.resetAt <= this.expirations[child]!.resetAt) break;
        this.expirations[index] = this.expirations[child]!;
        index = child;
      }
      this.expirations[index] = last;
    }
  }
}
