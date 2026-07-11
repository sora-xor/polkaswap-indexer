import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RocksDatabase } from '@harperfast/rocksdb-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RocksRepository, rocksCompactIndexKeysForDocument } from '../src/repository/rocksdb.js';
import {
  buildRocksAuditReport,
  readFinalizedBlock,
  readRocksAuditChainTimeoutMs,
  type ChainAuditApiModule,
} from '../src/scripts/audit-rocksdb.js';

import type { AppConfig } from '../src/config.js';
import type { IndexerDocument } from '../src/repository/types.js';

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

describe('RocksDB audit report', () => {
  let tempDir: string;
  let databasePath: string;
  let repository: RocksRepository | null;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'polkaswap-rocksdb-audit-'));
    databasePath = join(tempDir, 'indexer.rocksdb');
    repository = new RocksRepository(createConfig(databasePath));
    await repository.prepare();
  });

  afterEach(async () => {
    await repository?.close().catch(() => undefined);
    await rm(tempDir, { recursive: true, force: true });
  });

  it('reports format state, worker lag, and sampled missing/dangling compact indexes', async () => {
    const snapshot: IndexerDocument = {
      collection: 'assetSnapshots',
      id: 'xor-day-10',
      blockHeight: 10,
      timestamp: 10,
      data: { id: 'xor-day-10', assetId: 'xor', type: 'DAY', blockHeight: 10, timestamp: 10 },
    };
    const chainState: IndexerDocument = {
      collection: 'updatesStreams',
      id: 'chainState',
      blockHeight: 42,
      timestamp: 100,
      data: { id: 'chainState', block: 42, data: JSON.stringify({ lastIndexedBlock: 42 }) },
    };
    await repository!.upsertMany([snapshot, chainState]);
    await repository!.close();
    repository = null;

    const writable = RocksDatabase.open(databasePath);
    const missingKey = rocksCompactIndexKeysForDocument(snapshot)[0]!;
    await writable.remove(missingKey);
    await writable.put(['x', 'assetSnapshots', 'a-t', 'ghost', 'DAY', 999, 'ghost'], 1);
    await writable.put(['i', 'ts', 'assetSnapshots', 10, snapshot.id], 1);
    writable.close();

    const readonly = RocksDatabase.open(databasePath, { readOnly: true });
    try {
      const report = buildRocksAuditReport(readonly, {
        sampleSize: 100,
        finalizedBlock: 45,
        nowMs: 200_000,
      });

      expect(report.format).toMatchObject({
        version: 1,
        expectedVersion: 1,
        ready: true,
        unexpectedIndexNamespaceKeys: 1,
      });
      expect(report.chainState).toMatchObject({
        present: true,
        indexedBlock: 42,
        finalizedBlock: 45,
        lagBlocks: 3,
        updatedAt: 100,
        ageSeconds: 100,
      });
      expect(report.compactIndexIntegrity).toMatchObject({
        perCollectionSampleLimit: 4,
        missingCheckEnabled: true,
        missingCompactIndexes: 1,
        danglingCompactIndexes: 1,
        fullValidationPassed: false,
        healthy: false,
      });
      expect(report.compactIndexIntegrity.documentSamplesByCollection).toMatchObject({
        assetSnapshots: 1,
        updatesStreams: 1,
      });
      expect(report.compactIndexIntegrity.compactIndexSamplesByCollection.assetSnapshots).toBeGreaterThan(0);
      expect(report.compactIndexIntegrity.missingExamples).toContainEqual(missingKey);
      expect(report.compactIndexIntegrity.danglingExamples).toContainEqual(
        expect.objectContaining({ reason: 'missing_document' })
      );
    } finally {
      readonly.close();
    }
  });

  it('fails the release gate for physical count drift, excessive lag, or stale worker state', async () => {
    await repository!.upsertMany([
      {
        collection: 'assets',
        id: 'xor',
        blockHeight: 10,
        timestamp: 100,
        data: { id: 'xor', blockHeight: 10, timestamp: 100 },
      },
      {
        collection: 'updatesStreams',
        id: 'chainState',
        blockHeight: 10,
        timestamp: 100,
        data: { id: 'chainState', block: 10, data: JSON.stringify({ lastIndexedBlock: 10 }) },
      },
    ]);
    await repository!.close();
    repository = null;

    const writable = RocksDatabase.open(databasePath);
    await writable.put(['m', 'count', 'assets'], 99);
    writable.close();

    const readonly = RocksDatabase.open(databasePath, { readOnly: true });
    try {
      const report = buildRocksAuditReport(readonly, {
        sampleSize: 100,
        finalizedBlock: 20,
        requireChain: true,
        maxLagBlocks: 2,
        maxStateAgeSeconds: 30,
        nowMs: 200_000,
        fullValidationPassed: true,
      });

      expect(report.collectionCountMismatches).toContainEqual({
        collection: 'assets',
        stored: 99,
        physical: 1,
      });
      expect(report.releaseGate).toMatchObject({
        healthy: false,
        countsHealthy: false,
        compactIntegrityHealthy: true,
        formatHealthy: true,
        chainHealthy: false,
      });
      expect(report.chainState).toMatchObject({ lagBlocks: 10, ageSeconds: 100 });
    } finally {
      readonly.close();
    }
  });

  it('does not let a healthy sample substitute for exhaustive validation', async () => {
    const documents = Array.from({ length: 20 }, (_item, index): IndexerDocument => ({
      collection: 'assetSnapshots',
      id: `snapshot-${String(index).padStart(2, '0')}`,
      blockHeight: index,
      timestamp: index,
      data: { id: `snapshot-${String(index).padStart(2, '0')}`, assetId: 'xor', type: 'DAY' },
    }));
    await repository!.upsertMany(documents);
    await repository!.close();
    repository = null;

    const writable = RocksDatabase.open(databasePath);
    await writable.remove(rocksCompactIndexKeysForDocument(documents[10]!)[0]!);
    writable.close();

    const validating = RocksRepository.openReadOnly(createConfig(databasePath));
    await validating.prepare();
    await expect(validating.validateCompactIndexes()).rejects.toThrow('validation failed');
    await validating.close();

    const readonly = RocksDatabase.open(databasePath, { readOnly: true });
    try {
      const report = buildRocksAuditReport(readonly, { sampleSize: 1, fullValidationPassed: false });
      expect(report.compactIndexIntegrity).toMatchObject({
        sampleHealthy: true,
        fullValidationPassed: false,
        healthy: false,
      });
      expect(report.releaseGate).toMatchObject({ healthy: false, compactIntegrityHealthy: false });
    } finally {
      readonly.close();
    }
  });

  it('rejects indexed-ahead-finalized and future worker state', async () => {
    await repository!.upsert({
      collection: 'updatesStreams',
      id: 'chainState',
      blockHeight: 50,
      timestamp: 300,
      data: { id: 'chainState', block: 50, data: JSON.stringify({ lastIndexedBlock: 50 }) },
    });
    await repository!.close();
    repository = null;

    const readonly = RocksDatabase.open(databasePath, { readOnly: true });
    try {
      const report = buildRocksAuditReport(readonly, {
        finalizedBlock: 45,
        nowMs: 200_000,
        requireChain: true,
        fullValidationPassed: true,
      });
      expect(report.chainState).toMatchObject({
        indexedBlock: 50,
        finalizedBlock: 45,
        lagBlocks: -5,
        ageSeconds: -100,
      });
      expect(report.chainState.validationErrors).toEqual([
        'indexed block is ahead of finalized block',
        'worker timestamp is in the future',
      ]);
      expect(report.releaseGate).toMatchObject({ healthy: false, chainHealthy: false });
    } finally {
      readonly.close();
    }
  });
});

describe('RocksDB audit chain deadline', () => {
  it('rejects timeout values that would overflow or make the release gate impractically slow', () => {
    expect(readRocksAuditChainTimeoutMs({})).toBe(10_000);
    expect(readRocksAuditChainTimeoutMs({ ROCKSDB_AUDIT_CHAIN_TIMEOUT_MS: '60000' })).toBe(60_000);
    expect(() =>
      readRocksAuditChainTimeoutMs({ ROCKSDB_AUDIT_CHAIN_TIMEOUT_MS: '60001' })
    ).toThrow('at most 60000');
  });

  it.each(['finalized head', 'finalized header'] as const)(
    'bounds a stalled %s RPC and disconnects both chain resources',
    async (stalledPhase) => {
      const never = new Promise<never>(() => undefined);
      const disconnectApi = vi.fn(async () => undefined);
      const disconnectProvider = vi.fn(async () => undefined);
      const api = {
        rpc: {
          chain: {
            getFinalizedHead: vi.fn(() =>
              stalledPhase === 'finalized head' ? never : Promise.resolve('0x1234')
            ),
            getHeader: vi.fn(() => never),
          },
        },
        disconnect: disconnectApi,
      };
      class FakeWsProvider {
        disconnect = disconnectProvider;
      }
      const loadApi = async () =>
        ({
          ApiPromise: { create: async () => api },
          WsProvider: FakeWsProvider,
        }) as unknown as ChainAuditApiModule;

      const startedAt = Date.now();
      const result = await readFinalizedBlock('wss://stalled.invalid', 20, false, loadApi);

      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(result).toEqual({ finalizedBlock: null, error: 'chain check timed out after 20ms' });
      expect(disconnectApi).toHaveBeenCalledOnce();
      expect(disconnectProvider).toHaveBeenCalledOnce();
    }
  );
});
