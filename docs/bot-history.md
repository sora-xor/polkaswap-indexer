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

## Durable completed hours

The mainnet worker retains completed HOUR observations for XOR, VAL, PSWAP, DAI,
KUSD, LLD, and LLM without the ordinary chart retention limit. Other assets and
chart types retain their existing limits. The canonical addresses are declared
in `src/worker/hourly-history.ts`.

Each finalized block checks whether its timestamp crosses an hour boundary. When
it does, the worker reads the preceding block's immutable valuation state and
denomination, then commits all seven observations in the same transaction as the
new block's checkpoint. This path also runs during startup catchup, regardless of
the periodic projection cadence. Ordinary chart samples continue while the hour
is open. A delayed or coalesced projection cannot replace its finalized CLOSE:
the canonical document uses the adjacent successor's height as its write version.
A failed state read or write prevents checkpoint advancement so the same boundary
can be retried.

`assetSnapshots.closeEvidence` is optional JSON containing the actual source
block, its adjacent finalized successor, the completed hour, mainnet genesis,
historical symbol and decimals, and availability. Exact reserve strings from the
winning price route are retained when available. Unpriced assets retain up to 16
directly observed pools and report truncation explicitly. `marketStatus`
distinguishes an eligible price, observed liquidity without an eligible route,
and no observed positive pool; it does not assert that every possible market was
searched. The existing stable anchors and liquidity gates remain unchanged.

Every major token receives a source observation even when its metadata or price
is unavailable. Such a row has a null CLOSE and an explicit availability reason;
zero is not used as a substitute price. Coverage reports must distinguish absent
observations from observations without an eligible price. A chain halt with no
block in an hour produces no synthetic observation for that hour.

The collector and repair process preserve any existing open/high/low, supply,
mint/burn, and volume values exactly. Only CLOSE is corrected from the proved
state, with its denomination and source evidence. A new observation supplies
only CLOSE, never invented OHLC extrema or flow totals. Stored document height
uses the successor height, or a later legacy height to satisfy repository
ordering; the exact source height is always `closeEvidence.blockHeight`.

### Direct XOR pair marks

The global USD price is a chart valuation: DAI, KUSD and XSTUSD are fixed USD
anchors, and the winning discovery route can change between hours. Dividing two
such USD prices is not evidence of the directly executable token pair.

New completed-hour evidence includes `closeEvidence.xorPool`, independently of
`priceUSD` and its existing `pools` route. A present object has `baseAssetId` (XOR),
`targetAssetId` (this row's asset), exact unsigned codec strings
`baseAssetReserves` and `targetAssetReserves`, plus `baseDecimals` and
`targetDecimals` from this same block's metadata. A single reverse-oriented stored
pool is normalized by swapping its reserves. Duplicate pairs or both stored
orientations are ambiguous and reject the boundary; no DEX route is inferred.
Observed zero reserves remain zero and cannot support a usable market mark.

`xorPool: null` means a complete same-state pool observation found no direct pair
(also used for the XOR row itself). An absent field means unknown legacy coverage
or unavailable metadata/pools. Previous direct-pair evidence is never carried
into an unavailable new observation. The live collector sets
`xorPoolsComplete: true` only from its complete immutable pool map; historical
artifacts must explicitly retain that marker and all required direct XOR pools.
Older artifacts remain readable but cannot acquire synthetic absence evidence.

Clients must validate the common finalized block, adjacent successor, genesis,
denomination, precision and asset identities before deriving ratios. Natural
reserves use their respective decimals. For KUSD input and XOR output, both the
pair close and XOR fee close are natural KUSD reserve / natural XOR reserve.
Neither USD stable anchors nor a winning USD route may replace a missing pair.

## Historical repair and release

Historical repair is explicit. `CHAIN_HOURLY_REPAIR_FILE` and
`CHAIN_HOURLY_REPAIR_SHA256` must be provided together. The sole worker repository
owner verifies and applies the artifact before ordinary catchup and subscription;
it does not open a second writer, reset the chain checkpoint, or change the latest
asset projection. The preparation and application tool uses the same pricing and
hour-close helpers as the live collector. It validates historical denomination
and adjacent block evidence instead of labelling legacy prices with the current
denomination. Preserve a database checkpoint and record the artifact checksum and
coverage evidence with the deployment.

The schema additions are nullable and require no collection or index migration.
Deploy the API and worker together and verify the production GraphQL response.
Rolling back the collector also restores its old eight-day HOUR cleanup behavior,
so a rollback must keep retention disabled for these repaired major-token rows
or restore the matching pre-release checkpoint deliberately.

## Original denomination-only rollout

This is an additive schema/document change. There is no SQL migration, collection
change, new index, writer reset, or destructive backfill. Deploy the API and worker
from the same release following `docs/release-checklist.md`; the usual production
smoke against `https://pi.soramitsu.io/graphql` remains required. New worker
snapshots acquire evidence on the next scheduled snapshot refresh. Updating an
existing bucket attaches evidence to its newly derived CLOSE price, not to an old
price. Existing closed historical buckets remain unverified (`null`).

Do not stamp old snapshots with the present coefficient to accelerate rollout.
Backfill requires exact historical state at each recorded snapshot block, or a
separately validated complete denomination-event history anchored to finalized
chain state. The original release did not perform that backfill. The frontend has a
legacy-query fallback while servers roll out the optional field; legacy historical
verification still requires unchanged archival denomination state (or a current
cumulative coefficient of one).

Rollback to the prior API/worker is safe: documents may retain the additional
field, the old schema ignores it, and clients can use the legacy query. Keep all
existing deployment evidence and worker-health requirements intact.
