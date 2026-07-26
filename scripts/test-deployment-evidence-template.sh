#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
  echo "[deployment-evidence-template-test][error] $*" >&2
  exit 1
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

template="$TMP_DIR/template.json"
bash "$ROOT_DIR/scripts/generate-deployment-evidence-template.sh" --output "$template" >/dev/null
grep -Fq "TODO_40_HEX_GIT_COMMIT" "$template" || fail "template commit placeholder missing"
grep -Fq "TODO_64_HEX_IMAGE_DIGEST" "$template" || fail "template image digest placeholder missing"
grep -Fq "TODO_UTC_SMOKE_TIMESTAMP_SECONDS" "$template" || fail "template smoke timestamp placeholder missing"
grep -Fq "pi.soramitsu.io" "$template" || fail "template PI service id missing"
grep -Fq '"production-deployment-evidence-missing"' "$template" || fail "operator evidence blocker missing"
grep -Fq '"live-production-smoke-failing"' "$template" || fail "live production smoke blocker missing"
grep -Fq '"tlsEdgeControls"' "$template" || fail "TLS edge controls attestation missing"
grep -Fq '"forwardedClientIpHeaders": "overwrite"' "$template" || fail "TLS edge forwarded-header overwrite missing"
grep -Fq '"maxConcurrentConnections": 16' "$template" || fail "TLS edge WebSocket client limit missing"
grep -Fq '"genesisHash": "0x7e4e32d0feafd4f9c9414b0be86373f9a1efa904809b683453a9af6856d38ad5"' "$template" || fail "exact SORA mainnet genesis hash missing"
grep -Fq '"latestIndexedBlock": "TODO_POSITIVE_SAFE_INTEGER_INDEXED_BLOCK"' "$template" || fail "indexed block placeholder missing"
grep -Fq '"latestIndexedBlockHash": "TODO_0X_64_LOWERCASE_HEX_INDEXED_BLOCK_HASH"' "$template" || fail "indexed block hash placeholder missing"
grep -Fq '"latestIndexedAt": "TODO_UNIX_SECONDS_WITHIN_300_BEFORE_OR_30_AFTER_SMOKE"' "$template" || fail "indexed checkpoint timestamp placeholder missing"
grep -Fq '"soraRpcControls"' "$template" || fail "SORA RPC control attestation missing"
grep -Fq '"primaryEndpoint": "TODO_CANONICAL_WSS_LOCALLY_CONTROLLED_PRIMARY_RPC_ENDPOINT"' "$template" || fail "primary RPC endpoint placeholder missing"
grep -Fq '"archiveEndpoint": "TODO_CANONICAL_WSS_INDEPENDENT_ARCHIVE_RPC_ENDPOINT"' "$template" || fail "archive RPC endpoint placeholder missing"
grep -Fq '"primaryNodeControl": "locally-controlled-verifying-archive"' "$template" || fail "primary RPC control role missing"
grep -Fq '"archiveNodeControl": "independently-operated-verifying-archive"' "$template" || fail "archive RPC control role missing"
grep -Fq '"distinctHosts": true' "$template" || fail "RPC distinct-host requirement missing"
grep -Fq '"exactIdentityPreflight": true' "$template" || fail "RPC exact identity preflight missing"
grep -Fq '"rawPayloadAgreement": "height-hash-scale-block-events-timestamp"' "$template" || fail "RPC raw payload agreement missing"
expect_failure "template cannot pass ready audit with TODO placeholders" "operator-attested deployment evidence must be ready when --require-ready is used" bash "$ROOT_DIR/scripts/audit-deployment-evidence.sh" --evidence "$template" --require-ready
expect_failure "template rejects TODO primary RPC endpoint" "soraRpcControls.primaryEndpoint must be a canonical credential-free wss URL" bash "$ROOT_DIR/scripts/audit-deployment-evidence.sh" --evidence "$template"

template_wrong_rpc_role="$TMP_DIR/template-wrong-rpc-role.json"
cp "$template" "$template_wrong_rpc_role"
node - "$template_wrong_rpc_role" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.deploymentEvidence[0].soraRpcControls.primaryNodeControl = 'public-convenience-node';
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "template rejects wrong primary RPC role" "soraRpcControls.primaryNodeControl must be locally-controlled-verifying-archive" bash "$ROOT_DIR/scripts/audit-deployment-evidence.sh" --evidence "$template_wrong_rpc_role"

template_extra_rpc_control="$TMP_DIR/template-extra-rpc-control.json"
cp "$template" "$template_extra_rpc_control"
node - "$template_extra_rpc_control" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.deploymentEvidence[0].soraRpcControls.unreviewedFailover = true;
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "template rejects extra RPC control" "soraRpcControls.unreviewedFailover is not supported in public deployment evidence" bash "$ROOT_DIR/scripts/audit-deployment-evidence.sh" --evidence "$template_extra_rpc_control"

template_public_rpc="$TMP_DIR/template-public-rpc.json"
cp "$template" "$template_public_rpc"
node - "$template_public_rpc" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.deploymentEvidence[0].soraRpcControls.primaryEndpoint = 'wss://ws.mof.sora.org/';
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "template rejects public SORA RPC host" "soraRpcControls.primaryEndpoint must not use public SORA convenience host ws.mof.sora.org" bash "$ROOT_DIR/scripts/audit-deployment-evidence.sh" --evidence "$template_public_rpc"

missing_smoke_blocker="$TMP_DIR/missing-smoke-blocker.json"
cp "$ROOT_DIR/scripts/production-deployment-evidence.json" "$missing_smoke_blocker"
node - "$missing_smoke_blocker" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.blockers = manifest.blockers.filter((blocker) => blocker !== 'live-production-smoke-failing');
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "missing smoke blocker rejected by generator" "blockers missing live-production-smoke-failing" bash "$ROOT_DIR/scripts/generate-deployment-evidence-template.sh" --evidence "$missing_smoke_blocker"

missing_blocker="$TMP_DIR/missing-blocker.json"
cp "$ROOT_DIR/scripts/production-deployment-evidence.json" "$missing_blocker"
node - "$missing_blocker" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.blockers = [];
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "operator evidence blocker required by generator" "blockers missing production-deployment-evidence-missing" bash "$ROOT_DIR/scripts/generate-deployment-evidence-template.sh" --evidence "$missing_blocker"

missing_tls_edge_required_field="$TMP_DIR/missing-tls-edge-required-field.json"
cp "$ROOT_DIR/scripts/production-deployment-evidence.json" "$missing_tls_edge_required_field"
node - "$missing_tls_edge_required_field" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.requiredEvidenceFields = manifest.requiredEvidenceFields.filter((field) => field !== 'tlsEdgeControls');
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "TLS edge evidence field required by generator" "requiredEvidenceFields missing tlsEdgeControls" bash "$ROOT_DIR/scripts/generate-deployment-evidence-template.sh" --evidence "$missing_tls_edge_required_field"

missing_sora_rpc_required_field="$TMP_DIR/missing-sora-rpc-required-field.json"
cp "$ROOT_DIR/scripts/production-deployment-evidence.json" "$missing_sora_rpc_required_field"
node - "$missing_sora_rpc_required_field" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.requiredEvidenceFields = manifest.requiredEvidenceFields.filter((field) => field !== 'soraRpcControls');
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "SORA RPC controls required by generator" "requiredEvidenceFields missing soraRpcControls" bash "$ROOT_DIR/scripts/generate-deployment-evidence-template.sh" --evidence "$missing_sora_rpc_required_field"

unsupported="$TMP_DIR/unsupported-manifest.json"
cp "$ROOT_DIR/scripts/production-deployment-evidence.json" "$unsupported"
node - "$unsupported" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.extra = 'unsupported';
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "unsupported evidence field" "manifest.extra is not supported in public deployment evidence manifest" bash "$ROOT_DIR/scripts/generate-deployment-evidence-template.sh" --evidence "$unsupported"

secret="$TMP_DIR/secret-manifest.json"
cp "$ROOT_DIR/scripts/production-deployment-evidence.json" "$secret"
node - "$secret" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.deploymentSecret = 'not-public';
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "secret-like manifest key" "must not be read from public deployment evidence manifest" bash "$ROOT_DIR/scripts/generate-deployment-evidence-template.sh" --evidence "$secret"

prefilled="$TMP_DIR/prefilled.json"
cp "$ROOT_DIR/scripts/production-deployment-evidence.json" "$prefilled"
node - "$prefilled" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.deploymentEvidence = [{ commit: '1234567890abcdef1234567890abcdef12345678' }];
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "prefilled deployment evidence" "committed deployment evidence manifest must not contain prefilled deployment evidence" bash "$ROOT_DIR/scripts/generate-deployment-evidence-template.sh" --evidence "$prefilled"

echo "[deployment-evidence-template-test] all tests passed"
