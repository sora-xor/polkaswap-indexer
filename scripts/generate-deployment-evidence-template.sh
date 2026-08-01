#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${DEPLOYMENT_EVIDENCE_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
EVIDENCE_FILE="$ROOT_DIR/scripts/production-deployment-evidence.json"
OUTPUT_FILE=""

usage() {
  cat <<'USAGE'
Usage: scripts/generate-deployment-evidence-template.sh [--evidence <path>] [--output <path>]

Generates a fill-in-ready PI deployment evidence manifest. The generated
template intentionally contains TODO placeholders and must fail the release-ready
audit until an operator attests the real deployment and its successful live
production smoke result, exact SORA mainnet genesis and indexed checkpoint,
independent verifying RPC controls, plus the delegated TLS-edge client-IP
HTTP/WebSocket controls.
USAGE
}

while (($#)); do
  case "$1" in
    --evidence)
      [[ $# -ge 2 ]] || { echo "[deployment-evidence-template][error] --evidence requires a path" >&2; exit 2; }
      EVIDENCE_FILE="$2"
      shift 2
      ;;
    --output)
      [[ $# -ge 2 ]] || { echo "[deployment-evidence-template][error] --output requires a path" >&2; exit 2; }
      OUTPUT_FILE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[deployment-evidence-template][error] Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "[deployment-evidence-template][error] node is required for structured JSON generation" >&2
  exit 1
fi

node - "$EVIDENCE_FILE" "$OUTPUT_FILE" <<'NODE'
const fs = require('fs');
const path = require('path');

const [evidenceFile, outputFile] = process.argv.slice(2);
const errors = [];
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
    genesisHash: SORA_MAINNET_GENESIS_HASH,
    latestIndexedBlock: 'TODO_POSITIVE_SAFE_INTEGER_INDEXED_BLOCK',
    latestIndexedBlockHash: 'TODO_0X_64_LOWERCASE_HEX_INDEXED_BLOCK_HASH',
    latestIndexedAt: 'TODO_UNIX_SECONDS_WITHIN_300_BEFORE_OR_30_AFTER_SMOKE'
  },
  soraRpcControls: {
    primaryEndpoint: 'TODO_CANONICAL_WSS_LOCALLY_CONTROLLED_PRIMARY_RPC_ENDPOINT',
    archiveEndpoint: 'TODO_CANONICAL_WSS_INDEPENDENT_ARCHIVE_RPC_ENDPOINT',
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

function requireExactArray(value, expected, name) {
  const values = requireArray(value, name);
  const expectedSet = new Set(expected);
  const seen = new Set();
  for (const expectedValue of expected) {
    if (!values.includes(expectedValue)) {
      fail(`${name} missing ${expectedValue}`);
    }
  }
  for (const item of values) {
    if (seen.has(item)) {
      fail(`${name} contains duplicate ${item}`);
    }
    seen.add(item);
    if (!expectedSet.has(item)) {
      fail(`${name} contains unexpected ${item}`);
    }
  }
  return values;
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

function rejectUnsupportedKeys(value, allowedFields, pathName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const allowed = new Set(allowedFields);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      fail(`${pathName}.${field} is not supported in public deployment evidence manifest`);
    }
  }
}

const manifest = readJson(evidenceFile);
if (manifest) {
  rejectUnsupportedKeys(manifest, allowedManifestFields, 'manifest');
  const secretPath = secretLikeKeyReason(manifest);
  if (secretPath) {
    fail(`must not be read from public deployment evidence manifest: ${secretPath}`);
  }
  if (manifest.scope !== contract.scope) fail(`scope must be ${contract.scope}`);
  if (manifest.serviceId !== contract.serviceId) fail(`serviceId must be ${contract.serviceId}`);
  if (manifest.baseUrl !== contract.baseUrl) fail(`baseUrl must be ${contract.baseUrl}`);
  if (manifest.smokeCommand !== contract.smokeCommand) fail(`smokeCommand must be ${contract.smokeCommand}`);
  if (manifest.dockerBuildCommand !== contract.dockerBuildCommand) fail(`dockerBuildCommand must be ${contract.dockerBuildCommand}`);
  requireExactArray(manifest.blockers, contract.requiredBlockers, 'blockers');
  for (const field of requiredEvidenceFields) {
    if (!requireArray(manifest.requiredEvidenceFields, 'requiredEvidenceFields').includes(field)) {
      fail(`requiredEvidenceFields missing ${field}`);
    }
  }
  if (Array.isArray(manifest.deploymentEvidence) && manifest.deploymentEvidence.length > 0) {
    fail('committed deployment evidence manifest must not contain prefilled deployment evidence');
  }
}

if (errors.length > 0) {
  console.error('[deployment-evidence-template][error] Cannot generate deployment evidence template:');
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
  process.exit(1);
}

const template = {
  schemaVersion: 1,
  scope: contract.scope,
  serviceId: contract.serviceId,
  baseUrl: contract.baseUrl,
  status: 'blocked',
  releaseEnabled: false,
  lastReviewed: new Date().toISOString().slice(0, 10),
  blockers: [...contract.requiredBlockers],
  smokeCommand: contract.smokeCommand,
  dockerBuildCommand: contract.dockerBuildCommand,
  readyVerificationCommands: [
    'yarn test:deployment-evidence-template',
    'yarn generate:deployment-evidence-template --output build/reports/production-deployment-evidence-template.json',
    'yarn test:deployment-evidence-audit',
    'yarn audit:deployment-evidence --require-ready',
    contract.dockerBuildCommand,
    contract.smokeCommand
  ],
  requiredEvidenceFields,
  deploymentEvidence: [
    {
      commit: 'TODO_40_HEX_GIT_COMMIT',
      imageDigest: 'sha256:TODO_64_HEX_IMAGE_DIGEST',
      deploymentId: 'TODO_PRODUCTION_DEPLOYMENT_ID',
      baseUrl: contract.baseUrl,
      smokeCommand: contract.smokeCommand,
      deployedAt: 'TODO_UTC_DEPLOYED_AT_SECONDS',
      smokePassedAt: 'TODO_UTC_SMOKE_TIMESTAMP_SECONDS',
      healthInfo: contract.healthInfo,
      soraRpcControls: contract.soraRpcControls,
      tlsEdgeControls: contract.tlsEdgeControls,
      operator: 'TODO_RELEASE_OPERATOR'
    }
  ]
};

const rendered = `${JSON.stringify(template, null, 2)}\n`;
if (outputFile) {
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, rendered);
  console.log(`[deployment-evidence-template] wrote ${outputFile}`);
} else {
  process.stdout.write(rendered);
}
NODE
