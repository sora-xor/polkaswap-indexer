# AGENTS.md

## Project Overview

This repository is the Polkaswap indexer for `polkaswap.io`.

The service exposes a SubQuery-compatible GraphQL API for the Polkaswap UI and
keeps blockchain access server-side. The chain worker reads finalized blocks and
storage from a configured SORA2 node. Unless overridden, it connects to:

```sh
SORA_WS_ENDPOINT=wss://mof2.sora.org
```

The production topology uses embedded RocksDB. The API and worker run in one
combined process and share one repository handle. PostgreSQL remains the
migration source and a reference/development backend; its split API/worker
topology is not the RocksDB production deployment. See `README.md` for migration,
validation, backup, and supervised deployment procedures.

### Production stats API deployment target

The shipped Polkaswap configuration currently sets `POLKASWAP_INDEXER_ENDPOINT`
to `https://pi.soramitsu.io/graphql`, served by the approved Pi host
`207.254.29.218` (MOF). Check the live `env.json` before each API release and verify
against the endpoint the browser actually uses. The separate MOF GraphQL
service and `wss://ws.mof.sora.org` RPC node are distinct services; a successful
MOF API rollout does not update Pi's GraphQL service.

For an API-only correction, inspect Pi's actual launcher, process owner, release
path, and RocksDB lock before stopping or replacing that service. Preserve
Pi's deployed functionality and persistent database. Confirm the public Pi
schema, health, canonical BLOCK totals, and the browser's exact stats queries
after restart. No frontend/IPFS publication is needed for an API-only change.
For the one-shot trading-volume repair, follow
`docs/network-volume-repair.md` and complete the offline
repair before starting a calendar-enabled worker.

## Stack

- Node.js 24+
- Yarn 4 via Corepack
- TypeScript with `NodeNext` ESM output
- GraphQL Yoga plus `graphql-ws`
- `@polkadot/api` for SORA2 chain access
- Embedded RocksDB via `@harperfast/rocksdb-js` for production storage
- PostgreSQL 16+ for migration sources and reference/development storage
- Vitest

## Main Entry Points

- `src/combined.ts` starts the production API and chain worker with one shared
  RocksDB repository handle.
- `src/index.ts` starts the standalone PostgreSQL-backed GraphQL API.
- `src/server.ts` configures GraphQL HTTP/WebSocket serving at `GRAPHQL_PATH`.
- `src/worker/index.ts` starts the standalone PostgreSQL-backed chain worker.
- `src/worker/chain.ts` contains the SORA2 block indexing, event handling,
  storage refreshes, price derivation, snapshots, and update stream generation.
- `src/graphql/schema.ts` and `src/graphql/resolvers.ts` define the
  SubQuery-compatible GraphQL surface consumed by the Polkaswap UI.
- `src/repository/types.ts` defines the repository contract.
- `src/repository/rocksdb.ts` stores compact documents and query-specific indexes
  in native RocksDB.
- `src/repository/postgres.ts` implements the PostgreSQL reference backend.
- `src/scripts/migrate-postgres-to-rocksdb.ts` owns the captured, sealed, and
  exhaustively verified PostgreSQL-to-RocksDB cutover.
- `src/repository/memory.ts` is used by tests.

## Data Model

Documents share a repository contract keyed by `collection` and `id`, with
block height, timestamp, and a `data` payload. Production RocksDB stores compact
document envelopes and secondary indexes under `ROCKSDB_PATH`, restoring
deduplicated fields when reading. The PostgreSQL reference/source representation
uses `indexer_documents` with `block_height`, `timestamp`, and JSONB `data`.
The GraphQL schema projects those documents into collections such as:

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

- `STORAGE_ENGINE`: set explicitly to `rocksdb` for production; the configuration
  default remains `postgres` for reference/development commands
- `ROCKSDB_PATH`, default `./data/polkaswap-indexer.rocksdb`; production must use
  its explicit persistent database path
- `HOST`, default `0.0.0.0`
- `PORT`, default `4350`
- `GRAPHQL_PATH`, default `/graphql`
- `DATABASE_URL`, used by PostgreSQL migration/reference commands, default
  `postgres://polkaswap:polkaswap@127.0.0.1:5432/polkaswap_indexer`
- `SORA_WS_ENDPOINT`, default `wss://mof2.sora.org`
- `CHAIN_START_BLOCK`, default `0`
- `CHAIN_BATCH_SIZE`, default `25`
- `CHAIN_STATE_REFRESH_INTERVAL_BLOCKS`, default `25`
- `CHAIN_SNAPSHOT_INTERVAL_BLOCKS`, default `25`
- `CHAIN_SNAPSHOT_RETENTION_MODE`, default `all`; `rolling` explicitly reduces
  historical snapshot availability

The worker resumes from verified `updatesStreams/chainState` and
`updatesStreams/chainIdentity` checkpoints. Never blindly clear or rewind
`chainState`, business counters, or indexed history. Re-index into an isolated
artifact, or use an explicit verified repair procedure, and preserve the source
and its receipts until validation proves the replacement.

## Local Development

```sh
corepack enable
yarn install
yarn build
STORAGE_ENGINE=rocksdb ROCKSDB_PATH=./data/polkaswap-indexer.rocksdb yarn start:combined
```

Use an empty RocksDB path for a fresh indexer. To retain an existing PostgreSQL
history, follow the captured migration and verification procedure in `README.md`
before starting the combined process.

For the PostgreSQL reference/development topology, use a reachable
`DATABASE_URL`, migrate once, and start the API and worker separately:

```sh
yarn db:migrate
yarn dev
# In another terminal:
yarn worker
```

Useful commands:

```sh
yarn test
yarn build
docker compose --profile rocksdb up --build
docker compose --profile postgres up --build
```

The two complete Compose profiles are mutually exclusive because both publish
port `4350`. Standalone API and worker entry points reject RocksDB; use the
combined entry point for that backend. Chain workers require a reachable SORA2
WebSocket endpoint and enforce the reviewed chain identity and history anchor.
Production workers also require an independently validated archive endpoint.

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
