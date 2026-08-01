import { describe, expect, it, vi } from 'vitest';

import { estimateRetainedValueBytes } from '../src/cache-weight.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { createGraphQLHandler } from '../src/server.js';
import { createPersistedWorkerStatusDocument } from '../src/worker/status.js';
import {
  createPinnedWalletHistoryFilter,
  PINNED_WALLET_HISTORY_DOCUMENT,
  PINNED_WALLET_OPERATION_CRITERIA,
} from './pinned-wallet-history-fixture.js';

import type { AppConfig } from '../src/config.js';

const config: AppConfig = {
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
  storageEngine: 'postgres',
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
  rocksdbPath: './data/polkaswap-indexer.rocksdb',
  rocksdbBlockCacheMb: 512,
  rocksdbWriteBufferManagerMb: 256,
  rocksdbParallelism: 4,
  rocksdbEnableStats: false,
  rocksdbDocumentCacheMax: 10_000,
  rocksdbDocumentCacheMaxBytes: 268_435_456,
  rocksdbWatchQueueMax: 1_000,
  rocksdbQueryMaxScannedRows: 100_000,
  rocksdbCompactionMinFreeGb: 10,
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
};

const post = (
  yoga: ReturnType<typeof createGraphQLHandler>['yoga'],
  query: string,
  accept = 'application/json'
) =>
  yoga.fetch('http://localhost/graphql', {
    method: 'POST',
    headers: { accept, 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });

describe('production GraphQL handler', () => {
  it('executes a normal request without binding a TCP port', async () => {
    const now = Math.floor(Date.now() / 1_000);
    const repository = new MemoryRepository();
    await repository.upsert(
      createPersistedWorkerStatusDocument({
        lifecycle: 'running',
        startupComplete: true,
        latestFinalizedBlock: 1_000,
        latestIndexedBlock: 995,
        lag: 5,
        lastSuccessfulIndexTimestamp: now,
        lastError: null,
        lastErrorTimestamp: null,
      })
    );
    const { yoga } = createGraphQLHandler(config, repository);
    const response = await post(yoga, '{ _health { ok serviceId readOnly } }');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { _health: { ok: false, serviceId: 'pi.soramitsu.io', readOnly: true } },
    });
  });

  it('applies introspection, alias, and connection-cost limits before resolvers', async () => {
    const repository = new MemoryRepository();
    const query = async (source: string, overrides: Partial<AppConfig> = {}) => {
      const { yoga } = createGraphQLHandler({ ...config, ...overrides }, repository);
      const response = await post(yoga, source);
      return {
        response,
        body: (await response.json()) as {
          errors?: Array<{ message: string; extensions?: { code?: string } }>;
        },
      };
    };

    const introspection = await query('{ __schema { queryType { name } } }');
    expect(introspection.response.status).toBe(200);
    expect(introspection.body.errors?.[0]?.message).toContain('introspection is disabled');
    expect(introspection.body.errors?.[0]?.extensions?.code).toBe('GRAPHQL_QUERY_LIMIT_EXCEEDED');

    const aliases = await query('{ a: mobileConfig { soracard } b: mobileConfig { soracard } }', {
      graphqlMaxAliases: 1,
    });
    expect(aliases.response.status).toBe(200);
    expect(aliases.body.errors?.[0]?.message).toContain('aliases');
    expect(aliases.body.errors?.[0]?.extensions?.code).toBe('GRAPHQL_QUERY_LIMIT_EXCEEDED');

    const expensive = await query('{ assets(first: 1000000000) { nodes { id } } }', {
      graphqlMaxOperationCost: 10_000,
    });
    expect(expensive.response.status).toBe(200);
    expect(expensive.body.errors?.[0]?.message).toContain('estimated cost');
    expect(expensive.body.errors?.[0]?.extensions?.code).toBe('GRAPHQL_QUERY_LIMIT_EXCEEDED');

    const activityAliasAttack = await query(`{
      first: networkAccountActivity(from: 0, to: 100) { activeAccounts }
      second: networkAccountActivity(from: 101, to: 200) { activeAccounts }
    }`);
    expect(activityAliasAttack.response.status).toBe(200);
    expect(activityAliasAttack.body.errors?.[0]?.message).toContain('estimated cost');
    expect(activityAliasAttack.body.errors?.[0]?.extensions?.code).toBe('GRAPHQL_QUERY_LIMIT_EXCEEDED');

    const signalAliasAttack = await query(`{
      first: polkamarktSignals { activeMarkets }
      second: polkamarktSignals { activeMarkets }
    }`);
    expect(signalAliasAttack.response.status).toBe(200);
    expect(signalAliasAttack.body.errors?.[0]?.message).toContain('estimated cost');
    expect(signalAliasAttack.body.errors?.[0]?.extensions?.code).toBe('GRAPHQL_QUERY_LIMIT_EXCEEDED');

    const { yoga } = createGraphQLHandler({ ...config, graphqlMaxAliases: 1 }, repository);
    const negotiated = await post(
      yoga,
      '{ a: mobileConfig { soracard } b: mobileConfig { soracard } }',
      'application/graphql-response+json'
    );
    const negotiatedBody = (await negotiated.json()) as {
      errors?: Array<{ extensions?: { code?: string } }>;
    };
    expect(negotiated.status).toBeGreaterThanOrEqual(400);
    expect(negotiated.status).toBeLessThan(500);
    expect(negotiatedBody.errors?.[0]?.extensions?.code).toBe('GRAPHQL_QUERY_LIMIT_EXCEEDED');
  });

  it('accepts the pinned wallet history document under the default cost budget', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([
      { collection: 'historyElements', id: 'history-a', timestamp: 30, data: { id: 'history-a', timestamp: 30, address: 'alice', module: 'assets', method: 'burn' } },
      { collection: 'historyElements', id: 'history-b', timestamp: 20, data: { id: 'history-b', timestamp: 20, address: 'alice', module: 'assets', method: 'burn' } },
      { collection: 'historyElements', id: 'history-c', timestamp: 10, data: { id: 'history-c', timestamp: 10, address: 'alice', module: 'assets', method: 'burn' } },
    ]);
    const { yoga } = createGraphQLHandler(config, repository);
    expect(PINNED_WALLET_OPERATION_CRITERIA).toHaveLength(39);
    const response = await yoga.fetch('http://localhost/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: PINNED_WALLET_HISTORY_DOCUMENT,
        variables: {
          first: 1,
          last: null,
          offset: 1,
          after: '',
          before: '',
          filter: createPinnedWalletHistoryFilter({ address: 'alice' }),
        },
      }),
    });
    const body = (await response.json()) as { errors?: Array<{ message: string }>; data?: unknown };

    expect(response.status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect(body.data).toMatchObject({
      data: {
        edges: [{ node: { id: 'history-b' } }],
        pageInfo: { hasNextPage: true, hasPreviousPage: true },
        totalCount: 3,
      },
    });

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const oversized = await yoga.fetch('http://localhost/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: PINNED_WALLET_HISTORY_DOCUMENT,
        variables: {
          first: 1,
          offset: 0,
          filter: {
            and: [
              {
                or: Array.from({ length: 100 }, (_item, index) => ({
                  module: { equalTo: `module-${index}` },
                  method: { equalTo: `method-${index}` },
                  address: { equalTo: `account-${index}` },
                  dataFrom: { equalTo: `from-${index}` },
                  dataTo: { equalTo: `to-${index}` },
                })),
              },
            ],
          },
        },
      }),
    });
    const oversizedBody = (await oversized.json()) as {
      errors?: Array<{ message: string; extensions?: { code?: string } }>;
    };
    consoleError.mockRestore();
    expect(oversized.status).toBe(200);
    expect(oversizedBody.errors).toHaveLength(1);
    expect(oversizedBody.errors?.[0]?.message).toContain('maximum input node count');
    expect(oversizedBody.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('returns trusted client errors for invalid policy, cursor, and offset inputs', async () => {
    const repository = new MemoryRepository();
    const { yoga } = createGraphQLHandler(config, repository);
    const execute = async (query: string) => {
      const response = await post(yoga, query);
      const body = (await response.json()) as {
        data?: unknown;
        errors?: Array<{ message: string; extensions?: { code?: string } }>;
      };
      return { response, body };
    };

    const invalidCursor = await execute(
      '{ assets(first: 1, after: "legacy-offset", orderBy: [ID_ASC]) { nodes { id } } }'
    );
    expect(invalidCursor.response.status).toBe(200);
    expect(invalidCursor.body.errors?.[0]?.message).toContain('opaque cursor');
    expect(invalidCursor.body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');

    const unsupportedPlan = await execute(
      '{ assets(first: 1, orderBy: [LIQUIDITY_USD_ASC], filter: { priceUSD: { greaterThan: "0" } }) { nodes { id } } }'
    );
    expect(unsupportedPlan.response.status).toBe(200);
    expect(unsupportedPlan.body.errors?.[0]?.message).toContain('not supported by the public query plan');
    expect(unsupportedPlan.body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');

    const querySpy = vi.spyOn(repository, 'query');
    const unsafeTimestamp = await execute(
      '{ assetSnapshots(first: 1, orderBy: [TIMESTAMP_ASC], filter: { assetId: { equalTo: "xor" }, type: { equalTo: "DAY" }, timestamp: { greaterThanOrEqualTo: "9007199254740992" } }) { nodes { id } } }'
    );
    expect(unsafeTimestamp.response.status).toBe(200);
    expect(unsafeTimestamp.body.errors?.[0]?.message).toContain('non-negative safe integer');
    expect(unsafeTimestamp.body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    expect(querySpy).not.toHaveBeenCalled();
    querySpy.mockRestore();

    const exactOffsetBoundary = await execute(
      '{ assets(first: 1, offset: 99999, orderBy: [ID_ASC]) { nodes { id } } }'
    );
    expect(exactOffsetBoundary.response.status).toBe(200);
    expect(exactOffsetBoundary.body.errors?.[0]?.message).toContain('Unknown argument "offset"');
    expect(exactOffsetBoundary.body.errors?.[0]?.extensions?.code).toBe('GRAPHQL_VALIDATION_FAILED');
  });

  it('bounds connection documents during execution before final result serialization', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany(
      ['history-a', 'history-b', 'history-c'].map((id) => ({
        collection: 'historyElements' as const,
        id,
        data: { id, data: { payload: 'x'.repeat(600_000) } },
      }))
    );
    const querySpy = vi.spyOn(repository, 'query');
    const { yoga } = createGraphQLHandler({ ...config, graphqlMaxResultBytes: 1_000_000 }, repository);
    const response = await post(
      yoga,
      '{ historyElements(first: 3, orderBy: [ID_ASC]) { nodes { id data } pageInfo { hasNextPage } } }'
    );
    const body = (await response.json()) as {
      data?: { historyElements?: { nodes?: Array<{ id: string }>; pageInfo?: { hasNextPage?: boolean } } };
      errors?: unknown[];
    };

    expect(body.errors).toBeUndefined();
    expect(body.data?.historyElements?.nodes?.map(({ id }) => id)).toEqual(['history-a']);
    expect(body.data?.historyElements?.pageInfo?.hasNextPage).toBe(true);
    expect(querySpy).toHaveBeenCalledWith(
      'historyElements',
      expect.objectContaining({ first: 3, maxBytes: 1_000_000 })
    );
  });

  it('shares one serialized materialization budget across concurrent connection aliases', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany(
      ['a', 'b', 'c'].map((id) => ({
        collection: 'assets' as const,
        id,
        data: { id, symbol: id, retainedPayload: 'x'.repeat(10_000) },
      }))
    );
    const sample = await repository.query('assets', {
      first: 1,
      orderBy: ['ID_ASC'],
      filter: { id: { equalTo: 'a' } },
      includeTotalCount: false,
      maxBytes: Number.MAX_SAFE_INTEGER,
    });
    const sampleBytes = estimateRetainedValueBytes(sample, Number.MAX_SAFE_INTEGER);
    const operationBudget = sampleBytes * 2;
    const originalQuery = repository.query.bind(repository);
    const passedBudgets: number[] = [];
    let activeQueries = 0;
    let maximumActiveQueries = 0;
    let fetchedBytes = 0;
    repository.query = async (collectionName, args) => {
      activeQueries += 1;
      maximumActiveQueries = Math.max(maximumActiveQueries, activeQueries);
      passedBudgets.push(Number(args.maxBytes));
      try {
        // Keep all root-field promises live together so an uncoordinated
        // per-alias implementation would overlap the repository reads.
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        const result = await originalQuery(collectionName, args);
        fetchedBytes += estimateRetainedValueBytes(result, Number.MAX_SAFE_INTEGER);
        return result;
      } finally {
        activeQueries -= 1;
      }
    };

    const { yoga } = createGraphQLHandler(
      {
        ...config,
        graphqlCacheTtlMs: 0,
        graphqlMaxResultBytes: operationBudget,
      },
      repository
    );
    const response = await post(
      yoga,
      `{
        a: assets(first: 1, orderBy: [ID_ASC], filter: { id: { equalTo: "a" } }) { nodes { id } }
        b: assets(first: 1, orderBy: [ID_ASC], filter: { id: { equalTo: "b" } }) { nodes { id } }
        c: assets(first: 1, orderBy: [ID_ASC], filter: { id: { equalTo: "c" } }) { nodes { id } }
      }`
    );
    const body = (await response.json()) as {
      data?: Record<string, unknown>;
      errors?: Array<{ path?: string[]; extensions?: { code?: string } }>;
    };

    expect(response.status).toBe(200);
    // Connection roots are non-null in the compatibility schema, so the
    // rejected third alias nulls the operation result after the first two
    // reads have spent the shared budget.
    expect(body.data).toBeNull();
    expect(body.errors).toEqual([
      expect.objectContaining({
        path: ['c'],
        extensions: { code: 'GRAPHQL_EXECUTION_MEMORY_LIMIT_EXCEEDED' },
      }),
    ]);
    expect(maximumActiveQueries).toBe(1);
    expect(passedBudgets).toEqual([operationBudget, sampleBytes]);
    expect(fetchedBytes).toBeLessThanOrEqual(operationBudget);
  });
});
