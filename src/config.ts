export type AppConfig = {
  host: string;
  port: number;
  graphqlPath: string;
  databaseUrl: string;
  soraWsEndpoint: string;
  soraArchiveWsEndpoint?: string | null;
  chainStartBlock: number;
  chainBatchSize: number;
  stateRefreshIntervalBlocks: number;
  snapshotIntervalBlocks: number;
};

export type RuntimeSecurityConfig = {
  httpMaxBodyBytes: number;
  httpMaxHeaderBytes: number;
  httpListenBacklog: number;
  httpShutdownTimeoutMs: number;
  httpKeepAliveTimeoutMs: number;
  httpHeadersTimeoutMs: number;
  httpRequestTimeoutMs: number;
  httpMaxConnections: number;
  httpMaxRequestsPerSocket: number;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  rateLimitMaxKeys: number;
  rateLimitGlobalWindowMs: number;
  rateLimitGlobalMax: number;
  graphqlMaxDepth: number;
  graphqlMaxFields: number;
  graphqlMaxAliases: number;
  graphqlAllowIntrospection: boolean;
  graphqlWsMaxPayloadBytes: number;
  graphqlWsMaxConnections: number;
  graphqlWsMaxConnectionsPerClient: number;
  graphqlWsMaxOperationsPerConnection: number;
  graphqlWsConnectionInitTimeoutMs: number;
};

const DEFAULT_CHAIN_STATE_REFRESH_INTERVAL_BLOCKS = 25;
const DEFAULT_CHAIN_SNAPSHOT_INTERVAL_BLOCKS = 25;
const NODE_ENVIRONMENTS = new Set(['development', 'test', 'production']);

const readNodeEnvironment = (): string => {
  const value = process.env.NODE_ENV ?? 'development';
  if (!NODE_ENVIRONMENTS.has(value)) {
    throw new Error('NODE_ENV must be development, test, or production.');
  }
  return value;
};

const readOptionalString = (name: string): string | undefined => {
  const configured = process.env[name];
  if (configured === undefined) return undefined;
  const value = configured.trim();
  if (value.length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${name} must be a non-empty single-line value.`);
  }
  return value;
};

const readInteger = (
  name: string,
  fallback: number,
  { minimum, maximum = Number.MAX_SAFE_INTEGER }: { minimum: number; maximum?: number }
): number => {
  const configured = process.env[name];
  if (configured === undefined) return fallback;
  const value = configured.trim();
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
};

const readBoolean = (name: string, fallback: boolean): boolean => {
  const configured = process.env[name];
  if (configured === undefined) return fallback;
  const value = configured.trim().toLowerCase();
  if (value === 'true' || value === '1' || value === 'yes') return true;
  if (value === 'false' || value === '0' || value === 'no') return false;
  throw new Error(`${name} must be one of true, false, 1, 0, yes, or no.`);
};

const readHost = (): string => {
  const host = readOptionalString('HOST') ?? '0.0.0.0';
  if (!/^[A-Za-z0-9._:[\]-]+$/.test(host)) {
    throw new Error('HOST must be a hostname or IP address without whitespace.');
  }
  return host;
};

const readGraphqlPath = (): string => {
  const path = readOptionalString('GRAPHQL_PATH') ?? '/graphql';
  if (!/^\/[A-Za-z0-9/_-]*$/.test(path) || path.startsWith('//')) {
    throw new Error('GRAPHQL_PATH must be an absolute URL path without query, fragment, traversal, or encoding.');
  }
  return path;
};

const parseServiceUrl = (
  name: string,
  value: string,
  protocols: ReadonlySet<string>,
  { requireTlsOutsideLocalhost = false }: { requireTlsOutsideLocalhost?: boolean } = {}
): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }
  if (!protocols.has(url.protocol) || !url.hostname) {
    throw new Error(`${name} uses an unsupported URL scheme.`);
  }
  if (url.hash) {
    throw new Error(`${name} must not contain a URL fragment.`);
  }
  if (['SORA_WS_ENDPOINT', 'SORA_ARCHIVE_WS_ENDPOINT'].includes(name) &&
      (url.username || url.password || url.search)) {
    throw new Error(`${name} must not contain URL credentials or a query string.`);
  }
  const localhost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if (requireTlsOutsideLocalhost && !localhost && !['wss:', 'https:'].includes(url.protocol)) {
    throw new Error(`${name} must use TLS outside localhost.`);
  }
  return value;
};

export function readSoraArchiveWsEndpoint(requireConfigured = false): string | null {
  const configured = readOptionalString('SORA_ARCHIVE_WS_ENDPOINT');
  if (!configured) {
    if (requireConfigured) {
      throw new Error('SORA_ARCHIVE_WS_ENDPOINT is required for the production worker.');
    }
    return null;
  }
  return parseServiceUrl(
    'SORA_ARCHIVE_WS_ENDPOINT',
    configured,
    new Set(['ws:', 'wss:']),
    { requireTlsOutsideLocalhost: true },
  );
}

export function assertIndependentSoraRpcEndpoints(primary: string, archive: string): void {
  const primaryUrl = new URL(primary);
  const archiveUrl = new URL(archive);
  if (primaryUrl.hostname.toLowerCase() === archiveUrl.hostname.toLowerCase()) {
    throw new Error('SORA primary and archive endpoints must use different reviewed hosts.');
  }
}

const readDatabaseUrl = (nodeEnvironment: string): string => {
  const configured = readOptionalString('DATABASE_URL');
  if (!configured && nodeEnvironment === 'production') {
    throw new Error('DATABASE_URL is required when NODE_ENV=production.');
  }
  const value = configured ?? 'postgres://polkaswap:polkaswap@127.0.0.1:5432/polkaswap_indexer';
  const parsed = parseServiceUrl('DATABASE_URL', value, new Set(['postgres:', 'postgresql:']));
  const url = new URL(parsed);
  if (url.pathname.length <= 1) {
    throw new Error('DATABASE_URL must include a database name.');
  }
  return parsed;
};

/** Reads and strictly validates all core runtime configuration. */
export function readConfig(): AppConfig {
  const nodeEnvironment = readNodeEnvironment();
  return {
    host: readHost(),
    port: readInteger('PORT', 4350, { minimum: 1, maximum: 65_535 }),
    graphqlPath: readGraphqlPath(),
    databaseUrl: readDatabaseUrl(nodeEnvironment),
    soraWsEndpoint: parseServiceUrl(
      'SORA_WS_ENDPOINT',
      readOptionalString('SORA_WS_ENDPOINT') ?? 'wss://mof2.sora.org',
      new Set(['ws:', 'wss:']),
      { requireTlsOutsideLocalhost: true }
    ),
    chainStartBlock: readInteger('CHAIN_START_BLOCK', 0, { minimum: 0 }),
    chainBatchSize: readInteger('CHAIN_BATCH_SIZE', 25, { minimum: 1 }),
    stateRefreshIntervalBlocks: readInteger(
      'CHAIN_STATE_REFRESH_INTERVAL_BLOCKS',
      DEFAULT_CHAIN_STATE_REFRESH_INTERVAL_BLOCKS,
      { minimum: 1 }
    ),
    snapshotIntervalBlocks: readInteger(
      'CHAIN_SNAPSHOT_INTERVAL_BLOCKS',
      DEFAULT_CHAIN_SNAPSHOT_INTERVAL_BLOCKS,
      { minimum: 1 }
    ),
  };
}

/** Reads fail-closed HTTP, GraphQL, WebSocket, and abuse-control limits. */
export function readRuntimeSecurityConfig(): RuntimeSecurityConfig {
  const nodeEnvironment = readNodeEnvironment();
  const httpKeepAliveTimeoutMs = readInteger('HTTP_KEEP_ALIVE_TIMEOUT_MS', 75_000, {
    minimum: 1_000,
    maximum: 300_000,
  });
  return {
    httpMaxBodyBytes: readInteger('GRAPHQL_HTTP_MAX_BODY_BYTES', 64 * 1024, {
      minimum: 1_024,
      maximum: 1024 * 1024,
    }),
    httpMaxHeaderBytes: readInteger('HTTP_MAX_HEADER_BYTES', 16 * 1024, {
      minimum: 1_024,
      maximum: 64 * 1024,
    }),
    httpListenBacklog: readInteger('HTTP_LISTEN_BACKLOG', 4_096, { minimum: 16, maximum: 65_535 }),
    httpShutdownTimeoutMs: readInteger('HTTP_SHUTDOWN_TIMEOUT_MS', 30_000, {
      minimum: 1_000,
      maximum: 300_000,
    }),
    httpKeepAliveTimeoutMs,
    httpHeadersTimeoutMs: readInteger('HTTP_HEADERS_TIMEOUT_MS', httpKeepAliveTimeoutMs + 5_000, {
      minimum: httpKeepAliveTimeoutMs + 1,
      maximum: 310_000,
    }),
    httpRequestTimeoutMs: readInteger('HTTP_REQUEST_TIMEOUT_MS', 30_000, {
      minimum: 1_000,
      maximum: 300_000,
    }),
    httpMaxConnections: readInteger('HTTP_MAX_CONNECTIONS', 2_048, { minimum: 1, maximum: 100_000 }),
    httpMaxRequestsPerSocket: readInteger('HTTP_MAX_REQUESTS_PER_SOCKET', 1_000, {
      minimum: 1,
      maximum: 100_000,
    }),
    rateLimitWindowMs: readInteger('RATE_LIMIT_WINDOW_MS', 60_000, { minimum: 1_000, maximum: 3_600_000 }),
    rateLimitMax: readInteger('RATE_LIMIT_MAX', 600, { minimum: 1, maximum: 1_000_000 }),
    rateLimitMaxKeys: readInteger('RATE_LIMIT_MAX_KEYS', 20_000, { minimum: 1, maximum: 1_000_000 }),
    rateLimitGlobalWindowMs: readInteger('RATE_LIMIT_GLOBAL_WINDOW_MS', 60_000, {
      minimum: 1_000,
      maximum: 3_600_000,
    }),
    rateLimitGlobalMax: readInteger('RATE_LIMIT_GLOBAL_MAX', 50_000, {
      minimum: 1,
      maximum: 10_000_000,
    }),
    graphqlMaxDepth: readInteger('GRAPHQL_MAX_DEPTH', 12, { minimum: 1, maximum: 100 }),
    graphqlMaxFields: readInteger('GRAPHQL_MAX_FIELDS', 300, { minimum: 1, maximum: 10_000 }),
    graphqlMaxAliases: readInteger('GRAPHQL_MAX_ALIASES', 50, { minimum: 0, maximum: 10_000 }),
    graphqlAllowIntrospection: readBoolean('GRAPHQL_ALLOW_INTROSPECTION', nodeEnvironment !== 'production'),
    graphqlWsMaxPayloadBytes: readInteger('GRAPHQL_WS_MAX_PAYLOAD_BYTES', 64 * 1024, {
      minimum: 1_024,
      maximum: 1024 * 1024,
    }),
    graphqlWsMaxConnections: readInteger('GRAPHQL_WS_MAX_CONNECTIONS', 512, {
      minimum: 1,
      maximum: 100_000,
    }),
    graphqlWsMaxConnectionsPerClient: readInteger('GRAPHQL_WS_MAX_CONNECTIONS_PER_CLIENT', 16, {
      minimum: 1,
      maximum: 10_000,
    }),
    graphqlWsMaxOperationsPerConnection: readInteger('GRAPHQL_WS_MAX_OPERATIONS_PER_CONNECTION', 32, {
      minimum: 1,
      maximum: 10_000,
    }),
    graphqlWsConnectionInitTimeoutMs: readInteger('GRAPHQL_WS_CONNECTION_INIT_TIMEOUT_MS', 10_000, {
      minimum: 1_000,
      maximum: 120_000,
    }),
  };
}
