import type { RepositoryWatchEvent } from './types.js';

/**
 * A bounded identity-only watch queue that retains the latest pending mutation
 * per document. Replacing an id moves it to the tail so delivery order follows
 * the latest event without retaining complete JSON payloads.
 */
export class LatestDocumentWatchQueue {
  readonly maxSize: number;
  private readonly pending = new Map<string, RepositoryWatchEvent>();

  constructor(maxSize: number) {
    if (!Number.isSafeInteger(maxSize) || maxSize < 1) {
      throw new Error('Watch queue maximum must be a positive safe integer');
    }
    this.maxSize = maxSize;
  }

  get length(): number {
    return this.pending.size;
  }

  /** Returns true only when a distinct, still-pending id had to be evicted. */
  push(event: RepositoryWatchEvent): boolean {
    if (this.pending.has(event.id)) {
      this.pending.delete(event.id);
      this.pending.set(event.id, event);
      return false;
    }

    let dropped = false;
    if (this.pending.size >= this.maxSize) {
      const oldest = this.pending.keys().next().value as string | undefined;
      if (oldest !== undefined) this.pending.delete(oldest);
      dropped = true;
    }
    this.pending.set(event.id, event);
    return dropped;
  }

  shift(): RepositoryWatchEvent | undefined {
    const oldest = this.pending.keys().next().value as string | undefined;
    if (oldest === undefined) return undefined;

    const event = this.pending.get(oldest);
    this.pending.delete(oldest);
    return event;
  }

  clear(): void {
    this.pending.clear();
  }
}
