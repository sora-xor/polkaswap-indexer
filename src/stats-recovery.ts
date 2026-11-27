import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { validateBurnRecoveryPolicy, type BurnRecoveryPolicy } from './burn-recovery.js';
import { PRE_FORK_HISTORY_HOLD_CHECKPOINT } from './recovery-hold.js';
import { isNonzeroCanonicalSubstrateHash, parseStoredSoraChainState, SORA_MAINNET_GENESIS_HASH } from './soraIdentity.js';
import { normalizeIndexerDocument } from './repository/validation.js';
import type { IndexerCollection, IndexerDocument, IndexerRepository } from './repository/types.js';

export const STATS_ADMISSION_ID = 'canonicalStatsHistoryAdmission-v1';
export const STATS_CURSOR_ID = 'canonicalStatsHistoryCursor-v1';
export const STATS_RECONCILIATION_ID = 'canonicalStatsHistoryReconciliation-v1';
export const STATS_VOLUME_REPAIR_ID = 'networkVolumeRepair-v2';
/** Exact normalized marker observed in the independently qualified retained prefix. */
export const STATS_VOLUME_REPAIR_SHA256 = '28ddafd9e177edb13f9b588e293ba7913f6509ab787a4a1d5ddcc4a145e8e169';
const SCHEMA = 'sora-nexus-canonical-stats-history-v1';
const SHA = /^[a-f0-9]{64}$/;
const PREFIX = { ...PRE_FORK_HISTORY_HOLD_CHECKPOINT, genesisHash: SORA_MAINNET_GENESIS_HASH };

/** Operator-pinned admission for an independently qualified prefix COPY, never an entitlement source. */
export type StatsRecoveryAdmission = {
  schema: typeof SCHEMA;
  approvedForStatsHistory: true;
  entitlementsReady: false;
  sourceDatabasePath: string;
  databasePath: string;
  prefix: typeof PREFIX;
  qualification: { databaseFilesSha256: string; nativeAuditSha256: string; executorReceiptSha256: string; volumeRepairMarkerSha256: string };
  policy: BurnRecoveryPolicy;
};

/** Public capabilities are separate from complete-service health and never certify historical rederivation. */
export type IndexerCapabilities = {
  schemaVersion: 1;
  genesisHash: string;
  policyHash: string | null;
  mode: 'legacy' | 'full-recovery' | 'canonical-stats-history';
  statsReady: boolean;
  historyReady: boolean;
  currentViewsReady: boolean;
  coreViewsReady: boolean;
  entitlementsReady: false;
  indexedBlock: number | null;
  indexedBlockHash: string | null;
  reason: string | null;
};

function requireStats(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Canonical stats/history: ${message}`);
}

/** Sort public evidence keys without coercing exact numeric strings. */
export function statsEvidenceDigest(value: unknown): string {
  const ordered = (item: unknown): unknown => Array.isArray(item) ? item.map(ordered)
    : item !== null && typeof item === 'object'
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, entry]) => [key, ordered(entry)])) : item;
  return createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
}

/** Reject unreviewed modes, an arbitrary legacy height, or missing native-qualification pins. */
export function validateStatsRecoveryAdmission(value: unknown): StatsRecoveryAdmission {
  const admission = value as StatsRecoveryAdmission;
  requireStats(admission && Object.keys(admission).sort().join(',') ===
    'approvedForStatsHistory,databasePath,entitlementsReady,policy,prefix,qualification,schema,sourceDatabasePath', 'unexpected admission fields');
  requireStats(admission?.schema === SCHEMA && admission.approvedForStatsHistory === true &&
    admission.entitlementsReady === false && typeof admission.databasePath === 'string' &&
    isAbsolute(admission.databasePath) && resolve(admission.databasePath) === admission.databasePath &&
    typeof admission.sourceDatabasePath === 'string' && isAbsolute(admission.sourceDatabasePath) &&
    resolve(admission.sourceDatabasePath) === admission.sourceDatabasePath && admission.sourceDatabasePath !== admission.databasePath,
  'invalid explicit admission');
  requireStats(isDeepStrictEqual(admission.prefix, PREFIX), 'the exact qualified canonical prefix is required');
  requireStats(admission.qualification &&
    Object.keys(admission.qualification).sort().join(',') === 'databaseFilesSha256,executorReceiptSha256,nativeAuditSha256,volumeRepairMarkerSha256' &&
    Object.values(admission.qualification).every((pin) => typeof pin === 'string' && SHA.test(pin)),
  'complete prefix qualification pins are required');
  requireStats(admission.qualification.volumeRepairMarkerSha256 === STATS_VOLUME_REPAIR_SHA256,
    'the independently verified prefix volume repair marker is required');
  validateBurnRecoveryPolicy(admission.policy);
  return admission;
}

/** Load only explicitly pinned candidate configuration; this never initializes a database. */
export function loadStatsRecoveryAdmission(path: string | undefined, pin: string | undefined): StatsRecoveryAdmission | null {
  if (!path && !pin) return null;
  requireStats(path && pin && SHA.test(pin), 'admission path and SHA-256 are required together');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    requireStats(before.isFile() && before.size <= 16 * 1024 * 1024, 'admission exceeds the file bound');
    const raw = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < raw.length) {
      const count = readSync(fd, raw, offset, raw.length - offset, offset);
      requireStats(count > 0, 'admission was truncated');
      offset += count;
    }
    const after = fstatSync(fd);
    requireStats(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs &&
      createHash('sha256').update(raw).digest('hex') === pin, 'admission bytes differ');
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    // Operator evidence has one encoding: duplicate keys and lossy numeric forms cannot be admitted.
    requireStats(Buffer.from(JSON.stringify(value)).equals(raw), 'admission JSON must be canonical');
    return validateStatsRecoveryAdmission(value);
  } finally { closeSync(fd); }
}

/** Read the durable classification on every authorization check, including API-only readers. */
export async function statsRecoveryAdmission(repository: Pick<IndexerRepository, 'get'>): Promise<StatsRecoveryAdmission | null> {
  const row = await repository.get('updatesStreams', STATS_ADMISSION_ID);
  if (!row) {
    requireStats(!(await repository.get('updatesStreams', STATS_CURSOR_ID)), 'orphan stats cursor');
    return null;
  }
  const admission = validateStatsRecoveryAdmission(row.data.admission);
  requireStats(row.collection === 'updatesStreams' && row.id === STATS_ADMISSION_ID && row.data.id === row.id &&
    row.blockHeight === PREFIX.block && row.timestamp === null &&
    row.data.admissionDigest === statsEvidenceDigest(admission), 'malformed persisted admission');
  return admission;
}

/** Full/ordinary workers and entitlement exporters must never adopt a statistics-only derivative. */
export async function assertNotStatsRecovery(repository: Pick<IndexerRepository, 'get'>): Promise<void> {
  requireStats(!(await statsRecoveryAdmission(repository)), 'statistics-only database cannot enter full recovery');
}

/** The admitted prefix retains its completed exchange-only/calendar repair; no legacy rewrite is implied. */
export async function requireStatsVolumeRepair(repository: Pick<IndexerRepository, 'get'>, admission: StatsRecoveryAdmission): Promise<void> {
  const row = await repository.get('updatesStreams', STATS_VOLUME_REPAIR_ID);
  requireStats(row && statsEvidenceDigest(row) === admission.qualification.volumeRepairMarkerSha256 &&
    row.collection === 'updatesStreams' && row.id === STATS_VOLUME_REPAIR_ID && row.data.id === row.id &&
    typeof row.data.data === 'string', 'pinned completed network volume repair is required');
  const repair = JSON.parse(row.data.data);
  requireStats(repair.status === 'complete' && repair.repairVersion === 2 &&
    repair.semantics === 'verified-block-exchange-volume-calendar-v2' &&
    Number.isSafeInteger(repair.throughBlock) && repair.throughBlock > 0 && repair.throughBlock <= PREFIX.block &&
    row.blockHeight === repair.throughBlock && row.data.block === repair.throughBlock &&
    Number.isSafeInteger(repair.latestSnapshotTimestamp) && row.timestamp === repair.latestSnapshotTimestamp,
  'invalid completed network volume repair');
}

/** Exact suffix continuity is independent of the full point journal and cannot stand in for it. */
export async function requireStatsRecoveryState(repository: Pick<IndexerRepository, 'get'>, admission: StatsRecoveryAdmission) {
  requireStats(isDeepStrictEqual(await statsRecoveryAdmission(repository), admission), 'persisted/configured admission mismatch');
  for (const id of ['burnRecoveryIdentity-v1', 'soratopiaRecoveryContinuity-v1', 'soratopiaRecoveryProjection-v1']) {
    requireStats(!(await repository.get('updatesStreams', id)), 'full recovery identity cannot coexist with stats mode');
  }
  await requireStatsVolumeRepair(repository, admission);
  const stateRow = await repository.get('updatesStreams', 'chainState');
  const state = parseStoredSoraChainState(typeof stateRow?.data.data === 'string' ? JSON.parse(stateRow.data.data) : null);
  const cursor = await repository.get('updatesStreams', STATS_CURSOR_ID);
  requireStats(state && state.lastIndexedBlock >= PREFIX.block && state.genesisHash === SORA_MAINNET_GENESIS_HASH &&
    stateRow?.blockHeight === state.lastIndexedBlock && stateRow.data.block === state.lastIndexedBlock,
  'invalid stats chain checkpoint');
  requireStats(cursor?.collection === 'updatesStreams' && cursor.id === STATS_CURSOR_ID && cursor.data.id === cursor.id &&
    cursor.blockHeight === state.lastIndexedBlock && cursor.timestamp === null &&
    cursor.data.admissionDigest === statsEvidenceDigest(admission) &&
    cursor.data.block === state.lastIndexedBlock && cursor.data.hash === state.blockHash &&
    cursor.data.blockTimestamp === state.blockTimestamp && cursor.data.entitlementsReady === false,
  'stats cursor/chain checkpoint mismatch');
  if (state.lastIndexedBlock === PREFIX.block) requireStats(state.blockHash === PREFIX.hash && state.blockTimestamp === PREFIX.timestamp,
    'stats seed differs from the qualified prefix');
  return state;
}

/** Prepare a cursor only for the next canonical child; the caller commits it with the block and chainState. */
export async function statsBlockCursor(repository: Pick<IndexerRepository, 'get'>, admission: StatsRecoveryAdmission,
  block: number, hash: string, parent: string, timestamp: number): Promise<IndexerDocument> {
  const previous = await requireStatsRecoveryState(repository, admission);
  requireStats(Number.isSafeInteger(block) && block === previous.lastIndexedBlock + 1 && parent === previous.blockHash &&
    isNonzeroCanonicalSubstrateHash(hash) && Number.isSafeInteger(timestamp) && timestamp >= previous.blockTimestamp,
  'noncontiguous stats block');
  for (const identity of [admission.policy.checkpoint, admission.policy.postForkAnchor]) {
    if (block === identity.block) requireStats(hash === identity.hash, 'stats block differs from the pinned recovery anchor');
  }
  return { collection: 'updatesStreams', id: STATS_CURSOR_ID, blockHeight: block, timestamp: null, data: {
    id: STATS_CURSOR_ID, admissionDigest: statsEvidenceDigest(admission), block, hash, parentHash: parent, blockTimestamp: timestamp,
    entitlementsReady: false,
  } };
}

const WRITE_COLLECTIONS = new Set<IndexerCollection>([
  'accounts', 'accountPositions', 'accountTrades', 'accountTransactions', 'accountLiquiditySnapshots',
  'assets', 'assetSnapshots', 'historyCalls', 'historyElements', 'markets', 'marketSnapshots',
  'networkSnapshots', 'orderBooks', 'orderBookOrders', 'orderBookSnapshots', 'poolXYKs', 'poolSnapshots',
  'stakingStakers', 'stakingValidators', 'vaults', 'vaultEvents',
]);
const WRITE_STREAMS = new Set(['workerStatus-v1', 'chainState', STATS_CURSOR_ID, STATS_RECONCILIATION_ID,
  'hourlyHistoryTargets-v1', 'price', 'apy', 'assetRegistration', 'stakingValidators']);

/** Hard writer boundary: retained entitlement evidence is never modified or deleted by this worker. */
export function restrictStatsRecoveryWrites(repository: IndexerRepository, admission: StatsRecoveryAdmission): IndexerRepository {
  const check = (collection: IndexerCollection, id: string): void => {
    requireStats(collection === 'updatesStreams' ? WRITE_STREAMS.has(id) : WRITE_COLLECTIONS.has(collection),
      `write outside stats scope: ${collection}/${id}`);
  };
  const prepare = (row: IndexerDocument): IndexerDocument => {
    check(row.collection, row.id);
    if (['historyCalls', 'historyElements', 'accountTransactions', 'accountTrades', 'vaultEvents'].includes(row.collection) ||
        (row.collection === 'networkSnapshots' && row.data.type === 'BLOCK')) {
      requireStats(Number.isSafeInteger(row.blockHeight) && Number(row.blockHeight) > admission.prefix.block,
        'retained prefix history cannot be rewritten');
    }
    if (row.collection !== 'networkSnapshots') return row;
    const calendar = row.data.calendarFlows;
    return { ...row, data: { ...row.data, accounts: null, accountCountAvailable: false,
      ...(calendar && typeof calendar === 'object' && !Array.isArray(calendar)
        ? { calendarFlows: { ...calendar, accounts: null, accountCountAvailable: false } } : {}),
    } };
  };
  const atomic = (rows: IndexerDocument[]): IndexerDocument[] => {
    const prepared = rows.map(prepare);
    const states = rows.filter((row) => row.collection === 'updatesStreams' && row.id === 'chainState');
    const cursors = rows.filter((row) => row.collection === 'updatesStreams' && row.id === STATS_CURSOR_ID);
    if (states.length || cursors.length) {
      requireStats(states.length === 1 && cursors.length === 1, 'stats cursor and chainState must commit together');
      const state = parseStoredSoraChainState(JSON.parse(String(states[0]!.data.data)));
      const cursor = cursors[0]!;
      const markers = rows.filter((row) => row.collection === 'updatesStreams' && row.id === STATS_RECONCILIATION_ID);
      requireStats(markers.length === 1 && markers[0]!.data.ready === false &&
        markers[0]!.blockHeight === cursor.data.block && markers[0]!.data.block === cursor.data.block &&
        markers[0]!.data.hash === cursor.data.hash && markers[0]!.data.admissionDigest === statsEvidenceDigest(admission),
      'checkpoint must invalidate core readiness atomically');
      requireStats(state && cursor.blockHeight === state.lastIndexedBlock && cursor.timestamp === null &&
        cursor.data.id === STATS_CURSOR_ID && cursor.data.entitlementsReady === false &&
        cursor.data.admissionDigest === statsEvidenceDigest(admission) &&
        states[0]!.blockHeight === state.lastIndexedBlock && Number.isSafeInteger(states[0]!.timestamp) && Number(states[0]!.timestamp) > 0 &&
        states[0]!.data.block === state.lastIndexedBlock && state.genesisHash === SORA_MAINNET_GENESIS_HASH &&
        cursor.data.block === state.lastIndexedBlock && cursor.data.hash === state.blockHash &&
        cursor.data.blockTimestamp === state.blockTimestamp && rows.some((row) => row.collection === 'networkSnapshots' &&
          row.id === `block-${state.lastIndexedBlock}` && row.blockHeight === state.lastIndexedBlock &&
          row.data.type === 'BLOCK' && row.data.timestamp === state.blockTimestamp), 'atomic stats checkpoint is incomplete');
    }
    return prepared;
  };
  return new Proxy(repository, { get(target, key) {
    if (key === 'upsert') return (row: IndexerDocument) => target.upsert(atomic([row])[0]!);
    if (key === 'upsertMany') return (rows: IndexerDocument[]) => {
      const prepared = atomic(rows);
      const cursor = prepared.find((row) => row.collection === 'updatesStreams' && row.id === STATS_CURSOR_ID);
      if (!cursor) return target.upsertMany(prepared);
      return (async () => {
        const previous = await requireStatsRecoveryState(target, admission);
        requireStats(cursor.data.block === previous.lastIndexedBlock + 1 && cursor.data.parentHash === previous.blockHash &&
          Number(cursor.data.blockTimestamp) >= previous.blockTimestamp, 'writer cannot skip or replay a stats block');
        for (const anchor of [admission.policy.checkpoint, admission.policy.postForkAnchor]) {
          if (cursor.data.block === anchor.block) requireStats(cursor.data.hash === anchor.hash, 'writer recovery anchor differs');
        }
        await target.upsertMany(prepared);
      })();
    };
    if (key === 'deleteMany') return (collection: IndexerCollection, ids: string[]) => {
      ids.forEach((id) => check(collection, id));
      requireStats(['assets', 'poolXYKs', 'orderBooks', 'markets', 'accountPositions', 'stakingStakers', 'stakingValidators'].includes(collection),
        'retained history and stats evidence cannot be deleted');
      return target.deleteMany(collection, ids);
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

const CORE_COLLECTIONS: IndexerCollection[] = ['assets', 'poolXYKs', 'orderBooks'];
const CORE_STREAMS = ['price', 'apy', 'assetRegistration'];
const CORE_SCHEMA = 'sora-nexus-stats-core-reconciliation-v1';
const CORE_MAX_ROWS = 32_768;
const CORE_MAX_BYTES = 32 * 1024 * 1024;

/** Invalidate public core reads before a checkpoint advances or any partial refresh begins. */
export function statsReconciliationPending(admission: StatsRecoveryAdmission, block: number, hash: string): IndexerDocument {
  return { collection: 'updatesStreams', id: STATS_RECONCILIATION_ID, blockHeight: block, timestamp: null,
    data: { id: STATS_RECONCILIATION_ID, schema: CORE_SCHEMA, admissionDigest: statsEvidenceDigest(admission),
      policyHash: admission.policy.policyHash, block, hash, generation: randomUUID(), ready: false } };
}

/** Verify the complete bounded normalized core row sets, then publish readiness last at the unchanged checkpoint. */
export async function verifyStatsCoreReconciliation(repository: IndexerRepository, admission: StatsRecoveryAdmission,
  block: number, hash: string, expectedRows: IndexerDocument[]): Promise<boolean> {
  requireStats(repository.query, 'bounded core verification queries are required');
  const expected = expectedRows.filter((row) => CORE_COLLECTIONS.includes(row.collection) ||
    (row.collection === 'updatesStreams' && CORE_STREAMS.includes(row.id))).map(normalizeIndexerDocument);
  requireStats(expected.length <= CORE_MAX_ROWS && Buffer.byteLength(JSON.stringify(expected)) <= CORE_MAX_BYTES,
    'core reconciliation expected data exceeds bound');
  const key = (row: IndexerDocument) => `${row.collection}/${row.id}`;
  const byKey = new Map(expected.map((row) => [key(row), row]));
  requireStats(byKey.size === expected.length && CORE_STREAMS.every((id) => byKey.has(`updatesStreams/${id}`)) &&
    expected.every((row) => row.blockHeight === block), 'incomplete or duplicate core reconciliation inputs');
  const observed: IndexerDocument[] = [];
  let observedBytes = 0;
  for (const collection of CORE_COLLECTIONS) {
    let previous = '', offset = 0;
    for (;;) {
      const result = await repository.query(collection, { first: 256, offset, orderBy: ['ID_ASC'],
        includeTotalCount: false, maxBytes: 1024 * 1024 });
      requireStats(result.items.length > 0 || !result.hasNextPage, 'core verification did not advance');
      for (const row of result.items) {
        requireStats(row.collection === collection && row.id > previous, 'unordered core verification rows');
        previous = row.id;
        observedBytes += Buffer.byteLength(JSON.stringify(row));
        requireStats(observed.length < CORE_MAX_ROWS && observedBytes <= CORE_MAX_BYTES, 'core verification exceeds bound');
        const wanted = byKey.get(key(row));
        requireStats(wanted && isDeepStrictEqual(normalizeIndexerDocument(row), wanted), 'core row differs or is stale');
        observed.push(row);
      }
      offset += result.items.length;
      if (!result.hasNextPage) break;
    }
  }
  for (const id of CORE_STREAMS) {
    const row = await repository.get('updatesStreams', id);
    requireStats(row && isDeepStrictEqual(normalizeIndexerDocument(row), byKey.get(`updatesStreams/${id}`)), 'core stream differs');
    observed.push(row);
  }
  requireStats(observed.length === expected.length, 'core reconciliation rows are missing');
  const state = await requireStatsRecoveryState(repository, admission);
  if (state.lastIndexedBlock !== block || state.blockHash !== hash) return false;
  const manifest = expected.map((row) => ({ key: key(row), sha256: statsEvidenceDigest(row) })).sort((a, b) => a.key < b.key ? -1 : 1);
  const pending = await repository.get('updatesStreams', STATS_RECONCILIATION_ID);
  requireStats(pending?.data.ready === false && pending.data.block === block && pending.data.hash === hash &&
    typeof pending.data.generation === 'string', 'core reconciliation was not invalidated first');
  await repository.upsert({ ...pending, data: { ...pending.data, ready: true, rows: manifest.length,
    normalizedRowsSha256: statsEvidenceDigest(manifest), collections: CORE_COLLECTIONS, streams: CORE_STREAMS } });
  return true;
}

/** A receipt is usable only at its exact admitted checkpoint and while the real pipeline is ready. */
async function statsCoreReady(repository: Pick<IndexerRepository, 'get'>, admission: StatsRecoveryAdmission,
  state: Awaited<ReturnType<typeof requireStatsRecoveryState>>, workerReady: boolean): Promise<boolean> {
  if (!workerReady) return false;
  const row = await repository.get('updatesStreams', STATS_RECONCILIATION_ID);
  const data = row?.data;
  return Boolean(row?.collection === 'updatesStreams' && row.id === STATS_RECONCILIATION_ID &&
    row.blockHeight === state.lastIndexedBlock && row.timestamp === null && data?.id === row.id &&
    data.schema === CORE_SCHEMA && data.admissionDigest === statsEvidenceDigest(admission) &&
    data.policyHash === admission.policy.policyHash && data.block === state.lastIndexedBlock && data.hash === state.blockHash &&
    data.ready === true && typeof data.generation === 'string' && /^[0-9a-f-]{36}$/.test(data.generation) && Number.isSafeInteger(data.rows) && Number(data.rows) >= CORE_STREAMS.length &&
    Number(data.rows) <= CORE_MAX_ROWS && SHA.test(String(data.normalizedRowsSha256)) &&
    isDeepStrictEqual(data.collections, CORE_COLLECTIONS) && isDeepStrictEqual(data.streams, CORE_STREAMS));
}

/** Stats mode is a durable API authorization boundary, not a presentation hint. */
export async function assertEntitlementQueriesAvailable(repository: Pick<IndexerRepository, 'get'>): Promise<void> {
  requireStats(!(await statsRecoveryAdmission(repository)), 'entitlements are unavailable in canonical stats/history mode');
}

const CLAIM_COLLECTIONS = new Set<IndexerCollection>(['accountMeta', 'accountPointSystems', 'xorBurns', 'referrerRewards']);
const CURRENT_COLLECTIONS = new Set<IndexerCollection>(['assets', 'poolXYKs', 'orderBooks', 'orderBookOrders',
  'markets', 'accountPositions', 'accountLiquiditySnapshots', 'stakingStakers', 'stakingValidators', 'vaults']);

/** Unknown account-creation counts cannot be used as hidden ordering/filter predicates either. */
export function assertStatsQueryArguments(filter: unknown, orderBy: unknown): void {
  const containsAccounts = (value: unknown): boolean => Array.isArray(value) ? value.some(containsAccounts)
    : value !== null && typeof value === 'object'
      ? Object.entries(value).some(([key, child]) => key === 'accounts' || containsAccounts(child)) : false;
  requireStats(!containsAccounts(filter) && !(Array.isArray(orderBy) ? orderBy : [orderBy])
    .some((value) => typeof value === 'string' && /^ACCOUNTS_(ASC|DESC)$/.test(value)),
  'account creation counts are unavailable');
}

/** Guard before cache materialization, including arbitrary update-stream IDs and each subscription emission. */
export async function assertStatsPublicRead(repository: Pick<IndexerRepository, 'get'>, collection: IndexerCollection,
  ids: string[] = [], pipelineReady: () => Promise<boolean> = async () => false): Promise<boolean> {
  const admission = await statsRecoveryAdmission(repository);
  if (!admission) return false;
  requireStats(!CLAIM_COLLECTIONS.has(collection), 'entitlements are unavailable in canonical stats/history mode');
  if (collection === 'updatesStreams') {
    requireStats(ids.length > 0 && ids.every((id) => ['chainState', 'chainIdentity', 'price', 'apy', 'assetRegistration', 'stakingValidators'].includes(id)),
      'update stream is unavailable in stats/history mode');
  }
  if (CURRENT_COLLECTIONS.has(collection) || (collection === 'updatesStreams' && ids.some((id) => id !== 'chainState' && id !== 'chainIdentity'))) {
    requireStats(CORE_COLLECTIONS.includes(collection) || (collection === 'updatesStreams' && ids.every((id) => CORE_STREAMS.includes(id))),
      'current storage views await independently verified complete reconciliation');
    const state = await requireStatsRecoveryState(repository, admission);
    requireStats(await statsCoreReady(repository, admission, state, await pipelineReady()), 'core views are not ready at the current checkpoint');
  }
  return true;
}

export type StatsCoreGeneration = { generation: string; block: number; hash: string };
/** The cursor token and response fence share the same captured reconciliation receipt. */
export type StatsCoreReadBoundary = {
  <T>(value: T): Promise<T>;
  readonly generation?: StatsCoreGeneration;
};

/** Reject a response that crossed any partial refresh, even a refresh repeated at the same block. */
export async function statsCoreReadBoundary(repository: Pick<IndexerRepository, 'get'>, collection: IndexerCollection,
  ids: string[], pipelineReady: () => Promise<boolean>): Promise<StatsCoreReadBoundary> {
  const admission = await statsRecoveryAdmission(repository);
  const isCore = CORE_COLLECTIONS.includes(collection) || (collection === 'updatesStreams' && ids.some((id) => CORE_STREAMS.includes(id)));
  if (!admission || !isCore) return async <T>(value: T) => value;
  const receipt = await repository.get('updatesStreams', STATS_RECONCILIATION_ID);
  const state = await repository.get('updatesStreams', 'chainState');
  requireStats(receipt?.data.ready === true, 'core refresh is in progress');
  await assertStatsPublicRead(repository, collection, ids, pipelineReady);
  const finish = async <T>(value: T) => {
    const [after, afterState] = await Promise.all([repository.get('updatesStreams', STATS_RECONCILIATION_ID),
      repository.get('updatesStreams', 'chainState')]);
    requireStats(isDeepStrictEqual(receipt, after) && isDeepStrictEqual(state, afterState), 'core view changed during the read');
    await assertStatsPublicRead(repository, collection, ids, pipelineReady);
    return value;
  };
  return Object.assign(finish, { generation: { generation: String(receipt.data.generation),
    block: Number(receipt.data.block), hash: String(receipt.data.hash) } });
}

/** Report only observed capabilities; no current code path can certify the missing external entitlement gate. */
export async function indexerCapabilities(repository: Pick<IndexerRepository, 'get'>, workerReady: boolean): Promise<IndexerCapabilities> {
  const admission = await statsRecoveryAdmission(repository);
  const stateRow = await repository.get('updatesStreams', 'chainState');
  const state = parseStoredSoraChainState(typeof stateRow?.data.data === 'string' ? JSON.parse(stateRow.data.data) : null);
  const fullIdentity = await repository.get('updatesStreams', 'burnRecoveryIdentity-v1');
  const policy = admission?.policy ?? (fullIdentity ? validateBurnRecoveryPolicy(JSON.parse(String(fullIdentity.data.data))) : null);
  if (admission) await requireStatsRecoveryState(repository, admission);
  return { schemaVersion: 1, genesisHash: SORA_MAINNET_GENESIS_HASH, policyHash: policy?.policyHash ?? null,
    mode: admission ? 'canonical-stats-history' : policy ? 'full-recovery' : 'legacy',
    statsReady: Boolean(state && workerReady), historyReady: Boolean(state && workerReady),
    currentViewsReady: admission ? false : Boolean(state && workerReady),
    coreViewsReady: admission && state ? await statsCoreReady(repository, admission, state, workerReady) : Boolean(state && workerReady),
    entitlementsReady: false,
    indexedBlock: state?.lastIndexedBlock ?? null, indexedBlockHash: state?.blockHash ?? null,
    reason: admission ? 'Canonical statistics/history only; account creation counts and recovery entitlements are unavailable.'
      : 'Recovery entitlements require independent complete-history certification.',
  };
}
