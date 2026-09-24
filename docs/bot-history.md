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

## Release and historical coverage

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
chain state. This release does not perform that backfill. The frontend has a
legacy-query fallback while servers roll out the optional field; legacy historical
verification still requires unchanged archival denomination state (or a current
cumulative coefficient of one).

Rollback to the prior API/worker is safe: documents may retain the additional
field, the old schema ignores it, and clients can use the legacy query. Keep all
existing deployment evidence and worker-health requirements intact.
