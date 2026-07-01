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
  service?: unknown;
  serviceId?: unknown;
  schemaVersion?: unknown;
  ecosystem?: unknown;
  chainId?: unknown;
  network?: unknown;
  publicBaseUrl?: unknown;
  readOnly?: unknown;
  lastMasterSeqno?: unknown;
};

type FetchLike = (input: URL, init?: RequestInit) => Promise<Response>;

const DEFAULT_GRAPHQL_URL = 'https://pi.soramitsu.io/graphql';
const BODY_PREVIEW_LIMIT = 300;

const PRODUCTION_SMOKE_QUERY = /* GraphQL */ `
  query PolkaswapProductionSmoke {
    _health {
      ok
      service
      serviceId
      schemaVersion
      ecosystem
      chainId
      network
      publicBaseUrl
      readOnly
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

async function fetchGraphQl(fetchImpl: FetchLike, graphqlUrl: URL): Promise<GraphQlResponse> {
  const response = await fetchImpl(graphqlUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query: PRODUCTION_SMOKE_QUERY }),
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
    throw new Error(`PI production health is not ready: expected ok=true, received keys ${objectKeys(health)}.`);
  }

  assert.equal(health.service, 'polkaswap-indexer', 'health service must be polkaswap-indexer');
  assert.equal(health.serviceId, 'pi.soramitsu.io', 'health serviceId must be pi.soramitsu.io');
  assert.equal(health.schemaVersion, 1, 'health schemaVersion must be 1');
  assert.equal(health.ecosystem, 'sora2', 'health ecosystem must be sora2');
  assert.equal(health.chainId, 'sora:mainnet', 'health chainId must be sora:mainnet');
  assert.equal(health.network, 'mainnet', 'health network must be mainnet');
  assert.equal(health.publicBaseUrl, DEFAULT_GRAPHQL_URL, `health publicBaseUrl must be ${DEFAULT_GRAPHQL_URL}`);
  assert.equal(health.readOnly, true, 'health readOnly must be true');
}

export async function runProductionSmoke(
  graphqlUrlInput = process.env.POLKASWAP_INDEXER_BASE_URL || DEFAULT_GRAPHQL_URL,
  fetchImpl: FetchLike = fetch
): Promise<void> {
  const graphqlUrl = normalizeGraphqlUrl(graphqlUrlInput);
  const payload = await fetchGraphQl(fetchImpl, graphqlUrl);

  if (payload.errors !== undefined) {
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
    let endpointForLog = graphqlUrlInput;
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
