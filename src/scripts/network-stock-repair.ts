/**
 * Offline, bounded repair of missing network aggregate stocks from a retained
 * archive observation artifact. The collector must independently validate the
 * archive and pin each observation to its exact aggregate block. Run only with
 * the combined worker stopped and an exclusive repository handle. Planning and
 * applying perform no network calls and never rewind checkpoints. Production
 * RocksRepository.upsertMany commits the entire validated call atomically.
 */
import { isDeepStrictEqual } from 'node:util';
import type { IndexerDocument, IndexerRepository } from '../repository/types.js';

export const NETWORK_STOCK_REPAIR_GENESIS = '0x7e4e32d0feafd4f9c9414b0be86373f9a1efa904809b683453a9af6856d38ad5';
export const NETWORK_STOCK_REPAIR_ARCHIVE = 'https://mof2.sora.org/';
export const NETWORK_STOCK_REPAIR_MAX_ROWS = 600;
export const NETWORK_STOCK_REPAIR_MAX_BYTES = 2 * 1024 * 1024;
const MAX_PLAN_BYTES = 16 * 1024 * 1024;
const WINDOWS = { DEFAULT: 300, HOUR: 3600, DAY: 86400 } as const;
const STOCK_FIELDS = ['liquidityUSD', 'poolLiquidityUSD', 'orderBookLiquidityUSD',
  'activePools', 'activeOrderBooks', 'listedAssets'] as const;
type SnapshotType = keyof typeof WINDOWS;
type StockField = typeof STOCK_FIELDS[number];
type RepairRepository = Pick<IndexerRepository, 'get' | 'upsertMany'>;

export interface NetworkStockObservation {
  id: string;
  type: SnapshotType;
  blockHeight: number;
  timestamp: number;
  blockHash: string;
  stock: {
    liquidityUSD: string;
    poolLiquidityUSD: string;
    orderBookLiquidityUSD: string;
    activePools: number;
    activeOrderBooks: number;
    listedAssets: number;
  };
  proof: Record<string, unknown> & {
    kind: 'archive-network-stock'; genesisHash: string; archiveEndpoint: string;
    blockHash: string; blockHeight: number; timestamp: number;
  };
}

export interface NetworkStockRepairArtifact {
  kind: 'network-stock-repair-v1';
  genesisHash: string;
  archiveEndpoint: string;
  generatedAt: string;
  /** DEFAULT observations are accepted only when explicitly inventoried. */
  inventoryTypes?: SnapshotType[];
  observations: NetworkStockObservation[];
}

export interface NetworkStockRepairPlan {
  readonly kind: 'network-stock-repair-plan-v1';
  readonly observations: number;
  readonly changedRows: number;
  readonly unchangedRows: number;
  readonly changes: readonly { readonly id: string; readonly fields: readonly StockField[] }[];
}

type PlanState = { originals: IndexerDocument[]; sources: IndexerDocument[]; replacements: IndexerDocument[] };
// Keep the write payload private so a mutated/forged dry-run summary cannot
// authorize writes outside the validated artifact and retained originals.
const issuedPlans = new WeakMap<NetworkStockRepairPlan, PlanState>();

/** Reject accessors, non-JSON objects, cycles and oversized evidence before copying it. */
function jsonRecord(value: unknown): asserts value is Record<string, unknown> {
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 100_000 || depth > 24) throw new Error('Repair artifact exceeds JSON complexity bounds');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (!item || typeof item !== 'object' || seen.has(item)) throw new Error('Repair artifact must contain plain JSON');
    const prototype = Object.getPrototypeOf(item);
    if (Array.isArray(item) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      throw new Error('Repair artifact must contain plain JSON objects');
    seen.add(item);
    for (const key of Reflect.ownKeys(item)) {
      if (Array.isArray(item) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor) ||
          ['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Repair artifact contains an unsafe JSON key');
      visit(descriptor.value, depth + 1);
    }
    seen.delete(item);
  };
  visit(value, 0);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Repair artifact must be an object');
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > NETWORK_STOCK_REPAIR_MAX_BYTES)
    throw new Error('Repair artifact exceeds byte bound');
}

/** Convert bounded unsigned decimal USD text to an exact eight-place integer. */
function usd(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,37})(\.\d{1,8})?$/.test(value))
    throw new Error('Repair stock USD must be nonnegative decimal text with at most eight places');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * 100_000_000n + BigInt(fraction.padEnd(8, '0'));
}

/** Native chain positions and stock counters must stay inside the public signed Int domain. */
function integer(value: unknown, positive = false): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= (positive ? 1 : 0) && value <= 2_147_483_647;
}

/** Validate and detach an artifact; this function has no I/O or mutable worker state. */
export function validateNetworkStockRepairArtifact(
  input: unknown,
  nowSeconds = Math.floor(Date.now() / 1000),
): NetworkStockRepairArtifact {
  if (!integer(nowSeconds, true)) throw new Error('Invalid repair validation time');
  jsonRecord(input);
  if (input.kind !== 'network-stock-repair-v1' || input.genesisHash !== NETWORK_STOCK_REPAIR_GENESIS ||
      input.archiveEndpoint !== NETWORK_STOCK_REPAIR_ARCHIVE) throw new Error('Repair artifact chain or archive identity mismatch');
  const generated = typeof input.generatedAt === 'string' ? Date.parse(input.generatedAt) : NaN;
  if (!Number.isFinite(generated) || new Date(generated).toISOString() !== input.generatedAt ||
      generated <= 0 || generated >= (nowSeconds + 1) * 1000) throw new Error('Invalid repair artifact generation time');
  const generatedSeconds = Math.floor(generated / 1000);
  const inventory = input.inventoryTypes;
  if (inventory !== undefined && (!Array.isArray(inventory) || inventory.length === 0 || inventory.length > 3 ||
      inventory.some((type) => typeof type !== 'string' || !Object.hasOwn(WINDOWS, type)) ||
      new Set(inventory).size !== inventory.length)) throw new Error('Invalid repair snapshot inventory types');
  if (!Array.isArray(input.observations) || input.observations.length === 0 ||
      input.observations.length > NETWORK_STOCK_REPAIR_MAX_ROWS) throw new Error('Repair artifact must contain 1–600 observations');
  const ids = new Set<string>();
  for (const raw of input.observations) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid stock observation');
    const observation = raw as Record<string, unknown>;
    const type = observation.type;
    if (typeof type !== 'string' || !Object.hasOwn(WINDOWS, type) ||
        (type === 'DEFAULT' && (!Array.isArray(inventory) || !inventory.includes(type))) ||
        (Array.isArray(inventory) && !inventory.includes(type))) throw new Error('Observation type was not inventoried');
    if (!integer(observation.timestamp, true) || !integer(observation.blockHeight, true)) throw new Error('Invalid observation chain position');
    const window = WINDOWS[type as SnapshotType];
    const bucket = Math.floor(observation.timestamp / window) * window;
    if (bucket + window > generatedSeconds || observation.id !== `network-all-${type}-${bucket}` ||
        ids.has(observation.id as string)) throw new Error('Duplicate, incomplete, or noncanonical aggregate observation');
    ids.add(observation.id as string);
    if (typeof observation.blockHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(observation.blockHash) ||
        /^0x0{64}$/.test(observation.blockHash)) throw new Error('Invalid canonical observation block hash');
    const stock = observation.stock as Record<string, unknown> | undefined;
    if (!stock || typeof stock !== 'object' || Array.isArray(stock) ||
        Object.keys(stock).length !== STOCK_FIELDS.length || STOCK_FIELDS.some((field) => !Object.hasOwn(stock, field)))
      throw new Error('Observation must contain exactly six stock fields');
    if (usd(stock.liquidityUSD) !== usd(stock.poolLiquidityUSD) + usd(stock.orderBookLiquidityUSD))
      throw new Error('Repair stock total does not equal pool plus order-book liquidity');
    if (!integer(stock.activePools) || !integer(stock.activeOrderBooks) || !integer(stock.listedAssets))
      throw new Error('Invalid repair stock counts');
    const proof = observation.proof as Record<string, unknown> | undefined;
    if (!proof || typeof proof !== 'object' || Array.isArray(proof) || proof.kind !== 'archive-network-stock' || proof.genesisHash !== NETWORK_STOCK_REPAIR_GENESIS ||
        proof.archiveEndpoint !== NETWORK_STOCK_REPAIR_ARCHIVE || proof.blockHash !== observation.blockHash ||
        proof.blockHeight !== observation.blockHeight || proof.timestamp !== observation.timestamp)
      throw new Error('Archive proof is not bound to the observation');
  }
  return structuredClone(input) as unknown as NetworkStockRepairArtifact;
}

/** Parse bounded UTF-8 JSON without reading a file or allocating an unbounded artifact. */
export function parseNetworkStockRepairArtifact(text: string, nowSeconds?: number): NetworkStockRepairArtifact {
  if (typeof text !== 'string' || text.length > NETWORK_STOCK_REPAIR_MAX_BYTES ||
      Buffer.byteLength(text, 'utf8') > NETWORK_STOCK_REPAIR_MAX_BYTES) throw new Error('Repair artifact exceeds byte bound');
  return validateNetworkStockRepairArtifact(JSON.parse(text) as unknown, nowSeconds);
}

/** Require the existing target/source envelope to retain exactly the observed canonical position. */
function assertPosition(document: IndexerDocument | null, observation: NetworkStockObservation, source: boolean): asserts document is IndexerDocument {
  const id = source ? `block-${observation.blockHeight}` : observation.id;
  if (!document || document.collection !== 'networkSnapshots' || document.id !== id || document.data.id !== id ||
      document.data.type !== (source ? 'BLOCK' : observation.type) || document.blockHeight !== observation.blockHeight ||
      document.timestamp !== observation.timestamp || document.data.timestamp !== observation.timestamp ||
      (document.data.blockHeight !== undefined && document.data.blockHeight !== observation.blockHeight) ||
      (document.data.blockHash !== undefined && document.data.blockHash !== observation.blockHash))
    throw new Error(`Repair ${source ? 'canonical BLOCK source' : 'target'} position mismatch: ${id}`);
}

/**
 * Read and validate every target before constructing any write. Only missing or
 * null stocks can change; a conflicting present value aborts the whole plan.
 */
export async function planNetworkStockRepair(repository: RepairRepository, artifact: unknown): Promise<NetworkStockRepairPlan> {
  const validated = validateNetworkStockRepairArtifact(artifact);
  const originals: IndexerDocument[] = [], sources: IndexerDocument[] = [], replacements: IndexerDocument[] = [];
  const changes: { id: string; fields: StockField[] }[] = [];
  const sourceCache = new Map<string, IndexerDocument>();
  let retainedBytes = 0;
  for (const observation of validated.observations) {
    const original = await repository.get('networkSnapshots', observation.id);
    assertPosition(original, observation, false);
    const sourceId = `block-${observation.blockHeight}`;
    const source = sourceCache.get(sourceId) ?? await repository.get('networkSnapshots', sourceId);
    assertPosition(source, observation, true);
    if (!sourceCache.has(sourceId)) {
      sourceCache.set(sourceId, structuredClone(source));
      sources.push(structuredClone(source));
      retainedBytes += Buffer.byteLength(JSON.stringify(source));
    }
    originals.push(structuredClone(original));
    const replacement = structuredClone(original), fields: StockField[] = [];
    for (const field of STOCK_FIELDS) {
      const current = original.data[field], derived = observation.stock[field];
      if (current === null || current === undefined) { replacement.data[field] = derived; fields.push(field); }
      else if (!isDeepStrictEqual(current, derived)) throw new Error(`Present stock mismatch: ${observation.id}.${field}`);
    }
    retainedBytes += 2 * Buffer.byteLength(JSON.stringify(original));
    if (retainedBytes > MAX_PLAN_BYTES) throw new Error('Repair plan exceeds retained document byte bound');
    if (fields.length) { replacements.push(replacement); changes.push({ id: observation.id, fields }); }
  }
  const plan: NetworkStockRepairPlan = Object.freeze({ kind: 'network-stock-repair-plan-v1', observations: originals.length,
    changedRows: replacements.length, unchangedRows: originals.length - replacements.length,
    changes: Object.freeze(changes.map((change) => Object.freeze({ ...change, fields: Object.freeze(change.fields) }))),
  });
  issuedPlans.set(plan, { originals, sources, replacements });
  return plan;
}

/**
 * Recheck all originals and canonical sources, commit one bounded atomic native
 * upsertMany call, then verify full documents. An offline exclusive handle is
 * required because the repository interface provides no compare-and-swap API.
 */
export async function applyNetworkStockRepair(repository: RepairRepository, plan: NetworkStockRepairPlan): Promise<{ changedRows: number; verifiedRows: number }> {
  const state = issuedPlans.get(plan);
  if (!state) throw new Error('Repair plan was not issued by this module');
  for (const original of [...state.originals, ...state.sources]) {
    const current = await repository.get(original.collection, original.id);
    if (!isDeepStrictEqual(current, original)) throw new Error(`Repair source changed since planning: ${original.id}`);
  }
  if (state.replacements.length) await repository.upsertMany(structuredClone(state.replacements));
  const replacements = new Map(state.replacements.map((document) => [document.id, document]));
  for (const original of state.originals) {
    const expected = replacements.get(original.id) ?? original;
    if (!isDeepStrictEqual(await repository.get('networkSnapshots', original.id), expected))
      throw new Error(`Repair full-document verification failed: ${original.id}`);
  }
  for (const source of state.sources) {
    if (!isDeepStrictEqual(await repository.get('networkSnapshots', source.id), source))
      throw new Error(`Repair canonical BLOCK changed during application: ${source.id}`);
  }
  return { changedRows: state.replacements.length, verifiedRows: state.originals.length };
}
