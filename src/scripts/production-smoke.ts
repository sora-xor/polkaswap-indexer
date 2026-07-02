import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

type GraphQlResponse = {
  data?: {
    _health?: HealthInfo;
  };
  errors?: unknown;
};

type HealthInfo = {
  ok?: unknown;
  repositoryReady?: unknown;
  service?: unknown;
  serviceId?: unknown;
  schemaVersion?: unknown;
  ecosystem?: unknown;
  chainId?: unknown;
  network?: unknown;
  publicBaseUrl?: unknown;
  readOnly?: unknown;
  workerAvailable?: unknown;
  workerReady?: unknown;
  workerReadinessReason?: unknown;
  workerLifecycle?: unknown;
  workerStartupComplete?: unknown;
  workerLatestFinalizedBlock?: unknown;
  workerLatestIndexedBlock?: unknown;
  workerLag?: unknown;
  workerLastSuccessfulIndexTimestamp?: unknown;
  workerLastError?: unknown;
  workerLastErrorTimestamp?: unknown;
  lastMasterSeqno?: unknown;
};

type FetchLike = (input: URL, init?: RequestInit) => Promise<Response>;

const DEFAULT_GRAPHQL_URL = 'https://pi.soramitsu.io/graphql';
const BODY_PREVIEW_LIMIT = 300;
const REQUEST_TIMEOUT_MS = 10_000;
const PI_HEALTH_DEPLOYMENT_HINT =
  'Deploy the current polkaswap-indexer image to pi.soramitsu.io/graphql so _health exposes ok=true, service=polkaswap-indexer, serviceId=pi.soramitsu.io, schemaVersion=1, ecosystem=sora2, chainId=sora:mainnet, network=mainnet, publicBaseUrl=https://pi.soramitsu.io/graphql, and readOnly=true.';

const PRODUCTION_SMOKE_QUERY = /* GraphQL */ `
  query PolkaswapProductionSmoke {
    _health {
      ok
      repositoryReady
      service
      serviceId
      schemaVersion
      ecosystem
      chainId
      network
      publicBaseUrl
      readOnly
      workerAvailable
      workerReady
      workerReadinessReason
      workerLifecycle
      workerStartupComplete
      workerLatestFinalizedBlock
      workerLatestIndexedBlock
      workerLag
      workerLastSuccessfulIndexTimestamp
      workerLastError
      workerLastErrorTimestamp
    }
  }
`;

export function normalizeGraphqlUrl(value: string): URL {
  const url = new URL(value);

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Polkaswap production smoke URL must use http or https');
  }
  if (url.username || url.password) {
    throw new Error('Polkaswap production smoke URL must not contain credentials');
  }
  if (url.pathname === '' || url.pathname === '/') {
    url.pathname = '/graphql';
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';

  return url;
}

function bodyPreview(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) return '<empty body>';
  return compact.length > BODY_PREVIEW_LIMIT ? `${compact.slice(0, BODY_PREVIEW_LIMIT)}...` : compact;
}

function objectKeys(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '<non-object>';
  return Object.keys(value as Record<string, unknown>).sort().join(',') || '<empty object>';
}

function formatValue(value: unknown): string {
  if (value === undefined) return '<missing>';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function assertHealthField(value: unknown, expected: unknown, message: string): void {
  if (value !== expected) {
    throw new Error(`${message}; received ${formatValue(value)}. ${PI_HEALTH_DEPLOYMENT_HINT}`);
  }
}

function graphqlErrorMessages(errors: unknown): string[] {
  if (!Array.isArray(errors)) return [];

  return errors
    .map((error) => {
      if (!error || typeof error !== 'object' || !('message' in error)) return '';
      const message = (error as { message?: unknown }).message;
      return typeof message === 'string' ? message : '';
    })
    .filter((message) => message.length > 0);
}

function missingHealthIdentityFields(errors: unknown): string[] {
  const messages = graphqlErrorMessages(errors);
  const requiredFields = ['serviceId', 'schemaVersion', 'ecosystem', 'chainId', 'network', 'publicBaseUrl', 'readOnly'];
  return requiredFields.filter((field) =>
    messages.some((message) => message.includes(`Cannot query field "${field}" on type "Health"`))
  );
}

async function fetchGraphQl(fetchImpl: FetchLike, graphqlUrl: URL): Promise<GraphQlResponse> {
  const response = await fetchImpl(graphqlUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'cache-control': 'no-store',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query: PRODUCTION_SMOKE_QUERY }),
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const rawBody = await response.text();
  if (!response.ok) {
    throw new Error(
      `Polkaswap GraphQL endpoint returned HTTP ${response.status}. Body preview: ${bodyPreview(rawBody)}. Route pi.soramitsu.io to the polkaswap-indexer GraphQL API.`
    );
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!/application\/json/i.test(contentType)) {
    throw new Error(
      `Polkaswap GraphQL endpoint did not return JSON. Content-Type: ${contentType || '<missing>'}. Body preview: ${bodyPreview(rawBody)}.`
    );
  }

  try {
    return JSON.parse(rawBody) as GraphQlResponse;
  } catch {
    throw new Error(`Polkaswap GraphQL endpoint returned invalid JSON. Body preview: ${bodyPreview(rawBody)}.`);
  }
}

function assertHealthContract(health: HealthInfo): void {
  if ('lastMasterSeqno' in health || health.serviceId === 'ti.soramitsu.io' || health.ecosystem === 'ton') {
    throw new Error(
      'PI production routing points at a TON indexer contract. Route pi.soramitsu.io to the polkaswap-indexer deployment.'
    );
  }
  if (health.serviceId === 'si.soramitsu.io' || health.ecosystem === 'solana' || health.chainId === 'solana:mainnet') {
    throw new Error(
      'PI production routing points at a Solswap indexer contract. Route pi.soramitsu.io to the polkaswap-indexer deployment.'
    );
  }
  if (health.ok !== true) {
    throw new Error(
      `PI production health is not ready: expected ok=true, received keys ${objectKeys(health)}. ${PI_HEALTH_DEPLOYMENT_HINT}`
    );
  }
  assert.equal(health.repositoryReady, true, 'health repositoryReady must be true');

  assertHealthField(health.service, 'polkaswap-indexer', 'health service must be polkaswap-indexer');
  assertHealthField(health.serviceId, 'pi.soramitsu.io', 'health serviceId must be pi.soramitsu.io');
  assertHealthField(health.schemaVersion, 1, 'health schemaVersion must be 1');
  assertHealthField(health.ecosystem, 'sora2', 'health ecosystem must be sora2');
  assertHealthField(health.chainId, 'sora:mainnet', 'health chainId must be sora:mainnet');
  assertHealthField(health.network, 'mainnet', 'health network must be mainnet');
  assertHealthField(health.publicBaseUrl, DEFAULT_GRAPHQL_URL, `health publicBaseUrl must be ${DEFAULT_GRAPHQL_URL}`);
  assertHealthField(health.readOnly, true, 'health readOnly must be true');

  assert.equal(health.workerAvailable, true, 'production health must expose a shared worker status');
  assert.equal(health.workerReady, true, 'available worker must be ready');
  assert.equal(health.workerReadinessReason, null, 'ready worker must not have a readiness failure reason');
  assert.equal(health.workerLifecycle, 'running', 'ready worker lifecycle must be running');
  assert.equal(health.workerStartupComplete, true, 'ready worker startup must be complete');

  for (const [name, value] of [
    ['workerLatestFinalizedBlock', health.workerLatestFinalizedBlock],
    ['workerLatestIndexedBlock', health.workerLatestIndexedBlock],
    ['workerLag', health.workerLag],
    ['workerLastSuccessfulIndexTimestamp', health.workerLastSuccessfulIndexTimestamp],
  ] as const) {
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
      throw new Error(`health ${name} must be a non-negative safe integer`);
    }
  }

  if (Number(health.workerLatestIndexedBlock) > Number(health.workerLatestFinalizedBlock)) {
    throw new Error('health workerLatestIndexedBlock must not exceed workerLatestFinalizedBlock');
  }
  const expectedLag = Number(health.workerLatestFinalizedBlock) - Number(health.workerLatestIndexedBlock);
  assert.equal(health.workerLag, expectedLag, 'health workerLag must match finalized minus indexed blocks');
  if (Number(health.workerLastSuccessfulIndexTimestamp) === 0) {
    throw new Error('health workerLastSuccessfulIndexTimestamp must be positive');
  }
  if (
    health.workerLastError !== null &&
    (typeof health.workerLastError !== 'string' || health.workerLastError.length > 1_000)
  ) {
    throw new Error('health workerLastError must be null or a string');
  }
  if (
    health.workerLastErrorTimestamp !== null &&
    (!Number.isSafeInteger(health.workerLastErrorTimestamp) || Number(health.workerLastErrorTimestamp) < 0)
  ) {
    throw new Error('health workerLastErrorTimestamp must be null or a non-negative safe integer');
  }
  if ((health.workerLastError === null) !== (health.workerLastErrorTimestamp === null)) {
    throw new Error('health worker error and timestamp must either both be present or both be null');
  }
}

export async function runProductionSmoke(
  graphqlUrlInput = process.env.POLKASWAP_INDEXER_BASE_URL || DEFAULT_GRAPHQL_URL,
  fetchImpl: FetchLike = fetch
): Promise<void> {
  const graphqlUrl = normalizeGraphqlUrl(graphqlUrlInput);
  const payload = await fetchGraphQl(fetchImpl, graphqlUrl);

  if (payload.errors !== undefined) {
    const missingIdentityFields = missingHealthIdentityFields(payload.errors);
    if (missingIdentityFields.length > 0) {
      throw new Error(
        `PI production GraphQL schema is missing _health identity fields (${missingIdentityFields.join(', ')}). ${PI_HEALTH_DEPLOYMENT_HINT}`
      );
    }
    throw new Error(`Polkaswap GraphQL endpoint returned errors: ${JSON.stringify(payload.errors).slice(0, 300)}`);
  }
  if (!payload.data?._health || typeof payload.data._health !== 'object') {
    throw new Error('Polkaswap GraphQL endpoint did not return data._health');
  }

  assertHealthContract(payload.data._health);
  process.stdout.write(`polkaswap production smoke ok: ${graphqlUrl.toString()}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const graphqlUrlInput = process.argv[2] || process.env.POLKASWAP_INDEXER_BASE_URL || DEFAULT_GRAPHQL_URL;

  runProductionSmoke(graphqlUrlInput).catch((error) => {
    let endpointForLog = '<invalid endpoint>';
    try {
      endpointForLog = normalizeGraphqlUrl(graphqlUrlInput).toString();
    } catch {
      // Preserve the original validation error for invalid CLI input.
    }
    console.error(`polkaswap production smoke failed for ${endpointForLog}`);
    console.error(error);
    process.exit(1);
  });
}
