# AGENTS.md

## Project Overview

This repository is the Polkaswap indexer for `polkaswap.io`.

The service exposes a SubQuery-compatible GraphQL API for the Polkaswap UI and
keeps blockchain access server-side. The chain worker reads finalized blocks and
storage from a configured SORA2 node. Unless overridden, it connects to:

```sh
SORA_WS_ENDPOINT=wss://mof2.sora.org
```

The API and worker are separate processes that share the same PostgreSQL
database.

## Stack

- Node.js 24+
- Yarn 4 via Corepack
- TypeScript with `NodeNext` ESM output
- GraphQL Yoga plus `graphql-ws`
- `@polkadot/api` for SORA2 chain access
- PostgreSQL 16
- Vitest

## Main Entry Points

- `src/index.ts` starts the GraphQL API.
- `src/server.ts` configures GraphQL HTTP/WebSocket serving at `GRAPHQL_PATH`.
- `src/worker/index.ts` starts the chain worker.
- `src/worker/chain.ts` contains the SORA2 block indexing, event handling,
  storage refreshes, price derivation, snapshots, and update stream generation.
- `src/graphql/schema.ts` and `src/graphql/resolvers.ts` define the
  SubQuery-compatible GraphQL surface consumed by the Polkaswap UI.
- `src/repository/types.ts` defines the repository contract.
- `src/repository/postgres.ts` stores denormalized JSON documents in Postgres.
- `src/repository/memory.ts` is used by tests.

## Data Model

Documents are stored in the `indexer_documents` table. Each row is keyed by
`collection` and `id`, with `block_height`, `timestamp`, and a JSONB `data`
payload. The GraphQL schema projects those documents into collections such as:

- accounts and account point metadata
- assets and asset snapshots
- Pool XYK pools and pool snapshots
- order books, orders, and order-book snapshots
- network snapshots
- history elements and calls
- vault, staking, referral, liquidity, and update stream records

Prefer keeping collection changes compatible with the existing GraphQL field
names because the UI expects SubQuery-style names.

## Runtime Configuration

Configuration is read in `src/config.ts`.

- `HOST`, default `0.0.0.0`
- `PORT`, default `4350`
- `GRAPHQL_PATH`, default `/graphql`
- `DATABASE_URL`, default
  `postgres://polkaswap:polkaswap@127.0.0.1:5432/polkaswap_indexer`
- `SORA_WS_ENDPOINT`, default `wss://mof2.sora.org`
- `CHAIN_START_BLOCK`, default `0`
- `CHAIN_BATCH_SIZE`, default `25`
- `CHAIN_STATE_REFRESH_INTERVAL_BLOCKS`, default `250`
- `CHAIN_SNAPSHOT_INTERVAL_BLOCKS`, default `250`

The worker resumes from the stored `updatesStreams` document with id
`chainState`. If you need to re-index from an earlier block, clear or adjust that
state and any affected indexed documents before restarting the worker.

## Local Development

```sh
corepack enable
yarn install
yarn db:migrate
yarn dev
```

Run the worker separately:

```sh
yarn worker
```

Useful commands:

```sh
yarn test
yarn build
docker compose up postgres
docker compose up api worker
```

`yarn db:migrate`, `yarn dev`, and `yarn worker` require a reachable
PostgreSQL database through `DATABASE_URL`. The worker also requires the SORA2
WebSocket endpoint to be reachable.

## Implementation Notes

- Keep API and worker concerns separate. The API should read from the repository;
  the worker should write indexed documents and update chain state.
- The worker indexes finalized blocks, then subscribes to finalized heads. Avoid
  indexing non-finalized data unless the product requirement explicitly changes.
- `upsert` and `upsertMany` make writes idempotent by `collection` and `id`.
  Preserve stable document IDs when adding or changing indexed records.
- `src/worker/chain.ts` handles Polkadot codec normalization. Reuse the existing
  helpers for codec, asset id, decimal, and event parsing instead of adding
  ad-hoc conversions.
- Most numeric values exposed to GraphQL are strings to match UI expectations and
  avoid floating-point loss. Keep large chain amounts as `bigint` internally.
- Storage-derived collections are refreshed every
  `CHAIN_STATE_REFRESH_INTERVAL_BLOCKS`; snapshots are emitted according to
  `CHAIN_SNAPSHOT_INTERVAL_BLOCKS`.
- Keep GraphQL filters and ordering compatible with SubQuery-style query shapes
  used by the Polkaswap frontend.

## Verification

For code changes, run at least:

```sh
yarn test
yarn build
```

For worker changes, prefer adding focused Vitest coverage around pure helpers or
repository behavior. Live chain checks depend on `SORA_WS_ENDPOINT` and may be
slow because the worker can backfill from `CHAIN_START_BLOCK`.
