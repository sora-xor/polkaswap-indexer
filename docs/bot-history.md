# Bot backtest denomination evidence

`assetSnapshots.edges.node.denominator` is an optional GraphQL `String`. It is
the cumulative chain denomination coefficient at the state used to derive the
snapshot's `priceUSD.close`. The worker reads it from the same immutable query
context used for that snapshot; it never substitutes the latest chain state for
a historical query. Failed, pruned, absent, or malformed storage produces `null`.

The field applies to the CLOSE price only. It does not attest that an OHLC bucket
is free of denomination transitions, and it does not normalize historical prices.
Snapshots retain their current identifiers and actual last-update timestamps.
Clients group those timestamps by the requested HOUR/DAY bucket and consume only
completed buckets. They must preserve decimal-string prices and must not use
floating-point chart adapters for strategy simulation.

A client with a present-day allocation can use completed snapshots whose
coefficient agrees with the current finalized chain coefficient. Pair prices and
any separately valued fee asset must have the same verified coefficient. Missing
or inconsistent evidence must reduce reported coverage or stop the backtest; it
must not be interpreted as coefficient one.

## Completed hourly evidence

The worker starts with XOR, VAL, PSWAP, DAI, KUSD, LLD and LLM, and adds assets
from complete finalized XOR pool state when both reserves are positive and the
XOR reserve exceeds one natural XOR. This covers a superset of the frontend's
whitelist-based eligibility without consulting a market API. A validated catalogue
of at most 512 distinct IDs is stored in `updatesStreams/hourlyHistoryTargets-v1`.
Already tracked or explicitly imported targets remain tracked if their pools later
disappear or lose liquidity. The catalogue and completed hourly rows are committed
with the finalized block transaction; failed transactions cannot advance tracking.

Each completed UTC hour uses the actual adjacent finalized blocks, the preceding immutable
valuation state and its denomination. `assetSnapshots.closeEvidence` records
that source and the same-state direct XOR pool reserves and precision when
available. It corrects CLOSE while retaining existing open/high/low, volume and
supply fields. Unavailable metadata or prices remain explicit; chain halts create
no synthetic observations. Ordinary projections cannot replace a finalized CLOSE,
and rolling retention preserves all tracked assets' HOUR rows. The production
`all` retention mode continues preserving every historical snapshot.

`assetHourlyCoverage(assetId: String!, start: Int!, end: Int!)` reports metadata
for 1–2160 completed UTC hours from indexed storage. Missing, legacy, invalid,
unknown-pool, absent-pool and zero-reserve buckets remain distinct. Verified
boundary evidence and usable direct pools are separate counts; clients must join
the relevant assets by matching block and denomination evidence. The API makes
no chain RPC and returns no prices or strategy results from this field.
It accepts canonical asset IDs outside the initial seven; missing history remains
missing. Historical metadata supplies each token's actual symbol and precision,
including symbol changes, while the canonical original assets retain identity checks.

## Explicit historical repair

Prepare a bounded public artifact from the approved SORA mainnet archive:

```sh
node dist/src/scripts/backfill-hourly-history.js --hours=369 --end=2026-10-01T00:00:00Z --output=/absolute/private/prepared-hours.jsonl
```

Without an explicit target catalogue, artifact version 1 continues to mean the
original seven assets. To collect a different bounded scope, pass
`--targets=/absolute/private/targets.json`, containing an array of
`{"id":"0x…","symbol":"TOKEN"}` descriptors. The collector writes a version 2
manifest with that exact target scope; incidental USD pricing-route assets do not
become targets. The target catalogue validates before chain reads, and the complete
artifact validates before database writes. Each hour has one document per target,
including explicit unavailable metadata or price evidence. Existing version 1
artifacts and completion receipts retain their original scope and interpretation.
Completed version 2 imports merge their targets into the worker's durable catalogue
only after every imported hour verifies. Preparation remains subject to the existing
artifact, line, pool and route budgets; split a larger request into bounded artifacts.

Use an exact completed UTC hour supported by the archive. Preparation is read-only
and checks mainnet identity, the reviewed anchor, adjacent blocks and historical
state. Keep the resulting SHA-256 and complete artifact; partial output cannot
authorize application. Preserve a native database checkpoint before repair.

`CHAIN_HOURLY_REPAIR_FILE` and `CHAIN_HOURLY_REPAIR_SHA256` activate that verified
artifact through the existing combined worker's one repository handle before
normal catchup. The entire artifact validates before writing; each hour writes
atomically and is reread. Interrupted repair safely resumes and records completion
only after every hour verifies. It leaves `chainState` and current asset projections
unchanged and never assigns current denomination to legacy prices. Do not open
another RocksDB writer or run the PostgreSQL standalone worker against native data.

Deploy the API and worker together, retaining the usual health, source custody and
rollback controls. The additions require no collection or index migration. Repair
is an explicit operation; restoring the API does not upgrade historical evidence.
After repair, query the same bounded coverage window and preserve its gap statuses.
