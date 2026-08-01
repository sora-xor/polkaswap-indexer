import { INDEXER_COLLECTIONS } from './types.js';
import { parseExactJsonObject } from './json-numeric.js';
import { normalizeIndexerDocument } from './validation.js';

import type { IndexerCollection, IndexerDocument } from './types.js';

export type PostgresDocumentRow = {
  collection: unknown;
  id: unknown;
  blockHeight?: unknown;
  timestamp?: unknown;
  data: unknown;
};

export type PostgresDocumentTextRow = Omit<PostgresDocumentRow, 'data'> & {
  dataText: unknown;
};

const safeNullableInteger = (value: unknown, field: string): number | null => {
  if (value === null || value === undefined) return null;
  if (
    (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') ||
    (typeof value === 'string' && !/^(?:0|[1-9][0-9]*)$/.test(value))
  ) {
    throw new Error(`Postgres document ${field} must be a canonical non-negative safe integer or null`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Postgres document ${field} must be a canonical non-negative safe integer or null`);
  }
  return parsed;
};

/** Normalizes pg int8 strings and rejects rows outside the repository contract. */
export const decodePostgresDocument = (row: PostgresDocumentRow): IndexerDocument => {
  if (typeof row.collection !== 'string' || !INDEXER_COLLECTIONS.includes(row.collection as IndexerCollection)) {
    throw new Error(`Postgres document has an unknown collection: ${String(row.collection)}`);
  }
  if (typeof row.id !== 'string' || row.id.length === 0) {
    throw new Error('Postgres document id must be a non-empty string');
  }
  if (row.data === null || typeof row.data !== 'object' || Array.isArray(row.data)) {
    throw new Error(`Postgres document ${row.collection}/${row.id} data must be a JSON object`);
  }

  const document: IndexerDocument = {
    collection: row.collection as IndexerCollection,
    id: row.id,
    data: row.data as Record<string, unknown>,
  };
  if (Object.prototype.hasOwnProperty.call(row, 'blockHeight')) {
    document.blockHeight = safeNullableInteger(row.blockHeight, 'block_height');
  }
  if (Object.prototype.hasOwnProperty.call(row, 'timestamp')) {
    document.timestamp = safeNullableInteger(row.timestamp, 'timestamp');
  }
  return normalizeIndexerDocument(document);
};

/**
 * Decodes raw jsonb::text only after proving that PostgreSQL numeric precision
 * cannot be lost by JSON.parse.
 */
export const decodePostgresDocumentText = (row: PostgresDocumentTextRow): IndexerDocument => {
  if (typeof row.dataText !== 'string') {
    throw new Error(`Postgres document ${String(row.collection)}/${String(row.id)} data must be raw JSON text`);
  }
  const data = parseExactJsonObject(
    row.dataText,
    `Postgres document ${String(row.collection)}/${String(row.id)} data`
  );
  return decodePostgresDocument({ ...row, data });
};
