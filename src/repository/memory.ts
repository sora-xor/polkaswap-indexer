import { isAfterOrderPosition, matchesFilter, sortDocuments } from '../graphql/filter.js';
import { getOrderField, NUMERIC_ORDER_FIELDS } from '../graphql/order.js';
import { EventEmitter } from 'node:events';
import { estimateRetainedValueBytes } from '../cache-weight.js';

import {
  createRepositoryCursorScope,
  encodeRepositoryCursor,
  normalizeRepositoryCursorValue,
} from './cursor.js';
import {
  assertValidDocumentId,
  assertValidIndexerCollection,
  assertValidRepositoryQueryPositions,
  normalizeIndexerDocument,
  normalizeIndexerDocumentWriteCall,
} from './validation.js';

import type {
  IndexerCollection,
  IndexerDocument,
  IndexerRepository,
  RepositoryQueryArgs,
  RepositoryQueryResult,
  RepositoryWatchEvent,
} from './types.js';

const documentFieldValue = (document: IndexerDocument, field: NonNullable<RepositoryQueryArgs['seek']>['field']): number => {
  const value = field === 'timestamp' ? document.timestamp : document.blockHeight;
  const fallback = field === 'timestamp' ? document.data.timestamp : document.data.blockHeight;
  const parsed = Number(value ?? fallback ?? 0);

  return Number.isFinite(parsed) ? parsed : 0;
};

const isAfterSeek = (document: IndexerDocument, seek: NonNullable<RepositoryQueryArgs['seek']>): boolean => {
  const value = documentFieldValue(document, seek.field);
  const direction = seek.direction ?? 'asc';

  if (value === seek.value) {
    return direction === 'desc' ? document.id < seek.id : document.id > seek.id;
  }

  return direction === 'desc' ? value < seek.value : value > seek.value;
};

const cloneDocument = (document: IndexerDocument): IndexerDocument => structuredClone(document);

const queryableDocument = (document: IndexerDocument): Record<string, unknown> => ({
  ...document.data,
  id: document.id,
  timestamp: document.timestamp ?? document.data.timestamp,
  blockHeight: document.blockHeight ?? document.data.blockHeight,
});

const isStaleDocument = (current: IndexerDocument | undefined, incoming: IndexerDocument): boolean => {
  if (!current) return false;

  const currentHeight = current.blockHeight ?? null;
  const incomingHeight = incoming.blockHeight ?? null;
  return currentHeight !== null && (incomingHeight === null || incomingHeight < currentHeight);
};

/**
 * In-memory repository used by tests and by local experiments that do not need
 * persistence.
 */
export class MemoryRepository implements IndexerRepository {
  private readonly documents = new Map<IndexerCollection, Map<string, IndexerDocument>>();
  private readonly events = new EventEmitter();

  async list(collection: IndexerCollection): Promise<IndexerDocument[]> {
    assertValidIndexerCollection(collection);
    return [...(this.documents.get(collection)?.values() ?? [])].map(cloneDocument);
  }

  async query(collection: IndexerCollection, args: RepositoryQueryArgs): Promise<RepositoryQueryResult> {
    assertValidIndexerCollection(collection);
    assertValidRepositoryQueryPositions(args);
    const documents = [...(this.documents.get(collection)?.values() ?? [])];
    const sorted = sortDocuments(
      documents
        .map((document) => ({
          ...document.data,
          id: document.id,
          timestamp: document.timestamp ?? document.data.timestamp,
          blockHeight: document.blockHeight ?? document.data.blockHeight,
          __document: document,
        }))
        .filter((document) => matchesFilter(document, args.filter)),
      args.orderBy
    ).map((document) => document.__document as IndexerDocument);
    const seek = args.seek;
    const filtered = seek ? sorted.filter((document) => isAfterSeek(document, seek)) : sorted;
    const totalCount = filtered.length;
    const keyset = args.offset === null || args.offset === undefined ? args.keyset ?? null : null;
    const { field, direction } = getOrderField(args.orderBy);
    const numeric = NUMERIC_ORDER_FIELDS.has(field);
    const scope = createRepositoryCursorScope(collection, args.orderBy, args.filter);
    if (
      keyset &&
      (keyset.scope !== scope ||
        keyset.field !== field ||
        keyset.direction !== direction ||
        keyset.numeric !== numeric)
    ) {
      throw new Error('Pagination cursor does not match the requested connection or order');
    }
    const remaining = keyset
      ? filtered.filter((document) => isAfterOrderPosition(queryableDocument(document), keyset))
      : filtered;
    const after = args.after === null || args.after === undefined || args.after === '' ? 0 : Number(args.after) + 1;
    const offset = keyset ? 0 : Number(args.offset ?? after);
    const start = Number.isFinite(offset) ? Math.max(offset, 0) : 0;
    const first = args.first ?? null;
    const last = args.last ?? null;
    const end =
      first === null || first === undefined ? remaining.length : Math.min(start + Math.max(first, 0), remaining.length);
    const pageStart = last === null || last === undefined ? start : Math.max(end - Math.max(last, 0), start);
    const candidateItems = remaining.slice(pageStart, end);
    const maxBytes = args.maxBytes ?? null;
    let retainedBytes = 0;
    let byteLimitReached = false;
    const retainedItems: IndexerDocument[] = [];
    for (const document of candidateItems) {
      if (maxBytes === null) {
        retainedItems.push(document);
        continue;
      }
      const remainingBytes = Math.max(maxBytes - retainedBytes, 0);
      const documentBytes = estimateRetainedValueBytes(document, remainingBytes);
      if (retainedItems.length > 0 && documentBytes > remainingBytes) {
        byteLimitReached = true;
        break;
      }
      retainedItems.push(document);
      retainedBytes = Math.min(maxBytes + 1, retainedBytes + documentBytes);
    }
    const items = retainedItems.map(cloneDocument);
    const itemCursors = items.map((document) => {
      const value =
        field === 'id'
          ? document.id
          : field === 'timestamp'
            ? document.timestamp ?? document.data.timestamp
            : field === 'blockHeight'
              ? document.blockHeight ?? document.data.blockHeight
              : document.data[field];
      return encodeRepositoryCursor({
        scope,
        field,
        direction,
        numeric,
        value: normalizeRepositoryCursorValue(value, numeric),
        id: document.id,
      });
    });

    return {
      items,
      itemCursors,
      totalCount: args.includeTotalCount === false ? null : totalCount,
      pageStart,
      hasNextPage: byteLimitReached || end < remaining.length,
      hasPreviousPage: keyset !== null || pageStart > 0,
    };
  }

  async get(collection: IndexerCollection, id: string): Promise<IndexerDocument | null> {
    assertValidIndexerCollection(collection);
    assertValidDocumentId(id);
    const document = this.documents.get(collection)?.get(id);
    return document ? cloneDocument(document) : null;
  }

  async getMany(collection: IndexerCollection, ids: string[]): Promise<Map<string, IndexerDocument>> {
    assertValidIndexerCollection(collection);
    for (const id of ids) assertValidDocumentId(id);
    const documents = this.documents.get(collection);
    const result = new Map<string, IndexerDocument>();

    for (const id of ids) {
      const document = documents?.get(id);
      if (document) result.set(id, cloneDocument(document));
    }

    return result;
  }

  async upsert(document: IndexerDocument): Promise<void> {
    const normalized = normalizeIndexerDocument(document);
    const collection = this.documents.get(normalized.collection) ?? new Map<string, IndexerDocument>();
    const previous = collection.get(normalized.id);
    if (isStaleDocument(previous, normalized)) return;

    const stored = cloneDocument(normalized);
    collection.set(normalized.id, stored);
    this.documents.set(normalized.collection, collection);
    this.events.emit('document', {
      collection: stored.collection,
      id: stored.id,
      mutationType: previous ? 'UPDATE' : 'INSERT',
    } satisfies RepositoryWatchEvent);
  }

  async upsertMany(documents: IndexerDocument[]): Promise<void> {
    const normalized = normalizeIndexerDocumentWriteCall(documents);
    for (const document of normalized) {
      await this.upsert(document);
    }
  }

  async deleteMany(collection: IndexerCollection, ids: string[]): Promise<void> {
    assertValidIndexerCollection(collection);
    for (const id of ids) assertValidDocumentId(id);
    const documents = this.documents.get(collection);
    if (!documents) return;

    for (const id of ids) {
      if (documents.delete(id)) {
        this.events.emit('document', { collection, id, mutationType: 'DELETE' } satisfies RepositoryWatchEvent);
      }
    }
  }

  async close(): Promise<void> {
    this.documents.clear();
    this.events.removeAllListeners();
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async *watch(
    collection: IndexerCollection,
    ids: string[] = [],
    signal?: AbortSignal
  ): AsyncGenerator<RepositoryWatchEvent, void, unknown> {
    assertValidIndexerCollection(collection);
    for (const id of ids) assertValidDocumentId(id);
    if (signal?.aborted) return;
    const queue = new Map<string, RepositoryWatchEvent>();
    let notify: (() => void) | null = null;
    const filter = (event: RepositoryWatchEvent): boolean =>
      event.collection === collection && (!ids.length || ids.includes(event.id));
    const listener = (event: RepositoryWatchEvent) => {
      if (!filter(event)) return;

      queue.delete(event.id);
      queue.set(event.id, event);
      notify?.();
      notify = null;
    };

    this.events.on('document', listener);
    const abort = () => {
      notify?.();
      notify = null;
    };
    signal?.addEventListener('abort', abort, { once: true });

    try {
      while (!signal?.aborted) {
        if (!queue.size) {
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
        }

        if (signal?.aborted) break;

        const id = queue.keys().next().value as string | undefined;
        if (id !== undefined) {
          const event = queue.get(id);
          queue.delete(id);
          if (event) yield event;
        }
      }
    } finally {
      signal?.removeEventListener('abort', abort);
      this.events.off('document', listener);
    }
  }
}
