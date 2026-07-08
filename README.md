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

By default the worker reads finalized SORA blocks from `wss://mof2.sora.org`.

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
timestamp, block-height, equality, and numeric sort query shapes, while falling
back to compatible in-process filtering for uncommon GraphQL filters.

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
Use `CHAIN_STATE_REFRESH_INTERVAL_BLOCKS` to control how often storage-derived
collections are refreshed during block processing, and
`CHAIN_SNAPSHOT_INTERVAL_BLOCKS` to control chart snapshot density. Both default
to `25` so stats aggregates stay close to finalized block progress.

For RocksDB production deployment, use `start:combined` instead of separate API
and worker processes. RocksDB is embedded local storage; the API and worker must
share one process-local repository handle for fresh reads and safe writes.
On the MacStadium host, install `ops/run-combined.sh` as
`/Users/administrator/apps/polkaswap-indexer/run-combined.sh` and supervise it
with `ops/org.polkaswap.indexer.plist` under `/Library/LaunchDaemons`.

The Postgres-to-RocksDB migrator installs a temporary Postgres trigger/table
under `polkaswap_indexer_migration` before the export starts. This captures
concurrent inserts, updates, and deletes while the keyset export runs. For a
low-downtime cutover, run it once with `ROCKSDB_MIGRATION_FOLLOW=true`, stop the
old Postgres processes, run it once more without follow mode to replay the final
change-log tail, then verify and start `start:combined`.

If the production disk cannot hold Postgres plus RocksDB at the same time, use a
dry run to inspect reclaimable secondary indexes:

```sh
yarn storage:reclaim:postgres-index-space
```

Then explicitly disable dry-run mode to drop the selected large secondary
indexes while preserving the `(collection,id)` primary key used by the keyset
export:

```sh
POSTGRES_RECLAIM_DRY_RUN=false yarn storage:reclaim:postgres-index-space
```

This is a migration tradeoff: Postgres remains authoritative, but some old
Postgres GraphQL queries may slow down until the RocksDB cutover is complete.
If you need to run a temporary Postgres-backed API after reclaiming indexes, set
`SKIP_POSTGRES_MIGRATION=true` so startup does not recreate the dropped indexes.
After the cutover is stable, remove the trigger with:

```sh
yarn storage:cleanup:postgres-rocksdb-capture
```

RocksDB maintenance commands:

```sh
yarn storage:backup:rocksdb
ROCKSDB_BACKUP_VERIFY_CHECKSUM=true yarn storage:backup:rocksdb
ROCKSDB_CHECKPOINT_PATH=/path/on/same/filesystem/checkpoint yarn storage:checkpoint:rocksdb
yarn storage:compact:rocksdb
ROCKSDB_RESTORE_BACKUP_ID=<id> yarn storage:restore:rocksdb
```

`storage:backup:rocksdb` verifies the created backup before exiting. Checksum
verification is optional because it reads the full backup payload. Use a backup
directory on external storage for the first production backup when possible; a
same-filesystem checkpoint is the safer fallback on a nearly-full root disk
because RocksDB hard-links immutable files instead of copying the full database.
Keep the old Postgres data directory until rollback is no longer required.

Before enabling production routing, run the smoke check against the public
GraphQL endpoint:

```sh
POLKASWAP_INDEXER_BASE_URL=https://pi.soramitsu.io/graphql yarn smoke:production
```

The smoke query requires `_health` to identify this service as
`serviceId=pi.soramitsu.io`, `ecosystem=sora2`, `chainId=sora:mainnet`,
`network=mainnet`, `schemaVersion=1`, `readOnly=true`, and
`publicBaseUrl=https://pi.soramitsu.io/graphql`. It intentionally fails if the
route points at the TON or Solana indexer contracts.
