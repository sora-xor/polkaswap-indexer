import { INDEXER_COLLECTIONS } from './types.js';

import type { IndexerCollection, IndexerDocument, RepositoryQueryArgs } from './types.js';

export const MAX_DOCUMENT_ID_LENGTH = 1_024;
export const MAX_DOCUMENT_DATA_DEPTH = 32;
export const MAX_DOCUMENT_DATA_NODES = 100_000;
// SORA's legal operational block size can hex-encode one bytes argument to
// roughly 14.7 MB. Keep the persisted domain above that chain-level maximum.
export const MAX_DOCUMENT_DATA_STRING_LENGTH = 16 * 1_024 * 1_024;
export const MAX_DOCUMENT_DATA_KEY_LENGTH = 1_024;
export const MAX_DOCUMENT_DATA_JSON_BYTES = 32 * 1_024 * 1_024;
// One maximum-sized document plus its persisted envelope must always fit.
export const MAX_REPOSITORY_WRITE_BATCH_JSON_BYTES = 64 * 1_024 * 1_024;
export const MAX_REPOSITORY_WRITE_BATCH_DOCUMENTS = 1_000;
export const MAX_REPOSITORY_WRITE_CALL_JSON_BYTES = 256 * 1_024 * 1_024;
export const MAX_REPOSITORY_WRITE_CALL_DOCUMENTS = 10_000;
export const MAX_INDEXED_DECIMAL_TEXT_LENGTH = 256;
export const MAX_INDEXED_DECIMAL_INTEGER_DIGITS = 256;
export const MAX_INDEXED_EQUALITY_VALUE_BYTES = 256;
export const NATIVE_POSITION_FIELDS = new Set(['timestamp', 'blockHeight']);

/** Scalar decimals exposed to repository numeric casts for each collection. */
export const QUERYABLE_DECIMAL_FIELDS_BY_COLLECTION: Partial<
  Record<IndexerCollection, readonly string[]>
> = {
  accountPositions: ['marketId'],
  assets: [
    'liquidity', 'liquidityBooks', 'liquidityUSD', 'priceUSD', 'priceChangeDay',
    'priceChangeWeek', 'volumeDayUSD', 'volumeWeekUSD',
  ],
  markets: ['marketId', 'updatedAtBlock', 'liquidityUSD', 'volumeUSD'],
  marketSnapshots: ['marketId'],
  networkSnapshots: ['liquidityUSD'],
  orderBooks: ['updatedAtBlock', 'priceChangeDay', 'liquidityUSD', 'volumeDayUSD', 'baseAssetReserves'],
  orderBookOrders: ['updatedAtBlock', 'createdAtBlock', 'amount'],
  poolXYKs: [
    'liquidityUSD', 'priceUSD', 'poolTokenPriceUSD', 'baseAssetReserves',
    'targetAssetReserves', 'strategicBonusApy',
  ],
  referrerRewards: ['amount'],
  stakingValidators: ['apy', 'commission', 'rewardPoints'],
  vaults: ['createdAtBlock', 'updatedAtBlock'],
  xorBurns: ['amount'],
};

const INDEXER_COLLECTION_SET = new Set<unknown>(INDEXER_COLLECTIONS);
const FORBIDDEN_DATA_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export const INDEXED_EQUALITY_DATA_FIELDS = new Set([
  'accountLiquidityId',
  'account',
  'accountId',
  'assetId',
  'type',
  'address',
  'dataFrom',
  'dataTo',
  'module',
  'method',
  'marketId',
  'orderBookId',
  'baseAssetId',
  'quoteAssetId',
  'poolId',
  'targetAssetId',
  'referrer',
  'ownerId',
  'vaultId',
]);

export const assertValidIndexerCollection: (collection: unknown) => asserts collection is IndexerCollection = (
  collection
) => {
  if (!INDEXER_COLLECTION_SET.has(collection)) {
    throw new Error(`Invalid indexer document collection: ${String(collection)}`);
  }
};

/** IDs are persisted in keys and cursors, so one canonical domain is required across engines. */
export const assertValidDocumentId: (id: unknown) => asserts id is string = (id) => {
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    id.length > MAX_DOCUMENT_ID_LENGTH ||
    !/^[\x21-\x7e]+$/.test(id)
  ) {
    throw new Error(
      `Invalid indexer document id: expected 1-${MAX_DOCUMENT_ID_LENGTH} printable ASCII characters without spaces`
    );
  }
};

/** Native envelope positions have one exact, cross-engine query domain. */
export const assertValidNativePositionQueryValue = (
  field: 'timestamp' | 'blockHeight',
  value: unknown
): void => {
  const validNumber = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  const validString =
    typeof value === 'string' &&
    /^[0-9]+$/.test(value) &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) >= 0;
  if (!validNumber && !validString) {
    throw new Error(`Invalid native position ${field}: expected a non-negative safe integer`);
  }
};

const isQueryRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const assertValidNativePositionCondition = (
  field: 'timestamp' | 'blockHeight',
  condition: unknown
): void => {
  if (condition === null || condition === undefined || condition === 'null') return;
  if (!isQueryRecord(condition)) {
    assertValidNativePositionQueryValue(field, condition);
    return;
  }

  for (const [operator, expected] of Object.entries(condition)) {
    if (expected === null || expected === undefined || expected === 'null') continue;
    if (operator === 'in' || operator === 'notIn' || operator === 'not_in') {
      if (!Array.isArray(expected)) {
        throw new Error(`Invalid native position ${field}: expected a bounded integer array`);
      }
      for (const value of expected) {
        if (value !== null && value !== undefined && value !== 'null') {
          assertValidNativePositionQueryValue(field, value);
        }
      }
      continue;
    }
    assertValidNativePositionQueryValue(field, expected);
  }
};

/** Validates trusted repository filters and positions before any engine work. */
export const assertValidRepositoryQueryPositions = (args: RepositoryQueryArgs): void => {
  if (
    args.maxBytes !== null &&
    args.maxBytes !== undefined &&
    (!Number.isSafeInteger(args.maxBytes) || args.maxBytes <= 0)
  ) {
    throw new Error('Invalid repository query byte budget: expected a positive safe integer');
  }
  const visit = (filter: RepositoryQueryArgs['filter']): void => {
    if (!filter || !isQueryRecord(filter)) return;
    for (const [field, condition] of Object.entries(filter)) {
      if (field === 'and' || field === 'or') {
        if (Array.isArray(condition)) {
          for (const nested of condition) visit(nested as RepositoryQueryArgs['filter']);
        }
        continue;
      }
      if (field === 'timestamp' || field === 'blockHeight') {
        assertValidNativePositionCondition(field, condition);
      }
    }
  };
  visit(args.filter);

  if (args.seek) {
    if (args.seek.field !== 'timestamp' && args.seek.field !== 'blockHeight') {
      throw new Error(`Invalid repository seek field: ${String(args.seek.field)}`);
    }
    assertValidNativePositionQueryValue(args.seek.field, args.seek.value);
    assertValidDocumentId(args.seek.id);
  }

  const keyset = args.offset === null || args.offset === undefined ? args.keyset ?? null : null;
  if (
    keyset?.value !== null &&
    (keyset?.field === 'timestamp' || keyset?.field === 'blockHeight')
  ) {
    assertValidNativePositionQueryValue(keyset.field, keyset.value);
  }
};

const assertValidDocumentPosition = (name: 'blockHeight' | 'timestamp', value: unknown): void => {
  if (value === null || value === undefined) return;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(
      `Invalid indexer document ${name}: expected a non-negative safe integer, null, or undefined`
    );
  }
};

const PLAIN_DECIMAL_PATTERN = /^-?\d+(?:\.\d+)?$/;

/** Decimal domain shared by RocksDB keys and PostgreSQL NUMERIC expressions. */
export const assertValidIndexedDecimal = (value: unknown, field = 'numeric field'): void => {
  if (value === null || value === undefined) return;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`Invalid indexed decimal ${field}: expected a plain decimal string or finite number`);
  }
  const text = String(value);
  if (
    text.length === 0 ||
    text.length > MAX_INDEXED_DECIMAL_TEXT_LENGTH ||
    !PLAIN_DECIMAL_PATTERN.test(text)
  ) {
    throw new Error(
      `Invalid indexed decimal ${field}: expected at most ${MAX_INDEXED_DECIMAL_TEXT_LENGTH} plain decimal characters`
    );
  }
  const unsigned = text.startsWith('-') ? text.slice(1) : text;
  const integerDigits = (unsigned.split('.')[0] ?? '').replace(/^0+/, '').length || 1;
  if (integerDigits > MAX_INDEXED_DECIMAL_INTEGER_DIGITS) {
    throw new Error(
      `Invalid indexed decimal ${field}: integer precision exceeds ${MAX_INDEXED_DECIMAL_INTEGER_DIGITS} digits`
    );
  }
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

type JsonValidationBudget = {
  nodes: number;
  active: WeakSet<object>;
};

const invalidData = (detail: string): never => {
  throw new Error(`Invalid indexer document data: ${detail}`);
};

const validateJsonValue = (
  value: unknown,
  path: string,
  depth: number,
  budget: JsonValidationBudget
): void => {
  budget.nodes += 1;
  if (budget.nodes > MAX_DOCUMENT_DATA_NODES) {
    invalidData(`exceeds ${MAX_DOCUMENT_DATA_NODES} JSON nodes`);
  }
  if (depth > MAX_DOCUMENT_DATA_DEPTH) {
    invalidData(`exceeds maximum JSON depth ${MAX_DOCUMENT_DATA_DEPTH}`);
  }

  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (value.length > MAX_DOCUMENT_DATA_STRING_LENGTH) {
      invalidData(`${path} exceeds maximum string length ${MAX_DOCUMENT_DATA_STRING_LENGTH}`);
    }
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalidData(`${path} must be a finite JSON number`);
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      invalidData(`${path} must not contain an integer outside the JavaScript safe range`);
    }
    return;
  }
  if (typeof value !== 'object') {
    return invalidData(`${path} contains non-JSON ${typeof value}`);
  }
  const objectValue: object = value;
  if (budget.active.has(objectValue)) invalidData(`${path} contains a cycle`);
  budget.active.add(objectValue);

  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_DOCUMENT_DATA_NODES) {
        invalidData(`${path} exceeds maximum array length ${MAX_DOCUMENT_DATA_NODES}`);
      }
      const ownKeys = Reflect.ownKeys(value);
      if (
        ownKeys.some(
          (key) =>
            typeof key !== 'string' ||
            (key !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))
        )
      ) {
        invalidData(`${path} array contains non-index properties`);
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) invalidData(`${path} must not contain sparse array entries`);
        validateJsonValue(value[index], `${path}[${index}]`, depth + 1, budget);
      }
      return;
    }

    if (!isPlainObject(value)) return invalidData(`${path} must contain only plain objects and arrays`);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return invalidData(`${path} must not contain symbol keys`);
      const stringKey = key;
      if (FORBIDDEN_DATA_KEYS.has(stringKey)) invalidData(`${path} contains forbidden key ${stringKey}`);
      if (stringKey.length > MAX_DOCUMENT_DATA_KEY_LENGTH) {
        invalidData(`${path} contains an oversized key`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, stringKey);
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        return invalidData(`${path}.${stringKey} must be an enumerable data property`);
      }
      validateJsonValue(descriptor.value, `${path}.${stringKey}`, depth + 1, budget);
    }
  } finally {
    budget.active.delete(objectValue);
  }
};

const canonicalPosition = (
  name: 'blockHeight' | 'timestamp',
  envelopeValue: unknown,
  data: Record<string, unknown>
): number | null | undefined => {
  const dataHasValue = Object.hasOwn(data, name);
  const dataValue = dataHasValue ? data[name] : undefined;
  assertValidDocumentPosition(name, envelopeValue);
  if (dataHasValue) assertValidDocumentPosition(name, dataValue);

  if (envelopeValue !== null && envelopeValue !== undefined) {
    if (dataHasValue && dataValue !== envelopeValue) {
      throw new Error(`Invalid indexer document data: data.${name} conflicts with the canonical ${name}`);
    }
    return Object.is(envelopeValue, -0) ? 0 : envelopeValue as number;
  }
  const canonical = dataHasValue ? dataValue : envelopeValue;
  return Object.is(canonical, -0) ? 0 : canonical as number | null | undefined;
};

const validateIndexerDocument = (document: unknown): { document: IndexerDocument; dataJson: string } => {
  if (!isPlainObject(document)) {
    throw new Error('Invalid indexer document: expected a plain object');
  }

  assertValidIndexerCollection(document.collection);
  assertValidDocumentId(document.id);
  if (!isPlainObject(document.data)) {
    throw new Error('Invalid indexer document data: expected a plain object');
  }
  validateJsonValue(document.data, 'data', 0, { nodes: 0, active: new WeakSet() });
  if (Object.hasOwn(document.data, 'id') && document.data.id !== document.id) {
    throw new Error('Invalid indexer document data: data.id conflicts with the canonical id');
  }
  const blockHeight = canonicalPosition('blockHeight', document.blockHeight, document.data);
  const timestamp = canonicalPosition('timestamp', document.timestamp, document.data);
  const indexedDecimalFields = new Set(QUERYABLE_DECIMAL_FIELDS_BY_COLLECTION[document.collection] ?? []);
  for (const [field, value] of Object.entries(document.data)) {
    if (indexedDecimalFields.has(field)) assertValidIndexedDecimal(value, `data.${field}`);
    if (INDEXED_EQUALITY_DATA_FIELDS.has(field) && value !== null && value !== undefined) {
      if (field === 'marketId') {
        assertValidIndexedDecimal(value, 'data.marketId');
      } else if (typeof value !== 'string') {
        throw new Error(`Invalid indexer document data: data.${field} must be a string when present`);
      }
      if (Buffer.byteLength(String(value), 'utf8') > MAX_INDEXED_EQUALITY_VALUE_BYTES) {
        throw new Error(
          `Invalid indexer document data: data.${field} exceeds indexed equality value limit ${MAX_INDEXED_EQUALITY_VALUE_BYTES} bytes`
        );
      }
    }
  }
  const payload = document.data.data;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    for (const field of ['to', 'assetId']) {
      const value = (payload as Record<string, unknown>)[field];
      if (value !== null && value !== undefined) {
        if (typeof value !== 'string') {
          throw new Error(`Invalid indexer document data: data.data.${field} must be a string when present`);
        }
        if (Buffer.byteLength(value, 'utf8') > MAX_INDEXED_EQUALITY_VALUE_BYTES) {
          throw new Error(
            `Invalid indexer document data: data.data.${field} exceeds indexed equality value limit ${MAX_INDEXED_EQUALITY_VALUE_BYTES} bytes`
          );
        }
      }
    }
  }

  const dataJson = JSON.stringify(document.data);
  if (typeof dataJson !== 'string') invalidData('could not be encoded as JSON');
  if (Buffer.byteLength(dataJson, 'utf8') > MAX_DOCUMENT_DATA_JSON_BYTES) {
    invalidData(`exceeds maximum encoded size ${MAX_DOCUMENT_DATA_JSON_BYTES} bytes`);
  }
  // Parsing the validated encoding deep-owns the payload and canonicalizes
  // representational edge cases such as nested negative zero across engines.
  const data = JSON.parse(dataJson) as Record<string, unknown>;
  const normalized: IndexerDocument = {
    collection: document.collection,
    id: document.id,
    ...(Object.hasOwn(document, 'blockHeight') || Object.hasOwn(document.data, 'blockHeight') ? { blockHeight } : {}),
    ...(Object.hasOwn(document, 'timestamp') || Object.hasOwn(document.data, 'timestamp') ? { timestamp } : {}),
    data,
  };
  return { document: normalized, dataJson };
};

/** Enforces the persisted-document domain before any repository mutates state. */
export const assertValidIndexerDocument: (document: unknown) => asserts document is IndexerDocument = (document) => {
  validateIndexerDocument(document);
};

/** Returns an owned canonical document without mutating caller input. */
export const normalizeIndexerDocument = (document: unknown): IndexerDocument =>
  validateIndexerDocument(document).document;

export type SerializedIndexerDocument = {
  document: IndexerDocument;
  json: string;
  bytes: number;
};

export type IndexerDocumentJsonBatch = {
  documents: IndexerDocument[];
  json: string;
  bytes: number;
};

export const serializeIndexerDocument = (
  candidate: IndexerDocument,
  encodeData: (document: IndexerDocument) => Record<string, unknown> = (document) => document.data
): SerializedIndexerDocument => {
  const { document, dataJson } = validateIndexerDocument(candidate);
  const encodedData = encodeData(document);
  const encodedDataJson = encodedData === document.data ? dataJson : JSON.stringify(encodedData);
  if (typeof encodedDataJson !== 'string') invalidData('storage codec could not encode data as JSON');
  const json =
    `{"collection":${JSON.stringify(document.collection)},` +
    `"id":${JSON.stringify(document.id)},` +
    `"blockHeight":${JSON.stringify(document.blockHeight ?? null)},` +
    `"timestamp":${JSON.stringify(document.timestamp ?? null)},` +
    `"data":${encodedDataJson}}`;
  return { document, json, bytes: Buffer.byteLength(json, 'utf8') };
};

/** Exact UTF-8 JSON bytes used to bound repository transaction sub-batches. */
export const indexerDocumentJsonBytes = (document: IndexerDocument): number =>
  serializeIndexerDocument(document).bytes;

export const chunkSerializedIndexerDocuments = (
  serialized: readonly SerializedIndexerDocument[],
  {
    maxBytes = MAX_REPOSITORY_WRITE_BATCH_JSON_BYTES,
    maxDocuments = MAX_REPOSITORY_WRITE_BATCH_DOCUMENTS,
  }: { maxBytes?: number; maxDocuments?: number } = {}
): IndexerDocumentJsonBatch[] => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Write batch maxBytes must be positive');
  if (!Number.isSafeInteger(maxDocuments) || maxDocuments <= 0) {
    throw new Error('Write batch maxDocuments must be positive');
  }

  const batches: IndexerDocumentJsonBatch[] = [];
  let batch: SerializedIndexerDocument[] = [];
  // A JSON array contributes two brackets and one comma between documents.
  let batchBytes = 2;
  const flush = (): void => {
    if (!batch.length) return;
    batches.push({
      documents: batch.map(({ document }) => document),
      json: `[${batch.map(({ json }) => json).join(',')}]`,
      bytes: batchBytes,
    });
    batch = [];
    batchBytes = 2;
  };

  for (const item of serialized) {
    if (item.bytes + 2 > maxBytes) {
      throw new Error(`Indexer document ${item.document.collection}/${item.document.id} exceeds write batch byte limit`);
    }
    const nextBytes = batchBytes + (batch.length ? 1 : 0) + item.bytes;
    if (batch.length && (batch.length >= maxDocuments || nextBytes > maxBytes)) flush();
    batch.push(item);
    batchBytes += (batch.length > 1 ? 1 : 0) + item.bytes;
  }
  flush();
  return batches;
};

/**
 * Validates a complete write before any backend mutates state, while retaining
 * no serialized payloads. The call-level cap prevents a caller from turning
 * individually legal documents into an unbounded multi-gigabyte operation.
 */
export const normalizeIndexerDocumentWriteCall = (
  documents: readonly IndexerDocument[]
): IndexerDocument[] => {
  if (documents.length > MAX_REPOSITORY_WRITE_CALL_DOCUMENTS) {
    throw new Error(
      `Repository write contains ${documents.length} documents; maximum is ${MAX_REPOSITORY_WRITE_CALL_DOCUMENTS}`
    );
  }
  const normalized: IndexerDocument[] = [];
  let totalBytes = 2;
  for (const candidate of documents) {
    const item = serializeIndexerDocument(candidate);
    totalBytes += (normalized.length ? 1 : 0) + item.bytes;
    if (totalBytes > MAX_REPOSITORY_WRITE_CALL_JSON_BYTES) {
      throw new Error(`Repository write exceeds ${MAX_REPOSITORY_WRITE_CALL_JSON_BYTES} encoded JSON bytes`);
    }
    normalized.push(item.document);
  }
  return normalized;
};

/** Materializes only one byte-bounded transaction payload at a time. */
export function* iterateIndexerDocumentJsonPayloads(
  documents: readonly IndexerDocument[],
  {
    maxBytes = MAX_REPOSITORY_WRITE_BATCH_JSON_BYTES,
    maxDocuments = MAX_REPOSITORY_WRITE_BATCH_DOCUMENTS,
    encodeData,
  }: {
    maxBytes?: number;
    maxDocuments?: number;
    encodeData?: (document: IndexerDocument) => Record<string, unknown>;
  } = {}
): Generator<IndexerDocumentJsonBatch, void, unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Write batch maxBytes must be positive');
  if (!Number.isSafeInteger(maxDocuments) || maxDocuments <= 0) {
    throw new Error('Write batch maxDocuments must be positive');
  }

  let batch: SerializedIndexerDocument[] = [];
  let batchBytes = 2;
  const flush = (): IndexerDocumentJsonBatch | null => {
    if (!batch.length) return null;
    const ready = {
      documents: batch.map(({ document }) => document),
      json: `[${batch.map(({ json }) => json).join(',')}]`,
      bytes: batchBytes,
    };
    batch = [];
    batchBytes = 2;
    return ready;
  };

  for (const document of documents) {
    const item = serializeIndexerDocument(document, encodeData);
    if (item.bytes + 2 > maxBytes) {
      throw new Error(`Indexer document ${item.document.collection}/${item.document.id} exceeds write batch byte limit`);
    }
    const nextBytes = batchBytes + (batch.length ? 1 : 0) + item.bytes;
    if (batch.length && (batch.length >= maxDocuments || nextBytes > maxBytes)) {
      const ready = flush();
      if (ready) yield ready;
    }
    batch.push(item);
    batchBytes += (batch.length > 1 ? 1 : 0) + item.bytes;
  }
  const ready = flush();
  if (ready) yield ready;
}

export const chunkIndexerDocumentJsonPayloads = (
  documents: readonly IndexerDocument[],
  options: { maxBytes?: number; maxDocuments?: number } = {}
): IndexerDocumentJsonBatch[] => [...iterateIndexerDocumentJsonPayloads(documents, options)];

export const chunkIndexerDocumentsByJsonBytes = (
  documents: readonly IndexerDocument[],
  options: { maxBytes?: number; maxDocuments?: number } = {}
): IndexerDocument[][] => chunkIndexerDocumentJsonPayloads(documents, options).map(({ documents: batch }) => batch);
