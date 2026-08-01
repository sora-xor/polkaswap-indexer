import { pathToFileURL } from 'node:url';

import { readConfig } from '../config.js';
import {
  ROCKSDB_FORMAT_METADATA_KEY,
  ROCKSDB_FORMAT_VERSION,
  RocksRepository,
  rocksCompactIndexKeysForDocument,
} from '../repository/rocksdb.js';
import { decodeRocksDocument } from '../repository/rocksdb-document.js';
import { INDEXER_COLLECTIONS } from '../repository/types.js';
import { readNonNegativeSafeInteger, readPositiveSafeInteger, readStrictBoolean } from './env.js';
import {
  assertCurrentRocksdbArtifactSource,
  assertExistingRocksdbDirectory,
} from './rocksdb-artifact-source.js';

import type { IndexerCollection, IndexerDocument } from '../repository/types.js';
import type { RocksReadView } from '../repository/rocksdb.js';
import type { ApiPromise as PolkadotApi, WsProvider as PolkadotWsProvider } from '@polkadot/api';

type RocksKeyPart = string | number | boolean | Buffer | null;
type RocksKey = RocksKeyPart[];

export type RocksAuditOptions = {
  sampleSize?: number;
  finalizedBlock?: number | null;
  chainReadError?: string | null;
  nowMs?: number;
  maxLagBlocks?: number;
  maxStateAgeSeconds?: number;
  requireChain?: boolean;
  /** Set only after exhaustive repository validation succeeds. */
  fullValidationPassed?: boolean;
};

export const readRocksAuditChainTimeoutMs = (env: NodeJS.ProcessEnv): number => {
  const timeoutMs = readPositiveSafeInteger(env, 'ROCKSDB_AUDIT_CHAIN_TIMEOUT_MS', 10_000);
  if (timeoutMs > 60_000) {
    throw new Error('ROCKSDB_AUDIT_CHAIN_TIMEOUT_MS must be at most 60000');
  }
  return timeoutMs;
};

const HIGH_KEY = Buffer.from([0xff]);
const MAX_EXAMPLES = 10;
const COLLECTION_SET = new Set<string>(INDEXER_COLLECTIONS);

const prefixRange = (prefix: RocksKey) => ({
  start: prefix,
  end: [...prefix, HIGH_KEY],
  inclusiveEnd: true,
});

const readCount = (db: RocksReadView, prefix: RocksKey): number => db.getKeysCount(prefixRange(prefix));
const metadataKey = (name: string): RocksKey => ['m', 'metadata', name];
const readMetadata = (db: RocksReadView, name: string): unknown => db.getSync(metadataKey(name));
const keyIdentity = (key: RocksKey): string => JSON.stringify(key);

const stratifiedRangeEntries = (
  db: RocksReadView,
  prefix: RocksKey,
  limit: number,
  values = true
): Array<{ key: unknown; value?: unknown }> => {
  const forwardLimit = Math.ceil(limit / 2);
  const reverseLimit = Math.floor(limit / 2);
  const entries: Array<{ key: unknown; value?: unknown }> = [];
  const identities = new Set<string>();

  for (const reverse of [false, true]) {
    const directionLimit = reverse ? reverseLimit : forwardLimit;
    if (directionLimit <= 0) continue;

    for (const entry of db.getRange({
      ...prefixRange(prefix),
      values,
      reverse,
      limit: directionLimit,
    })) {
      const identity = JSON.stringify(entry?.key);
      if (identities.has(identity)) continue;
      identities.add(identity);
      entries.push(entry as { key: unknown; value?: unknown });
    }
  }

  return entries;
};

const documentIdentity = (key: unknown): { collection: IndexerCollection; id: string } | null => {
  if (!Array.isArray(key) || key[0] !== 'd' || typeof key[1] !== 'string' || typeof key[2] !== 'string') return null;
  if (!COLLECTION_SET.has(key[1])) return null;

  return { collection: key[1] as IndexerCollection, id: key[2] };
};

const compactIdentity = (key: unknown): { collection: IndexerCollection; id: string; key: RocksKey } | null => {
  if (!Array.isArray(key) || key[0] !== 'x' || typeof key[1] !== 'string' || !COLLECTION_SET.has(key[1])) return null;
  const id = key[key.length - 1];
  if (typeof id !== 'string') return null;

  return { collection: key[1] as IndexerCollection, id, key: key as RocksKey };
};

const parseChainState = (
  db: RocksReadView,
  finalizedBlock: number | null,
  chainReadError: string | null,
  nowMs: number
) => {
  const collection: IndexerCollection = 'updatesStreams';
  const id = 'chainState';
  const document = decodeRocksDocument(collection, id, db.getSync(['d', collection, id]));
  let payload: Record<string, unknown> = {};

  if (typeof document?.data.data === 'string') {
    try {
      const parsed: unknown = JSON.parse(document.data.data);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
    } catch {
      // Keep the stored header fields available even when the payload is malformed.
    }
  }

  const safeInteger = (value: unknown): number | null => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' && !/^(0|[1-9]\d*)$/.test(value)) return null;
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  };
  const indexedBlock = safeInteger(payload.lastIndexedBlock ?? document?.data.block ?? document?.blockHeight);
  const updatedAt = safeInteger(document?.timestamp ?? document?.data.timestamp);
  const safeFinalizedBlock = safeInteger(finalizedBlock);
  const nowSeconds = safeInteger(Math.floor(nowMs / 1_000));
  const validationErrors: string[] = [];
  if (document && indexedBlock === null) validationErrors.push('invalid indexed block');
  if (document && updatedAt === null) validationErrors.push('invalid worker timestamp');
  if (finalizedBlock !== null && safeFinalizedBlock === null) validationErrors.push('invalid finalized block');
  if (nowSeconds === null) validationErrors.push('invalid audit clock');
  if (indexedBlock !== null && safeFinalizedBlock !== null && indexedBlock > safeFinalizedBlock) {
    validationErrors.push('indexed block is ahead of finalized block');
  }
  if (updatedAt !== null && nowSeconds !== null && updatedAt > nowSeconds) {
    validationErrors.push('worker timestamp is in the future');
  }

  return {
    present: Boolean(document),
    indexedBlock,
    finalizedBlock: safeFinalizedBlock,
    lagBlocks:
      indexedBlock !== null && safeFinalizedBlock !== null ? safeFinalizedBlock - indexedBlock : null,
    updatedAt,
    ageSeconds: updatedAt === null || nowSeconds === null ? null : nowSeconds - updatedAt,
    chainReadError,
    validationErrors,
  };
};

export const buildRocksAuditReport = (db: RocksReadView, options: RocksAuditOptions = {}) => {
  const sampleSize = Math.max(Math.trunc(options.sampleSize ?? 1_000), 1);
  const formatVersionValue = readMetadata(db, ROCKSDB_FORMAT_METADATA_KEY);
  const formatVersion = Number.isSafeInteger(formatVersionValue) ? (formatVersionValue as number) : null;
  const formatReady = formatVersion === ROCKSDB_FORMAT_VERSION;
  const verifyMissingIndexes = formatReady;
  const perCollectionSampleSize = Math.max(Math.ceil(sampleSize / INDEXER_COLLECTIONS.length), 1);
  const documentSamplesByCollection = Object.fromEntries(
    INDEXER_COLLECTIONS.map((collection) => [collection, 0])
  ) as Record<IndexerCollection, number>;
  const compactIndexSamplesByCollection = Object.fromEntries(
    INDEXER_COLLECTIONS.map((collection) => [collection, 0])
  ) as Record<IndexerCollection, number>;
  const missingExamples: RocksKey[] = [];
  const danglingExamples: Array<{ key: RocksKey | unknown; reason: string }> = [];
  let sampledDocuments = 0;
  let expectedCompactIndexes = 0;
  let missingCompactIndexes = 0;

  for (const collection of INDEXER_COLLECTIONS) {
    for (const entry of stratifiedRangeEntries(db, ['d', collection], perCollectionSampleSize)) {
      const identity = documentIdentity(entry?.key);
      if (!identity) continue;
      const document = decodeRocksDocument(identity.collection, identity.id, entry?.value);
      if (!document) continue;
      sampledDocuments += 1;
      documentSamplesByCollection[collection] += 1;
      if (!verifyMissingIndexes) continue;

      for (const expectedKey of rocksCompactIndexKeysForDocument(document)) {
        expectedCompactIndexes += 1;
        if (db.getSync(expectedKey) !== undefined) continue;
        missingCompactIndexes += 1;
        if (missingExamples.length < MAX_EXAMPLES) missingExamples.push(expectedKey);
      }
    }
  }

  let sampledCompactIndexes = 0;
  let danglingCompactIndexes = 0;
  for (const collection of INDEXER_COLLECTIONS) {
    for (const entry of stratifiedRangeEntries(db, ['x', collection], perCollectionSampleSize, false)) {
      sampledCompactIndexes += 1;
      compactIndexSamplesByCollection[collection] += 1;
      const identity = compactIdentity(entry?.key);
      if (!identity) {
        danglingCompactIndexes += 1;
        if (danglingExamples.length < MAX_EXAMPLES) danglingExamples.push({ key: entry?.key, reason: 'malformed_key' });
        continue;
      }

      const stored = db.getSync(['d', identity.collection, identity.id]);
      const document = decodeRocksDocument(identity.collection, identity.id, stored);
      if (!document) {
        danglingCompactIndexes += 1;
        if (danglingExamples.length < MAX_EXAMPLES) danglingExamples.push({ key: identity.key, reason: 'missing_document' });
        continue;
      }

      const expected = new Set(rocksCompactIndexKeysForDocument(document).map(keyIdentity));
      if (expected.has(keyIdentity(identity.key))) continue;
      danglingCompactIndexes += 1;
      if (danglingExamples.length < MAX_EXAMPLES) danglingExamples.push({ key: identity.key, reason: 'stale_index' });
    }
  }

  const storedCollections = Object.fromEntries(
    INDEXER_COLLECTIONS.map((collection) => {
      const storedCount = db.getSync(['m', 'count', collection]);

      return [collection, typeof storedCount === 'number' ? storedCount : null];
    })
  ) as Record<IndexerCollection, number | null>;
  const collections = Object.fromEntries(
    INDEXER_COLLECTIONS.map((collection) => [collection, readCount(db, ['d', collection])])
  ) as Record<IndexerCollection, number>;
  const collectionCountMismatches = INDEXER_COLLECTIONS.flatMap((collection) => {
    const stored = storedCollections[collection];
    const physical = collections[collection];
    return stored === physical || (stored === null && physical === 0)
      ? []
      : [{ collection, stored, physical }];
  });
  const compactIndexesByCollection = Object.fromEntries(
    INDEXER_COLLECTIONS.map((collection) => [collection, readCount(db, ['x', collection])])
  ) as Record<IndexerCollection, number>;
  const documents = Object.values(collections).reduce((sum, count) => sum + count, 0);
  const unsupportedIndexKeys = readCount(db, ['i']);
  const compactIndexes = readCount(db, ['x']);
  const estimatedKeys = db.getEstimatedKeyCount();
  const stats = db.getStats() as Record<string, unknown>;
  const liveDataBytes = Number(stats['rocksdb.estimate-live-data-size'] ?? 0);
  const sstBytes = Number(stats['rocksdb.live-sst-files-size'] ?? 0);
  const totalKnownKeys = documents + unsupportedIndexKeys + compactIndexes;
  const chainState = parseChainState(
    db,
    options.finalizedBlock ?? null,
    options.chainReadError ?? null,
    options.nowMs ?? Date.now()
  );
  const requireChain = options.requireChain ?? false;
  const maxLagBlocks = Math.max(Math.trunc(options.maxLagBlocks ?? 100), 0);
  const maxStateAgeSeconds = Math.max(Math.trunc(options.maxStateAgeSeconds ?? 600), 0);
  const chainHealthy =
    !requireChain ||
    (chainState.present &&
      chainState.chainReadError === null &&
      chainState.validationErrors.length === 0 &&
      chainState.lagBlocks !== null &&
      chainState.lagBlocks >= 0 &&
      chainState.lagBlocks <= maxLagBlocks &&
      chainState.ageSeconds !== null &&
      chainState.ageSeconds >= 0 &&
      chainState.ageSeconds <= maxStateAgeSeconds);
  const countsHealthy = collectionCountMismatches.length === 0;
  const sampleIntegrityHealthy = missingCompactIndexes === 0 && danglingCompactIndexes === 0;
  const fullValidationPassed = options.fullValidationPassed === true;
  const compactIntegrityHealthy = sampleIntegrityHealthy && fullValidationPassed;
  const formatHealthy = formatReady && unsupportedIndexKeys === 0;

  return {
    estimatedKeys,
    countedKeys: totalKnownKeys,
    documents,
    unsupportedIndexKeys,
    compactIndexes,
    compactIndexesByCollection,
    keysPerDocument: documents > 0 ? totalKnownKeys / documents : 0,
    liveDataBytes,
    sstBytes,
    collections,
    storedCollections,
    collectionCountMismatches,
    format: {
      version: formatVersion,
      expectedVersion: ROCKSDB_FORMAT_VERSION,
      ready: formatReady,
      unexpectedIndexNamespaceKeys: unsupportedIndexKeys,
    },
    chainState,
    compactIndexIntegrity: {
      requestedSampleLimit: sampleSize,
      perCollectionSampleLimit: perCollectionSampleSize,
      missingCheckEnabled: verifyMissingIndexes,
      sampledDocuments,
      documentSamplesByCollection,
      expectedCompactIndexes,
      missingCompactIndexes,
      sampledCompactIndexes,
      compactIndexSamplesByCollection,
      danglingCompactIndexes,
      sampleHealthy: sampleIntegrityHealthy,
      fullValidationPassed,
      healthy: compactIntegrityHealthy,
      missingExamples,
      danglingExamples,
    },
    releaseGate: {
      healthy: countsHealthy && compactIntegrityHealthy && formatHealthy && chainHealthy,
      countsHealthy,
      compactIntegrityHealthy,
      formatHealthy,
      chainHealthy,
      requireChain,
      maxLagBlocks,
      maxStateAgeSeconds,
    },
  };
};

export type ChainAuditApiModule = {
  ApiPromise: {
    create(options: { provider: PolkadotWsProvider }): Promise<PolkadotApi>;
  };
  WsProvider: new (endpoint: string) => PolkadotWsProvider;
};

const settleWithin = async (work: Promise<unknown>, timeoutMs: number): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([
    work.then(
      () => undefined,
      () => undefined
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(1, timeoutMs));
    }),
  ]);
  if (timer) clearTimeout(timer);
};

export const readFinalizedBlock = async (
  endpoint: string,
  timeoutMs: number,
  skipChain: boolean,
  loadApi: () => Promise<ChainAuditApiModule> = () => import('@polkadot/api')
): Promise<{ finalizedBlock: number | null; error: string | null }> => {
  if (skipChain) {
    return { finalizedBlock: null, error: 'chain check skipped' };
  }

  let provider: PolkadotWsProvider | null = null;
  let api: PolkadotApi | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let finished = false;
  const timeoutError = new Error(`chain check timed out after ${timeoutMs}ms`);
  const chainRead = (async (): Promise<number> => {
    const { ApiPromise, WsProvider } = await loadApi();
    provider = new WsProvider(endpoint);
    const createdApi = await ApiPromise.create({ provider });
    if (finished) {
      await settleWithin(createdApi.disconnect(), Math.min(timeoutMs, 1_000));
      throw timeoutError;
    }
    api = createdApi;
    const hash = await api.rpc.chain.getFinalizedHead();
    const header = await api.rpc.chain.getHeader(hash);
    return header.number.toNumber();
  })();
  // The operation may reject after the deadline wins and cleanup disconnects
  // its transport. Observe that late rejection immediately.
  void chainRead.catch(() => undefined);
  try {
    const finalizedBlock = await Promise.race<number>([
      chainRead,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(timeoutError), timeoutMs);
      }),
    ]);
    return { finalizedBlock, error: null };
  } catch (error) {
    return { finalizedBlock: null, error: error instanceof Error ? error.message : String(error) };
  } finally {
    finished = true;
    if (timer) clearTimeout(timer);
    // These variables are assigned inside `chainRead`; TypeScript does not
    // propagate closure assignments into the outer control-flow graph.
    const connectedApi = api as PolkadotApi | null;
    const connectedProvider = provider as PolkadotWsProvider | null;
    const cleanup = Promise.allSettled([
      connectedApi?.disconnect() ?? Promise.resolve(),
      connectedProvider?.disconnect() ?? Promise.resolve(),
    ]);
    await settleWithin(cleanup, Math.min(timeoutMs, 1_000));
  }
};

export const runRocksAudit = async (): Promise<void> => {
  const config = readConfig();
  await assertExistingRocksdbDirectory(config.rocksdbPath);
  const skipChain = readStrictBoolean(process.env, 'ROCKSDB_AUDIT_SKIP_CHAIN', false);
  const chain = await readFinalizedBlock(
    config.soraWsEndpoint,
    readRocksAuditChainTimeoutMs(process.env),
    skipChain
  );
  const repository = new RocksRepository({ ...config, storageEngine: 'rocksdb' });
  try {
    await repository.prepare();
    repository.inspectCurrentSnapshot((db) => assertCurrentRocksdbArtifactSource(db, config.rocksdbPath));
    await repository.validateCompactIndexes();
    const report = repository.inspectCurrentSnapshot((db) =>
      buildRocksAuditReport(db, {
        sampleSize: readPositiveSafeInteger(process.env, 'ROCKSDB_AUDIT_SAMPLE_SIZE', 1_000),
        finalizedBlock: chain.finalizedBlock,
        chainReadError: chain.error,
        requireChain: !skipChain,
        fullValidationPassed: true,
        maxLagBlocks: readNonNegativeSafeInteger(process.env, 'ROCKSDB_AUDIT_MAX_LAG_BLOCKS', 100),
        maxStateAgeSeconds: readNonNegativeSafeInteger(process.env, 'ROCKSDB_AUDIT_MAX_STATE_AGE_SECONDS', 600),
      })
    );
    console.info(JSON.stringify({ path: config.rocksdbPath, ...report }, null, 2));
    if (!report.releaseGate.healthy) {
      throw new Error('RocksDB audit release gate failed; inspect releaseGate and integrity details above');
    }
  } finally {
    await repository.close().catch(() => undefined);
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runRocksAudit().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
