# Offline network stock repair

`src/scripts/network-stock-repair.ts` fills missing stock values in existing
`networkSnapshots` aggregates using independently reconstructed, historical
SORA Nexus archive observations. It does not collect chain data, open a database,
start a worker, or provide a command-line entry point. An operator supplies the
qualified artifact and an exclusive repository handle.

This procedure addresses aggregates whose flow fields exist but whose stock
fields are absent or `null`. A row-presence audit alone cannot detect this gap:
the Statistics TVL query excludes rows without positive `liquidityUSD`.

## Permitted changes

Only these six fields may be filled:

| Field | Representation |
| --- | --- |
| `liquidityUSD` | Nonnegative decimal string, at most eight fractional places |
| `poolLiquidityUSD` | Same |
| `orderBookLiquidityUSD` | Same |
| `activePools` | Nonnegative integer |
| `activeOrderBooks` | Nonnegative integer |
| `listedAssets` | Nonnegative integer |

Existing matching values are retained. Any conflicting present value aborts the
entire plan before writing. Total liquidity must equal pool plus order-book
liquidity using exact eight-place integer arithmetic. Counters and chain
positions must fit the public signed GraphQL `Int` range.

The module preserves each complete document envelope and every unrelated field,
including volume, fees, transaction counters, and other flows. It does not create
missing aggregate documents, rewrite canonical `BLOCK` snapshots, replay flows,
rewind `chainState`, or change `chainIdentity`.

## Artifact and provenance

The artifact has this shape; `stock` must contain exactly the six fields above:

```ts
{
  kind: 'network-stock-repair-v1',
  genesisHash: '0x7e4e32d0feafd4f9c9414b0be86373f9a1efa904809b683453a9af6856d38ad5',
  archiveEndpoint: 'https://mof2.sora.org/',
  generatedAt: '<canonical ISO timestamp>',
  inventoryTypes: ['DEFAULT', 'HOUR', 'DAY'],
  observations: [{
    id: 'network-all-HOUR-<bucket-start-seconds>',
    type: 'HOUR',
    blockHeight: 0, // Replace with the positive canonical source height.
    timestamp: 0,   // Replace with that block's positive timestamp in seconds.
    blockHash: '<nonzero lowercase 0x-prefixed 32-byte hash>',
    stock: { /* exactly the six stock fields */ },
    proof: {
      kind: 'archive-network-stock',
      genesisHash: '<same genesis hash>',
      archiveEndpoint: 'https://mof2.sora.org/',
      blockHash: '<same block hash>',
      blockHeight: 0, // Must equal the observation.
      timestamp: 0,   // Must equal the observation.
      // Retained collector evidence may add input paths, hashes and counts.
    },
  }],
}
```

`DEFAULT`, `HOUR`, and `DAY` use 300-, 3,600-, and 86,400-second UTC buckets.
Each ID must use the observation timestamp rounded down to its bucket boundary;
the bucket must have completed before `generatedAt`. IDs must be unique.
`inventoryTypes` is optional for hourly/daily artifacts, but every observation
must belong to it when present, and `DEFAULT` always requires explicit inventory.
The module accepts 1–600 observations in at most 2 MiB, with additional JSON
complexity bounds. It rejects unsafe object shapes, accessors, cycles, invalid
timestamps, and future generation times.

The collector must independently verify the archive's chain identity, reviewed
history anchor, finalized bound, and each source block's hash, height, and
timestamp. Reconstruct stocks from the **post-block state at the original
aggregate block**, using complete asset metadata, XYK reserves, and order-book
state with the production valuation rules and exact token arithmetic. Retain raw
inputs and SHA-256 hashes over their exact file bytes, including any final
newline. Never infer that order books are empty without querying their state.
Do not substitute current state, interpolate neighboring values, or copy a
`BLOCK` snapshot's potentially different valuation state.

The module checks proof identity and its binding to the observation; it does not
perform RPC requests or independently verify raw input files or storage proofs.
Hash verification, reconstruction, inventory completeness, and intact control
comparisons belong to the collection and operational harness. Retain those
receipts alongside the artifact. A top-level `controls` extension may carry
independently reconstructed intact neighbors for the harness to check; the
module itself does not interpret that extension.

## Module API

| Export | Behavior |
| --- | --- |
| `validateNetworkStockRepairArtifact(input, nowSeconds?)` | Validates a plain JSON object and returns a detached copy. |
| `parseNetworkStockRepairArtifact(text, nowSeconds?)` | Bounds UTF-8 size, parses JSON, and validates it. |
| `planNetworkStockRepair(repository, artifact)` | Validates every target and canonical source, retaining complete originals and constructing a read-only plan. No writes. |
| `applyNetworkStockRepair(repository, plan)` | Rechecks retained originals, writes replacements, and verifies complete target and source documents. |

Planning requires each existing target and `networkSnapshots/block-<height>`
source to have the expected collection, ID, type, height, and timestamp, including
the document's data envelope. If stored `blockHeight` or `blockHash` data fields
exist, they must also match. A missing source, missing target, or position mismatch
aborts planning.

A plan reports `observations`, `changedRows`, `unchangedRows`, and the exact field
names changed for each ID. Its write payload is private to the issuing module
instance; a forged or copied summary cannot authorize writes. Apply rechecks all
original target and source documents before one bounded `upsertMany` call. The
production RocksDB implementation commits that batch atomically. Full-document
reads after application detect both incorrect writes and changes to unrelated
fields or canonical sources.

Plan again after application to verify idempotence: a fresh plan must report zero
changed rows and all observations unchanged. Do not reuse the old plan after its
original documents have changed. The repository interface has no compare-and-swap
operation, so these checks do not replace exclusive offline access.

## Operational procedure

1. Confirm the live frontend's `env.json` and actual GraphQL requests. Inspect
   the approved Pi host's exact launcher, process owner, release, database path,
   and RocksDB `LOCK` owner. Preserve the deployed release and persistent DB;
   stage only the reviewed repair module and harness outside that release.
2. Inventory every affected aggregate type and ID, retaining complete original
   rows and canonical source positions. Qualify the archive artifact, verify its
   exact SHA-256, and compare reconstructed stocks with intact neighboring rows.
   An incident-specific harness should require the expected complete inventory,
   rather than treating the module's 600-row limit as evidence of completeness.
3. Stop only the verified combined service gracefully. Confirm its process has
   exited, API listener is closed, and no process holds the exact database lock.
   Do not run a second worker, PostgreSQL worker, or repair against an open
   production RocksDB handle.
4. Create a native RocksDB checkpoint before writing, then create a separate
   rehearsal checkpoint from it. Keep the first checkpoint untouched. Validate
   the current artifact format and retained chain state/identity before opening
   either candidate or production for repair.
5. On the rehearsal checkpoint, compare intact controls, plan, inspect the
   precise changes, apply, verify complete rows, and require a fresh idempotent
   plan. Compare complete `chainState`, `chainIdentity`, and control rows before
   and after. Any mismatch stops the production step.
6. Repeat the same qualification and application against production using its
   exclusive repository handle. Retain phase receipts, artifact and module
   hashes, original checkpoint, rehearsal database, and operation logs. A
   verification error requires inspection; do not blindly rerun or overwrite
   existing evidence.
7. Close the repair handle and restart the same combined service. Arrange service
   restoration even if repair fails. Confirm public health and worker readiness,
   canonical `BLOCK` totals, and the browser's exact Statistics TVL queries.
   Check the affected time ranges in the mounted Statistics page and retain
   before/after evidence. This data-only repair needs no frontend/IPFS release.

The October 17, 2026 incident inventory contains 439 aggregates: 404 `DEFAULT`,
33 `HOUR`, and 2 `DAY`, representing 404 distinct source blocks. Its operational
harness additionally requires two independently reconstructed intact controls,
checks the native database format, retains pre-repair and rehearsal checkpoints,
and records chain-state and full-row verification. Those incident-specific
requirements are stricter than the reusable module API.

This repair does not deploy a worker change or add automatic historical stock
reconstruction to future catch-up processing. Diagnose that behavior separately
if it recurs.

## Validation

`tests/network-stock-repair.spec.ts` covers 33 cases, including stock-only fills,
full-row preservation, mixed present/missing values, canonical source validation,
artifact bounds, conflict aborts, mutation detection, forged plans, backend
corruption, and fresh-plan idempotence. The focused tests and `yarn build` passed
for this implementation.

The first full `yarn test` run recorded 2,101 passed, 25 skipped, and six timeout
failures in native RocksDB/process suites. All six affected suites then passed
with no code changes: 64 tests using `--testTimeout=120000
--hookTimeout=120000 --maxWorkers=2`. The initial full run should remain recorded
as having failed; the targeted rerun qualifies those failures without claiming a
second complete suite run.
