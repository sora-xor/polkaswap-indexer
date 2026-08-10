#!/usr/bin/env node

const failures = [];

const fail = (message) => {
  failures.push(message);
};

const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const mobileCapabilityNames = [
  'MOBILE_CONFIG_NEXUS_AVAILABLE',
  'MOBILE_CONFIG_NEXUS_SENDS_AVAILABLE',
  'MOBILE_CONFIG_POLKAMARKT_VISIBLE',
  'MOBILE_CONFIG_POLKAMARKT_MUTATIONS_AVAILABLE',
  'MOBILE_CONFIG_TAIRA_DEFAULT_VISIBLE',
];
const parseExpectedMobileCapabilities = () => {
  if (process.argv.length === 2) return ['true', 'false', 'true', 'false', 'true'];
  if (process.argv.length !== 4 || process.argv[2] !== '--mobile-capabilities') {
    console.error(
      '[deployment-manifest-resolved][error] expected no arguments or --mobile-capabilities <five comma-separated booleans>'
    );
    process.exit(1);
  }
  const values = process.argv[3].split(',');
  if (
    values.length !== mobileCapabilityNames.length ||
    values.some((value) => value !== 'true' && value !== 'false')
  ) {
    console.error(
      '[deployment-manifest-resolved][error] --mobile-capabilities must contain exactly five comma-separated booleans'
    );
    process.exit(1);
  }
  return values;
};
const expectedMobileCapabilityValues = parseExpectedMobileCapabilities();
const expectedMobileCapabilities = Object.fromEntries(
  mobileCapabilityNames.map((name, index) => [name, expectedMobileCapabilityValues[index]])
);

let input = '';
for await (const chunk of process.stdin) input += chunk;

let manifest;
try {
  manifest = JSON.parse(input);
} catch {
  console.error('[deployment-manifest-resolved][error] resolved Compose JSON is invalid');
  process.exit(1);
}

const services = isRecord(manifest.services) ? manifest.services : {};
const serviceNames = Object.keys(services).sort();
if (serviceNames.join(',') !== 'api,migrate,worker') {
  fail('resolved Compose must contain exactly migrate, api, and worker');
}

const expectedCommands = {
  migrate: ['node', 'dist/src/scripts/production-migrate.js'],
  api: ['node', 'dist/src/index.js'],
  worker: ['node', 'dist/src/worker/index.js'],
};
const expectedRestarts = {
  migrate: 'no',
  api: 'unless-stopped',
  worker: 'unless-stopped',
};
const expectedImage =
  'registry.invalid/polkaswap-indexer@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const expectedEnvironments = {
  migrate: {
    DATABASE_URL:
      'postgresql://manifest_migration_owner:owner-test-only@database.invalid/polkaswap?sslmode=verify-full',
    NODE_ENV: 'production',
    POLKASWAP_API_DATABASE_URL:
      'postgresql://manifest_api:api-test-only@database.invalid/polkaswap?sslmode=verify-full',
    POLKASWAP_WORKER_DATABASE_URL:
      'postgresql://manifest_worker:worker-test-only@database.invalid/polkaswap?sslmode=verify-full',
    POSTGRES_MIGRATION_QUERY_TIMEOUT_MS: '0',
    POSTGRES_MIGRATION_STATEMENT_TIMEOUT_MS: '0',
    STORAGE_ENGINE: 'postgres',
  },
  api: {
    DATABASE_URL:
      'postgresql://manifest_api:api-test-only@database.invalid/polkaswap?sslmode=verify-full',
    GRAPHQL_ALLOW_INTROSPECTION: 'false',
    GRAPHQL_HTTP_MAX_BODY_BYTES: '65536',
    GRAPHQL_HTTP_MAX_IN_FLIGHT: '100',
    GRAPHQL_MAX_ALIASES: '50',
    GRAPHQL_MAX_DEPTH: '12',
    GRAPHQL_MAX_DOCUMENT_NODES: '2000',
    GRAPHQL_MAX_FIELDS: '300',
    GRAPHQL_MAX_FRAGMENT_SPREADS: '100',
    GRAPHQL_MAX_OPERATION_COST: '100000',
    GRAPHQL_PATH: '/graphql',
    GRAPHQL_WS_CONNECTION_INIT_TIMEOUT_MS: '10000',
    GRAPHQL_WS_MAX_CONNECTIONS: '512',
    GRAPHQL_WS_MAX_CONNECTIONS_PER_CLIENT: '512',
    GRAPHQL_WS_MAX_OPERATIONS: '1024',
    GRAPHQL_WS_MAX_OPERATIONS_PER_CONNECTION: '32',
    GRAPHQL_WS_MAX_PAYLOAD_BYTES: '65536',
    GRAPHQL_WS_MAX_PENDING_MESSAGES_PER_CONNECTION: '64',
    HOST: '0.0.0.0',
    HTTP_MAX_CONNECTIONS: '2048',
    HTTP_MAX_HEADER_BYTES: '16384',
    HTTP_MAX_REQUESTS_PER_SOCKET: '1000',
    ...expectedMobileCapabilities,
    NODE_ENV: 'production',
    PORT: '4350',
    RATE_LIMIT_GLOBAL_MAX: '50000',
    RATE_LIMIT_GLOBAL_WINDOW_MS: '60000',
    RATE_LIMIT_MAX: '50000',
    RATE_LIMIT_MAX_KEYS: '20000',
    RATE_LIMIT_WINDOW_MS: '60000',
    SKIP_POSTGRES_MIGRATION: 'true',
    STORAGE_ENGINE: 'postgres',
  },
  worker: {
    CHAIN_BATCH_SIZE: '25',
    CHAIN_SNAPSHOT_INTERVAL_BLOCKS: '25',
    CHAIN_START_BLOCK: '14000000',
    CHAIN_STATE_REFRESH_INTERVAL_BLOCKS: '25',
    DATABASE_URL:
      'postgresql://manifest_worker:worker-test-only@database.invalid/polkaswap?sslmode=verify-full',
    NODE_ENV: 'production',
    PI_WORKER_HEALTH_TIMEOUT_MS: '4000',
    SKIP_POSTGRES_MIGRATION: 'true',
    SORA_ARCHIVE_WS_ENDPOINT: 'wss://archive.invalid',
    SORA_WS_ENDPOINT: 'wss://primary.invalid',
    STORAGE_ENGINE: 'postgres',
  },
};
const expectedServiceKeys = {
  migrate: [
    'cap_drop',
    'command',
    'entrypoint',
    'environment',
    'healthcheck',
    'image',
    'init',
    'logging',
    'networks',
    'pids_limit',
    'read_only',
    'restart',
    'security_opt',
    'stop_grace_period',
    'tmpfs',
    'user',
  ],
  api: [
    'cap_drop',
    'command',
    'depends_on',
    'entrypoint',
    'environment',
    'image',
    'init',
    'logging',
    'networks',
    'pids_limit',
    'ports',
    'read_only',
    'restart',
    'security_opt',
    'stop_grace_period',
    'tmpfs',
    'user',
  ],
  worker: [
    'cap_drop',
    'command',
    'depends_on',
    'entrypoint',
    'environment',
    'healthcheck',
    'image',
    'init',
    'logging',
    'networks',
    'pids_limit',
    'read_only',
    'restart',
    'security_opt',
    'stop_grace_period',
    'tmpfs',
    'user',
  ],
};
const forbiddenNamespaceKeys = [
  'dns',
  'dns_opt',
  'dns_search',
  'extra_hosts',
  'ipc',
  'network_mode',
  'pid',
  'uts',
  'userns_mode',
];

const exactArray = (actual, expected) =>
  Array.isArray(actual) &&
  actual.length === expected.length &&
  actual.every((value, index) => value === expected[index]);
const exactRecord = (actual, expected) =>
  isRecord(actual) &&
  Object.keys(actual).sort().join('\0') === Object.keys(expected).sort().join('\0') &&
  Object.entries(expected).every(([key, value]) => actual[key] === value);

for (const name of ['migrate', 'api', 'worker']) {
  const service = services[name];
  if (!isRecord(service)) {
    fail(`resolved ${name} service is missing`);
    continue;
  }
  for (const key of forbiddenNamespaceKeys) {
    if (service[key] !== null && service[key] !== undefined) {
      fail(`resolved ${name} must not override host or network namespaces`);
    }
  }
  if (
    Object.keys(service).sort().join('\0') !==
    [...expectedServiceKeys[name]].sort().join('\0')
  ) {
    fail(`resolved ${name} must contain only its exact audited service keys`);
  }
  if (!exactRecord(service.environment, expectedEnvironments[name])) {
    fail(`resolved ${name} environment must match its exact audited map`);
  }
  if (
    service.image !== expectedImage ||
    service.init !== true ||
    !exactArray(service.cap_drop, ['ALL']) ||
    !exactArray(service.security_opt, ['no-new-privileges:true']) ||
    service.pids_limit !== 128 ||
    !exactArray(service.tmpfs, ['/tmp:rw,noexec,nosuid,nodev,size=16m']) ||
    !isRecord(service.networks) ||
    Object.keys(service.networks).length !== 1 ||
    service.networks.default !== null
  ) {
    fail(`resolved ${name} security and image contract is not exact`);
  }
  if (service.stop_grace_period !== '4m0s' && service.stop_grace_period !== '4m') {
    fail(`resolved ${name} stop grace must be exactly four minutes`);
  }
  if (
    !isRecord(service.logging) ||
    service.logging.driver !== 'local' ||
    !isRecord(service.logging.options) ||
    service.logging.options['max-size'] !== '10m' ||
    service.logging.options['max-file'] !== '5'
  ) {
    fail(`resolved ${name} logging must be local with exact 10m/5 bounds`);
  }
  if (service.restart !== expectedRestarts[name]) {
    fail(`resolved ${name} restart policy is invalid`);
  }
  if (service.read_only !== true || service.user !== 'node') {
    fail(`resolved ${name} must remain read-only and non-root`);
  }
  if (!Array.isArray(service.command) || service.command.join('\0') !== expectedCommands[name].join('\0')) {
    fail(`resolved ${name} command is not the exact audited executable`);
  }
  if (service.entrypoint !== null && service.entrypoint !== undefined) {
    fail(`resolved ${name} must not override the image entrypoint`);
  }
  for (const key of [
    'build',
    'cap_add',
    'develop',
    'devices',
    'post_start',
    'pre_stop',
    'privileged',
    'volumes',
    'volumes_from',
    'working_dir',
  ]) {
    if (service[key] !== null && service[key] !== undefined) {
      fail(`resolved ${name} contains forbidden execution override ${key}`);
    }
  }
}

const migration = services.migrate;
const api = services.api;
const worker = services.worker;
const exactSuccessfulMigrationDependency = (service, name) => {
  if (!isRecord(service)) return;
  const dependencies = service.depends_on;
  const dependencyNames = isRecord(dependencies) ? Object.keys(dependencies) : [];
  const dependency = isRecord(dependencies) ? dependencies.migrate : null;
  if (
    dependencyNames.length !== 1 ||
    dependencyNames[0] !== 'migrate' ||
    !isRecord(dependency) ||
    dependency.condition !== 'service_completed_successfully' ||
    dependency.required !== true ||
    Object.keys(dependency).some((key) => key !== 'condition' && key !== 'required')
  ) {
    fail(`resolved ${name} dependency must require successful one-shot migration completion`);
  }
};
exactSuccessfulMigrationDependency(api, 'api');
exactSuccessfulMigrationDependency(worker, 'worker');

const migrationEnvironment = isRecord(migration?.environment) ? migration.environment : {};
const apiEnvironment = isRecord(api?.environment) ? api.environment : {};
const workerEnvironment = isRecord(worker?.environment) ? worker.environment : {};

const hasVerifiedTlsDatabaseUrl = (value) => {
  if (typeof value !== 'string') return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return false;
  const entries = [...url.searchParams.entries()];
  const keys = entries.map(([key]) => key);
  if (
    new Set(keys).size !== keys.length ||
    keys.some((key) => key !== key.toLowerCase()) ||
    keys.some((key) => key !== 'sslmode' && key !== 'sslnegotiation') ||
    url.searchParams.get('sslmode') !== 'verify-full'
  ) {
    return false;
  }
  const sslNegotiation = url.searchParams.get('sslnegotiation');
  return (
    sslNegotiation === null ||
    sslNegotiation === 'direct' ||
    sslNegotiation === 'postgres'
  );
};

if (
  typeof migrationEnvironment.DATABASE_URL !== 'string' ||
  typeof migrationEnvironment.POLKASWAP_API_DATABASE_URL !== 'string' ||
  typeof migrationEnvironment.POLKASWAP_WORKER_DATABASE_URL !== 'string' ||
  new Set([
    migrationEnvironment.DATABASE_URL,
    migrationEnvironment.POLKASWAP_API_DATABASE_URL,
    migrationEnvironment.POLKASWAP_WORKER_DATABASE_URL,
  ]).size !== 3
) {
  fail('resolved migration preflight must receive three distinct credential inputs');
}
if (
  !hasVerifiedTlsDatabaseUrl(migrationEnvironment.DATABASE_URL) ||
  !hasVerifiedTlsDatabaseUrl(migrationEnvironment.POLKASWAP_API_DATABASE_URL) ||
  !hasVerifiedTlsDatabaseUrl(migrationEnvironment.POLKASWAP_WORKER_DATABASE_URL) ||
  !hasVerifiedTlsDatabaseUrl(apiEnvironment.DATABASE_URL) ||
  !hasVerifiedTlsDatabaseUrl(workerEnvironment.DATABASE_URL)
) {
  fail('resolved PostgreSQL URLs must require verified TLS without unaudited controls');
}
if (
  apiEnvironment.DATABASE_URL !== migrationEnvironment.POLKASWAP_API_DATABASE_URL ||
  workerEnvironment.DATABASE_URL !== migrationEnvironment.POLKASWAP_WORKER_DATABASE_URL
) {
  fail('resolved runtime credentials must match the values checked by migration preflight');
}
if (
  apiEnvironment.SKIP_POSTGRES_MIGRATION !== 'true' ||
  workerEnvironment.SKIP_POSTGRES_MIGRATION !== 'true'
) {
  fail('resolved API and worker must disable in-process migration');
}
if (
  Object.hasOwn(apiEnvironment, 'POLKASWAP_MIGRATION_OWNER_DATABASE_URL') ||
  Object.hasOwn(workerEnvironment, 'POLKASWAP_MIGRATION_OWNER_DATABASE_URL')
) {
  fail('resolved runtime services must not receive the migration-owner credential');
}
if (Object.hasOwn(migrationEnvironment, 'SKIP_POSTGRES_MIGRATION')) {
  fail('resolved one-shot migration must not disable itself');
}
if (!isRecord(migration?.healthcheck) || migration.healthcheck.disable !== true) {
  fail('resolved migration must disable the inherited service healthcheck');
}
if (api?.healthcheck !== null && api?.healthcheck !== undefined) {
  fail('resolved api must not override the audited image healthcheck');
}
if (
  !isRecord(worker?.healthcheck) ||
  !Array.isArray(worker.healthcheck.test) ||
  worker.healthcheck.test.join('\0') !==
    ['CMD', 'node', 'dist/src/scripts/worker-health.js'].join('\0') ||
  worker.healthcheck.interval !== '30s' ||
  worker.healthcheck.timeout !== '5s' ||
  worker.healthcheck.start_period !== '30s' ||
  worker.healthcheck.retries !== 3
) {
  fail('resolved worker healthcheck is not the exact database-only probe contract');
}
if (
  !Array.isArray(api?.ports) ||
  api.ports.length !== 1 ||
  !isRecord(api.ports[0]) ||
  Object.keys(api.ports[0]).sort().join(',') !==
    'host_ip,mode,protocol,published,target' ||
  api.ports[0].host_ip !== '127.0.0.1' ||
  api.ports[0].target !== 4350 ||
  api.ports[0].published !== '4350' ||
  api.ports[0].protocol !== 'tcp' ||
  api.ports[0].mode !== 'ingress'
) {
  fail('resolved api must publish exactly TCP 4350 on host loopback');
}
if (
  (Array.isArray(migration?.ports) && migration.ports.length > 0) ||
  (Array.isArray(worker?.ports) && worker.ports.length > 0)
) {
  fail('resolved migrate and worker must not publish ports');
}

if (failures.length > 0) {
  for (const message of failures) {
    console.error(`[deployment-manifest-resolved][error] ${message}`);
  }
  process.exit(1);
}

console.log('[deployment-manifest-resolved] exact per-service contract passed.');
