# Release Checklist

Use this checklist for every Polkaswap indexer release PR from `develop` to
`master`.

## Before The Release PR

- Confirm all release work has landed on `develop` and that `master` changes
  have been merged or cherry-picked back to `develop`.
- Confirm the GraphQL schema, `_health` identity, production environment notes,
  and storage compatibility are final.
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
  logging. Confirm the resolved-manifest audit checks all three services.
- Build the exact candidate image and run
  `POLKASWAP_TEST_IMAGE=<candidate> yarn test:production-database-deployment`.
  Confirm the pinned PostgreSQL 16 TLS test passes the fresh migration,
  idempotent rerun, exact per-table ACL matrix, API repository probe,
  hostname-verification negative case, and assumable-role/object-owner/extra-ACL
  adversarial cases without logging credential components.
- Run `docker build -t polkaswap-indexer:release .` and confirm the production
  image builds from the checked-in container contract.
- Inspect the image user and dependency surface; the runtime user must be `node`,
  production dependencies must resolve, and `typescript`, `vitest`, and `tsx`
  must not resolve in the final image.
- Confirm any database migration has a tested backup, restore, and rollback
  path. Stop or quiesce writers before a destructive storage cutover. Confirm
  the migration-owner role can atomically provision the exact runtime ACLs,
  the credential preflight completes before DDL, the one-shot migration exits
  successfully, and its credential is absent from the API and worker
  containers. The API and worker credentials are transiently present in the
  one-shot container only so it can prove all three live session roles and the
  database target. After DDL, confirm the same one-shot gate proves the API has
  only `SELECT` on `indexer_documents` and no fence access. Confirm the worker
  has `SELECT`/`INSERT`/`UPDATE`/`DELETE` on `indexer_documents`, only
  `SELECT`/`INSERT`/`UPDATE` on the fence, and no `TRUNCATE`, `REFERENCES`, or
  `TRIGGER` on either table. Confirm this audit includes every directly or
  indirectly assumable role, including `NOINHERIT` memberships.
- Validate production Compose with `docker compose -f
  docker-compose.production.yml config --quiet`; never print the interpolated
  manifest after loading secrets. Inspect an unresolved manifest with
  `config --no-interpolate` before loading credentials. Confirm the contract
  uses a four-minute shutdown grace and bounded local log rotation, requires
  distinct reviewed primary/archive RPC inputs, and requires an explicit
  reviewed `POLKASWAP_CHAIN_START_BLOCK`. Run
  `node dist/src/scripts/worker-health.js` inside the worker container and
  inspect its container health. It must validate the immutable mainnet anchor,
  fresh exact `chainState`, and matching `BLOCK` snapshot directly through
  PostgreSQL without reaching the API container. Confirm its 4-second total
  deadline is below the 5-second container timeout; missing, stale, future,
  malformed, and mismatched records must remain unhealthy.
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
- Before declaring the deployment production-ready, use the generated evidence
  template to create operator-attested evidence for the current release commit,
  immutable Docker image digest, deployment ID, UTC deployment and smoke
  timestamps, exact `_health` payload, and the command
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
- Confirm green CI for branch-flow, public-artifact, TODO-debt, immutable install,
  production dependency audit, deployment-evidence, adversarial production
  smoke, build, and the full test suite.
- Confirm rollback owner, monitoring owner, deployment owner, and release
  communication channel.

## Release PR To `master`

- Open the PR from `develop` or `release/<version>` to `master`.
- Include test evidence, schema compatibility notes, deployment notes, storage
  migration notes, and rollback notes.
- Require CODEOWNERS review and green CI before merge.
- Merge with a merge commit so the release boundary remains visible.
- Create the release tag only after the merge commit is on `master`.

## After Release

- Verify the deployed service is serving the tagged commit and recorded image
  digest.
- Run
  `POLKASWAP_INDEXER_BASE_URL=https://pi.soramitsu.io/graphql yarn smoke:production`
  and verify the production `_health` identity.
- Verify representative wallet and Polkaswap GraphQL queries against production
  without mutating chain or indexer state.
- Monitor GraphQL error rate and latency, SORA RPC health, finalized-block lag,
  worker restarts, database health, storage growth, and backup completion.
- Keep the previous release artifact and compatible data backup until the
  rollback window closes.
