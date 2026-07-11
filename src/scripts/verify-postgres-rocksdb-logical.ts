import { isDeepStrictEqual } from 'node:util';

import pg from 'pg';

import { decodePostgresDocumentText } from '../repository/postgres-document.js';
import { INDEXER_COLLECTIONS } from '../repository/types.js';

import type { RocksRepository } from '../repository/rocksdb.js';
import type { IndexerCollection, IndexerDocument } from '../repository/types.js';

type PostgresDocumentRow = {
  collection: IndexerCollection;
  id: string;
  blockHeight: number | string | null;
  timestamp: number | string | null;
  dataText: string;
};

const documentsEqual = (left: IndexerDocument | null | undefined, right: IndexerDocument): boolean =>
  Boolean(
    left &&
      left.collection === right.collection &&
      left.id === right.id &&
      (left.blockHeight ?? null) === (right.blockHeight ?? null) &&
      (left.timestamp ?? null) === (right.timestamp ?? null) &&
      isDeepStrictEqual(left.data, right.data)
  );

/**
 * Exhaustively proves logical source/destination equality under the caller's
 * source write fence. Memory is bounded by `batchSize`.
 */
export const verifyPostgresRocksdbLogicalEquality = async (
  client: pg.PoolClient,
  repository: RocksRepository,
  batchSize: number
): Promise<number> => {
  let verifiedRows = 0;

  for (const collection of INDEXER_COLLECTIONS) {
    const countResult = await client.query<{ count: string }>(
      `select count(*)::text as count
         from indexer_documents
        where collection collate "C" = $1::text collate "C"`,
      [collection]
    );
    const sourceCount = Number(countResult.rows[0]?.count ?? '');
    if (!Number.isSafeInteger(sourceCount) || sourceCount < 0) {
      throw new Error(`${collection}: PostgreSQL document count exceeds the safe integer range`);
    }
    const destinationCount = repository.count(collection);
    if (sourceCount !== destinationCount) {
      throw new Error(
        `${collection}: sealed logical count mismatch postgres=${sourceCount} rocksdb=${destinationCount}`
      );
    }

    let afterId: string | null = null;
    let compared = 0;
    while (true) {
      const result: pg.QueryResult<PostgresDocumentRow> = await client.query<PostgresDocumentRow>(
        `select collection,
                id,
                block_height as "blockHeight",
                timestamp,
                data::text as "dataText"
           from indexer_documents
          where collection collate "C" = $1::text collate "C"
            and ($2::text is null or id collate "C" > $2::text collate "C")
          order by id collate "C"
          limit $3::int`,
        [collection, afterId, batchSize]
      );
      if (!result.rows.length) break;

      const expected: IndexerDocument[] = result.rows.map((row: PostgresDocumentRow) =>
        decodePostgresDocumentText(row)
      );
      const actual = await repository.getMany(
        collection,
        expected.map((document: IndexerDocument) => document.id)
      );
      for (const document of expected) {
        if (!documentsEqual(actual.get(document.id), document)) {
          throw new Error(`${collection}/${document.id}: sealed PostgreSQL/RocksDB document mismatch`);
        }
      }
      compared += expected.length;
      verifiedRows += expected.length;
      afterId = expected.at(-1)!.id;
    }
    if (compared !== sourceCount) {
      throw new Error(`${collection}: sealed keyset verification visited ${compared}/${sourceCount} documents`);
    }
  }

  return verifiedRows;
};
