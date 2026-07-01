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

template="$TMP_DIR/template.json"
bash "$ROOT_DIR/scripts/generate-deployment-evidence-template.sh" --output "$template" >/dev/null
grep -Fq "TODO_40_HEX_GIT_COMMIT" "$template" || fail "template commit placeholder missing"
grep -Fq "TODO_64_HEX_IMAGE_DIGEST" "$template" || fail "template image digest placeholder missing"
grep -Fq "TODO_UTC_SMOKE_TIMESTAMP_SECONDS" "$template" || fail "template smoke timestamp placeholder missing"
grep -Fq "pi.soramitsu.io" "$template" || fail "template PI service id missing"

expect_failure "template cannot pass ready audit with TODO placeholders" "deployment evidence must be ready when --require-ready is used" bash "$ROOT_DIR/scripts/audit-deployment-evidence.sh" --evidence "$template" --require-ready

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
