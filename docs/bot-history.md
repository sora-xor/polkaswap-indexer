# Bot backtest denomination evidence

`assetSnapshots.edges.node.denominator` is an optional GraphQL `String`. It is
the cumulative chain denomination coefficient at the state used to derive the
snapshot's `priceUSD.close`. The worker reads it from the same immutable query
context used for that snapshot; it never substitutes the latest chain state for
a historical query. Failed, pruned, absent, or malformed storage produces `null`.

Hourly replay has one explicit historical exception: original SORA Nexus units
before the denomination pallet existed. Commit
`93cf5ca2f2e147924b5e3475e155eb01a68f7d8d` introduced the pallet at runtime 113
with `Denominator` defaulting to `One::one()`. The first denomination occurred
at block 21,063,093; its parent 21,063,092 is
`0xf47edd8d25943b4c11d0b07f722c85aecb33525f6a70139c41195e2672a0b62f`
(see the chain repository's `misc/incident_recovery/capture_offence_preimages.mjs`).
Only within that earlier canonical mainnet interval, for `sora-substrate`
runtimes 1–113, may an hourly close record `1`: its own pinned metadata must
explicitly lack the Denomination pallet, and a raw read of the exact historical
Denominator key must return absence. Both checked RPC roles must agree on the
close's exact block hash. A missing query context, a declared but unreadable
pallet, a present raw key, or any later runtime remains unknown and stops the
hourly replay. The generic snapshot reader still never substitutes `1`.

The original metadata at block 90 (hash
`0xa07c08f83b432f84a3e98746bd7d0844bd5ea9eb328f989a7cb814951cdd2a1f`)
is version 12, runtime 1, and contains no Denomination pallet. Its raw metadata
SHA-256 is `e0b721141bc2ef0ab0eee2167d1800d8d14ec0cbe27f61752b10d9543a8d0eda`.
This is the first hourly boundary encountered by a genesis replay (block 91).

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
valuation state and its denomination. The worker reads that state's complete asset
metadata and Pool XYK reserves from storage pinned at the hour's last block; it does
not reuse its incrementally advanced valuation state as evidence.
`assetSnapshots.closeEvidence` records that source and the same-state direct XOR
pool reserves and precision when available. The close corrects CLOSE while retaining
existing open/high/low, volume and supply fields. Closes written by workers released
before this rule can carry stale reserves and prices after XYK swaps; repair them
with a verified archive artifact as described below. Unavailable metadata or prices remain explicit; chain halts create
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


Historical asset metadata uses the map declared by the pinned runtime. Before
`AssetInfosV2`, the indexer accepts the original four-field `AssetInfos` tuple
and its later six-field form with optional text content source and description;
all other tuple shapes remain invalid. The exact SCALE fixture from block
5,000,000 (runtime 30) is
`tests/fixtures/historical-assets/asset-infos-six-field.json`. The six-field
source layout is recorded in chain commit `3ea532728` (ContentSource/Description
migration, 11 February 2022), and retained alongside V2 by `a6ad32345`.
The extra text fields do not change precision, supply or price arithmetic.
