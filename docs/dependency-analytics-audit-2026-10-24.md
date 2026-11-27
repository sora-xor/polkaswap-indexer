# Indexer dependency and analytics audit — 2026-10-24

Compatible dependency updates removed every advisory reported by Yarn's current
registry audit. The service remains on GraphQL 16, Yoga 5 and Polkadot API 16;
this change does not migrate chain codecs, the native database, or GraphQL major
versions. Production deployment was not performed.

## 1. High priority: vulnerable transitive packages — fixed

The initial all-dependency audit reported 16 advisory entries across six
packages: `@fastify/busboy`, `@graphql-tools/utils`, `@vitest/mocker`,
`source-map-js`, `undici`, and `vite` (multiple versions of GraphQL utilities
were installed). Findings included prototype pollution,
multipart-parser denial of service and injection, and development-server issues.
These are affected-version findings, not a claim every vulnerable API is
reachable in this service. Multipart uploads were already disabled in
`src/server.ts:295`; test tooling is excluded from the production image.

| Direct dependency | Before | After |
| --- | --- | --- |
| @babel/runtime | 7.29.7 | 7.29.10 |
| @graphql-tools/schema | 10.0.36 | 10.1.5 |
| graphql-yoga | 5.21.2 | 5.24.6 |
| graphql-ws | 6.1.0 | 6.4.1 |
| pg | 8.22.0 | 8.23.1 |
| ws | 8.21.0 | 8.22.0 |
| vitest | 4.1.11 | 4.1.12 |
| tsx | 4.23.0 | 4.23.15 |

Type packages were refreshed, vulnerable transitive ranges re-resolved, and
compatible duplicate resolutions deduplicated. `package.json:55` and `yarn.lock`
contain the resulting reproducible graph. No audit ignore list or forced
cross-major resolution was added.

Sources: [GraphQL mergeDeep advisory](https://github.com/advisories/GHSA-7mx3-vvmw-hjmv),
[incremental-result advisory](https://github.com/advisories/GHSA-c4qx-w738-7hr3),
[Busboy advisory](https://github.com/advisories/GHSA-xjh9-v7x6-24jw), and the live
npm registry audit returned through Yarn. Direct current versions and peer
compatibility were checked against registry metadata.

## 2. Runtime image — rebuilt, hardened, and scanned; OS findings remain

Both Dockerfile stages now pin the current Docker Official Image
`node:24-trixie-slim` index digest:
`sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea`.
The public registry manifest was checked against its digest. The image keeps
Node 24 (24.22.1 in this build), moves from Debian 12 to Debian 13, and removes
unused npm/Corepack/Yarn installations from the final runtime stage. This removes
13 advisory matches in npm's own dependency tree, which the application's Yarn
audit does not cover. Build-stage package managers remain available. Runtime
setuid/setgid file bits are also removed, and CI now verifies both properties.
The existing non-root user, capability restrictions, and no-new-privileges
deployment settings remain in effect.

An isolated local Docker VM built and exercised the Linux arm64 production
image. Trivy 0.76.1 scanned both reference bases and the final image without
ignoring unfixed findings. Complete package/advisory records, report digests,
the scanner image digest, and runtime evidence are retained in
[the container audit](dependency-container-audit-2026-10-24.json).

| Image | OS package/advisory matches | High / critical OS matches | Node.js matches |
| --- | ---: | ---: | ---: |
| Current Node 24 Debian 12 reference base | 228 | 56 / 1 | 13 |
| Current Node 24 Debian 13 reference base | 162 | 43 / 0 | 13 |
| Final application runtime | 162 | 43 / 0 | 0 |

The final 162 OS matches represent 71 advisory IDs; 43 high matches represent
eight advisory IDs. None has a fixed Debian 13 version in the scanner database.
These are package/advisory matches, not a count of proven exploitable paths.
The reference Debian 12 critical MiniZip finding concerns code that Debian says
is not built into its zlib package, so its disappearance is not evidence that
this application previously exposed a critical exploit.

| Remaining high advisory | Relevant scope |
| --- | --- |
| [CVE-2025-69720](https://security-tracker.debian.org/tracker/CVE-2025-69720) | ncurses `infocmp` input handling; executable remains present |
| [CVE-2026-16742](https://security-tracker.debian.org/tracker/CVE-2026-16742) | systemd-homed local privilege issue; daemon is absent |
| [CVE-2026-54369](https://security-tracker.debian.org/tracker/CVE-2026-54369) | libacl path/symlink handling |
| [CVE-2026-76642](https://security-tracker.debian.org/tracker/CVE-2026-76642) | util-linux mount hooks |
| [CVE-2026-78408](https://security-tracker.debian.org/tracker/CVE-2026-78408) | util-linux `nsenter` cgroup handling |
| [CVE-2026-78409](https://security-tracker.debian.org/tracker/CVE-2026-78409) | util-linux mount subdirectory handling |
| [CVE-2026-78410](https://security-tracker.debian.org/tracker/CVE-2026-78410) | util-linux restricted bind mounts |
| [CVE-2026-9538](https://security-tracker.debian.org/tracker/CVE-2026-9538) | Perl Archive::Tar; module is unavailable in the runtime |

Inspection confirms `mount` and `nsenter` have mode 0755 and `/etc/fstab` has no
active entries. This and the deployment restrictions reduce prerequisites for
some local privilege attacks; they do not establish that every OS finding is
unreachable. No scanner suppression, unstable Debian package substitution, or
unreviewed OS-library backport was added. Vendor updates remain necessary.

Sources: [official Node images](https://github.com/nodejs/docker-node/blob/main/README.md),
[Trivy image scanning](https://trivy.dev/docs/latest/target/container_image/), and
[Debian's MiniZip assessment](https://security-tracker.debian.org/tracker/CVE-2023-45853).

## 3. Analytics API and telemetry review

The indexer derives prices, volume, and snapshots from chain data; no external
event-analytics collector SDK or outgoing event-telemetry service was found in
its production TypeScript imports. Its worker's production RPC configuration
requires the existing chain identity and finalized-data safeguards. The public
GraphQL API already has request-size, query-depth/cost, connection, concurrency,
and rate limits, and does not accept multipart uploads. Public read-only data
explains the permissive CORS policy; no credentialed session was found.

A minimal read-only HTTPS probe of `https://pi.soramitsu.io/graphql` returned the
expected `polkaswap-indexer` service identity, `sora:mainnet`, ready repository and
worker, and lag of one block. No accounts, transactions, or credentials were sent.
The deployed image and infrastructure TLS/rate-limit configuration were not
attested by this probe.

## Validation and retained upgrades

- Final full-suite follow-up: **1,391 passed, 25 skipped** in 151.98 seconds with
  `yarn test --testTimeout=30000`. This command-only test-runner limit accounts
  for heavy concurrent native-build load; no repository test timeout, application
  timeout or security admission deadline was changed. The preceding default
  five-second run passed 1,389 tests and timed out in `chain-env.spec.ts` and
  `restore-rocksdb.spec.ts`. An earlier default run had a process-exit timing
  assertion in `deployment.spec.ts`; its unchanged focused rerun passed all
  seven tests. These earlier failures are retained in `.local/dependency-audit-*20261024.log`.
  The final TypeScript build passes. The 25 initially skipped PostgreSQL tests
  subsequently passed against an isolated PostgreSQL 16.15 cluster in 15.15
  seconds; the temporary cluster was stopped and removed after the run. Evidence:
  `.local/dependency-audit-postgres-integration-20261024.json` and its matching log.
  The initial audit's updated graph
  also completed a default full run with 1,387 passing tests and 25 skipped.
- All-dependency and production-dependency audits return no reported advisories.
- Yarn constraints and duplicate-resolution checks pass.
- `.local/` is excluded from the Docker build context so local audit outputs and
  caches cannot be sent with an image build. All 14 container contract tests
  pass; the CI YAML parses and the deployment test script passes `bash -n`.
- The final Linux arm64 production image builds. All production dependency
  imports and a native RocksDB write/read round trip pass as UID 1000, without
  network access, capabilities, package managers, development dependencies, or
  setuid/setgid files. This is arm64 evidence; other architectures remain CI
  responsibilities.
- The real container deployment test passes TLS migration, hostile search-path
  isolation, idempotency, API readiness, exact table/column ACLs, grant-option
  rejection, hostname verification, role defenses, override rejection, and
  credential-safe diagnostics. The test now copies only runtime certificates
  through the Docker API so it also works with remote engines. Its readiness
  probe now waits for the final TCP listener instead of racing PostgreSQL's
  temporary initialization server. Evidence:
  `.local/dependency-audit-database-container-retest-20261024.log`.
- `@harperfast/rocksdb-js` 2.4.0 has a newer 2.12.0 release. Its on-disk database,
  backup/restore and deployment qualification warrant a separate native-storage
  upgrade. It has no registry advisory in the tested graph. GraphQL 17, Yoga 6,
  Polkadot API 17, TypeScript 7, Babel 8 and Vitest 5 are available but deliberately
  not introduced as untested major migrations. Node typings remain on Node 24.

Re-run `yarn audit:dependencies`, `yarn audit:dependencies:production`,
`yarn dedupe --check`, `yarn constraints`, `yarn test`, and `yarn build`.
This host lacks Corepack; verification used pinned `@yarnpkg/cli-dist@4.10.3`
through `npx`, with an incompatible inherited `YARN_CHILD_CONCURRENCY` variable
unset for the commands only.
