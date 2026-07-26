#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${DEPLOYMENT_EVIDENCE_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
EVIDENCE_FILE="$ROOT_DIR/scripts/production-deployment-evidence.json"
REQUIRE_READY=false

usage() {
  cat <<'USAGE'
Usage: scripts/audit-deployment-evidence.sh [--evidence <path>] [--require-ready]

Validates public PI deployment evidence. The default audit allows the committed
blocked state. --require-ready requires an operator-attested deployment record
for the current release commit, image digest, deployment identity, successful
live smoke timestamp, exact PI health identity with a recent SORA mainnet
checkpoint, independently verified SORA RPC controls, and delegated TLS-edge
client-IP HTTP/WebSocket controls.

Set DEPLOYMENT_EVIDENCE_EXPECTED_COMMIT to validate evidence for a specific
release commit instead of the local repository HEAD.
USAGE
}

while (($#)); do
  case "$1" in
    --evidence)
      [[ $# -ge 2 ]] || { echo "[deployment-evidence][error] --evidence requires a path" >&2; exit 2; }
      EVIDENCE_FILE="$2"
      shift 2
      ;;
    --require-ready)
      REQUIRE_READY=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[deployment-evidence][error] Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "[deployment-evidence][error] node is required for structured JSON validation" >&2
  exit 1
fi

node - "$EVIDENCE_FILE" "$REQUIRE_READY" "$ROOT_DIR" <<'NODE'
const fs = require('fs');
const childProcess = require('child_process');

const [evidenceFile, requireReadyRaw, rootDir] = process.argv.slice(2);
const requireReady = requireReadyRaw === 'true';
const errors = [];
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_INDEXED_CHECKPOINT_AGE_SECONDS = 300;
const MAX_INDEXED_CHECKPOINT_FUTURE_SKEW_SECONDS = 30;
const SORA_MAINNET_GENESIS_HASH =
  '0x7e4e32d0feafd4f9c9414b0be86373f9a1efa904809b683453a9af6856d38ad5';

const contract = {
  scope: 'polkaswap-indexer-production-deployment-readiness',
  serviceId: 'pi.soramitsu.io',
  baseUrl: 'https://pi.soramitsu.io/graphql',
  smokeCommand: 'POLKASWAP_INDEXER_BASE_URL=https://pi.soramitsu.io/graphql yarn smoke:production',
  dockerBuildCommand: 'docker build -t polkaswap-indexer:release .',
  requiredBlockers: [
    'production-deployment-evidence-missing',
    'live-production-smoke-failing'
  ],
  healthInfo: {
    ok: true,
    service: 'polkaswap-indexer',
    serviceId: 'pi.soramitsu.io',
    schemaVersion: 1,
    ecosystem: 'sora2',
    chainId: 'sora:mainnet',
    network: 'mainnet',
    publicBaseUrl: 'https://pi.soramitsu.io/graphql',
    readOnly: true,
    genesisHash: SORA_MAINNET_GENESIS_HASH
  },
  soraRpcControls: {
    primaryNodeControl: 'locally-controlled-verifying-archive',
    archiveNodeControl: 'independently-operated-verifying-archive',
    distinctHosts: true,
    exactIdentityPreflight: true,
    rawPayloadAgreement: 'height-hash-scale-block-events-timestamp'
  },
  tlsEdgeControls: {
    tlsTermination: true,
    forwardedClientIpHeaders: 'overwrite',
    httpClientIpRateLimit: {
      windowMs: 60000,
      maxRequests: 600
    },
    webSocketClientIpLimits: {
      windowMs: 60000,
      maxUpgrades: 600,
      maxConcurrentConnections: 16
    }
  }
};

const requiredEvidenceFields = [
  'commit',
  'imageDigest',
  'deploymentId',
  'baseUrl',
  'smokeCommand',
  'deployedAt',
  'smokePassedAt',
  'healthInfo',
  'soraRpcControls',
  'tlsEdgeControls',
  'operator'
];
const allowedManifestFields = [
  'schemaVersion',
  'scope',
  'serviceId',
  'baseUrl',
  'status',
  'releaseEnabled',
  'lastReviewed',
  'blockers',
  'smokeCommand',
  'dockerBuildCommand',
  'readyVerificationCommands',
  'requiredEvidenceFields',
  'deploymentEvidence'
];
const SECRET_VALUE_PATTERN =
  /(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})/u;
const allowedEvidenceFields = new Set(requiredEvidenceFields);
const requiredHealthInfoFields = [
  'ok',
  'service',
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
  'latestIndexedAt'
];
const exactHealthInfoFields = [
  'ok',
  'service',
  'serviceId',
  'schemaVersion',
  'ecosystem',
  'chainId',
  'network',
  'publicBaseUrl',
  'readOnly',
  'genesisHash'
];
const soraRpcControlFields = [
  'primaryEndpoint',
  'archiveEndpoint',
  'primaryNodeControl',
  'archiveNodeControl',
  'distinctHosts',
  'exactIdentityPreflight',
  'rawPayloadAgreement'
];
const publicSoraConvenienceHosts = new Set([
  'ws.mof.sora.org',
  'mof2.sora.org',
  'mof3.sora.org'
]);

function fail(message) {
  errors.push(message);
}

function readJson(file) {
  if (!fs.existsSync(file)) {
    fail(`production deployment evidence manifest missing: ${file}`);
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`production deployment evidence manifest must be valid JSON: ${error.message}`);
    return null;
  }
}

function requireArray(value, name) {
  if (!Array.isArray(value)) {
    fail(`${name} must be an array`);
    return [];
  }
  return value;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoUtcSecond(value) {
  return timestampMillis(value) !== null;
}

function timestampMillis(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) {
    return null;
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return null;
  return new Date(millis).toISOString() === value.replace(/Z$/, '.000Z') ? millis : null;
}

function isFutureTimestamp(value) {
  const millis = timestampMillis(value);
  return millis !== null && millis > Date.now() + MAX_CLOCK_SKEW_MS;
}

function parseUtcDate(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return { ok: false, reason: 'format', millis: null };
  }

  const millis = Date.parse(`${text}T00:00:00Z`);
  if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 10) !== text) {
    return { ok: false, reason: 'calendar', millis: null };
  }

  return { ok: true, reason: null, millis };
}

function expectedReleaseCommitResult() {
  const configured = String(process.env.DEPLOYMENT_EVIDENCE_EXPECTED_COMMIT || '').trim();
  if (configured.length > 0) {
    if (!/^[0-9a-f]{40}$/i.test(configured)) {
      return {
        commit: null,
        error: 'DEPLOYMENT_EVIDENCE_EXPECTED_COMMIT must be a 40-character git commit'
      };
    }
    return { commit: configured.toLowerCase(), error: null };
  }

  try {
    const commit = childProcess.execFileSync('git', ['-C', rootDir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
    if (!/^[0-9a-f]{40}$/i.test(commit)) {
      return { commit: null, error: `git rev-parse HEAD returned an invalid commit: ${commit}` };
    }
    return { commit: commit.toLowerCase(), error: null };
  } catch (error) {
    return { commit: null, error: `could not determine repository HEAD: ${error.message}` };
  }
}

function isRepeatedHexPlaceholder(value) {
  const hex = String(value || '').replace(/^sha256:/i, '').toLowerCase();
  return /^[0-9a-f]+$/.test(hex) && new Set(hex).size === 1;
}

function isTemplatePlaceholder(value) {
  const raw = String(value || '').trim();
  const normalized = raw.toUpperCase();
  return (
    normalized.length === 0 ||
    normalized.startsWith('TODO_') ||
    normalized.startsWith('REPLACE_WITH_') ||
    normalized === 'TBD' ||
    normalized === 'N/A' ||
    normalized === 'SAMPLE' ||
    normalized.includes('PLACEHOLDER') ||
    normalized.includes('EXAMPLE')
  );
}

function secretLikeKeyReason(value, currentPath = '$') {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const reason = secretLikeKeyReason(value[index], `${currentPath}[${index}]`);
      if (reason) return reason;
    }
    return null;
  }

  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (
      normalized.includes('privatekey') ||
      normalized.includes('mnemonic') ||
      normalized.includes('seed') ||
      normalized.includes('secret') ||
      normalized.includes('password') ||
      normalized.includes('authorization') ||
      normalized.includes('credential') ||
      normalized.includes('clientdatajson')
    ) {
      return `${currentPath}.${key}`;
    }

    const reason = secretLikeKeyReason(child, `${currentPath}.${key}`);
    if (reason) return reason;
  }

  return null;
}

function secretLikeValueReason(value, currentPath = '$') {
  if (typeof value === 'string') {
    return SECRET_VALUE_PATTERN.test(value) ? currentPath : null;
  }
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const reason = secretLikeValueReason(value[index], `${currentPath}[${index}]`);
      if (reason) return reason;
    }
    return null;
  }

  for (const [key, child] of Object.entries(value)) {
    const reason = secretLikeValueReason(child, `${currentPath}.${key}`);
    if (reason) return reason;
  }

  return null;
}

function rejectUnsupportedKeys(value, allowedFields, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const allowed = new Set(allowedFields);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      fail(`${path}.${field} is not supported in public deployment evidence`);
    }
  }
}

function validatePublicOperator(value, currentPath) {
  const operator = String(value || '');
  if (!nonEmptyString(operator) || isTemplatePlaceholder(operator) || /^dummy/i.test(operator)) {
    fail(`${currentPath}.operator must identify the release operator`);
    return;
  }
  if (/[\u0000-\u001f\u007f]/u.test(operator)) {
    fail(`${currentPath}.operator: operator must be a single-line public value`);
  }
  if (SECRET_VALUE_PATTERN.test(operator)) {
    fail(`${currentPath}.operator: operator must not contain secret-like token`);
  }
}

function requireExactArray(name, actual, expected) {
  const values = requireArray(actual, name);
  const expectedSet = new Set(expected);
  for (const expectedValue of expected) {
    if (!values.includes(expectedValue)) {
      fail(`${name} missing ${expectedValue}`);
    }
  }
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) {
      fail(`duplicate ${name.replace(/\[\]$/, '')}: ${value}`);
    }
    seen.add(value);
    if (!expectedSet.has(value)) {
      fail(`${name} contains unexpected ${value}`);
    }
  }
  return values;
}

function isCanonicalNonzeroSubstrateHash(value) {
  return (
    typeof value === 'string' &&
    /^0x[0-9a-f]{64}$/.test(value) &&
    value !== `0x${'0'.repeat(64)}`
  );
}

function validateHealthInfo(value, currentPath, smokePassedAtMillis) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${currentPath} must be an object`);
    return;
  }

  rejectUnsupportedKeys(value, requiredHealthInfoFields, currentPath);
  for (const field of exactHealthInfoFields) {
    if (value[field] !== contract.healthInfo[field]) {
      fail(`${currentPath}.${field} must be ${contract.healthInfo[field]}`);
    }
  }

  if (!Number.isSafeInteger(value.latestIndexedBlock) || value.latestIndexedBlock <= 0) {
    fail(`${currentPath}.latestIndexedBlock must be a positive safe integer`);
  }

  if (!isCanonicalNonzeroSubstrateHash(value.latestIndexedBlockHash)) {
    fail(`${currentPath}.latestIndexedBlockHash must be a canonical nonzero 32-byte lowercase hash`);
  }

  if (!Number.isSafeInteger(value.latestIndexedAt) || value.latestIndexedAt <= 0) {
    fail(`${currentPath}.latestIndexedAt must be a positive safe integer Unix timestamp in seconds`);
  } else if (smokePassedAtMillis !== null) {
    const smokePassedAtSeconds = smokePassedAtMillis / 1000;
    const checkpointAgeSeconds = smokePassedAtSeconds - value.latestIndexedAt;
    if (checkpointAgeSeconds > MAX_INDEXED_CHECKPOINT_AGE_SECONDS) {
      fail(
        `${currentPath}.latestIndexedAt must be no more than ${MAX_INDEXED_CHECKPOINT_AGE_SECONDS} seconds before smokePassedAt`
      );
    }
    if (checkpointAgeSeconds < -MAX_INDEXED_CHECKPOINT_FUTURE_SKEW_SECONDS) {
      fail(
        `${currentPath}.latestIndexedAt must be no more than ${MAX_INDEXED_CHECKPOINT_FUTURE_SKEW_SECONDS} seconds after smokePassedAt`
      );
    }
  }
}

function isPlaceholderRpcHostname(hostname) {
  const normalized = String(hostname || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (
    normalized.length === 0 ||
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '0.0.0.0' ||
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('127.') ||
    normalized.startsWith('192.0.2.') ||
    normalized.startsWith('198.51.100.') ||
    normalized.startsWith('203.0.113.') ||
    normalized === '2001:db8' ||
    normalized.startsWith('2001:db8:') ||
    normalized.endsWith('.invalid') ||
    normalized.endsWith('.test') ||
    normalized === 'example.com' ||
    normalized === 'example.net' ||
    normalized === 'example.org' ||
    normalized.endsWith('.example.com') ||
    normalized.endsWith('.example.net') ||
    normalized.endsWith('.example.org')
  ) {
    return true;
  }

  return normalized
    .split('.')
    .some((label) => /^(?:todo|tbd|replace|placeholder|example|sample|dummy|test|invalid)(?:[^a-z0-9]|$)/.test(label));
}

function containsSecretLikeRpcEndpointValue(value) {
  return (
    SECRET_VALUE_PATTERN.test(value) ||
    /(?:^|[\/._~-])(?:secret|token|password|passwd|credential|api[-_]?key)(?:[\/._:=~-]|$)/i.test(value)
  );
}

function validateSoraRpcEndpoint(value, currentPath) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${currentPath} must be a canonical credential-free wss URL`);
    return null;
  }
  if (/^[\s]|[\s]$/u.test(value) || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${currentPath} must not contain whitespace or control characters`);
    return null;
  }
  if (containsSecretLikeRpcEndpointValue(value)) {
    fail(`${currentPath} must not contain secret-like values`);
    return null;
  }

  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    fail(`${currentPath} must be a canonical credential-free wss URL`);
    return null;
  }

  if (endpoint.protocol !== 'wss:') {
    fail(`${currentPath} must use wss`);
  }
  if (endpoint.username || endpoint.password) {
    fail(`${currentPath} must not contain credentials`);
  }
  if (endpoint.search) {
    fail(`${currentPath} must not contain a query string`);
  }
  if (endpoint.hash) {
    fail(`${currentPath} must not contain a fragment`);
  }
  if (value.includes('%')) {
    fail(`${currentPath} must not contain percent-encoded components`);
  }
  if (endpoint.toString() !== value) {
    fail(`${currentPath} must use canonical URL serialization`);
  }
  if (endpoint.hostname.endsWith('.')) {
    fail(`${currentPath} hostname must not have a trailing dot`);
  }

  const normalizedHostname = endpoint.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isPlaceholderRpcHostname(endpoint.hostname)) {
    fail(`${currentPath} must use a non-placeholder host`);
  }
  if (publicSoraConvenienceHosts.has(normalizedHostname)) {
    fail(`${currentPath} must not use public SORA convenience host ${normalizedHostname}`);
  }

  return normalizedHostname || null;
}

function validateSoraRpcControls(value, currentPath) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${currentPath} must be an object`);
    return;
  }

  rejectUnsupportedKeys(value, soraRpcControlFields, currentPath);
  const primaryHost = validateSoraRpcEndpoint(value.primaryEndpoint, `${currentPath}.primaryEndpoint`);
  const archiveHost = validateSoraRpcEndpoint(value.archiveEndpoint, `${currentPath}.archiveEndpoint`);

  for (const field of [
    'primaryNodeControl',
    'archiveNodeControl',
    'distinctHosts',
    'exactIdentityPreflight',
    'rawPayloadAgreement'
  ]) {
    if (value[field] !== contract.soraRpcControls[field]) {
      fail(`${currentPath}.${field} must be ${contract.soraRpcControls[field]}`);
    }
  }

  if (primaryHost && archiveHost && primaryHost === archiveHost) {
    fail(`${currentPath}.primaryEndpoint and ${currentPath}.archiveEndpoint must use different hosts`);
  }
}

function validateTlsEdgeControls(value, currentPath) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${currentPath} must be an object`);
    return;
  }

  rejectUnsupportedKeys(
    value,
    ['tlsTermination', 'forwardedClientIpHeaders', 'httpClientIpRateLimit', 'webSocketClientIpLimits'],
    currentPath
  );
  if (value.tlsTermination !== true) {
    fail(`${currentPath}.tlsTermination must be true`);
  }
  if (value.forwardedClientIpHeaders !== 'overwrite') {
    fail(`${currentPath}.forwardedClientIpHeaders must be overwrite`);
  }

  const http = value.httpClientIpRateLimit;
  if (!http || typeof http !== 'object' || Array.isArray(http)) {
    fail(`${currentPath}.httpClientIpRateLimit must be an object`);
  } else {
    rejectUnsupportedKeys(http, ['windowMs', 'maxRequests'], `${currentPath}.httpClientIpRateLimit`);
    if (http.windowMs !== contract.tlsEdgeControls.httpClientIpRateLimit.windowMs) {
      fail(`${currentPath}.httpClientIpRateLimit.windowMs must be 60000`);
    }
    if (http.maxRequests !== contract.tlsEdgeControls.httpClientIpRateLimit.maxRequests) {
      fail(`${currentPath}.httpClientIpRateLimit.maxRequests must be 600`);
    }
  }

  const webSocket = value.webSocketClientIpLimits;
  if (!webSocket || typeof webSocket !== 'object' || Array.isArray(webSocket)) {
    fail(`${currentPath}.webSocketClientIpLimits must be an object`);
  } else {
    rejectUnsupportedKeys(
      webSocket,
      ['windowMs', 'maxUpgrades', 'maxConcurrentConnections'],
      `${currentPath}.webSocketClientIpLimits`
    );
    if (webSocket.windowMs !== contract.tlsEdgeControls.webSocketClientIpLimits.windowMs) {
      fail(`${currentPath}.webSocketClientIpLimits.windowMs must be 60000`);
    }
    if (webSocket.maxUpgrades !== contract.tlsEdgeControls.webSocketClientIpLimits.maxUpgrades) {
      fail(`${currentPath}.webSocketClientIpLimits.maxUpgrades must be 600`);
    }
    if (
      webSocket.maxConcurrentConnections !==
      contract.tlsEdgeControls.webSocketClientIpLimits.maxConcurrentConnections
    ) {
      fail(`${currentPath}.webSocketClientIpLimits.maxConcurrentConnections must be 16`);
    }
  }
}

function validateDeploymentRecord(record, index, expectedCommitResult, seenDeploymentIds) {
  const currentPath = `deploymentEvidence[${index}]`;
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    fail(`${currentPath} must be an object`);
    return;
  }

  rejectUnsupportedKeys(record, requiredEvidenceFields, currentPath);
  for (const field of requiredEvidenceFields) {
    if (!(field in record)) {
      fail(`${currentPath}.${field} missing`);
    }
  }

  const commit = String(record.commit || '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commit) || isRepeatedHexPlaceholder(commit) || isTemplatePlaceholder(commit)) {
    fail(`${currentPath}.commit must be a real 40-character git commit`);
  } else if (expectedCommitResult.commit && commit !== expectedCommitResult.commit) {
    fail(`${currentPath}.commit must match expected release commit ${expectedCommitResult.commit}`);
  }

  const imageDigest = String(record.imageDigest || '');
  if (!/^sha256:[0-9a-f]{64}$/i.test(imageDigest) || isRepeatedHexPlaceholder(imageDigest) || isTemplatePlaceholder(imageDigest)) {
    fail(`${currentPath}.imageDigest must be a real sha256 image digest`);
  }

  if (!nonEmptyString(record.deploymentId) || isTemplatePlaceholder(record.deploymentId)) {
    fail(`${currentPath}.deploymentId must be a real production deployment id`);
  } else if (seenDeploymentIds.has(record.deploymentId)) {
    fail(`duplicate deployment id in evidence: ${record.deploymentId}`);
  } else {
    seenDeploymentIds.add(record.deploymentId);
  }

  if (record.baseUrl !== contract.baseUrl) {
    fail(`${currentPath}.baseUrl must be ${contract.baseUrl}`);
  }
  if (record.smokeCommand !== contract.smokeCommand) {
    fail(`${currentPath}.smokeCommand must be ${contract.smokeCommand}`);
  }

  for (const field of ['deployedAt', 'smokePassedAt']) {
    if (!isIsoUtcSecond(record[field])) {
      fail(`${currentPath}.${field} must be an ISO-8601 UTC timestamp with second precision`);
    } else if (isFutureTimestamp(record[field])) {
      fail(`${currentPath}.${field} must not be in the future`);
    }
  }
  const deployedAt = timestampMillis(record.deployedAt);
  const smokePassedAt = timestampMillis(record.smokePassedAt);
  if (deployedAt !== null && smokePassedAt !== null && smokePassedAt < deployedAt) {
    fail(`${currentPath}.smokePassedAt must be at or after deployedAt`);
  }

  validateHealthInfo(record.healthInfo, `${currentPath}.healthInfo`, smokePassedAt);
  validateSoraRpcControls(record.soraRpcControls, `${currentPath}.soraRpcControls`);
  validateTlsEdgeControls(record.tlsEdgeControls, `${currentPath}.tlsEdgeControls`);

  validatePublicOperator(record.operator, currentPath);
}

const manifest = readJson(evidenceFile);
if (manifest) {
  rejectUnsupportedKeys(manifest, allowedManifestFields, 'manifest');
  const secretPath = secretLikeKeyReason(manifest);
  if (secretPath) {
    fail(`must not be included in public deployment evidence: ${secretPath}`);
  }
  const secretValuePath = secretLikeValueReason(manifest);
  if (secretValuePath) {
    fail(`${secretValuePath} must not contain secret-like token`);
  }

  if (manifest.schemaVersion !== 1) fail('schemaVersion must be 1');
  if (manifest.scope !== contract.scope) fail(`scope must be ${contract.scope}`);
  if (manifest.serviceId !== contract.serviceId) fail(`serviceId must be ${contract.serviceId}`);
  if (manifest.baseUrl !== contract.baseUrl) fail(`baseUrl must be ${contract.baseUrl}`);
  if (!['blocked', 'ready'].includes(manifest.status)) fail('status must be blocked or ready');
  if (typeof manifest.releaseEnabled !== 'boolean') fail('releaseEnabled must be boolean');
  const lastReviewed = parseUtcDate(manifest.lastReviewed);
  if (!lastReviewed.ok) {
    fail(lastReviewed.reason === 'format' ? 'lastReviewed must be YYYY-MM-DD' : 'lastReviewed must be a valid YYYY-MM-DD date');
  } else if (lastReviewed.millis > Date.now() + MAX_CLOCK_SKEW_MS) {
    fail('lastReviewed must not be in the future');
  }
  if (manifest.smokeCommand !== contract.smokeCommand) fail(`smokeCommand must be ${contract.smokeCommand}`);
  if (manifest.dockerBuildCommand !== contract.dockerBuildCommand) {
    fail(`dockerBuildCommand must be ${contract.dockerBuildCommand}`);
  }

  const blockers = requireExactArray('blockers[]', manifest.blockers, manifest.status === 'blocked' ? contract.requiredBlockers : []);
  const readyCommands = requireExactArray('readyVerificationCommands[]', manifest.readyVerificationCommands, [
    'yarn test:deployment-evidence-template',
    'yarn generate:deployment-evidence-template --output build/reports/production-deployment-evidence-template.json',
    'yarn test:deployment-evidence-audit',
    'yarn audit:deployment-evidence --require-ready',
    contract.dockerBuildCommand,
    contract.smokeCommand
  ]);
  requireExactArray('requiredEvidenceFields[]', manifest.requiredEvidenceFields, requiredEvidenceFields);
  void blockers;
  void readyCommands;

  const deploymentEvidence = requireArray(manifest.deploymentEvidence, 'deploymentEvidence');
  if (manifest.status === 'blocked' && manifest.releaseEnabled !== false) {
    fail('releaseEnabled must remain false while deployment evidence is blocked');
  }
  if (manifest.status === 'ready' && manifest.releaseEnabled !== true) {
    fail('releaseEnabled must be true when deployment evidence is ready');
  }
  if (manifest.status === 'ready' && deploymentEvidence.length === 0) {
    fail('ready deployment evidence requires at least one operator-attested production deployment record');
  }
  if (requireReady && manifest.status !== 'ready') {
    fail('operator-attested deployment evidence must be ready when --require-ready is used');
  }

  const expectedCommitResult = expectedReleaseCommitResult();
  if ((manifest.status === 'ready' || requireReady) && expectedCommitResult.error) {
    fail(expectedCommitResult.error);
  }
  const seenDeploymentIds = new Set();
  deploymentEvidence.forEach((record, index) => {
    validateDeploymentRecord(record, index, expectedCommitResult, seenDeploymentIds);
    if (
      lastReviewed.ok &&
      timestampMillis(record?.smokePassedAt) !== null &&
      manifest.lastReviewed < record.smokePassedAt.slice(0, 10)
    ) {
      fail(`lastReviewed must be on or after deploymentEvidence[${index}].smokePassedAt UTC date`);
    }
  });
}

if (errors.length > 0) {
  console.error('[deployment-evidence][error] Operator-attested production deployment evidence is not release-ready:');
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
  process.exit(1);
}

console.log(`[deployment-evidence] status=${manifest.status} releaseEnabled=${manifest.releaseEnabled} evidence=${manifest.deploymentEvidence.length}`);
NODE
