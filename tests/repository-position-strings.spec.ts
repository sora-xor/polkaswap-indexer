import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readConfig } from '../src/config.js';
import { decodeRepositoryCursor } from '../src/repository/cursor.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { decodePostgresDocumentText } from '../src/repository/postgres-document.js';
import { RocksRepository, rocksCompactIndexKeysForDocument } from '../src/repository/rocksdb.js';

import type { IndexerDocument } from '../src/repository/types.js';

// Bounded public source row from the migration failure at referrerRewards.
const referrer = 'cnRWW1PFEVFwSPxR26GAwzAdEd9wTPUMb2mo84UFdMi9TASXn';
const referral = 'cnW1pm3hDysWLCD4xvQAKFmW9QPjMG5zmnRxBpc6hd3P7CWP3';
const auditedReward = {
  id: `${referrer}-${referral}`, amount: '0', updated: 1_779_860_520,
  referral, referrer, timestamp: 1_779_860_520, blockHeight: '26309250',
};

describe('lossless payload position strings with native RocksDB', () => {
  let temporary: string;
  let repository: RocksRepository;

  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'polkaswap-position-strings-'));
    vi.stubEnv('STORAGE_ENGINE', 'rocksdb');
    vi.stubEnv('ROCKSDB_PATH', join(temporary, 'indexer.rocksdb'));
    vi.stubEnv('ROCKSDB_BLOCK_CACHE_MB', '16');
    vi.stubEnv('ROCKSDB_WRITE_BUFFER_MANAGER_MB', '16');
    vi.stubEnv('ROCKSDB_DOCUMENT_CACHE_MAX', '0');
    vi.stubEnv('ROCKSDB_DOCUMENT_CACHE_MAX_BYTES', '0');
    repository = new RocksRepository(readConfig());
    await repository.prepare();
  });

  afterEach(async () => {
    await repository?.close();
    vi.unstubAllEnvs();
    await rm(temporary, { recursive: true, force: true });
  });

  it('round-trips the audited reward and a 503-row mixed string/number reward batch without changing payload types', async () => {
    const documents = Array.from({ length: 503 }, (_, index) => {
      const data = { ...auditedReward,
        id: index === 0 ? auditedReward.id : `${auditedReward.id}-${index}`,
        blockHeight: index < 481 ? auditedReward.blockHeight : Number(auditedReward.blockHeight),
      };
      return decodePostgresDocumentText({ collection: 'referrerRewards', id: data.id,
        blockHeight: '26309250', timestamp: '1779860520', dataText: JSON.stringify(data) });
    });
    expect(documents[0]).toEqual({ collection: 'referrerRewards', id: auditedReward.id,
      blockHeight: 26_309_250, timestamp: 1_779_860_520, data: auditedReward });
    await repository.upsertMany(documents);
    await repository.upsertMany(documents);
    await repository.validateCompactIndexes();
    expect(repository.count('referrerRewards')).toBe(503);
    await repository.close();
    repository = new RocksRepository(readConfig());
    await repository.prepare();
    const restored = await repository.getMany('referrerRewards', documents.map(({ id }) => id));
    expect(restored.size).toBe(503);
    for (const document of documents) expect(restored.get(document.id)).toEqual(document);
    expect(typeof restored.get(auditedReward.id)?.data.blockHeight).toBe('string');
    const page = await repository.query('referrerRewards', { first: 2,
      filter: { referrer: { equalTo: referrer }, blockHeight: { equalTo: '26309250' } },
      orderBy: ['BLOCK_HEIGHT_ASC'], includeTotalCount: true });
    expect(page.totalCount).toBe(503);
    expect(page.items.every(({ blockHeight }) => blockHeight === 26_309_250)).toBe(true);
  });

  it('uses numeric envelope positions for compact indexes, filters and keyset pages while preserving strings', async () => {
    const documents: IndexerDocument[] = [2, 10, 10, 20].map((position, index) =>
      decodePostgresDocumentText({ collection: 'historyElements', id: `history-${index}`,
        blockHeight: String(position), timestamp: String(position),
        dataText: JSON.stringify({ id: `history-${index}`, address: 'alice', module: 'system',
          blockHeight: String(position), timestamp: String(position) }) }));
    for (const document of documents) {
      expect(rocksCompactIndexKeysForDocument(document)).toEqual(rocksCompactIndexKeysForDocument({
        ...document, data: { ...document.data, blockHeight: document.blockHeight, timestamp: document.timestamp },
      }));
    }
    const memory = new MemoryRepository();
    try {
      await memory.upsertMany(documents);
      await repository.upsertMany(documents);
      await repository.validateCompactIndexes();
      const args = { first: 2, orderBy: ['TIMESTAMP_ASC'], includeTotalCount: true,
        filter: { address: { equalTo: 'alice' }, blockHeight: { greaterThan: '2' } } };
      const first = await repository.query('historyElements', args);
      expect(first.items.map(({ id }) => id)).toEqual(['history-1', 'history-2']);
      expect(first.items).toEqual((await memory.query('historyElements', args)).items);
      expect(first.totalCount).toBe(3);
      const keyset = decodeRepositoryCursor(first.itemCursors?.[1]);
      expect(keyset).toMatchObject({ field: 'timestamp', value: '10', id: 'history-2' });
      const second = await repository.query('historyElements', { ...args, keyset });
      expect(second.items.map(({ id }) => id)).toEqual(['history-3']);
      expect(second.items).toEqual((await memory.query('historyElements', { ...args, keyset })).items);
      expect(second.items[0]?.data).toMatchObject({ timestamp: '20', blockHeight: '20' });
    } finally { await memory.close(); }
  });
});
