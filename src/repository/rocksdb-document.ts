import type { IndexerCollection, IndexerDocument } from './types.js';
import { normalizeIndexerDocument } from './validation.js';

const CURRENT_DOCUMENT_VERSION = 2;
const RESTORE_DATA_ID = 1 << 0;
const RESTORE_DATA_TIMESTAMP = 1 << 1;
const RESTORE_DATA_BLOCK_HEIGHT = 1 << 2;

type CompactDocument = readonly [
  version: typeof CURRENT_DOCUMENT_VERSION,
  blockHeight: number | null | undefined,
  timestamp: number | null | undefined,
  restoreFlags: number,
  data: Record<string, unknown>,
];

const isOptionalPosition = (value: unknown): value is number | null | undefined =>
  value === null || value === undefined || (Number.isSafeInteger(value) && (value as number) >= 0);

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isCurrentDocument = (value: unknown): value is CompactDocument =>
  Array.isArray(value) &&
  value.length === 5 &&
  value[0] === CURRENT_DOCUMENT_VERSION &&
  isOptionalPosition(value[1]) &&
  isOptionalPosition(value[2]) &&
  Number.isSafeInteger(value[3]) &&
  value[3] >= 0 &&
  value[3] <= (RESTORE_DATA_ID | RESTORE_DATA_TIMESTAMP | RESTORE_DATA_BLOCK_HEIGHT) &&
  isPlainRecord(value[4]);

/**
 * Removes fields already encoded in the primary key or document header. A bit
 * mask records exactly which data fields existed so decoding preserves the
 * repository contract, including documents that intentionally omit them.
 */
export const encodeRocksDocument = (document: IndexerDocument): CompactDocument => {
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

  return [CURRENT_DOCUMENT_VERSION, document.blockHeight, document.timestamp, restoreFlags, data];
};

export const decodeRocksDocument = (
  collection: IndexerCollection,
  id: string,
  stored: unknown
): IndexerDocument | null => {
  if (stored === undefined) return null;
  if (!isCurrentDocument(stored)) {
    throw new Error(`Unsupported or corrupt RocksDB document envelope for ${collection}/${id}`);
  }

  const [, blockHeight, timestamp, restoreFlags, compactData] = stored;
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
