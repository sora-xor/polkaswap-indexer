import { ApiPromise, HttpProvider } from '@polkadot/api';
import { setTimeout as sleep } from 'node:timers/promises';

import { deriveAssetPrices, HOURLY_HISTORY_ASSETS } from '../worker/hourly-history.js';
import type { HourlyAssetMetadata, HourlyPoolReserves } from '../worker/hourly-history.js';
import { HOURLY_ARCHIVE_ENDPOINT, HOURLY_GENESIS_HASH } from './hourly-backfill-constants.js';
import type { HourlyBackfillBlock, HourlyBackfillSource } from './backfill-hourly-history.js';

const ANCHOR_HEIGHT = 25_059_555;
const ANCHOR_HASH = '0x959ac28650702a446bd3ad1963ed60a8aec4ec4f86b1cfe90c4564c38f831203';
const HASH = /^0x[0-9a-f]{64}$/;
type Codec = { toJSON(): unknown; toHuman(): unknown; toString(): string; toHex(): string; isNone?: boolean; unwrap?: () => Codec };
type Key = Codec & { args: Codec[] };
type Storage = {
  (): Promise<Codec>;
  entriesPaged(options: { args: unknown[]; pageSize: number; startKey?: string }): Promise<Array<[Key, Codec]>>;
};
type Queries = { assets: { assetInfosV2: Storage }; poolXYK: { reserves: Storage }; denomination?: { denominator?: Storage } };

/** Serialize, pace and bound every read-only HTTP RPC, including API metadata initialization. */
export class HourlyArchiveHttpProvider extends HttpProvider {
  private pending: Array<{ id: number; method: string; params: unknown[]; resolve(value: unknown): void; reject(error: unknown): void }> = [];
  private scheduled = false;
  private active = false;
  private calls = 0;
  private requests = 0;
  private lastRequestAt = 0;
  private startedAt = Date.now();
  private methodCounts: Record<string, number> = {};

  /** Public operational counters contain no credentials or account state. */
  progress(): Record<string, unknown> {
    return { rpcCalls: this.calls, httpRequests: this.requests, elapsedSeconds: Math.round((Date.now() - this.startedAt) / 1_000), methods: { ...this.methodCounts } };
  }

  override send<T>(method: string, params: unknown[]): Promise<T> {
    const metadataCall = method === 'state_call' && ['Metadata_metadata_versions', 'Metadata_metadata_at_version', 'Metadata_metadata'].includes(String(params[0]));
    if (++this.calls > 300_000 || (!metadataCall && !/^(chain_get[A-Za-z]+|state_get[A-Za-z]+|state_queryStorageAt|rpc_methods|system_(chain|properties|name|version))$/.test(method))) {
      return Promise.reject(new Error('Archive preparation RPC limit or read-only method restriction'));
    }
    this.methodCounts[method] = (this.methodCounts[method] ?? 0) + 1;
    return new Promise<T>((resolve, reject) => {
      this.pending.push({ id: this.calls, method, params, resolve: (value) => resolve(value as T), reject });
      this.schedule();
    });
  }

  private schedule(): void {
    if (this.scheduled || this.active) return;
    this.scheduled = true;
    setTimeout(() => { this.scheduled = false; void this.drain(); }, 0);
  }

  private async drain(): Promise<void> {
    if (this.active || !this.pending.length) return;
    this.active = true;
    const batch = this.pending.splice(0, 32);
    try {
      await sleep(Math.max(0, this.lastRequestAt + 30 - Date.now()));
      this.lastRequestAt = Date.now();
      this.requests += 1;
      const response = await fetch(HOURLY_ARCHIVE_ENDPOINT, {
        method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error',
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify(batch.map(({ id, method, params }) => ({ jsonrpc: '2.0', id, method, params }))),
      });
      if (!response.ok || !response.body) throw new Error(`Archive batch returned HTTP ${response.status}`);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 8 * 1_024 * 1_024) throw new Error('Archive response exceeded 8 MiB');
          chunks.push(chunk.value);
        }
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
      } finally {
        reader.releaseLock();
      }
      const decoded: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!Array.isArray(decoded) || decoded.length !== batch.length) throw new Error('Archive batch returned invalid RPC data');
      const byId = new Map<number, { result?: unknown; error?: unknown }>();
      for (const item of decoded) {
        if (!item || item.jsonrpc !== '2.0' || typeof item.id !== 'number' || byId.has(item.id) || !batch.some((call) => call.id === item.id)) {
          throw new Error('Archive batch returned invalid RPC identities');
        }
        byId.set(item.id, item);
      }
      for (const call of batch) {
        const item = byId.get(call.id)!;
        if (item.error || !('result' in item)) call.reject(new Error(`Archive ${call.method} returned an RPC error`));
        else call.resolve(item.result);
      }
    } catch (error) {
      for (const call of batch) call.reject(error);
    } finally {
      this.active = false;
      if (this.pending.length) this.schedule();
    }
  }
}

function assetId(codec: Codec): string {
  const value = codec.toJSON();
  const id = typeof value === 'string' ? value : value && typeof value === 'object' && 'code' in value ? String(value.code) : '';
  if (!HASH.test(id.toLowerCase())) throw new Error('Invalid archive asset storage key');
  return id.toLowerCase();
}

function unsigned(value: unknown): bigint {
  const text = String(value);
  if (!/^(?:\d{1,39}|0x[0-9a-f]{1,32})$/i.test(text)) throw new Error('Invalid archive unsigned amount');
  const number = BigInt(text);
  if (number >= (1n << 128n)) throw new Error('Archive amount exceeds u128');
  return number;
}

/** Stream bounded state-key pages at one immutable hash, without reading accounts or latest balances. */
export async function* readHourlyArchiveEntries(storage: Storage): AsyncGenerator<[Key, Codec]> {
  let startKey: string | undefined;
  let count = 0;
  while (true) {
    const page = await storage.entriesPaged({ args: [], pageSize: 256, startKey });
    count += page.length;
    if (page.length > 256 || count > 16_384) throw new Error('Archive metadata/reserve entry limit exceeded');
    for (const entry of page) yield entry;
    if (page.length < 256) return;
    const next = page.at(-1)![0].toHex();
    if (startKey && next <= startKey) throw new Error('Archive storage pagination did not advance');
    startKey = next;
  }
}

/** Connect only to the approved archive; every observation is decoded against its historical runtime. */
export async function createArchiveHourlyBackfillSource(): Promise<HourlyBackfillSource & { close(): Promise<void> }> {
  const provider = new HourlyArchiveHttpProvider(HOURLY_ARCHIVE_ENDPOINT);
  const api = await ApiPromise.create({ provider, noInitWarn: true, throwOnConnect: true });
  if (api.genesisHash.toHex() !== HOURLY_GENESIS_HASH) {
    await api.disconnect();
    throw new Error('Archive genesis does not match SORA');
  }
  const timeKey = api.query.timestamp!.now!.key();
  const block = async (height: number, knownHash?: string): Promise<HourlyBackfillBlock> => {
    if (!Number.isSafeInteger(height) || height < 1) throw new Error('Invalid archive block height');
    const hash = knownHash ?? (await api.rpc.chain.getBlockHash(height)).toHex();
    if (!HASH.test(hash) || (height === ANCHOR_HEIGHT && hash !== ANCHOR_HASH)) throw new Error('Archive block identity mismatch');
    const [header, value] = await Promise.all([api.rpc.chain.getHeader(hash), api.rpc.state.getStorage(timeKey, hash)]);
    const raw = (value as { toHex(): string }).toHex();
    if (header.number.toNumber() !== height || !/^0x[0-9a-f]{16}$/.test(raw)) throw new Error('Archive timestamp or header missing');
    const millis = Buffer.from(raw.slice(2), 'hex').readBigUInt64LE();
    if (millis > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Archive timestamp exceeds safe integer');
    return { height, hash, parentHash: header.parentHash.toHex(), timestamp: Math.floor(Number(millis) / 1_000) };
  };
  return {
    lowerBoundHeight: ANCHOR_HEIGHT,
    progress: () => provider.progress(),
    genesisHash: async () => api.genesisHash.toHex(),
    finalized: async () => {
      const hash = (await api.rpc.chain.getFinalizedHead()).toHex();
      return block((await api.rpc.chain.getHeader(hash)).number.toNumber(), hash);
    },
    block,
    observation: async (before) => {
      const at = await api.at(before.hash);
      const query = at.query as unknown as Queries;
      if (!query.assets?.assetInfosV2 || !query.poolXYK?.reserves || !query.denomination?.denominator) {
        throw new Error(`Historical metadata, reserves or denomination unavailable at ${before.height}`);
      }
      const denominator = unsigned((await query.denomination.denominator()).toString()).toString();
      if (denominator === '0') throw new Error('Historical denomination is not positive');
      const assets = new Map<string, HourlyAssetMetadata>();
      for await (const [key, raw] of readHourlyArchiveEntries(query.assets.assetInfosV2)) {
        if (raw.isNone) continue;
        const value = (raw.unwrap ? raw.unwrap() : raw).toHuman();
        if (!value || typeof value !== 'object' || !('precision' in value) || !('symbol' in value)) throw new Error('Historical asset metadata is malformed');
        const decimals = Number(value.precision);
        if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('Historical asset precision is unsupported');
        const id = assetId(key.args[0]!);
        assets.set(id, { id, symbol: String(value.symbol), decimals });
      }
      const pools: HourlyPoolReserves[] = [];
      for await (const [key, raw] of readHourlyArchiveEntries(query.poolXYK.reserves)) {
        const value = raw.toJSON();
        if (!Array.isArray(value) || value.length !== 2) throw new Error('Historical pool reserves are malformed');
        pools.push({ baseAssetId: assetId(key.args[0]!), targetAssetId: assetId(key.args[1]!),
          baseAssetReserves: unsigned(value[0]), targetAssetReserves: unsigned(value[1]) });
      }
      const routes = new Map<string, HourlyPoolReserves[]>();
      const prices = deriveAssetPrices(assets, pools, routes);
      const ids = new Set(HOURLY_HISTORY_ASSETS.map((asset) => asset.id));
      const retained = new Map<string, HourlyPoolReserves>();
      for (const asset of HOURLY_HISTORY_ASSETS) {
        const evidence = prices.has(asset.id) ? routes.get(asset.id) ?? []
          : pools.filter((pool) => pool.baseAssetId === asset.id || pool.targetAssetId === asset.id);
        for (const pool of evidence) retained.set(`${pool.baseAssetId}:${pool.targetAssetId}`, pool);
      }
      const retainedAssets = new Set([...ids, ...[...retained.values()].flatMap((pool) => [pool.baseAssetId, pool.targetAssetId])]);
      return {
        denominator,
        assets: [...assets.values()].filter((asset) => retainedAssets.has(asset.id)),
        prices: [...prices].filter(([id, value]) => ids.has(id) && value > 0n).map(([id, value]) => ({ id, value: value.toString() })),
        pools: [...retained.values()].map((pool) => ({
          ...pool, baseAssetReserves: pool.baseAssetReserves.toString(), targetAssetReserves: pool.targetAssetReserves.toString(),
        })),
        priceRoutes: [...prices].filter(([id, value]) => ids.has(id) && value > 0n).map(([id]) => ({
          id, poolIds: (routes.get(id) ?? []).map((pool) => `${pool.baseAssetId}:${pool.targetAssetId}`),
        })),
      };
    },
    close: () => api.disconnect(),
  };
}
