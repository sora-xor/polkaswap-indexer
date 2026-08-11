#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AUDIT_SCRIPT="$SCRIPT_DIR/audit-public-artifacts.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

new_repo() {
  local repo="$1"
  mkdir -p "$repo"
  git -C "$repo" init -q
  printf 'API_TOKEN=\n' > "$repo/.env.example"
  printf 'export const ok = true;\n' > "$repo/index.ts"
  git -C "$repo" add .env.example index.ts
}

expect_failure() {
  local repo="$1"
  local label="$2"
  local expected="$3"
  local output="$TMP_DIR/$label.out"
  if PUBLIC_ARTIFACT_AUDIT_ROOT="$repo" bash "$AUDIT_SCRIPT" >"$output" 2>&1; then
    echo "[public-artifact-audit-test] ERROR: expected failure for $label" >&2
    exit 1
  fi
  if ! grep -Fq "$expected" "$output"; then
    echo "[public-artifact-audit-test] ERROR: $label did not report: $expected" >&2
    cat "$output" >&2
    exit 1
  fi
}

PASS_REPO="$TMP_DIR/pass"
new_repo "$PASS_REPO"
PUBLIC_ARTIFACT_AUDIT_ROOT="$PASS_REPO" bash "$AUDIT_SCRIPT" >/dev/null

BUILD_REPO="$TMP_DIR/build"
new_repo "$BUILD_REPO"
mkdir -p "$BUILD_REPO/dist"
printf 'generated\n' > "$BUILD_REPO/dist/index.js"
git -C "$BUILD_REPO" add dist/index.js
expect_failure "$BUILD_REPO" "build" "generated build output is tracked"

ENV_REPO="$TMP_DIR/env"
new_repo "$ENV_REPO"
printf 'TOKEN=secret\n' > "$ENV_REPO/.env"
git -C "$ENV_REPO" add .env
expect_failure "$ENV_REPO" "env" "unexpected env file is tracked"

KEY_REPO="$TMP_DIR/key"
new_repo "$KEY_REPO"
printf 'not-a-real-key\n' > "$KEY_REPO/release.pem"
git -C "$KEY_REPO" add release.pem
expect_failure "$KEY_REPO" "key" "private key or signing artifact is tracked"

SENSITIVE_EXAMPLE_REPO="$TMP_DIR/sensitive-example"
new_repo "$SENSITIVE_EXAMPLE_REPO"
printf 'API_TOKEN=committed-secret\n' > "$SENSITIVE_EXAMPLE_REPO/.env.example"
git -C "$SENSITIVE_EXAMPLE_REPO" add .env.example
expect_failure "$SENSITIVE_EXAMPLE_REPO" "sensitive-example" "non-empty sensitive value for API_TOKEN"

echo "[public-artifact-audit-test] all tests passed"
