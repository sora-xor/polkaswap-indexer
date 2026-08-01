import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createYoga } from 'graphql-yoga';
import { describe, expect, it, vi } from 'vitest';

import { createSchema } from '../src/graphql/resolvers.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { normalizeGraphqlUrl, runProductionSmoke } from '../src/scripts/production-smoke.js';
import { SORA_LEGACY_IDENTITY_ANCHOR, SORA_MAINNET_GENESIS_HASH } from '../src/soraIdentity.js';
import { createPersistedWorkerStatusDocument } from '../src/worker/status.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VALID_BLOCK = 30_000_000;
const VALID_BLOCK_HASH = `0x${'ab'.repeat(32)}`;
const VALID_TIMESTAMP = Math.floor(Date.now() / 1000);
const IDENTITY_BLOCK = SORA_LEGACY_IDENTITY_ANCHOR.block;
const IDENTITY_BLOCK_HASH = SORA_LEGACY_IDENTITY_ANCHOR.hash;
const IDENTITY_TIMESTAMP = SORA_LEGACY_IDENTITY_ANCHOR.timestamp;

const validHealth = {
  ok: true,
  repositoryReady: true,
  service: 'polkaswap-indexer',
  serviceId: 'pi.soramitsu.io',
  schemaVersion: 1,
  ecosystem: 'sora2',
  chainId: 'sora:mainnet',
  network: 'mainnet',
  publicBaseUrl: 'https://pi.soramitsu.io/graphql',
  readOnly: true,
  genesisHash: SORA_MAINNET_GENESIS_HASH,
  latestIndexedBlock: VALID_BLOCK,
  latestIndexedBlockHash: VALID_BLOCK_HASH,
  latestIndexedAt: VALID_TIMESTAMP,
  workerAvailable: true,
  workerReady: true,
  workerReadinessReason: null,
  workerLifecycle: 'running',
  workerStartupComplete: true,
  workerLatestFinalizedBlock: VALID_BLOCK + 5,
  workerLatestIndexedBlock: VALID_BLOCK,
  workerLag: 5,
  workerLastSuccessfulIndexTimestamp: VALID_TIMESTAMP,
  workerLastError: null,
  workerLastErrorTimestamp: null,
};

const readyWorkerHealth = validHealth;

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

const validWorkerState = (
  blockTimestamp = VALID_TIMESTAMP,
  block = VALID_BLOCK,
  blockHash = VALID_BLOCK_HASH,
) => ({
  chainIdentity: {
    id: 'chainIdentity',
    block: IDENTITY_BLOCK,
    data: JSON.stringify({
      schemaVersion: 1,
      genesisHash: SORA_MAINNET_GENESIS_HASH,
      verificationBlock: IDENTITY_BLOCK,
      verificationBlockHash: IDENTITY_BLOCK_HASH,
      verificationBlockTimestamp: IDENTITY_TIMESTAMP,
      migration: 'fresh-database',
    }),
  },
  chainState: {
    id: 'chainState',
    block,
    data: JSON.stringify({
      lastIndexedBlock: block,
      genesisHash: SORA_MAINNET_GENESIS_HASH,
      blockHash,
      blockTimestamp,
    }),
  },
  networkSnapshots: {
    nodes: [{ id: `block-${block}`, type: 'BLOCK', timestamp: blockTimestamp }],
  },
});

const fetchWithHealth = (health: Record<string, unknown>) =>
  vi.fn(async () => jsonResponse({ data: { _health: health, ...validWorkerState() } }));

describe('Polkaswap production smoke', () => {
  it('normalizes host-only endpoints to the GraphQL path', () => {
    expect(normalizeGraphqlUrl('https://pi.soramitsu.io').toString()).toBe('https://pi.soramitsu.io/graphql');
  });

  it('rejects credentialed endpoints before making requests', async () => {
    const fetchImpl = fetchWithHealth(validHealth);

    await expect(runProductionSmoke('https://user:pass@pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
      'must not contain credentials'
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects endpoints with query strings or fragments before making requests', async () => {
    const fetchImpl = fetchWithHealth(validHealth);

    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql?token=secret#fragment', fetchImpl)).rejects.toThrow(
      'must not contain query strings or fragments'
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects non-HTTPS remote endpoints before making requests', async () => {
    const fetchImpl = fetchWithHealth(validHealth);

    await expect(runProductionSmoke('http://pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
      'must use HTTPS outside localhost smoke tests'
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('redacts credentialed endpoints in CLI failure logs', () => {
    const result = spawnSync(
      resolve(repoRoot, 'node_modules/.bin/tsx'),
      ['src/scripts/production-smoke.ts', 'https://operator:secret@pi.soramitsu.io/graphql'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      }
    );
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain('polkaswap production smoke failed for https://pi.soramitsu.io/graphql');
    expect(output).toContain('Polkaswap production smoke URL must not contain credentials');
    expect(output).not.toContain('operator:secret');
  });

  it('redacts query strings and fragments in CLI failure logs', () => {
    const result = spawnSync(
      resolve(repoRoot, 'node_modules/.bin/tsx'),
      ['src/scripts/production-smoke.ts', 'https://pi.soramitsu.io/graphql?token=secret#leaky-fragment'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      }
    );
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain('polkaswap production smoke failed for https://pi.soramitsu.io/graphql');
    expect(output).toContain('Polkaswap production smoke URL must not contain query strings or fragments');
    expect(output).not.toContain('token=secret');
    expect(output).not.toContain('leaky-fragment');
  });

  it('passes when the production endpoint returns the PI/SORA2 health contract', async () => {
    const fetchImpl = fetchWithHealth(validHealth);

    await runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('https://pi.soramitsu.io/graphql');
    expect(init?.method).toBe('POST');
    expect(init?.cache).toBe('no-store');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect((init?.headers as Record<string, string>)['cache-control']).toBe('no-store');
    expect(String(init?.body)).toContain('_health');
    expect(String(init?.body)).toContain('chainIdentity: updatesStream(id: \\"chainIdentity\\")');
    expect(String(init?.body)).toContain('chainState: updatesStream(id: \\"chainState\\")');
    expect(String(init?.body)).toContain('networkSnapshots');
    expect(String(init?.body)).toContain('equalTo: \\"BLOCK\\"');
    expect(init?.redirect).toBe('manual');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('executes the complete smoke query against the real schema and repository ordering', async () => {
    const repository = new MemoryRepository();
    const now = Math.floor(Date.now() / 1000);
    await repository.upsertMany([
      {
        collection: 'updatesStreams',
        id: 'chainIdentity',
        blockHeight: IDENTITY_BLOCK,
        timestamp: IDENTITY_TIMESTAMP,
        data: {
          id: 'chainIdentity',
          block: IDENTITY_BLOCK,
          data: JSON.stringify({
            schemaVersion: 1,
            genesisHash: SORA_MAINNET_GENESIS_HASH,
            verificationBlock: IDENTITY_BLOCK,
            verificationBlockHash: IDENTITY_BLOCK_HASH,
            verificationBlockTimestamp: IDENTITY_TIMESTAMP,
            migration: 'fresh-database',
          }),
        },
      },
      {
        collection: 'updatesStreams',
        id: 'chainState',
        blockHeight: VALID_BLOCK,
        timestamp: now,
        data: {
          id: 'chainState',
          block: VALID_BLOCK,
          data: JSON.stringify({
            lastIndexedBlock: VALID_BLOCK,
            genesisHash: SORA_MAINNET_GENESIS_HASH,
            blockHash: VALID_BLOCK_HASH,
            blockTimestamp: now,
          }),
        },
      },
      {
        collection: 'networkSnapshots',
        id: 'network-all-DEFAULT-unrelated',
        blockHeight: VALID_BLOCK + 1,
        timestamp: now + 1,
        data: { id: 'network-all-DEFAULT-unrelated', type: 'DEFAULT', timestamp: now + 1 },
      },
      {
        collection: 'networkSnapshots',
        id: `block-${VALID_BLOCK}`,
        blockHeight: VALID_BLOCK,
        timestamp: now,
        data: { id: `block-${VALID_BLOCK}`, type: 'BLOCK', timestamp: now },
      },
      createPersistedWorkerStatusDocument({
        lifecycle: 'running',
        startupComplete: true,
        latestFinalizedBlock: VALID_BLOCK,
        latestIndexedBlock: VALID_BLOCK,
        lag: 0,
        lastSuccessfulIndexTimestamp: now,
        lastError: null,
        lastErrorTimestamp: null,
      }, now),
    ]);
    const schema = createSchema();
    const yoga = createYoga({
      schema,
      context: { repository },
      graphqlEndpoint: '/graphql',
      logging: false,
    });
    const fetchImpl = vi.fn(async (url: URL, init?: RequestInit) => yoga.fetch(url, init ?? {}));

    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('rejects redirects without following them or exposing the location', async () => {
    const fetchImpl = vi.fn(async () => new Response('redirecting', {
      status: 302,
      headers: {
        location: 'https://attacker.invalid/?token=must-not-leak',
        'content-type': 'text/plain',
      },
    }));

    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
      /refused redirect HTTP 302; production smoke redirects are forbidden/
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
    await runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl).catch((error) => {
      expect(String(error)).not.toContain('must-not-leak');
    });
  });

  it('enforces the total request deadline for slow and non-cooperative fetches', async () => {
    for (const fetchImpl of [
      vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return jsonResponse({ data: { _health: validHealth, ...validWorkerState() } });
      }),
      vi.fn(async () => new Promise<Response>(() => undefined)),
    ]) {
      const startedAt = Date.now();
      await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl, { timeoutMs: 25 })).rejects.toThrow(
        /timed out after 25ms/
      );
      expect(Date.now() - startedAt).toBeLessThan(500);
    }
  });

  it('rejects oversized response bodies before JSON parsing', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      data: { _health: validHealth, ...validWorkerState() },
      padding: 'x'.repeat(1_000),
    }));

    await expect(runProductionSmoke(
      'https://pi.soramitsu.io/graphql',
      fetchImpl,
      { maxResponseBytes: 256 },
    )).rejects.toThrow('response exceeded the 256-byte limit');
  });

  it.each([
    'text/application/json',
    'application/jsonp',
    'application/json, text/html',
  ])('rejects misleading JSON content type %s', async (contentType) => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ data: { _health: validHealth, ...validWorkerState() } }),
      { status: 200, headers: { 'content-type': contentType } },
    ));

    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
      /did not return JSON\. Content-Type:/
    );
  });

  it('accepts the registered GraphQL JSON structured-suffix media type', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ data: { _health: validHealth, ...validWorkerState() } }),
      { status: 200, headers: { 'content-type': 'application/graphql-response+json; charset="utf-8"' } },
    ));

    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).resolves.toBeUndefined();
  });

  it('validates complete ready-worker details when the deployment exposes a worker', async () => {
    await expect(
      runProductionSmoke('https://pi.soramitsu.io/graphql', fetchWithHealth(readyWorkerHealth))
    ).resolves.toBeUndefined();
  });

  it('rejects an available worker that is not ready even if the top-level flag is inconsistent', async () => {
    await expect(
      runProductionSmoke(
        'https://pi.soramitsu.io/graphql',
        fetchWithHealth({ ...readyWorkerHealth, workerReady: false, workerReadinessReason: 'lag-exceeded' })
      )
    ).rejects.toThrow('available worker must be ready');
  });

  it('rejects a production API that has no shared worker heartbeat', async () => {
    await expect(
      runProductionSmoke(
        'https://pi.soramitsu.io/graphql',
        fetchWithHealth({
          ...validHealth,
          workerAvailable: false,
          workerReady: null,
          workerLifecycle: null,
        })
      )
    ).rejects.toThrow('must expose a shared worker status');
  });

  it('rejects missing or internally inconsistent ready-worker checkpoints', async () => {
    await expect(
      runProductionSmoke(
        'https://pi.soramitsu.io/graphql',
        fetchWithHealth({ ...readyWorkerHealth, workerLatestIndexedBlock: null })
      )
    ).rejects.toThrow('workerLatestIndexedBlock must be a non-negative safe integer');
    await expect(
      runProductionSmoke(
        'https://pi.soramitsu.io/graphql',
        fetchWithHealth({ ...readyWorkerHealth, workerLag: 4 })
      )
    ).rejects.toThrow('workerLag must match');
    await expect(
      runProductionSmoke(
        'https://pi.soramitsu.io/graphql',
        fetchWithHealth({
          ...readyWorkerHealth,
          workerLatestFinalizedBlock: 1_000,
          workerLatestIndexedBlock: 1_001,
          workerLag: 0,
        })
      )
    ).rejects.toThrow('must not exceed');
    await expect(
      runProductionSmoke(
        'https://pi.soramitsu.io/graphql',
        fetchWithHealth({ ...readyWorkerHealth, workerLastError: null, workerLastErrorTimestamp: 1_700_000_000 })
      )
    ).rejects.toThrow('must either both be present');
  });

  it('rejects GraphQL errors even when HTTP status is successful', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ errors: [{ message: 'resolver failed' }] }));

    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
      /GraphQL endpoint returned errors: .*resolver failed.*Production routing must serve the polkaswap-indexer GraphQL API/
    );
  });

  it('reports transport failures with fetch cause metadata and a routing hint', async () => {
    const networkError = new TypeError('fetch failed', {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND pi.soramitsu.io'), {
        code: 'ENOTFOUND',
        syscall: 'getaddrinfo',
        hostname: 'pi.soramitsu.io',
      }),
    });
    const fetchImpl = vi.fn(async () => {
      throw networkError;
    });

    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
      /Polkaswap GraphQL request to https:\/\/pi\.soramitsu\.io\/graphql failed: fetch failed; cause: getaddrinfo ENOTFOUND pi\.soramitsu\.io; code=ENOTFOUND; syscall=getaddrinfo; hostname=pi\.soramitsu\.io.*Production routing must serve the polkaswap-indexer GraphQL API/
    );
  });

  it('redacts and bounds secrets in transport-error diagnostics', async () => {
    const networkError = new TypeError('fetch failed password=transport-password', {
      cause: new Error(
        `upstream https://operator:transport-pass@pi.soramitsu.io/?api_key=transport-key Authorization: Bearer transport-bearer ${'x'.repeat(2_000)}`
      ),
    });
    const fetchImpl = vi.fn(async () => { throw networkError; });

    try {
      await runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl);
      expect.fail('transport error must reject');
    } catch (error) {
      const diagnostic = String(error);
      expect(diagnostic).toContain('<redacted>');
      for (const secret of ['transport-password', 'transport-pass', 'transport-key', 'transport-bearer']) {
        expect(diagnostic).not.toContain(secret);
      }
      expect(diagnostic.length).toBeLessThan(1_000);
    }
  });

  it('rejects successful responses missing data._health with a routing hint', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { status: 'ok' } }));

    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
      /did not return data\._health; received data keys status.*Production routing must serve the polkaswap-indexer GraphQL API/
    );
  });

  it('rejects old production health schemas missing identity fields', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        errors: [
          {
            message: 'Cannot query field "serviceId" on type "Health". Did you mean "service"?',
          },
          {
            message: 'Cannot query field "schemaVersion" on type "Health".',
          },
        ],
      })
    );

    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
      'PI production GraphQL schema is missing _health identity fields (serviceId, schemaVersion)'
    );
  });

  it('diagnoses missing identity fields from GraphQL validation HTTP 400 responses', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        errors: [
          { message: 'Cannot query field "genesisHash" on type "Health".' },
          { message: 'Cannot query field "latestIndexedBlock" on type "Health".' },
          { message: 'Cannot query field "latestIndexedBlockHash" on type "Health".' },
          { message: 'Cannot query field "latestIndexedAt" on type "Health".' },
        ],
      }, { status: 400 })
    );

    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
      'PI production GraphQL schema is missing _health identity fields (genesisHash, latestIndexedBlock, latestIndexedBlockHash, latestIndexedAt)'
    );
  });

  it('rejects deployed health objects missing identity fields with a deployment hint', async () => {
    const fetchImpl = fetchWithHealth({
      ok: true,
      repositoryReady: true,
      service: 'polkaswap-indexer',
    });

    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
      /health serviceId must be pi\.soramitsu\.io; received <missing>.*_health proves genesisHash=/
    );
  });

  it('rejects non-JSON production responses with a body preview', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('<html>not graphql</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
    );

    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
      /did not return JSON.*Body preview: <html>not graphql<\/html>.*Production routing must serve the polkaswap-indexer GraphQL API/
    );
  });

  it('rejects invalid JSON production responses with a body preview and routing hint', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('{"data":', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );

    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
      /returned invalid JSON\. Body preview: \{"data":.*Production routing must serve the polkaswap-indexer GraphQL API/
    );
  });

  it.each([null, [], 42, 'graphql is healthy'])('rejects non-object top-level JSON payload %j', async (payload) => {
    const fetchImpl = vi.fn(async () => jsonResponse(payload));

    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
      'Polkaswap GraphQL endpoint returned a non-object JSON payload',
    );
  });

  it('rejects HTTP failures with a body preview and routing hint', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('deploy in progress', {
          status: 503,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        })
    );

    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
      /returned HTTP 503\. Body preview: deploy in progress.*Production routing must serve the polkaswap-indexer GraphQL API/
    );
  });

  it('redacts token, password, API-key, and bearer values from response previews', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      '{"token":"body-token","password":"body-password","api_key":"body-key","authorization":"Bearer body-bearer"}',
      { status: 503, headers: { 'content-type': 'application/json' } },
    ));

    try {
      await runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl);
      expect.fail('HTTP failure must reject');
    } catch (error) {
      const diagnostic = String(error);
      expect(diagnostic).toContain('<redacted>');
      for (const secret of ['body-token', 'body-password', 'body-key', 'body-bearer']) {
        expect(diagnostic).not.toContain(secret);
      }
    }
  });

  it('rejects unhealthy repository-backed health responses', async () => {
    const fetchImpl = fetchWithHealth({ ...validHealth, ok: false });

    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
      'expected ok=true'
    );
  });

  it('rejects TON indexer routing by contract shape', async () => {
    const fetchImpl = fetchWithHealth({
      lastMasterSeqno: 123,
      serviceId: 'ti.soramitsu.io',
      ecosystem: 'ton',
      chainId: 'ton:mainnet',
      network: 'mainnet',
    });

    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
      'points at a TON indexer contract'
    );
  });

  it('rejects Solswap indexer routing by service identity', async () => {
    const fetchImpl = fetchWithHealth({
      ok: true,
      service: 'solswap-indexer',
      serviceId: 'si.soramitsu.io',
      schemaVersion: 1,
      ecosystem: 'solana',
      chainId: 'solana:mainnet',
      network: 'mainnet',
      publicBaseUrl: 'https://si.soramitsu.io',
      readOnly: true,
    });

    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
      'points at a Solswap indexer contract'
    );
  });

  it('rejects schema version drift', async () => {
    const fetchImpl = fetchWithHealth({ ...validHealth, schemaVersion: 2 });

    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
      'health schemaVersion must be 1'
    );
  });

  it('rejects non-read-only production contracts', async () => {
    const fetchImpl = fetchWithHealth({ ...validHealth, readOnly: false });

    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
      'health readOnly must be true'
    );
  });

  it('rejects publicBaseUrl drift', async () => {
    const fetchImpl = fetchWithHealth({ ...validHealth, publicBaseUrl: 'https://pi.soramitsu.io' });

    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
      'health publicBaseUrl must be https://pi.soramitsu.io/graphql'
    );
  });

  it('rejects missing and internally inconsistent worker checkpoints', async () => {
    const worker = validWorkerState();
    const missingCheckpoint = vi.fn(async () => jsonResponse({
      data: {
        _health: validHealth,
        ...worker,
        chainState: null,
      },
    }));
    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', missingCheckpoint)).rejects.toThrow(
      'worker must expose a positive chainState checkpoint'
    );

    const inconsistentCheckpoint = vi.fn(async () => jsonResponse({
      data: {
        _health: validHealth,
        ...worker,
        chainState: {
          ...worker.chainState,
          data: JSON.stringify({
            lastIndexedBlock: VALID_BLOCK - 1,
            genesisHash: SORA_MAINNET_GENESIS_HASH,
            blockHash: VALID_BLOCK_HASH,
            blockTimestamp: VALID_TIMESTAMP,
          }),
        },
      },
    }));
    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', inconsistentCheckpoint)).rejects.toThrow(
      'chainState must contain an exact SORA mainnet block identity'
    );
  });

  it('rejects an equal-height chainState with a hash different from chainIdentity', async () => {
    const timestamp = IDENTITY_TIMESTAMP;
    const blockHash = `0x${'cd'.repeat(32)}`;
    const worker = validWorkerState(timestamp, IDENTITY_BLOCK, blockHash);
    const fetchImpl = vi.fn(async () => jsonResponse({
      data: {
        _health: {
          ...validHealth,
          latestIndexedBlock: IDENTITY_BLOCK,
          latestIndexedBlockHash: blockHash,
          latestIndexedAt: timestamp,
          workerLatestFinalizedBlock: IDENTITY_BLOCK,
          workerLatestIndexedBlock: IDENTITY_BLOCK,
          workerLag: 0,
          workerLastSuccessfulIndexTimestamp: timestamp,
        },
        ...worker,
      },
    }));

    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
      'chainState is incoherent with its immutable chainIdentity checkpoint'
    );
  });

  it('rejects stale or future coherent worker checkpoint timestamps', async () => {
    for (const timestamp of [
      Math.floor(Date.now() / 1000) - 301,
      Math.floor(Date.now() / 1000) + 31,
    ]) {
      const worker = validWorkerState(timestamp);
      const fetchImpl = vi.fn(async () => jsonResponse({
        data: {
          _health: {
            ...validHealth,
            latestIndexedAt: timestamp,
            workerLastSuccessfulIndexTimestamp: timestamp,
          },
          ...worker,
        },
      }));
      await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
        'worker checkpoint must be within 300 seconds'
      );
    }
  });

  it.each([
    ['maximum stale age', -300],
    ['maximum future skew', 30],
  ])('accepts the inclusive %s checkpoint boundary', async (_label, timestampOffset) => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(VALID_TIMESTAMP * 1_000);
    const timestamp = VALID_TIMESTAMP + timestampOffset;
    const worker = validWorkerState(timestamp);
    const fetchImpl = vi.fn(async () => jsonResponse({
      data: {
        _health: {
          ...validHealth,
          latestIndexedAt: timestamp,
          workerLastSuccessfulIndexTimestamp: timestamp,
        },
        ...worker,
      },
    }));

    try {
      await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).resolves.toBeUndefined();
    } finally {
      clock.mockRestore();
    }
  });

  it('allows the worker commit time to be newer than the indexed block timestamp', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(VALID_TIMESTAMP * 1_000);
    const blockTimestamp = VALID_TIMESTAMP - 10;
    const fetchImpl = vi.fn(async () => jsonResponse({
      data: {
        _health: {
          ...validHealth,
          latestIndexedAt: blockTimestamp,
          workerLastSuccessfulIndexTimestamp: VALID_TIMESTAMP,
        },
        ...validWorkerState(blockTimestamp),
      },
    }));

    try {
      await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).resolves.toBeUndefined();
    } finally {
      clock.mockRestore();
    }
  });

  it('rejects a fresh unrelated snapshot instead of using it to hide stale chainState', async () => {
    const staleTimestamp = Math.floor(Date.now() / 1000) - 301;
    const worker = validWorkerState(staleTimestamp);
    const fetchImpl = vi.fn(async () => jsonResponse({
      data: {
        _health: {
          ...validHealth,
          latestIndexedAt: staleTimestamp,
          workerLastSuccessfulIndexTimestamp: staleTimestamp,
        },
        ...worker,
        networkSnapshots: {
          nodes: [{ id: `block-${VALID_BLOCK + 1}`, type: 'BLOCK', timestamp: Math.floor(Date.now() / 1000) }],
        },
      },
    }));

    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
      'freshness probe must be the BLOCK snapshot matching chainState',
    );
  });

  it('rejects an unrelated aggregate snapshot even when it is fresh', async () => {
    const worker = validWorkerState();
    const fetchImpl = vi.fn(async () => jsonResponse({
      data: {
        _health: validHealth,
        ...worker,
        networkSnapshots: {
          nodes: [{ id: `block-${VALID_BLOCK}`, type: 'DEFAULT', timestamp: VALID_TIMESTAMP }],
        },
      },
    }));

    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
      'freshness probe must be the BLOCK snapshot matching chainState',
    );
  });

  it('rejects health checkpoint fields that do not exactly match chainState', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      data: {
        _health: { ...validHealth, latestIndexedBlockHash: `0x${'ef'.repeat(32)}` },
        ...validWorkerState(),
      },
    }));

    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
      'health latestIndexedBlockHash must match chainState',
    );
  });

  it('rejects a ready worker heartbeat that does not identify the persisted chainState', async () => {
    const fetchImpl = fetchWithHealth({
      ...validHealth,
      workerLatestFinalizedBlock: VALID_BLOCK + 5,
      workerLatestIndexedBlock: VALID_BLOCK - 1,
      workerLag: 6,
    });

    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
      'health workerLatestIndexedBlock must match chainState',
    );
  });

  it('rejects a chainIdentity record with a wrong genesis despite correct labels', async () => {
    const worker = validWorkerState();
    const fetchImpl = vi.fn(async () => jsonResponse({
      data: {
        _health: validHealth,
        ...worker,
        chainIdentity: {
          ...worker.chainIdentity,
          data: JSON.stringify({
            schemaVersion: 1,
            genesisHash: `0x${'11'.repeat(32)}`,
            verificationBlock: IDENTITY_BLOCK,
            verificationBlockHash: IDENTITY_BLOCK_HASH,
            verificationBlockTimestamp: IDENTITY_TIMESTAMP,
            migration: 'fresh-database',
          }),
        },
      },
    }));

    await expect(runProductionSmoke('https://pi.soramitsu.io/graphql', fetchImpl)).rejects.toThrow(
      'chainIdentity must exactly prove the reviewed SORA mainnet checkpoint',
    );
  });
});
