import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertIndependentSoraRpcEndpoints,
  readConfig,
  readRuntimeSecurityConfig,
  readSoraArchiveWsEndpoint,
} from '../src/config.js';

const CONFIG_ENV_KEYS = [
  'NODE_ENV',
  'HOST',
  'PORT',
  'GRAPHQL_PATH',
  'HTTP_LISTEN_BACKLOG',
  'HTTP_SHUTDOWN_TIMEOUT_MS',
  'HTTP_KEEP_ALIVE_TIMEOUT_MS',
  'HTTP_HEADERS_TIMEOUT_MS',
  'HTTP_REQUEST_TIMEOUT_MS',
  'HTTP_MAX_CONNECTIONS',
  'GRAPHQL_HTTP_MAX_BODY_BYTES',
  'GRAPHQL_HTTP_MAX_IN_FLIGHT',
  'GRAPHQL_MAX_DEPTH',
  'GRAPHQL_MAX_DOCUMENT_NODES',
  'GRAPHQL_MAX_FIELDS',
  'GRAPHQL_MAX_ALIASES',
  'GRAPHQL_MAX_FRAGMENT_SPREADS',
  'GRAPHQL_MAX_OPERATION_COST',
  'GRAPHQL_ALLOW_INTROSPECTION',
  'GRAPHQL_WS_MAX_PAYLOAD_BYTES',
  'GRAPHQL_WS_CONNECTION_INIT_TIMEOUT_MS',
  'GRAPHQL_WS_MAX_CONNECTIONS',
  'GRAPHQL_WS_MAX_OPERATIONS',
  'GRAPHQL_WS_MAX_OPERATIONS_PER_CONNECTION',
  'GRAPHQL_WS_MAX_PENDING_MESSAGES_PER_CONNECTION',
  'GRAPHQL_CACHE_MAX_ENTRIES',
  'GRAPHQL_CACHE_MAX_BYTES',
  'GRAPHQL_CACHE_TTL_MS',
  'GRAPHQL_MAX_RESULT_BYTES',
  'GRAPHQL_EXECUTION_MEMORY_MAX_BYTES',
  'STORAGE_ENGINE',
  'DATABASE_URL',
  'SKIP_POSTGRES_MIGRATION',
  'POSTGRES_POOL_MAX',
  'POSTGRES_LISTEN_POOL_MAX',
  'POSTGRES_CONNECTION_TIMEOUT_MS',
  'POSTGRES_QUERY_TIMEOUT_MS',
  'POSTGRES_STATEMENT_TIMEOUT_MS',
  'POSTGRES_MIGRATION_QUERY_TIMEOUT_MS',
  'POSTGRES_MIGRATION_STATEMENT_TIMEOUT_MS',
  'POSTGRES_WATCH_QUEUE_MAX',
  'POSTGRES_WATCH_RECONNECT_MIN_DELAY_MS',
  'POSTGRES_WATCH_RECONNECT_MAX_DELAY_MS',
  'ROCKSDB_PATH',
  'ROCKSDB_BLOCK_CACHE_MB',
  'ROCKSDB_WRITE_BUFFER_MANAGER_MB',
  'ROCKSDB_PARALLELISM',
  'ROCKSDB_ENABLE_STATS',
  'ROCKSDB_DOCUMENT_CACHE_MAX',
  'ROCKSDB_DOCUMENT_CACHE_MAX_BYTES',
  'ROCKSDB_WATCH_QUEUE_MAX',
  'ROCKSDB_QUERY_MAX_SCANNED_ROWS',
  'ROCKSDB_COMPACTION_MIN_FREE_GB',
  'SORA_WS_ENDPOINT',
  'SORA_ARCHIVE_WS_ENDPOINT',
  'CHAIN_START_BLOCK',
  'CHAIN_BATCH_SIZE',
  'CHAIN_STATE_REFRESH_INTERVAL_BLOCKS',
  'CHAIN_SNAPSHOT_INTERVAL_BLOCKS',
  'HTTP_MAX_HEADER_BYTES',
  'HTTP_MAX_REQUESTS_PER_SOCKET',
  'RATE_LIMIT_WINDOW_MS',
  'RATE_LIMIT_MAX',
  'RATE_LIMIT_MAX_KEYS',
  'RATE_LIMIT_GLOBAL_WINDOW_MS',
  'RATE_LIMIT_GLOBAL_MAX',
  'GRAPHQL_WS_MAX_CONNECTIONS_PER_CLIENT',
  'CHAIN_STATE_FULL_RECONCILIATION_INTERVAL_BLOCKS',
  'CHAIN_SHUTDOWN_TIMEOUT_MS',
  'CHAIN_RPC_TIMEOUT_MS',
  'CHAIN_RPC_MAX_IN_FLIGHT',
  'CHAIN_DERIVED_STORAGE_LOAD_MAX_BYTES',
  'CHAIN_DERIVED_STORAGE_CACHE_MAX_BYTES',
  'CHAIN_ANALYTICS_INPUT_CACHE_MAX_BYTES',
  'CHAIN_BACKFILL_PREFETCH_CONCURRENCY',
  'CHAIN_FINALIZED_CATCHUP_PREFETCH_CONCURRENCY',
  'CHAIN_PRICE_STREAM_REFRESH_INTERVAL_BLOCKS',
  'CHAIN_LEGACY_SORA_BLOCK_TYPES',
  'SORA_ARCHIVE_WS_ENDPOINT',
  'WORKER_READINESS_MAX_LAG_BLOCKS',
  'WORKER_READINESS_MAX_STALENESS_SECONDS',
  'WORKER_METRICS_HOST',
  'WORKER_METRICS_PORT',
  'WORKER_METRICS_MAX_IN_FLIGHT',
] as const;

const originalEnv = new Map(CONFIG_ENV_KEYS.map((key) => [key, process.env[key]]));

const restoreEnv = () => {
  for (const key of CONFIG_ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

const setEnv = (values: Record<string, string>) => {
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
};

describe('runtime configuration', () => {
  beforeEach(() => {
    for (const key of CONFIG_ENV_KEYS) delete process.env[key];
  });

  afterEach(restoreEnv);

  it('uses documented development defaults when environment variables are absent', () => {
    expect(readConfig()).toEqual({
      host: '0.0.0.0',
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
      soraArchiveWsEndpoint: null,
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
  });

  it('parses every supported override without coercing its type', () => {
    Object.assign(process.env, {
      HOST: '127.0.0.1',
      PORT: '4444',
      GRAPHQL_PATH: '/alt-graphql',
      HTTP_LISTEN_BACKLOG: '2048',
      HTTP_SHUTDOWN_TIMEOUT_MS: '20000',
      HTTP_KEEP_ALIVE_TIMEOUT_MS: '60000',
      HTTP_HEADERS_TIMEOUT_MS: '65000',
      HTTP_REQUEST_TIMEOUT_MS: '90000',
      HTTP_MAX_CONNECTIONS: '25000',
      GRAPHQL_HTTP_MAX_BODY_BYTES: '131072',
      GRAPHQL_HTTP_MAX_IN_FLIGHT: '250',
      GRAPHQL_MAX_DEPTH: '16',
      GRAPHQL_MAX_DOCUMENT_NODES: '3000',
      GRAPHQL_MAX_FIELDS: '750',
      GRAPHQL_MAX_ALIASES: '75',
      GRAPHQL_MAX_FRAGMENT_SPREADS: '150',
      GRAPHQL_MAX_OPERATION_COST: '200000',
      GRAPHQL_ALLOW_INTROSPECTION: 'yes',
      GRAPHQL_WS_MAX_PAYLOAD_BYTES: '32768',
      GRAPHQL_WS_CONNECTION_INIT_TIMEOUT_MS: '15000',
      GRAPHQL_WS_MAX_CONNECTIONS: '500',
      GRAPHQL_WS_MAX_OPERATIONS: '750',
      GRAPHQL_WS_MAX_OPERATIONS_PER_CONNECTION: '10',
      GRAPHQL_WS_MAX_PENDING_MESSAGES_PER_CONNECTION: '32',
      GRAPHQL_CACHE_MAX_ENTRIES: '2000',
      GRAPHQL_CACHE_MAX_BYTES: '33554432',
      GRAPHQL_CACHE_TTL_MS: '1500',
      GRAPHQL_MAX_RESULT_BYTES: '100663296',
      GRAPHQL_EXECUTION_MEMORY_MAX_BYTES: '268435456',
      STORAGE_ENGINE: 'ROCKSDB',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/indexer',
      SKIP_POSTGRES_MIGRATION: 'yes',
      POSTGRES_POOL_MAX: '30',
      POSTGRES_LISTEN_POOL_MAX: '3',
      POSTGRES_CONNECTION_TIMEOUT_MS: '8000',
      POSTGRES_QUERY_TIMEOUT_MS: '80000',
      POSTGRES_STATEMENT_TIMEOUT_MS: '85000',
      POSTGRES_MIGRATION_QUERY_TIMEOUT_MS: '1800000',
      POSTGRES_MIGRATION_STATEMENT_TIMEOUT_MS: '1900000',
      POSTGRES_WATCH_QUEUE_MAX: '5000',
      POSTGRES_WATCH_RECONNECT_MIN_DELAY_MS: '250',
      POSTGRES_WATCH_RECONNECT_MAX_DELAY_MS: '5000',
      ROCKSDB_PATH: '/tmp/polkaswap.rocksdb',
      ROCKSDB_BLOCK_CACHE_MB: '1024',
      ROCKSDB_WRITE_BUFFER_MANAGER_MB: '512',
      ROCKSDB_PARALLELISM: '8',
      ROCKSDB_ENABLE_STATS: 'yes',
      ROCKSDB_DOCUMENT_CACHE_MAX: '25000',
      ROCKSDB_DOCUMENT_CACHE_MAX_BYTES: '134217728',
      ROCKSDB_WATCH_QUEUE_MAX: '2000',
      ROCKSDB_QUERY_MAX_SCANNED_ROWS: '250000',
      ROCKSDB_COMPACTION_MIN_FREE_GB: '20.5',
      SORA_WS_ENDPOINT: 'wss://example.invalid:9944',
      CHAIN_START_BLOCK: '100',
      CHAIN_BATCH_SIZE: '50',
      CHAIN_STATE_REFRESH_INTERVAL_BLOCKS: '60',
      CHAIN_SNAPSHOT_INTERVAL_BLOCKS: '75',
      CHAIN_STATE_FULL_RECONCILIATION_INTERVAL_BLOCKS: '300',
      CHAIN_SHUTDOWN_TIMEOUT_MS: '45000',
      CHAIN_RPC_TIMEOUT_MS: '12000',
      CHAIN_RPC_MAX_IN_FLIGHT: '128',
      CHAIN_DERIVED_STORAGE_LOAD_MAX_BYTES: '201326592',
      CHAIN_DERIVED_STORAGE_CACHE_MAX_BYTES: '33554432',
      CHAIN_ANALYTICS_INPUT_CACHE_MAX_BYTES: '67108864',
      CHAIN_BACKFILL_PREFETCH_CONCURRENCY: '4',
      CHAIN_FINALIZED_CATCHUP_PREFETCH_CONCURRENCY: '8',
      CHAIN_PRICE_STREAM_REFRESH_INTERVAL_BLOCKS: '10',
      CHAIN_LEGACY_SORA_BLOCK_TYPES: 'yes',
      SORA_ARCHIVE_WS_ENDPOINT: 'wss://archive.example.invalid:9944',
      WORKER_READINESS_MAX_LAG_BLOCKS: '50',
      WORKER_READINESS_MAX_STALENESS_SECONDS: '180',
      WORKER_METRICS_HOST: '::1',
      WORKER_METRICS_PORT: '9465',
      WORKER_METRICS_MAX_IN_FLIGHT: '20',
    });

    expect(readConfig()).toEqual({
      host: '127.0.0.1',
      port: 4444,
      graphqlPath: '/alt-graphql',
      httpListenBacklog: 2_048,
      httpShutdownTimeoutMs: 20_000,
      httpKeepAliveTimeoutMs: 60_000,
      httpHeadersTimeoutMs: 65_000,
      httpRequestTimeoutMs: 90_000,
      httpMaxConnections: 25_000,
      graphqlHttpMaxBodyBytes: 131_072,
      graphqlHttpMaxInFlight: 250,
      graphqlMaxDepth: 16,
      graphqlMaxDocumentNodes: 3_000,
      graphqlMaxFields: 750,
      graphqlMaxAliases: 75,
      graphqlMaxFragmentSpreads: 150,
      graphqlMaxOperationCost: 200_000,
      graphqlAllowIntrospection: true,
      graphqlWsMaxPayloadBytes: 32_768,
      graphqlWsConnectionInitTimeoutMs: 15_000,
      graphqlWsMaxConnections: 500,
      graphqlWsMaxOperations: 750,
      graphqlWsMaxOperationsPerConnection: 10,
      graphqlWsMaxPendingMessagesPerConnection: 32,
      graphqlCacheMaxEntries: 2_000,
      graphqlCacheMaxBytes: 33_554_432,
      graphqlCacheTtlMs: 1_500,
      graphqlMaxResultBytes: 100_663_296,
      graphqlExecutionMemoryMaxBytes: 268_435_456,
      storageEngine: 'rocksdb',
      databaseUrl: 'postgresql://user:pass@localhost:5432/indexer',
      skipPostgresMigration: true,
      postgresPoolMax: 30,
      postgresListenPoolMax: 3,
      postgresConnectionTimeoutMs: 8_000,
      postgresQueryTimeoutMs: 80_000,
      postgresStatementTimeoutMs: 85_000,
      postgresMigrationQueryTimeoutMs: 1_800_000,
      postgresMigrationStatementTimeoutMs: 1_900_000,
      postgresWatchQueueMax: 5_000,
      postgresWatchReconnectMinDelayMs: 250,
      postgresWatchReconnectMaxDelayMs: 5_000,
      rocksdbPath: '/tmp/polkaswap.rocksdb',
      rocksdbBlockCacheMb: 1024,
      rocksdbWriteBufferManagerMb: 512,
      rocksdbParallelism: 8,
      rocksdbEnableStats: true,
      rocksdbDocumentCacheMax: 25_000,
      rocksdbDocumentCacheMaxBytes: 134_217_728,
      rocksdbWatchQueueMax: 2_000,
      rocksdbQueryMaxScannedRows: 250_000,
      rocksdbCompactionMinFreeGb: 20.5,
      soraWsEndpoint: 'wss://example.invalid:9944',
      soraArchiveWsEndpoint: 'wss://archive.example.invalid:9944',
      chainStartBlock: 100,
      chainBatchSize: 50,
      stateRefreshIntervalBlocks: 60,
      snapshotIntervalBlocks: 75,
      fullReconciliationIntervalBlocks: 300,
      chainShutdownTimeoutMs: 45_000,
      chainRpcTimeoutMs: 12_000,
      chainRpcMaxInFlight: 128,
      derivedStorageLoadMaxBytes: 201_326_592,
      derivedStorageCacheMaxBytes: 33_554_432,
      analyticsInputCacheMaxBytes: 67_108_864,
      backfillPrefetchConcurrency: 4,
      finalizedCatchupPrefetchConcurrency: 8,
      priceStreamRefreshIntervalBlocks: 10,
      legacySoraBlockTypes: true,
      archiveSoraWsEndpoint: 'wss://archive.example.invalid:9944',
      workerReadinessMaxLagBlocks: 50,
      workerReadinessMaxStalenessSeconds: 180,
      workerMetricsHost: '::1',
      workerMetricsPort: 9465,
      workerMetricsMaxInFlight: 20,
    });
  });

  it('uses bounded abuse-control defaults and disables introspection in production', () => {
    expect(readRuntimeSecurityConfig()).toEqual({
      httpMaxBodyBytes: 65_536,
      httpMaxHeaderBytes: 16_384,
      httpListenBacklog: 4_096,
      httpShutdownTimeoutMs: 30_000,
      httpKeepAliveTimeoutMs: 75_000,
      httpHeadersTimeoutMs: 80_000,
      httpRequestTimeoutMs: 30_000,
      httpMaxConnections: 2_048,
      httpMaxRequestsPerSocket: 1_000,
      rateLimitWindowMs: 60_000,
      rateLimitMax: 600,
      rateLimitMaxKeys: 20_000,
      rateLimitGlobalWindowMs: 60_000,
      rateLimitGlobalMax: 50_000,
      graphqlMaxDepth: 12,
      graphqlMaxFields: 300,
      graphqlMaxAliases: 50,
      graphqlAllowIntrospection: true,
      graphqlWsMaxPayloadBytes: 65_536,
      graphqlWsMaxConnections: 512,
      graphqlWsMaxConnectionsPerClient: 16,
      graphqlWsMaxOperationsPerConnection: 32,
      graphqlWsConnectionInitTimeoutMs: 10_000,
    });

    process.env.NODE_ENV = 'production';
    expect(readRuntimeSecurityConfig().graphqlAllowIntrospection).toBe(false);
    process.env.GRAPHQL_ALLOW_INTROSPECTION = 'true';
    expect(readRuntimeSecurityConfig().graphqlAllowIntrospection).toBe(true);
  });

  it('accepts canonical security-limit overrides', () => {
    setEnv({
      GRAPHQL_HTTP_MAX_BODY_BYTES: '32768',
      HTTP_MAX_HEADER_BYTES: '8192',
      HTTP_LISTEN_BACKLOG: '256',
      HTTP_SHUTDOWN_TIMEOUT_MS: '5000',
      HTTP_KEEP_ALIVE_TIMEOUT_MS: '10000',
      HTTP_HEADERS_TIMEOUT_MS: '11000',
      HTTP_REQUEST_TIMEOUT_MS: '12000',
      HTTP_MAX_CONNECTIONS: '128',
      HTTP_MAX_REQUESTS_PER_SOCKET: '100',
      RATE_LIMIT_WINDOW_MS: '10000',
      RATE_LIMIT_MAX: '50',
      RATE_LIMIT_MAX_KEYS: '500',
      RATE_LIMIT_GLOBAL_WINDOW_MS: '20000',
      RATE_LIMIT_GLOBAL_MAX: '1000',
      GRAPHQL_MAX_DEPTH: '8',
      GRAPHQL_MAX_FIELDS: '100',
      GRAPHQL_MAX_ALIASES: '10',
      GRAPHQL_ALLOW_INTROSPECTION: 'false',
      GRAPHQL_WS_MAX_PAYLOAD_BYTES: '16384',
      GRAPHQL_WS_MAX_CONNECTIONS: '100',
      GRAPHQL_WS_MAX_CONNECTIONS_PER_CLIENT: '4',
      GRAPHQL_WS_MAX_OPERATIONS_PER_CONNECTION: '8',
      GRAPHQL_WS_CONNECTION_INIT_TIMEOUT_MS: '5000',
    });
    const security = readRuntimeSecurityConfig();
    expect(security.httpMaxBodyBytes).toBe(32_768);
    expect(security.httpMaxConnections).toBe(128);
    expect(security.rateLimitMaxKeys).toBe(500);
    expect(security.graphqlMaxDepth).toBe(8);
    expect(security.graphqlAllowIntrospection).toBe(false);
    expect(security.graphqlWsMaxOperationsPerConnection).toBe(8);
  });

  it('rejects malformed, ambiguous, unsafe, and out-of-range scalar settings', () => {
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ NODE_ENV: '' }, /NODE_ENV must be development, test, or production/],
      [{ NODE_ENV: 'prod' }, /NODE_ENV must be development, test, or production/],
      [{ HOST: 'bad host' }, /HOST must be a hostname or IP address/],
      [{ HOST: '   ' }, /HOST must be a non-empty single-line value/],
      [{ PORT: '' }, /PORT must be an integer/],
      [{ PORT: '0' }, /PORT must be an integer/],
      [{ PORT: '-1' }, /PORT must be an integer/],
      [{ PORT: '+4350' }, /PORT must be an integer/],
      [{ PORT: '04350' }, /PORT must be an integer/],
      [{ PORT: '4350.5' }, /PORT must be an integer/],
      [{ PORT: '4e3' }, /PORT must be an integer/],
      [{ PORT: '65536' }, /PORT must be an integer/],
      [{ PORT: '9007199254740993' }, /PORT must be an integer/],
      [{ GRAPHQL_PATH: 'graphql' }, /GRAPHQL_PATH must be an absolute URL path/],
      [{ GRAPHQL_PATH: '//evil.example/graphql' }, /GRAPHQL_PATH must be an absolute URL path/],
      [{ GRAPHQL_PATH: '/graphql?admin=true' }, /GRAPHQL_PATH must be an absolute URL path/],
      [{ GRAPHQL_PATH: '/graphql#fragment' }, /GRAPHQL_PATH must be an absolute URL path/],
      [{ GRAPHQL_PATH: '/../graphql' }, /GRAPHQL_PATH must be an absolute URL path/],
      [{ GRAPHQL_PATH: '/%2e%2e/graphql' }, /GRAPHQL_PATH must be an absolute URL path/],
      [{ CHAIN_START_BLOCK: '-1' }, /CHAIN_START_BLOCK must be an integer/],
      [{ CHAIN_BATCH_SIZE: '0' }, /CHAIN_BATCH_SIZE must be an integer/],
      [{ CHAIN_BATCH_SIZE: '25junk' }, /CHAIN_BATCH_SIZE must be an integer/],
      [{ CHAIN_STATE_REFRESH_INTERVAL_BLOCKS: '1.5' }, /must be an integer/],
      [{ CHAIN_SNAPSHOT_INTERVAL_BLOCKS: '0' }, /must be an integer/],
    ];

    for (const [values, expected] of cases) {
      setEnv(values);
      expect(readConfig).toThrow(expected);
      for (const key of Object.keys(values)) delete process.env[key];
    }
  });

  it('fails closed on invalid service URLs and missing production database configuration', () => {
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ NODE_ENV: 'production' }, /DATABASE_URL is required/],
      [{ DATABASE_URL: 'not-a-url' }, /DATABASE_URL must be a valid URL/],
      [{ DATABASE_URL: 'https://db.example.invalid/indexer' }, /unsupported URL scheme/],
      [{ DATABASE_URL: 'postgres://db.example.invalid' }, /must include a database name/],
      [{ DATABASE_URL: 'postgres://db.example.invalid/indexer#secret' }, /must not contain a URL fragment/],
      [{ SORA_WS_ENDPOINT: 'not-a-url' }, /SORA_WS_ENDPOINT must be a valid URL/],
      [{ SORA_WS_ENDPOINT: 'https://sora.example.invalid' }, /unsupported URL scheme/],
      [{ SORA_WS_ENDPOINT: 'ws://sora.example.invalid' }, /must use TLS outside localhost/],
      [{ SORA_WS_ENDPOINT: 'wss://operator:secret@sora.example.invalid' }, /must not contain URL credentials/],
      [{ SORA_WS_ENDPOINT: 'wss://sora.example.invalid/socket?api_key=secret' }, /must not contain URL credentials or a query string/],
      [{ SORA_WS_ENDPOINT: 'wss://sora.example.invalid/socket#secret' }, /must not contain a URL fragment/],
    ];

    for (const [values, expected] of cases) {
      setEnv(values);
      expect(readConfig).toThrow(expected);
      for (const key of Object.keys(values)) delete process.env[key];
    }

    process.env.SORA_WS_ENDPOINT = 'ws://127.0.0.1:9944';
    expect(readConfig().soraWsEndpoint).toBe('ws://127.0.0.1:9944');
  });

  it('reads an optional archive endpoint and requires it for production worker startup', () => {
    expect(readSoraArchiveWsEndpoint()).toBeNull();
    expect(() => readSoraArchiveWsEndpoint(true)).toThrow(
      'SORA_ARCHIVE_WS_ENDPOINT is required for the production worker',
    );

    process.env.SORA_ARCHIVE_WS_ENDPOINT = 'wss://archive.sora.example/ws';
    expect(readSoraArchiveWsEndpoint(true)).toBe('wss://archive.sora.example/ws');
    process.env.SORA_ARCHIVE_WS_ENDPOINT = 'ws://127.0.0.1:9944';
    expect(readSoraArchiveWsEndpoint(true)).toBe('ws://127.0.0.1:9944');
  });

  it.each([
    ['', /non-empty single-line value/],
    ['   ', /non-empty single-line value/],
    ['not a URL', /must be a valid URL/],
    ['https://archive.sora.org', /unsupported URL scheme/],
    ['ftp://archive.sora.org', /unsupported URL scheme/],
    ['ws://archive.sora.org', /must use TLS outside localhost/],
    ['wss://user:secret@archive.sora.org', /must not contain URL credentials/],
    ['wss://archive.sora.org/?token=secret', /must not contain URL credentials or a query string/],
    ['wss://archive.sora.org/#mainnet', /must not contain a URL fragment/],
    ['wss://archive.sora.org/\nsecond-line', /non-empty single-line value/],
  ])('rejects malformed archive endpoint %j', (value, expected) => {
    process.env.SORA_ARCHIVE_WS_ENDPOINT = value;
    expect(readSoraArchiveWsEndpoint).toThrow(expected);
  });

  it('requires independent primary and archive hosts regardless of case, port, or path', () => {
    expect(() => assertIndependentSoraRpcEndpoints(
      'wss://Mof2.Sora.org:443/primary',
      'wss://mof2.sora.org:9443/archive',
    )).toThrow('must use different reviewed hosts');

    expect(() => assertIndependentSoraRpcEndpoints(
      'wss://mof2.sora.org',
      'wss://ws.mof.sora.org',
    )).not.toThrow();
  });

  it('rejects malformed and unsafe security-limit settings', () => {
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ GRAPHQL_HTTP_MAX_BODY_BYTES: '1023' }, /GRAPHQL_HTTP_MAX_BODY_BYTES must be an integer/],
      [{ HTTP_MAX_HEADER_BYTES: '65537' }, /HTTP_MAX_HEADER_BYTES must be an integer/],
      [{ HTTP_MAX_CONNECTIONS: '0' }, /HTTP_MAX_CONNECTIONS must be an integer/],
      [{ HTTP_KEEP_ALIVE_TIMEOUT_MS: '10000', HTTP_HEADERS_TIMEOUT_MS: '10000' }, /HTTP_HEADERS_TIMEOUT_MS must be an integer/],
      [{ RATE_LIMIT_MAX: '0' }, /RATE_LIMIT_MAX must be an integer/],
      [{ RATE_LIMIT_MAX_KEYS: '0' }, /RATE_LIMIT_MAX_KEYS must be an integer/],
      [{ RATE_LIMIT_GLOBAL_MAX: '0' }, /RATE_LIMIT_GLOBAL_MAX must be an integer/],
      [{ GRAPHQL_MAX_DEPTH: '0' }, /GRAPHQL_MAX_DEPTH must be an integer/],
      [{ GRAPHQL_MAX_FIELDS: '10001' }, /GRAPHQL_MAX_FIELDS must be an integer/],
      [{ GRAPHQL_MAX_ALIASES: '-1' }, /GRAPHQL_MAX_ALIASES must be an integer/],
      [{ GRAPHQL_ALLOW_INTROSPECTION: 'sometimes' }, /GRAPHQL_ALLOW_INTROSPECTION must be one of/],
      [{ GRAPHQL_WS_MAX_PAYLOAD_BYTES: '1e5' }, /GRAPHQL_WS_MAX_PAYLOAD_BYTES must be an integer/],
      [{ GRAPHQL_WS_MAX_CONNECTIONS: '0' }, /GRAPHQL_WS_MAX_CONNECTIONS must be an integer/],
      [{ GRAPHQL_WS_MAX_CONNECTIONS_PER_CLIENT: '0' }, /must be an integer/],
      [{ GRAPHQL_WS_MAX_OPERATIONS_PER_CONNECTION: '0' }, /must be an integer/],
      [{ GRAPHQL_WS_CONNECTION_INIT_TIMEOUT_MS: '999' }, /must be an integer/],
    ];
    for (const [values, expected] of cases) {
      setEnv(values);
      expect(readRuntimeSecurityConfig).toThrow(expected);
      for (const key of Object.keys(values)) delete process.env[key];
    }
  });
  it.each([
    ['PORT', '0', 'at least 1'],
    ['PORT', '65536', 'at most 65535'],
    ['PORT', '1.5', 'integer'],
    ['PORT', '1e3', 'integer'],
    ['HTTP_LISTEN_BACKLOG', '0', 'at least 1'],
    ['HTTP_SHUTDOWN_TIMEOUT_MS', '3600001', 'at most 3600000'],
    ['HTTP_KEEP_ALIVE_TIMEOUT_MS', '0', 'at least 1'],
    ['HTTP_MAX_CONNECTIONS', '0', 'at least 1'],
    ['GRAPHQL_HTTP_MAX_BODY_BYTES', '16777217', 'at most 16777216'],
    ['GRAPHQL_HTTP_MAX_IN_FLIGHT', '0', 'at least 1'],
    ['GRAPHQL_HTTP_MAX_IN_FLIGHT', '1e2', 'integer'],
    ['GRAPHQL_HTTP_MAX_IN_FLIGHT', '10001', 'at most 10000'],
    ['GRAPHQL_MAX_DEPTH', '101', 'at most 100'],
    ['GRAPHQL_MAX_DOCUMENT_NODES', '0', 'at least 1'],
    ['GRAPHQL_MAX_FIELDS', '-1', 'at least 1'],
    ['GRAPHQL_MAX_ALIASES', '-1', 'at least 0'],
    ['GRAPHQL_MAX_FRAGMENT_SPREADS', '-1', 'at least 0'],
    ['GRAPHQL_MAX_OPERATION_COST', '0', 'at least 1'],
    ['GRAPHQL_WS_MAX_PAYLOAD_BYTES', '0', 'at least 1'],
    ['GRAPHQL_WS_CONNECTION_INIT_TIMEOUT_MS', '0', 'at least 1'],
    ['GRAPHQL_WS_MAX_CONNECTIONS', '0', 'at least 1'],
    ['GRAPHQL_WS_MAX_OPERATIONS', '0', 'at least 1'],
    ['GRAPHQL_WS_MAX_OPERATIONS_PER_CONNECTION', '0', 'at least 1'],
    ['GRAPHQL_WS_MAX_PENDING_MESSAGES_PER_CONNECTION', '0', 'at least 1'],
    ['GRAPHQL_CACHE_MAX_ENTRIES', '-1', 'at least 0'],
    ['GRAPHQL_CACHE_MAX_BYTES', '-1', 'at least 0'],
    ['GRAPHQL_CACHE_TTL_MS', '-1', 'at least 0'],
    ['GRAPHQL_MAX_RESULT_BYTES', '67108863', 'at least 67108864'],
    ['GRAPHQL_MAX_RESULT_BYTES', '1073741825', 'at most 1073741824'],
    ['GRAPHQL_EXECUTION_MEMORY_MAX_BYTES', '67108863', 'at least 67108864'],
    ['POSTGRES_POOL_MAX', '0', 'at least 1'],
    ['POSTGRES_LISTEN_POOL_MAX', '101', 'at most 100'],
    ['POSTGRES_CONNECTION_TIMEOUT_MS', '0', 'at least 1'],
    ['POSTGRES_QUERY_TIMEOUT_MS', '0', 'at least 1'],
    ['POSTGRES_STATEMENT_TIMEOUT_MS', '0', 'at least 1'],
    ['POSTGRES_MIGRATION_QUERY_TIMEOUT_MS', '-1', 'at least 0'],
    ['POSTGRES_MIGRATION_QUERY_TIMEOUT_MS', '1e3', 'integer'],
    ['POSTGRES_MIGRATION_STATEMENT_TIMEOUT_MS', '2147483648', 'at most 2147483647'],
    ['POSTGRES_WATCH_QUEUE_MAX', '0', 'at least 1'],
    ['POSTGRES_WATCH_RECONNECT_MIN_DELAY_MS', '0', 'at least 1'],
    ['POSTGRES_WATCH_RECONNECT_MAX_DELAY_MS', '3600001', 'at most 3600000'],
    ['ROCKSDB_BLOCK_CACHE_MB', '-1', 'at least 0'],
    ['ROCKSDB_BLOCK_CACHE_MB', '65537', 'at most 65536'],
    ['ROCKSDB_WRITE_BUFFER_MANAGER_MB', 'NaN', 'integer'],
    ['ROCKSDB_WRITE_BUFFER_MANAGER_MB', '65537', 'at most 65536'],
    ['ROCKSDB_PARALLELISM', '0', 'at least 1'],
    ['ROCKSDB_PARALLELISM', '257', 'at most 256'],
    ['ROCKSDB_DOCUMENT_CACHE_MAX', '-1', 'at least 0'],
    ['ROCKSDB_DOCUMENT_CACHE_MAX', '1000001', 'at most 1000000'],
    ['ROCKSDB_DOCUMENT_CACHE_MAX_BYTES', '-1', 'at least 0'],
    ['ROCKSDB_WATCH_QUEUE_MAX', '0', 'at least 1'],
    ['ROCKSDB_QUERY_MAX_SCANNED_ROWS', '0', 'at least 1'],
    ['ROCKSDB_COMPACTION_MIN_FREE_GB', 'Infinity', 'finite'],
    ['ROCKSDB_COMPACTION_MIN_FREE_GB', '-0.1', 'at least 0'],
    ['CHAIN_START_BLOCK', '-1', 'at least 0'],
    ['CHAIN_BATCH_SIZE', '0', 'at least 1'],
    ['CHAIN_BATCH_SIZE', '1001', 'at most 1000'],
    ['CHAIN_STATE_REFRESH_INTERVAL_BLOCKS', '0', 'at least 1'],
    ['CHAIN_SNAPSHOT_INTERVAL_BLOCKS', '-5', 'at least 1'],
    ['CHAIN_STATE_FULL_RECONCILIATION_INTERVAL_BLOCKS', '0', 'at least 1'],
    ['CHAIN_SHUTDOWN_TIMEOUT_MS', '0', 'at least 1'],
    ['CHAIN_RPC_TIMEOUT_MS', '0', 'at least 1'],
    ['CHAIN_RPC_MAX_IN_FLIGHT', '63', 'at least 64'],
    ['CHAIN_DERIVED_STORAGE_CACHE_MAX_BYTES', '-1', 'at least 0'],
    ['CHAIN_ANALYTICS_INPUT_CACHE_MAX_BYTES', '-1', 'at least 0'],
    ['CHAIN_BACKFILL_PREFETCH_CONCURRENCY', '0', 'at least 1'],
    ['CHAIN_BACKFILL_PREFETCH_CONCURRENCY', '257', 'at most 256'],
    ['CHAIN_FINALIZED_CATCHUP_PREFETCH_CONCURRENCY', '257', 'at most 256'],
    ['CHAIN_PRICE_STREAM_REFRESH_INTERVAL_BLOCKS', '-1', 'at least 0'],
    ['CHAIN_PRICE_STREAM_REFRESH_INTERVAL_BLOCKS', '10000001', 'at most 10000000'],
    ['WORKER_READINESS_MAX_LAG_BLOCKS', '-1', 'at least 0'],
    ['WORKER_READINESS_MAX_STALENESS_SECONDS', '29', 'at least 30'],
    ['WORKER_METRICS_PORT', '0', 'at least 1'],
    ['WORKER_METRICS_PORT', '65536', 'at most 65535'],
    ['WORKER_METRICS_MAX_IN_FLIGHT', '0', 'at least 1'],
  ])('fails fast for unsafe numeric input %s=%s', (name, value, message) => {
    process.env[name] = value;
    expect(() => readConfig()).toThrow(new RegExp(`Invalid ${name}:.*${message}`));
  });

  it('requires the shared execution memory budget to fit one maximum result reservation', () => {
    process.env.GRAPHQL_MAX_RESULT_BYTES = String(128 * 1_024 * 1_024);
    process.env.GRAPHQL_EXECUTION_MEMORY_MAX_BYTES = String(64 * 1_024 * 1_024);
    expect(() => readConfig()).toThrow(
      /Invalid GRAPHQL_EXECUTION_MEMORY_MAX_BYTES:.*at least GRAPHQL_MAX_RESULT_BYTES/
    );
  });

  it.each([
    ['STORAGE_ENGINE', 'sqlite', 'postgres, rocksdb'],
    ['ROCKSDB_ENABLE_STATS', 'sometimes', 'true, false'],
    ['SKIP_POSTGRES_MIGRATION', 'sometimes', 'true, false'],
    ['GRAPHQL_ALLOW_INTROSPECTION', 'sometimes', 'true, false'],
    ['CHAIN_LEGACY_SORA_BLOCK_TYPES', 'sometimes', 'true, false'],
  ])('rejects unsupported enum/boolean input %s=%s', (name, value, message) => {
    process.env[name] = value;
    expect(() => readConfig()).toThrow(new RegExp(`Invalid ${name}:.*${message}`));
  });

  it.each([
    ['HOST', '   ', 'must not be empty'],
    ['HOST', 'bad host', 'whitespace'],
    ['HOST', 'http://localhost', 'valid IP address or hostname'],
    ['GRAPHQL_PATH', 'graphql', 'start with'],
    ['GRAPHQL_PATH', '//attacker.example/graphql', 'protocol-relative'],
    ['GRAPHQL_PATH', '/foo\\graphql', 'canonical URL path'],
    ['GRAPHQL_PATH', '/foo/../graphql', 'canonical URL path'],
    ['GRAPHQL_PATH', '/metrics', 'reserved /metrics'],
    ['GRAPHQL_PATH', '/graphql?debug=1', 'without whitespace'],
    ['DATABASE_URL', 'mysql://localhost/indexer', 'postgres'],
    ['DATABASE_URL', 'not a url', 'absolute URL'],
    ['SORA_WS_ENDPOINT', 'https://mof2.sora.org', 'ws: or wss:'],
    ['SORA_WS_ENDPOINT', 'wss://', 'absolute URL'],
    ['SORA_ARCHIVE_WS_ENDPOINT', 'https://archive.example', 'ws: or wss:'],
    ['SORA_ARCHIVE_WS_ENDPOINT', 'not a url', 'absolute URL'],
    ['ROCKSDB_PATH', '', 'must not be empty'],
    ['WORKER_METRICS_HOST', '', 'must not be empty'],
    ['WORKER_METRICS_HOST', 'bad host', 'whitespace'],
    ['WORKER_METRICS_HOST', 'http://localhost', 'valid IP address or hostname'],
    ['WORKER_METRICS_HOST', '-invalid.local', 'valid IP address or hostname'],
  ])('rejects malformed structural input %s', (name, value, message) => {
    process.env[name] = value;
    expect(() => readConfig()).toThrow(new RegExp(`Invalid ${name}:.*${message}`));
  });

  it('accepts every explicit false boolean spelling', () => {
    for (const value of ['false', '0', 'no', 'off']) {
      process.env.ROCKSDB_ENABLE_STATS = value;
      process.env.GRAPHQL_ALLOW_INTROSPECTION = value;
      process.env.SKIP_POSTGRES_MIGRATION = value;
      process.env.CHAIN_LEGACY_SORA_BLOCK_TYPES = value;
      expect(readConfig().rocksdbEnableStats).toBe(false);
      expect(readConfig().graphqlAllowIntrospection).toBe(false);
      expect(readConfig().skipPostgresMigration).toBe(false);
      expect(readConfig().legacySoraBlockTypes).toBe(false);
    }
  });

  it('defaults finalized catch-up prefetching to the configured backfill concurrency', () => {
    process.env.CHAIN_BACKFILL_PREFETCH_CONCURRENCY = '7';
    expect(readConfig().finalizedCatchupPrefetchConcurrency).toBe(7);
  });

  it('rejects HTTP timeout relationships that allow slow or ambiguous connection teardown', () => {
    process.env.HTTP_HEADERS_TIMEOUT_MS = '75000';
    expect(() => readConfig()).toThrow(/Invalid HTTP_HEADERS_TIMEOUT_MS:.*greater than HTTP_KEEP_ALIVE_TIMEOUT_MS/);

    process.env.HTTP_HEADERS_TIMEOUT_MS = '80001';
    process.env.HTTP_REQUEST_TIMEOUT_MS = '80000';
    expect(() => readConfig()).toThrow(/Invalid HTTP_REQUEST_TIMEOUT_MS:.*at least HTTP_HEADERS_TIMEOUT_MS/);
  });

  it('rejects a watch reconnect maximum below its minimum', () => {
    process.env.POSTGRES_WATCH_RECONNECT_MIN_DELAY_MS = '500';
    process.env.POSTGRES_WATCH_RECONNECT_MAX_DELAY_MS = '499';
    expect(() => readConfig()).toThrow(
      /Invalid POSTGRES_WATCH_RECONNECT_MAX_DELAY_MS:.*POSTGRES_WATCH_RECONNECT_MIN_DELAY_MS/
    );
  });
});
