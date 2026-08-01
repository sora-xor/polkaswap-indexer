import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RocksDatabase } from '@harperfast/rocksdb-js';

import { decodeRepositoryCursor } from '../src/repository/cursor.js';
import { sortDocuments } from '../src/graphql/filter.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { rocksCompactIndexKeysForDocument, RocksRepository } from '../src/repository/rocksdb.js';
import { metrics } from '../src/metrics.js';

import type { AppConfig } from '../src/config.js';
import type { IndexerDocument } from '../src/repository/types.js';
import type { Key } from '@harperfast/rocksdb-js';

const createConfig = (rocksdbPath: string): AppConfig => ({
  host: '127.0.0.1',
  port: 4350,
  graphqlPath: '/graphql',
  httpListenBacklog: 4_096,
  httpShutdownTimeoutMs: 30_000,
  httpKeepAliveTimeoutMs: 75_000,
  httpHeadersTimeoutMs: 80_000,
  httpRequestTimeoutMs: 120_000,
  httpMaxConnections: 10_000,
  graphqlHttpMaxBodyBytes: 262_144,
  graphqlHttpMaxInFlight: 100,
  graphqlMaxDepth: 12,
  graphqlMaxDocumentNodes: 2_000,
  graphqlMaxFields: 500,
  graphqlMaxAliases: 50,
  graphqlMaxFragmentSpreads: 100,
  graphqlMaxOperationCost: 100_000,
  graphqlAllowIntrospection: false,
  graphqlWsMaxPayloadBytes: 65_536,
  graphqlWsConnectionInitTimeoutMs: 30_000,
  graphqlWsMaxConnections: 1_000,
  graphqlWsMaxOperations: 2_000,
  graphqlWsMaxOperationsPerConnection: 20,
  graphqlWsMaxPendingMessagesPerConnection: 64,
  graphqlCacheMaxEntries: 1_000,
  graphqlCacheMaxBytes: 67_108_864,
  graphqlCacheTtlMs: 2_000,
  graphqlMaxResultBytes: 67_108_864,
  graphqlExecutionMemoryMaxBytes: 536_870_912,
  storageEngine: 'rocksdb',
  databaseUrl: 'postgres://polkaswap:polkaswap@127.0.0.1:5432/polkaswap_indexer',
  skipPostgresMigration: false,
  postgresPoolMax: 20,
  postgresListenPoolMax: 2,
  postgresConnectionTimeoutMs: 10_000,
  postgresQueryTimeoutMs: 120_000,
  postgresStatementTimeoutMs: 120_000,
  postgresMigrationQueryTimeoutMs: 0,
  postgresMigrationStatementTimeoutMs: 0,
  postgresWatchQueueMax: 1_000,
  postgresWatchReconnectMinDelayMs: 100,
  postgresWatchReconnectMaxDelayMs: 10_000,
  rocksdbPath,
  rocksdbBlockCacheMb: 32,
  rocksdbWriteBufferManagerMb: 16,
  rocksdbParallelism: 1,
  rocksdbEnableStats: false,
  rocksdbDocumentCacheMax: 10_000,
  rocksdbDocumentCacheMaxBytes: 268_435_456,
  rocksdbWatchQueueMax: 1_000,
  rocksdbQueryMaxScannedRows: 100_000,
  rocksdbCompactionMinFreeGb: 0,
  soraWsEndpoint: 'wss://mof2.sora.org',
  chainStartBlock: 0,
  chainBatchSize: 25,
  stateRefreshIntervalBlocks: 25,
  snapshotIntervalBlocks: 25,
  fullReconciliationIntervalBlocks: 250,
  chainShutdownTimeoutMs: 30_000,
  chainRpcTimeoutMs: 15_000,
  chainRpcMaxInFlight: 256,
  derivedStorageLoadMaxBytes: 268_435_456,
  derivedStorageCacheMaxBytes: 67_108_864,
  analyticsInputCacheMaxBytes: 134_217_728,
  backfillPrefetchConcurrency: 1,
  finalizedCatchupPrefetchConcurrency: 1,
  priceStreamRefreshIntervalBlocks: 0,
  legacySoraBlockTypes: false,
  archiveSoraWsEndpoint: '',
  workerReadinessMaxLagBlocks: 25,
  workerReadinessMaxStalenessSeconds: 120,
  workerMetricsHost: '127.0.0.1',
  workerMetricsPort: 9464,
  workerMetricsMaxInFlight: 10,
});

const assetSnapshot = (id: string, assetId: string, timestamp: number, type = 'DAY'): IndexerDocument => ({
  collection: 'assetSnapshots',
  id,
  blockHeight: timestamp,
  timestamp,
  data: { id, assetId, timestamp, type },
});

const compactRange = (prefix: Key[]) => ({
  start: prefix,
  end: [...prefix, Buffer.from([0xff])],
  inclusiveEnd: true,
});

describe('RocksRepository', () => {
  let tempDir: string;
  let repository: RocksRepository;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'polkaswap-rocksdb-'));
    repository = new RocksRepository(createConfig(join(tempDir, 'indexer.rocksdb')));
    await repository.prepare();
  });

  afterEach(async () => {
    await repository.close().catch(() => undefined);
    await rm(tempDir, { recursive: true, force: true });
  });

  it('stores and retrieves documents by collection/id', async () => {
    const xor = assetSnapshot('snapshot-xor', 'xor', 10);
    const val = assetSnapshot('snapshot-val', 'val', 20);

    await repository.upsertMany([xor, val]);

    await expect(repository.get('assetSnapshots', 'snapshot-xor')).resolves.toEqual(xor);
    await expect(repository.getMany('assetSnapshots', ['snapshot-val', 'missing'])).resolves.toEqual(
      new Map([['snapshot-val', val]])
    );
    await expect(repository.list('assetSnapshots')).resolves.toEqual([val, xor].sort((left, right) => left.id.localeCompare(right.id)));
  });

  it('fails closed when an unindexed query exceeds its configured scan budget', async () => {
    await repository.close();
    repository = new RocksRepository({
      ...createConfig(join(tempDir, 'scan-budget.rocksdb')),
      rocksdbQueryMaxScannedRows: 2,
    });
    await repository.prepare();
    await repository.upsertMany([
      { collection: 'assets', id: 'a', data: { id: 'a', label: 'a' } },
      { collection: 'assets', id: 'b', data: { id: 'b', label: 'b' } },
      { collection: 'assets', id: 'c', data: { id: 'c', label: 'c' } },
    ]);

    await expect(
      repository.query('assets', {
        first: 1,
        orderBy: ['LABEL_ASC'],
        includeTotalCount: false,
      })
    ).rejects.toThrow(/row scan limit/);
    expect(metrics.render()).toContain(
      'indexer_rocksdb_query_scan_limit_total{collection="assets",source="x:scan-sort"} 1'
    );
  });

  it('keeps a bounded LRU of owned document clones', async () => {
    await repository.close();
    repository = new RocksRepository({
      ...createConfig(join(tempDir, 'indexer.rocksdb')),
      rocksdbDocumentCacheMax: 2,
    });
    await repository.prepare();

    metrics.reset();
    const original = assetSnapshot('snapshot-a', 'xor', 10);
    await repository.upsert(original);
    original.data.assetId = 'caller-mutated';

    const firstRead = await repository.get('assetSnapshots', 'snapshot-a');
    expect(firstRead?.data.assetId).toBe('xor');
    if (firstRead) firstRead.data.assetId = 'reader-mutated';
    await expect(repository.get('assetSnapshots', 'snapshot-a')).resolves.toMatchObject({ data: { assetId: 'xor' } });

    await repository.upsert(assetSnapshot('snapshot-b', 'xor', 20));
    await repository.upsert(assetSnapshot('snapshot-c', 'xor', 30));

    expect(repository.metricsSnapshot()).toMatchObject({
      rocksdb_document_cache_entries: 2,
      rocksdb_document_cache_max: 2,
    });
    expect(metrics.render()).toContain(
      'indexer_rocksdb_document_cache_hits_total{collection="assetSnapshots"}'
    );
    expect(metrics.render()).toContain('indexer_rocksdb_document_cache_entries 2');
  });

  it('does not rewrite or publish semantically equal JSON with different key order', async () => {
    await repository.upsert({
      collection: 'assets',
      id: 'xor',
      blockHeight: 10,
      timestamp: 20,
      data: { id: 'xor', metadata: { symbol: 'XOR', decimals: 18 } },
    });
    const internal = repository as unknown as {
      events: { on: (name: string, listener: () => void) => void };
    };
    let published = 0;
    internal.events.on('document', () => {
      published += 1;
    });

    await repository.upsert({
      collection: 'assets',
      id: 'xor',
      blockHeight: 10,
      timestamp: 20,
      data: { metadata: { decimals: 18, symbol: 'XOR' }, id: 'xor' },
    });

    expect(published).toBe(0);
  });

  it('uses the fallback sorter collation exactly across keyset pages', async () => {
    const documents: IndexerDocument[] = [
      { collection: 'assets', id: 'lower-a', data: { id: 'lower-a', label: 'a' } },
      { collection: 'assets', id: 'upper-z', data: { id: 'upper-z', label: 'Z' } },
      { collection: 'assets', id: 'unicode-a', data: { id: 'unicode-a', label: 'ä' } },
      { collection: 'assets', id: 'plain-z', data: { id: 'plain-z', label: 'z' } },
      { collection: 'assets', id: 'missing', data: { id: 'missing' } },
      { collection: 'assets', id: 'null', data: { id: 'null', label: null } },
    ];
    await repository.upsertMany(documents);

    const collectPages = async (direction: 'ASC' | 'DESC'): Promise<string[]> => {
      const ids: string[] = [];
      let keyset = null;
      for (let page = 0; page < documents.length + 1; page += 1) {
        const result = await repository.query('assets', {
          first: 1,
          orderBy: [`LABEL_${direction}`],
          includeTotalCount: false,
          ...(keyset ? { keyset } : {}),
        });
        if (!result.items.length) break;
        ids.push(result.items[0]!.id);
        keyset = decodeRepositoryCursor(result.itemCursors?.[0]);
      }
      return ids;
    };

    for (const direction of ['ASC', 'DESC'] as const) {
      const expected = sortDocuments(
        documents.map((document) => ({ ...document.data, id: document.id })),
        [`LABEL_${direction}`]
      ).map((document) => String(document.id));
      await expect(collectPages(direction)).resolves.toEqual(expected);
    }
  });

  it('uses document ids as deterministic fallback keyset tie breakers in both directions', async () => {
    await repository.upsertMany([
      { collection: 'assets', id: 'tie-b', data: { id: 'tie-b', label: 'same' } },
      { collection: 'assets', id: 'tie-a', data: { id: 'tie-a', label: 'same' } },
      { collection: 'assets', id: 'tie-c', data: { id: 'tie-c', label: 'same' } },
    ]);

    const pageAfterFirst = async (direction: 'ASC' | 'DESC') => {
      const first = await repository.query('assets', {
        first: 1,
        orderBy: [`LABEL_${direction}`],
        includeTotalCount: false,
      });
      const keyset = decodeRepositoryCursor(first.itemCursors?.[0]);
      const rest = await repository.query('assets', {
        first: 2,
        orderBy: [`LABEL_${direction}`],
        includeTotalCount: false,
        keyset,
      });
      return [...first.items, ...rest.items].map((document) => document.id);
    };

    await expect(pageAfterFirst('ASC')).resolves.toEqual(['tie-a', 'tie-b', 'tie-c']);
    await expect(pageAfterFirst('DESC')).resolves.toEqual(['tie-c', 'tie-b', 'tie-a']);
  });

  it('rejects lower-block overwrites and keeps the freshest candidate within a batch', async () => {
    const atBlock = (blockHeight: number | null, assetId: string): IndexerDocument => ({
      collection: 'assetSnapshots',
      id: 'stable-id',
      blockHeight,
      timestamp: blockHeight ?? undefined,
      data: { id: 'stable-id', assetId, type: 'DAY', blockHeight },
    });

    await repository.upsert(atBlock(100, 'current'));
    await repository.upsert(atBlock(90, 'stale'));
    await repository.upsert(atBlock(null, 'null-is-older'));
    await expect(repository.get('assetSnapshots', 'stable-id')).resolves.toMatchObject({
      blockHeight: 100,
      data: { assetId: 'current' },
    });

    await repository.upsertMany([atBlock(120, 'freshest'), atBlock(110, 'late-stale')]);
    await expect(repository.get('assetSnapshots', 'stable-id')).resolves.toMatchObject({
      blockHeight: 120,
      data: { assetId: 'freshest' },
    });

    await repository.upsertMany([atBlock(120, 'equal-first'), atBlock(120, 'equal-last')]);
    await expect(repository.get('assetSnapshots', 'stable-id')).resolves.toMatchObject({
      blockHeight: 120,
      data: { assetId: 'equal-last' },
    });

    const staleIndex = await repository.query('assetSnapshots', {
      filter: { assetId: { equalTo: 'stale' }, type: { equalTo: 'DAY' } },
      orderBy: ['TIMESTAMP_ASC'],
      includeTotalCount: true,
    });
    const currentIndex = await repository.query('assetSnapshots', {
      filter: { assetId: { equalTo: 'equal-last' }, type: { equalTo: 'DAY' } },
      orderBy: ['TIMESTAMP_ASC'],
      includeTotalCount: true,
    });
    expect(staleIndex).toMatchObject({ items: [], totalCount: 0 });
    expect(currentIndex.items.map((document) => document.id)).toEqual(['stable-id']);

    await repository.upsert({ ...atBlock(null, 'null-first'), id: 'null-id', data: { id: 'null-id', assetId: 'null-first' } });
    await repository.upsert({ ...atBlock(null, 'null-update'), id: 'null-id', data: { id: 'null-id', assetId: 'null-update' } });
    await expect(repository.get('assetSnapshots', 'null-id')).resolves.toMatchObject({ data: { assetId: 'null-update' } });
  });

  it('rolls back the complete upsertMany call when a later internal payload batch fails', async () => {
    type WritableTransaction = {
      put: (key: Key, value: unknown) => Promise<unknown>;
    };
    type TransactionCallback = (
      transaction: WritableTransaction,
      attempt: number
    ) => unknown | PromiseLike<unknown>;
    type InstrumentableDatabase = {
      transaction: (callback: TransactionCallback, options?: unknown) => Promise<unknown>;
    };

    const database = (repository as unknown as { db: InstrumentableDatabase }).db;
    const originalTransaction = database.transaction.bind(database);
    let documentPuts = 0;
    database.transaction = (callback, options) =>
      originalTransaction(async (transaction, attempt) => {
        const originalPut = transaction.put.bind(transaction);
        transaction.put = async (key, value) => {
          if (Array.isArray(key) && key[0] === 'd' && ++documentPuts > 1_000) {
            throw new Error('injected second payload batch failure');
          }
          return originalPut(key, value);
        };
        return callback(transaction, attempt);
      }, options);

    const documents = Array.from({ length: 1_001 }, (_item, index): IndexerDocument => {
      const id = `stream-${String(index).padStart(4, '0')}`;
      return { collection: 'updatesStreams', id, data: { id, value: index } };
    });
    try {
      await expect(repository.upsertMany(documents)).rejects.toThrow('injected second payload batch failure');
    } finally {
      database.transaction = originalTransaction;
    }

    await expect(repository.list('updatesStreams')).resolves.toEqual([]);
    await expect(repository.get('updatesStreams', 'stream-0000')).resolves.toBeNull();
    expect(repository.count('updatesStreams')).toBe(0);
    await expect(repository.validateCompactIndexes()).resolves.toBeUndefined();
  });

  it('initializes an empty first-release store directly in the current compact format', async () => {
    await repository.upsert(assetSnapshot('compact-only', 'xor', 10));

    const internal = repository as unknown as { db: RocksDatabase };
    expect([...internal.db.getRange({ ...compactRange(['i']), values: false })]).toHaveLength(0);
    expect([...internal.db.getRange({ ...compactRange(['x']), values: false })].length).toBeGreaterThan(0);
    expect(repository.formatVersion()).toBe(1);
    await expect(repository.prepare()).resolves.toBeUndefined();
  });

  it('requires prepare before reads or writes and then initializes exactly once', async () => {
    await repository.close();
    repository = new RocksRepository(createConfig(join(tempDir, 'prepare-required.rocksdb')));

    await expect(repository.upsert(assetSnapshot('blocked', 'xor', 1))).rejects.toThrow('prepare() first');
    await expect(repository.query('assetSnapshots', { first: 1 })).rejects.toThrow('prepare() first');
    await repository.prepare();
    await repository.prepare();
    await expect(repository.upsert(assetSnapshot('accepted', 'xor', 1))).resolves.toBeUndefined();
  });

  it.each(['in_progress', 'failed'] as const)(
    'refuses to serve a %s PostgreSQL migration artifact even when it contains chain state',
    async (status) => {
      await repository.close();
      const databasePath = join(tempDir, `partial-migration-${status}.rocksdb`);
      repository = new RocksRepository(createConfig(databasePath), { allowIncompleteMigration: true });
      await repository.prepare();
      await repository.upsert({
        collection: 'updatesStreams',
        id: 'chainState',
        blockHeight: 100,
        timestamp: 100,
        data: { id: 'chainState', blockHeight: 100 },
      });
      await repository.setMetadata('postgresToRocksdbMigration', { version: 1, status });
      await repository.close();

      repository = new RocksRepository(createConfig(databasePath));
      await expect(repository.prepare()).rejects.toThrow(/malformed PostgreSQL migration artifact/);
    }
  );

  it.each([
    { name: 'unversioned document', version: undefined, legacyIndex: false },
    { name: 'zero version', version: 0, legacyIndex: false },
    { name: 'future version', version: 2, legacyIndex: false },
    { name: 'string version', version: '1', legacyIndex: false },
    { name: 'fractional version', version: 1.5, legacyIndex: false },
    { name: 'legacy index residue', version: 1, legacyIndex: true },
  ])('fails closed for a non-current $name store', async ({ version, legacyIndex }) => {
    await repository.close();
    const databasePath = join(tempDir, `unsupported-${String(version)}-${legacyIndex}.rocksdb`);
    const raw = RocksDatabase.open(databasePath);
    if (version === undefined) {
      await raw.put(['d', 'assetSnapshots', 'old'], assetSnapshot('old', 'xor', 1));
    } else {
      await raw.put(['m', 'metadata', 'rocksdbFormatVersion'], version);
    }
    if (legacyIndex) await raw.put(['i', 'ts', 'assetSnapshots', 1, 'old'], 1);
    raw.close();

    repository = new RocksRepository(createConfig(databasePath));
    await expect(repository.prepare()).rejects.toThrow(/Unsupported/);
  });

  it('rejects malformed document envelopes instead of casting legacy values through', async () => {
    const internal = repository as unknown as { db: RocksDatabase };
    await internal.db.put(['d', 'assetSnapshots', 'legacy-object'], assetSnapshot('legacy-object', 'xor', 1));

    await expect(repository.get('assetSnapshots', 'legacy-object')).rejects.toThrow(/Unsupported or corrupt/);
    await expect(repository.validateCompactIndexes()).rejects.toThrow(/Unsupported or corrupt/);
  });

  it('uses timestamp indexes for filtered pagination and seek queries', async () => {
    await repository.upsertMany([
      assetSnapshot('xor-10', 'xor', 10),
      assetSnapshot('xor-20', 'xor', 20),
      assetSnapshot('xor-30', 'xor', 30),
      assetSnapshot('val-40', 'val', 40),
    ]);

    const firstPage = await repository.query('assetSnapshots', {
      first: 2,
      filter: { assetId: { equalTo: 'xor' }, type: { equalTo: 'DAY' } },
      orderBy: ['TIMESTAMP_ASC'],
      includeTotalCount: false,
    });

    expect(firstPage.items.map((document) => document.id)).toEqual(['xor-10', 'xor-20']);
    expect(firstPage.totalCount).toBeNull();
    expect(firstPage.hasNextPage).toBe(true);

    const secondPage = await repository.query('assetSnapshots', {
      first: 2,
      filter: { assetId: { equalTo: 'xor' }, type: { equalTo: 'DAY' } },
      orderBy: ['TIMESTAMP_ASC'],
      includeTotalCount: false,
      seek: { field: 'timestamp', value: 20, id: 'xor-20', direction: 'asc' },
    });

    expect(secondPage.items.map((document) => document.id)).toEqual(['xor-30']);
    expect(secondPage.hasNextPage).toBe(false);
  });

  it('uses the global history timestamp plan for worker analytics ranges and seek pagination', async () => {
    await repository.upsertMany([
      {
        collection: 'historyElements',
        id: 'history-a',
        blockHeight: 10,
        timestamp: 100,
        data: { id: 'history-a', blockHeight: 10, timestamp: 100, module: 'assets' },
      },
      {
        collection: 'historyElements',
        id: 'history-b',
        blockHeight: 20,
        timestamp: 100,
        data: { id: 'history-b', blockHeight: 20, timestamp: 100, module: 'liquidityProxy' },
      },
      {
        collection: 'historyElements',
        id: 'history-residual-excluded',
        blockHeight: 999,
        timestamp: 150,
        data: { id: 'history-residual-excluded', blockHeight: 999, timestamp: 150, module: 'system' },
      },
      {
        collection: 'historyElements',
        id: 'history-c',
        blockHeight: 30,
        timestamp: 200,
        data: { id: 'history-c', blockHeight: 30, timestamp: 200, module: 'poolXYK' },
      },
      {
        collection: 'historyElements',
        id: 'history-outside',
        blockHeight: 1,
        timestamp: 300,
        data: { id: 'history-outside', blockHeight: 1, timestamp: 300, module: 'system' },
      },
    ]);
    const filter = {
      and: [
        { timestamp: { greaterThanOrEqualTo: 100, lessThanOrEqualTo: 200 } },
        { blockHeight: { lessThanOrEqualTo: 30 } },
      ],
    };

    metrics.reset();
    const firstPage = await repository.query('historyElements', {
      first: 2,
      filter,
      orderBy: ['TIMESTAMP_ASC'],
      includeTotalCount: false,
    });
    expect(firstPage.items.map(({ id }) => id)).toEqual(['history-a', 'history-b']);
    expect(firstPage.hasNextPage).toBe(true);
    expect(metrics.render()).toContain('collection="historyElements",source="x:t"');
    expect(metrics.render()).not.toContain('indexer_rocksdb_query_fallback_total{collection="historyElements"');

    const secondPage = await repository.query('historyElements', {
      first: 2,
      filter,
      orderBy: ['TIMESTAMP_ASC'],
      includeTotalCount: false,
      seek: { field: 'timestamp', value: 100, id: 'history-b', direction: 'asc' },
    });
    expect(secondPage.items.map(({ id }) => id)).toEqual(['history-c']);
    expect(secondPage.hasNextPage).toBe(false);
  });

  it('rejects unsafe native positions before selecting a RocksDB source', async () => {
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '9007199254740992', '9'.repeat(80)]) {
      await expect(
        repository.query('historyElements', {
          filter: { timestamp: { greaterThanOrEqualTo: value } },
          orderBy: ['TIMESTAMP_ASC'],
        })
      ).rejects.toThrow('non-negative safe integer');
    }
    await expect(
      repository.query('historyElements', {
        filter: { blockHeight: { in: [1, '9007199254740992'] } },
        orderBy: ['ID_ASC'],
      })
    ).rejects.toThrow('non-negative safe integer');
    await expect(
      repository.query('historyElements', {
        orderBy: ['TIMESTAMP_ASC'],
        seek: { field: 'timestamp', value: Number.MAX_SAFE_INTEGER + 1, id: 'history-a' },
      })
    ).rejects.toThrow('non-negative safe integer');
    await expect(
      repository.query('historyElements', {
        orderBy: ['TIMESTAMP_ASC'],
        keyset: {
          scope: 'invalid-but-not-reached',
          field: 'timestamp',
          direction: 'asc',
          numeric: true,
          value: '9007199254740992',
          id: 'history-a',
        },
      })
    ).rejects.toThrow('non-negative safe integer');
  });

  it('stops materializing a page at its document byte budget while preserving progress', async () => {
    await repository.upsertMany(
      ['a', 'b', 'c'].map((id) => ({
        collection: 'updatesStreams' as const,
        id,
        data: { id, payload: 'x'.repeat(2_000) },
      }))
    );

    const result = await repository.query('updatesStreams', {
      first: 3,
      orderBy: ['ID_ASC'],
      includeTotalCount: true,
      maxBytes: 1_024,
    });

    expect(result.items.map(({ id }) => id)).toEqual(['a']);
    expect(result.totalCount).toBe(3);
    expect(result.hasNextPage).toBe(true);
  });

  it('keeps bounded direct-ID sorts within the same document byte budget', async () => {
    await repository.upsertMany([
      { collection: 'historyElements', id: 'history-a', blockHeight: 30, data: { id: 'history-a', payload: 'x'.repeat(2_000) } },
      { collection: 'historyElements', id: 'history-b', blockHeight: 10, data: { id: 'history-b', payload: 'x'.repeat(2_000) } },
      { collection: 'historyElements', id: 'history-c', blockHeight: 20, data: { id: 'history-c', payload: 'x'.repeat(2_000) } },
    ]);

    const result = await repository.query('historyElements', {
      first: 3,
      orderBy: ['BLOCK_HEIGHT_ASC'],
      filter: { id: { in: ['history-a', 'history-b', 'history-c'] } },
      includeTotalCount: true,
      maxBytes: 1_024,
    });

    expect(result.items.map(({ id }) => id)).toEqual(['history-b']);
    expect(result.totalCount).toBe(3);
    expect(result.hasNextPage).toBe(true);
  });

  it('bounds compact timestamp index scans from comparison filters', async () => {
    await repository.upsertMany(
      Array.from({ length: 100 }, (_item, index) => assetSnapshot(`xor-${index + 1}`, 'xor', index + 1))
    );

    metrics.reset();
    const result = await repository.query('assetSnapshots', {
      first: 10,
      filter: {
        assetId: { equalTo: 'xor' },
        type: { equalTo: 'DAY' },
        timestamp: { greaterThanOrEqualTo: 90, lessThanOrEqualTo: 92, lessThan: null },
      },
      orderBy: ['TIMESTAMP_ASC'],
      includeTotalCount: false,
    });

    expect(result.items.map((document) => document.id)).toEqual(['xor-90', 'xor-91', 'xor-92']);
    expect(metrics.render()).toContain(
      'indexer_rocksdb_query_scanned_rows_total{collection="assetSnapshots",source="x:a-t"} 3'
    );
  });

  it('uses the dedicated account-transaction index for global time ranges', async () => {
    await repository.upsertMany([
      ...Array.from({ length: 200 }, (_item, index) => ({
        collection: 'accountTransactions' as const,
        id: `unrelated-${String(index).padStart(3, '0')}`,
        blockHeight: index + 1,
        timestamp: index + 1,
        data: { id: `unrelated-${String(index).padStart(3, '0')}`, historyElementId: `other-${index}` },
      })),
      {
        collection: 'accountTransactions',
        id: 'match-a',
        blockHeight: 201,
        timestamp: 201,
        data: { id: 'match-a', historyElementId: 'history-a', accountId: 'alice' },
      },
      {
        collection: 'accountTransactions',
        id: 'match-b',
        blockHeight: 202,
        timestamp: 202,
        data: { id: 'match-b', historyElementId: 'history-b', accountId: 'bob' },
      },
    ]);

    metrics.reset();
    const chronological = await repository.query('accountTransactions', {
      first: 2,
      filter: { timestamp: { greaterThanOrEqualTo: 201 } },
      orderBy: ['TIMESTAMP_ASC'],
      includeTotalCount: false,
    });
    expect(chronological.items.map((document) => document.id)).toEqual(['match-a', 'match-b']);
    expect(metrics.render()).toContain('source="x:t"');

  });

  it('uses compact plans for required account-position and vault-event time queries', async () => {
    await repository.upsertMany([
      { collection: 'accountPositions', id: 'alice-old', timestamp: 10, data: { id: 'alice-old', account: 'alice' } },
      { collection: 'accountPositions', id: 'alice-new', timestamp: 20, data: { id: 'alice-new', account: 'alice' } },
      { collection: 'accountPositions', id: 'bob', timestamp: 30, data: { id: 'bob', account: 'bob' } },
      { collection: 'vaultEvents', id: 'vault-a-old', timestamp: 10, data: { id: 'vault-a-old', vaultId: 'vault-a' } },
      { collection: 'vaultEvents', id: 'vault-a-new', timestamp: 20, data: { id: 'vault-a-new', vaultId: 'vault-a' } },
      { collection: 'vaultEvents', id: 'vault-b', timestamp: 30, data: { id: 'vault-b', vaultId: 'vault-b' } },
    ]);

    metrics.reset();
    const positions = await repository.query('accountPositions', {
      first: 10,
      filter: { account: { equalTo: 'alice' } },
      orderBy: ['TIMESTAMP_DESC'],
      includeTotalCount: false,
    });
    const vaultEvents = await repository.query('vaultEvents', {
      first: 10,
      filter: { vaultId: { equalTo: 'vault-a' } },
      orderBy: ['TIMESTAMP_DESC'],
      includeTotalCount: false,
    });
    expect(positions.items.map((document) => document.id)).toEqual(['alice-new', 'alice-old']);
    expect(vaultEvents.items.map((document) => document.id)).toEqual(['vault-a-new', 'vault-a-old']);
    expect(metrics.render()).toContain('collection="accountPositions",source="x:a-t"');
    expect(metrics.render()).toContain('collection="vaultEvents",source="x:v-t"');
  });

  it('uses bounded compact sources for official UI eligibility, vault, and history queries', async () => {
    await repository.upsertMany([
      { collection: 'assets', id: 'asset-a', data: { id: 'asset-a', liquidity: '1', liquidityBooks: '0', priceUSD: '0' } },
      { collection: 'assets', id: 'asset-b', data: { id: 'asset-b', liquidity: '0', liquidityBooks: '2', priceUSD: '1' } },
      { collection: 'assets', id: 'asset-c', data: { id: 'asset-c', liquidity: '0', liquidityBooks: '0', priceUSD: '0' } },
      { collection: 'poolXYKs', id: 'pool-a', data: { id: 'pool-a', targetAssetId: 'xor', baseAssetReserves: '1', targetAssetReserves: '1', strategicBonusApy: '0' } },
      { collection: 'poolXYKs', id: 'pool-b', data: { id: 'pool-b', targetAssetId: 'val', baseAssetReserves: '1', targetAssetReserves: '0', strategicBonusApy: '5' } },
      { collection: 'poolXYKs', id: 'pool-c', data: { id: 'pool-c', targetAssetId: 'dot', baseAssetReserves: '2', targetAssetReserves: '2', strategicBonusApy: '3' } },
      { collection: 'vaults', id: 'vault-a', data: { id: 'vault-a', ownerId: 'alice', status: 'Closed', updatedAtBlock: 20 } },
      { collection: 'vaults', id: 'vault-b', data: { id: 'vault-b', ownerId: 'alice', status: 'Open', updatedAtBlock: 30 } },
      { collection: 'vaults', id: 'vault-c', data: { id: 'vault-c', ownerId: 'bob', status: 'Closed', updatedAtBlock: 40 } },
      { collection: 'historyElements', id: 'history-a', blockHeight: 10, timestamp: 10, data: { id: 'history-a', blockHeight: 10, timestamp: 10, module: 'assets', method: 'burn', data: { assetId: 'xor' } } },
      { collection: 'historyElements', id: 'history-b', blockHeight: 20, timestamp: 20, data: { id: 'history-b', blockHeight: 20, timestamp: 20, module: 'poolXYK', method: 'depositLiquidity', address: 'alice' } },
      { collection: 'historyElements', id: 'history-c', blockHeight: 200, timestamp: 200, data: { id: 'history-c', blockHeight: 200, timestamp: 200, module: 'assets', method: 'burn', data: { assetId: 'xor' } } },
    ]);

    const assertSource = (collection: string, source: string) => {
      const rendered = metrics.render();
      expect(rendered).toContain(`collection="${collection}",source="${source}"`);
      expect(rendered).not.toContain(`indexer_rocksdb_query_fallback_total{collection="${collection}"`);
    };

    metrics.reset();
    const activeAssets = await repository.query('assets', {
      first: 100,
      orderBy: ['ID_ASC'],
      filter: { or: [{ liquidity: { greaterThan: '0' } }, { liquidityBooks: { greaterThan: '0' } }] },
      includeTotalCount: false,
    });
    expect(activeAssets.items.map(({ id }) => id)).toEqual(['asset-a', 'asset-b']);
    assertSource('assets', 'x:assets-active-id');

    metrics.reset();
    const selectedAssets = await repository.query('assets', {
      first: 100,
      orderBy: ['ID_ASC'],
      filter: {
        id: { in: ['asset-b', 'asset-c'] },
        or: [{ liquidity: { greaterThan: '0' } }, { liquidityBooks: { greaterThan: '0' } }],
      },
      includeTotalCount: false,
    });
    expect(selectedAssets.items.map(({ id }) => id)).toEqual(['asset-b']);
    assertSource('assets', 'x:id-set');

    metrics.reset();
    const fiatAssets = await repository.query('assets', {
      first: 100,
      orderBy: ['ID_ASC'],
      filter: { priceUSD: { greaterThan: '0' } },
      includeTotalCount: false,
    });
    expect(fiatAssets.items.map(({ id }) => id)).toEqual(['asset-b']);
    assertSource('assets', 'x:assets-price-id');

    metrics.reset();
    const activePools = await repository.query('poolXYKs', {
      first: 100,
      orderBy: ['ID_ASC'],
      filter: {
        baseAssetReserves: { greaterThan: '0' },
        targetAssetReserves: { greaterThan: '0' },
        targetAssetId: { in: ['xor', 'val'] },
      },
      includeTotalCount: false,
    });
    expect(activePools.items.map(({ id }) => id)).toEqual(['pool-a']);
    assertSource('poolXYKs', 'x:t-i');

    metrics.reset();
    const apyPools = await repository.query('poolXYKs', {
      first: 100,
      orderBy: ['ID_ASC'],
      filter: { strategicBonusApy: { greaterThan: '0' } },
      includeTotalCount: false,
    });
    expect(apyPools.items.map(({ id }) => id)).toEqual(['pool-b', 'pool-c']);
    assertSource('poolXYKs', 'x:pools-apy-id');

    metrics.reset();
    const vaults = await repository.query('vaults', {
      first: 100,
      orderBy: ['UPDATED_AT_BLOCK_DESC'],
      filter: { ownerId: { equalTo: 'alice' }, status: { in: ['Closed', 'Liquidated'] } },
      includeTotalCount: false,
    });
    expect(vaults.items.map(({ id }) => id)).toEqual(['vault-a']);
    assertSource('vaults', 'x:o-u');

    metrics.reset();
    const boundedHistory = await repository.query('historyElements', {
      first: 100,
      orderBy: ['ID_ASC'],
      filter: {
        and: [
          { blockHeight: { greaterThanOrEqualTo: 1, lessThanOrEqualTo: 50 } },
          { module: { equalTo: 'assets' } },
          { method: { equalTo: 'burn' } },
          { data: { contains: { assetId: 'xor' } } },
        ],
      },
      includeTotalCount: false,
    });
    expect(boundedHistory.items.map(({ id }) => id)).toEqual(['history-a']);
    assertSource('historyElements', 'x:history-signature-block-id');

    metrics.reset();
    const insensitiveModule = await repository.query('historyElements', {
      first: 100,
      orderBy: ['TIMESTAMP_DESC'],
      filter: { address: { equalTo: 'alice' }, module: { includesInsensitive: 'poolXYK' } },
      includeTotalCount: false,
    });
    expect(insensitiveModule.items.map(({ id }) => id)).toEqual(['history-b']);
    assertSource('historyElements', 'x:a-t');
  });

  it('preserves arbitrary-precision vault updatedAtBlock ordering across compact keys and cursors', async () => {
    const memory = new MemoryRepository();
    const documents: IndexerDocument[] = [
      {
        collection: 'vaults',
        id: 'vault-y-safe',
        data: { id: 'vault-y-safe', ownerId: 'alice', updatedAtBlock: '9007199254740991' },
      },
      {
        collection: 'vaults',
        id: 'vault-z-lower',
        data: { id: 'vault-z-lower', ownerId: 'alice', updatedAtBlock: '9007199254740992' },
      },
      {
        collection: 'vaults',
        id: 'vault-a-higher',
        data: { id: 'vault-a-higher', ownerId: 'alice', updatedAtBlock: '9007199254740993' },
      },
      {
        collection: 'vaults',
        id: 'vault-b-huge',
        data: { id: 'vault-b-huge', ownerId: 'alice', updatedAtBlock: '9'.repeat(80) },
      },
      {
        collection: 'vaults',
        id: 'vault-other-owner',
        data: { id: 'vault-other-owner', ownerId: 'bob', updatedAtBlock: '1'.repeat(80) },
      },
    ];
    await Promise.all([memory.upsertMany(documents), repository.upsertMany(documents)]);

    const args = {
      first: 2,
      orderBy: ['UPDATED_AT_BLOCK_ASC'],
      filter: { ownerId: { equalTo: 'alice' } },
      includeTotalCount: true,
    };
    const [memoryFirst, rocksFirst] = await Promise.all([
      memory.query('vaults', args),
      repository.query('vaults', args),
    ]);
    expect(rocksFirst.items.map(({ id }) => id)).toEqual(memoryFirst.items.map(({ id }) => id));
    expect(rocksFirst.items.map(({ id }) => id)).toEqual(['vault-y-safe', 'vault-z-lower']);
    expect(rocksFirst.totalCount).toBe(4);

    const memoryCursor = decodeRepositoryCursor(memoryFirst.itemCursors?.at(-1));
    const rocksCursor = decodeRepositoryCursor(rocksFirst.itemCursors?.at(-1));
    expect(rocksCursor).toEqual(memoryCursor);
    if (!memoryCursor || !rocksCursor) throw new Error('Vault query did not return valid keyset cursors');

    const [memorySecond, rocksSecond] = await Promise.all([
      memory.query('vaults', { ...args, keyset: memoryCursor }),
      repository.query('vaults', { ...args, keyset: rocksCursor }),
    ]);
    expect(rocksSecond.items.map(({ id }) => id)).toEqual(memorySecond.items.map(({ id }) => id));
    expect(rocksSecond.items.map(({ id }) => id)).toEqual(['vault-a-higher', 'vault-b-huge']);
    expect(rocksSecond.totalCount).toBe(4);

    await memory.close();
  });

  it('counts only rows covered by a partial zero-equality compact index', async () => {
    const memory = new MemoryRepository();
    const documents: IndexerDocument[] = [
      {
        collection: 'historyElements',
        id: 'polkamarkt-old',
        timestamp: 10,
        data: { id: 'polkamarkt-old', module: 'polkamarkt', timestamp: 10 },
      },
      {
        collection: 'historyElements',
        id: 'polkamarkt-new',
        timestamp: 30,
        data: { id: 'polkamarkt-new', module: 'polkamarkt', timestamp: 30 },
      },
      {
        collection: 'historyElements',
        id: 'unrelated-history',
        timestamp: 20,
        data: { id: 'unrelated-history', module: 'system', timestamp: 20 },
      },
    ];
    await Promise.all([memory.upsertMany(documents), repository.upsertMany(documents)]);

    metrics.reset();
    const args = {
      first: 1,
      orderBy: ['TIMESTAMP_DESC'],
      filter: { module: { equalTo: 'polkamarkt' } },
      includeTotalCount: true,
    };
    const [memoryResult, rocksResult] = await Promise.all([
      memory.query('historyElements', args),
      repository.query('historyElements', args),
    ]);
    expect(rocksResult.items.map(({ id }) => id)).toEqual(memoryResult.items.map(({ id }) => id));
    expect(rocksResult.items.map(({ id }) => id)).toEqual(['polkamarkt-new']);
    expect(rocksResult.totalCount).toBe(memoryResult.totalCount);
    expect(rocksResult.totalCount).toBe(2);
    expect(metrics.render()).toContain('collection="historyElements",source="x:p-t"');
    expect(metrics.render()).not.toContain(
      'indexer_rocksdb_query_fast_count_total{collection="historyElements",source="x:p-t"}'
    );

    await memory.close();
  });

  it('bounds exact history-signature scans independently of unrelated collection cardinality', async () => {
    const boundedRepository = new RocksRepository({
      ...createConfig(join(tempDir, 'history-signature-budget.rocksdb')),
      rocksdbQueryMaxScannedRows: 2,
    });
    await boundedRepository.prepare();

    const query = () =>
      boundedRepository.query('historyElements', {
        first: 100,
        orderBy: ['ID_ASC'],
        filter: {
          and: [
            { blockHeight: { greaterThanOrEqualTo: 1, lessThanOrEqualTo: 10_000 } },
            { module: { equalTo: 'assets' } },
            { method: { equalTo: 'burn' } },
            { data: { contains: { assetId: 'xor' } } },
          ],
        },
        includeTotalCount: false,
      });

    try {
      const unrelated = Array.from({ length: 500 }, (_, index) => {
        const blockHeight = index + 1;
        const id = `unrelated-${String(index).padStart(4, '0')}`;
        return {
          collection: 'historyElements' as const,
          id,
          blockHeight,
          timestamp: blockHeight,
          data: {
            id,
            blockHeight,
            timestamp: blockHeight,
            module: 'assets',
            method: 'mint',
            data: { assetId: 'xor' },
          },
        };
      });
      const matching = ['match-a', 'match-b'].map((id, offset) => ({
        collection: 'historyElements' as const,
        id,
        blockHeight: 1_000 + offset,
        timestamp: 1_000 + offset,
        data: {
          id,
          blockHeight: 1_000 + offset,
          timestamp: 1_000 + offset,
          module: 'assets',
          method: 'burn',
          data: { assetId: 'xor' },
        },
      }));
      await boundedRepository.upsertMany([...unrelated, ...matching]);

      metrics.reset();
      await expect(query()).resolves.toMatchObject({
        items: matching.map(({ id }) => expect.objectContaining({ id })),
      });
      expect(metrics.render()).toContain(
        'indexer_rocksdb_query_scanned_rows_total{collection="historyElements",source="x:history-signature-block-id"} 2'
      );

      await boundedRepository.upsert({
        collection: 'historyElements',
        id: 'match-c',
        blockHeight: 1_002,
        timestamp: 1_002,
        data: {
          id: 'match-c',
          blockHeight: 1_002,
          timestamp: 1_002,
          module: 'assets',
          method: 'burn',
          data: { assetId: 'xor' },
        },
      });
      await expect(query()).rejects.toThrow(/2 row scan limit/);
    } finally {
      await boundedRepository.close();
    }
  });

  it.each([
    ['accountPointSystems', 'accountId', 'alice', 'a-i'],
    ['referrerRewards', 'referrer', 'alice', 'r-i'],
    ['poolXYKs', 'baseAssetId', 'xor', 'b-i'],
    ['stakingValidators', 'address', 'alice', 'a-i'],
    ['vaults', 'ownerId', 'alice', 'o-i'],
  ] as const)('uses an ID-equality compact plan for %s.%s', async (collection, field, value, code) => {
    await repository.upsertMany([
      { collection, id: 'match-a', data: { id: 'match-a', [field]: value } },
      { collection, id: 'match-b', data: { id: 'match-b', [field]: value } },
      { collection, id: 'unrelated', data: { id: 'unrelated', [field]: 'other' } },
    ]);

    metrics.reset();
    const result = await repository.query(collection, {
      first: 10,
      filter: { [field]: { equalTo: value } },
      orderBy: ['ID_ASC'],
      includeTotalCount: false,
    });
    expect(result.items.map((document) => document.id)).toEqual(['match-a', 'match-b']);
    expect(metrics.render()).toContain(
      `indexer_rocksdb_query_scanned_rows_total{collection="${collection}",source="x:${code}"} 2`
    );
  });

  it('uses both order-book residual ID indexes for base-or-quote filters', async () => {
    await repository.upsertMany([
      { collection: 'orderBooks', id: 'base-match', data: { id: 'base-match', baseAssetId: 'xor', quoteAssetId: 'val' } },
      { collection: 'orderBooks', id: 'quote-match', data: { id: 'quote-match', baseAssetId: 'eth', quoteAssetId: 'xor' } },
      { collection: 'orderBooks', id: 'unrelated', data: { id: 'unrelated', baseAssetId: 'eth', quoteAssetId: 'val' } },
    ]);

    metrics.reset();
    const result = await repository.query('orderBooks', {
      first: 10,
      filter: { or: [{ baseAssetId: { equalTo: 'xor' } }, { quoteAssetId: { equalTo: 'xor' } }] },
      orderBy: ['ID_ASC'],
      includeTotalCount: false,
    });
    expect(result.items.map((document) => document.id)).toEqual(['base-match', 'quote-match']);
    expect(metrics.render()).toContain(
      'indexer_rocksdb_query_scanned_rows_total{collection="orderBooks",source="x:or-id-equality"} 2'
    );
  });

  it('streams bounded compact ranges for exact counts without an unbounded native count', async () => {
    await repository.upsertMany(
      Array.from({ length: 100 }, (_item, index) => assetSnapshot(`xor-${index + 1}`, 'xor', index + 1))
    );

    metrics.reset();
    const result = await repository.query('assetSnapshots', {
      first: 2,
      filter: {
        and: [
          { assetId: { equalTo: 'xor' } },
          { type: { equalTo: 'DAY' } },
          { timestamp: { greaterThanOrEqualTo: 20, lessThanOrEqualTo: 79, lessThan: null } },
        ],
      },
      orderBy: ['TIMESTAMP_ASC'],
      includeTotalCount: true,
    });

    expect(result.items.map((document) => document.id)).toEqual(['xor-20', 'xor-21']);
    expect(result.totalCount).toBe(60);
    expect(result.hasNextPage).toBe(true);
    expect(metrics.render()).toContain(
      'indexer_rocksdb_query_scanned_rows_total{collection="assetSnapshots",source="x:a-t"} 60'
    );
    expect(metrics.render()).not.toContain('indexer_rocksdb_query_fast_count_total');

    metrics.reset();
    const descending = await repository.query('assetSnapshots', {
      first: 2,
      filter: {
        assetId: { equalTo: 'xor' },
        type: { equalTo: 'DAY' },
        timestamp: { greaterThanOrEqualTo: 20, lessThanOrEqualTo: 79 },
      },
      orderBy: ['TIMESTAMP_DESC'],
      includeTotalCount: true,
    });
    expect(descending.items.map((document) => document.id)).toEqual(['xor-79', 'xor-78']);
    expect(descending.totalCount).toBe(60);
    expect(metrics.render()).toContain(
      'indexer_rocksdb_query_scanned_rows_total{collection="assetSnapshots",source="x:a-t"} 60'
    );
  });

  it('maintains exact compact-prefix counts through moves and last-document deletion', async () => {
    await repository.upsertMany([
      assetSnapshot('move-me', 'xor', 10),
      assetSnapshot('stay', 'xor', 20),
    ]);
    await repository.upsert(assetSnapshot('move-me', 'val', 30));

    const countFor = async (assetId: string) =>
      repository.query('assetSnapshots', {
        first: 0,
        filter: { assetId: { equalTo: assetId }, type: { equalTo: 'DAY' } },
        orderBy: ['TIMESTAMP_ASC'],
        includeTotalCount: true,
      });
    await expect(countFor('xor')).resolves.toMatchObject({ items: [], totalCount: 1 });
    await expect(countFor('val')).resolves.toMatchObject({ items: [], totalCount: 1 });

    await repository.deleteMany('assetSnapshots', ['move-me']);
    await expect(countFor('val')).resolves.toMatchObject({ items: [], totalCount: 0 });
    await expect(repository.validateCompactIndexes()).resolves.toBeUndefined();
  });

  it('keeps missing timestamp and block-height values NULL-like across compact ranges and keyset pages', async () => {
    await repository.upsertMany([
      assetSnapshot('xor-10', 'xor', 10),
      {
        collection: 'assetSnapshots',
        id: 'xor-missing',
        data: { id: 'xor-missing', assetId: 'xor', type: 'DAY' },
      },
      {
        collection: 'assetSnapshots',
        id: 'xor-null',
        timestamp: null,
        blockHeight: null,
        data: { id: 'xor-null', assetId: 'xor', type: 'DAY', timestamp: null, blockHeight: null },
      },
      assetSnapshot('xor-20', 'xor', 20),
    ]);

    const timestampAsc = await repository.query('assetSnapshots', {
      first: 4,
      filter: { assetId: { equalTo: 'xor' }, type: { equalTo: 'DAY' } },
      orderBy: ['TIMESTAMP_ASC'],
      includeTotalCount: true,
    });
    expect(timestampAsc.items.map((document) => document.id)).toEqual(['xor-10', 'xor-20', 'xor-missing', 'xor-null']);
    expect(timestampAsc.totalCount).toBe(4);

    const firstPage = await repository.query('assetSnapshots', {
      first: 1,
      filter: { assetId: { equalTo: 'xor' }, type: { equalTo: 'DAY' } },
      orderBy: ['TIMESTAMP_ASC'],
      includeTotalCount: false,
    });
    const firstKeyset = decodeRepositoryCursor(firstPage.itemCursors?.[0]);
    const afterFirst = await repository.query('assetSnapshots', {
      first: 2,
      filter: { assetId: { equalTo: 'xor' }, type: { equalTo: 'DAY' } },
      orderBy: ['TIMESTAMP_ASC'],
      includeTotalCount: false,
      keyset: firstKeyset,
    });
    expect(firstPage.items.map((document) => document.id)).toEqual(['xor-10']);
    expect(afterFirst.items.map((document) => document.id)).toEqual(['xor-20', 'xor-missing']);

    const timestampDesc = await repository.query('assetSnapshots', {
      first: 4,
      orderBy: ['TIMESTAMP_DESC'],
      includeTotalCount: true,
    });
    expect(timestampDesc.items.map((document) => document.id)).toEqual(['xor-null', 'xor-missing', 'xor-20', 'xor-10']);
    expect(timestampDesc.totalCount).toBe(4);

    const nullKeyset = decodeRepositoryCursor(timestampDesc.itemCursors?.[0]);
    const afterNull = await repository.query('assetSnapshots', {
      first: 3,
      orderBy: ['TIMESTAMP_DESC'],
      includeTotalCount: false,
      keyset: nullKeyset,
    });
    expect(afterNull.items.map((document) => document.id)).toEqual(['xor-missing', 'xor-20', 'xor-10']);

    const missingKeyset = decodeRepositoryCursor(timestampDesc.itemCursors?.[1]);
    const afterMissing = await repository.query('assetSnapshots', {
      first: 2,
      orderBy: ['TIMESTAMP_DESC'],
      includeTotalCount: false,
      keyset: missingKeyset,
    });
    expect(afterMissing.items.map((document) => document.id)).toEqual(['xor-20', 'xor-10']);

    const blockHeight = await repository.query('assetSnapshots', {
      first: 4,
      filter: { assetId: { equalTo: 'xor' } },
      orderBy: ['BLOCK_HEIGHT_ASC'],
      includeTotalCount: true,
    });
    expect(blockHeight.items.map((document) => document.id)).toEqual(['xor-10', 'xor-20', 'xor-missing', 'xor-null']);
    expect(blockHeight.totalCount).toBe(4);
  });

  it('falls back to document validation when a compact range does not cover the complete filter', async () => {
    await repository.upsertMany(
      Array.from({ length: 100 }, (_item, index) => {
        const timestamp = index + 1;
        const snapshot = assetSnapshot(`xor-${timestamp}`, 'xor', timestamp);
        return {
          ...snapshot,
          data: { ...snapshot.data, tag: timestamp === 25 || timestamp === 75 ? 'wanted' : 'other' },
        };
      })
    );

    metrics.reset();
    const result = await repository.query('assetSnapshots', {
      first: 1,
      filter: {
        assetId: { equalTo: 'xor' },
        type: { equalTo: 'DAY' },
        tag: { equalTo: 'wanted' },
      },
      orderBy: ['TIMESTAMP_ASC'],
      includeTotalCount: true,
    });

    expect(result.items.map((document) => document.id)).toEqual(['xor-25']);
    expect(result.totalCount).toBe(2);
    expect(metrics.render()).toContain(
      'indexer_rocksdb_query_scanned_rows_total{collection="assetSnapshots",source="x:a-t"} 100'
    );
    expect(metrics.render()).not.toContain('indexer_rocksdb_query_fast_count_total');
  });

  it.each([
    {
      name: 'missing',
      corrupt: async (db: RocksDatabase, key: Key[]) => db.remove(key),
    },
    {
      name: 'balanced stale and missing',
      corrupt: async (db: RocksDatabase, key: Key[]) => {
        await db.remove(key);
        await db.put([...key.slice(0, -2), 999, key[key.length - 1]], 1);
      },
    },
    {
      name: 'dangling',
      corrupt: async (db: RocksDatabase) => db.put(['x', 'assetSnapshots', 't', 999, 'ghost'], 1),
    },
    {
      name: 'malformed',
      corrupt: async (db: RocksDatabase) => db.put(['x', 'not-a-collection', 't', 1, 'bad'], 1),
    },
  ])('fails exhaustive validation for $name index corruption', async ({ corrupt }) => {
    const snapshot = assetSnapshot('snapshot-a', 'xor', 10);
    await repository.upsert(snapshot);
    const internal = repository as unknown as { db: RocksDatabase };
    const expectedKey = rocksCompactIndexKeysForDocument(snapshot)[0]!;
    await corrupt(internal.db, expectedKey);
    await expect(repository.validateCompactIndexes()).rejects.toThrow('validation failed');
  });

  it('writes type/timestamp compact keys for every query-retained snapshot collection', () => {
    for (const collection of [
      'accountLiquiditySnapshots',
      'assetSnapshots',
      'marketSnapshots',
      'orderBookSnapshots',
      'poolSnapshots',
    ] as const) {
      const document: IndexerDocument = {
        collection,
        id: `${collection}-default-10`,
        blockHeight: 10,
        timestamp: 10,
        data: { id: `${collection}-default-10`, type: 'DEFAULT', timestamp: 10 },
      };
      expect(rocksCompactIndexKeysForDocument(document)).toContainEqual([
        'x',
        collection,
        'y-t',
        'DEFAULT',
        expect.any(String),
        document.id,
      ]);
    }
  });

  it('returns one awaitable close and rejects operations once closing starts', async () => {
    const firstClose = repository.close();
    const secondClose = repository.close();
    expect(secondClose).toBe(firstClose);
    await expect(repository.upsert(assetSnapshot('late', 'xor', 99))).rejects.toThrow('closing');
    await expect(repository.deleteMany('assetSnapshots', ['late'])).rejects.toThrow('closing');
    await expect(repository.setMetadata('late', true)).rejects.toThrow('closing');
    await firstClose;
  });

  it.each([
    { id: '', blockHeight: 1, timestamp: 1, message: /document id/ },
    { id: 'nul\0id', blockHeight: 1, timestamp: 1, message: /document id/ },
    { id: 'unicode-ä', blockHeight: 1, timestamp: 1, message: /document id/ },
    { id: 'contains space', blockHeight: 1, timestamp: 1, message: /document id/ },
    { id: 'x'.repeat(1_025), blockHeight: 1, timestamp: 1, message: /document id/ },
    { id: 'bad-height', blockHeight: -1, timestamp: 1, message: /blockHeight/ },
    { id: 'fractional-height', blockHeight: 1.5, timestamp: 1, message: /blockHeight/ },
    { id: 'unsafe-height', blockHeight: Number.MAX_SAFE_INTEGER + 1, timestamp: 1, message: /blockHeight/ },
    { id: 'bad-time', blockHeight: 1, timestamp: -1, message: /timestamp/ },
    { id: 'fractional-time', blockHeight: 1, timestamp: 1.5, message: /timestamp/ },
    { id: 'unsafe-time', blockHeight: 1, timestamp: Number.MAX_SAFE_INTEGER + 1, message: /timestamp/ },
  ])('rejects malformed write-boundary input %#', async ({ id, blockHeight, timestamp, message }) => {
    await expect(
      repository.upsert({ collection: 'assetSnapshots', id, blockHeight, timestamp, data: { id } })
    ).rejects.toThrow(message);
  });

  it.each([
    [{ collection: 'unknown', id: 'id', data: {} }, /collection/],
    [{ collection: 'assets', id: 'id', data: [] }, /data/],
    [{ collection: 'assets', id: 'id', data: new (class DocumentData {})() }, /data/],
    [{ collection: 'assets', id: 'id', data: { bad: 1n } }, /non-JSON bigint/],
    [{ collection: 'assets', id: 'id', data: { bad: Number.POSITIVE_INFINITY } }, /finite JSON number/],
    [{ collection: 'assets', id: 'id', data: { bad: new Date() } }, /plain objects/],
  ])('rejects malformed structural write-boundary input %#', async (document, message) => {
    await expect(repository.upsert(document as unknown as IndexerDocument)).rejects.toThrow(message);
  });

  it('rejects cyclic RocksDB document data', async () => {
    const data: Record<string, unknown> = {};
    data.self = data;
    await expect(repository.upsert({ collection: 'assets', id: 'cyclic', data })).rejects.toThrow(/cycle/);
  });

  it('rejects invalid delete collection and ids before mutating RocksDB', async () => {
    await repository.upsert({ collection: 'assets', id: 'kept', data: { id: 'kept' } });
    await expect(repository.deleteMany('unknown' as never, ['kept'])).rejects.toThrow(/collection/);
    await expect(repository.deleteMany('assets', ['contains space'])).rejects.toThrow(/document id/);
    await expect(repository.get('assets', 'kept')).resolves.not.toBeNull();
  });

  it('accepts the cursor-safe document ID boundary', async () => {
    const id = 'x'.repeat(1_024);
    await expect(repository.upsert({ collection: 'assets', id, data: { id } })).resolves.toBeUndefined();
    await expect(repository.get('assets', id)).resolves.toMatchObject({ id });
  });

  it('uses compact keyset cursors without gaps or offset rescans', async () => {
    await repository.upsertMany([
      assetSnapshot('xor-10', 'xor', 10),
      assetSnapshot('xor-20', 'xor', 20),
      assetSnapshot('xor-30', 'xor', 30),
      assetSnapshot('xor-40', 'xor', 40),
    ]);

    const query = {
      first: 2,
      filter: { assetId: { equalTo: 'xor' }, type: { equalTo: 'DAY' } },
      orderBy: ['TIMESTAMP_ASC'],
      includeTotalCount: false,
    } as const;
    const firstPage = await repository.query('assetSnapshots', query);
    const keyset = decodeRepositoryCursor(firstPage.itemCursors?.[1]);
    expect(keyset).toMatchObject({ field: 'timestamp', value: '20', id: 'xor-20' });

    const secondPage = await repository.query('assetSnapshots', {
      ...query,
      keyset,
    });

    expect(secondPage.items.map((document) => document.id)).toEqual(['xor-30', 'xor-40']);
    expect(decodeRepositoryCursor(secondPage.itemCursors?.[0])).toMatchObject({ id: 'xor-30' });
    expect(secondPage.hasPreviousPage).toBe(true);
  });

  it('uses document-key keysets for compact ID ordering', async () => {
    await repository.upsertMany([
      assetSnapshot('a', 'xor', 10),
      assetSnapshot('b', 'xor', 20),
      assetSnapshot('c', 'xor', 30),
      assetSnapshot('d', 'xor', 40),
    ]);

    const firstPage = await repository.query('assetSnapshots', {
      first: 2,
      orderBy: ['ID_ASC'],
      includeTotalCount: false,
    });
    const keyset = decodeRepositoryCursor(firstPage.itemCursors?.[1]);
    const secondPage = await repository.query('assetSnapshots', {
      first: 2,
      orderBy: ['ID_ASC'],
      includeTotalCount: false,
      keyset,
    });

    expect(firstPage.items.map((document) => document.id)).toEqual(['a', 'b']);
    expect(secondPage.items.map((document) => document.id)).toEqual(['c', 'd']);
  });

  it('keeps filtered fallback ID pages in binary key order', async () => {
    await repository.upsertMany([
      assetSnapshot('a', 'xor', 10),
      assetSnapshot('Z', 'xor', 20),
    ]);

    const firstPage = await repository.query('assetSnapshots', {
      first: 1,
      filter: { type: { equalTo: 'DAY' } },
      orderBy: ['ID_ASC'],
      includeTotalCount: false,
    });
    const keyset = decodeRepositoryCursor(firstPage.itemCursors?.[0]);
    const secondPage = await repository.query('assetSnapshots', {
      first: 1,
      filter: { type: { equalTo: 'DAY' } },
      orderBy: ['ID_ASC'],
      includeTotalCount: false,
      keyset,
    });

    expect(firstPage.items.map((document) => document.id)).toEqual(['Z']);
    expect(secondPage.items.map((document) => document.id)).toEqual(['a']);
  });

  it('keeps direct document-key ID pages consistent with their one-shot order', async () => {
    await repository.upsertMany([
      assetSnapshot('a', 'xor', 10),
      assetSnapshot('Z', 'xor', 20),
      assetSnapshot('_', 'xor', 30),
    ]);
    const all = await repository.query('assetSnapshots', {
      first: 3,
      orderBy: ['ID_ASC'],
      includeTotalCount: false,
    });

    const paged: string[] = [];
    let keyset = null;
    for (let index = 0; index < 3; index += 1) {
      const page = await repository.query('assetSnapshots', {
        first: 1,
        orderBy: ['ID_ASC'],
        includeTotalCount: false,
        ...(keyset ? { keyset } : {}),
      });
      paged.push(...page.items.map((document) => document.id));
      keyset = decodeRepositoryCursor(page.itemCursors?.[0]);
    }
    expect(paged).toEqual(all.items.map((document) => document.id));
  });

  it('bounds account metadata by immutable creation time before sorting mutable timestamps', async () => {
    await repository.upsertMany(
      Array.from({ length: 100 }, (_item, index) => {
        const createdAtTimestamp = index + 1;
        return {
          collection: 'accountMeta' as const,
          id: `account-${createdAtTimestamp}`,
          timestamp: 1_000 - createdAtTimestamp,
          data: { id: `account-${createdAtTimestamp}`, createdAtTimestamp },
        };
      })
    );

    metrics.reset();
    const result = await repository.query('accountMeta', {
      first: 10,
      filter: { createdAtTimestamp: { greaterThanOrEqualTo: 90, lessThanOrEqualTo: 92 } },
      orderBy: ['TIMESTAMP_ASC'],
      includeTotalCount: false,
    });

    expect(result.items.map((document) => document.id)).toEqual(['account-92', 'account-91', 'account-90']);
    expect(metrics.render()).toContain(
      'indexer_rocksdb_query_scanned_rows_total{collection="accountMeta",source="x:account-created"} 3'
    );
  });

  it('uses the market snapshot block-height index for final pre-close lookups', async () => {
    await repository.upsertMany([
      {
        collection: 'marketSnapshots',
        id: 'market-7-default-80',
        blockHeight: 80,
        timestamp: 80,
        data: { id: 'market-7-default-80', marketId: 7, type: 'DEFAULT', blockHeight: 80, timestamp: 80 },
      },
      {
        collection: 'marketSnapshots',
        id: 'market-7-day-90',
        blockHeight: 90,
        timestamp: 90,
        data: { id: 'market-7-day-90', marketId: 7, type: 'DAY', blockHeight: 90, timestamp: 90 },
      },
      {
        collection: 'marketSnapshots',
        id: 'market-8-default-95',
        blockHeight: 95,
        timestamp: 95,
        data: { id: 'market-8-default-95', marketId: 8, type: 'DEFAULT', blockHeight: 95, timestamp: 95 },
      },
    ]);

    metrics.reset();
    const result = await repository.query('marketSnapshots', {
      first: 1,
      orderBy: ['BLOCK_HEIGHT_DESC'],
      filter: {
        // Numeric compact equality prefixes canonicalize number/string forms.
        marketId: { equalTo: '7.00' },
        type: { equalTo: 'DEFAULT' },
        blockHeight: { lessThanOrEqualTo: 100 },
      },
      includeTotalCount: false,
    });

    expect(result.items.map((document) => document.id)).toEqual(['market-7-default-80']);
    expect(metrics.render()).toContain('source="x:mt-b"');
  });

  it('removes stale secondary index entries on update and delete', async () => {
    await repository.upsert(assetSnapshot('snapshot-a', 'xor', 10));
    await repository.upsert(assetSnapshot('snapshot-a', 'val', 20));

    const oldAsset = await repository.query('assetSnapshots', {
      filter: { assetId: { equalTo: 'xor' } },
      orderBy: ['ID_ASC'],
      includeTotalCount: true,
    });
    const newAsset = await repository.query('assetSnapshots', {
      filter: { assetId: { equalTo: 'val' } },
      orderBy: ['ID_ASC'],
      includeTotalCount: true,
    });

    expect(oldAsset.items).toEqual([]);
    expect(oldAsset.totalCount).toBe(0);
    expect(newAsset.items.map((document) => document.id)).toEqual(['snapshot-a']);
    expect(newAsset.totalCount).toBe(1);

    await repository.deleteMany('assetSnapshots', ['snapshot-a']);

    const deleted = await repository.query('assetSnapshots', {
      filter: { assetId: { equalTo: 'val' } },
      orderBy: ['ID_ASC'],
      includeTotalCount: true,
    });

    expect(deleted.items).toEqual([]);
    expect(deleted.totalCount).toBe(0);
  });

  it('does not read stale legacy equality indexes after compact activation', async () => {
    await repository.upsert(assetSnapshot('snapshot-a', 'xor', 10));
    await repository.upsert(assetSnapshot('snapshot-a', 'val', 20));

    const oldAsset = await repository.query('assetSnapshots', {
      filter: { assetId: { equalTo: 'xor' } },
      orderBy: ['ID_ASC'],
      includeTotalCount: true,
    });
    const newAsset = await repository.query('assetSnapshots', {
      filter: { assetId: { equalTo: 'val' } },
      orderBy: ['ID_ASC'],
      includeTotalCount: true,
    });

    expect(oldAsset.items).toEqual([]);
    expect(newAsset.items.map((document) => document.id)).toEqual(['snapshot-a']);
  });

  it('falls back to filtered scans for OR filters while preserving compatibility', async () => {
    await repository.upsertMany([
      {
        collection: 'historyElements',
        id: 'history-1',
        timestamp: 10,
        data: { id: 'history-1', timestamp: 10, address: 'alice', method: 'transfer' },
      },
      {
        collection: 'historyElements',
        id: 'history-2',
        timestamp: 30,
        data: { id: 'history-2', timestamp: 30, dataTo: 'alice', method: 'swap' },
      },
      {
        collection: 'historyElements',
        id: 'history-3',
        timestamp: 20,
        data: { id: 'history-3', timestamp: 20, dataFrom: 'bob', method: 'transfer' },
      },
    ]);

    const result = await repository.query('historyElements', {
      filter: {
        or: [{ address: { equalTo: 'alice' } }, { dataTo: { equalTo: 'alice' } }],
      },
      orderBy: ['TIMESTAMP_DESC'],
      includeTotalCount: true,
    });

    expect(result.items.map((document) => document.id)).toEqual(['history-2', 'history-1']);
    expect(result.totalCount).toBe(2);
  });

  it('merges compact history ranges in timestamp order and deduplicates overlapping OR branches', async () => {
    await repository.upsertMany([
      {
        collection: 'historyElements',
        id: 'history-10',
        timestamp: 10,
        data: { id: 'history-10', timestamp: 10, address: 'alice', method: 'transfer' },
      },
      {
        collection: 'historyElements',
        id: 'history-20',
        timestamp: 20,
        data: { id: 'history-20', timestamp: 20, address: 'alice', dataTo: 'alice', method: 'swap' },
      },
      {
        collection: 'historyElements',
        id: 'history-30',
        timestamp: 30,
        data: { id: 'history-30', timestamp: 30, address: 'bob', method: 'transfer' },
      },
      {
        collection: 'historyElements',
        id: 'history-40',
        timestamp: 40,
        data: { id: 'history-40', timestamp: 40, address: 'carol', method: 'transfer' },
      },
    ]);

    metrics.reset();
    const result = await repository.query('historyElements', {
      filter: {
        and: [
          {
            or: [
              { address: { equalTo: 'alice' } },
              { address: { equalTo: 'bob' } },
              { address: { equalTo: 'alice' } },
            ],
          },
          { timestamp: { greaterThanOrEqualTo: 15 } },
        ],
      },
      orderBy: ['TIMESTAMP_DESC'],
      includeTotalCount: true,
    });

    expect(result.items.map((document) => document.id)).toEqual(['history-30', 'history-20']);
    expect(result.totalCount).toBe(2);
    expect(metrics.render()).toContain('source="x:or-t"');
  });

  it('orders numeric fields through numeric secondary indexes', async () => {
    await repository.upsertMany([
      {
        collection: 'assets',
        id: 'asset-low',
        data: { id: 'asset-low', priceUSD: '2' },
      },
      {
        collection: 'assets',
        id: 'asset-high',
        data: { id: 'asset-high', priceUSD: '10' },
      },
      {
        collection: 'assets',
        id: 'asset-missing',
        data: { id: 'asset-missing' },
      },
    ]);

    metrics.reset();
    const result = await repository.query('assets', {
      first: 3,
      orderBy: ['PRICE_USD_DESC'],
      includeTotalCount: true,
    });

    expect(result.items.map((document) => document.id)).toEqual(['asset-missing', 'asset-high', 'asset-low']);
    expect(result.totalCount).toBe(3);
    expect(metrics.render()).toContain('collection="assets",source="x:num"');
  });

  it('orders arbitrary-precision decimals without truncation collisions', async () => {
    const values = [
      ['negative-huge', `-${'9'.repeat(81)}`],
      ['negative-fraction', `-0.${'0'.repeat(40)}2`],
      ['zero', '0'],
      ['fraction-one', `0.${'0'.repeat(40)}1`],
      ['fraction-two', `0.${'0'.repeat(40)}2`],
      ['huge-80', `1${'0'.repeat(80)}`],
      ['huge-81', `1${'0'.repeat(81)}`],
    ] as const;
    await repository.upsertMany(
      values.map(([id, priceUSD]) => ({ collection: 'assets', id, data: { id, priceUSD } }))
    );

    const result = await repository.query('assets', {
      first: values.length,
      orderBy: ['PRICE_USD_ASC'],
      includeTotalCount: true,
    });
    expect(result.items.map((document) => document.id)).toEqual([
      'negative-huge',
      'negative-fraction',
      'zero',
      'fraction-one',
      'fraction-two',
      'huge-80',
      'huge-81',
    ]);
    expect(new Set(result.itemCursors).size).toBe(values.length);
    await expect(repository.validateCompactIndexes()).resolves.toBeUndefined();
  });

  it('uses exact arbitrary-precision numeric bounds to restrict the global ordered source', async () => {
    const prefix = '9'.repeat(80);
    const lower = `${prefix}889`;
    const middle = `${prefix}890`;
    const upper = `${prefix}891`;
    await repository.upsertMany([
      { collection: 'assets', id: 'below', data: { id: 'below', priceUSD: lower } },
      { collection: 'assets', id: 'middle', data: { id: 'middle', priceUSD: middle } },
      { collection: 'assets', id: 'upper', data: { id: 'upper', priceUSD: upper } },
      { collection: 'assets', id: 'above', data: { id: 'above', priceUSD: `${prefix}892` } },
      { collection: 'assets', id: 'small', data: { id: 'small', priceUSD: '1' } },
    ]);

    metrics.reset();
    const result = await repository.query('assets', {
      first: 10,
      orderBy: ['PRICE_USD_ASC'],
      filter: { priceUSD: { greaterThan: lower, lessThanOrEqualTo: upper } },
      includeTotalCount: false,
    });

    expect(result.items.map((document) => document.id)).toEqual(['middle', 'upper']);
    expect(metrics.render()).toContain(
      'indexer_rocksdb_query_scanned_rows_total{collection="assets",source="x:num"} 2'
    );
    expect(metrics.render()).not.toContain('indexer_rocksdb_query_fallback_total{collection="assets"');
  });

  it.each(['1e100', 'NaN', 'Infinity', `1${'0'.repeat(4_096)}`])(
    'rejects out-of-domain indexed decimals %s',
    async (priceUSD) => {
      await expect(
        repository.upsert({ collection: 'assets', id: `invalid-${priceUSD.length}`, data: { priceUSD } })
      ).rejects.toThrow(/Invalid indexed decimal/);
    }
  );

  it('indexes absent compact numeric values with NULL-like ordering', async () => {
    await repository.upsertMany([
      {
        collection: 'assets',
        id: 'asset-low',
        data: { id: 'asset-low', priceUSD: '2' },
      },
      {
        collection: 'assets',
        id: 'asset-high',
        data: { id: 'asset-high', priceUSD: '10' },
      },
      {
        collection: 'assets',
        id: 'asset-missing',
        data: { id: 'asset-missing' },
      },
    ]);

    metrics.reset();
    const result = await repository.query('assets', {
      first: 3,
      orderBy: ['PRICE_USD_DESC'],
      includeTotalCount: true,
    });

    expect(result.items.map((document) => document.id)).toEqual(['asset-missing', 'asset-high', 'asset-low']);
    expect(result.totalCount).toBe(3);
    expect(metrics.render()).toContain('collection="assets",source="x:num"');
  });

  it.each([
    ['ASC', ['zero', 'two', 'missing-a', 'missing-b']],
    ['DESC', ['missing-b', 'missing-a', 'two', 'zero']],
  ] as const)('paginates missing/null numeric values consistently in %s order', async (direction, expected) => {
    await repository.upsertMany([
      { collection: 'assets', id: 'missing-a', data: { id: 'missing-a' } },
      { collection: 'assets', id: 'missing-b', data: { id: 'missing-b', priceUSD: null } },
      { collection: 'assets', id: 'zero', data: { id: 'zero', priceUSD: '0' } },
      { collection: 'assets', id: 'two', data: { id: 'two', priceUSD: '2' } },
    ]);

    const ids: string[] = [];
    let keyset = null;
    for (let page = 0; page < 3; page += 1) {
      const result = await repository.query('assets', {
        first: 2,
        orderBy: [`PRICE_USD_${direction}`],
        includeTotalCount: false,
        ...(keyset ? { keyset } : {}),
      });
      ids.push(...result.items.map((document) => document.id));
      keyset = decodeRepositoryCursor(result.itemCursors?.at(-1));
      if (!result.hasNextPage) break;
    }
    expect(ids).toEqual(expected);
  });

  it('publishes in-process watch updates', async () => {
    const watcher = repository.watch('assetSnapshots', ['watched']);
    const next = watcher.next();

    await repository.upsert(assetSnapshot('ignored', 'xor', 1));
    await repository.upsert(assetSnapshot('watched', 'xor', 2));

    await expect(next).resolves.toMatchObject({
      value: { collection: 'assetSnapshots', id: 'watched', mutationType: 'INSERT' },
      done: false,
    });

    await watcher.return(undefined);
  });

  it('retains only the latest pending version per watched id and still drops the oldest distinct id', async () => {
    const watcher = repository.watch('assetSnapshots');
    const firstPending = watcher.next();
    await Promise.resolve();
    const internal = repository as unknown as {
      events: {
        emit(
          name: string,
          event: { collection: 'assetSnapshots'; id: string; mutationType: 'INSERT' | 'UPDATE' | 'DELETE' }
        ): void;
      };
    };

    for (let version = 0; version < 1_000; version += 1) {
      internal.events.emit('document', {
        collection: 'assetSnapshots',
        id: 'hot-snapshot',
        mutationType: version === 999 ? 'DELETE' : 'UPDATE',
      });
    }

    await expect(firstPending).resolves.toMatchObject({
      done: false,
      value: { id: 'hot-snapshot', mutationType: 'DELETE' },
    });
    expect(repository.metricsSnapshot()).toMatchObject({ rocksdb_watch_queue_drops_total: 0 });

    for (let index = 0; index <= 1_000; index += 1) {
      internal.events.emit('document', {
        collection: 'assetSnapshots',
        id: `distinct-${index}`,
        mutationType: 'UPDATE',
      });
    }
    await expect(watcher.next()).resolves.toMatchObject({ value: { id: 'distinct-1' }, done: false });
    expect(repository.metricsSnapshot()).toMatchObject({ rocksdb_watch_queue_drops_total: 1 });

    await watcher.return(undefined);
  });

  it('aborts an idle RocksDB watcher immediately', async () => {
    const controller = new AbortController();
    const watcher = repository.watch('assetSnapshots', ['never-updated'], controller.signal);
    const pending = watcher.next();

    controller.abort();

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
  });

  it('completes an idle watcher promptly when the repository closes', async () => {
    const watcher = repository.watch('assetSnapshots', ['never-updated']);
    const pending = watcher.next();
    await Promise.resolve();

    await repository.close();

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
  });

  it('gives each watcher a payload-free identity and keeps stored documents owned', async () => {
    const firstWatcher = repository.watch('assetSnapshots', ['watched']);
    const secondWatcher = repository.watch('assetSnapshots', ['watched']);
    const firstNext = firstWatcher.next();
    const secondNext = secondWatcher.next();

    await repository.upsert(assetSnapshot('watched', 'xor', 2));
    const first = await firstNext;
    expect(first.done).toBe(false);
    expect(first.value).toEqual({
      collection: 'assetSnapshots',
      id: 'watched',
      mutationType: 'INSERT',
    });

    await expect(secondNext).resolves.toMatchObject({
      value: first.value,
      done: false,
    });
    await expect(repository.get('assetSnapshots', 'watched')).resolves.toMatchObject({ data: { assetId: 'xor' } });

    await firstWatcher.return(undefined);
    await secondWatcher.return(undefined);
  });

  it('opens an existing checkpoint through a truly read-only repository', async () => {
    const databasePath = join(tempDir, 'indexer.rocksdb');
    const snapshot = assetSnapshot('read-only', 'xor', 10);
    await repository.upsert(snapshot);
    await repository.close();

    repository = RocksRepository.openReadOnly(createConfig(databasePath));
    await expect(repository.prepare()).resolves.toBeUndefined();
    await expect(repository.validateCompactIndexes()).resolves.toBeUndefined();
    await expect(repository.get('assetSnapshots', snapshot.id)).resolves.toEqual(snapshot);
    await expect(repository.upsert(assetSnapshot('blocked', 'xor', 20))).rejects.toThrow('read-only');
    await expect(repository.deleteMany('assetSnapshots', [snapshot.id])).rejects.toThrow('read-only');
    await expect(repository.setMetadata('blocked', true)).rejects.toThrow('read-only');
  });
});
