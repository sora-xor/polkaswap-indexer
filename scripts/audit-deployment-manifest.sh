#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DOCKERFILE="${1:-$ROOT_DIR/Dockerfile}"
DOCKERIGNORE="${2:-$ROOT_DIR/.dockerignore}"
PRODUCTION_COMPOSE="${3:-$ROOT_DIR/docker-compose.production.yml}"
README_FILE="${4:-$ROOT_DIR/README.md}"
FAILURES=0
NODE_IMAGE='node:24-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5'

fail() {
  echo "[deployment-manifest][error] $*" >&2
  FAILURES=1
}

require_literal() {
  local file="$1"
  local literal="$2"
  local label="$3"
  if ! grep -Fq -- "$literal" "$file"; then
    fail "$label"
  fi
}

service_section() {
  local service="$1"
  awk -v service="$service" '
    $0 == "  " service ":" { in_service = 1 }
    in_service && /^  [A-Za-z0-9_-]+:$/ && $0 != "  " service ":" { exit }
    in_service { print }
  ' "$PRODUCTION_COMPOSE"
}

require_exact_migration_dependency() {
  local service="$1"
  local section="$2"
  local dependency_block
  local expected
  dependency_block="$(awk '
    /^    depends_on:$/ { in_dependencies = 1 }
    in_dependencies && /^    [A-Za-z0-9_-]+:$/ && $0 != "    depends_on:" { exit }
    in_dependencies { print }
  ' <<<"$section")"
  expected=$'    depends_on:\n      migrate:\n        condition: service_completed_successfully'
  if [[ "$dependency_block" != "$expected" ]]; then
    fail "$service must depend exactly on successful completion of the one-shot migration"
  fi
}

[[ -f "$DOCKERFILE" ]] || {
  echo "[deployment-manifest][error] Dockerfile missing: $DOCKERFILE" >&2
  exit 1
}
[[ -f "$DOCKERIGNORE" ]] || {
  echo "[deployment-manifest][error] .dockerignore missing: $DOCKERIGNORE" >&2
  exit 1
}
[[ -f "$PRODUCTION_COMPOSE" ]] || {
  echo "[deployment-manifest][error] Production Compose missing: $PRODUCTION_COMPOSE" >&2
  exit 1
}
[[ -f "$README_FILE" ]] || {
  echo "[deployment-manifest][error] README missing: $README_FILE" >&2
  exit 1
}

if grep -Eq '\|\|[[:space:]]*yarn[[:space:]]+install' "$DOCKERFILE"; then
  fail "Dockerfile must not fall back to a mutable yarn install"
fi

require_literal "$DOCKERFILE" "FROM $NODE_IMAGE AS dependencies" "Dockerfile must pin the dependency-stage Node image by digest"
require_literal "$DOCKERFILE" 'RUN corepack enable && yarn install --immutable' "dependency installation must be immutable and fail closed"
require_literal "$DOCKERFILE" 'FROM dependencies AS production-dependencies' "Dockerfile must derive a production dependency stage from the immutable install"
require_literal "$DOCKERFILE" 'RUN yarn workspaces focus --all --production' "production dependency stage must exclude devDependencies"
require_literal "$DOCKERFILE" "FROM $NODE_IMAGE AS runtime" "Dockerfile must pin the runtime-stage Node image by digest"
require_literal "$DOCKERFILE" 'COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules' "runtime must copy only production-focused node_modules"
require_literal "$DOCKERFILE" 'COPY --from=build --chown=node:node /app/dist ./dist' "runtime must copy compiled output from the build stage"
require_literal "$DOCKERFILE" 'USER node' "runtime must use the non-root node user"
require_literal "$DOCKERFILE" 'GRAPHQL_HTTP_MAX_BODY_BYTES=65536' "runtime image must default to a bounded GraphQL HTTP body"
require_literal "$DOCKERFILE" 'RATE_LIMIT_MAX_KEYS=20000' "runtime image must bound rate-limit identities"
require_literal "$DOCKERFILE" 'RATE_LIMIT_GLOBAL_MAX=50000' "runtime image must enable the global rate bucket"
require_literal "$DOCKERFILE" 'GRAPHQL_ALLOW_INTROSPECTION=false' "runtime image must disable production introspection"
require_literal "$DOCKERFILE" 'GRAPHQL_WS_MAX_CONNECTIONS=512' "runtime image must bound WebSocket connections"
require_literal "$DOCKERFILE" 'GRAPHQL_WS_MAX_OPERATIONS_PER_CONNECTION=32' "runtime image must bound WebSocket operations"
require_literal "$DOCKERFILE" 'POLKASWAP_INDEXER_SMOKE_TIMEOUT_MS=4000' "runtime healthcheck must use a deadline shorter than its container timeout"
require_literal "$DOCKERFILE" 'node dist/src/scripts/production-smoke.js' "runtime healthcheck must reuse the complete PI identity smoke contract"
require_literal "$DOCKERFILE" 'http://127.0.0.1:${PORT:-4350}${GRAPHQL_PATH:-/graphql}' "runtime healthcheck must probe the loopback GraphQL endpoint"

require_literal "$PRODUCTION_COMPOSE" 'image: "${POLKASWAP_INDEXER_IMAGE_REPOSITORY:?' "Production Compose must require an external image repository"
require_literal "$PRODUCTION_COMPOSE" '@sha256:${POLKASWAP_INDEXER_IMAGE_DIGEST:?' "Production Compose must require an immutable image digest"
require_literal "$PRODUCTION_COMPOSE" '"127.0.0.1:4350:4350"' "Production Compose must publish GraphQL only on host loopback"
require_literal "$PRODUCTION_COMPOSE" 'read_only: true' "Production Compose must use a read-only root filesystem"
require_literal "$PRODUCTION_COMPOSE" 'cap_drop:' "Production Compose must define dropped capabilities"
require_literal "$PRODUCTION_COMPOSE" '    - ALL' "Production Compose must drop all Linux capabilities"
require_literal "$PRODUCTION_COMPOSE" 'no-new-privileges:true' "Production Compose must prevent privilege escalation"
require_literal "$PRODUCTION_COMPOSE" 'pids_limit: 128' "Production Compose must bound process IDs"
require_literal "$PRODUCTION_COMPOSE" '/tmp:rw,noexec,nosuid,nodev,size=16m' "Production Compose must use a bounded no-exec tmpfs"
require_literal "$PRODUCTION_COMPOSE" 'stop_grace_period: 4m' "Production Compose must allow the runtime shutdown deadline to drain"
require_literal "$PRODUCTION_COMPOSE" 'logging: *bounded-logging' "Production Compose must apply bounded logging to every service"
require_literal "$PRODUCTION_COMPOSE" 'driver: local' "Production Compose must use the bounded local logging driver"
require_literal "$PRODUCTION_COMPOSE" 'max-size: "10m"' "Production Compose must bound each log file"
require_literal "$PRODUCTION_COMPOSE" 'max-file: "5"' "Production Compose must bound retained log files"
require_literal "$PRODUCTION_COMPOSE" 'SORA_WS_ENDPOINT: "${POLKASWAP_SORA_WS_ENDPOINT:?' "Production Compose must require an external SORA endpoint"
require_literal "$PRODUCTION_COMPOSE" 'SORA_ARCHIVE_WS_ENDPOINT: "${POLKASWAP_SORA_ARCHIVE_WS_ENDPOINT:?' "Production Compose must require an independently reviewed SORA archive endpoint"
require_literal "$PRODUCTION_COMPOSE" 'CHAIN_START_BLOCK: "${POLKASWAP_CHAIN_START_BLOCK:?' "Production Compose must require an explicit reviewed chain start block"
require_literal "$PRODUCTION_COMPOSE" 'GRAPHQL_HTTP_MAX_BODY_BYTES: "65536"' "Production Compose must configure the GraphQL HTTP body limit"
require_literal "$PRODUCTION_COMPOSE" 'RATE_LIMIT_MAX_KEYS: "20000"' "Production Compose must bound rate-limit identities"
require_literal "$PRODUCTION_COMPOSE" 'RATE_LIMIT_MAX: "50000"' "Production Compose must avoid treating the loopback proxy as one public client"
require_literal "$PRODUCTION_COMPOSE" 'RATE_LIMIT_GLOBAL_MAX: "50000"' "Production Compose must configure a global rate bucket"
require_literal "$PRODUCTION_COMPOSE" 'GRAPHQL_ALLOW_INTROSPECTION: "false"' "Production Compose must disable production introspection"
require_literal "$PRODUCTION_COMPOSE" 'GRAPHQL_WS_MAX_CONNECTIONS: "512"' "Production Compose must bound WebSocket connections"
require_literal "$PRODUCTION_COMPOSE" 'GRAPHQL_WS_MAX_CONNECTIONS_PER_CLIENT: "512"' "Production Compose must avoid treating the loopback proxy as one WebSocket client"
require_literal "$PRODUCTION_COMPOSE" 'GRAPHQL_WS_MAX_OPERATIONS_PER_CONNECTION: "32"' "Production Compose must bound WebSocket operations"

if [[ "$(grep -Fc '<<: *runtime-security' "$PRODUCTION_COMPOSE")" -ne 3 ]]; then
  fail "Production Compose must apply the hardened runtime anchor to migration, API, and worker"
fi

for service in migrate api worker; do
  if [[ "$(grep -Fxc "  $service:" "$PRODUCTION_COMPOSE")" -ne 1 ]]; then
    fail "Production Compose must define the $service service exactly once"
  fi
done

migration_service="$(service_section migrate)"
api_service="$(service_section api)"
worker_service="$(service_section worker)"

if [[ -z "$migration_service" ]]; then
  fail "Production Compose must define a one-shot migration service"
else
  if [[ "$(grep -Fxc '    restart: "no"' <<<"$migration_service")" -ne 1 ]]; then
    fail "migration must be a restart-disabled one-shot service"
  fi
  if [[ "$(grep -Fxc '    command: ["node", "dist/src/db/migrate.js"]' <<<"$migration_service")" -ne 1 ]]; then
    fail "migration must run the compiled schema migration command exactly once"
  fi
  if [[ "$(grep -Fxc '      disable: true' <<<"$migration_service")" -ne 1 ]]; then
    fail "migration must disable the inherited long-running service healthcheck"
  fi
  if [[ "$(grep -Fxc '      DATABASE_URL: "${POLKASWAP_MIGRATION_OWNER_DATABASE_URL:?Set the separately managed PostgreSQL migration-owner URL}"' <<<"$migration_service")" -ne 1 ]]; then
    fail "migration must require its separate migration-owner database URL"
  fi
  if [[ "$(grep -Ec '^      DATABASE_URL:' <<<"$migration_service")" -ne 1 ]]; then
    fail "migration must receive exactly one database URL"
  fi
  if grep -Fq 'SKIP_POSTGRES_MIGRATION' <<<"$migration_service"; then
    fail "migration must not disable its own schema migration"
  fi
  if grep -Fq 'ports:' <<<"$migration_service"; then
    fail "migration must not publish any port"
  fi
fi

if [[ -z "$api_service" ]]; then
  fail "Production Compose must define a standalone API service"
else
  require_exact_migration_dependency "api" "$api_service"
  if [[ "$(grep -Fxc '      DATABASE_URL: "${POLKASWAP_API_DATABASE_URL:?Set the separately managed PostgreSQL API runtime URL}"' <<<"$api_service")" -ne 1 ]] ||
     [[ "$(grep -Ec '^      DATABASE_URL:' <<<"$api_service")" -ne 1 ]]; then
    fail "api must require only its separate runtime database URL"
  fi
  if [[ "$(grep -Fxc '      SKIP_POSTGRES_MIGRATION: "true"' <<<"$api_service")" -ne 1 ]]; then
    fail "api must disable in-process PostgreSQL migration"
  fi
fi

if [[ -z "$worker_service" ]]; then
  fail "Production Compose must define a standalone worker service"
else
  require_exact_migration_dependency "worker" "$worker_service"
  if [[ "$(grep -Fxc '      DATABASE_URL: "${POLKASWAP_WORKER_DATABASE_URL:?Set the separately managed PostgreSQL worker runtime URL}"' <<<"$worker_service")" -ne 1 ]] ||
     [[ "$(grep -Ec '^      DATABASE_URL:' <<<"$worker_service")" -ne 1 ]]; then
    fail "worker must require only its separate runtime database URL"
  fi
  if [[ "$(grep -Fxc '      SKIP_POSTGRES_MIGRATION: "true"' <<<"$worker_service")" -ne 1 ]]; then
    fail "worker must disable in-process PostgreSQL migration"
  fi
  if [[ "$(grep -Fxc '    healthcheck:' <<<"$worker_service")" -ne 1 ]]; then
    fail "worker must override the inherited API healthcheck"
  fi
  if [[ "$(grep -Fxc '      test: ["CMD", "node", "dist/src/scripts/worker-health.js"]' <<<"$worker_service")" -ne 1 ]]; then
    fail "worker healthcheck must use the compiled database-only worker probe"
  fi
  if grep -Eq 'production-smoke|127\.0\.0\.1|https?://' <<<"$worker_service"; then
    fail "worker healthcheck must not depend on the API or any HTTP endpoint"
  fi
  if [[ "$(grep -Fxc '      timeout: 5s' <<<"$worker_service")" -ne 1 ]]; then
    fail "worker healthcheck must retain the five-second container timeout"
  fi
  if [[ "$(grep -Fxc '      PI_WORKER_HEALTH_TIMEOUT_MS: "4000"' <<<"$worker_service")" -ne 1 ]]; then
    fail "worker database probe must enforce a four-second total deadline"
  fi
  if [[ "$(grep -Fxc '      SORA_ARCHIVE_WS_ENDPOINT: "${POLKASWAP_SORA_ARCHIVE_WS_ENDPOINT:?Set an independently reviewed SORA mainnet archive WSS endpoint}"' <<<"$worker_service")" -ne 1 ]]; then
    fail "worker must require the independently reviewed SORA archive endpoint"
  fi
  if [[ "$(grep -Fxc '      CHAIN_START_BLOCK: "${POLKASWAP_CHAIN_START_BLOCK:?Set the reviewed first SORA block to index}"' <<<"$worker_service")" -ne 1 ]]; then
    fail "worker must require an explicit reviewed chain start block"
  fi
fi

if grep -Fq 'POLKASWAP_DATABASE_URL' "$PRODUCTION_COMPOSE"; then
  fail "Production Compose must not reuse one shared database URL across privileged and runtime services"
fi
for database_input in \
  POLKASWAP_MIGRATION_OWNER_DATABASE_URL \
  POLKASWAP_API_DATABASE_URL \
  POLKASWAP_WORKER_DATABASE_URL; do
  if [[ "$(grep -Fc "$database_input" "$PRODUCTION_COMPOSE")" -ne 1 ]]; then
    fail "Production Compose must consume $database_input exactly once"
  fi
done

runtime_stage="$(awk -v image="$NODE_IMAGE" '$0 == "FROM " image " AS runtime" { in_runtime = 1 } in_runtime { print }' "$DOCKERFILE")"
if [[ -z "$runtime_stage" ]]; then
  fail "runtime stage could not be inspected"
elif grep -Eq '^RUN .*yarn (install|workspaces focus)' <<<"$runtime_stage"; then
  fail "runtime stage must not install or mutate dependencies"
fi

for ignored in node_modules dist build coverage .env data '*.rocksdb'; do
  require_literal "$DOCKERIGNORE" "$ignored" ".dockerignore must exclude $ignored"
done

require_literal "$README_FILE" 'docker compose -f docker-compose.production.yml config --quiet' "Production instructions must validate Compose without printing interpolated credentials"
require_literal "$README_FILE" 'docker compose -f docker-compose.production.yml config --no-interpolate' "Production instructions must provide a non-interpolated manifest review command"
if grep -Eq 'docker compose -f docker-compose\.production\.yml config[[:space:]]*$' "$README_FILE"; then
  fail "Production instructions must not print interpolated database credentials"
fi

if [[ "$FAILURES" -ne 0 ]]; then
  exit 1
fi

echo "[deployment-manifest] Docker production deployment contract passed."
