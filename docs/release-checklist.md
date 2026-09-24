# Release Checklist

Use this checklist for every Polkaswap indexer release PR from `develop` to
`master`.

## Before The Release PR

- Confirm all release work has landed on `develop` and that `master` changes
  have been merged or cherry-picked back to `develop`.
- Confirm the GraphQL schema, `_health` identity, the five `mobileConfig`
  capability booleans, production environment notes, and storage compatibility
  are final. The example tester projection is `true,false,true,false,true` for
  Nexus, Nexus sends, Polkamarkt, Polkamarkt mutations, and Taira respectively;
  never enable send or mutation capabilities before the candidate-bound mobile
  release gates qualify.
- Confirm no private tokens, database credentials, deployment keys, local
  environment files, database files, or backups are committed.
- Confirm the deployment secret store has three distinct PostgreSQL role URLs:
  `POLKASWAP_MIGRATION_OWNER_DATABASE_URL`,
  `POLKASWAP_API_DATABASE_URL`, and
  `POLKASWAP_WORKER_DATABASE_URL`. Verify the API and worker logins are
  different, neither is the schema owner, and omitting any URL aborts Compose
  validation. Confirm the one-shot credential preflight also rejects equal URL
  values, repeated decoded role identities, different database targets, and
  target-changing or deadline-overriding URL parameters without printing any
  credential component. Only the audited `sslmode` and `sslnegotiation`
  parameters may be present, and every URL must use `sslmode=verify-full`.
  Confirm it connects all three credentials and verifies the expected
  `session_user`, `current_user`, and `current_database()` before DDL. Confirm
  the owner is a non-superuser schema creator; API and worker must have no
  elevated role attributes, direct or assumable DDL access, owner membership,
  or direct/assumable application-object ownership.
  Direct production processes must still receive their role URL as `DATABASE_URL`
  with `NODE_ENV=production`.
- Run `bash scripts/test-branch-flow-audit.sh` and
  `bash scripts/audit-branch-flow.sh`.
- Run `bash scripts/test-public-artifacts-audit.sh` and
  `bash scripts/audit-public-artifacts.sh`.
- Run `bash scripts/test-todo-debt-audit.sh` and
  `bash scripts/audit-todo-debt.sh`.
- Run `corepack enable`, `yarn install --immutable`,
  `yarn audit:dependencies`, and `yarn audit:dependencies:production`. The
  commands audit the complete and shipped recursive graphs at low severity or
  higher. They suppress registry deprecation notices (currently emitted by
  optional upstream Polkadot fetch and light-client packages) but do not
  suppress security advisories.
- Run `yarn test:deployment-evidence-template`,
  `yarn generate:deployment-evidence-template --output
  build/reports/production-deployment-evidence-template.json`,
  `yarn test:deployment-evidence-audit`, and
  `yarn audit:deployment-evidence`.
- Run `yarn test:production-smoke`, `yarn test`, and `yarn build`.
- Run `yarn test:deployment-manifest` and confirm immutable dependency
  installation fails closed, the runtime image uses production dependencies
  only, the restart-disabled migration owner runs exactly once, API and worker
  wait for its successful completion with in-process migration disabled, and
  the worker overrides the inherited API healthcheck with the compiled
  database-only probe. Confirm the manifest rejects owner/runtime URL reuse,
  weak migration dependencies, runtime migration commands/entrypoints,
  per-service shutdown/logging overrides, short shutdown grace, and unbounded
  logging. Confirm the resolved-manifest audit checks the exact service and
  environment maps for all three services and rejects Node/PostgreSQL process
  overrides.
- Build the exact candidate image and run
  `POLKASWAP_TEST_IMAGE=<candidate> yarn test:production-database-deployment`.
  Confirm the pinned PostgreSQL 16 TLS test passes the fresh migration,
  idempotent rerun, hostile role-default search path, exact table and column ACL
  matrix, absence of grant options, API repository probe, hostname-verification
  and process-override negative cases, predefined/assumable-role,
  schema/object-owner, PUBLIC column-ACL, column grant-option, and extra-ACL
  adversarial cases without logging credential components.
- Run `docker build -t polkaswap-indexer:release .` and confirm the production
  image builds from the checked-in container contract.
- Inspect the image user and dependency surface; the runtime user must be `node`,
  production dependencies must resolve, and `typescript`, `vitest`, and `tsx`
  must not resolve in the final image.
- Confirm any database migration has a tested backup, restore, and rollback
  path. Stop or quiesce writers before a destructive storage cutover. Confirm
  the migration-owner role can atomically provision the exact runtime ACLs,
  the credential preflight completes before DDL, and the migration's read-only
  preflight verifies `indexer_documents` uses `C` collation for `collection`
  and `id` and has a valid primary key. For an existing nonempty database, it
  must find a valid legacy or current `chainState` and the exact matching
  `networkSnapshots` `BLOCK` row by collection and ID. The only allowed
  no-checkpoint startup states contain a worker heartbeat, a valid immutable
  `chainIdentity`, or both, with no other documents. Any failure must leave
  schema objects untouched. Confirm the one-shot migration exits
  successfully, and its credential is absent from the API and worker
  containers. The API and worker credentials are transiently present in the
  one-shot container only so it can prove all three live session roles and the
  database target. After DDL, confirm the same one-shot gate proves the API has
  only `SELECT` on `indexer_documents` and no fence access. Confirm the worker
  has `SELECT`/`INSERT`/`UPDATE`/`DELETE` on `indexer_documents`, only
  `SELECT`/`INSERT`/`UPDATE` on the fence, and no `TRUNCATE`, `REFERENCES`, or
  `TRIGGER` on either table. Confirm this audit includes every directly or
  indirectly assumable role, including `NOINHERIT` memberships.
- Before starting the candidate worker against a legacy database, run the
  [legacy identity preflight](#legacy-database-identity-preflight) through a
  direct, read-only PostgreSQL session. Do not infer that the audited migration
  anchor still exists from a healthy public API or a recent `BLOCK` snapshot.
- Confirm green CI for branch-flow, public-artifact, TODO-debt, immutable install,
  production dependency audit, deployment-evidence, adversarial production
  smoke, build, and the full test suite.
- Confirm rollback owner, monitoring owner, deployment owner, and release
  communication channel.

## Legacy Database Identity Preflight

The worker's first startup against an existing database with no `chainIdentity`
requires the exact audited `networkSnapshots` `BLOCK` row at height
`26872383` and Unix timestamp `1783716432`. The worker retains raw `BLOCK`
snapshots for only 31 days, so an older anchor may have been retired. On
2026-09-24, the public GraphQL endpoint returned no row for this anchor while
returning a recent `BLOCK` row. A subsequent direct, read-only PostgreSQL read
confirmed the exact anchor row in the then-live database. Repeat the direct
preflight against the database selected for each upgrade; the public API result
does not establish the current database contents.

Use the read-only API database role in a direct PostgreSQL session. Run this
query against the exact database selected for the upgrade; keep the connection
URL in the operator's secret store, not in command arguments or a release log:

```sql
BEGIN TRANSACTION READ ONLY;

SELECT id, block_height, timestamp, data->>'data' AS checkpoint
FROM public.indexer_documents
WHERE collection = 'updatesStreams' AND id IN ('chainIdentity', 'chainState')
ORDER BY id;

SELECT count(*) = 1 AS audited_anchor_present
FROM public.indexer_documents
WHERE collection = 'networkSnapshots'
  AND id = 'block-26872383'
  AND block_height = 26872383
  AND timestamp = 1783716432
  AND data->>'id' = 'block-26872383'
  AND data->>'type' = 'BLOCK'
  AND data->>'timestamp' = '1783716432';

COMMIT;
```

If `chainIdentity` is absent and `audited_anchor_present` is false, do not
start the candidate worker against that database: its identity preflight will
fail. Keep the existing service available while choosing one of these paths:

1. Restore the exact audited anchor row from a verified, compatible database
   backup. Rehearse backup and rollback, quiesce writers, restore only the
   verified row, and rerun the direct preflight before candidate startup. Keep
   writers quiesced until the candidate has persisted `chainIdentity`; normal
   snapshot retention may later remove the anchor row again.
2. Build an empty parallel database and let the candidate backfill from the
   reviewed first required SORA block. Verify the complete worker and API
   health contract, data compatibility, and production smoke before switching
   traffic. Preserve the old database and service for rollback.

A newer retained `BLOCK` snapshot contains no block hash and does not replace
the audited historical database anchor. Do not synthesize the missing row from
an RPC response or disable the worker's identity preflight. If neither
recovery path is available, the upgrade remains blocked until a separately
reviewed migration with operator-attested evidence is designed and tested.

## Release PR To `master`

- Open the PR from `develop` or `release/<version>` to `master`.
- Include test evidence, schema compatibility notes, deployment notes, storage
  migration notes, and rollback notes.
- Require CODEOWNERS review and green CI before merge.
- Merge with a merge commit so the release boundary remains visible.
- Create the release tag only after the merge commit is on `master`.

## After Release

Follow these steps in order for the tagged release. Keep the previous release
artifact and compatible database available through the rollback window.

- Validate production Compose with `docker compose -f
  docker-compose.production.yml config --quiet`; never print the interpolated
  manifest after loading secrets. Inspect an unresolved manifest with
  `config --no-interpolate` before loading credentials. Confirm the contract
  uses a four-minute shutdown grace and bounded local log rotation, requires
  distinct reviewed primary/archive RPC inputs, and requires an explicit
  reviewed `POLKASWAP_CHAIN_START_BLOCK`.
- Repeat the direct, read-only [legacy identity preflight](#legacy-database-identity-preflight)
  against the selected production database immediately before startup.
- Deploy the exact tagged image and recorded digest to the reviewed target.
  Confirm the one-shot migration exited successfully before the API and worker
  start. Run `node dist/src/scripts/worker-health.js` inside the worker container and
  inspect its container health. It must validate the immutable mainnet anchor,
  fresh exact `chainState`, and matching `BLOCK` snapshot directly through
  PostgreSQL without reaching the API container. Confirm its 4-second total
  deadline is below the 5-second container timeout; missing, stale, future,
  malformed, and mismatched records must remain unhealthy.
- Verify the deployed service is serving the tagged commit and recorded image
  digest.
- After internal health passes, route `pi.soramitsu.io` to the candidate
  while keeping the previous service and compatible data available for rollback.
- Run `POLKASWAP_INDEXER_BASE_URL=https://pi.soramitsu.io/graphql yarn smoke:production`
  against the public candidate.
- Confirm `https://pi.soramitsu.io/graphql` routes to the intended release and
  returns `_health` with `serviceId=pi.soramitsu.io`, `schemaVersion=1`,
  `ecosystem=sora2`, `chainId=sora:mainnet`, `network=mainnet`,
  `publicBaseUrl=https://pi.soramitsu.io/graphql`, `readOnly=true`, the exact
  reviewed genesis, and a fresh exact block height/hash/timestamp. Confirm the
  migration container exited successfully before API and worker startup, and
  the worker log shows its genesis/history-anchor preflight completed before
  worker repository construction for both distinct RPC hosts. Confirm the
  primary is a locally controlled verifying node, the archive is independently
  operated, and sampled block hashes, raw SCALE blocks/events, and timestamps
  agree. A prior deployment passed only the static service-identity routing check on
  2026-07-10; the current endpoint does not expose the required checkpoint
  fields, and every release must pass the complete current smoke contract.
- Confirm the same smoke response exposes boolean `nexusAvailable`,
  `nexusSendsAvailable`, `polkamarktVisible`,
  `polkamarktMutationsAvailable`, and `tairaDefaultVisible` fields under
  `mobileConfig`. Nexus sends require Nexus availability, Polkamarkt mutations
  require Polkamarkt visibility, and mobile clients independently combine the
  Taira remote default with the Nexus kill switch. Record the exact
  operator-selected projection from the public GraphQL readback; do not infer a
  missing value. The deployment evidence `mobileConfig` object must contain
  exactly these five booleans and match that readback.
- Before declaring the deployment production-ready, use the generated evidence
  template to create operator-attested evidence for the current release commit,
  immutable Docker image digest, deployment ID, UTC deployment and smoke
  timestamps, the required `_health` identity and checkpoint projection,
  the five-boolean `mobileConfig` public readback, and the command
  `POLKASWAP_INDEXER_BASE_URL=https://pi.soramitsu.io/graphql yarn smoke:production`.
  The health payload must report genesis
  `0x7e4e32d0feafd4f9c9414b0be86373f9a1efa904809b683453a9af6856d38ad5`,
  a positive safe-integer `latestIndexedBlock`, a canonical nonzero lowercase
  32-byte `latestIndexedBlockHash`, and an integer Unix-seconds
  `latestIndexedAt` no more than 300 seconds before or 30 seconds after
  `smokePassedAt`.
  Include exact `soraRpcControls` with canonical credential-free `wss` URLs on
  distinct non-public hosts, the required local-primary and independent-archive
  control roles, exact identity preflight, and raw height/hash/SCALE
  block/events/timestamp agreement. Public `*.sora.org` convenience endpoints
  do not satisfy ready evidence.
  The same evidence record must attest the TLS-edge controls delegated by the
  loopback-only container contract: TLS termination, overwrite (never preserve)
  of forwarded client-IP headers, 600 HTTP requests per client per 60 seconds,
  600 WebSocket upgrades per client per 60 seconds, and no more than 16
  concurrent WebSockets per client.
  Set `status: ready` and `releaseEnabled: true`, then run
  `yarn audit:deployment-evidence --require-ready`. If release tooling validates
  a tagged commit instead of local `HEAD`, set
  `DEPLOYMENT_EVIDENCE_EXPECTED_COMMIT` to that 40-character commit.
- Verify representative wallet and Polkaswap GraphQL queries against production
  without mutating chain or indexer state.
- Monitor GraphQL error rate and latency, SORA RPC health, finalized-block lag,
  worker restarts, database health, storage growth, and backup completion.
- Keep the previous release artifact and compatible data backup until the
  rollback window closes.
