import { matchesFilter, sortDocuments } from '../graphql/filter.js';
import { EventEmitter } from 'node:events';

import type {
  IndexerCollection,
  IndexerDocument,
  IndexerRepository,
  RepositoryQueryArgs,
  RepositoryQueryResult,
} from './types.js';

/**
 * In-memory repository used by tests and by local experiments that do not need
 * persistence.
 */
export class MemoryRepository implements IndexerRepository {
  private readonly documents = new Map<IndexerCollection, Map<string, IndexerDocument>>();
  private readonly events = new EventEmitter();

  async list(collection: IndexerCollection): Promise<IndexerDocument[]> {
    return [...(this.documents.get(collection)?.values() ?? [])];
  }

  async query(collection: IndexerCollection, args: RepositoryQueryArgs): Promise<RepositoryQueryResult> {
    const documents = await this.list(collection);
    const filtered = sortDocuments(
      documents.filter((document) => matchesFilter(document.data, args.filter)),
      args.orderBy
    );
    const totalCount = filtered.length;
    const after = args.after === null || args.after === undefined || args.after === '' ? 0 : Number(args.after) + 1;
    const offset = Number(args.offset ?? after);
    const start = Number.isFinite(offset) ? Math.max(offset, 0) : 0;
    const first = args.first ?? null;
    const last = args.last ?? null;
    const end =
      first === null || first === undefined ? filtered.length : Math.min(start + Math.max(first, 0), filtered.length);
    const items = last === null || last === undefined ? filtered.slice(start, end) : filtered.slice(Math.max(end - last, start), end);

    return { items, totalCount };
  }

  async get(collection: IndexerCollection, id: string): Promise<IndexerDocument | null> {
    return this.documents.get(collection)?.get(id) ?? null;
  }

  async upsert(document: IndexerDocument): Promise<void> {
    const collection = this.documents.get(document.collection) ?? new Map<string, IndexerDocument>();
    collection.set(document.id, { ...document, data: { ...document.data } });
    this.documents.set(document.collection, collection);
    this.events.emit('document', document);
  }

  async upsertMany(documents: IndexerDocument[]): Promise<void> {
    for (const document of documents) {
      await this.upsert(document);
    }
  }

  async close(): Promise<void> {
    this.documents.clear();
    this.events.removeAllListeners();
  }

  async *watch(collection: IndexerCollection, ids: string[] = []): AsyncGenerator<IndexerDocument, void, unknown> {
    const queue: IndexerDocument[] = [];
    let notify: (() => void) | null = null;
    const filter = (document: IndexerDocument): boolean =>
      document.collection === collection && (!ids.length || ids.includes(document.id));
    const listener = (document: IndexerDocument) => {
      if (!filter(document)) return;

      queue.push(document);
      notify?.();
      notify = null;
    };

    this.events.on('document', listener);

    try {
      while (true) {
        if (!queue.length) {
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
        }

        const document = queue.shift();
        if (document) yield document;
      }
    } finally {
      this.events.off('document', listener);
    }
  }
}
