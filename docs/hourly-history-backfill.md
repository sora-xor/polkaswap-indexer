# Repairing finalized hourly price history

The preparation command reads public finalized SORA state from the approved
`https://mof2.sora.org/` archive. It never opens PostgreSQL or RocksDB and never
reads wallet accounts or signing keys. Prepare an initial seven-day window or
the full retained ninety-day window while the existing indexer remains running:

```sh
node_modules/.bin/tsx src/scripts/backfill-hourly-history.ts --hours=168 --output=/absolute/path/hourly-168.jsonl
node_modules/.bin/tsx src/scripts/backfill-hourly-history.ts --hours=2160 --output=/absolute/path/hourly-2160.jsonl
```

The compiled equivalent is `node dist/src/scripts/backfill-hourly-history.js`.
An optional `--end=2026-09-19T03:00:00Z` pins an exact UTC hour. Without it, the
last complete hour at the captured finalized head is used. Limits are 1–2160
hours, 128 KiB per line and 32 MiB per completed artifact. Progress reports
prepared hours, elapsed seconds, RPC counts and HTTP batch counts. Independent
reads are grouped into batches of at most 32, with twelve hours in flight;
every storage read still uses that hour's immutable historical block hash.

The output is written to a new `.partial` file, flushed, and atomically linked
to the requested final path only after all records validate. Existing output
files are never replaced. Failed partial files remain available for inspection;
use a new output path when retrying. The successful receipt prints the exact
artifact SHA-256, hour/document counts, and `missing` counts for unavailable
eligible prices by token. Those counts describe missing **prices**, not missing
observations: all seven assets have an observation with a truthful availability
status. A null close never becomes a fabricated quote.

Each hour carries the exact SORA genesis, positive historical denomination,
historical asset precision, and adjacent canonical block hashes and timestamps
that bracket the close. The successor's parent hash must equal the closing
block's hash, and both must be within the captured finalized ceiling. The shared
liquidity-gated price formula uses metadata and pool reserves from the closing
block. Only relevant winning-route reserves, unavailable-asset diagnostics and
their metadata are retained in the artifact. A halted or missing hour cannot be
filled by carrying an earlier price forward.

## Applying through the existing database owner

Activation is separate from preparation. Do not run a second repair process
against the live RocksDB path. The combined worker reads these optional settings
at startup and applies the artifact through its existing repository handle:

```sh
CHAIN_HOURLY_REPAIR_FILE=/absolute/path/hourly-2160.jsonl
CHAIN_HOURLY_REPAIR_SHA256=<exact SHA-256 printed by preparation>
```

Use the established graceful-stop and native RocksDB checkpoint procedure before
the release cutover. A checkpoint shares existing SST files and avoids a full
database copy. The checkpoint utility requires the live writer to be stopped;
it must not be used as a second writer against a running service.

The startup hook runs before catchup or subscriptions can write snapshots. It
checks the entire byte-bounded file, checksum, active genesis and finalized
ceiling before the first mutation. It merges only canonical `assetSnapshots`
HOUR rows, preserving existing open/high/low, volume, supply and other flow
fields exactly. The verified close, denomination and close provenance are
corrected. New rows contain only the observations actually known. Current
`assets`, other snapshot types and the `chainState` checkpoint are untouched.

Each hour is a bounded idempotent write batch followed by a readback check.
Interrupted activation can safely replay the same file: matching hours are
skipped and remaining hours are completed. A distinct
`updatesStreams/hourlyHistoryRepair-v1-<sha256>` receipt is written only after
all hours verify. A completed receipt makes subsequent startup replay a no-op.
Remove the optional activation settings after verifying the release.

Preparation captures its end hour before doing historical reads. If a long run
crosses an hour before cutover, prepare a short recent tail too and validate a
combined window before activation; otherwise the old worker's advancing
checkpoint may leave an unrepaired interval between the artifact and the new
collector. Never rewind the checkpoint to close that gap.

## Validation

`tests/hourly-backfill.spec.ts` covers adjacent finalized boundaries, exact decimal
values, bounds, unavailable prices, required archive pagination arguments,
read-only RPC restrictions, the real CLI import path without network access,
full-file validation before writes, preserved existing data, checksum/chain
rejection, crash replay and idempotence. All database tests use MemoryRepository.
Live preparation is read-only release evidence; it is separate from activation.
