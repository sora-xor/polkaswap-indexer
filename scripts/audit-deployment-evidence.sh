#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${DEPLOYMENT_EVIDENCE_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
EVIDENCE_FILE="$ROOT_DIR/scripts/production-deployment-evidence.json"
REQUIRE_READY=false

usage() {
  cat <<'USAGE'
Usage: scripts/audit-deployment-evidence.sh [--evidence <path>] [--require-ready]

Validates public PI deployment evidence. The default audit allows the committed
blocked state. --require-ready requires a real deployment record for the current
release commit, image digest, live smoke timestamp, and PI health identity.

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
    readOnly: true
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
  'readOnly'
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

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoUtcSecond(value) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(String(value || ''));
}

function timestampMillis(value) {
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

function isFutureTimestamp(value) {
  const millis = timestampMillis(value);
  return millis !== null && millis > Date.now() + MAX_CLOCK_SKEW_MS;
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

function rejectUnsupportedKeys(value, allowedFields, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const allowed = new Set(allowedFields);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      fail(`${path}.${field} is not supported in public deployment evidence`);
    }
  }
}

function requireExactArray(name, actual, expected) {
  const values = requireArray(actual, name);
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
  }
  return values;
}

function validateHealthInfo(value, currentPath) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${currentPath} must be an object`);
    return;
  }

  rejectUnsupportedKeys(value, requiredHealthInfoFields, currentPath);
  for (const field of requiredHealthInfoFields) {
    if (value[field] !== contract.healthInfo[field]) {
      fail(`${currentPath}.${field} must be ${contract.healthInfo[field]}`);
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

  validateHealthInfo(record.healthInfo, `${currentPath}.healthInfo`);

  const operator = String(record.operator || '');
  if (!nonEmptyString(operator) || isTemplatePlaceholder(operator) || /^dummy/i.test(operator)) {
    fail(`${currentPath}.operator must identify the release operator`);
  }
}

const manifest = readJson(evidenceFile);
if (manifest) {
  rejectUnsupportedKeys(manifest, allowedManifestFields, 'manifest');
  const secretPath = secretLikeKeyReason(manifest);
  if (secretPath) {
    fail(`must not be included in public deployment evidence: ${secretPath}`);
  }

  if (manifest.schemaVersion !== 1) fail('schemaVersion must be 1');
  if (manifest.scope !== contract.scope) fail(`scope must be ${contract.scope}`);
  if (manifest.serviceId !== contract.serviceId) fail(`serviceId must be ${contract.serviceId}`);
  if (manifest.baseUrl !== contract.baseUrl) fail(`baseUrl must be ${contract.baseUrl}`);
  if (!['blocked', 'ready'].includes(manifest.status)) fail('status must be blocked or ready');
  if (typeof manifest.releaseEnabled !== 'boolean') fail('releaseEnabled must be boolean');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(manifest.lastReviewed || ''))) {
    fail('lastReviewed must be YYYY-MM-DD');
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
    fail('ready deployment evidence requires at least one successful live production smoke record');
  }
  if (requireReady && manifest.status !== 'ready') {
    fail('deployment evidence must be ready when --require-ready is used');
  }

  const expectedCommitResult = expectedReleaseCommitResult();
  if ((manifest.status === 'ready' || requireReady) && expectedCommitResult.error) {
    fail(expectedCommitResult.error);
  }
  const seenDeploymentIds = new Set();
  deploymentEvidence.forEach((record, index) => validateDeploymentRecord(record, index, expectedCommitResult, seenDeploymentIds));
}

if (errors.length > 0) {
  console.error('[deployment-evidence][error] Production deployment evidence is not release-ready:');
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
  process.exit(1);
}

console.log(`[deployment-evidence] status=${manifest.status} releaseEnabled=${manifest.releaseEnabled} evidence=${manifest.deploymentEvidence.length}`);
NODE
