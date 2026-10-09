import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import {
  buildAssetHourlyCloseDocumentsAtBoundary,
  HOURLY_HISTORY_ASSETS,
  MAX_HOURLY_HISTORY_TARGETS,
  validateHourlyHistoryTargets,
} from '../worker/hourly-history.js';
import type { HourlyHistoryTarget } from '../worker/hourly-history.js';
import type { IndexerDocument, IndexerRepository } from '../repository/types.js';
import { HOURLY_ARCHIVE_ENDPOINT, HOURLY_GENESIS_HASH } from './hourly-backfill-constants.js';

export { HOURLY_ARCHIVE_ENDPOINT, HOURLY_GENESIS_HASH } from './hourly-backfill-constants.js';
const HOUR = 3_600;
const MAX_HOURS = 90 * 24;
const MAX_ARTIFACT_BYTES = 32 * 1_024 * 1_024;
const MAX_LINE_BYTES = 128 * 1_024;
const HASH = /^0x[0-9a-f]{64}$/;

export type HourlyBackfillBlock = { height: number; hash: string; parentHash: string; timestamp: number };
export type HourlyBackfillAsset = { id: string; symbol: string; decimals: number };
export type HourlyBackfillObservation = {
  denominator: string;
  assets: HourlyBackfillAsset[];
  prices: Array<{ id: string; value: string }>;
  pools: Array<{ baseAssetId: string; targetAssetId: string; baseAssetReserves: string; targetAssetReserves: string }>;
  priceRoutes?: Array<{ id: string; poolIds: string[] }>;
  /** Every same-state direct XOR pool for the manifest's targets is retained. */
  xorPoolsComplete?: true;
};
export type HourlyBackfillRow = HourlyBackfillObservation & {
  kind: 'hour';
  boundary: number;
  before: HourlyBackfillBlock;
  after: HourlyBackfillBlock;
};
type HourlyBackfillManifestFields = {
  kind: 'polkaswap-hourly-backfill';
  archiveEndpoint: string;
  genesisHash: string;
  startAt: number;
  endAt: number;
  finalized: HourlyBackfillBlock;
};
export type HourlyBackfillManifest = HourlyBackfillManifestFields & (
  { version: 1 } | { version: 2; targets: HourlyHistoryTarget[] }
);

/** Read-only historical source. All timestamps use chain seconds; token values stay integer strings. */
export interface HourlyBackfillSource {
  /** Scope whose direct XOR pools are complete in observations; absent for original caller-defined sources. */
  readonly targets?: readonly HourlyHistoryTarget[];
  lowerBoundHeight?: number;
  progress?(): Record<string, unknown>;
  genesisHash(): Promise<string>;
  finalized(): Promise<HourlyBackfillBlock>;
  block(height: number): Promise<HourlyBackfillBlock>;
  observation(block: HourlyBackfillBlock): Promise<HourlyBackfillObservation>;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Reject unknown fields so an artifact cannot smuggle arbitrary document writes into a repair. */
function fields(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!record(value) || Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) {
    throw new Error('Malformed hourly repair record');
  }
}

function assertBlock(value: unknown): asserts value is HourlyBackfillBlock {
  fields(value, ['height', 'hash', 'parentHash', 'timestamp']);
  if (!integer(value.height) || !integer(value.timestamp) || !HASH.test(String(value.hash)) || !HASH.test(String(value.parentHash))) {
    throw new Error('Invalid hourly repair block proof');
  }
}

function assertManifest(value: unknown): asserts value is HourlyBackfillManifest {
  fields(value, ['kind', 'version', 'archiveEndpoint', 'genesisHash', 'startAt', 'endAt', 'finalized',
    ...(record(value) && value.version === 2 ? ['targets'] : [])]);
  assertBlock(value.finalized);
  if (value.kind !== 'polkaswap-hourly-backfill' || (value.version !== 1 && value.version !== 2) ||
      value.archiveEndpoint !== HOURLY_ARCHIVE_ENDPOINT || value.genesisHash !== HOURLY_GENESIS_HASH ||
      !integer(value.startAt) || !integer(value.endAt) || value.startAt % HOUR || value.endAt % HOUR ||
      value.endAt <= value.startAt || value.endAt - value.startAt > MAX_HOURS * HOUR ||
      value.endAt > value.finalized.timestamp) {
    throw new Error('Invalid hourly repair manifest or finalized range');
  }
  if (value.version === 2) validateHourlyHistoryTargets(value.targets);
}

function manifestTargets(manifest: HourlyBackfillManifest): readonly HourlyHistoryTarget[] {
  return manifest.version === 1 ? HOURLY_HISTORY_ASSETS : manifest.targets;
}

/** Reconstruct only the canonical snapshot documents from bounded, explicit historical observations. */
function documentsForRow(row: HourlyBackfillRow, manifest: HourlyBackfillManifest, previous?: Map<string, IndexerDocument>): IndexerDocument[] {
  const pools = row.pools.map((pool) => ({ ...pool, baseAssetReserves: BigInt(pool.baseAssetReserves), targetAssetReserves: BigInt(pool.targetAssetReserves) }));
  return buildAssetHourlyCloseDocumentsAtBoundary({
    before: row.before,
    after: row.after,
    genesisHash: HOURLY_GENESIS_HASH,
    denominator: row.denominator,
    targets: manifestTargets(manifest),
    assets: new Map(row.assets.map((asset) => [asset.id, asset])),
    prices: new Map(row.prices.map((price) => [price.id, BigInt(price.value)])),
    pools,
    xorPoolsComplete: row.xorPoolsComplete,
    priceRoutes: row.priceRoutes ? new Map(row.priceRoutes.map((route) => [route.id,
      route.poolIds.map((id) => pools.find((pool) => `${pool.baseAssetId}:${pool.targetAssetId}` === id)!),
    ])) : undefined,
    previous,
  });
}

function assertRow(value: unknown, boundary: number, manifest: HourlyBackfillManifest): asserts value is HourlyBackfillRow {
  const targets = manifestTargets(manifest);
  const targetIds = new Set(targets.map((target) => target.id));
  fields(value, ['kind', 'boundary', 'before', 'after', 'denominator', 'assets', 'prices', 'pools',
    ...(record(value) && 'priceRoutes' in value ? ['priceRoutes'] : []),
    ...(record(value) && 'xorPoolsComplete' in value ? ['xorPoolsComplete'] : [])]);
  if ('xorPoolsComplete' in value && value.xorPoolsComplete !== true) throw new Error('Invalid direct XOR pool completeness evidence');
  assertBlock(value.before);
  assertBlock(value.after);
  if (value.kind !== 'hour' || value.boundary !== boundary || value.before.height + 1 !== value.after.height ||
      value.after.parentHash !== value.before.hash || value.before.timestamp < boundary - HOUR ||
      value.before.timestamp >= boundary || value.after.timestamp < boundary || value.after.timestamp >= boundary + HOUR ||
      value.after.height > manifest.finalized.height || value.after.timestamp > manifest.finalized.timestamp ||
      typeof value.denominator !== 'string' || !/^[1-9]\d{0,38}$/.test(value.denominator) ||
      BigInt(value.denominator) >= (1n << 128n) || !Array.isArray(value.assets) || !Array.isArray(value.prices) ||
      value.assets.length > (manifest.version === 1 ? 128 : MAX_HOURLY_HISTORY_TARGETS) || value.prices.length > targets.length ||
      !Array.isArray(value.pools) || value.pools.length > 512) {
    throw new Error(`Invalid hourly repair evidence at ${boundary}`);
  }
  const ids = new Set<string>();
  for (const asset of value.assets) {
    fields(asset, ['id', 'symbol', 'decimals']);
    const expected = HOURLY_HISTORY_ASSETS.find((item) => item.id === asset.id);
    if (typeof asset.id !== 'string' || !HASH.test(asset.id) || typeof asset.symbol !== 'string' || asset.symbol.length > 128 ||
        (expected && expected.symbol !== asset.symbol) || !integer(asset.decimals) || asset.decimals > 36 || ids.has(asset.id)) {
      throw new Error(`Invalid historical asset metadata at ${boundary}`);
    }
    ids.add(asset.id);
  }
  const pricedIds = new Set<string>();
  for (const price of value.prices) {
    fields(price, ['id', 'value']);
    if (typeof price.id !== 'string' || !ids.has(price.id) || !targetIds.has(price.id) || pricedIds.has(price.id) ||
        typeof price.value !== 'string' || !/^[1-9]\d{0,119}$/.test(price.value)) {
      throw new Error(`Invalid historical price at ${boundary}`);
    }
    pricedIds.add(price.id);
  }
  const poolIds = new Set<string>();
  for (const pool of value.pools) {
    fields(pool, ['baseAssetId', 'targetAssetId', 'baseAssetReserves', 'targetAssetReserves']);
    const key = `${String(pool.baseAssetId)}:${String(pool.targetAssetId)}`;
    if (typeof pool.baseAssetId !== 'string' || !HASH.test(pool.baseAssetId) ||
        typeof pool.targetAssetId !== 'string' || !HASH.test(pool.targetAssetId) || poolIds.has(key) ||
        typeof pool.baseAssetReserves !== 'string' || !/^\d{1,39}$/.test(pool.baseAssetReserves) ||
        typeof pool.targetAssetReserves !== 'string' || !/^\d{1,39}$/.test(pool.targetAssetReserves) ||
        BigInt(pool.baseAssetReserves) >= (1n << 128n) || BigInt(pool.targetAssetReserves) >= (1n << 128n)) {
      throw new Error(`Invalid historical reserve evidence at ${boundary}`);
    }
    poolIds.add(key);
  }
  if (value.priceRoutes !== undefined) {
    if (!Array.isArray(value.priceRoutes) || value.priceRoutes.length > targets.length) throw new Error('Invalid hourly price routes');
    const routed = new Set<string>();
    for (const route of value.priceRoutes) {
      fields(route, ['id', 'poolIds']);
      if (typeof route.id !== 'string' || !pricedIds.has(route.id) || routed.has(route.id) || !Array.isArray(route.poolIds) ||
          route.poolIds.length > 128 || new Set(route.poolIds).size !== route.poolIds.length ||
          route.poolIds.some((id) => typeof id !== 'string' || !poolIds.has(id))) throw new Error('Invalid hourly price route references');
      routed.add(route.id);
    }
    if (routed.size !== pricedIds.size) throw new Error('Missing hourly price route evidence');
  }
  documentsForRow(value as HourlyBackfillRow, manifest);
}

/** Prepare a bounded finalized window. A binary search finds the adjacent blocks proving every hour close. */
export async function* prepareHourlyBackfill(
  source: HourlyBackfillSource,
  options: { hours?: number; endAt?: number; targets?: readonly HourlyHistoryTarget[] } = {}
): AsyncGenerator<HourlyBackfillManifest | HourlyBackfillRow> {
  const hours = options.hours ?? 168;
  if (!integer(hours) || hours < 1 || hours > MAX_HOURS) throw new Error('hours must be between 1 and 2160');
  const targets = options.targets === undefined ? undefined : validateHourlyHistoryTargets(options.targets);
  if (source.targets !== undefined && !isDeepStrictEqual(validateHourlyHistoryTargets(source.targets), targets ?? HOURLY_HISTORY_ASSETS)) {
    throw new Error('Archive observation targets do not match the requested artifact scope');
  }
  if (await source.genesisHash() !== HOURLY_GENESIS_HASH) throw new Error('Archive genesis does not match SORA');
  const finalized = await source.finalized();
  assertBlock(finalized);
  const endAt = options.endAt ?? Math.floor(finalized.timestamp / HOUR) * HOUR;
  const manifest: HourlyBackfillManifest = {
    kind: 'polkaswap-hourly-backfill', ...(targets === undefined ? { version: 1 as const } : { version: 2 as const, targets }), archiveEndpoint: HOURLY_ARCHIVE_ENDPOINT,
    genesisHash: HOURLY_GENESIS_HASH, startAt: endAt - hours * HOUR, endAt, finalized,
  };
  assertManifest(manifest);
  yield manifest;
  // The cache holds only search probes for this bounded window, never full storage snapshots.
  const cache = new Map<number, Promise<HourlyBackfillBlock>>([[finalized.height, Promise.resolve(finalized)]]);
  const read = async (height: number): Promise<HourlyBackfillBlock> => {
    let pending = cache.get(height);
    if (!pending) {
      pending = source.block(height).then((block) => {
        assertBlock(block);
        if (block.height !== height || height > finalized.height || block.timestamp > finalized.timestamp) {
          throw new Error('Archive returned an inconsistent finalized block');
        }
        return block;
      });
      cache.set(height, pending);
    }
    return pending;
  };
  let lower = await read(source.lowerBoundHeight ?? 1);
  for (let start = manifest.startAt + HOUR; start <= endAt; start += 12 * HOUR) {
    const boundaries = Array.from({ length: Math.min(12, (endAt - start) / HOUR + 1) }, (_, index) => start + index * HOUR);
    const brackets = await Promise.all(boundaries.map(async (boundary) => {
      if (lower.timestamp >= boundary) throw new Error('Archive does not cover the requested start');
      let before = lower;
      let after = finalized;
      for (let round = 0; after.height - before.height > 1; round += 1) {
        if (round >= 128) throw new Error('Archive hour search did not converge');
        const width = after.height - before.height;
        const offset = round % 5 === 4 ? Math.floor(width / 2)
          : Math.floor(width * (boundary - before.timestamp) / (after.timestamp - before.timestamp));
        const probe = await read(before.height + Math.max(1, Math.min(width - 1, offset)));
        if (probe.timestamp < before.timestamp || probe.timestamp > after.timestamp) throw new Error('Non-monotonic archive timestamps');
        if (probe.timestamp < boundary) before = probe;
        else after = probe;
      }
      return { boundary, before, after };
    }));
    const observe = async ({ boundary, before, after }: typeof brackets[number]): Promise<HourlyBackfillRow> => {
      const row: HourlyBackfillRow = { kind: 'hour', boundary, before, after, ...await source.observation(before) };
      assertRow(row, boundary, manifest);
      return row;
    };
    // Warm that historical runtime's decoder once before overlapping the remaining immutable reads.
    yield await observe(brackets[0]!);
    const rows = await Promise.all(brackets.slice(1).map(observe));
    for (const row of rows) yield row;
    lower = brackets.at(-1)!.before;
  }
}

/** Publish a complete preparation artifact atomically; partial files are never accepted as completed output. */
export async function writeHourlyBackfillArtifact(
  source: HourlyBackfillSource,
  path: string,
  options: { hours?: number; endAt?: number; targets?: readonly HourlyHistoryTarget[]; onProgress?: (hours: number) => void } = {}
): Promise<{ path: string; sha256: string; hours: number; documents: number; missing: Record<string, number> }> {
  const output = resolve(path);
  const explicitTargets = options.targets === undefined ? undefined : validateHourlyHistoryTargets(options.targets);
  const targets = explicitTargets ?? HOURLY_HISTORY_ASSETS;
  const preparation = { hours: options.hours, endAt: options.endAt, targets: explicitTargets };
  const partial = `${output}.partial`;
  await mkdir(dirname(output), { recursive: true });
  const handle = await open(partial, 'wx', 0o600);
  const digest = createHash('sha256');
  let bytes = 0;
  let hours = 0;
  let documents = 0;
  // V1 retains symbol keys byte-for-byte; explicit scopes use IDs so repeated symbols cannot collide.
  const missing = Object.fromEntries(targets.map((asset) => [options.targets === undefined ? asset.symbol : asset.id, 0]));
  let manifest: HourlyBackfillManifest | undefined;
  try {
    for await (const row of prepareHourlyBackfill(source, preparation)) {
      const line = `${JSON.stringify(row)}\n`;
      bytes += Buffer.byteLength(line);
      if (Buffer.byteLength(line) > MAX_LINE_BYTES || bytes > MAX_ARTIFACT_BYTES) throw new Error('Hourly repair artifact exceeds byte limit');
      await handle.writeFile(line);
      digest.update(line);
      if (row.kind === 'hour') {
        const generated = documentsForRow(row, manifest!);
        documents += generated.length;
        for (const asset of targets) {
          if (!row.prices.some((price) => price.id === asset.id)) missing[options.targets === undefined ? asset.symbol : asset.id]! += 1;
        }
        hours += 1;
        options.onProgress?.(hours);
      } else manifest = row;
    }
    await handle.sync();
    await handle.close();
    // link() fails rather than replacing a previous verified artifact at the destination.
    await link(partial, output);
    await unlink(partial);
    return { path: output, sha256: digest.digest('hex'), hours, documents, missing };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/** Read a byte-bounded artifact once, then validate its entire contents before any database mutation. */
export async function readHourlyBackfillArtifact(path: string, sha256: string): Promise<{
  manifest: HourlyBackfillManifest; rows: HourlyBackfillRow[];
}> {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('Expected hourly repair SHA-256 is required');
  const chunks: Buffer[] = [];
  const digest = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1_024 })) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_ARTIFACT_BYTES) throw new Error('Hourly repair artifact exceeds byte limit');
    digest.update(buffer);
    chunks.push(buffer);
  }
  if (digest.digest('hex') !== sha256) throw new Error('Hourly repair artifact SHA-256 mismatch');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  if (!text.endsWith('\n')) throw new Error('Hourly repair artifact is incomplete');
  const lines = text.slice(0, -1).split('\n');
  if (lines.length < 2 || lines.length > MAX_HOURS + 1 || lines.some((line) => Buffer.byteLength(line) > MAX_LINE_BYTES)) {
    throw new Error('Invalid hourly repair line count or size');
  }
  const manifest: unknown = JSON.parse(lines[0]!);
  assertManifest(manifest);
  if (lines.length !== (manifest.endAt - manifest.startAt) / HOUR + 1) throw new Error('Hourly repair window is incomplete');
  const rows: HourlyBackfillRow[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const row: unknown = JSON.parse(lines[index]!);
    assertRow(row, manifest.startAt + index * HOUR, manifest);
    rows.push(row);
  }
  return { manifest, rows };
}

/**
 * Run only through the existing database owner before live snapshot writes begin.
 * Never opens another RocksDB handle, mutates current assets, or rewinds chainState.
 * A crash may leave completed hours; replay verifies/skips those and safely finishes.
 */
export async function applyHourlyBackfillFile(
  repository: Pick<IndexerRepository, 'get' | 'getMany' | 'upsert' | 'upsertMany'>,
  options: { path: string; sha256: string; genesisHash: string; finalizedHeight: number }
): Promise<{ status: 'applied' | 'already-applied'; hours: number; documents: number; changed: number }> {
  const { manifest, rows } = await readHourlyBackfillArtifact(options.path, options.sha256);
  if (options.genesisHash !== manifest.genesisHash || !integer(options.finalizedHeight) || options.finalizedHeight < manifest.finalized.height) {
    throw new Error('Hourly repair does not match the active finalized chain');
  }
  const receiptId = `hourlyHistoryRepair-v${manifest.version}-${options.sha256}`;
  const catalogueId = 'hourlyHistoryTargets-v1';
  const catalogue = manifest.version === 2 ? await repository.get('updatesStreams', catalogueId) : null;
  let mergedTargets: HourlyHistoryTarget[] | undefined;
  if (manifest.version === 2) {
    if (catalogue && (catalogue.data.id !== catalogueId || !integer(catalogue.blockHeight) || catalogue.blockHeight > options.finalizedHeight)) {
      throw new Error('Invalid hourly history target catalogue');
    }
    const existing = catalogue ? validateHourlyHistoryTargets(catalogue.data.targets) : [];
    const merged = new Map(HOURLY_HISTORY_ASSETS.map((target) => [target.id, { ...target }]));
    for (const target of [...existing, ...manifest.targets]) {
      // Requested symbols belong to an artifact's scope; later renames do not replace prior catalogue provenance.
      if (!merged.has(target.id)) merged.set(target.id, { ...target });
    }
    mergedTargets = validateHourlyHistoryTargets([...merged.values()].sort((left, right) => left.id.localeCompare(right.id)));
  }
  const receipt = await repository.get('updatesStreams', receiptId);
  if (receipt?.data.sha256 === options.sha256 && receipt.data.complete === true) {
    if (manifest.version === 2 && (receipt.data.artifactVersion !== 2 ||
        !isDeepStrictEqual(receipt.data.targets, manifest.targets) || receipt.data.documents !== rows.length * manifest.targets.length ||
        !catalogue || !isDeepStrictEqual(validateHourlyHistoryTargets(catalogue.data.targets), mergedTargets))) {
      throw new Error('Completed hourly repair target scope or catalogue mismatch');
    }
    return { status: 'already-applied', hours: rows.length, documents: Number(receipt.data.documents), changed: 0 };
  }
  let documents = 0;
  let changed = 0;
  for (const row of rows) {
    const ids = documentsForRow(row, manifest).map((document) => document.id);
    const previous = await repository.getMany('assetSnapshots', ids);
    const merged = documentsForRow(row, manifest, previous);
    const updates = merged.filter((document) => !isDeepStrictEqual(previous.get(document.id), document));
    if (updates.length) await repository.upsertMany(updates);
    const persisted = await repository.getMany('assetSnapshots', ids);
    if (merged.some((document) => !isDeepStrictEqual(persisted.get(document.id), document))) {
      throw new Error(`Hourly repair write verification failed at ${row.boundary}`);
    }
    documents += merged.length;
    changed += updates.length;
  }
  if (mergedTargets) {
    const targetDocument: IndexerDocument = {
      collection: 'updatesStreams', id: catalogueId, blockHeight: options.finalizedHeight, timestamp: manifest.endAt,
      data: { id: catalogueId, targets: mergedTargets },
    };
    await repository.upsert(targetDocument);
    if (!isDeepStrictEqual(await repository.get('updatesStreams', catalogueId), targetDocument)) {
      throw new Error('Hourly history target catalogue write verification failed');
    }
  }
  await repository.upsert({
    collection: 'updatesStreams', id: receiptId,
    blockHeight: manifest.finalized.height, timestamp: manifest.endAt,
    data: { id: receiptId, complete: true, sha256: options.sha256, startAt: manifest.startAt,
      endAt: manifest.endAt, hours: rows.length, documents, archiveEndpoint: manifest.archiveEndpoint,
      genesisHash: manifest.genesisHash, finalized: manifest.finalized,
      ...(manifest.version === 2 ? { artifactVersion: 2, targets: manifest.targets } : {}) },
  });
  return { status: 'applied', hours: rows.length, documents, changed };
}

/** CLI prepares public data only; activation is a separate worker-startup configuration. */
async function main(): Promise<void> {
  const args = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const match = /^--(hours|end|output|targets)=(.+)$/.exec(arg);
    if (!match || args.has(match[1]!)) throw new Error('Usage: backfill-hourly-history --output=path [--hours=168] [--end=ISO8601] [--targets=JSON-file]');
    args.set(match[1]!, match[2]!);
  }
  if (!args.has('output')) throw new Error('--output is required');
  const hours = args.has('hours') && /^\d+$/.test(args.get('hours')!) ? Number(args.get('hours')) : args.has('hours') ? NaN : 168;
  const endAt = args.has('end') ? Date.parse(args.get('end')!) / 1_000 : undefined;
  if (!integer(hours) || hours < 1 || hours > MAX_HOURS || (endAt !== undefined && (!integer(endAt) || endAt % HOUR))) {
    throw new Error('Invalid --hours or --end: use 1–2160 hours and an exact UTC hour');
  }
  let targets: HourlyHistoryTarget[] | undefined;
  if (args.has('targets')) {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of createReadStream(args.get('targets')!, { highWaterMark: 16 * 1_024 })) {
      const buffer = Buffer.from(chunk);
      if ((bytes += buffer.byteLength) > MAX_LINE_BYTES) throw new Error('Hourly history target file exceeds byte limit');
      chunks.push(buffer);
    }
    targets = validateHourlyHistoryTargets(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
  }
  const { createArchiveHourlyBackfillSource } = await import('./hourly-backfill-archive.js');
  const source = await createArchiveHourlyBackfillSource({ targets });
  try {
    const result = await writeHourlyBackfillArtifact(source, args.get('output')!, {
      hours, endAt, targets, onProgress: (completed) => {
        if (completed <= 3 || completed % 12 === 0) console.info(JSON.stringify({ preparedHours: completed, ...source.progress?.() }));
      },
    });
    console.info(JSON.stringify(result, null, 2));
  } finally {
    await source.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
