import pg from 'pg';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { readConfig } from '../src/config.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { PostgresRepository } from '../src/repository/postgres.js';
import { RocksRepository } from '../src/repository/rocksdb.js';
import type { IndexerDocument, IndexerRepository } from '../src/repository/types.js';
const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL ?? '';
const suite = databaseUrl ? describe : describe.skip;

suite('cross-engine filter operator matrix', () => {
  let directory: string;
  let repositories: Array<[string, MemoryRepository | PostgresRepository | RocksRepository]> = [];
  const admin = new pg.Pool({ connectionString: databaseUrl });
  beforeAll(async () => {
    await migrate(databaseUrl); await admin.query('truncate table indexer_documents');
    directory = await mkdtemp(join(tmpdir(), 'sora-filter-matrix-'));
    const rocks = new RocksRepository({ ...readConfig(), storageEngine: 'rocksdb', rocksdbPath: join(directory, 'rocks'), rocksdbBlockCacheMb: 16, rocksdbWriteBufferManagerMb: 16, rocksdbParallelism: 1 });
    await rocks.prepare();
    repositories = [['PostgreSQL', new PostgresRepository(databaseUrl)], ['RocksDB', rocks], ['memory', new MemoryRepository()]];
    const documents: IndexerDocument[] = [1, 2, 3].map(value => ({ collection: 'assets', id: `a${value}`, blockHeight: value, timestamp: value,
      data: { id: `a${value}`, liquidity: String(value), customNumber: String(value), symbol: ['Alpha', 'Beta', 'Gamma'][value - 1], tags: [value, 'shared'], data: { assetId: `asset${value}`, to: `account${value}`, kind: 'fixture' } } }));
    for (const [, repository] of repositories) await repository.upsertMany(documents);
  }, 30_000);
  afterAll(async () => {
    for (const [, repository] of repositories) await repository.close();
    await admin.query("delete from indexer_documents where collection = 'assets' and id = any($1::text[])", [['a1', 'a2', 'a3']]);
    await admin.end(); if (directory) await rm(directory, { recursive: true, force: true });
  });
  const query = async (filter: Record<string, unknown>, expected: string[]) => {
    for (const [engine, repository] of repositories) {
      const result = await repository.query('assets', { filter, first: 100, orderBy: ['ID_ASC'] });
      expect(result.items.map(row => row.id), engine + ' ' + JSON.stringify(filter)).toEqual(expected);
    }
  };
  for (const field of ['blockHeight', 'liquidity', 'customNumber']) {
    it.each([
      ['equalTo', '2', ['a2']], ['eq', '2', ['a2']], ['notEqualTo', '2', ['a1', 'a3']], ['not_eq', '2', ['a1', 'a3']],
      ['in', ['1', null, '3'], ['a1', 'a3']], ['notIn', ['1', '3'], ['a2']], ['not_in', ['1', '3'], ['a2']],
      ['greaterThan', '2', ['a3']], ['gt', '2', ['a3']], ['greaterThanOrEqualTo', '2', ['a2', 'a3']], ['gte', '2', ['a2', 'a3']],
      ['lessThan', '2', ['a1']], ['lt', '2', ['a1']], ['lessThanOrEqualTo', '2', ['a1', 'a2']], ['lte', '2', ['a1', 'a2']],
    ])(`filters ${field} with %s consistently`, async (operator, value, expected) => {
      await query({ [field]: { [operator as string]: value } }, expected as string[]);
    });
    it(`supports direct equality on ${field}`, async () => { await query({ [field]: '2' }, ['a2']); });
  }
  it.each([
    [{ symbol: { equalTo: 'Beta' } }, ['a2']], [{ symbol: { notEqualTo: 'Beta' } }, ['a1', 'a3']],
    [{ symbol: { equalToInsensitive: 'bEtA' } }, ['a2']], [{ symbol: { includesInsensitive: 'MM' } }, ['a3']],
    [{ symbol: { in: ['Alpha', 'Gamma'] } }, ['a1', 'a3']], [{ symbol: { notIn: ['Alpha', 'Gamma'] } }, ['a2']],
    [{ tags: { contains: 2 } }, ['a2']], [{ tags: { contains: [1, 'shared'] } }, ['a1']],
    [{ data: { contains: { assetId: 'asset2' } } }, ['a2']], [{ data: { contains: { to: 'account3' } } }, ['a3']],
    [{ data: { contains: { assetId: 'asset1', kind: 'fixture' } } }, ['a1']],
    [{ and: [{ blockHeight: { gt: 1 } }, { liquidity: { lt: 3 } }] }, ['a2']],
    [{ or: [{ blockHeight: { eq: 1 } }, { liquidity: { eq: '3' } }] }, ['a1', 'a3']],
    [{ and: [] }, ['a1', 'a2', 'a3']], [{ or: [] }, []],
    [{ liquidity: { in: [] } }, []], [{ liquidity: { notIn: [] } }, ['a1', 'a2', 'a3']],
    [{ symbol: { equalTo: null } }, ['a1', 'a2', 'a3']], [{ symbol: {} }, ['a1', 'a2', 'a3']],
  ])('matches text, containment and boolean filter semantics: %j', async (filter, expected) => {
    await query(filter as Record<string, unknown>, expected as string[]);
  });
});
