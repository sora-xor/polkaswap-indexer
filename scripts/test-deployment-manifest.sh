#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
AUDIT_SCRIPT="$SCRIPT_DIR/audit-deployment-manifest.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

expect_failure() {
  local label="$1"
  local dockerfile="$2"
  local dockerignore="$3"
  local expected="$4"
  local compose="${5:-$ROOT_DIR/docker-compose.production.yml}"
  local output="$TMP_DIR/$label.out"
  if bash "$AUDIT_SCRIPT" "$dockerfile" "$dockerignore" "$compose" >"$output" 2>&1; then
    echo "[deployment-manifest-test][error] $label unexpectedly passed" >&2
    exit 1
  fi
  if ! grep -Fq "$expected" "$output"; then
    echo "[deployment-manifest-test][error] $label did not report: $expected" >&2
    cat "$output" >&2
    exit 1
  fi
}

bash "$AUDIT_SCRIPT" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" >/dev/null

mutable_base_image="$TMP_DIR/Dockerfile.mutable-base-image"
cp "$ROOT_DIR/Dockerfile" "$mutable_base_image"
perl -0pi -e 's/\@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5//g' "$mutable_base_image"
expect_failure "mutable-base-image" "$mutable_base_image" "$ROOT_DIR/.dockerignore" "must pin the dependency-stage Node image by digest"

runtime_digest_drift="$TMP_DIR/Dockerfile.runtime-digest-drift"
cp "$ROOT_DIR/Dockerfile" "$runtime_digest_drift"
perl -0pi -e 's/(FROM node:24-bookworm-slim\@sha256:)[0-9a-f]{64}( AS runtime)/${1}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa${2}/' "$runtime_digest_drift"
expect_failure "runtime-digest-drift" "$runtime_digest_drift" "$ROOT_DIR/.dockerignore" "must pin the runtime-stage Node image by digest"

mutable_fallback="$TMP_DIR/Dockerfile.mutable-fallback"
cp "$ROOT_DIR/Dockerfile" "$mutable_fallback"
perl -0pi -e 's/yarn install --immutable/yarn install --immutable || yarn install/' "$mutable_fallback"
expect_failure "mutable-fallback" "$mutable_fallback" "$ROOT_DIR/.dockerignore" "must not fall back to a mutable yarn install"

missing_immutable="$TMP_DIR/Dockerfile.missing-immutable"
cp "$ROOT_DIR/Dockerfile" "$missing_immutable"
perl -0pi -e 's/yarn install --immutable/yarn install/' "$missing_immutable"
expect_failure "missing-immutable" "$missing_immutable" "$ROOT_DIR/.dockerignore" "dependency installation must be immutable and fail closed"

includes_dev_dependencies="$TMP_DIR/Dockerfile.includes-dev-dependencies"
cp "$ROOT_DIR/Dockerfile" "$includes_dev_dependencies"
perl -0pi -e 's/yarn workspaces focus --all --production/yarn workspaces focus --all/' "$includes_dev_dependencies"
expect_failure "includes-dev-dependencies" "$includes_dev_dependencies" "$ROOT_DIR/.dockerignore" "production dependency stage must exclude devDependencies"

copies_unpruned_dependencies="$TMP_DIR/Dockerfile.copies-unpruned-dependencies"
cp "$ROOT_DIR/Dockerfile" "$copies_unpruned_dependencies"
perl -0pi -e 's/--from=production-dependencies --chown=node:node \/app\/node_modules/--from=dependencies --chown=node:node \/app\/node_modules/' "$copies_unpruned_dependencies"
expect_failure "copies-unpruned-dependencies" "$copies_unpruned_dependencies" "$ROOT_DIR/.dockerignore" "runtime must copy only production-focused node_modules"

runtime_install="$TMP_DIR/Dockerfile.runtime-install"
cp "$ROOT_DIR/Dockerfile" "$runtime_install"
printf '\nRUN yarn install --immutable\n' >> "$runtime_install"
expect_failure "runtime-install" "$runtime_install" "$ROOT_DIR/.dockerignore" "runtime stage must not install or mutate dependencies"

root_runtime="$TMP_DIR/Dockerfile.root-runtime"
cp "$ROOT_DIR/Dockerfile" "$root_runtime"
perl -0pi -e 's/^USER node\n//m' "$root_runtime"
expect_failure "root-runtime" "$root_runtime" "$ROOT_DIR/.dockerignore" "runtime must use the non-root node user"

weak_health_identity="$TMP_DIR/Dockerfile.weak-health-identity"
cp "$ROOT_DIR/Dockerfile" "$weak_health_identity"
perl -0pi -e 's#node dist/src/scripts/production-smoke\.js#node dist/src/index.js#' "$weak_health_identity"
expect_failure "weak-health-identity" "$weak_health_identity" "$ROOT_DIR/.dockerignore" "runtime healthcheck must reuse the complete PI identity smoke contract"

unbounded_health="$TMP_DIR/Dockerfile.unbounded-health"
cp "$ROOT_DIR/Dockerfile" "$unbounded_health"
perl -0pi -e 's/POLKASWAP_INDEXER_SMOKE_TIMEOUT_MS=4000 //' "$unbounded_health"
expect_failure "unbounded-health" "$unbounded_health" "$ROOT_DIR/.dockerignore" "runtime healthcheck must use a deadline shorter than its container timeout"

remote_health="$TMP_DIR/Dockerfile.remote-health"
cp "$ROOT_DIR/Dockerfile" "$remote_health"
perl -0pi -e 's#http://127\.0\.0\.1:#https://attacker.invalid:#' "$remote_health"
expect_failure "remote-health" "$remote_health" "$ROOT_DIR/.dockerignore" "runtime healthcheck must probe the loopback GraphQL endpoint"

public_bind="$TMP_DIR/docker-compose.public-bind.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$public_bind"
perl -0pi -e 's/127\.0\.0\.1:4350:4350/0.0.0.0:4350:4350/' "$public_bind"
expect_failure "public-bind" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "must publish GraphQL only on host loopback" "$public_bind"

writable_root="$TMP_DIR/docker-compose.writable-root.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$writable_root"
perl -0pi -e 's/read_only: true/read_only: false/' "$writable_root"
expect_failure "writable-root" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "must use a read-only root filesystem" "$writable_root"

keeps_capabilities="$TMP_DIR/docker-compose.keeps-capabilities.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$keeps_capabilities"
perl -0pi -e 's/    - ALL\n//' "$keeps_capabilities"
expect_failure "keeps-capabilities" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "must drop all Linux capabilities" "$keeps_capabilities"

allows_escalation="$TMP_DIR/docker-compose.allows-escalation.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$allows_escalation"
perl -0pi -e 's/    - no-new-privileges:true\n//' "$allows_escalation"
expect_failure "allows-escalation" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "must prevent privilege escalation" "$allows_escalation"

unbounded_pids="$TMP_DIR/docker-compose.unbounded-pids.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$unbounded_pids"
perl -0pi -e 's/  pids_limit: 128\n//' "$unbounded_pids"
expect_failure "unbounded-pids" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "must bound process IDs" "$unbounded_pids"

optional_database="$TMP_DIR/docker-compose.optional-database.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$optional_database"
perl -0pi -e 's/\$\{POLKASWAP_DATABASE_URL:\?/\${POLKASWAP_DATABASE_URL-/g' "$optional_database"
expect_failure "optional-database" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "must require an external database URL" "$optional_database"

worker_without_hardening="$TMP_DIR/docker-compose.worker-without-hardening.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$worker_without_hardening"
perl -0pi -e 's/(  worker:\n)    <<: \*runtime-security\n/$1/' "$worker_without_hardening"
expect_failure "worker-without-hardening" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "must apply the hardened runtime anchor to both API and worker" "$worker_without_hardening"

worker_without_health_override="$TMP_DIR/docker-compose.worker-without-health-override.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$worker_without_health_override"
perl -0pi -e 's/    healthcheck:\n      test: \["CMD", "node", "dist\/src\/scripts\/worker-health\.js"\]\n      interval: 30s\n      timeout: 5s\n      start_period: 30s\n      retries: 3\n//' "$worker_without_health_override"
expect_failure "worker-without-health-override" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "worker must override the inherited API healthcheck" "$worker_without_health_override"

duplicate_worker_service="$TMP_DIR/docker-compose.duplicate-worker-service.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$duplicate_worker_service"
perl -0pi -e 's/^  worker:\n/  worker:\n  worker:\n/m' "$duplicate_worker_service"
expect_failure "duplicate-worker-service" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "must define the worker service exactly once" "$duplicate_worker_service"

worker_api_only_health="$TMP_DIR/docker-compose.worker-api-only-health.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$worker_api_only_health"
perl -0pi -e 's#dist/src/scripts/worker-health\.js#dist/src/scripts/production-smoke.js#' "$worker_api_only_health"
expect_failure "worker-api-only-health" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "worker healthcheck must use the compiled database-only worker probe" "$worker_api_only_health"

worker_unbounded_health="$TMP_DIR/docker-compose.worker-unbounded-health.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$worker_unbounded_health"
perl -0pi -e 's/^      PI_WORKER_HEALTH_TIMEOUT_MS: "4000"\n//m' "$worker_unbounded_health"
expect_failure "worker-unbounded-health" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "worker database probe must enforce a four-second total deadline" "$worker_unbounded_health"

worker_deadline_exceeds_container="$TMP_DIR/docker-compose.worker-deadline-exceeds-container.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$worker_deadline_exceeds_container"
perl -0pi -e 's/PI_WORKER_HEALTH_TIMEOUT_MS: "4000"/PI_WORKER_HEALTH_TIMEOUT_MS: "5000"/' "$worker_deadline_exceeds_container"
expect_failure "worker-deadline-exceeds-container" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "worker database probe must enforce a four-second total deadline" "$worker_deadline_exceeds_container"

worker_without_container_deadline="$TMP_DIR/docker-compose.worker-without-container-deadline.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$worker_without_container_deadline"
perl -0pi -e 's/^      timeout: 5s\n//m' "$worker_without_container_deadline"
expect_failure "worker-without-container-deadline" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "worker healthcheck must retain the five-second container timeout" "$worker_without_container_deadline"

optional_image="$TMP_DIR/docker-compose.optional-image.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$optional_image"
perl -0pi -e 's/\$\{POLKASWAP_INDEXER_IMAGE_DIGEST:\?/\${POLKASWAP_INDEXER_IMAGE_DIGEST-/' "$optional_image"
expect_failure "optional-image" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "must require an immutable image digest" "$optional_image"

executable_tmp="$TMP_DIR/docker-compose.executable-tmp.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$executable_tmp"
perl -0pi -e 's#/tmp:rw,noexec,nosuid,nodev,size=16m#/tmp:rw,size=16m#' "$executable_tmp"
expect_failure "executable-tmp" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "must use a bounded no-exec tmpfs" "$executable_tmp"

optional_sora="$TMP_DIR/docker-compose.optional-sora.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$optional_sora"
perl -0pi -e 's/\$\{POLKASWAP_SORA_WS_ENDPOINT:\?/\${POLKASWAP_SORA_WS_ENDPOINT-/' "$optional_sora"
expect_failure "optional-sora" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "must require an external SORA endpoint" "$optional_sora"

optional_sora_archive="$TMP_DIR/docker-compose.optional-sora-archive.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$optional_sora_archive"
perl -0pi -e 's/\$\{POLKASWAP_SORA_ARCHIVE_WS_ENDPOINT:\?/\${POLKASWAP_SORA_ARCHIVE_WS_ENDPOINT-/' "$optional_sora_archive"
expect_failure "optional-sora-archive" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "must require an independently reviewed SORA archive endpoint" "$optional_sora_archive"

missing_sora_archive="$TMP_DIR/docker-compose.missing-sora-archive.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$missing_sora_archive"
perl -0pi -e 's/^      SORA_ARCHIVE_WS_ENDPOINT:.*\n//m' "$missing_sora_archive"
expect_failure "missing-sora-archive" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "must require an independently reviewed SORA archive endpoint" "$missing_sora_archive"

optional_chain_start="$TMP_DIR/docker-compose.optional-chain-start.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$optional_chain_start"
perl -0pi -e 's/\$\{POLKASWAP_CHAIN_START_BLOCK:\?/\${POLKASWAP_CHAIN_START_BLOCK-/' "$optional_chain_start"
expect_failure "optional-chain-start" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "must require an explicit reviewed chain start block" "$optional_chain_start"

missing_chain_start="$TMP_DIR/docker-compose.missing-chain-start.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$missing_chain_start"
perl -0pi -e 's/^      CHAIN_START_BLOCK:.*\n//m' "$missing_chain_start"
expect_failure "missing-chain-start" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "must require an explicit reviewed chain start block" "$missing_chain_start"

introspection_enabled="$TMP_DIR/docker-compose.introspection-enabled.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$introspection_enabled"
perl -0pi -e 's/GRAPHQL_ALLOW_INTROSPECTION: "false"/GRAPHQL_ALLOW_INTROSPECTION: "true"/' "$introspection_enabled"
expect_failure "introspection-enabled" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "must disable production introspection" "$introspection_enabled"

proxy_throttled_as_client="$TMP_DIR/docker-compose.proxy-throttled-as-client.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$proxy_throttled_as_client"
perl -0pi -e 's/RATE_LIMIT_MAX: "50000"/RATE_LIMIT_MAX: "600"/' "$proxy_throttled_as_client"
expect_failure "proxy-throttled-as-client" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "must avoid treating the loopback proxy as one public client" "$proxy_throttled_as_client"

proxy_throttled_as_websocket_client="$TMP_DIR/docker-compose.proxy-throttled-as-websocket-client.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$proxy_throttled_as_websocket_client"
perl -0pi -e 's/GRAPHQL_WS_MAX_CONNECTIONS_PER_CLIENT: "512"/GRAPHQL_WS_MAX_CONNECTIONS_PER_CLIENT: "16"/' "$proxy_throttled_as_websocket_client"
expect_failure "proxy-throttled-as-websocket-client" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "must avoid treating the loopback proxy as one WebSocket client" "$proxy_throttled_as_websocket_client"

unsafe_context="$TMP_DIR/.dockerignore"
cp "$ROOT_DIR/.dockerignore" "$unsafe_context"
perl -0pi -e 's/^node_modules\n//m' "$unsafe_context"
expect_failure "unsafe-context" "$ROOT_DIR/Dockerfile" "$unsafe_context" ".dockerignore must exclude node_modules"

echo "[deployment-manifest-test] all assertions passed"
