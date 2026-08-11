#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
AUDIT_SCRIPT="$SCRIPT_DIR/audit-deployment-manifest.sh"
RESOLVED_AUDIT_SCRIPT="$SCRIPT_DIR/audit-resolved-deployment-manifest.mjs"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  COMPOSE_COMMAND=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_COMMAND=(docker-compose)
else
  echo "[deployment-manifest-test][error] Docker Compose is required" >&2
  exit 1
fi

expect_failure() {
  local label="$1"
  local dockerfile="$2"
  local dockerignore="$3"
  local expected="$4"
  local compose="${5:-$ROOT_DIR/docker-compose.production.yml}"
  local readme="${6:-$ROOT_DIR/README.md}"
  local env_example="${7:-$ROOT_DIR/.env.example}"
  local output="$TMP_DIR/$label.out"
  if bash "$AUDIT_SCRIPT" "$dockerfile" "$dockerignore" "$compose" "$readme" "$env_example" >"$output" 2>&1; then
    echo "[deployment-manifest-test][error] $label unexpectedly passed" >&2
    exit 1
  fi
  if ! grep -Fq "$expected" "$output"; then
    echo "[deployment-manifest-test][error] $label did not report: $expected" >&2
    cat "$output" >&2
    exit 1
  fi
}

expect_resolved_failure() {
  local label="$1"
  local expected="$2"
  local owner_url="$3"
  local api_url="$4"
  local worker_url="$5"
  local output="$TMP_DIR/$label.out"
  local resolved
  if ! resolved="$(
    POLKASWAP_INDEXER_IMAGE_REPOSITORY=registry.invalid/polkaswap-indexer \
    POLKASWAP_INDEXER_IMAGE_DIGEST=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    POLKASWAP_MIGRATION_OWNER_DATABASE_URL="$owner_url" \
    POLKASWAP_API_DATABASE_URL="$api_url" \
    POLKASWAP_WORKER_DATABASE_URL="$worker_url" \
    POLKASWAP_SORA_WS_ENDPOINT=wss://primary.invalid \
    POLKASWAP_SORA_ARCHIVE_WS_ENDPOINT=wss://archive.invalid \
    POLKASWAP_CHAIN_START_BLOCK=14000000 \
      "${COMPOSE_COMMAND[@]}" -f "$ROOT_DIR/docker-compose.production.yml" config --format json
  )"; then
    echo "[deployment-manifest-test][error] $label fixture did not render" >&2
    exit 1
  fi
  if node "$RESOLVED_AUDIT_SCRIPT" <<<"$resolved" >"$output" 2>&1; then
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

shell_runtime_entrypoint="$TMP_DIR/Dockerfile.shell-runtime-entrypoint"
cp "$ROOT_DIR/Dockerfile" "$shell_runtime_entrypoint"
perl -0pi -e 's/ENTRYPOINT \["docker-entrypoint\.sh"\]/ENTRYPOINT ["sh", "-c"]/' "$shell_runtime_entrypoint"
expect_failure "shell-runtime-entrypoint" "$shell_runtime_entrypoint" "$ROOT_DIR/.dockerignore" "runtime image must use exactly the pinned Node exec entrypoint"

shell_runtime_command="$TMP_DIR/Dockerfile.shell-runtime-command"
cp "$ROOT_DIR/Dockerfile" "$shell_runtime_command"
perl -0pi -e 's#CMD \["node", "dist/src/index\.js"\]#CMD ["sh", "-c", "node dist/src/db/migrate.js && node dist/src/index.js"]#' "$shell_runtime_command"
expect_failure "shell-runtime-command" "$shell_runtime_command" "$ROOT_DIR/.dockerignore" "runtime image must use exactly the compiled API default command"

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

dockerfile_tls_override="$TMP_DIR/Dockerfile.tls-override"
cp "$ROOT_DIR/Dockerfile" "$dockerfile_tls_override"
printf '\nENV NODE_TLS_REJECT_UNAUTHORIZED=0\n' >> "$dockerfile_tls_override"
expect_failure "dockerfile-tls-override" "$dockerfile_tls_override" "$ROOT_DIR/.dockerignore" "production image and Compose must not set Node or PostgreSQL process overrides"

public_bind="$TMP_DIR/docker-compose.public-bind.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$public_bind"
perl -0pi -e 's/127\.0\.0\.1:4350:4350/0.0.0.0:4350:4350/' "$public_bind"
expect_failure "public-bind" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "must publish GraphQL only on host loopback" "$public_bind"

migration_pgoptions_override="$TMP_DIR/docker-compose.migration-pgoptions.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$migration_pgoptions_override"
perl -0pi -e 's/(^  migrate:\n.*?^      NODE_ENV: production\n)/$1      PGOPTIONS: "-c search_path=attacker,public"\n/ms' "$migration_pgoptions_override"
expect_failure "migration-pgoptions-override" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "production image and Compose must not set Node or PostgreSQL process overrides" "$migration_pgoptions_override"

api_tls_override="$TMP_DIR/docker-compose.api-tls-override.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$api_tls_override"
perl -0pi -e 's/(^  api:\n.*?^      NODE_ENV: production\n)/$1      NODE_TLS_REJECT_UNAUTHORIZED: "0"\n/ms' "$api_tls_override"
expect_failure "api-tls-override" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "production image and Compose must not set Node or PostgreSQL process overrides" "$api_tls_override"

worker_node_options_override="$TMP_DIR/docker-compose.worker-node-options.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$worker_node_options_override"
perl -0pi -e 's/(^  worker:\n.*?^      NODE_ENV: production\n)/$1      NODE_OPTIONS: "--require=\/tmp\/unreviewed.js"\n/ms' "$worker_node_options_override"
expect_failure "worker-node-options-override" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "production image and Compose must not set Node or PostgreSQL process overrides" "$worker_node_options_override"

api_extra_environment="$TMP_DIR/docker-compose.api-extra-environment.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$api_extra_environment"
perl -0pi -e 's/(^  api:\n.*?^      NODE_ENV: production\n)/$1      UNREVIEWED_RUNTIME_INPUT: "1"\n/ms' "$api_extra_environment"
expect_failure "api-extra-environment" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "resolved api environment must match its exact audited map" "$api_extra_environment"

api_missing_mobile_capability="$TMP_DIR/docker-compose.api-missing-mobile-capability.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$api_missing_mobile_capability"
perl -0pi -e 's/^      MOBILE_CONFIG_NEXUS_AVAILABLE:.*\n//m' "$api_missing_mobile_capability"
expect_failure "api-missing-mobile-capability" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "Production Compose must expose MOBILE_CONFIG_NEXUS_AVAILABLE through its exact reviewed deployment input" "$api_missing_mobile_capability"

api_unreviewed_mobile_default="$TMP_DIR/docker-compose.api-unreviewed-mobile-default.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$api_unreviewed_mobile_default"
perl -0pi -e 's/POLKASWAP_MOBILE_CONFIG_NEXUS_SENDS_AVAILABLE:-false/POLKASWAP_MOBILE_CONFIG_NEXUS_SENDS_AVAILABLE:-true/' "$api_unreviewed_mobile_default"
expect_failure "api-unreviewed-mobile-default" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "Production Compose must expose MOBILE_CONFIG_NEXUS_SENDS_AVAILABLE through its exact reviewed deployment input" "$api_unreviewed_mobile_default"

dockerfile_mobile_default_drift="$TMP_DIR/Dockerfile.mobile-default-drift"
cp "$ROOT_DIR/Dockerfile" "$dockerfile_mobile_default_drift"
perl -0pi -e 's/MOBILE_CONFIG_TAIRA_DEFAULT_VISIBLE=true/MOBILE_CONFIG_TAIRA_DEFAULT_VISIBLE=false/' "$dockerfile_mobile_default_drift"
expect_failure "dockerfile-mobile-default-drift" "$dockerfile_mobile_default_drift" "$ROOT_DIR/.dockerignore" "runtime image must pin the reviewed MOBILE_CONFIG_TAIRA_DEFAULT_VISIBLE tester default"

dockerfile_duplicate_mobile_override="$TMP_DIR/Dockerfile.duplicate-mobile-override"
cp "$ROOT_DIR/Dockerfile" "$dockerfile_duplicate_mobile_override"
printf '\nENV MOBILE_CONFIG_NEXUS_SENDS_AVAILABLE=true\n' >> "$dockerfile_duplicate_mobile_override"
expect_failure "dockerfile-duplicate-mobile-override" "$dockerfile_duplicate_mobile_override" "$ROOT_DIR/.dockerignore" "runtime image must assign MOBILE_CONFIG_NEXUS_SENDS_AVAILABLE exactly once"

env_example_missing_compose_capability="$TMP_DIR/.env.example.missing-compose-capability"
cp "$ROOT_DIR/.env.example" "$env_example_missing_compose_capability"
perl -0pi -e 's/^POLKASWAP_MOBILE_CONFIG_NEXUS_AVAILABLE=.*\n//m' "$env_example_missing_compose_capability"
expect_failure "env-example-missing-compose-capability" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" ".env.example must document the production Compose POLKASWAP_MOBILE_CONFIG_NEXUS_AVAILABLE tester default" "$ROOT_DIR/docker-compose.production.yml" "$ROOT_DIR/README.md" "$env_example_missing_compose_capability"

worker_mobile_capability="$TMP_DIR/docker-compose.worker-mobile-capability.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$worker_mobile_capability"
perl -0pi -e 's/(^  worker:\n.*?^      NODE_ENV: production\n)/$1      MOBILE_CONFIG_NEXUS_AVAILABLE: "true"\n/ms' "$worker_mobile_capability"
expect_failure "worker-mobile-capability" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "mobile capabilities must be routed only to the API service" "$worker_mobile_capability"

api_extra_port="$TMP_DIR/docker-compose.api-extra-port.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$api_extra_port"
perl -0pi -e 's/(      - "127\.0\.0\.1:4350:4350"\n)/$1      - "127.0.0.1:9999:9999"\n/' "$api_extra_port"
expect_failure "api-extra-port" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "resolved api must publish exactly TCP 4350 on host loopback" "$api_extra_port"

anchor_runtime_ports="$TMP_DIR/docker-compose.anchor-runtime-ports.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$anchor_runtime_ports"
perl -0pi -e 's/(x-runtime-security: &runtime-security\n)/$1  ports:\n    - "127.0.0.1:9999:9999"\n/' "$anchor_runtime_ports"
expect_failure "anchor-runtime-ports" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "resolved migrate must contain only its exact audited service keys" "$anchor_runtime_ports"

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

anchor_host_network="$TMP_DIR/docker-compose.anchor-host-network.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$anchor_host_network"
perl -0pi -e 's/(x-runtime-security: &runtime-security\n)/$1  network_mode: host\n/' "$anchor_host_network"
expect_failure "anchor-host-network" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "resolved migrate must not override host or network namespaces" "$anchor_host_network"

anchor_host_pid="$TMP_DIR/docker-compose.anchor-host-pid.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$anchor_host_pid"
perl -0pi -e 's/(x-runtime-security: &runtime-security\n)/$1  pid: host\n/' "$anchor_host_pid"
expect_failure "anchor-host-pid" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "resolved migrate must not override host or network namespaces" "$anchor_host_pid"

anchor_host_ipc="$TMP_DIR/docker-compose.anchor-host-ipc.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$anchor_host_ipc"
perl -0pi -e 's/(x-runtime-security: &runtime-security\n)/$1  ipc: host\n/' "$anchor_host_ipc"
expect_failure "anchor-host-ipc" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "resolved migrate must not override host or network namespaces" "$anchor_host_ipc"

anchor_host_uts="$TMP_DIR/docker-compose.anchor-host-uts.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$anchor_host_uts"
perl -0pi -e 's/(x-runtime-security: &runtime-security\n)/$1  uts: host\n/' "$anchor_host_uts"
expect_failure "anchor-host-uts" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "resolved migrate must not override host or network namespaces" "$anchor_host_uts"

anchor_host_userns="$TMP_DIR/docker-compose.anchor-host-userns.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$anchor_host_userns"
perl -0pi -e 's/(x-runtime-security: &runtime-security\n)/$1  userns_mode: host\n/' "$anchor_host_userns"
expect_failure "anchor-host-userns" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "resolved migrate must not override host or network namespaces" "$anchor_host_userns"

anchor_extra_hosts="$TMP_DIR/docker-compose.anchor-extra-hosts.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$anchor_extra_hosts"
perl -0pi -e 's/(x-runtime-security: &runtime-security\n)/$1  extra_hosts:\n    - "database=127.0.0.1"\n/' "$anchor_extra_hosts"
expect_failure "anchor-extra-hosts" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "resolved migrate must not override host or network namespaces" "$anchor_extra_hosts"

anchor_dns_override="$TMP_DIR/docker-compose.anchor-dns-override.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$anchor_dns_override"
perl -0pi -e 's/(x-runtime-security: &runtime-security\n)/$1  dns:\n    - "8.8.8.8"\n/' "$anchor_dns_override"
expect_failure "anchor-dns-override" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "resolved migrate must not override host or network namespaces" "$anchor_dns_override"

anchor_init_decoy="$TMP_DIR/docker-compose.anchor-init-decoy.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$anchor_init_decoy"
perl -0pi -e 's/  init: true/  init: false\n  x-decoy-init: true/' "$anchor_init_decoy"
expect_failure "anchor-init-decoy" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "resolved migrate security and image contract is not exact" "$anchor_init_decoy"

anchor_capability_decoy="$TMP_DIR/docker-compose.anchor-capability-decoy.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$anchor_capability_decoy"
perl -0pi -e 's/(  cap_drop:\n    - ALL\n)/$1    - NET_ADMIN\n/' "$anchor_capability_decoy"
expect_failure "anchor-capability-decoy" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "resolved migrate security and image contract is not exact" "$anchor_capability_decoy"

anchor_security_option_decoy="$TMP_DIR/docker-compose.anchor-security-option-decoy.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$anchor_security_option_decoy"
perl -0pi -e 's/(  security_opt:\n    - no-new-privileges:true\n)/$1    - seccomp=unconfined\n/' "$anchor_security_option_decoy"
expect_failure "anchor-security-option-decoy" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "resolved migrate security and image contract is not exact" "$anchor_security_option_decoy"

anchor_pids_decoy="$TMP_DIR/docker-compose.anchor-pids-decoy.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$anchor_pids_decoy"
perl -0pi -e 's/  pids_limit: 128/  pids_limit: 129\n  x-decoy-pids_limit: 128/' "$anchor_pids_decoy"
expect_failure "anchor-pids-decoy" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "resolved migrate security and image contract is not exact" "$anchor_pids_decoy"

anchor_tmpfs_decoy="$TMP_DIR/docker-compose.anchor-tmpfs-decoy.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$anchor_tmpfs_decoy"
perl -0pi -e 's#    - /tmp:rw,noexec,nosuid,nodev,size=16m#    - /tmp:rw,size=1g\n  x-decoy-tmpfs: "/tmp:rw,noexec,nosuid,nodev,size=16m"#' "$anchor_tmpfs_decoy"
expect_failure "anchor-tmpfs-decoy" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "resolved migrate security and image contract is not exact" "$anchor_tmpfs_decoy"

anchor_image_decoy="$TMP_DIR/docker-compose.anchor-image-decoy.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$anchor_image_decoy"
perl -0pi -e 's#(  image: ".*")#  image: "attacker.invalid/indexer:latest"\n  \# $1#' "$anchor_image_decoy"
expect_failure "anchor-image-decoy" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "resolved migrate security and image contract is not exact" "$anchor_image_decoy"

short_shutdown_grace="$TMP_DIR/docker-compose.short-shutdown-grace.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$short_shutdown_grace"
perl -0pi -e 's/stop_grace_period: 4m/stop_grace_period: 10s/' "$short_shutdown_grace"
expect_failure "short-shutdown-grace" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "must allow the runtime shutdown deadline to drain" "$short_shutdown_grace"

unbounded_logging="$TMP_DIR/docker-compose.unbounded-logging.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$unbounded_logging"
perl -0pi -e 's/^    max-size:.*$/    max-size: "0"/m' "$unbounded_logging"
expect_failure "unbounded-logging" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "must bound each log file" "$unbounded_logging"

migration_short_grace_override="$TMP_DIR/docker-compose.migration-short-grace-override.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$migration_short_grace_override"
perl -0pi -e 's/(^  migrate:\n    <<: \*runtime-security\n)/$1    stop_grace_period: 1s\n/m' "$migration_short_grace_override"
expect_failure "migration-short-grace-override" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "resolved migrate stop grace must be exactly four minutes" "$migration_short_grace_override"

migration_logging_override="$TMP_DIR/docker-compose.migration-logging-override.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$migration_logging_override"
perl -0pi -e 's/(^  migrate:\n    <<: \*runtime-security\n)/$1    logging:\n      driver: json-file\n/m' "$migration_logging_override"
expect_failure "migration-logging-override" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "resolved migrate logging must be local with exact 10m/5 bounds" "$migration_logging_override"

api_short_grace_override="$TMP_DIR/docker-compose.api-short-grace-override.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$api_short_grace_override"
perl -0pi -e 's/(^  api:\n    <<: \*runtime-security\n)/$1    stop_grace_period: 1s\n/m' "$api_short_grace_override"
expect_failure "api-short-grace-override" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "resolved api stop grace must be exactly four minutes" "$api_short_grace_override"

api_logging_override="$TMP_DIR/docker-compose.api-logging-override.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$api_logging_override"
perl -0pi -e 's/(^  api:\n    <<: \*runtime-security\n)/$1    logging:\n      driver: json-file\n/m' "$api_logging_override"
expect_failure "api-logging-override" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "resolved api logging must be local with exact 10m/5 bounds" "$api_logging_override"

worker_short_grace_override="$TMP_DIR/docker-compose.worker-short-grace-override.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$worker_short_grace_override"
perl -0pi -e 's/(^  worker:\n    <<: \*runtime-security\n)/$1    stop_grace_period: 1s\n/m' "$worker_short_grace_override"
expect_failure "worker-short-grace-override" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "resolved worker stop grace must be exactly four minutes" "$worker_short_grace_override"

worker_logging_override="$TMP_DIR/docker-compose.worker-logging-override.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$worker_logging_override"
perl -0pi -e 's/(^  worker:\n    <<: \*runtime-security\n)/$1    logging:\n      driver: json-file\n/m' "$worker_logging_override"
expect_failure "worker-logging-override" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "resolved worker logging must be local with exact 10m/5 bounds" "$worker_logging_override"

missing_migration_service="$TMP_DIR/docker-compose.missing-migration-service.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$missing_migration_service"
perl -0pi -e 's/^  migrate:\n.*?(?=^  api:\n)//ms' "$missing_migration_service"
expect_failure "missing-migration-service" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "must define a one-shot migration service" "$missing_migration_service"

restarting_migration="$TMP_DIR/docker-compose.restarting-migration.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$restarting_migration"
perl -0pi -e 's/restart: "no"/restart: on-failure/' "$restarting_migration"
expect_failure "restarting-migration" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "migration must be a restart-disabled one-shot service" "$restarting_migration"

migration_bypasses_credential_preflight="$TMP_DIR/docker-compose.migration-bypasses-credential-preflight.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$migration_bypasses_credential_preflight"
perl -0pi -e 's#dist/src/scripts/production-migrate\.js#dist/src/db/migrate.js#' "$migration_bypasses_credential_preflight"
expect_failure "migration-bypasses-credential-preflight" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "migration must run the credential-preflight schema migration command exactly once" "$migration_bypasses_credential_preflight"

migration_missing_runtime_credentials="$TMP_DIR/docker-compose.migration-missing-runtime-credentials.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$migration_missing_runtime_credentials"
perl -0pi -e 's/^      POLKASWAP_WORKER_DATABASE_URL:.*\n//m' "$migration_missing_runtime_credentials"
expect_failure "migration-missing-runtime-credentials" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "migration preflight must receive the exact API and worker runtime credentials" "$migration_missing_runtime_credentials"

optional_migration_owner="$TMP_DIR/docker-compose.optional-migration-owner.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$optional_migration_owner"
perl -0pi -e 's/\$\{POLKASWAP_MIGRATION_OWNER_DATABASE_URL:\?/\${POLKASWAP_MIGRATION_OWNER_DATABASE_URL-/' "$optional_migration_owner"
expect_failure "optional-migration-owner" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "migration must require its separate migration-owner database URL" "$optional_migration_owner"

migration_reuses_api_role="$TMP_DIR/docker-compose.migration-reuses-api-role.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$migration_reuses_api_role"
perl -0pi -e 's/POLKASWAP_MIGRATION_OWNER_DATABASE_URL/POLKASWAP_API_DATABASE_URL/' "$migration_reuses_api_role"
expect_failure "migration-reuses-api-role" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "migration must require its separate migration-owner database URL" "$migration_reuses_api_role"

api_reuses_owner_role="$TMP_DIR/docker-compose.api-reuses-owner-role.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$api_reuses_owner_role"
perl -0pi -e 's/(^  api:\n.*?)(POLKASWAP_API_DATABASE_URL)/${1}POLKASWAP_MIGRATION_OWNER_DATABASE_URL/ms' "$api_reuses_owner_role"
expect_failure "api-reuses-owner-role" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "api must require only its separate runtime database URL" "$api_reuses_owner_role"

worker_reuses_api_role="$TMP_DIR/docker-compose.worker-reuses-api-role.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$worker_reuses_api_role"
perl -0pi -e 's/(^  worker:\n.*?)(POLKASWAP_WORKER_DATABASE_URL)/${1}POLKASWAP_API_DATABASE_URL/ms' "$worker_reuses_api_role"
expect_failure "worker-reuses-api-role" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "worker must require only its separate runtime database URL" "$worker_reuses_api_role"

api_shells_through_migration="$TMP_DIR/docker-compose.api-shells-through-migration.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$api_shells_through_migration"
perl -0pi -e 's#    command: \["node", "dist/src/index\.js"\]#    command: ["sh", "-c", "node dist/src/db/migrate.js && node dist/src/index.js"]#' "$api_shells_through_migration"
expect_failure "api-shells-through-migration" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "api must run only the exact compiled API command" "$api_shells_through_migration"

worker_shells_through_migration="$TMP_DIR/docker-compose.worker-shells-through-migration.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$worker_shells_through_migration"
perl -0pi -e 's#    command: \["node", "dist/src/worker/index\.js"\]#    command: ["sh", "-c", "node dist/src/db/migrate.js && node dist/src/worker/index.js"]#' "$worker_shells_through_migration"
expect_failure "worker-shells-through-migration" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "worker must run only the exact compiled worker command" "$worker_shells_through_migration"

api_migration_entrypoint="$TMP_DIR/docker-compose.api-migration-entrypoint.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$api_migration_entrypoint"
perl -0pi -e 's#(^  api:\n    <<: \*runtime-security\n)#$1    entrypoint: ["node", "dist/src/db/migrate.js"]\n#m' "$api_migration_entrypoint"
expect_failure "api-migration-entrypoint" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "api must not override its entrypoint or invoke any migration executable" "$api_migration_entrypoint"

worker_migration_entrypoint="$TMP_DIR/docker-compose.worker-migration-entrypoint.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$worker_migration_entrypoint"
perl -0pi -e 's#(^  worker:\n    <<: \*runtime-security\n)#$1    entrypoint: ["node", "dist/src/db/migrate.js"]\n#m' "$worker_migration_entrypoint"
expect_failure "worker-migration-entrypoint" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "worker must not override its entrypoint or invoke any migration executable" "$worker_migration_entrypoint"

api_migration_healthcheck="$TMP_DIR/docker-compose.api-migration-healthcheck.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$api_migration_healthcheck"
perl -0pi -e 's#(^  api:\n    <<: \*runtime-security\n)#$1    healthcheck:\n      test: ["CMD", "node", "dist/src/db/migrate.js"]\n#m' "$api_migration_healthcheck"
expect_failure "api-migration-healthcheck" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "api must not override its entrypoint or invoke any migration executable" "$api_migration_healthcheck"

worker_migration_post_start="$TMP_DIR/docker-compose.worker-migration-post-start.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$worker_migration_post_start"
perl -0pi -e 's#(^  worker:\n    <<: \*runtime-security\n)#$1    post_start:\n      - command: ["node", "dist/src/db/migrate.js"]\n#m' "$worker_migration_post_start"
expect_failure "worker-migration-post-start" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "worker must not override its entrypoint or invoke any migration executable" "$worker_migration_post_start"

api_runtime_volume_override="$TMP_DIR/docker-compose.api-runtime-volume-override.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$api_runtime_volume_override"
perl -0pi -e 's#(^  api:\n    <<: \*runtime-security\n)#$1    volumes:\n      - ./dist:/app/dist:ro\n#m' "$api_runtime_volume_override"
expect_failure "api-runtime-volume-override" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "api must contain only its exact audited top-level service keys" "$api_runtime_volume_override"

api_runs_migration="$TMP_DIR/docker-compose.api-runs-migration.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$api_runs_migration"
perl -0pi -e 's/^      SKIP_POSTGRES_MIGRATION: "true"\n//m' "$api_runs_migration"
expect_failure "api-runs-migration" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "api must disable in-process PostgreSQL migration" "$api_runs_migration"

worker_runs_migration="$TMP_DIR/docker-compose.worker-runs-migration.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$worker_runs_migration"
perl -0pi -e 's/(^  worker:\n.*?)SKIP_POSTGRES_MIGRATION: "true"/${1}SKIP_POSTGRES_MIGRATION: "false"/ms' "$worker_runs_migration"
expect_failure "worker-runs-migration" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "worker must disable in-process PostgreSQL migration" "$worker_runs_migration"

api_weak_migration_dependency="$TMP_DIR/docker-compose.api-weak-migration-dependency.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$api_weak_migration_dependency"
perl -0pi -e 's/condition: service_completed_successfully/condition: service_started/' "$api_weak_migration_dependency"
expect_failure "api-weak-migration-dependency" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "api must depend exactly on successful completion of the one-shot migration" "$api_weak_migration_dependency"

worker_optional_migration_dependency="$TMP_DIR/docker-compose.worker-optional-migration-dependency.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$worker_optional_migration_dependency"
perl -0pi -e 's/(^  worker:\n.*?condition: service_completed_successfully)/$1\n        required: false/ms' "$worker_optional_migration_dependency"
expect_failure "worker-optional-migration-dependency" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "worker must depend exactly on successful completion of the one-shot migration" "$worker_optional_migration_dependency"

worker_without_hardening="$TMP_DIR/docker-compose.worker-without-hardening.yml"
cp "$ROOT_DIR/docker-compose.production.yml" "$worker_without_hardening"
perl -0pi -e 's/(  worker:\n)    <<: \*runtime-security\n/$1/' "$worker_without_hardening"
expect_failure "worker-without-hardening" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "must apply the hardened runtime anchor to migration, API, and worker" "$worker_without_hardening"

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
perl -0pi -e 's#^node_modules/?\n##m' "$unsafe_context"
expect_failure "unsafe-context" "$ROOT_DIR/Dockerfile" "$unsafe_context" ".dockerignore must exclude node_modules"

credential_leaking_instructions="$TMP_DIR/README.credential-leaking.md"
cp "$ROOT_DIR/README.md" "$credential_leaking_instructions"
perl -0pi -e 's/docker compose -f docker-compose\.production\.yml config --quiet/docker compose -f docker-compose.production.yml config/' "$credential_leaking_instructions"
expect_failure "credential-leaking-instructions" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "Production instructions must validate Compose without printing interpolated credentials" "$ROOT_DIR/docker-compose.production.yml" "$credential_leaking_instructions"

insecure_database_instructions="$TMP_DIR/README.insecure-database.md"
cp "$ROOT_DIR/README.md" "$insecure_database_instructions"
perl -0pi -e 's/sslmode=verify-full/sslmode=require/g' "$insecure_database_instructions"
expect_failure "insecure-database-instructions" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/.dockerignore" "Production instructions must require hostname-verified PostgreSQL TLS" "$ROOT_DIR/docker-compose.production.yml" "$insecure_database_instructions"

secure_owner_url='postgresql://manifest_migration_owner:owner-test-only@database.invalid/polkaswap?sslmode=verify-full'
secure_api_url='postgresql://manifest_api:api-test-only@database.invalid/polkaswap?sslmode=verify-full'
secure_worker_url='postgresql://manifest_worker:worker-test-only@database.invalid/polkaswap?sslmode=verify-full'
expect_resolved_failure \
  "resolved-plaintext-owner-url" \
  "resolved PostgreSQL URLs must require verified TLS without unaudited controls" \
  'postgresql://manifest_migration_owner:owner-test-only@database.invalid/polkaswap' \
  "$secure_api_url" \
  "$secure_worker_url"
expect_resolved_failure \
  "resolved-downgrade-api-url" \
  "resolved PostgreSQL URLs must require verified TLS without unaudited controls" \
  "$secure_owner_url" \
  'postgresql://manifest_api:api-test-only@database.invalid/polkaswap?sslmode=prefer' \
  "$secure_worker_url"
expect_resolved_failure \
  "resolved-timeout-override-worker-url" \
  "resolved PostgreSQL URLs must require verified TLS without unaudited controls" \
  "$secure_owner_url" \
  "$secure_api_url" \
  'postgresql://manifest_worker:worker-test-only@database.invalid/polkaswap?sslmode=verify-full&query_timeout=0'

echo "[deployment-manifest-test] all assertions passed"
