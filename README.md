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
Use `CHAIN_STATE_REFRESH_INTERVAL_BLOCKS` to control how often storage-derived
collections are refreshed during block processing, and
`CHAIN_SNAPSHOT_INTERVAL_BLOCKS` to control chart snapshot density. Both default
to `25` so stats aggregates stay close to finalized block progress.
