#!/usr/bin/env bash
set -euo pipefail

for required in docker openssl; do
  command -v "$required" >/dev/null 2>&1 || {
    echo "[production-database-test][error] $required is required" >&2
    exit 1
  }
done

SUFFIX="$$"
NETWORK="polkaswap-tls-evidence-$SUFFIX"
POSTGRES_CONTAINER="polkaswap-tls-postgres-$SUFFIX"
API_CONTAINER="polkaswap-tls-api-$SUFFIX"
CERTIFICATE_VOLUME="polkaswap-tls-certs-$SUFFIX"
CERTIFICATE_DIRECTORY="$(mktemp -d "$PWD/.polkaswap-certificate-test.XXXXXX")"
CHECKPOINT="certificate-generation"
POSTGRES_IMAGE='postgres@sha256:92620daddcd947f8d5ab5ba66e848702fe443d87fed30c4cea8e389fd78dfc55'
APPLICATION_IMAGE="${POLKASWAP_TEST_IMAGE:-polkaswap-indexer:migration-preflight-final}"
OWNER_URL='postgresql://pi_migration_owner:owner-test-password@database:5432/polkaswap?sslmode=verify-full'
API_URL='postgresql://pi_api:api-test-password@database:5432/polkaswap?sslmode=verify-full'
WORKER_URL='postgresql://pi_worker:worker-test-password@database:5432/polkaswap?sslmode=verify-full'

cleanup() {
  local exit_code=$?
  docker container rm --force "$API_CONTAINER" "$POSTGRES_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  docker volume rm "$CERTIFICATE_VOLUME" >/dev/null 2>&1 || true
  find "$CERTIFICATE_DIRECTORY" -type f -delete >/dev/null 2>&1 || true
  rmdir "$CERTIFICATE_DIRECTORY" >/dev/null 2>&1 || true
  if [[ "$exit_code" -ne 0 ]]; then
    echo "[production-database-test][error] failed at $CHECKPOINT" >&2
  fi
  return "$exit_code"
}
trap cleanup EXIT

assert_credential_safe_log() {
  local output="$1"
  for forbidden in \
    owner-test-password \
    api-test-password \
    worker-test-password \
    '@database'; do
    if [[ "$output" == *"$forbidden"* ]]; then
      echo "[production-database-test][error] credential component reached logs" >&2
      exit 1
    fi
  done
}

run_migration() {
  local owner_url="$1"
  local api_url="$2"
  local worker_url="$3"
  docker run --rm \
    --network "$NETWORK" \
    --volume "$CERTIFICATE_VOLUME:/certs:ro" \
    --env NODE_EXTRA_CA_CERTS=/certs/ca.crt \
    --env NODE_ENV=production \
    --env STORAGE_ENGINE=postgres \
    --env DATABASE_URL="$owner_url" \
    --env POLKASWAP_API_DATABASE_URL="$api_url" \
    --env POLKASWAP_WORKER_DATABASE_URL="$worker_url" \
    "$APPLICATION_IMAGE" \
    node dist/src/scripts/production-migrate.js 2>&1
}

openssl req \
  -x509 \
  -newkey rsa:2048 \
  -sha256 \
  -nodes \
  -days 1 \
  -subj '/CN=Polkaswap Test CA' \
  -keyout "$CERTIFICATE_DIRECTORY/ca.key" \
  -out "$CERTIFICATE_DIRECTORY/ca.crt" >/dev/null 2>&1
openssl req \
  -newkey rsa:2048 \
  -sha256 \
  -nodes \
  -subj '/CN=database' \
  -addext 'subjectAltName=DNS:database' \
  -keyout "$CERTIFICATE_DIRECTORY/server.key" \
  -out "$CERTIFICATE_DIRECTORY/server.csr" >/dev/null 2>&1
openssl x509 \
  -req \
  -sha256 \
  -days 1 \
  -in "$CERTIFICATE_DIRECTORY/server.csr" \
  -CA "$CERTIFICATE_DIRECTORY/ca.crt" \
  -CAkey "$CERTIFICATE_DIRECTORY/ca.key" \
  -CAcreateserial \
  -copy_extensions copy \
  -out "$CERTIFICATE_DIRECTORY/server.crt" >/dev/null 2>&1

docker volume create "$CERTIFICATE_VOLUME" >/dev/null
docker run --rm \
  --entrypoint bash \
  --volume "$CERTIFICATE_VOLUME:/dest" \
  --volume "$CERTIFICATE_DIRECTORY:/src:ro" \
  "$POSTGRES_IMAGE" \
  -c 'cp /src/ca.crt /src/server.crt /src/server.key /dest/; chown postgres:postgres /dest/server.crt /dest/server.key; chmod 600 /dest/server.key; chmod 644 /dest/ca.crt /dest/server.crt' \
  >/dev/null
docker network create "$NETWORK" >/dev/null

CHECKPOINT="TLS PostgreSQL startup"
docker run -d \
  --name "$POSTGRES_CONTAINER" \
  --network "$NETWORK" \
  --network-alias database \
  --network-alias wrong-database \
  --volume "$CERTIFICATE_VOLUME:/certs:ro" \
  --env POSTGRES_PASSWORD=postgres-test-password \
  --env POSTGRES_DB=polkaswap \
  "$POSTGRES_IMAGE" \
  -c ssl=on \
  -c ssl_cert_file=/certs/server.crt \
  -c ssl_key_file=/certs/server.key >/dev/null
for attempt in {1..45}; do
  if docker exec "$POSTGRES_CONTAINER" pg_isready -U postgres -d polkaswap >/dev/null 2>&1; then
    break
  fi
  [[ "$attempt" -lt 45 ]]
  sleep 1
done

CHECKPOINT="role provisioning"
docker exec \
  --env PGPASSWORD=postgres-test-password \
  "$POSTGRES_CONTAINER" \
  psql -v ON_ERROR_STOP=1 -U postgres -d polkaswap \
  -c "create role pi_migration_owner login password 'owner-test-password';" \
  -c "create role pi_api login password 'api-test-password';" \
  -c "create role pi_worker login password 'worker-test-password';" \
  -c 'alter database polkaswap owner to pi_migration_owner;' \
  -c 'revoke connect on database polkaswap from public;' \
  -c 'grant connect on database polkaswap to pi_migration_owner, pi_api, pi_worker;' \
  -c 'revoke create on schema public from public;' \
  -c 'grant usage on schema public to pi_api, pi_worker;' >/dev/null

CHECKPOINT="fresh migration"
MIGRATION_LOGS="$(run_migration "$OWNER_URL" "$API_URL" "$WORKER_URL")"
[[ "$MIGRATION_LOGS" == *'Verified distinct least-privilege production PostgreSQL sessions before schema migration'* ]]
[[ "$MIGRATION_LOGS" == *'Verified production PostgreSQL runtime table privileges after schema migration'* ]]
assert_credential_safe_log "$MIGRATION_LOGS"

CHECKPOINT="exact ACL matrix"
ACL_MATRIX="$(
  docker exec \
    --env PGPASSWORD=postgres-test-password \
    "$POSTGRES_CONTAINER" \
    psql -U postgres -d polkaswap -Atc \
    "select '' ||
       has_table_privilege('pi_api','public.indexer_documents','SELECT')::int ||
       has_table_privilege('pi_api','public.indexer_documents','INSERT')::int ||
       has_table_privilege('pi_api','public.indexer_documents','UPDATE')::int ||
       has_table_privilege('pi_api','public.indexer_documents','DELETE')::int ||
       has_table_privilege('pi_api','public.indexer_documents','TRUNCATE')::int ||
       has_table_privilege('pi_api','public.indexer_documents','REFERENCES')::int ||
       has_table_privilege('pi_api','public.indexer_documents','TRIGGER')::int || '|' ||
       has_table_privilege('pi_api','public.polkaswap_indexer_worker_lease_fence','SELECT')::int ||
       has_table_privilege('pi_api','public.polkaswap_indexer_worker_lease_fence','INSERT')::int ||
       has_table_privilege('pi_api','public.polkaswap_indexer_worker_lease_fence','UPDATE')::int ||
       has_table_privilege('pi_api','public.polkaswap_indexer_worker_lease_fence','DELETE')::int ||
       has_table_privilege('pi_api','public.polkaswap_indexer_worker_lease_fence','TRUNCATE')::int ||
       has_table_privilege('pi_api','public.polkaswap_indexer_worker_lease_fence','REFERENCES')::int ||
       has_table_privilege('pi_api','public.polkaswap_indexer_worker_lease_fence','TRIGGER')::int || '|' ||
       has_table_privilege('pi_worker','public.indexer_documents','SELECT')::int ||
       has_table_privilege('pi_worker','public.indexer_documents','INSERT')::int ||
       has_table_privilege('pi_worker','public.indexer_documents','UPDATE')::int ||
       has_table_privilege('pi_worker','public.indexer_documents','DELETE')::int ||
       has_table_privilege('pi_worker','public.indexer_documents','TRUNCATE')::int ||
       has_table_privilege('pi_worker','public.indexer_documents','REFERENCES')::int ||
       has_table_privilege('pi_worker','public.indexer_documents','TRIGGER')::int || '|' ||
       has_table_privilege('pi_worker','public.polkaswap_indexer_worker_lease_fence','SELECT')::int ||
       has_table_privilege('pi_worker','public.polkaswap_indexer_worker_lease_fence','INSERT')::int ||
       has_table_privilege('pi_worker','public.polkaswap_indexer_worker_lease_fence','UPDATE')::int ||
       has_table_privilege('pi_worker','public.polkaswap_indexer_worker_lease_fence','DELETE')::int ||
       has_table_privilege('pi_worker','public.polkaswap_indexer_worker_lease_fence','TRUNCATE')::int ||
       has_table_privilege('pi_worker','public.polkaswap_indexer_worker_lease_fence','REFERENCES')::int ||
       has_table_privilege('pi_worker','public.polkaswap_indexer_worker_lease_fence','TRIGGER')::int;"
)"
[[ "$ACL_MATRIX" == '1000000|0000000|1111000|1110000' ]]

CHECKPOINT="runtime API"
docker run -d \
  --name "$API_CONTAINER" \
  --network "$NETWORK" \
  --volume "$CERTIFICATE_VOLUME:/certs:ro" \
  --read-only \
  --user node \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 128 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  --init \
  --stop-timeout 240 \
  --log-driver local \
  --log-opt max-size=10m \
  --log-opt max-file=5 \
  --env NODE_EXTRA_CA_CERTS=/certs/ca.crt \
  --env NODE_ENV=production \
  --env STORAGE_ENGINE=postgres \
  --env DATABASE_URL="$API_URL" \
  --env SKIP_POSTGRES_MIGRATION=true \
  "$APPLICATION_IMAGE" \
  node dist/src/index.js >/dev/null
for attempt in {1..20}; do
  API_STATE="$(docker inspect --format '{{.State.Status}}/{{.RestartCount}}' "$API_CONTAINER")"
  if [[ "$API_STATE" == 'running/0' ]]; then
    set +e
    API_PROBE="$(
      docker exec "$API_CONTAINER" node --input-type=module -e \
        "const response=await fetch('http://127.0.0.1:4350/graphql',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:'query { _health { repositoryReady service readOnly } }'})});const payload=await response.json();const health=payload.data?._health;if(!response.ok||health?.repositoryReady!==true||health?.service!=='polkaswap-indexer'||health?.readOnly!==true)process.exit(1);process.stdout.write(health.service+'|'+health.repositoryReady+'|'+health.readOnly);" \
        2>/dev/null
    )"
    probe_exit=$?
    set -e
    [[ "$probe_exit" -eq 0 ]] && break
  fi
  [[ "$attempt" -lt 20 ]]
  sleep 1
done
[[ "$API_STATE" == 'running/0' ]]
[[ "$API_PROBE" == 'polkaswap-indexer|true|true' ]]

CHECKPOINT="runtime operations"
[[ "$(
  docker exec \
    --env PGPASSWORD=api-test-password \
    "$POSTGRES_CONTAINER" \
    psql -h 127.0.0.1 -U pi_api -d polkaswap -Atc \
    'select count(*) from indexer_documents;'
)" == 0 ]]
set +e
api_fence_output="$(
  docker exec \
    --env PGPASSWORD=api-test-password \
    "$POSTGRES_CONTAINER" \
    psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -U pi_api -d polkaswap -c \
    'select count(*) from polkaswap_indexer_worker_lease_fence;' 2>&1
)"
api_fence_exit=$?
worker_ddl_output="$(
  docker exec \
    --env PGPASSWORD=worker-test-password \
    "$POSTGRES_CONTAINER" \
    psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -U pi_worker -d polkaswap -c \
    'create table worker_must_not_create(id integer);' 2>&1
)"
worker_ddl_exit=$?
worker_fence_delete_output="$(
  docker exec \
    --env PGPASSWORD=worker-test-password \
    "$POSTGRES_CONTAINER" \
    psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -U pi_worker -d polkaswap -c \
    'delete from polkaswap_indexer_worker_lease_fence;' 2>&1
)"
worker_fence_delete_exit=$?
set -e
[[ "$api_fence_exit" -ne 0 ]]
[[ "$worker_ddl_exit" -ne 0 ]]
[[ "$worker_fence_delete_exit" -ne 0 ]]
docker exec \
  --env PGPASSWORD=worker-test-password \
  "$POSTGRES_CONTAINER" \
  psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -U pi_worker -d polkaswap \
  -c "insert into indexer_documents(collection,id,data) values ('assets','worker-can-write','{}');" \
  -c "delete from indexer_documents where collection='assets' and id='worker-can-write';" \
  >/dev/null

CHECKPOINT="idempotent rerun"
RERUN_LOGS="$(run_migration "$OWNER_URL" "$API_URL" "$WORKER_URL")"
[[ "$RERUN_LOGS" == *'Verified production PostgreSQL runtime table privileges after schema migration'* ]]
assert_credential_safe_log "$RERUN_LOGS"

CHECKPOINT="TLS negative cases"
wrong_owner="${OWNER_URL//@database:/@wrong-database:}"
wrong_api="${API_URL//@database:/@wrong-database:}"
wrong_worker="${WORKER_URL//@database:/@wrong-database:}"
set +e
hostname_logs="$(run_migration "$wrong_owner" "$wrong_api" "$wrong_worker")"
hostname_exit=$?
plaintext_logs="$(
  run_migration \
    "${OWNER_URL/sslmode=verify-full/sslmode=disable}" \
    "$API_URL" \
    "$WORKER_URL"
)"
plaintext_exit=$?
set -e
[[ "$hostname_exit" -eq 1 ]]
[[ "$hostname_logs" == 'Production database credential preflight failed: database-session-check-failed' ]]
[[ "$plaintext_exit" -eq 1 ]]
[[ "$plaintext_logs" == 'Production database credential preflight failed: migration-owner-url-tls-invalid' ]]
assert_credential_safe_log "$hostname_logs"
assert_credential_safe_log "$plaintext_logs"

CHECKPOINT="assumable DDL membership"
docker exec \
  --env PGPASSWORD=postgres-test-password \
  "$POSTGRES_CONTAINER" \
  psql -v ON_ERROR_STOP=1 -U postgres -d polkaswap \
  -c 'create role pi_ddl_group nologin;' \
  -c 'grant create on schema public to pi_ddl_group;' \
  -c 'grant pi_ddl_group to pi_worker;' >/dev/null
set +e
ddl_group_logs="$(run_migration "$OWNER_URL" "$API_URL" "$WORKER_URL")"
ddl_group_exit=$?
set -e
docker exec \
  --env PGPASSWORD=postgres-test-password \
  "$POSTGRES_CONTAINER" \
  psql -v ON_ERROR_STOP=1 -U postgres -d polkaswap \
  -c 'revoke pi_ddl_group from pi_worker;' \
  -c 'revoke create on schema public from pi_ddl_group;' \
  -c 'drop role pi_ddl_group;' >/dev/null
[[ "$ddl_group_exit" -eq 1 ]]
[[ "$ddl_group_logs" == 'Production database credential preflight failed: database-runtime-role-privileges-invalid' ]]
assert_credential_safe_log "$ddl_group_logs"

CHECKPOINT="assumable object ownership"
docker exec \
  --env PGPASSWORD=postgres-test-password \
  "$POSTGRES_CONTAINER" \
  psql -v ON_ERROR_STOP=1 -U postgres -d polkaswap \
  -c 'create role pi_object_owner nologin;' \
  -c 'create table membership_owned_object(id integer);' \
  -c 'alter table membership_owned_object owner to pi_object_owner;' \
  -c 'grant pi_object_owner to pi_api;' >/dev/null
set +e
object_group_logs="$(run_migration "$OWNER_URL" "$API_URL" "$WORKER_URL")"
object_group_exit=$?
set -e
docker exec \
  --env PGPASSWORD=postgres-test-password \
  "$POSTGRES_CONTAINER" \
  psql -v ON_ERROR_STOP=1 -U postgres -d polkaswap \
  -c 'revoke pi_object_owner from pi_api;' \
  -c 'drop table membership_owned_object;' \
  -c 'drop role pi_object_owner;' >/dev/null
[[ "$object_group_exit" -eq 1 ]]
[[ "$object_group_logs" == 'Production database credential preflight failed: database-runtime-role-privileges-invalid' ]]
assert_credential_safe_log "$object_group_logs"

CHECKPOINT="assumable extra group ACL"
docker exec \
  --env PGPASSWORD=postgres-test-password \
  "$POSTGRES_CONTAINER" \
  psql -v ON_ERROR_STOP=1 -U postgres -d polkaswap \
  -c 'alter role pi_api noinherit;' \
  -c 'create role pi_extra_acl nologin;' \
  -c 'grant select on polkaswap_indexer_worker_lease_fence to pi_extra_acl;' \
  -c 'grant pi_extra_acl to pi_api;' >/dev/null
set +e
extra_acl_logs="$(run_migration "$OWNER_URL" "$API_URL" "$WORKER_URL")"
extra_acl_exit=$?
set -e
docker exec \
  --env PGPASSWORD=postgres-test-password \
  "$POSTGRES_CONTAINER" \
  psql -v ON_ERROR_STOP=1 -U postgres -d polkaswap \
  -c 'revoke pi_extra_acl from pi_api;' \
  -c 'alter role pi_api inherit;' \
  -c 'revoke select on polkaswap_indexer_worker_lease_fence from pi_extra_acl;' \
  -c 'drop role pi_extra_acl;' >/dev/null
[[ "$extra_acl_exit" -eq 1 ]]
[[ "$extra_acl_logs" == *'Production database credential preflight failed: database-api-privileges-invalid'* ]]
assert_credential_safe_log "$extra_acl_logs"

CHECKPOINT="complete"
echo "[production-database-test] TLS fresh migration, idempotent rerun, API readiness, exact ACLs, hostname verification, role-membership defenses, and credential-safe diagnostics passed."
