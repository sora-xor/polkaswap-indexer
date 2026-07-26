import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const readProjectFile = (name: string): Promise<string> => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

const composeService = (compose: string, name: string): string => {
  const marker = `\n  ${name}:\n`;
  const start = compose.indexOf(marker);
  if (start < 0) throw new Error(`Missing Compose service: ${name}`);
  const body = compose.slice(start + 1);
  const nextService = body.slice(marker.length - 1).search(/\n  [a-zA-Z0-9][a-zA-Z0-9-]*:\n|\nvolumes:\n/);
  return nextService < 0 ? body : body.slice(0, marker.length - 1 + nextService);
};

describe('production container contract', () => {
  it('uses an immutable install and a production-only non-root runtime', async () => {
    const dockerfile = await readProjectFile('Dockerfile');

    expect(dockerfile).toContain('yarn install --immutable');
    expect(dockerfile).not.toContain('|| yarn install');
    expect(dockerfile).toContain('yarn workspaces focus --all --production');
    expect(dockerfile).toContain('COPY --from=production-dependencies --chown=node:node /app/node_modules');
    expect(dockerfile).toContain('RUN install -d -o node -g node /data');
    expect(dockerfile).toContain('ROCKSDB_PATH=/data/polkaswap-indexer.rocksdb');
    expect(dockerfile).toContain('COPY --chown=node:node LICENSE ./LICENSE');
    expect(dockerfile).toMatch(/\nUSER node\n/);
    expect(dockerfile).toContain('STOPSIGNAL SIGTERM');
    expect(dockerfile).toContain('CMD ["node", "dist/src/index.js"]');
  });

  it('exposes compiled maintenance commands that work without development dependencies', async () => {
    const packageJson = JSON.parse(await readProjectFile('package.json')) as {
      scripts?: Record<string, string>;
    };
    const expectedScripts = [
      'db:migrate:dist',
      'storage:migrate:postgres-to-rocksdb:dist',
      'storage:verify:rocksdb:dist',
      'storage:backup:rocksdb:dist',
      'storage:restore:rocksdb:dist',
      'storage:checkpoint:rocksdb:dist',
      'storage:compact:rocksdb:dist',
      'storage:audit:rocksdb:dist',
      'storage:benchmark:rocksdb:dist',
      'storage:reclaim:postgres-index-space:dist',
      'storage:cleanup:postgres-rocksdb-capture:dist',
    ];

    for (const name of expectedScripts) {
      expect(packageJson.scripts?.[name]).toMatch(/^node dist\/src\//);
      expect(packageJson.scripts?.[name]).not.toContain('tsx');
    }
  });

  it('uses the compiled identity smoke with environment-driven health routing', async () => {
    const dockerfile = await readProjectFile('Dockerfile');

    expect(dockerfile).toContain('node dist/src/scripts/production-smoke.js');
    expect(dockerfile).toContain(
      '"http://127.0.0.1:${PORT:-4350}${GRAPHQL_PATH:-/graphql}"'
    );
    expect(dockerfile).toContain('POLKASWAP_INDEXER_SMOKE_TIMEOUT_MS=4000');
    expect(dockerfile).not.toContain('http://127.0.0.1:4350/graphql');
  });

  it('overrides standalone worker healthchecks to use the isolated readiness listener', async () => {
    const compose = await readProjectFile('docker-compose.yml');

    expect(compose).toContain('WORKER_METRICS_HOST: 127.0.0.1');
    expect(compose).toContain('WORKER_METRICS_PORT: 9464');
    expect(compose).toContain("'http://127.0.0.1:'+port+'/health'");
    expect(compose).toContain("process.env.WORKER_METRICS_PORT??'9464'");
    expect(compose.match(/stop_grace_period: 4m/g)).toHaveLength(5);
  });

  it('runs PostgreSQL migrations once before starting migration-disabled services', async () => {
    const compose = await readProjectFile('docker-compose.yml');
    const migration = composeService(compose, 'migrate');

    expect(migration).toContain('restart: "no"');
    expect(migration).toContain('condition: service_healthy');
    expect(migration).toContain('POSTGRES_MIGRATION_DATABASE_URL');
    expect(migration).toContain('POSTGRES_MIGRATION_QUERY_TIMEOUT_MS');
    expect(migration).toContain('POSTGRES_MIGRATION_STATEMENT_TIMEOUT_MS');
    expect(migration).toContain('disable: true');
    expect(migration).toContain('["node", "dist/src/db/migrate.js"]');
    expect(migration).not.toContain('ports:');

    for (const serviceName of ['api', 'worker']) {
      const service = composeService(compose, serviceName);
      expect(service).toContain('migrate:');
      expect(service).toContain('condition: service_completed_successfully');
      expect(service).toContain('SKIP_POSTGRES_MIGRATION: "true"');
    }

    expect(composeService(compose, 'api')).toContain('POSTGRES_API_DATABASE_URL');
    expect(composeService(compose, 'worker')).toContain('POSTGRES_WORKER_DATABASE_URL');
  });

  it('isolates the production migration owner from migration-disabled runtime roles', async () => {
    const compose = await readProjectFile('docker-compose.production.yml');
    const migration = composeService(compose, 'migrate');
    const api = composeService(compose, 'api');
    const worker = composeService(compose, 'worker');

    expect(compose.match(/<<: \*runtime-security/g)).toHaveLength(3);
    expect(migration).toContain('restart: "no"');
    expect(migration).toContain('["node", "dist/src/db/migrate.js"]');
    expect(migration).toContain('POLKASWAP_MIGRATION_OWNER_DATABASE_URL:?');
    expect(migration).toContain('disable: true');
    expect(migration).not.toContain('SKIP_POSTGRES_MIGRATION');
    expect(migration).not.toContain('ports:');

    for (const service of [api, worker]) {
      expect(service).toContain('depends_on:\n      migrate:\n        condition: service_completed_successfully');
      expect(service).toContain('SKIP_POSTGRES_MIGRATION: "true"');
      expect(service).not.toContain('POLKASWAP_MIGRATION_OWNER_DATABASE_URL');
    }

    expect(api).toContain('POLKASWAP_API_DATABASE_URL:?');
    expect(api).not.toContain('POLKASWAP_WORKER_DATABASE_URL');
    expect(worker).toContain('POLKASWAP_WORKER_DATABASE_URL:?');
    expect(worker).not.toContain('POLKASWAP_API_DATABASE_URL');
    expect(compose).not.toContain('POLKASWAP_DATABASE_URL');
  });

  it('keeps production shutdown and logs bounded without documenting credential-rendering validation', async () => {
    const compose = await readProjectFile('docker-compose.production.yml');
    const readme = await readProjectFile('README.md');

    expect(compose).toContain('stop_grace_period: 4m');
    expect(compose).toContain('logging: *bounded-logging');
    expect(compose).toContain('max-size: "10m"');
    expect(compose).toContain('max-file: "5"');
    expect(readme).toContain('docker compose -f docker-compose.production.yml config --quiet');
    expect(readme).toContain('docker compose -f docker-compose.production.yml config --no-interpolate');
    expect(readme).not.toMatch(/docker compose -f docker-compose\.production\.yml config\s*\n/);
  });

  it('keeps the PostgreSQL and RocksDB Compose profiles mutually exclusive', async () => {
    const compose = await readProjectFile('docker-compose.yml');

    for (const serviceName of ['postgres', 'migrate', 'api', 'worker']) {
      const service = composeService(compose, serviceName);
      expect(service).toMatch(/profiles:\n\s+- postgres(?:\n|$)/);
      expect(service).not.toMatch(/profiles:\n\s+- rocksdb(?:\n|$)/);
    }

    const combined = composeService(compose, 'combined-rocksdb');
    expect(combined).toMatch(/profiles:\n\s+- rocksdb(?:\n|$)/);
    expect(combined).not.toMatch(/profiles:\n\s+- postgres(?:\n|$)/);
    expect(compose.match(/\n\s+profiles:\n\s+- postgres\n/g)).toHaveLength(4);
    expect(compose.match(/\n\s+profiles:\n\s+- rocksdb\n/g)).toHaveLength(1);
  });

  it('documents profile-wide deployment and targeted development commands', async () => {
    const readme = await readProjectFile('README.md');

    expect(readme).toContain('docker compose --profile postgres up --build');
    expect(readme).toContain('docker compose --profile rocksdb up --build');
    expect(readme).toContain('docker compose up postgres');
    expect(readme).toContain('docker compose up api worker --build');
    expect(readme).toMatch(/Do not enable\s+both complete profiles together/);
  });

  it('bounds service logs without coupling the RocksDB profile to PostgreSQL', async () => {
    const compose = await readProjectFile('docker-compose.yml');
    const combined = composeService(compose, 'combined-rocksdb');

    expect(compose).toContain('driver: local');
    expect(compose).toContain('max-size: "${DOCKER_LOG_MAX_SIZE:-10m}"');
    expect(compose).toContain('max-file: "${DOCKER_LOG_MAX_FILE:-5}"');
    expect(compose.match(/logging: \*bounded-logging/g)).toHaveLength(5);
    expect(combined).toContain('- rocksdb');
    expect(combined).not.toContain('depends_on:');
    expect(combined).not.toContain('SKIP_POSTGRES_MIGRATION');
    expect(combined).not.toContain('DATABASE_URL');
  });

  it('publishes development Postgres only on loopback', async () => {
    const compose = await readProjectFile('docker-compose.yml');
    const postgresService = compose.slice(compose.indexOf('  postgres:'), compose.indexOf('\n  api:'));

    expect(postgresService).toContain('"127.0.0.1:5432:5432"');
    expect(postgresService).not.toMatch(/^\s+-\s+["']?5432:5432/m);
    expect(postgresService).not.toContain('0.0.0.0:5432:5432');
  });

  it('excludes host dependencies, secrets, databases, and development artifacts', async () => {
    const dockerignore = await readProjectFile('.dockerignore');

    for (const pattern of [
      'node_modules/',
      '.git/',
      '.env',
      '*.pem',
      '/data/',
      '/rocksdb/',
      '/backups/',
      '*.rocksdb',
      '/logs/',
      '/tests/',
      '/dist/',
      '/.playwright-cli/',
    ]) {
      expect(dockerignore).toContain(pattern);
    }

    expect(dockerignore).toContain('!.yarn/releases/**');
    expect(dockerignore).toContain('!.yarn/plugins/**');
    expect(dockerignore).toContain('!.yarn/patches/**');
    expect(dockerignore).not.toMatch(/^package\.json\/?$/m);
    expect(dockerignore).not.toMatch(/^yarn\.lock\/?$/m);
    expect(dockerignore).not.toMatch(/^src\/?$/m);
    expect(dockerignore).not.toMatch(/^tsconfig\.json\/?$/m);
  });

  it('ignores runtime databases, backups, checkpoints, and generated output', async () => {
    const gitignore = await readProjectFile('.gitignore');

    for (const pattern of [
      '/data/',
      '/rocksdb/',
      '/backups/',
      '/checkpoints/',
      '/output/',
      '*.rocksdb',
      '**/*-backups/',
      '**/*-checkpoints/',
    ]) {
      expect(gitignore).toContain(pattern);
    }
  });

  it('builds the release image and loads the native RocksDB binding in CI', async () => {
    const workflow = await readProjectFile('.github/workflows/ci.yml');

    expect(workflow).toContain('docker build --tag polkaswap-indexer:ci .');
    expect(workflow).toContain('docker run --rm --entrypoint node polkaswap-indexer:ci');
    expect(workflow).toContain("import('@harperfast/rocksdb-js')");
    expect(workflow).toContain("RocksDatabase.open('/data/ci-native-smoke.rocksdb')");
    expect(workflow).toContain('docker compose --profile postgres config --quiet');
    expect(workflow).toContain('docker compose --profile rocksdb config --quiet');
  });
});
