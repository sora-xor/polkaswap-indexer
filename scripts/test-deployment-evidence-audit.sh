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
  local log="$TMP_DIR/$(printf '%s' "$name" | tr -cs '[:alnum:]_.' '-').log"
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
  lastReviewed: '2026-07-10',
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
    'soraRpcControls',
    'tlsEdgeControls',
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
        readOnly: true,
        genesisHash: '0x7e4e32d0feafd4f9c9414b0be86373f9a1efa904809b683453a9af6856d38ad5',
        latestIndexedBlock: 26_000_001,
        latestIndexedBlockHash: '0x28dd415867e637e5c70056a564cfa4e81f0f3df3a18d1132ccc61fe5025c762c',
        latestIndexedAt: Math.floor(Date.parse('2026-07-01T00:03:00Z') / 1000)
      },
      soraRpcControls: {
        primaryEndpoint: 'wss://sora-primary-rpc.prod.internal/ws',
        archiveEndpoint: 'wss://sora-archive-rpc.dr.internal/ws',
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
      },
      operator: 'release-operator'
    }
  ]
};
fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
}

set_health_value() {
  local file="$1"
  local field="$2"
  local json_value="$3"
  node - "$file" "$field" "$json_value" <<'NODE'
const fs = require('fs');
const [file, field, jsonValue] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
const healthInfo = manifest.deploymentEvidence[0].healthInfo;
if (jsonValue === '__DELETE__') delete healthInfo[field];
else healthInfo[field] = JSON.parse(jsonValue);
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
}

set_rpc_control_value() {
  local file="$1"
  local field="$2"
  local json_value="$3"
  node - "$file" "$field" "$json_value" <<'NODE'
const fs = require('fs');
const [file, field, jsonValue] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
const soraRpcControls = manifest.deploymentEvidence[0].soraRpcControls;
if (jsonValue === '__DELETE__') delete soraRpcControls[field];
else soraRpcControls[field] = JSON.parse(jsonValue);
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
}

set_checkpoint_offset_from_smoke() {
  local file="$1"
  local offset_seconds="$2"
  node - "$file" "$offset_seconds" <<'NODE'
const fs = require('fs');
const [file, offsetSeconds] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
const record = manifest.deploymentEvidence[0];
record.healthInfo.latestIndexedAt = Math.floor(Date.parse(record.smokePassedAt) / 1000) + Number(offsetSeconds);
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
}

blocked="$ROOT_DIR/scripts/production-deployment-evidence.json"
run_audit "$blocked" >/dev/null
expect_failure "blocked require-ready" "operator-attested deployment evidence must be ready when --require-ready is used" run_audit "$blocked" --require-ready

missing_smoke_blocker="$TMP_DIR/missing-smoke-blocker.json"
cp "$blocked" "$missing_smoke_blocker"
node - "$missing_smoke_blocker" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.blockers = manifest.blockers.filter((blocker) => blocker !== 'live-production-smoke-failing');
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "missing live smoke blocker" "blockers[] missing live-production-smoke-failing" run_audit "$missing_smoke_blocker"

missing_operator_evidence_blocker="$TMP_DIR/missing-operator-evidence-blocker.json"
cp "$blocked" "$missing_operator_evidence_blocker"
node - "$missing_operator_evidence_blocker" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.blockers = [];
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "missing operator evidence blocker" "blockers[] missing production-deployment-evidence-missing" run_audit "$missing_operator_evidence_blocker"

duplicate_operator_evidence_blocker="$TMP_DIR/duplicate-operator-evidence-blocker.json"
cp "$blocked" "$duplicate_operator_evidence_blocker"
node - "$duplicate_operator_evidence_blocker" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.blockers.push('production-deployment-evidence-missing');
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "duplicate operator evidence blocker" "duplicate blockers: production-deployment-evidence-missing" run_audit "$duplicate_operator_evidence_blocker"

ready="$TMP_DIR/ready.json"
write_ready_manifest "$ready"
run_audit "$ready" --require-ready >/dev/null

bad_last_reviewed="$TMP_DIR/bad-last-reviewed.json"
write_ready_manifest "$bad_last_reviewed"
perl -0pi -e 's/"lastReviewed": "2026-07-10"/"lastReviewed": "today"/' "$bad_last_reviewed"
expect_failure "bad lastReviewed date" "lastReviewed must be YYYY-MM-DD" run_audit "$bad_last_reviewed" --require-ready

invalid_calendar_last_reviewed="$TMP_DIR/invalid-calendar-last-reviewed.json"
write_ready_manifest "$invalid_calendar_last_reviewed"
perl -0pi -e 's/"lastReviewed": "2026-07-10"/"lastReviewed": "2026-02-31"/' "$invalid_calendar_last_reviewed"
expect_failure "invalid calendar lastReviewed date" "lastReviewed must be a valid YYYY-MM-DD date" run_audit "$invalid_calendar_last_reviewed" --require-ready

future_last_reviewed="$TMP_DIR/future-last-reviewed.json"
write_ready_manifest "$future_last_reviewed"
perl -0pi -e 's/"lastReviewed": "2026-07-10"/"lastReviewed": "2999-01-01"/' "$future_last_reviewed"
expect_failure "future lastReviewed date" "lastReviewed must not be in the future" run_audit "$future_last_reviewed" --require-ready

stale_multi_record_review="$TMP_DIR/stale-multi-record-review.json"
write_ready_manifest "$stale_multi_record_review"
node - "$stale_multi_record_review" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
const second = structuredClone(manifest.deploymentEvidence[0]);
second.deploymentId = 'pi-release-20260711';
second.deployedAt = '2026-07-11T00:00:00Z';
second.smokePassedAt = '2026-07-11T00:05:00Z';
second.healthInfo.latestIndexedAt = Math.floor(Date.parse(second.smokePassedAt) / 1000);
manifest.deploymentEvidence.push(second);
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure \
  "lastReviewed predates later smoke in multiple deployment records" \
  "lastReviewed must be on or after deploymentEvidence[1].smokePassedAt UTC date" \
  run_audit "$stale_multi_record_review" --require-ready

missing="$TMP_DIR/missing.json"
expect_failure "missing manifest" "production deployment evidence manifest missing" run_audit "$missing"

blocked_enabled="$TMP_DIR/blocked-enabled.json"
cp "$blocked" "$blocked_enabled"
perl -0pi -e 's/"releaseEnabled": false/"releaseEnabled": true/' "$blocked_enabled"
expect_failure "release enabled while blocked" "releaseEnabled must remain false while deployment evidence is blocked" run_audit "$blocked_enabled"

ready_without_evidence="$TMP_DIR/ready-without-evidence.json"
cp "$blocked" "$ready_without_evidence"
perl -0pi -e 's/"status": "blocked"/"status": "ready"/; s/"releaseEnabled": false/"releaseEnabled": true/; s/"blockers": \\[[^\\]]+\\]/"blockers": []/s' "$ready_without_evidence"
expect_failure "ready without evidence" "ready deployment evidence requires at least one operator-attested production deployment record" run_audit "$ready_without_evidence" --require-ready

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

impossible_deployed_date="$TMP_DIR/impossible-deployed-date.json"
write_ready_manifest "$impossible_deployed_date"
perl -0pi -e 's/"deployedAt": "2026-07-01T00:00:00Z"/"deployedAt": "2026-02-30T00:00:00Z"/' "$impossible_deployed_date"
expect_failure "impossible deployed calendar date" "deployedAt must be an ISO-8601 UTC timestamp with second precision" run_audit "$impossible_deployed_date" --require-ready

non_leap_smoke_date="$TMP_DIR/non-leap-smoke-date.json"
write_ready_manifest "$non_leap_smoke_date"
perl -0pi -e 's/"smokePassedAt": "2026-07-01T00:05:00Z"/"smokePassedAt": "2025-02-29T00:05:00Z"/' "$non_leap_smoke_date"
expect_failure "non-leap-day smoke timestamp" "smokePassedAt must be an ISO-8601 UTC timestamp with second precision" run_audit "$non_leap_smoke_date" --require-ready

hour_24_smoke="$TMP_DIR/hour-24-smoke.json"
write_ready_manifest "$hour_24_smoke"
perl -0pi -e 's/"smokePassedAt": "2026-07-01T00:05:00Z"/"smokePassedAt": "2026-07-01T24:00:00Z"/' "$hour_24_smoke"
expect_failure "hour-24 smoke timestamp" "smokePassedAt must be an ISO-8601 UTC timestamp with second precision" run_audit "$hour_24_smoke" --require-ready

valid_leap_day="$TMP_DIR/valid-leap-day.json"
write_ready_manifest "$valid_leap_day"
perl -0pi -e 's/"deployedAt": "2026-07-01T00:00:00Z"/"deployedAt": "2024-02-29T00:00:00Z"/; s/"smokePassedAt": "2026-07-01T00:05:00Z"/"smokePassedAt": "2024-02-29T00:05:00Z"/' "$valid_leap_day"
node - "$valid_leap_day" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.deploymentEvidence[0].healthInfo.latestIndexedAt =
  Math.floor(Date.parse('2024-02-29T00:03:00Z') / 1000);
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
run_audit "$valid_leap_day" --require-ready >/dev/null

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

missing_genesis_hash="$TMP_DIR/missing-genesis-hash.json"
write_ready_manifest "$missing_genesis_hash"
set_health_value "$missing_genesis_hash" genesisHash __DELETE__
expect_failure "missing SORA genesis hash" "healthInfo.genesisHash must be 0x7e4e32d0feafd4f9c9414b0be86373f9a1efa904809b683453a9af6856d38ad5" run_audit "$missing_genesis_hash" --require-ready

wrong_genesis_hash="$TMP_DIR/wrong-genesis-hash.json"
write_ready_manifest "$wrong_genesis_hash"
set_health_value "$wrong_genesis_hash" genesisHash '"0x28dd415867e637e5c70056a564cfa4e81f0f3df3a18d1132ccc61fe5025c762c"'
expect_failure "wrong but well-formed genesis hash" "healthInfo.genesisHash must be 0x7e4e32d0feafd4f9c9414b0be86373f9a1efa904809b683453a9af6856d38ad5" run_audit "$wrong_genesis_hash" --require-ready

uppercase_genesis_hash="$TMP_DIR/uppercase-genesis-hash.json"
write_ready_manifest "$uppercase_genesis_hash"
set_health_value "$uppercase_genesis_hash" genesisHash '"0x7E4E32D0FEAFD4F9C9414B0BE86373F9A1EFA904809B683453A9AF6856D38AD5"'
expect_failure "noncanonical uppercase genesis hash" "healthInfo.genesisHash must be 0x7e4e32d0feafd4f9c9414b0be86373f9a1efa904809b683453a9af6856d38ad5" run_audit "$uppercase_genesis_hash" --require-ready

missing_indexed_block="$TMP_DIR/missing-indexed-block.json"
write_ready_manifest "$missing_indexed_block"
set_health_value "$missing_indexed_block" latestIndexedBlock __DELETE__
expect_failure "missing indexed block" "healthInfo.latestIndexedBlock must be a positive safe integer" run_audit "$missing_indexed_block" --require-ready

zero_indexed_block="$TMP_DIR/zero-indexed-block.json"
write_ready_manifest "$zero_indexed_block"
set_health_value "$zero_indexed_block" latestIndexedBlock '0'
expect_failure "zero indexed block" "healthInfo.latestIndexedBlock must be a positive safe integer" run_audit "$zero_indexed_block" --require-ready

negative_indexed_block="$TMP_DIR/negative-indexed-block.json"
write_ready_manifest "$negative_indexed_block"
set_health_value "$negative_indexed_block" latestIndexedBlock '-1'
expect_failure "negative indexed block" "healthInfo.latestIndexedBlock must be a positive safe integer" run_audit "$negative_indexed_block" --require-ready

string_indexed_block="$TMP_DIR/string-indexed-block.json"
write_ready_manifest "$string_indexed_block"
set_health_value "$string_indexed_block" latestIndexedBlock '"26000001"'
expect_failure "string indexed block" "healthInfo.latestIndexedBlock must be a positive safe integer" run_audit "$string_indexed_block" --require-ready

fractional_indexed_block="$TMP_DIR/fractional-indexed-block.json"
write_ready_manifest "$fractional_indexed_block"
set_health_value "$fractional_indexed_block" latestIndexedBlock '26000001.5'
expect_failure "fractional indexed block" "healthInfo.latestIndexedBlock must be a positive safe integer" run_audit "$fractional_indexed_block" --require-ready

unsafe_indexed_block="$TMP_DIR/unsafe-indexed-block.json"
write_ready_manifest "$unsafe_indexed_block"
set_health_value "$unsafe_indexed_block" latestIndexedBlock '9007199254740992'
expect_failure "unsafe indexed block" "healthInfo.latestIndexedBlock must be a positive safe integer" run_audit "$unsafe_indexed_block" --require-ready

missing_indexed_block_hash="$TMP_DIR/missing-indexed-block-hash.json"
write_ready_manifest "$missing_indexed_block_hash"
set_health_value "$missing_indexed_block_hash" latestIndexedBlockHash __DELETE__
expect_failure "missing indexed block hash" "healthInfo.latestIndexedBlockHash must be a canonical nonzero 32-byte lowercase hash" run_audit "$missing_indexed_block_hash" --require-ready

zero_indexed_block_hash="$TMP_DIR/zero-indexed-block-hash.json"
write_ready_manifest "$zero_indexed_block_hash"
set_health_value "$zero_indexed_block_hash" latestIndexedBlockHash '"0x0000000000000000000000000000000000000000000000000000000000000000"'
expect_failure "zero indexed block hash" "healthInfo.latestIndexedBlockHash must be a canonical nonzero 32-byte lowercase hash" run_audit "$zero_indexed_block_hash" --require-ready

uppercase_indexed_block_hash="$TMP_DIR/uppercase-indexed-block-hash.json"
write_ready_manifest "$uppercase_indexed_block_hash"
set_health_value "$uppercase_indexed_block_hash" latestIndexedBlockHash '"0x28DD415867E637E5C70056A564CFA4E81F0F3DF3A18D1132CCC61FE5025C762C"'
expect_failure "uppercase indexed block hash" "healthInfo.latestIndexedBlockHash must be a canonical nonzero 32-byte lowercase hash" run_audit "$uppercase_indexed_block_hash" --require-ready

short_indexed_block_hash="$TMP_DIR/short-indexed-block-hash.json"
write_ready_manifest "$short_indexed_block_hash"
set_health_value "$short_indexed_block_hash" latestIndexedBlockHash '"0x1234"'
expect_failure "short indexed block hash" "healthInfo.latestIndexedBlockHash must be a canonical nonzero 32-byte lowercase hash" run_audit "$short_indexed_block_hash" --require-ready

long_indexed_block_hash="$TMP_DIR/long-indexed-block-hash.json"
write_ready_manifest "$long_indexed_block_hash"
set_health_value "$long_indexed_block_hash" latestIndexedBlockHash '"0x28dd415867e637e5c70056a564cfa4e81f0f3df3a18d1132ccc61fe5025c762c00"'
expect_failure "long indexed block hash" "healthInfo.latestIndexedBlockHash must be a canonical nonzero 32-byte lowercase hash" run_audit "$long_indexed_block_hash" --require-ready

unprefixed_indexed_block_hash="$TMP_DIR/unprefixed-indexed-block-hash.json"
write_ready_manifest "$unprefixed_indexed_block_hash"
set_health_value "$unprefixed_indexed_block_hash" latestIndexedBlockHash '"28dd415867e637e5c70056a564cfa4e81f0f3df3a18d1132ccc61fe5025c762c"'
expect_failure "unprefixed indexed block hash" "healthInfo.latestIndexedBlockHash must be a canonical nonzero 32-byte lowercase hash" run_audit "$unprefixed_indexed_block_hash" --require-ready

nonhex_indexed_block_hash="$TMP_DIR/nonhex-indexed-block-hash.json"
write_ready_manifest "$nonhex_indexed_block_hash"
set_health_value "$nonhex_indexed_block_hash" latestIndexedBlockHash '"0x28dd415867e637e5c70056a564cfa4e81f0f3df3a18d1132ccc61fe5025c762z"'
expect_failure "nonhex indexed block hash" "healthInfo.latestIndexedBlockHash must be a canonical nonzero 32-byte lowercase hash" run_audit "$nonhex_indexed_block_hash" --require-ready

numeric_indexed_block_hash="$TMP_DIR/numeric-indexed-block-hash.json"
write_ready_manifest "$numeric_indexed_block_hash"
set_health_value "$numeric_indexed_block_hash" latestIndexedBlockHash '42'
expect_failure "numeric indexed block hash" "healthInfo.latestIndexedBlockHash must be a canonical nonzero 32-byte lowercase hash" run_audit "$numeric_indexed_block_hash" --require-ready

missing_indexed_at="$TMP_DIR/missing-indexed-at.json"
write_ready_manifest "$missing_indexed_at"
set_health_value "$missing_indexed_at" latestIndexedAt __DELETE__
expect_failure "missing indexed timestamp" "healthInfo.latestIndexedAt must be a positive safe integer Unix timestamp in seconds" run_audit "$missing_indexed_at" --require-ready

zero_indexed_at="$TMP_DIR/zero-indexed-at.json"
write_ready_manifest "$zero_indexed_at"
set_health_value "$zero_indexed_at" latestIndexedAt '0'
expect_failure "zero indexed timestamp" "healthInfo.latestIndexedAt must be a positive safe integer Unix timestamp in seconds" run_audit "$zero_indexed_at" --require-ready

negative_indexed_at="$TMP_DIR/negative-indexed-at.json"
write_ready_manifest "$negative_indexed_at"
set_health_value "$negative_indexed_at" latestIndexedAt '-1'
expect_failure "negative indexed timestamp" "healthInfo.latestIndexedAt must be a positive safe integer Unix timestamp in seconds" run_audit "$negative_indexed_at" --require-ready

string_indexed_at="$TMP_DIR/string-indexed-at.json"
write_ready_manifest "$string_indexed_at"
set_health_value "$string_indexed_at" latestIndexedAt '"1782864180"'
expect_failure "string indexed timestamp" "healthInfo.latestIndexedAt must be a positive safe integer Unix timestamp in seconds" run_audit "$string_indexed_at" --require-ready

fractional_indexed_at="$TMP_DIR/fractional-indexed-at.json"
write_ready_manifest "$fractional_indexed_at"
set_health_value "$fractional_indexed_at" latestIndexedAt '1782864180.5'
expect_failure "fractional indexed timestamp" "healthInfo.latestIndexedAt must be a positive safe integer Unix timestamp in seconds" run_audit "$fractional_indexed_at" --require-ready

unsafe_indexed_at="$TMP_DIR/unsafe-indexed-at.json"
write_ready_manifest "$unsafe_indexed_at"
set_health_value "$unsafe_indexed_at" latestIndexedAt '9007199254740992'
expect_failure "unsafe indexed timestamp" "healthInfo.latestIndexedAt must be a positive safe integer Unix timestamp in seconds" run_audit "$unsafe_indexed_at" --require-ready

millisecond_indexed_at="$TMP_DIR/millisecond-indexed-at.json"
write_ready_manifest "$millisecond_indexed_at"
set_health_value "$millisecond_indexed_at" latestIndexedAt '1782864180000'
expect_failure "millisecond indexed timestamp" "healthInfo.latestIndexedAt must be no more than 30 seconds after smokePassedAt" run_audit "$millisecond_indexed_at" --require-ready

stale_indexed_at="$TMP_DIR/stale-indexed-at.json"
write_ready_manifest "$stale_indexed_at"
set_checkpoint_offset_from_smoke "$stale_indexed_at" -301
expect_failure "indexed timestamp one second stale" "healthInfo.latestIndexedAt must be no more than 300 seconds before smokePassedAt" run_audit "$stale_indexed_at" --require-ready

future_indexed_at="$TMP_DIR/future-indexed-at.json"
write_ready_manifest "$future_indexed_at"
set_checkpoint_offset_from_smoke "$future_indexed_at" 31
expect_failure "indexed timestamp one second too far ahead" "healthInfo.latestIndexedAt must be no more than 30 seconds after smokePassedAt" run_audit "$future_indexed_at" --require-ready

oldest_allowed_indexed_at="$TMP_DIR/oldest-allowed-indexed-at.json"
write_ready_manifest "$oldest_allowed_indexed_at"
set_checkpoint_offset_from_smoke "$oldest_allowed_indexed_at" -300
run_audit "$oldest_allowed_indexed_at" --require-ready >/dev/null

newest_allowed_indexed_at="$TMP_DIR/newest-allowed-indexed-at.json"
write_ready_manifest "$newest_allowed_indexed_at"
set_checkpoint_offset_from_smoke "$newest_allowed_indexed_at" 30
run_audit "$newest_allowed_indexed_at" --require-ready >/dev/null

unsupported_health_field="$TMP_DIR/unsupported-health-field.json"
write_ready_manifest "$unsupported_health_field"
set_health_value "$unsupported_health_field" rpcEndpoint '"wss://should-not-be-public.example"'
expect_failure "unsupported health evidence field" "healthInfo.rpcEndpoint is not supported in public deployment evidence" run_audit "$unsupported_health_field" --require-ready

missing_sora_rpc_controls="$TMP_DIR/missing-sora-rpc-controls.json"
write_ready_manifest "$missing_sora_rpc_controls"
node - "$missing_sora_rpc_controls" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
delete manifest.deploymentEvidence[0].soraRpcControls;
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "missing SORA RPC controls" "deploymentEvidence[0].soraRpcControls missing" run_audit "$missing_sora_rpc_controls" --require-ready

missing_sora_rpc_required_field="$TMP_DIR/missing-sora-rpc-required-field.json"
write_ready_manifest "$missing_sora_rpc_required_field"
node - "$missing_sora_rpc_required_field" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.requiredEvidenceFields = manifest.requiredEvidenceFields.filter((field) => field !== 'soraRpcControls');
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "missing SORA RPC required evidence field" "requiredEvidenceFields[] missing soraRpcControls" run_audit "$missing_sora_rpc_required_field" --require-ready

for container_value in 'null' '[]' '"invalid"'; do
  fixture="$TMP_DIR/rpc-controls-wrong-container-$(printf '%s' "$container_value" | tr -cd '[:alnum:]').json"
  write_ready_manifest "$fixture"
  node - "$fixture" "$container_value" <<'NODE'
const fs = require('fs');
const [file, jsonValue] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.deploymentEvidence[0].soraRpcControls = JSON.parse(jsonValue);
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
  expect_failure "wrong SORA RPC controls container $container_value" "soraRpcControls must be an object" run_audit "$fixture" --require-ready
done

for field in primaryEndpoint archiveEndpoint; do
  fixture="$TMP_DIR/missing-${field}.json"
  write_ready_manifest "$fixture"
  set_rpc_control_value "$fixture" "$field" __DELETE__
  expect_failure "missing $field" "soraRpcControls.$field must be a canonical credential-free wss URL" run_audit "$fixture" --require-ready
done

for field in primaryNodeControl archiveNodeControl distinctHosts exactIdentityPreflight rawPayloadAgreement; do
  fixture="$TMP_DIR/missing-${field}.json"
  write_ready_manifest "$fixture"
  set_rpc_control_value "$fixture" "$field" __DELETE__
  case "$field" in
    primaryNodeControl) expected='soraRpcControls.primaryNodeControl must be locally-controlled-verifying-archive' ;;
    archiveNodeControl) expected='soraRpcControls.archiveNodeControl must be independently-operated-verifying-archive' ;;
    distinctHosts) expected='soraRpcControls.distinctHosts must be true' ;;
    exactIdentityPreflight) expected='soraRpcControls.exactIdentityPreflight must be true' ;;
    rawPayloadAgreement) expected='soraRpcControls.rawPayloadAgreement must be height-hash-scale-block-events-timestamp' ;;
  esac
  expect_failure "missing $field" "$expected" run_audit "$fixture" --require-ready
done

extra_sora_rpc_control="$TMP_DIR/extra-sora-rpc-control.json"
write_ready_manifest "$extra_sora_rpc_control"
set_rpc_control_value "$extra_sora_rpc_control" failoverEndpoint '"wss://unattested-rpc.prod.internal/ws"'
expect_failure "extra SORA RPC control" "soraRpcControls.failoverEndpoint is not supported in public deployment evidence" run_audit "$extra_sora_rpc_control" --require-ready

wrong_primary_control="$TMP_DIR/wrong-primary-control.json"
write_ready_manifest "$wrong_primary_control"
set_rpc_control_value "$wrong_primary_control" primaryNodeControl '"third-party-rpc"'
expect_failure "wrong primary node control role" "soraRpcControls.primaryNodeControl must be locally-controlled-verifying-archive" run_audit "$wrong_primary_control" --require-ready

wrong_archive_control="$TMP_DIR/wrong-archive-control.json"
write_ready_manifest "$wrong_archive_control"
set_rpc_control_value "$wrong_archive_control" archiveNodeControl '"locally-controlled-verifying-archive"'
expect_failure "wrong archive node control role" "soraRpcControls.archiveNodeControl must be independently-operated-verifying-archive" run_audit "$wrong_archive_control" --require-ready

for field in distinctHosts exactIdentityPreflight; do
  for bad_value in 'false' '"true"' '1'; do
    fixture="$TMP_DIR/wrong-${field}-$(printf '%s' "$bad_value" | tr -cd '[:alnum:]').json"
    write_ready_manifest "$fixture"
    set_rpc_control_value "$fixture" "$field" "$bad_value"
    expect_failure "wrong $field value $bad_value" "soraRpcControls.$field must be true" run_audit "$fixture" --require-ready
  done
done

wrong_payload_agreement="$TMP_DIR/wrong-payload-agreement.json"
write_ready_manifest "$wrong_payload_agreement"
set_rpc_control_value "$wrong_payload_agreement" rawPayloadAgreement '"height-hash-json"'
expect_failure "incomplete raw RPC payload agreement" "soraRpcControls.rawPayloadAgreement must be height-hash-scale-block-events-timestamp" run_audit "$wrong_payload_agreement" --require-ready

same_rpc_host="$TMP_DIR/same-rpc-host.json"
write_ready_manifest "$same_rpc_host"
set_rpc_control_value "$same_rpc_host" primaryEndpoint '"wss://shared-sora-rpc.prod.internal:7443/primary"'
set_rpc_control_value "$same_rpc_host" archiveEndpoint '"wss://shared-sora-rpc.prod.internal:8443/archive"'
expect_failure "same RPC host behind different ports and paths" "primaryEndpoint and deploymentEvidence[0].soraRpcControls.archiveEndpoint must use different hosts" run_audit "$same_rpc_host" --require-ready

for public_host in ws.mof.sora.org mof2.sora.org mof3.sora.org; do
  fixture="$TMP_DIR/public-${public_host//./-}.json"
  write_ready_manifest "$fixture"
  set_rpc_control_value "$fixture" primaryEndpoint "\"wss://$public_host/\""
  expect_failure "public SORA convenience host $public_host" "soraRpcControls.primaryEndpoint must not use public SORA convenience host $public_host" run_audit "$fixture" --require-ready
done

public_archive_host="$TMP_DIR/public-archive-host.json"
write_ready_manifest "$public_archive_host"
set_rpc_control_value "$public_archive_host" archiveEndpoint '"wss://mof2.sora.org/"'
expect_failure "public SORA archive convenience host" "soraRpcControls.archiveEndpoint must not use public SORA convenience host mof2.sora.org" run_audit "$public_archive_host" --require-ready

for bad_scheme in 'ws://sora-primary-rpc.prod.internal/ws' 'https://sora-primary-rpc.prod.internal/ws' 'http://sora-primary-rpc.prod.internal/ws'; do
  fixture="$TMP_DIR/bad-rpc-scheme-$(printf '%s' "$bad_scheme" | tr -cd '[:alnum:]').json"
  write_ready_manifest "$fixture"
  set_rpc_control_value "$fixture" primaryEndpoint "\"$bad_scheme\""
  expect_failure "unsafe RPC scheme $bad_scheme" "soraRpcControls.primaryEndpoint must use wss" run_audit "$fixture" --require-ready
done

credentialed_rpc="$TMP_DIR/credentialed-rpc.json"
write_ready_manifest "$credentialed_rpc"
set_rpc_control_value "$credentialed_rpc" primaryEndpoint '"wss://alice:opaque@sora-primary-rpc.prod.internal/ws"'
expect_failure "credentialed RPC endpoint" "soraRpcControls.primaryEndpoint must not contain credentials" run_audit "$credentialed_rpc" --require-ready

query_rpc="$TMP_DIR/query-rpc.json"
write_ready_manifest "$query_rpc"
set_rpc_control_value "$query_rpc" primaryEndpoint '"wss://sora-primary-rpc.prod.internal/ws?mode=ready"'
expect_failure "RPC endpoint query string" "soraRpcControls.primaryEndpoint must not contain a query string" run_audit "$query_rpc" --require-ready

fragment_rpc="$TMP_DIR/fragment-rpc.json"
write_ready_manifest "$fragment_rpc"
set_rpc_control_value "$fragment_rpc" primaryEndpoint '"wss://sora-primary-rpc.prod.internal/ws#primary"'
expect_failure "RPC endpoint fragment" "soraRpcControls.primaryEndpoint must not contain a fragment" run_audit "$fragment_rpc" --require-ready

encoded_rpc="$TMP_DIR/encoded-rpc.json"
write_ready_manifest "$encoded_rpc"
set_rpc_control_value "$encoded_rpc" primaryEndpoint '"wss://sora-primary-rpc.prod.internal/%77s"'
expect_failure "percent-encoded RPC endpoint" "soraRpcControls.primaryEndpoint must not contain percent-encoded components" run_audit "$encoded_rpc" --require-ready

uppercase_rpc_host="$TMP_DIR/uppercase-rpc-host.json"
write_ready_manifest "$uppercase_rpc_host"
set_rpc_control_value "$uppercase_rpc_host" primaryEndpoint '"wss://SORA-PRIMARY-RPC.prod.internal/ws"'
expect_failure "noncanonical uppercase RPC host" "soraRpcControls.primaryEndpoint must use canonical URL serialization" run_audit "$uppercase_rpc_host" --require-ready

default_port_rpc="$TMP_DIR/default-port-rpc.json"
write_ready_manifest "$default_port_rpc"
set_rpc_control_value "$default_port_rpc" primaryEndpoint '"wss://sora-primary-rpc.prod.internal:443/ws"'
expect_failure "noncanonical default RPC port" "soraRpcControls.primaryEndpoint must use canonical URL serialization" run_audit "$default_port_rpc" --require-ready

missing_path_slash_rpc="$TMP_DIR/missing-path-slash-rpc.json"
write_ready_manifest "$missing_path_slash_rpc"
set_rpc_control_value "$missing_path_slash_rpc" primaryEndpoint '"wss://sora-primary-rpc.prod.internal"'
expect_failure "noncanonical missing RPC path slash" "soraRpcControls.primaryEndpoint must use canonical URL serialization" run_audit "$missing_path_slash_rpc" --require-ready

trailing_dot_rpc="$TMP_DIR/trailing-dot-rpc.json"
write_ready_manifest "$trailing_dot_rpc"
set_rpc_control_value "$trailing_dot_rpc" primaryEndpoint '"wss://sora-primary-rpc.prod.internal./ws"'
expect_failure "RPC hostname trailing dot" "soraRpcControls.primaryEndpoint hostname must not have a trailing dot" run_audit "$trailing_dot_rpc" --require-ready

for placeholder_url in \
  'wss://TODO_PRIMARY_RPC.prod.internal/ws' \
  'wss://primary-rpc.example.com/ws' \
  'wss://192.0.2.10/ws' \
  'wss://localhost/ws' \
  'wss://test/ws' \
  'wss://invalid/ws'; do
  fixture="$TMP_DIR/placeholder-rpc-$(printf '%s' "$placeholder_url" | tr -cd '[:alnum:]').json"
  write_ready_manifest "$fixture"
  set_rpc_control_value "$fixture" primaryEndpoint "\"$placeholder_url\""
  expect_failure "placeholder RPC host $placeholder_url" "soraRpcControls.primaryEndpoint must use a non-placeholder host" run_audit "$fixture" --require-ready
done

control_character_rpc="$TMP_DIR/control-character-rpc.json"
write_ready_manifest "$control_character_rpc"
set_rpc_control_value "$control_character_rpc" primaryEndpoint '"wss://sora-primary-rpc.prod.internal/ws\nInjected"'
expect_failure "control character in RPC endpoint" "soraRpcControls.primaryEndpoint must not contain whitespace or control characters" run_audit "$control_character_rpc" --require-ready

secret_path_rpc="$TMP_DIR/secret-path-rpc.json"
write_ready_manifest "$secret_path_rpc"
set_rpc_control_value "$secret_path_rpc" primaryEndpoint '"wss://sora-primary-rpc.prod.internal/token/opaque"'
expect_failure "secret-like RPC path" "soraRpcControls.primaryEndpoint must not contain secret-like values" run_audit "$secret_path_rpc" --require-ready

token_value_rpc="$TMP_DIR/token-value-rpc.json"
write_ready_manifest "$token_value_rpc"
set_rpc_control_value "$token_value_rpc" primaryEndpoint '"wss://sora-primary-rpc.prod.internal/ws/ghp_1234567890abcdefghijklmnop"'
expect_failure "secret token in RPC endpoint" "deploymentEvidence[0].soraRpcControls.primaryEndpoint must not contain secret-like token" run_audit "$token_value_rpc" --require-ready

numeric_rpc_endpoint="$TMP_DIR/numeric-rpc-endpoint.json"
write_ready_manifest "$numeric_rpc_endpoint"
set_rpc_control_value "$numeric_rpc_endpoint" primaryEndpoint '42'
expect_failure "numeric RPC endpoint" "soraRpcControls.primaryEndpoint must be a canonical credential-free wss URL" run_audit "$numeric_rpc_endpoint" --require-ready

missing_tls_edge_controls="$TMP_DIR/missing-tls-edge-controls.json"
write_ready_manifest "$missing_tls_edge_controls"
node - "$missing_tls_edge_controls" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
delete manifest.deploymentEvidence[0].tlsEdgeControls;
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "missing TLS edge controls attestation" "deploymentEvidence[0].tlsEdgeControls missing" run_audit "$missing_tls_edge_controls" --require-ready

missing_tls_edge_required_field="$TMP_DIR/missing-tls-edge-required-field.json"
write_ready_manifest "$missing_tls_edge_required_field"
node - "$missing_tls_edge_required_field" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.requiredEvidenceFields = manifest.requiredEvidenceFields.filter((field) => field !== 'tlsEdgeControls');
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "missing TLS edge required evidence field" "requiredEvidenceFields[] missing tlsEdgeControls" run_audit "$missing_tls_edge_required_field" --require-ready

tls_termination_disabled="$TMP_DIR/tls-termination-disabled.json"
write_ready_manifest "$tls_termination_disabled"
node - "$tls_termination_disabled" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.deploymentEvidence[0].tlsEdgeControls.tlsTermination = false;
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "TLS edge termination disabled" "tlsEdgeControls.tlsTermination must be true" run_audit "$tls_termination_disabled" --require-ready

forwarded_headers_preserved="$TMP_DIR/forwarded-headers-preserved.json"
write_ready_manifest "$forwarded_headers_preserved"
node - "$forwarded_headers_preserved" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.deploymentEvidence[0].tlsEdgeControls.forwardedClientIpHeaders = 'preserve';
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "TLS edge preserves spoofable forwarding headers" "forwardedClientIpHeaders must be overwrite" run_audit "$forwarded_headers_preserved" --require-ready

missing_http_edge_limit="$TMP_DIR/missing-http-edge-limit.json"
write_ready_manifest "$missing_http_edge_limit"
node - "$missing_http_edge_limit" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
delete manifest.deploymentEvidence[0].tlsEdgeControls.httpClientIpRateLimit;
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "missing TLS edge HTTP rate limit" "httpClientIpRateLimit must be an object" run_audit "$missing_http_edge_limit" --require-ready

permissive_http_edge_limit="$TMP_DIR/permissive-http-edge-limit.json"
write_ready_manifest "$permissive_http_edge_limit"
node - "$permissive_http_edge_limit" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.deploymentEvidence[0].tlsEdgeControls.httpClientIpRateLimit.maxRequests = 50000;
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "permissive TLS edge HTTP rate limit" "httpClientIpRateLimit.maxRequests must be 600" run_audit "$permissive_http_edge_limit" --require-ready

string_http_edge_limit="$TMP_DIR/string-http-edge-limit.json"
write_ready_manifest "$string_http_edge_limit"
node - "$string_http_edge_limit" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.deploymentEvidence[0].tlsEdgeControls.httpClientIpRateLimit.windowMs = '60000';
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "string TLS edge HTTP rate window" "httpClientIpRateLimit.windowMs must be 60000" run_audit "$string_http_edge_limit" --require-ready

permissive_websocket_edge_limit="$TMP_DIR/permissive-websocket-edge-limit.json"
write_ready_manifest "$permissive_websocket_edge_limit"
node - "$permissive_websocket_edge_limit" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.deploymentEvidence[0].tlsEdgeControls.webSocketClientIpLimits.maxConcurrentConnections = 512;
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "permissive TLS edge WebSocket connection limit" "webSocketClientIpLimits.maxConcurrentConnections must be 16" run_audit "$permissive_websocket_edge_limit" --require-ready

unsupported_tls_edge_field="$TMP_DIR/unsupported-tls-edge-field.json"
write_ready_manifest "$unsupported_tls_edge_field"
node - "$unsupported_tls_edge_field" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.deploymentEvidence[0].tlsEdgeControls.webSocketClientIpLimits.unbounded = true;
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "unsupported TLS edge limit field" "webSocketClientIpLimits.unbounded is not supported in public deployment evidence" run_audit "$unsupported_tls_edge_field" --require-ready

placeholder_operator="$TMP_DIR/placeholder-operator.json"
write_ready_manifest "$placeholder_operator"
node - "$placeholder_operator" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.deploymentEvidence[0].operator = 'TODO_RELEASE_OPERATOR';
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "placeholder operator evidence" "operator must identify the release operator" run_audit "$placeholder_operator" --require-ready

dummy_operator="$TMP_DIR/dummy-operator.json"
write_ready_manifest "$dummy_operator"
node - "$dummy_operator" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.deploymentEvidence[0].operator = 'dummy operator';
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "dummy operator evidence" "operator must identify the release operator" run_audit "$dummy_operator" --require-ready

multiline_operator="$TMP_DIR/multiline-operator.json"
write_ready_manifest "$multiline_operator"
node - "$multiline_operator" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.deploymentEvidence[0].operator = 'release\noperator';
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "multiline operator evidence" "operator must be a single-line public value" run_audit "$multiline_operator" --require-ready

secret_operator="$TMP_DIR/secret-operator.json"
write_ready_manifest "$secret_operator"
node - "$secret_operator" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.deploymentEvidence[0].operator = 'ghp_1234567890abcdefghijklmnop';
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "secret-like operator evidence" "operator must not contain secret-like token" run_audit "$secret_operator" --require-ready

secret_value="$TMP_DIR/secret-value.json"
write_ready_manifest "$secret_value"
node - "$secret_value" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.deploymentEvidence[0].deploymentId = 'pi-ghp_1234567890abcdefghijklmnop';
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "secret-like deployment evidence value" "deploymentId must not contain secret-like token" run_audit "$secret_value" --require-ready

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
