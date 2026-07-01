#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
  echo "[deployment-evidence-test][error] $*" >&2
  exit 1
}

run_audit() {
  DEPLOYMENT_EVIDENCE_ROOT="$ROOT_DIR" bash "$ROOT_DIR/scripts/audit-deployment-evidence.sh" --evidence "$1" "${@:2}"
}

expect_failure() {
  local name="$1"
  local expected="$2"
  shift 2
  local log="$TMP_DIR/${name// /-}.log"
  if "$@" >"$log" 2>&1; then
    cat "$log" >&2
    fail "$name unexpectedly passed"
  fi
  if ! grep -Fq "$expected" "$log"; then
    cat "$log" >&2
    fail "$name did not report expected message: $expected"
  fi
}

write_ready_manifest() {
  local output="$1"
  local commit="${2:-$(git -C "$ROOT_DIR" rev-parse HEAD)}"
  node - "$output" "$commit" <<'NODE'
const fs = require('fs');
const [output, commit] = process.argv.slice(2);
const manifest = {
  schemaVersion: 1,
  scope: 'polkaswap-indexer-production-deployment-readiness',
  serviceId: 'pi.soramitsu.io',
  baseUrl: 'https://pi.soramitsu.io/graphql',
  status: 'ready',
  releaseEnabled: true,
  lastReviewed: '2026-07-01',
  blockers: [],
  smokeCommand: 'POLKASWAP_INDEXER_BASE_URL=https://pi.soramitsu.io/graphql yarn smoke:production',
  dockerBuildCommand: 'docker build -t polkaswap-indexer:release .',
  readyVerificationCommands: [
    'yarn test:deployment-evidence-template',
    'yarn generate:deployment-evidence-template --output build/reports/production-deployment-evidence-template.json',
    'yarn test:deployment-evidence-audit',
    'yarn audit:deployment-evidence --require-ready',
    'docker build -t polkaswap-indexer:release .',
    'POLKASWAP_INDEXER_BASE_URL=https://pi.soramitsu.io/graphql yarn smoke:production'
  ],
  requiredEvidenceFields: [
    'commit',
    'imageDigest',
    'deploymentId',
    'baseUrl',
    'smokeCommand',
    'deployedAt',
    'smokePassedAt',
    'healthInfo',
    'operator'
  ],
  deploymentEvidence: [
    {
      commit,
      imageDigest: 'sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      deploymentId: 'pi-prod-20260701-001',
      baseUrl: 'https://pi.soramitsu.io/graphql',
      smokeCommand: 'POLKASWAP_INDEXER_BASE_URL=https://pi.soramitsu.io/graphql yarn smoke:production',
      deployedAt: '2026-07-01T00:00:00Z',
      smokePassedAt: '2026-07-01T00:05:00Z',
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
      },
      operator: 'release-operator'
    }
  ]
};
fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
}

blocked="$ROOT_DIR/scripts/production-deployment-evidence.json"
run_audit "$blocked" >/dev/null
expect_failure "blocked require-ready" "deployment evidence must be ready when --require-ready is used" run_audit "$blocked" --require-ready

ready="$TMP_DIR/ready.json"
write_ready_manifest "$ready"
run_audit "$ready" --require-ready >/dev/null

missing="$TMP_DIR/missing.json"
expect_failure "missing manifest" "production deployment evidence manifest missing" run_audit "$missing"

blocked_enabled="$TMP_DIR/blocked-enabled.json"
cp "$blocked" "$blocked_enabled"
perl -0pi -e 's/"releaseEnabled": false/"releaseEnabled": true/' "$blocked_enabled"
expect_failure "release enabled while blocked" "releaseEnabled must remain false while deployment evidence is blocked" run_audit "$blocked_enabled"

ready_without_evidence="$TMP_DIR/ready-without-evidence.json"
cp "$blocked" "$ready_without_evidence"
perl -0pi -e 's/"status": "blocked"/"status": "ready"/; s/"releaseEnabled": false/"releaseEnabled": true/; s/"blockers": \\[[^\\]]+\\]/"blockers": []/s' "$ready_without_evidence"
expect_failure "ready without evidence" "ready deployment evidence requires at least one successful live production smoke record" run_audit "$ready_without_evidence" --require-ready

placeholder_digest="$TMP_DIR/placeholder-digest.json"
write_ready_manifest "$placeholder_digest"
perl -0pi -e 's/sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef/sha256:0000000000000000000000000000000000000000000000000000000000000000/' "$placeholder_digest"
expect_failure "placeholder image digest" "imageDigest must be a real sha256 image digest" run_audit "$placeholder_digest" --require-ready

stale_commit="$TMP_DIR/stale-commit.json"
write_ready_manifest "$stale_commit" "1234567890abcdef1234567890abcdef12345678"
expect_failure "stale release commit evidence" "commit must match expected release commit" run_audit "$stale_commit" --require-ready

bad_expected="$TMP_DIR/bad-expected.json"
write_ready_manifest "$bad_expected"
expect_failure "malformed expected release commit" "DEPLOYMENT_EVIDENCE_EXPECTED_COMMIT must be a 40-character git commit" env DEPLOYMENT_EVIDENCE_EXPECTED_COMMIT=not-a-commit DEPLOYMENT_EVIDENCE_ROOT="$ROOT_DIR" bash "$ROOT_DIR/scripts/audit-deployment-evidence.sh" --evidence "$bad_expected" --require-ready

future_smoke="$TMP_DIR/future-smoke.json"
write_ready_manifest "$future_smoke"
perl -0pi -e 's/"smokePassedAt": "2026-07-01T00:05:00Z"/"smokePassedAt": "2999-01-01T00:05:00Z"/' "$future_smoke"
expect_failure "future smoke timestamp" "smokePassedAt must not be in the future" run_audit "$future_smoke" --require-ready

smoke_before_deploy="$TMP_DIR/smoke-before-deploy.json"
write_ready_manifest "$smoke_before_deploy"
perl -0pi -e 's/"smokePassedAt": "2026-07-01T00:05:00Z"/"smokePassedAt": "2025-12-31T23:59:00Z"/' "$smoke_before_deploy"
expect_failure "smoke before deployment evidence" "smokePassedAt must be at or after deployedAt" run_audit "$smoke_before_deploy" --require-ready

secret_like="$TMP_DIR/secret-like.json"
write_ready_manifest "$secret_like"
node - "$secret_like" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.deploymentEvidence[0].privateKey = 'not-public';
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "secret-like deployment evidence key" "must not be included in public deployment evidence" run_audit "$secret_like" --require-ready

unsupported="$TMP_DIR/unsupported.json"
write_ready_manifest "$unsupported"
node - "$unsupported" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.deploymentEvidence[0].extra = 'unsupported';
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "unsupported deployment evidence field" "deploymentEvidence[0].extra is not supported in public deployment evidence" run_audit "$unsupported" --require-ready

wrong_health="$TMP_DIR/wrong-health.json"
write_ready_manifest "$wrong_health"
node - "$wrong_health" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.deploymentEvidence[0].healthInfo.serviceId = 'si.soramitsu.io';
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "wrong health identity" "healthInfo.serviceId must be pi.soramitsu.io" run_audit "$wrong_health" --require-ready

missing_template_command="$TMP_DIR/missing-template-command.json"
write_ready_manifest "$missing_template_command"
node - "$missing_template_command" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.readyVerificationCommands = manifest.readyVerificationCommands.filter((command) => !command.includes('generate:deployment-evidence-template'));
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "missing deployment evidence template command" "readyVerificationCommands[] missing yarn generate:deployment-evidence-template" run_audit "$missing_template_command" --require-ready

echo "[deployment-evidence-test] all tests passed"
