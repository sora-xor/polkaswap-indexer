import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';

import type { IndexerCollection, IndexerDocument } from './types.js';
import { MAX_DOCUMENT_DATA_JSON_BYTES, normalizeIndexerDocument } from './validation.js';

const CURRENT_DOCUMENT_VERSION = 2;
const COMPRESSED_DOCUMENT_VERSION = 3;
const COMPRESSION_CODEC = 'brotli-json-v1';
const COMPRESSION_MIN_BYTES = 1_024;
const RESTORE_DATA_ID = 1 << 0;
const RESTORE_DATA_TIMESTAMP = 1 << 1;
const RESTORE_DATA_BLOCK_HEIGHT = 1 << 2;

export type RocksDocumentCompression = 'none' | 'brotli';
type Position = number | null | undefined;
type CompactDocument = readonly [version: 2, blockHeight: Position, timestamp: Position,
  restoreFlags: number, data: Record<string, unknown>];
type CompressedDocument = readonly [version: 3, blockHeight: Position, timestamp: Position,
  restoreFlags: number, codec: typeof COMPRESSION_CODEC, jsonBytes: number, compressed: Buffer];
type StoredDocument = CompactDocument | CompressedDocument;

const isOptionalPosition = (value: unknown): value is Position =>
  value === null || value === undefined || (Number.isSafeInteger(value) && (value as number) >= 0);

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** Format 3 explicitly permits ordinary v2 values as well as bounded compressed values. */
const isCurrentDocument = (value: unknown, formatVersion = 2): value is StoredDocument => {
  if ((formatVersion !== 2 && formatVersion !== 3) || !Array.isArray(value) ||
      !isOptionalPosition(value[1]) || !isOptionalPosition(value[2]) ||
      !Number.isSafeInteger(value[3]) || value[3] < 0 ||
      value[3] > (RESTORE_DATA_ID | RESTORE_DATA_TIMESTAMP | RESTORE_DATA_BLOCK_HEIGHT)) return false;
  if (value[0] === CURRENT_DOCUMENT_VERSION) return value.length === 5 && isPlainRecord(value[4]);
  return formatVersion === 3 && value[0] === COMPRESSED_DOCUMENT_VERSION && value.length === 7 &&
    value[4] === COMPRESSION_CODEC && Number.isSafeInteger(value[5]) && value[5] >= 2 &&
    value[5] <= MAX_DOCUMENT_DATA_JSON_BYTES && Buffer.isBuffer(value[6]) &&
    value[6].length > 0 && value[6].length <= MAX_DOCUMENT_DATA_JSON_BYTES;
};

/**
 * Removes fields duplicated by the key/header, retaining exactly which data
 * fields existed. Compression is opt-in and only covers normalized data; native
 * header slots retain their existing undefined/null distinction.
 */
export const encodeRocksDocument = (
  input: IndexerDocument,
  compression: RocksDocumentCompression = 'none'
): StoredDocument => {
  if (compression !== 'none' && compression !== 'brotli') throw new Error('Unsupported RocksDB document compression');
  const document = compression === 'brotli' ? normalizeIndexerDocument(input) : input;
  let restoreFlags = 0;
  let data = document.data;
  const compactData = (): Record<string, unknown> => {
    if (data === document.data) data = { ...document.data };
    return data;
  };

  if (document.data.id === document.id) {
    delete compactData().id;
    restoreFlags |= RESTORE_DATA_ID;
  }
  if (document.timestamp !== undefined && document.data.timestamp === document.timestamp) {
    delete compactData().timestamp;
    restoreFlags |= RESTORE_DATA_TIMESTAMP;
  }
  if (document.blockHeight !== undefined && document.data.blockHeight === document.blockHeight) {
    delete compactData().blockHeight;
    restoreFlags |= RESTORE_DATA_BLOCK_HEIGHT;
  }

  if (compression === 'brotli') {
    const json = Buffer.from(JSON.stringify(data));
    if (json.length >= COMPRESSION_MIN_BYTES) {
      const compressed = brotliCompressSync(json, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } });
      // Include the added envelope fields when deciding whether compression helps.
      if (compressed.length + 64 < json.length) {
        return [COMPRESSED_DOCUMENT_VERSION, document.blockHeight, document.timestamp, restoreFlags,
          COMPRESSION_CODEC, json.length, compressed];
      }
    }
  }
  return [CURRENT_DOCUMENT_VERSION, document.blockHeight, document.timestamp, restoreFlags, data];
};

/** Decodes one bounded, canonical JSON payload without accepting trailing Brotli bytes. */
const decompressData = (stored: CompressedDocument): Record<string, unknown> => {
  // Node returns { buffer, engine } for info:true; @types/node still declares Buffer.
  const result = brotliDecompressSync(stored[6], { maxOutputLength: stored[5], info: true }) as unknown as {
    buffer: Buffer; engine: { bytesWritten: number };
  };
  if (result.buffer.length !== stored[5] || result.engine.bytesWritten !== stored[6].length) {
    throw new Error('Compressed RocksDB document byte length mismatch');
  }
  const data: unknown = JSON.parse(result.buffer.toString('utf8'));
  // This also rejects duplicate keys, invalid UTF-8, alternate number spellings,
  // whitespace and other byte sequences the encoder can never produce.
  if (!isPlainRecord(data) || !Buffer.from(JSON.stringify(data)).equals(result.buffer)) {
    throw new Error('Noncanonical compressed RocksDB document JSON');
  }
  return data;
};

/** A format-2 caller cannot accidentally admit a compressed format-3 envelope. */
export const decodeRocksDocument = (
  collection: IndexerCollection,
  id: string,
  stored: unknown,
  formatVersion = 2
): IndexerDocument | null => {
  if (stored === undefined) return null;
  if (!isCurrentDocument(stored, formatVersion)) {
    throw new Error(`Unsupported or corrupt RocksDB document envelope for ${collection}/${id}`);
  }

  const [, blockHeight, timestamp, restoreFlags] = stored;
  let compactData: Record<string, unknown>;
  try {
    compactData = stored[0] === CURRENT_DOCUMENT_VERSION ? stored[4] : decompressData(stored);
  } catch (cause) {
    throw new Error(`Unsupported or corrupt compressed RocksDB document for ${collection}/${id}`, { cause });
  }
  if (
    ((restoreFlags & RESTORE_DATA_ID) !== 0 && Object.hasOwn(compactData, 'id')) ||
    ((restoreFlags & RESTORE_DATA_TIMESTAMP) !== 0 && Object.hasOwn(compactData, 'timestamp')) ||
    ((restoreFlags & RESTORE_DATA_BLOCK_HEIGHT) !== 0 && Object.hasOwn(compactData, 'blockHeight'))
  ) {
    throw new Error(`Corrupt RocksDB document restore flags for ${collection}/${id}`);
  }
  const data = restoreFlags === 0 ? compactData : { ...compactData };

  if (restoreFlags & RESTORE_DATA_ID) data.id = id;
  if (restoreFlags & RESTORE_DATA_TIMESTAMP) data.timestamp = timestamp;
  if (restoreFlags & RESTORE_DATA_BLOCK_HEIGHT) data.blockHeight = blockHeight;

  return normalizeIndexerDocument({ collection, id, blockHeight, timestamp, data });
};

export const isCurrentRocksDocument = isCurrentDocument;
