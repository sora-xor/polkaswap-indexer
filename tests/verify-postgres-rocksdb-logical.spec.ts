import { describe, expect, it } from 'vitest';

import { INDEXER_COLLECTIONS } from '../src/repository/types.js';
import { verifyPostgresRocksdbLogicalEquality } from '../src/scripts/verify-postgres-rocksdb-logical.js';

import type pg from 'pg';
import type { RocksRepository } from '../src/repository/rocksdb.js';
import type { IndexerDocument } from '../src/repository/types.js';

const source: IndexerDocument = {
  collection: 'assets',
  id: 'xor',
  blockHeight: 10,
  timestamp: 20,
  data: { id: 'xor', symbol: 'XOR', blockHeight: 10, timestamp: 20 },
};

const clientFor = (documents: IndexerDocument[]) =>
  ({
    query: async (sql: string, values: unknown[]) => {
      const collection = values[0];
      const rows = documents.filter((document) => document.collection === collection);
      if (sql.includes('count(*)')) return { rows: [{ count: String(rows.length) }], rowCount: 1 };
      const after = values[1];
      return {
        rows: rows
          .filter((document) => after === null || document.id > String(after))
          .map((document) => ({
            collection: document.collection,
            id: document.id,
            blockHeight: document.blockHeight ?? null,
            timestamp: document.timestamp ?? null,
            dataText: JSON.stringify(document.data),
          })),
        rowCount: rows.length,
      };
    },
  }) as unknown as pg.PoolClient;

const repositoryFor = (documents: IndexerDocument[]) =>
  ({
    count: (collection: string) => documents.filter((document) => document.collection === collection).length,
    getMany: async (collection: string, ids: string[]) =>
      new Map(
        documents
          .filter((document) => document.collection === collection && ids.includes(document.id))
          .map((document) => [document.id, document])
      ),
  }) as unknown as RocksRepository;

describe('sealed PostgreSQL/RocksDB logical verification', () => {
  it('uses the C-collated composite migration index predicate for every exhaustive collection scan', async () => {
    const countQueries: string[] = [];
    const pageQueries: string[] = [];
    const client = {
      query: async (sql: string) => {
        const normalized = sql.replace(/\s+/g, ' ').trim();
        if (sql.includes('count(*)')) {
          countQueries.push(normalized);
          return { rows: [{ count: '0' }], rowCount: 1 };
        }
        pageQueries.push(normalized);
        return { rows: [], rowCount: 0 };
      },
    } as unknown as pg.PoolClient;

    await expect(verifyPostgresRocksdbLogicalEquality(client, repositoryFor([]), 10)).resolves.toBe(0);
    expect(countQueries).toHaveLength(INDEXER_COLLECTIONS.length);
    expect(pageQueries).toHaveLength(INDEXER_COLLECTIONS.length);
    for (const sql of [...countQueries, ...pageQueries]) {
      expect(sql).toContain('where collection collate "C" = $1::text collate "C"');
    }
    for (const sql of pageQueries) {
      expect(sql).toContain('id collate "C" > $2::text collate "C"');
      expect(sql).toContain('order by id collate "C"');
    }
  });

  it('accepts an exhaustive semantic match', async () => {
    await expect(
      verifyPostgresRocksdbLogicalEquality(clientFor([source]), repositoryFor([structuredClone(source)]), 10)
    ).resolves.toBe(1);
  });

  it('rejects an omitted destination document even when its internal indexes could be consistent', async () => {
    await expect(verifyPostgresRocksdbLogicalEquality(clientFor([source]), repositoryFor([]), 10)).rejects.toThrow(
      /logical count mismatch/
    );
  });

  it('rejects an extra destination document even when its internal indexes could be consistent', async () => {
    const extra = { ...source, id: 'val', data: { id: 'val', symbol: 'VAL' } };
    await expect(
      verifyPostgresRocksdbLogicalEquality(clientFor([source]), repositoryFor([source, extra]), 10)
    ).rejects.toThrow(/logical count mismatch/);
  });

  it('rejects altered payloads with matching identities and cardinality', async () => {
    const altered = { ...source, data: { ...source.data, symbol: 'WRONG' } };
    await expect(
      verifyPostgresRocksdbLogicalEquality(clientFor([source]), repositoryFor([altered]), 10)
    ).rejects.toThrow(/document mismatch/);
  });

  it('rejects unsafe raw PostgreSQL numerics instead of comparing two rounded values', async () => {
    const client = clientFor([source]) as unknown as {
      query: (sql: string, values: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
    };
    const originalQuery = client.query.bind(client);
    client.query = async (sql, values) => {
      const result = await originalQuery(sql, values);
      if (!sql.includes('count(*)') && result.rows.length) {
        (result.rows[0] as { dataText: string }).dataText = '{"id":"xor","unsafe":9007199254740992}';
      }
      return result;
    };

    await expect(
      verifyPostgresRocksdbLogicalEquality(client as unknown as pg.PoolClient, repositoryFor([source]), 10)
    ).rejects.toThrow(/cannot be represented exactly/);
  });
});
