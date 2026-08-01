import { pathToFileURL } from 'node:url';

import {
  parseStoredSoraChainIdentity,
  parseStoredSoraChainState,
  SORA_LEGACY_IDENTITY_ANCHOR,
  SORA_MAINNET_GENESIS_HASH,
} from '../soraIdentity.js';

type UpdateStreamProbe = {
  id?: unknown;
  block?: unknown;
  data?: unknown;
};

type GraphQlResponse = {
  data?: {
    _health?: HealthInfo;
    chainIdentity?: UpdateStreamProbe | null;
    chainState?: UpdateStreamProbe | null;
    networkSnapshots?: {
      nodes?: Array<{
        id?: unknown;
        type?: unknown;
        timestamp?: unknown;
      }>;
    };
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
  genesisHash?: unknown;
  latestIndexedBlock?: unknown;
  latestIndexedBlockHash?: unknown;
  latestIndexedAt?: unknown;
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

export type ProductionSmokeOptions = {
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxIndexerAgeSec?: number;
};

const DEFAULT_GRAPHQL_URL = 'https://pi.soramitsu.io/graphql';
const BODY_PREVIEW_LIMIT = 300;
const DIAGNOSTIC_LIMIT = 300;
const DIAGNOSTIC_SCAN_LIMIT = 4_096;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 5_242_880;
const DEFAULT_MAX_INDEXER_AGE_SEC = 300;
const MAX_INDEXER_AGE_SEC = 3_600;
const FUTURE_TIMESTAMP_TOLERANCE_SEC = 30;
const JSON_CONTENT_TYPE = /^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)(?:\s*;\s*[a-z0-9!#$%&'*+.^_`|~-]+\s*=\s*(?:[a-z0-9!#$%&'*+.^_`|~-]+|"[^"\r\n]*"))*\s*$/i;
const PI_GRAPHQL_DEPLOYMENT_HINT =
  'Production routing must serve the polkaswap-indexer GraphQL API at https://pi.soramitsu.io/graphql. Deploy the current polkaswap-indexer image to pi.soramitsu.io/graphql.';
const PI_HEALTH_DEPLOYMENT_HINT =
  `Deploy the current polkaswap-indexer worker and API so _health proves genesisHash=${SORA_MAINNET_GENESIS_HASH} and an exact, fresh SORA mainnet chainState checkpoint.`;

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
      genesisHash
      latestIndexedBlock
      latestIndexedBlockHash
      latestIndexedAt
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
    chainIdentity: updatesStream(id: "chainIdentity") {
      id
      block
      data
    }
    chainState: updatesStream(id: "chainState") {
      id
      block
      data
    }
    networkSnapshots(first: 1, orderBy: ["TIMESTAMP_DESC"], filter: { type: { equalTo: "BLOCK" } }) {
      nodes {
        id
        type
        timestamp
      }
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
  if (url.search || url.hash) {
    throw new Error('Polkaswap production smoke URL must not contain query strings or fragments');
  }
  const isLocalhost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalhost)) {
    throw new Error('Polkaswap production smoke URL must use HTTPS outside localhost smoke tests');
  }
  if (url.pathname === '' || url.pathname === '/') {
    url.pathname = '/graphql';
  }
  url.pathname = url.pathname.replace(/\/+$/, '');

  return url;
}

function graphqlUrlForFailureLog(value: string): string {
  try {
    return normalizeGraphqlUrl(value).toString();
  } catch {
    try {
      const url = new URL(value);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      return '<invalid URL>';
    }
  }
}

function redactSecrets(value: string): string {
  return value
    .replace(/("(?:access[_-]?token|refresh[_-]?token|token|password|passwd|api[-_]?key|secret|authorization|cookie|set-cookie)"\s*:\s*)(?:"(?:\\.|[^"\\])*"|[^,}\]\s]+)/gi, '$1"<redacted>"')
    .replace(/(\b(?:bearer|basic)\s+)[A-Za-z0-9+/=_~.-]+/gi, '$1<redacted>')
    .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1<redacted>@')
    .replace(/([?&](?:access[_-]?token|refresh[_-]?token|token|password|passwd|api[-_]?key|secret|authorization|key)=)[^&#\s]*/gi, '$1<redacted>')
    .replace(/(\b(?:access[_-]?token|refresh[_-]?token|token|password|passwd|api[-_]?key|secret|authorization)\b\s*[:=]\s*)(?:["'][^"'\r\n]*["']|[^\s,;&]+)/gi, '$1<redacted>');
}

function bodyPreview(value: string): string {
  const compact = redactSecrets(value.slice(0, DIAGNOSTIC_SCAN_LIMIT)).replace(/\s+/g, ' ').trim();
  if (!compact) return '<empty body>';
  return compact.length > BODY_PREVIEW_LIMIT ? `${compact.slice(0, BODY_PREVIEW_LIMIT)}...` : compact;
}

function diagnosticPreview(value: unknown): string {
  const compact = redactSecrets(String(value ?? '').slice(0, DIAGNOSTIC_SCAN_LIMIT))
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!compact) return '<empty>';
  return compact.length > DIAGNOSTIC_LIMIT ? `${compact.slice(0, DIAGNOSTIC_LIMIT)}...` : compact;
}

class RequestTimeoutError extends Error {}
class ResponseTooLargeError extends Error {}
class RedirectRejectedError extends Error {
  constructor(readonly status: number) {
    super(`redirect response HTTP ${status}`);
  }
}

function boundedInteger(value: unknown, name: string, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const candidate = typeof value === 'string' ? value : String(value);
  if (!/^[1-9][0-9]*$/.test(candidate)) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  const parsed = Number(candidate);
  if (!Number.isSafeInteger(parsed) || parsed > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return parsed;
}

async function withinDeadline<T>(
  operation: () => Promise<T>,
  controller: AbortController,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new RequestTimeoutError(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readBoundedBody(response: Response, maxResponseBytes: number): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^(?:0|[1-9][0-9]*)$/.test(contentLength)) {
    const declared = Number(contentLength);
    if (Number.isSafeInteger(declared) && declared > maxResponseBytes) {
      throw new ResponseTooLargeError(`declared ${declared} bytes`);
    }
  }

  if (!response.body?.getReader) {
    const text = await response.text();
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > maxResponseBytes) throw new ResponseTooLargeError(`received more than ${maxResponseBytes} bytes`);
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxResponseBytes) {
        void reader.cancel().catch(() => undefined);
        throw new ResponseTooLargeError(`received more than ${maxResponseBytes} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function isJsonContentType(value: string): boolean {
  return JSON_CONTENT_TYPE.test(value.trim());
}

function formatFailureCause(cause: unknown, depth = 0): string {
  if (depth >= 3) return '<nested cause omitted>';
  if (cause instanceof Error) {
    const details = [diagnosticPreview(cause.message || cause.name)];
    const metadata = cause as unknown as Record<string, unknown>;
    for (const key of ['code', 'errno', 'syscall', 'hostname', 'address', 'port']) {
      const value = metadata[key];
      if (value !== undefined) details.push(`${key}=${diagnosticPreview(value)}`);
    }
    if ('cause' in cause && cause.cause !== undefined) {
      details.push(`cause=${formatFailureCause(cause.cause, depth + 1)}`);
    }
    return diagnosticPreview(details.join('; '));
  }

  if (typeof cause === 'string') return diagnosticPreview(cause);
  try {
    return diagnosticPreview(JSON.stringify(cause));
  } catch {
    return diagnosticPreview(cause);
  }
}

function requestFailureReason(error: unknown): string {
  if (error instanceof Error) {
    const cause = 'cause' in error && error.cause !== undefined
      ? `; cause: ${formatFailureCause(error.cause)}`
      : '';
    return diagnosticPreview(`${error.message}${cause}`);
  }
  return diagnosticPreview(error);
}

function objectKeys(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '<non-object>';
  return Object.keys(value as Record<string, unknown>).sort().join(',') || '<empty object>';
}

function formatValue(value: unknown): string {
  if (value === undefined) return '<missing>';
  if (typeof value === 'string') return diagnosticPreview(value);
  return diagnosticPreview(JSON.stringify(value));
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
  const requiredFields = [
    'serviceId',
    'schemaVersion',
    'ecosystem',
    'chainId',
    'network',
    'publicBaseUrl',
    'readOnly',
    'genesisHash',
    'latestIndexedBlock',
    'latestIndexedBlockHash',
    'latestIndexedAt',
  ];
  return requiredFields.filter((field) =>
    messages.some((message) => message.includes(`Cannot query field "${field}" on type "Health"`))
  );
}

async function fetchGraphQl(
  fetchImpl: FetchLike,
  graphqlUrl: URL,
  { timeoutMs, maxResponseBytes }: Required<Pick<ProductionSmokeOptions, 'timeoutMs' | 'maxResponseBytes'>>,
): Promise<GraphQlResponse> {
  const controller = new AbortController();
  let response: Response;
  let rawBody: string;
  try {
    ({ response, rawBody } = await withinDeadline(async () => {
      const received = await fetchImpl(graphqlUrl, {
        method: 'POST',
        headers: {
          accept: 'application/graphql-response+json, application/json',
          'cache-control': 'no-store',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query: PRODUCTION_SMOKE_QUERY }),
        cache: 'no-store',
        redirect: 'manual',
        signal: controller.signal,
      });
      if (received.status >= 300 && received.status < 400) {
        throw new RedirectRejectedError(received.status);
      }
      return { response: received, rawBody: await readBoundedBody(received, maxResponseBytes) };
    }, controller, timeoutMs));
  } catch (error) {
    if (error instanceof RedirectRejectedError) {
      throw new Error(`Polkaswap GraphQL endpoint refused redirect HTTP ${error.status}; production smoke redirects are forbidden. ${PI_GRAPHQL_DEPLOYMENT_HINT}`);
    }
    if (error instanceof ResponseTooLargeError) {
      throw new Error(`Polkaswap GraphQL response exceeded the ${maxResponseBytes}-byte limit. ${PI_GRAPHQL_DEPLOYMENT_HINT}`);
    }
    throw new Error(`Polkaswap GraphQL request to ${graphqlUrl.toString()} failed: ${requestFailureReason(error)}. ${PI_GRAPHQL_DEPLOYMENT_HINT}`);
  }
  if (!response.ok) {
    if (isJsonContentType(response.headers.get('content-type') ?? '')) {
      try {
        const errorPayload = JSON.parse(rawBody) as { errors?: unknown };
        const missingIdentityFields = missingHealthIdentityFields(errorPayload?.errors);
        if (missingIdentityFields.length > 0) {
          throw new Error(
            `PI production GraphQL schema is missing _health identity fields (${missingIdentityFields.join(', ')}). ${PI_HEALTH_DEPLOYMENT_HINT}`
          );
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('PI production GraphQL schema is missing')) {
          throw error;
        }
      }
    }
    throw new Error(
      `Polkaswap GraphQL endpoint returned HTTP ${response.status}. Body preview: ${bodyPreview(rawBody)}. ${PI_GRAPHQL_DEPLOYMENT_HINT}`
    );
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!isJsonContentType(contentType)) {
    throw new Error(
      `Polkaswap GraphQL endpoint did not return JSON. Content-Type: ${contentType ? diagnosticPreview(contentType) : '<missing>'}. Body preview: ${bodyPreview(rawBody)}. ${PI_GRAPHQL_DEPLOYMENT_HINT}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new Error(`Polkaswap GraphQL endpoint returned invalid JSON. Body preview: ${bodyPreview(rawBody)}. ${PI_GRAPHQL_DEPLOYMENT_HINT}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Polkaswap GraphQL endpoint returned a non-object JSON payload. ${PI_GRAPHQL_DEPLOYMENT_HINT}`);
  }
  return parsed as GraphQlResponse;
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
  assertHealthField(health.repositoryReady, true, 'health repositoryReady must be true');
  assertHealthField(health.service, 'polkaswap-indexer', 'health service must be polkaswap-indexer');
  assertHealthField(health.serviceId, 'pi.soramitsu.io', 'health serviceId must be pi.soramitsu.io');
  assertHealthField(health.schemaVersion, 1, 'health schemaVersion must be 1');
  assertHealthField(health.ecosystem, 'sora2', 'health ecosystem must be sora2');
  assertHealthField(health.chainId, 'sora:mainnet', 'health chainId must be sora:mainnet');
  assertHealthField(health.network, 'mainnet', 'health network must be mainnet');
  assertHealthField(health.publicBaseUrl, DEFAULT_GRAPHQL_URL, `health publicBaseUrl must be ${DEFAULT_GRAPHQL_URL}`);
  assertHealthField(health.readOnly, true, 'health readOnly must be true');
  assertHealthField(
    health.genesisHash,
    SORA_MAINNET_GENESIS_HASH,
    `health genesisHash must be the reviewed SORA mainnet genesis ${SORA_MAINNET_GENESIS_HASH}`,
  );
  assertHealthField(health.workerAvailable, true, 'production health must expose a shared worker status');
  assertHealthField(health.workerReady, true, 'available worker must be ready');
  assertHealthField(health.workerReadinessReason, null, 'ready worker must not have a readiness failure reason');
  assertHealthField(health.workerLifecycle, 'running', 'ready worker lifecycle must be running');
  assertHealthField(health.workerStartupComplete, true, 'ready worker startup must be complete');

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
  assertHealthField(health.workerLag, expectedLag, 'health workerLag must match finalized minus indexed blocks');
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

function parseProbeJson(probe: UpdateStreamProbe, label: string): unknown {
  if (typeof probe.data !== 'string') {
    throw new Error(`PI production ${label} data must be JSON text. ${PI_HEALTH_DEPLOYMENT_HINT}`);
  }
  try {
    return JSON.parse(probe.data);
  } catch {
    throw new Error(`PI production ${label} data must be valid JSON. ${PI_HEALTH_DEPLOYMENT_HINT}`);
  }
}

export async function runProductionSmoke(
  graphqlUrlInput = process.env.POLKASWAP_INDEXER_BASE_URL || DEFAULT_GRAPHQL_URL,
  fetchImpl: FetchLike = fetch,
  options: ProductionSmokeOptions = {},
): Promise<void> {
  const graphqlUrl = normalizeGraphqlUrl(graphqlUrlInput);
  const requestOptions = {
    timeoutMs: boundedInteger(
      options.timeoutMs ?? process.env.POLKASWAP_INDEXER_SMOKE_TIMEOUT_MS,
      'POLKASWAP_INDEXER_SMOKE_TIMEOUT_MS',
      DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    ),
    maxResponseBytes: boundedInteger(
      options.maxResponseBytes ?? process.env.POLKASWAP_INDEXER_SMOKE_MAX_RESPONSE_BYTES,
      'POLKASWAP_INDEXER_SMOKE_MAX_RESPONSE_BYTES',
      DEFAULT_MAX_RESPONSE_BYTES,
      MAX_RESPONSE_BYTES,
    ),
  };
  const maxIndexerAgeSec = boundedInteger(
    options.maxIndexerAgeSec ?? process.env.POLKASWAP_INDEXER_SMOKE_MAX_INDEXER_AGE_SEC,
    'POLKASWAP_INDEXER_SMOKE_MAX_INDEXER_AGE_SEC',
    DEFAULT_MAX_INDEXER_AGE_SEC,
    MAX_INDEXER_AGE_SEC,
  );
  const payload = await fetchGraphQl(fetchImpl, graphqlUrl, requestOptions);

  if (payload.errors !== undefined) {
    const missingIdentityFields = missingHealthIdentityFields(payload.errors);
    if (missingIdentityFields.length > 0) {
      throw new Error(
        `PI production GraphQL schema is missing _health identity fields (${missingIdentityFields.join(', ')}). ${PI_HEALTH_DEPLOYMENT_HINT}`
      );
    }
    throw new Error(`Polkaswap GraphQL endpoint returned errors: ${bodyPreview(JSON.stringify(payload.errors))}. ${PI_GRAPHQL_DEPLOYMENT_HINT}`);
  }
  if (!payload.data?._health || typeof payload.data._health !== 'object') {
    throw new Error(
      `Polkaswap GraphQL endpoint did not return data._health; received data keys ${objectKeys(payload.data)}. ${PI_GRAPHQL_DEPLOYMENT_HINT}`
    );
  }

  assertHealthContract(payload.data._health);

  const identityProbe = payload.data.chainIdentity;
  if (!identityProbe || identityProbe.id !== 'chainIdentity' ||
      !Number.isSafeInteger(identityProbe.block) || Number(identityProbe.block) <= 0) {
    throw new Error(`PI production worker must expose its immutable chainIdentity checkpoint. ${PI_HEALTH_DEPLOYMENT_HINT}`);
  }
  const identity = parseStoredSoraChainIdentity(parseProbeJson(identityProbe, 'chainIdentity'));
  if (!identity || identityProbe.block !== identity.verificationBlock ||
      (identity.migration === 'legacy-production-anchor-v1' &&
        (identity.verificationBlock !== SORA_LEGACY_IDENTITY_ANCHOR.block ||
         identity.verificationBlockHash !== SORA_LEGACY_IDENTITY_ANCHOR.hash ||
         identity.verificationBlockTimestamp !== SORA_LEGACY_IDENTITY_ANCHOR.timestamp))) {
    throw new Error(`PI production chainIdentity must exactly prove the reviewed SORA mainnet checkpoint. ${PI_HEALTH_DEPLOYMENT_HINT}`);
  }

  const stateProbe = payload.data.chainState;
  if (!stateProbe || stateProbe.id !== 'chainState' ||
      !Number.isSafeInteger(stateProbe.block) || Number(stateProbe.block) <= 0) {
    throw new Error(`PI production worker must expose a positive chainState checkpoint. ${PI_HEALTH_DEPLOYMENT_HINT}`);
  }
  const state = parseStoredSoraChainState(parseProbeJson(stateProbe, 'chainState'));
  if (!state || stateProbe.block !== state.lastIndexedBlock) {
    throw new Error(`PI production chainState must contain an exact SORA mainnet block identity. ${PI_HEALTH_DEPLOYMENT_HINT}`);
  }
  if (state.lastIndexedBlock < identity.verificationBlock ||
      state.blockTimestamp < identity.verificationBlockTimestamp) {
    throw new Error(`PI production chainState is incoherent with its immutable chainIdentity checkpoint. ${PI_HEALTH_DEPLOYMENT_HINT}`);
  }

  assertHealthField(
    payload.data._health.latestIndexedBlock,
    state.lastIndexedBlock,
    'health latestIndexedBlock must match chainState',
  );
  assertHealthField(
    payload.data._health.latestIndexedBlockHash,
    state.blockHash,
    'health latestIndexedBlockHash must match chainState',
  );
  assertHealthField(
    payload.data._health.latestIndexedAt,
    state.blockTimestamp,
    'health latestIndexedAt must match chainState',
  );
  const latestSnapshot = payload.data.networkSnapshots?.nodes?.[0];
  if (!latestSnapshot || latestSnapshot.type !== 'BLOCK' ||
      latestSnapshot.id !== `block-${state.lastIndexedBlock}` ||
      latestSnapshot.timestamp !== state.blockTimestamp) {
    throw new Error(`PI production freshness probe must be the BLOCK snapshot matching chainState. ${PI_HEALTH_DEPLOYMENT_HINT}`);
  }
  const now = Math.floor(Date.now() / 1000);
  const checkpointAgeSec = now - state.blockTimestamp;
  if (checkpointAgeSec < -FUTURE_TIMESTAMP_TOLERANCE_SEC || checkpointAgeSec > maxIndexerAgeSec) {
    throw new Error(
      `PI production worker checkpoint must be within ${maxIndexerAgeSec} seconds of the smoke clock; received timestamp ${formatValue(state.blockTimestamp)}. ${PI_HEALTH_DEPLOYMENT_HINT}`,
    );
  }
  process.stdout.write(`polkaswap production smoke ok: ${graphqlUrl.toString()}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const graphqlUrlInput = process.argv[2] || process.env.POLKASWAP_INDEXER_BASE_URL || DEFAULT_GRAPHQL_URL;

  runProductionSmoke(graphqlUrlInput).catch((error) => {
    console.error(`polkaswap production smoke failed for ${graphqlUrlForFailureLog(graphqlUrlInput)}`);
    console.error(error);
    process.exit(1);
  });
}
