# polkaswap-indexer

Polkaswap-owned indexer service for the exchange UI.

The API intentionally exposes SubQuery-compatible GraphQL field names so the
static Polkaswap UI can use a single external endpoint without depending on
SubQuery or Subsquid from the browser.

## Runtime

- Node.js 24+
- PostgreSQL 16+
- GraphQL HTTP and WebSocket endpoint: `/graphql`

## Local Setup

```sh
corepack enable
yarn install
yarn db:migrate
yarn dev
```

Run the chain worker separately:

```sh
yarn worker
```

By default the worker reads finalized SORA blocks from `wss://mof2.sora.org`.
Before it constructs or migrates the database, startup proves both the reviewed
SORA mainnet genesis
`0x7e4e32d0feafd4f9c9414b0be86373f9a1efa904809b683453a9af6856d38ad5`
and audited history anchor block `26872383` with hash
`0x28dd415867e637e5c70056a564cfa4e81f0f3df3a18d1132ccc61fe5025c762c`.
The worker repeats that proof before any repository read, persists the fixed
audited anchor as an immutable `chainIdentity` checkpoint, and validates every
configured archive endpoint independently. There is no environment override or
skip switch for this proof.

For local exchange development before a full worker backfill has completed, seed
the current XOR/DAI assets, price update stream, recent chart snapshots, and
SOLSWAP burn campaign history used by the burn page stats:

```sh
yarn seed:swap-chart
```

The UI should point `POLKASWAP_INDEXER_ENDPOINT` at the hosted GraphQL URL:
`https://pi.soramitsu.io/graphql`.

Explore views rely on `exploreStats` plus filtered `assets` and `poolXYKs`
connections. Keep the migration indexes current before serving production
traffic so count and order-by queries on liquidity, volume, price, and pool
reserves stay fast.

## Data Model

Documents are stored in `indexer_documents` as denormalized JSON. The GraphQL
schema projects those documents into the fields consumed by Polkaswap:

- account and transaction history
- per-account transaction activity for unique active-account stats
- asset prices and snapshots
- pool and order-book stats
- Polkamarkt prediction markets from runtime storage, including explicit SORA
  governance references encoded in condition resolution sources
- network snapshots
- vault, staking, referral, and stream records
- point-system account metadata
- update streams for fiat prices, APY, asset registration, accounts, and order books

The chain worker reads finalized SORA blocks for transaction history and uses
SORA storage refreshes to maintain the current asset, pool, order-book,
Polkamarkt market, vault, referral, staking, account-liquidity, snapshot, and
stream collections. Historical
backfill starts at `CHAIN_START_BLOCK` and resumes from the stored chain state.
The `accountTransactions` collection stores one row per account involved in an
indexed transaction. The `networkAccountActivity` GraphQL query counts distinct
accounts from that collection over a requested timestamp range for the exchange
stats page. On first startup after this collection is introduced, the worker
backfills it from legacy `historyElements`, filters external hex addresses out of
the active-account metric, and records completion in
`accountTransactionsBackfill-v1` so future stats queries skip legacy history
scans. SOLSWAP burn stats are backfilled separately into `xorBurns` from block
`25,043,003`; progress is stored in the `xorBurnsBackfill` update stream so
redeploys resume without rewinding normal chain indexing.

## Production Notes

Run the API and worker as separate processes against the same PostgreSQL
database. For a fresh production deployment, set `CHAIN_START_BLOCK` to the
earliest block you need indexed; a full-chain backfill is intentionally long.
Set `NODE_ENV=production` and inject an explicit `DATABASE_URL`; production
startup rejects the development database fallback. Runtime configuration is
strict: invalid ports, non-canonical integer values, unsafe GraphQL paths,
non-PostgreSQL database URLs, credentialed or query-bearing SORA URLs, and
non-TLS remote SORA endpoints abort startup. Production workers require a second
`SORA_ARCHIVE_WS_ENDPOINT` on a different reviewed host; it must likewise use
`wss`, contain no credentials/query/fragment, and prove the same genesis and
history anchor before the database is opened. Every indexed height must have the
same hash, raw SCALE block body, raw events storage, and timestamp on both
endpoints. Storage-derived analytics still treat the reviewed primary RPC as a
trusted input, so operators must use a locally controlled verifying primary and
an independently operated archival endpoint rather than public convenience RPCs
for release evidence.
Use `CHAIN_STATE_REFRESH_INTERVAL_BLOCKS` to control how often storage-derived
collections are refreshed during block processing, and
`CHAIN_SNAPSHOT_INTERVAL_BLOCKS` to control chart snapshot density. Both default
to `25` so stats aggregates stay close to finalized block progress.

The public GraphQL runtime applies a 64 KiB HTTP/WS payload ceiling, disables
batching and multipart uploads, bounds query depth, expanded fields, aliases,
HTTP identities, total request rate, WebSocket connections, and operations per
connection, and disables introspection by default in production. Forwarding
headers are intentionally ignored; the local TLS proxy must reach the
loopback-published service from `docker-compose.production.yml`.
Because every proxied request has the proxy's raw socket identity, the Compose
contract sets the peer bucket equal to the process-wide ceiling; the TLS edge
must enforce its own client-IP request and WebSocket limits after replacing
untrusted forwarding headers. Direct deployments retain the stricter per-peer
defaults from the image.

Launch the hardened API and worker contract with externally managed service
configuration and immutable image evidence:

```sh
export POLKASWAP_INDEXER_IMAGE_REPOSITORY=registry.example/polkaswap-indexer
export POLKASWAP_INDEXER_IMAGE_DIGEST=<reviewed-64-hex-digest>
export POLKASWAP_DATABASE_URL=postgresql://<managed-secret>@db.example/indexer?sslmode=require
export POLKASWAP_SORA_WS_ENDPOINT=wss://<controlled-verifying-primary>
export POLKASWAP_SORA_ARCHIVE_WS_ENDPOINT=wss://<independently-operated-archive>
export POLKASWAP_CHAIN_START_BLOCK=<reviewed-first-required-block>
docker compose -f docker-compose.production.yml config
docker compose -f docker-compose.production.yml up -d
```

The production worker overrides the image's API healthcheck with
`dist/src/scripts/worker-health.js`. This probe has no HTTP or API-container
dependency. It uses the worker's existing `DATABASE_URL` to require the exact
immutable SORA mainnet anchor, a strictly shaped `chainState`, and the exact
matching `BLOCK` snapshot. The state height/hash/timestamp must be coherent with
the anchor, and its timestamp may be at most 300 seconds old or 30 seconds
ahead. PostgreSQL connection, statement/query, and cleanup waits are bounded;
the 4-second hard process deadline remains below the 5-second container timeout.
Diagnostics contain only fixed failure codes and never include the database URL
or raw driver error text.

During rollout, confirm worker health independently of GraphQL:

```sh
docker compose -f docker-compose.production.yml exec worker \
  node dist/src/scripts/worker-health.js
docker inspect --format '{{json .State.Health}}' <worker-container>
```

An empty database, an incomplete first block, a stopped or stale worker, a
future clock, a malformed row, or a snapshot that does not exactly match
`chainState` is intentionally unhealthy. The public API production smoke is a
separate release gate and must not replace this database-backed worker check.

Run `yarn audit:dependencies` for the complete dependency graph and
`yarn audit:dependencies:production` for the shipped runtime graph. Both fail on
security advisories at low severity or higher; `--no-deprecations` only excludes
non-security registry maintenance notices from the gate.

For every production deployment, run the smoke check against the public GraphQL
endpoint:

```sh
POLKASWAP_INDEXER_BASE_URL=https://pi.soramitsu.io/graphql yarn smoke:production
```

The smoke query requires `_health` to identify this service as
`serviceId=pi.soramitsu.io`, `ecosystem=sora2`, `chainId=sora:mainnet`,
`network=mainnet`, `schemaVersion=1`, `readOnly=true`, and
`publicBaseUrl=https://pi.soramitsu.io/graphql`. It intentionally fails if the
route points at the TON or Solana indexer contracts. A prior deployment passed
the static service-identity routing check on 2026-07-10. The current endpoint
does not expose the required checkpoint fields, so that historical routing
result does not satisfy the current smoke contract or replace operator-attested
evidence for a specific release artifact.

The same request requires the exact reviewed genesis in `_health`, a strictly
shaped immutable `chainIdentity`, and a `chainState` containing the same genesis,
a positive block height, its nonzero lowercase 32-byte hash, and its chain
timestamp. `_health` must reproduce that checkpoint exactly, and the latest
filtered `BLOCK` snapshot must have ID `block-<height>` and the same timestamp.
The checkpoint may be at most 300 seconds old or 30 seconds ahead of the smoke
clock. Static `chainId`/`network` labels alone never satisfy the contract. The
client refuses
redirects, uses a 10-second total deadline, accepts exact JSON media types
(including `application/graphql-response+json`), and caps decoded responses at
1 MiB. Diagnostic overrides are bounded by 60 seconds, 5 MiB, and one hour via
`POLKASWAP_INDEXER_SMOKE_TIMEOUT_MS`,
`POLKASWAP_INDEXER_SMOKE_MAX_RESPONSE_BYTES`, and
`POLKASWAP_INDEXER_SMOKE_MAX_INDEXER_AGE_SEC`.

Production release evidence is tracked in
`scripts/production-deployment-evidence.json`. The committed manifest must stay
blocked on `production-deployment-evidence-missing` and
`live-production-smoke-failing` until the current public smoke passes and an
operator records the deployed image digest, git commit, deployment id, PI health
response, and live smoke timestamp for the intended release. The attested health
response must
contain the exact SORA mainnet genesis hash
`0x7e4e32d0feafd4f9c9414b0be86373f9a1efa904809b683453a9af6856d38ad5`,
a positive safe-integer indexed block, its canonical nonzero lowercase 32-byte
hash, and an integer Unix-seconds checkpoint timestamp no more than 300 seconds
before or 30 seconds after `smokePassedAt`. The same record must include exact
`soraRpcControls`: canonical credential-free `wss` URLs on distinct non-public
hosts, the roles `locally-controlled-verifying-archive` and
`independently-operated-verifying-archive`, successful exact identity preflight,
and `height-hash-scale-block-events-timestamp` raw payload agreement. Public
`*.sora.org` convenience nodes are useful for diagnostics but cannot satisfy
that production trust attestation. Because the loopback service cannot
derive end-client identities behind the local proxy, the same record must attest
that the TLS edge terminates TLS, overwrites untrusted forwarded-client headers,
enforces 600 HTTP requests per client per 60 seconds, permits at most 600
WebSocket upgrades per client per 60 seconds, and caps concurrent WebSockets at
16 per client.

Prepare the operator template and run the ready gate before enabling release
routing:

```sh
yarn test:deployment-evidence-template
yarn generate:deployment-evidence-template --output build/reports/production-deployment-evidence-template.json
yarn test:deployment-evidence-audit
yarn audit:deployment-evidence --require-ready
POLKASWAP_INDEXER_BASE_URL=https://pi.soramitsu.io/graphql yarn smoke:production
```
