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
  'DATABASE_URL',
  'SORA_WS_ENDPOINT',
  'SORA_ARCHIVE_WS_ENDPOINT',
  'CHAIN_START_BLOCK',
  'CHAIN_BATCH_SIZE',
  'CHAIN_STATE_REFRESH_INTERVAL_BLOCKS',
  'CHAIN_SNAPSHOT_INTERVAL_BLOCKS',
  'GRAPHQL_HTTP_MAX_BODY_BYTES',
  'HTTP_MAX_HEADER_BYTES',
  'HTTP_LISTEN_BACKLOG',
  'HTTP_SHUTDOWN_TIMEOUT_MS',
  'HTTP_KEEP_ALIVE_TIMEOUT_MS',
  'HTTP_HEADERS_TIMEOUT_MS',
  'HTTP_REQUEST_TIMEOUT_MS',
  'HTTP_MAX_CONNECTIONS',
  'HTTP_MAX_REQUESTS_PER_SOCKET',
  'RATE_LIMIT_WINDOW_MS',
  'RATE_LIMIT_MAX',
  'RATE_LIMIT_MAX_KEYS',
  'RATE_LIMIT_GLOBAL_WINDOW_MS',
  'RATE_LIMIT_GLOBAL_MAX',
  'GRAPHQL_MAX_DEPTH',
  'GRAPHQL_MAX_FIELDS',
  'GRAPHQL_MAX_ALIASES',
  'GRAPHQL_ALLOW_INTROSPECTION',
  'GRAPHQL_WS_MAX_PAYLOAD_BYTES',
  'GRAPHQL_WS_MAX_CONNECTIONS',
  'GRAPHQL_WS_MAX_CONNECTIONS_PER_CLIENT',
  'GRAPHQL_WS_MAX_OPERATIONS_PER_CONNECTION',
  'GRAPHQL_WS_CONNECTION_INIT_TIMEOUT_MS',
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
      databaseUrl: 'postgres://polkaswap:polkaswap@127.0.0.1:5432/polkaswap_indexer',
      soraWsEndpoint: 'wss://mof2.sora.org',
      chainStartBlock: 0,
      chainBatchSize: 25,
      stateRefreshIntervalBlocks: 25,
      snapshotIntervalBlocks: 25,
    });
  });

  it('accepts canonical production overrides', () => {
    setEnv({
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: '4444',
      GRAPHQL_PATH: '/alt-graphql',
      DATABASE_URL: 'postgresql://user:pass@db.example.invalid:5432/indexer?sslmode=require',
      SORA_WS_ENDPOINT: 'wss://sora.example.invalid/socket',
      CHAIN_START_BLOCK: '100',
      CHAIN_BATCH_SIZE: '30',
      CHAIN_STATE_REFRESH_INTERVAL_BLOCKS: '50',
      CHAIN_SNAPSHOT_INTERVAL_BLOCKS: '75',
    });

    expect(readConfig()).toEqual({
      host: '127.0.0.1',
      port: 4444,
      graphqlPath: '/alt-graphql',
      databaseUrl: 'postgresql://user:pass@db.example.invalid:5432/indexer?sslmode=require',
      soraWsEndpoint: 'wss://sora.example.invalid/socket',
      chainStartBlock: 100,
      chainBatchSize: 30,
      stateRefreshIntervalBlocks: 50,
      snapshotIntervalBlocks: 75,
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
});
