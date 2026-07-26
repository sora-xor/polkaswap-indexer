# polkaswap-indexer

Polkaswap-owned indexer service for the exchange UI.

The API intentionally exposes SubQuery-compatible GraphQL field names so the
static Polkaswap UI can use a single external endpoint without depending on
SubQuery or Subsquid from the browser.

## Runtime

- Node.js 24+
- PostgreSQL 16+
- Optional embedded RocksDB storage via `STORAGE_ENGINE=rocksdb`
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

The Compose deployment modes are mutually exclusive profiles because both
publish the GraphQL API on port `4350`. Start the split PostgreSQL API and
worker topology, including its one-shot migration service, with:

```sh
docker compose --profile postgres up --build
```

Start the embedded RocksDB combined process without PostgreSQL services with:

```sh
docker compose --profile rocksdb up --build
```

For targeted local development, Compose automatically enables the profile of
an explicitly named service. `docker compose up postgres` starts only the
database, while `docker compose up api worker --build` starts the split API and
worker plus their required migration and database dependencies. Do not enable
both complete profiles together because they intentionally publish the same
host port.

By default the worker reads finalized SORA blocks from `wss://mof2.sora.org`.
The direct `@babel/runtime` dependency is intentional: the published
`@sora-substrate/type-definitions` CommonJS build imports Babel helpers at
runtime without declaring that package itself.

For the embedded RocksDB backend, migrate existing Postgres documents first and
then run API and worker in one process so they share the same local database
handle:

```sh
STORAGE_ENGINE=rocksdb ROCKSDB_MIGRATION_FOLLOW=true yarn storage:migrate:postgres-to-rocksdb
# stop the old Postgres API/worker
STORAGE_ENGINE=rocksdb yarn storage:migrate:postgres-to-rocksdb
STORAGE_ENGINE=rocksdb yarn storage:verify:rocksdb
STORAGE_ENGINE=rocksdb yarn storage:backup:rocksdb
yarn build
STORAGE_ENGINE=rocksdb yarn start:combined
```

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

When `STORAGE_ENGINE=rocksdb`, the same document model is stored in RocksDB
under `ROCKSDB_PATH`. The RocksDB repository keeps secondary indexes for common
timestamp, block-height, equality, and numeric sort query shapes. Public
GraphQL connections accept only the supported, indexed filter/order policies
and fail closed before repository execution for unsupported shapes. Bounded
scan/sort fallback is reserved for trusted internal repository callers.

The chain worker reads finalized SORA blocks for transaction history and uses
SORA storage refreshes to maintain the current asset, pool, order-book,
Polkamarkt market, vault, referral, staking, account-liquidity, snapshot, and
stream collections. Historical
backfill starts at `CHAIN_START_BLOCK` and resumes from the stored chain state.
The `accountTransactions` collection stores one row per account involved in an
indexed transaction. The `networkAccountActivity` GraphQL query counts distinct
accounts from that collection over a requested timestamp range for the exchange
stats page. It rejects ranges longer than 366 days and enforces one 100,000-row
scan budget across all pages and source collections. Public collection
connections also enforce collection-specific filter/order policies; unsupported
shapes fail before repository execution. Scan/sort fallbacks remain available
only to bounded, trusted internal repository callers.

## Production Notes

Run the API and worker as separate processes against the same PostgreSQL
database. For a fresh production deployment, set `CHAIN_START_BLOCK` to the
earliest block you need indexed; a full-chain backfill is intentionally long.
Set `NODE_ENV=production` and inject `DATABASE_URL`; production startup rejects
the development database fallback. Primary and archive SORA URLs must be
credential-free `wss:` endpoints without query strings or fragments, on
different hosts. The production worker requires `SORA_ARCHIVE_WS_ENDPOINT`.
Before constructing, migrating, reading, or writing the repository, it proves
the reviewed SORA mainnet genesis and immutable history anchor independently on
both endpoints. The in-process worker repeats the primary proof and validates a
self-consistent finalized head before it may persist even its first heartbeat.
Every archived block then has to match the primary endpoint by height/hash, raw
SCALE block and event bytes, and timestamp.
The one-shot PostgreSQL schema migration uses
`POSTGRES_MIGRATION_QUERY_TIMEOUT_MS` and
`POSTGRES_MIGRATION_STATEMENT_TIMEOUT_MS`, both defaulting to `0` (unlimited),
instead of the bounded runtime query deadlines. Check constraints are installed
as `NOT VALID` so new writes are protected immediately, then validated
separately. If a long validation is interrupted, rerunning the migration keeps
the correctly manifested constraint and retries validation without dropping and
re-adding it; PostgreSQL restarts that constraint's table scan. Set a positive
migration timeout only when an operator intentionally wants to cap these
production-scale scans and concurrent index builds.

Use `CHAIN_STATE_REFRESH_INTERVAL_BLOCKS` to control how often storage-derived
collections are refreshed during block processing, and
`CHAIN_SNAPSHOT_INTERVAL_BLOCKS` to control chart snapshot density. Both default
to `25` so stats aggregates stay close to finalized block progress. Between
refreshes, clean storage domains reuse their last RPC result while event-dirty
domains are reloaded at the next projection; a full
reconciliation defaults to every `250` blocks and is configurable with
`CHAIN_STATE_FULL_RECONCILIATION_INTERVAL_BLOCKS`.

Backfill and finalized catch-up value each block from its exact parent-block
asset metadata and Pool XYK reserves. The initial archive state is consumed in
256-entry pages under one retained-byte ceiling; later blocks point-read only
canonical assets and both possible pool-key orientations touched by successful
events/calls. Ambiguous runtime mutations fail closed to a bounded full reload,
and valuation advances only after the block documents and `chainState` commit
atomically. Historical order-book USD stock cannot be reconstructed from pool
state alone, so `liquidityUSD`, `orderBookLiquidityUSD`, and
`activeOrderBooks` are `null` until a pinned full projection has recomputed raw
orders at the same height. The worker never substitutes a misleading zero.

Public asset, pool, order-book, market, and network chart snapshots use only
`DEFAULT`, `HOUR`, `DAY`, and `MONTH`; per-block entity chart snapshots are not
stored. `DEFAULT` buckets are retained for 48 hours and `HOUR` buckets for 8
days, while `DAY` and `MONTH` remain available for all-time charts.
Account-liquidity snapshots use `DEFAULT` and the same 48-hour horizon. Raw
network `BLOCK` rows used by rolling analytics are retained for 31 days.
Cleanup queries the type/timestamp indexes and deletes a bounded number of
pages per refresh. Successful deletion is its durable progress marker, so an
interrupted page is still visible to the next refresh; no retention cursor or
migration state document is stored.

Worker backfill controls are parsed once into each indexer instance's runtime
configuration. `CHAIN_BACKFILL_PREFETCH_CONCURRENCY` defaults to `1`; finalized
catch-up inherits that value unless
`CHAIN_FINALIZED_CATCHUP_PREFETCH_CONCURRENCY` is set explicitly. Both are
bounded at `256`. Set
`CHAIN_PRICE_STREAM_REFRESH_INTERVAL_BLOCKS` to a positive interval (maximum
`10,000,000`) to refresh the price stream independently; `0` keeps it coupled
to normal derived-state refreshes. Outside production,
`SORA_ARCHIVE_WS_ENDPOINT` optionally selects a validated historical block
endpoint, while
`CHAIN_LEGACY_SORA_BLOCK_TYPES=true` enables the legacy type bundle. Invalid or
out-of-range values abort startup.

Both combined and split deployments expose worker-aware GraphQL readiness.
The worker persists the strict versioned `updatesStreams/workerStatus-v1`
heartbeat every 15 seconds; the split API reads that same document. `_health.ok`
is false when the status is missing, stale, incompatible, internally
inconsistent, not running/startup-complete, more than
`WORKER_READINESS_MAX_LAG_BLOCKS` behind, or older than
`WORKER_READINESS_MAX_STALENESS_SECONDS`. The staleness threshold has a
30-second minimum. The standalone worker also exposes JSON health at `/health`
and Prometheus metrics at `/metrics` on
`WORKER_METRICS_HOST:WORKER_METRICS_PORT` (loopback port `9464` by default).
Every PostgreSQL-backed worker or combined process also holds one dedicated,
session-scoped advisory writer lease. Each worker mutation validates an
unpredictable lease epoch while holding a shared transaction fence; lease
handoff takes that fence exclusively, drains already-validated writes, and
rejects every old-token write after loss. A second worker fails startup, and
loss of the lease connection triggers fatal shutdown. The schema migration
creates `public.polkaswap_indexer_worker_lease_fence`; a split runtime worker
role needs `SELECT`, `INSERT`, and `UPDATE` on that table but does not need DDL
privileges. A worker started against an unmigrated database fails closed with an
instruction to run the migration; it never attempts runtime DDL. API-only and
administrative repository instances are not fenced unless they are explicitly
constructed with a worker fencing token.

The public GraphQL boundary is fail-closed and resource bounded. HTTP POST
requests accept JSON only, with a default 256 KiB body cap; multipart uploads
and operation batching are disabled. At most `GRAPHQL_HTTP_MAX_IN_FLIGHT`
HTTP operations are admitted per process; excess requests receive HTTP 503 and
`Retry-After`. This is separate from WebSocket and ingress limits. Validation rejects excessive AST size,
depth, expanded fields, aliases, fragment spreads/cycles, and estimated nested
connection work before resolvers run. Schema introspection is disabled by
default and can be enabled explicitly with `GRAPHQL_ALLOW_INTROSPECTION=true`.
WebSocket payloads, `GRAPHQL_WS_MAX_CONNECTIONS`, total concurrent operations
across both supported protocols (`GRAPHQL_WS_MAX_OPERATIONS`), concurrent
operations per connection (`GRAPHQL_WS_MAX_OPERATIONS_PER_CONNECTION`), and
connection-initialization time are bounded separately. Both WebSocket framings
accept subscription operations only; queries use HTTP. See `.env.example` for
the defaults. Invalid or internally inconsistent HTTP/GraphQL limit values abort
startup rather than being coerced.

`GRAPHQL_MAX_RESULT_BYTES` is both the exact encoded response cap and the
per-operation repository materialization allowance. All connection, point, and
batch reads in one operation share that allowance: concurrent aliases are
serialized at the repository boundary and each query receives only the bytes
still available. A repository may retain one oversized first document so
keyset pagination can make progress, but that consumes the operation's entire
allowance and prevents any later alias from multiplying it.
`GRAPHQL_EXECUTION_MEMORY_MAX_BYTES` is the process-wide admission budget shared
by HTTP and emitted results from both WebSocket protocols. HTTP holds one
`GRAPHQL_MAX_RESULT_BYTES` reservation for the request lifetime. An idle
subscription holds no execution-memory reservation; after its source produces
an event, the server reserves capacity for field execution and retains it
through result serialization and the socket send. Startup requires the global
budget to be at least one maximum result.

Repository watch queues retain only bounded document identities and the latest
mutation type per id, never complete JSON documents. Subscription entities are
point-read during field execution after that emission reservation is acquired.
Polling fallback likewise hashes one legal document at a time and retains only
fixed-size SHA-256 fingerprints.

The server also applies bounded fixed-window request and WebSocket-upgrade rates
to the raw TCP peer, caps tracked peer identities, caps concurrent WebSockets
per raw peer, bounds header bytes and requests per keep-alive socket, and ignores
spoofable forwarding headers. A trusted loopback proxy is one raw peer, not the
end client: production Compose raises that peer bucket only to the process-wide
backstop, while the TLS edge must overwrite untrusted forwarding headers and
enforce the attested per-client request, upgrade, connection, body, and header
limits.

For RocksDB production deployment, use `start:combined` instead of separate API
and worker processes. RocksDB is embedded local storage; the API and worker must
share one process-local repository handle for fresh reads and safe writes. The
standalone API and worker entry points reject `STORAGE_ENGINE=rocksdb` before
opening the database so a split deployment cannot race accidentally.
On the MacStadium host, install `ops/run-combined.sh` as
`/Users/administrator/apps/polkaswap-indexer/run-combined.sh` and supervise it
with `ops/org.polkaswap.indexer.plist` under `/Library/LaunchDaemons`.
Install the bounded combined-log policy at the same time:

```sh
sudo install -d -o administrator -g staff -m 0750 \
  /Users/administrator/apps/polkaswap-indexer/logs
sudo install -o root -g wheel -m 0755 ops/run-combined.sh \
  /Users/administrator/apps/polkaswap-indexer/run-combined.sh
sudo install -o root -g wheel -m 0644 ops/org.polkaswap.indexer.plist \
  /Library/LaunchDaemons/org.polkaswap.indexer.plist
sudo install -o root -g wheel -m 0644 ops/org.polkaswap.indexer.newsyslog.conf \
  /etc/newsyslog.d/org.polkaswap.indexer.conf
sudo plutil -lint /Library/LaunchDaemons/org.polkaswap.indexer.plist
sudo newsyslog -nvv -f /etc/newsyslog.d/org.polkaswap.indexer.conf
sudo newsyslog -C -N -f /etc/newsyslog.d/org.polkaswap.indexer.conf
sudo launchctl bootout system/org.polkaswap.indexer 2>/dev/null || true
sudo launchctl bootstrap system /Library/LaunchDaemons/org.polkaswap.indexer.plist
```

Both stdout and stderr intentionally share `combined-launchd.log`. `newsyslog`
creates the replacement as `administrator:staff` mode `0640` and keeps five
100 MiB archives. On macOS, signal 31 is `SIGUSR2`: after renaming
the log, `newsyslog` signals the supervisor PID in `combined.pid`; the
supervisor sends `SIGTERM` to Node, waits for its graceful shutdown, and exits.
`KeepAlive` then starts a fresh supervisor with launchd descriptors opened on
the new pathname. Duplicate stop signals during that drain are ignored so Node
cannot be orphaned.

Verify the complete rotation handoff after installation:

```sh
log=/Users/administrator/apps/polkaswap-indexer/logs/combined-launchd.log
before=$(stat -f %i "$log")
old_pid=$(cat /Users/administrator/apps/polkaswap-indexer/combined.pid)
sudo newsyslog -Fv -f /etc/newsyslog.d/org.polkaswap.indexer.conf "$log"
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  new_pid=$(cat /Users/administrator/apps/polkaswap-indexer/combined.pid 2>/dev/null || true)
  [[ -n "$new_pid" && "$new_pid" != "$old_pid" ]] && break
  sleep 2
done
test "$(stat -f %i "$log")" != "$before"
sudo launchctl print system/org.polkaswap.indexer | grep 'state = running'
sudo lsof -a -p "$new_pid" -d 1,2
```

The final `lsof` output must name the current `combined-launchd.log`, not an
archived `.0` file. Never signal `api-4350.pid` separately: both PID files name
the same launchd supervisor.

The Postgres-to-RocksDB migrator installs a versioned capture generation under
`polkaswap_indexer_migration` before export. Source transactions are serialized
at their first `indexer_documents` statement and held through commit, so the
append-only 32-byte SHA-256 predecessor chain has the same order as commit
visibility without storing hexadecimal hashes twice as large in PostgreSQL.
Concurrent inserts, updates, and deletes—including inserts behind an already
exported keyset cursor—are replayed without a gap. Primary-key-changing updates
and source/change-log truncation are rejected. The migration database role must
be allowed to create its schema and triggers. Hashing uses PostgreSQL 16's core
`sha256(bytea)` function, so no extension-creation privilege is required.

For a low-downtime cutover, run with `ROCKSDB_MIGRATION_FOLLOW=true`, terminate
that follower, stop the old Postgres API/worker, then run once without follow
mode. Follow mode refuses an already sealed source, so a crash during final
publication must be recovered by rerunning final mode. Final mode takes an
exclusive source write fence, records an exact sealed high-water mark, replays
through that receipt, validates every compact index,
and exhaustively compares every PostgreSQL document and per-collection count in
bounded batches. Only then does it persist matching source/destination cutover
receipts and mark the RocksDB artifact `validated_complete`. A killed,
malformed, failed, or merely `in_progress` destination is refused by normal API,
worker, backup, restore, audit, and combined-process startup.

Migration export and change replay are bounded by both row count and encoded
bytes. PostgreSQL first returns only ordered identities and conservative JSON
sizes, then fetches that same prefix in a short repeatable-read snapshot; a
legal large history payload therefore cannot multiply a 5,000-row fetch into
unbounded Node memory. `ROCKSDB_MIGRATION_BATCH_BYTES` and
`ROCKSDB_CHANGE_REPLAY_BATCH_BYTES` default to the repository's 64 MiB write
limit and cannot exceed it. Row limits are capped at 10,000. Lower byte limits
are safe but must still fit the largest document present in the source plus the
4 KiB conservative canonical-envelope reserve.

PostgreSQL JSONB supports numeric precision that JavaScript and RocksDB cannot
represent. The first-release storage contract therefore rejects integer-valued
JSON numbers outside JavaScript's safe-integer range and rejects fractional
JSONB numbers unless their exact value equals the shortest decimal emitted by
the shared IEEE-754 representation. Numeric strings remain lossless and are not
subject to this IEEE-754 rule (normal indexed-field size limits still apply).
Numeric tokens are capped at 1,024 bytes to keep adversarial validation bounded.
PostgreSQL enforces this recursively with an immutable `CHECK`, and the
migrator and both verification modes read `data::text` and validate every
numeric token before `JSON.parse`; an unsafe source can never pass by comparing
two identically rounded values.

The first release has one mandatory RocksDB format (version 1) and writes
compact documents/indexes from the first row. There is no pre-v1 upgrade mode:
the migrator refuses a non-empty destination without its exact versioned
destination/run/source state. Rebuild an unversioned or incompatible artifact
from an empty path.

If the production disk cannot hold Postgres plus RocksDB at the same time, use a
dry run to inspect reclaimable secondary indexes:

```sh
yarn storage:reclaim:postgres-index-space
```

`POSTGRES_RECLAIM_MODE=large` selects the curated high-space indexes;
`POSTGRES_RECLAIM_MODE=all-secondary` selects every non-primary secondary
index. `POSTGRES_RECLAIM_EXTRA_DROP_INDEXES` and
`POSTGRES_RECLAIM_KEEP_INDEXES` accept comma-separated index-name overrides;
the keep list wins. Always inspect the dry-run output before supplying the
confirmation token.

Then explicitly disable dry-run mode to drop the selected large secondary
indexes while preserving the `(collection,id)` primary key used by the keyset
export:

```sh
POSTGRES_RECLAIM_DRY_RUN=false \
POSTGRES_RECLAIM_CONFIRM=DROP:indexer_documents-secondary-indexes \
yarn storage:reclaim:postgres-index-space
```

This is a migration tradeoff: Postgres remains authoritative, but some old
Postgres GraphQL queries may slow down until the RocksDB cutover is complete.
If you need to run a temporary Postgres-backed API after reclaiming indexes, set
`SKIP_POSTGRES_MIGRATION=true` so startup does not recreate the dropped indexes.
After the validated cutover is stable, stop change-log capture with:

```sh
yarn storage:cleanup:postgres-rocksdb-capture
```

Cleanup uses the same process-wide advisory lock as the migrator, is
transactional, and refuses to run without a sealed validated cutover receipt.
It replaces the PostgreSQL `indexer_documents` writer guard with a
self-contained permanent post-cutover fence and freezes the retained receipt,
so ordinary updates, deletes, or truncation of capture state cannot reopen the
source. The append-only change table is retained for
analysis by default. Deleting only that table is a separate choice requiring
both `ROCKSDB_DROP_CHANGE_TABLE=true` and the exact acknowledgement
`ROCKSDB_DROP_CHANGE_TABLE_CONFIRM=DROP:polkaswap_indexer_migration.rocksdb_changes`;
the writer fence and cutover state still remain.

The capture protocol protects ordinary DML and `TRUNCATE`, not a privileged
`DROP TABLE`, `ALTER TABLE`, trigger disable, or direct catalog change. Restrict
DDL and trigger-management privileges to the migration operator; the runtime
worker role should have only the DML privileges it needs.

RocksDB maintenance commands:

```sh
yarn storage:audit:rocksdb
yarn storage:verify:rocksdb
yarn storage:backup:rocksdb
ROCKSDB_CHECKPOINT_PATH=/path/on/same/filesystem/checkpoint yarn storage:checkpoint:rocksdb
ROCKSDB_BENCHMARK_PATH=/path/to/offline/checkpoint \
ROCKSDB_BENCHMARK_ITERATIONS=20 yarn storage:benchmark:rocksdb
ROCKSDB_COMPACT_PREFIX=indexes yarn storage:compact:rocksdb
ROCKSDB_COMPACT_PREFIX=all yarn storage:compact:rocksdb
ROCKSDB_BACKUP_DIR=/mnt/indexer-backups \
ROCKSDB_RESTORE_PARENT_PATH=/srv/indexer-restores \
ROCKSDB_RESTORE_BACKUP_ID=42 \
yarn storage:restore:rocksdb
```

Audit, verification, backup, checkpoint, compaction, and restore validation need
exclusive access to the embedded database. Stop `start:combined` before running
them; they fail instead of opening a second live handle. The audit proves the
exact format marker, document/count metadata, exhaustive compact-index
validation, and worker lag from the finalized chain head. A sample is diagnostic
only and cannot satisfy the release gate. Ahead-of-finalized state and
future-dated worker state are invalid. Set `ROCKSDB_AUDIT_SKIP_CHAIN=true` only
for an offline audit;
configure the lag and age bounds with `ROCKSDB_AUDIT_MAX_LAG_BLOCKS` and
`ROCKSDB_AUDIT_MAX_STATE_AGE_SECONDS`. Repeated
point reads and worker write comparisons use a bounded owned-clone cache;
`ROCKSDB_DOCUMENT_CACHE_MAX=0` disables it. Unindexed fallback queries also
fail closed after `ROCKSDB_QUERY_MAX_SCANNED_ROWS` documents instead of
materializing and sorting an unbounded collection; refine or index any query
that reaches this guard.

For low-disk maintenance, compact one completed key range rather than the whole
database. `ROCKSDB_COMPACT_PREFIX` accepts `indexes`, `documents`,
`documents:<collection>`, or explicit `all`. There is no implicit full-database
default. Compaction refuses to start below
`ROCKSDB_COMPACTION_MIN_FREE_GB`. Benchmarking likewise refuses the live
RocksDB path and requires an offline checkpoint.

`storage:backup:rocksdb` flushes the exclusive writer, includes committed WAL,
and verifies the created backup before exiting. Every backup has mandatory
native checksum verification plus a complete SHA-256 file manifest; there is no
integrity-disable mode. Restore verifies that SHA-256 receipt and the native
checksums before it creates a staging target, verifies both receipts again after
the native restore to detect concurrent source mutation, then
generates an unpredictable fresh sibling under
`ROCKSDB_RESTORE_PARENT_PATH`, validates its format and all compact indexes,
and prints the stop/switch/restart handoff. It never purges or overwrites the
live `ROCKSDB_PATH`. Use a backup directory on external storage for the first
production backup when possible; a
same-filesystem checkpoint is the safer fallback on a nearly-full root disk
because RocksDB hard-links immutable files instead of copying the full database.
Keep the old Postgres data directory until rollback is no longer required.

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
route points at the TON or Solana indexer contracts. Production smoke always
requires an available, ready, running, startup-complete worker with internally
consistent finalized, indexed, lag, heartbeat, and commit-time details.

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
