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

The UI should point `POLKASWAP_INDEXER_ENDPOINT` at the hosted GraphQL URL, for
example `https://indexer.example.com/graphql`.

## Data Model

Documents are stored in `indexer_documents` as denormalized JSON. The GraphQL
schema projects those documents into the fields consumed by Polkaswap:

- account and transaction history
- asset prices and snapshots
- pool and order-book stats
- network snapshots
- vault, staking, referral, and stream records
- point-system account metadata
- update streams for fiat prices, APY, asset registration, accounts, and order books

The chain worker reads finalized SORA blocks for transaction history and uses
SORA storage refreshes to maintain the current asset, pool, order-book, vault,
referral, staking, account-liquidity, snapshot, and stream collections. Historical
backfill starts at `CHAIN_START_BLOCK` and resumes from the stored chain state.

## Production Notes

Run the API and worker as separate processes against the same PostgreSQL
database. For a fresh production deployment, set `CHAIN_START_BLOCK` to the
earliest block you need indexed; a full-chain backfill is intentionally long.
Use `CHAIN_STATE_REFRESH_INTERVAL_BLOCKS` to control how often storage-derived
collections are refreshed during block processing, and
`CHAIN_SNAPSHOT_INTERVAL_BLOCKS` to control chart snapshot density.
