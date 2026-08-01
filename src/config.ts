import { isIP } from 'node:net';

import { findUnsafePostgresProcessEnvironmentOverride } from './postgres-session.js';

export type AppConfig = {
  host: string;
  port: number;
  graphqlPath: string;
  httpListenBacklog: number;
  httpShutdownTimeoutMs: number;
  httpKeepAliveTimeoutMs: number;
  httpHeadersTimeoutMs: number;
  httpRequestTimeoutMs: number;
  httpMaxConnections: number;
  httpMaxHeaderBytes: number;
  httpMaxRequestsPerSocket: number;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  rateLimitMaxKeys: number;
  rateLimitGlobalWindowMs: number;
  rateLimitGlobalMax: number;
  graphqlHttpMaxBodyBytes: number;
  graphqlHttpMaxInFlight: number;
  graphqlMaxDepth: number;
  graphqlMaxDocumentNodes: number;
  graphqlMaxFields: number;
  graphqlMaxAliases: number;
  graphqlMaxFragmentSpreads: number;
  graphqlMaxOperationCost: number;
  graphqlAllowIntrospection: boolean;
  graphqlWsMaxPayloadBytes: number;
  graphqlWsConnectionInitTimeoutMs: number;
  graphqlWsMaxConnections: number;
  graphqlWsMaxConnectionsPerClient: number;
  graphqlWsMaxOperations: number;
  graphqlWsMaxOperationsPerConnection: number;
  graphqlWsMaxPendingMessagesPerConnection: number;
  graphqlCacheMaxEntries: number;
  graphqlCacheMaxBytes: number;
  graphqlCacheTtlMs: number;
  graphqlMaxResultBytes: number;
  graphqlExecutionMemoryMaxBytes: number;
  storageEngine: 'postgres' | 'rocksdb';
  databaseUrl: string;
  skipPostgresMigration: boolean;
  postgresPoolMax: number;
  postgresListenPoolMax: number;
  postgresConnectionTimeoutMs: number;
  postgresQueryTimeoutMs: number;
  postgresStatementTimeoutMs: number;
  postgresMigrationQueryTimeoutMs: number;
  postgresMigrationStatementTimeoutMs: number;
  postgresWatchQueueMax: number;
  postgresWatchReconnectMinDelayMs: number;
  postgresWatchReconnectMaxDelayMs: number;
  rocksdbPath: string;
  rocksdbBlockCacheMb: number;
  rocksdbWriteBufferManagerMb: number;
  rocksdbParallelism: number;
  rocksdbEnableStats: boolean;
  rocksdbDocumentCacheMax: number;
  rocksdbDocumentCacheMaxBytes: number;
  rocksdbWatchQueueMax: number;
  rocksdbQueryMaxScannedRows: number;
  rocksdbCompactionMinFreeGb: number;
  soraWsEndpoint: string;
  chainStartBlock: number;
  chainBatchSize: number;
  stateRefreshIntervalBlocks: number;
  snapshotIntervalBlocks: number;
  fullReconciliationIntervalBlocks: number;
  chainShutdownTimeoutMs: number;
  chainRpcTimeoutMs: number;
  chainRpcMaxInFlight: number;
  /** Hard ceiling for one pinned projection's retained RPC storage entries. */
  derivedStorageLoadMaxBytes: number;
  derivedStorageCacheMaxBytes: number;
  analyticsInputCacheMaxBytes: number;
  backfillPrefetchConcurrency: number;
  finalizedCatchupPrefetchConcurrency: number;
  priceStreamRefreshIntervalBlocks: number;
  legacySoraBlockTypes: boolean;
  archiveSoraWsEndpoint: string;
  workerReadinessMaxLagBlocks: number;
  workerReadinessMaxStalenessSeconds: number;
  workerMetricsHost: string;
  workerMetricsPort: number;
  workerMetricsMaxInFlight: number;
};

const DEFAULT_DATABASE_URL = 'postgres://polkaswap:polkaswap@127.0.0.1:5432/polkaswap_indexer';
const NODE_ENVIRONMENTS = new Set(['development', 'test', 'production']);

const invalid = (name: string, reason: string): never => {
  throw new Error(`Invalid ${name}: ${reason}`);
};

const readString = (name: string, fallback: string): string => {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (value.trim() === '') return invalid(name, 'must not be empty');
  return value;
};

const readInteger = (
  name: string,
  fallback: number,
  { minimum, maximum }: { minimum: number; maximum?: number }
): number => {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!/^-?\d+$/.test(value.trim())) return invalid(name, 'must be an integer');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return invalid(name, 'must be a safe integer');
  if (parsed < minimum) return invalid(name, `must be at least ${minimum}`);
  if (maximum !== undefined && parsed > maximum) return invalid(name, `must be at most ${maximum}`);
  return parsed;
};

const readNumber = (name: string, fallback: number, minimum: number): number => {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (value.trim() === '') return invalid(name, 'must not be empty');

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return invalid(name, 'must be a finite number');
  if (parsed < minimum) return invalid(name, `must be at least ${minimum}`);
  return parsed;
};

const readBoolean = (name: string, fallback = false): boolean => {
  const value = process.env[name];
  if (value === undefined) return fallback;

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return invalid(name, 'must be one of true, false, 1, 0, yes, no, on, or off');
};

const readEnum = <T extends string>(name: string, fallback: T, values: readonly T[]): T => {
  const value = process.env[name];
  if (value === undefined) return fallback;

  const normalized = value.trim().toLowerCase() as T;
  if (values.includes(normalized)) return normalized;
  return invalid(name, `must be one of ${values.join(', ')}`);
};

const validateUrl = (name: string, value: string, protocols: readonly string[]): string => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalid(name, 'must be an absolute URL');
  }
  if (!protocols.includes(parsed.protocol)) return invalid(name, `must use ${protocols.join(' or ')}`);
  if (!parsed.hostname) return invalid(name, 'must include a host');
  return value;
};

const validateProductionDatabaseUrl = (value: string, nodeEnvironment: string): string => {
  if (nodeEnvironment !== 'production') return value;
  const url = new URL(value);
  const entries = [...url.searchParams.entries()];
  const keys = entries.map(([key]) => key);
  if (
    new Set(keys).size !== keys.length ||
    keys.some((key) => key !== key.toLowerCase()) ||
    keys.some((key) => key !== 'sslmode' && key !== 'sslnegotiation')
  ) {
    return invalid(
      'DATABASE_URL',
      'may use only one lowercase sslmode and optional sslnegotiation parameter in production'
    );
  }
  if (url.searchParams.get('sslmode') !== 'verify-full') {
    return invalid('DATABASE_URL', 'must use sslmode=verify-full in production');
  }
  const sslNegotiation = url.searchParams.get('sslnegotiation');
  if (
    sslNegotiation !== null &&
    sslNegotiation !== 'direct' &&
    sslNegotiation !== 'postgres'
  ) {
    return invalid(
      'DATABASE_URL',
      'sslnegotiation must be direct or postgres in production'
    );
  }
  return value;
};

const readNodeEnvironment = (): string => {
  const value = process.env.NODE_ENV ?? 'development';
  if (!NODE_ENVIRONMENTS.has(value)) {
    return invalid('NODE_ENV', 'must be development, test, or production');
  }
  return value;
};

const validateSoraWsUrl = (name: string, value: string): string => {
  if (value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    return invalid(name, 'must be a non-empty single-line URL without surrounding whitespace');
  }
  validateUrl(name, value, ['ws:', 'wss:']);
  const parsed = new URL(value);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return invalid(name, 'must not contain credentials, a query string, or a fragment');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname.endsWith('.')) {
    return invalid(name, 'hostname must not have a trailing dot');
  }
  const localhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  if (!localhost && parsed.protocol !== 'wss:') {
    return invalid(name, 'must use TLS outside localhost');
  }
  return value;
};

export function readSoraArchiveWsEndpoint(requireConfigured = false): string | null {
  const value = process.env.SORA_ARCHIVE_WS_ENDPOINT;
  if (value === undefined || value === '') {
    if (requireConfigured) {
      return invalid('SORA_ARCHIVE_WS_ENDPOINT', 'is required for the production worker');
    }
    return null;
  }
  return validateSoraWsUrl('SORA_ARCHIVE_WS_ENDPOINT', value);
}

/**
 * Production workers must not silently inherit development chain inputs.
 * The values themselves are parsed and validated by readConfig().
 */
export function assertExplicitProductionWorkerChainInputs(): void {
  if (process.env.NODE_ENV !== 'production') return;
  if (process.env.SORA_WS_ENDPOINT === undefined) {
    invalid('SORA_WS_ENDPOINT', 'is required for the production worker');
  }
  if (process.env.CHAIN_START_BLOCK === undefined) {
    invalid('CHAIN_START_BLOCK', 'is required for the production worker');
  }
}

export function assertIndependentSoraRpcEndpoints(primary: string, archive: string): void {
  const canonicalHostname = (value: string): string =>
    new URL(value).hostname.toLowerCase().replace(/\.$/, '');
  if (canonicalHostname(primary) === canonicalHostname(archive)) {
    throw new Error('SORA primary and archive endpoints must use different reviewed hosts.');
  }
}

const validateGraphqlPath = (value: string): string => {
  if (!value.startsWith('/')) return invalid('GRAPHQL_PATH', 'must start with /');
  if (value.startsWith('//')) return invalid('GRAPHQL_PATH', 'must not be protocol-relative');
  if (value === '/metrics') return invalid('GRAPHQL_PATH', 'must not use the reserved /metrics route');
  if (value.includes('?') || value.includes('#') || /\s/.test(value)) {
    return invalid('GRAPHQL_PATH', 'must be a URL path without whitespace, query, or fragment');
  }
  if (new URL(value, 'http://localhost').pathname !== value) {
    return invalid('GRAPHQL_PATH', 'must be a canonical URL path without backslashes or dot segments');
  }
  return value;
};

const validateNetworkHost = (name: string, value: string): string => {
  if (/\s/.test(value)) return invalid(name, 'must not contain whitespace');
  if (isIP(value)) return value;
  if (value.length > 253) return invalid(name, 'must be a valid IP address or hostname');
  const labels = value.split('.');
  if (
    labels.some(
      (label) =>
        !label ||
        label.length > 63 ||
        !/^[A-Za-z0-9-]+$/.test(label) ||
        label.startsWith('-') ||
        label.endsWith('-')
    )
  ) {
    return invalid(name, 'must be a valid IP address or hostname');
  }
  return value;
};

/** Reads and strictly validates all long-lived runtime configuration. */
export function readConfig(): AppConfig {
  const nodeEnvironment = readNodeEnvironment();
  if (nodeEnvironment === 'production') {
    const override = findUnsafePostgresProcessEnvironmentOverride(process.env);
    if (override !== null) {
      invalid(
        override,
        'must not override production PostgreSQL connection or TLS policy'
      );
    }
  }
  const host = validateNetworkHost('HOST', readString('HOST', '0.0.0.0'));
  const workerMetricsHost = validateNetworkHost(
    'WORKER_METRICS_HOST',
    readString('WORKER_METRICS_HOST', '127.0.0.1')
  );

  if (nodeEnvironment === 'production' && process.env.DATABASE_URL === undefined) {
    invalid('DATABASE_URL', 'is required when NODE_ENV=production');
  }
  const databaseUrl = validateProductionDatabaseUrl(
    validateUrl('DATABASE_URL', readString('DATABASE_URL', DEFAULT_DATABASE_URL), [
      'postgres:',
      'postgresql:',
    ]),
    nodeEnvironment
  );
  const soraWsEndpoint = validateSoraWsUrl(
    'SORA_WS_ENDPOINT',
    readString('SORA_WS_ENDPOINT', 'wss://mof2.sora.org')
  );
  const httpKeepAliveTimeoutMs = readInteger('HTTP_KEEP_ALIVE_TIMEOUT_MS', 75_000, {
    minimum: 1,
    maximum: 3_600_000,
  });
  const httpHeadersTimeoutMs = readInteger('HTTP_HEADERS_TIMEOUT_MS', 80_000, {
    minimum: 1,
    maximum: 3_600_000,
  });
  const httpRequestTimeoutMs = readInteger('HTTP_REQUEST_TIMEOUT_MS', 120_000, {
    minimum: 1,
    maximum: 3_600_000,
  });
  if (httpHeadersTimeoutMs <= httpKeepAliveTimeoutMs) {
    invalid('HTTP_HEADERS_TIMEOUT_MS', 'must be greater than HTTP_KEEP_ALIVE_TIMEOUT_MS');
  }
  if (httpRequestTimeoutMs < httpHeadersTimeoutMs) {
    invalid('HTTP_REQUEST_TIMEOUT_MS', 'must be at least HTTP_HEADERS_TIMEOUT_MS');
  }
  const backfillPrefetchConcurrency = readInteger('CHAIN_BACKFILL_PREFETCH_CONCURRENCY', 1, {
    minimum: 1,
    maximum: 256,
  });
  const finalizedCatchupPrefetchConcurrency = readInteger(
    'CHAIN_FINALIZED_CATCHUP_PREFETCH_CONCURRENCY',
    backfillPrefetchConcurrency,
    { minimum: 1, maximum: 256 }
  );
  const chainRpcMaxInFlight = readInteger('CHAIN_RPC_MAX_IN_FLIGHT', 256, {
    minimum: 64,
    maximum: 10_000,
  });
  const minimumRpcCapacity = 3 * Math.max(backfillPrefetchConcurrency, finalizedCatchupPrefetchConcurrency);
  if (chainRpcMaxInFlight < minimumRpcCapacity) {
    invalid(
      'CHAIN_RPC_MAX_IN_FLIGHT',
      `must be at least 3 times the maximum configured prefetch concurrency (${minimumRpcCapacity})`
    );
  }
  const postgresWatchReconnectMinDelayMs = readInteger(
    'POSTGRES_WATCH_RECONNECT_MIN_DELAY_MS',
    100,
    { minimum: 1, maximum: 60_000 }
  );
  const postgresWatchReconnectMaxDelayMs = readInteger(
    'POSTGRES_WATCH_RECONNECT_MAX_DELAY_MS',
    10_000,
    { minimum: 1, maximum: 3_600_000 }
  );
  if (postgresWatchReconnectMaxDelayMs < postgresWatchReconnectMinDelayMs) {
    invalid(
      'POSTGRES_WATCH_RECONNECT_MAX_DELAY_MS',
      'must be at least POSTGRES_WATCH_RECONNECT_MIN_DELAY_MS'
    );
  }
  const graphqlMaxResultBytes = readInteger('GRAPHQL_MAX_RESULT_BYTES', 64 * 1_024 * 1_024, {
    minimum: 64 * 1_024 * 1_024,
    maximum: 1 * 1_024 * 1_024 * 1_024,
  });
  const graphqlExecutionMemoryMaxBytes = readInteger(
    'GRAPHQL_EXECUTION_MEMORY_MAX_BYTES',
    512 * 1_024 * 1_024,
    { minimum: 64 * 1_024 * 1_024, maximum: 16 * 1_024 * 1_024 * 1_024 }
  );
  if (graphqlMaxResultBytes > graphqlExecutionMemoryMaxBytes) {
    invalid('GRAPHQL_EXECUTION_MEMORY_MAX_BYTES', 'must be at least GRAPHQL_MAX_RESULT_BYTES');
  }

  return {
    host,
    port: readInteger('PORT', 4350, { minimum: 1, maximum: 65_535 }),
    graphqlPath: validateGraphqlPath(readString('GRAPHQL_PATH', '/graphql')),
    httpListenBacklog: readInteger('HTTP_LISTEN_BACKLOG', 4_096, { minimum: 1, maximum: 65_535 }),
    httpShutdownTimeoutMs: readInteger('HTTP_SHUTDOWN_TIMEOUT_MS', 30_000, {
      minimum: 1,
      maximum: 3_600_000,
    }),
    httpKeepAliveTimeoutMs,
    httpHeadersTimeoutMs,
    httpRequestTimeoutMs,
    httpMaxConnections: readInteger('HTTP_MAX_CONNECTIONS', 10_000, {
      minimum: 1,
      maximum: 1_000_000,
    }),
    httpMaxHeaderBytes: readInteger('HTTP_MAX_HEADER_BYTES', 16 * 1_024, {
      minimum: 1_024,
      maximum: 64 * 1_024,
    }),
    httpMaxRequestsPerSocket: readInteger('HTTP_MAX_REQUESTS_PER_SOCKET', 1_000, {
      minimum: 1,
      maximum: 100_000,
    }),
    rateLimitWindowMs: readInteger('RATE_LIMIT_WINDOW_MS', 60_000, {
      minimum: 1_000,
      maximum: 3_600_000,
    }),
    rateLimitMax: readInteger('RATE_LIMIT_MAX', 600, {
      minimum: 1,
      maximum: 1_000_000,
    }),
    rateLimitMaxKeys: readInteger('RATE_LIMIT_MAX_KEYS', 20_000, {
      minimum: 1,
      maximum: 1_000_000,
    }),
    rateLimitGlobalWindowMs: readInteger('RATE_LIMIT_GLOBAL_WINDOW_MS', 60_000, {
      minimum: 1_000,
      maximum: 3_600_000,
    }),
    rateLimitGlobalMax: readInteger('RATE_LIMIT_GLOBAL_MAX', 50_000, {
      minimum: 1,
      maximum: 10_000_000,
    }),
    graphqlHttpMaxBodyBytes: readInteger('GRAPHQL_HTTP_MAX_BODY_BYTES', 256 * 1_024, {
      minimum: 1,
      maximum: 16 * 1_024 * 1_024,
    }),
    graphqlHttpMaxInFlight: readInteger('GRAPHQL_HTTP_MAX_IN_FLIGHT', 100, {
      minimum: 1,
      maximum: 10_000,
    }),
    graphqlMaxDepth: readInteger('GRAPHQL_MAX_DEPTH', 12, { minimum: 1, maximum: 100 }),
    graphqlMaxDocumentNodes: readInteger('GRAPHQL_MAX_DOCUMENT_NODES', 2_000, {
      minimum: 1,
      maximum: 100_000,
    }),
    graphqlMaxFields: readInteger('GRAPHQL_MAX_FIELDS', 500, { minimum: 1, maximum: 50_000 }),
    graphqlMaxAliases: readInteger('GRAPHQL_MAX_ALIASES', 50, { minimum: 0, maximum: 10_000 }),
    graphqlMaxFragmentSpreads: readInteger('GRAPHQL_MAX_FRAGMENT_SPREADS', 100, {
      minimum: 0,
      maximum: 10_000,
    }),
    graphqlMaxOperationCost: readInteger('GRAPHQL_MAX_OPERATION_COST', 100_000, {
      minimum: 1,
      maximum: 1_000_000_000,
    }),
    graphqlAllowIntrospection: readBoolean('GRAPHQL_ALLOW_INTROSPECTION'),
    graphqlWsMaxPayloadBytes: readInteger('GRAPHQL_WS_MAX_PAYLOAD_BYTES', 64 * 1_024, {
      minimum: 1,
      maximum: 16 * 1_024 * 1_024,
    }),
    graphqlWsConnectionInitTimeoutMs: readInteger('GRAPHQL_WS_CONNECTION_INIT_TIMEOUT_MS', 30_000, {
      minimum: 1,
      maximum: 3_600_000,
    }),
    graphqlWsMaxConnections: readInteger('GRAPHQL_WS_MAX_CONNECTIONS', 1_000, {
      minimum: 1,
      maximum: 1_000_000,
    }),
    graphqlWsMaxConnectionsPerClient: readInteger('GRAPHQL_WS_MAX_CONNECTIONS_PER_CLIENT', 16, {
      minimum: 1,
      maximum: 10_000,
    }),
    graphqlWsMaxOperations: readInteger('GRAPHQL_WS_MAX_OPERATIONS', 2_000, {
      minimum: 1,
      maximum: 1_000_000,
    }),
    graphqlWsMaxOperationsPerConnection: readInteger('GRAPHQL_WS_MAX_OPERATIONS_PER_CONNECTION', 20, {
      minimum: 1,
      maximum: 10_000,
    }),
    graphqlWsMaxPendingMessagesPerConnection: readInteger(
      'GRAPHQL_WS_MAX_PENDING_MESSAGES_PER_CONNECTION',
      64,
      { minimum: 1, maximum: 10_000 }
    ),
    graphqlCacheMaxEntries: readInteger('GRAPHQL_CACHE_MAX_ENTRIES', 1_000, {
      minimum: 0,
      maximum: 1_000_000,
    }),
    graphqlCacheMaxBytes: readInteger('GRAPHQL_CACHE_MAX_BYTES', 64 * 1_024 * 1_024, {
      minimum: 0,
      maximum: 16 * 1_024 * 1_024 * 1_024,
    }),
    graphqlCacheTtlMs: readInteger('GRAPHQL_CACHE_TTL_MS', 2_000, {
      minimum: 0,
      maximum: 3_600_000,
    }),
    graphqlMaxResultBytes,
    graphqlExecutionMemoryMaxBytes,
    storageEngine: readEnum('STORAGE_ENGINE', 'postgres', ['postgres', 'rocksdb']),
    databaseUrl,
    skipPostgresMigration: readBoolean('SKIP_POSTGRES_MIGRATION'),
    postgresPoolMax: readInteger('POSTGRES_POOL_MAX', 20, { minimum: 1, maximum: 1_000 }),
    postgresListenPoolMax: readInteger('POSTGRES_LISTEN_POOL_MAX', 2, { minimum: 1, maximum: 100 }),
    postgresConnectionTimeoutMs: readInteger('POSTGRES_CONNECTION_TIMEOUT_MS', 10_000, {
      minimum: 1,
      maximum: 3_600_000,
    }),
    postgresQueryTimeoutMs: readInteger('POSTGRES_QUERY_TIMEOUT_MS', 120_000, {
      minimum: 1,
      maximum: 3_600_000,
    }),
    postgresStatementTimeoutMs: readInteger('POSTGRES_STATEMENT_TIMEOUT_MS', 120_000, {
      minimum: 1,
      maximum: 3_600_000,
    }),
    postgresMigrationQueryTimeoutMs: readInteger('POSTGRES_MIGRATION_QUERY_TIMEOUT_MS', 0, {
      minimum: 0,
      maximum: 2_147_483_647,
    }),
    postgresMigrationStatementTimeoutMs: readInteger('POSTGRES_MIGRATION_STATEMENT_TIMEOUT_MS', 0, {
      minimum: 0,
      maximum: 2_147_483_647,
    }),
    postgresWatchQueueMax: readInteger('POSTGRES_WATCH_QUEUE_MAX', 1_000, {
      minimum: 1,
      maximum: 1_000_000,
    }),
    postgresWatchReconnectMinDelayMs,
    postgresWatchReconnectMaxDelayMs,
    rocksdbPath: readString('ROCKSDB_PATH', './data/polkaswap-indexer.rocksdb'),
    rocksdbBlockCacheMb: readInteger('ROCKSDB_BLOCK_CACHE_MB', 512, { minimum: 0, maximum: 65_536 }),
    rocksdbWriteBufferManagerMb: readInteger('ROCKSDB_WRITE_BUFFER_MANAGER_MB', 256, {
      minimum: 0,
      maximum: 65_536,
    }),
    rocksdbParallelism: readInteger('ROCKSDB_PARALLELISM', 4, { minimum: 1, maximum: 256 }),
    rocksdbEnableStats: readBoolean('ROCKSDB_ENABLE_STATS'),
    rocksdbDocumentCacheMax: readInteger('ROCKSDB_DOCUMENT_CACHE_MAX', 10_000, {
      minimum: 0,
      maximum: 1_000_000,
    }),
    rocksdbDocumentCacheMaxBytes: readInteger('ROCKSDB_DOCUMENT_CACHE_MAX_BYTES', 256 * 1_024 * 1_024, {
      minimum: 0,
      maximum: 64 * 1_024 * 1_024 * 1_024,
    }),
    rocksdbWatchQueueMax: readInteger('ROCKSDB_WATCH_QUEUE_MAX', 1_000, {
      minimum: 1,
      maximum: 1_000_000,
    }),
    rocksdbQueryMaxScannedRows: readInteger('ROCKSDB_QUERY_MAX_SCANNED_ROWS', 100_000, {
      minimum: 1,
      maximum: 100_000_000,
    }),
    rocksdbCompactionMinFreeGb: readNumber('ROCKSDB_COMPACTION_MIN_FREE_GB', 10, 0),
    soraWsEndpoint,
    chainStartBlock: readInteger('CHAIN_START_BLOCK', 0, { minimum: 0 }),
    chainBatchSize: readInteger('CHAIN_BATCH_SIZE', 25, { minimum: 1, maximum: 1_000 }),
    stateRefreshIntervalBlocks: readInteger('CHAIN_STATE_REFRESH_INTERVAL_BLOCKS', 25, { minimum: 1 }),
    snapshotIntervalBlocks: readInteger('CHAIN_SNAPSHOT_INTERVAL_BLOCKS', 25, { minimum: 1 }),
    fullReconciliationIntervalBlocks: readInteger('CHAIN_STATE_FULL_RECONCILIATION_INTERVAL_BLOCKS', 250, {
      minimum: 1,
    }),
    chainShutdownTimeoutMs: readInteger('CHAIN_SHUTDOWN_TIMEOUT_MS', 30_000, { minimum: 1 }),
    chainRpcTimeoutMs: readInteger('CHAIN_RPC_TIMEOUT_MS', 15_000, {
      minimum: 1,
      maximum: 3_600_000,
    }),
    chainRpcMaxInFlight,
    derivedStorageLoadMaxBytes: readInteger('CHAIN_DERIVED_STORAGE_LOAD_MAX_BYTES', 268_435_456, {
      minimum: 1_048_576,
      maximum: 4_294_967_296,
    }),
    derivedStorageCacheMaxBytes: readInteger('CHAIN_DERIVED_STORAGE_CACHE_MAX_BYTES', 67_108_864, {
      minimum: 0,
      maximum: 4_294_967_296,
    }),
    analyticsInputCacheMaxBytes: readInteger('CHAIN_ANALYTICS_INPUT_CACHE_MAX_BYTES', 134_217_728, {
      minimum: 0,
      maximum: 4_294_967_296,
    }),
    backfillPrefetchConcurrency,
    finalizedCatchupPrefetchConcurrency,
    priceStreamRefreshIntervalBlocks: readInteger('CHAIN_PRICE_STREAM_REFRESH_INTERVAL_BLOCKS', 0, {
      minimum: 0,
      maximum: 10_000_000,
    }),
    legacySoraBlockTypes: readBoolean('CHAIN_LEGACY_SORA_BLOCK_TYPES'),
    archiveSoraWsEndpoint: readSoraArchiveWsEndpoint() ?? '',
    workerReadinessMaxLagBlocks: readInteger('WORKER_READINESS_MAX_LAG_BLOCKS', 25, { minimum: 0 }),
    workerReadinessMaxStalenessSeconds: readInteger('WORKER_READINESS_MAX_STALENESS_SECONDS', 120, {
      minimum: 30,
    }),
    workerMetricsHost,
    workerMetricsPort: readInteger('WORKER_METRICS_PORT', 9464, { minimum: 1, maximum: 65_535 }),
    workerMetricsMaxInFlight: readInteger('WORKER_METRICS_MAX_IN_FLIGHT', 10, {
      minimum: 1,
      maximum: 10_000,
    }),
  };
}
