/** Read-only routing across the retained shared history and the recovery chain. */
export const ARCHIVE_CHECKPOINT = Object.freeze({
  height: 28_191_817,
  hash: '0x7f7c253fa72f32e7b03f32bdc9ae456fd7174fb131b689be6d876006124129f0',
});
export const ARCHIVE_GENESIS = '0x7e4e32d0feafd4f9c9414b0be86373f9a1efa904809b683453a9af6856d38ad5';
/** Observed recovery-branch identity, not a claim that this child is finalized. */
export const RECOVERY_FIRST_CHILD = '0x15f8dc66c3be19d8de14acfe2558209a9140bc94c64aaf00b36507020f6aae75';
type Rpc = (method: string, params: unknown[]) => Promise<unknown>;
const HASH = /^0x[0-9a-f]{64}$/;
const stateHashPositions: Record<string, number> = {
  state_getStorage: 1, state_getStorageAt: 1, state_getStorageHash: 1,
  state_getStorageSize: 1, state_getKeys: 1, state_getPairs: 1,
  state_getKeysPaged: 3, state_queryStorageAt: 1, state_getReadProof: 1,
  state_getMetadata: 0, state_getRuntimeVersion: 0, state_call: 2,
};
const headMethods = ['system_chain', 'system_chainType', 'system_name', 'system_version', 'system_properties', 'system_health', 'chain_getFinalizedHead'];
export const LIVE_SUBSCRIPTIONS = new Set([
  'chain_subscribeNewHeads', 'chain_unsubscribeNewHeads',
  'chain_subscribeFinalizedHeads', 'chain_unsubscribeFinalizedHeads',
  'state_subscribeRuntimeVersion', 'state_unsubscribeRuntimeVersion',
]);
export const ARCHIVE_METHODS = [
  ...headMethods, ...Object.keys(stateHashPositions), 'chain_getBlockHash',
  'chain_getHeader', 'chain_getBlock', 'rpc_methods', ...LIVE_SUBSCRIPTIONS,
];

/** An RPC error safe to return to a caller without exposing transport details. */
export class ArchiveRpcError extends Error {
  constructor(public readonly code: number, message: string) { super(message); }
}

/** Selects only canonical historical hashes; no abandoned-fork head is exposed. */
export class ArchiveRouter {
  private admitted = false;
  private readonly historical = new Map<string, number>();
  constructor(private readonly live: Rpc, private readonly archive: Rpc) {}

  /** Recheck both independent chain identities, failing closed on any mismatch. */
  async verify(): Promise<void> {
    try {
      for (const rpc of [this.live, this.archive]) {
        if (await rpc('chain_getBlockHash', [0]) !== ARCHIVE_GENESIS ||
            await rpc('chain_getBlockHash', [ARCHIVE_CHECKPOINT.height]) !== ARCHIVE_CHECKPOINT.hash) {
          throw new Error('Archive/recovery shared checkpoint mismatch');
        }
      }
      if (await this.live('chain_getBlockHash', [ARCHIVE_CHECKPOINT.height + 1]) !== RECOVERY_FIRST_CHILD) {
        throw new Error('Live upstream is not the pinned recovery branch');
      }
      const child = await this.live('chain_getHeader', [RECOVERY_FIRST_CHILD]) as { parentHash?: string } | null;
      if (child?.parentHash !== ARCHIVE_CHECKPOINT.hash) throw new Error('Recovery child parent mismatch');
      this.admitted = true;
    } catch (error) { this.admitted = false; throw error; }
  }

  /** Identify shared history by height and canonical hash, never by availability alone. */
  private async historicalHeight(hash: string): Promise<number | null> {
    const cached = this.historical.get(hash);
    if (cached !== undefined) return cached;
    const header = await this.archive('chain_getHeader', [hash]) as { number?: unknown } | null;
    if (header && typeof header.number === 'string' && /^0x[0-9a-f]+$/i.test(header.number)) {
      const height = Number(BigInt(header.number));
      if (Number.isSafeInteger(height) && height <= ARCHIVE_CHECKPOINT.height) {
        if (await this.archive('chain_getBlockHash', [height]) !== hash) {
          throw new ArchiveRpcError(-32001, 'Noncanonical historical block');
        }
        if (this.historical.size >= 8192) this.historical.delete(this.historical.keys().next().value!);
        this.historical.set(hash, height);
        return height;
      }
    }
    const current = await this.live('chain_getHeader', [hash]) as { number?: unknown } | null;
    if (!current || typeof current.number !== 'string' || !/^0x[0-9a-f]+$/i.test(current.number)) {
      throw new ArchiveRpcError(-32001, 'Unknown recovery block');
    }
    const height = Number(BigInt(current.number));
    if (!Number.isSafeInteger(height) || height <= ARCHIVE_CHECKPOINT.height ||
        await this.live('chain_getBlockHash', [height]) !== hash) {
      throw new ArchiveRpcError(-32001, 'Noncanonical recovery block');
    }
    return null;
  }

  /** Route one bounded read; omitted block hashes and heads always use the live chain. */
  async call(method: string, params: unknown[]): Promise<unknown> {
    if (!this.admitted) throw new ArchiveRpcError(-32002, 'Archive identity is not verified');
    if (!ARCHIVE_METHODS.includes(method) || LIVE_SUBSCRIPTIONS.has(method)) {
      throw new ArchiveRpcError(-32601, 'Unsupported read-only method');
    }
    if (method === 'rpc_methods') return { version: 1, methods: ARCHIVE_METHODS };
    if (headMethods.includes(method)) return this.live(method, params);
    if (method === 'chain_getBlockHash') {
      if (params.length === 0 || params[0] === null) return this.live(method, params);
      const input = params[0];
      const height = typeof input === 'number' ? input
        : typeof input === 'string' && /^0x[0-9a-f]+$/i.test(input) ? Number(BigInt(input)) : NaN;
      if (!Number.isSafeInteger(height) || height < 0 || params.length > 1) {
        throw new ArchiveRpcError(-32602, 'Expected one nonnegative block height');
      }
      return (height <= ARCHIVE_CHECKPOINT.height ? this.archive : this.live)(method, params);
    }
    const position = method === 'chain_getHeader' || method === 'chain_getBlock' ? 0 : stateHashPositions[method];
    const hash = params[position];
    if (params.length > position + 1) throw new ArchiveRpcError(-32602, 'Unexpected block parameters');
    if (hash === undefined || hash === null) return this.live(method, params);
    if (typeof hash !== 'string' || !HASH.test(hash)) throw new ArchiveRpcError(-32602, 'Expected a canonical block hash');
    const height = await this.historicalHeight(hash);
    // The recovery code substitute executes the first child from this parent.
    // Its runtime API/metadata must come from the recovery node, even though
    // the checkpoint's stored state and block hash match the old chain.
    const executingRecovery = height === ARCHIVE_CHECKPOINT.height &&
      ['state_getMetadata', 'state_getRuntimeVersion', 'state_call'].includes(method);
    return (height !== null && !executingRecovery ? this.archive : this.live)(method, params);
  }
}
