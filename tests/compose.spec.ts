import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const readWorkerEnvironment = async (filename: string) => {
  const source = await readFile(resolve(repoRoot, filename), 'utf8');
  const workerStart = source.indexOf('\n  worker:\n');

  expect(workerStart, `${filename} must define a worker service`).toBeGreaterThan(-1);

  const remainder = source.slice(workerStart + 1);
  const nextService = remainder.slice(1).search(/\n  [a-zA-Z0-9_-]+:\n/);
  const worker = nextService === -1 ? remainder : remainder.slice(0, nextService + 1);
  const environmentStart = worker.indexOf('    environment:\n');

  expect(environmentStart, `${filename} worker must define an environment`).toBeGreaterThan(-1);

  const environmentRemainder = worker.slice(environmentStart + '    environment:\n'.length);
  const environmentEnd = environmentRemainder.search(/^ {0,4}\S/m);

  return environmentEnd === -1 ? environmentRemainder : environmentRemainder.slice(0, environmentEnd);
};

describe('Compose worker environments', () => {
  it('runs the development worker in development mode without requiring an archive endpoint', async () => {
    const environment = await readWorkerEnvironment('docker-compose.yml');

    expect(environment).toMatch(/^      NODE_ENV: development$/m);
    expect(environment).not.toContain('SORA_ARCHIVE_WS_ENDPOINT');
  });

  it('keeps the production worker fail-closed with an independently configured archive', async () => {
    const environment = await readWorkerEnvironment('docker-compose.production.yml');

    expect(environment).toMatch(/^      NODE_ENV: production$/m);
    expect(environment).toMatch(
      /^      SORA_ARCHIVE_WS_ENDPOINT: "\$\{POLKASWAP_SORA_ARCHIVE_WS_ENDPOINT:\?[^}]+\}"$/m,
    );
  });
});
