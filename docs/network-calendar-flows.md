# Network flow aggregation

Public `networkSnapshots` flow fields (`accounts`, `transactions`, `fees`,
`volumeUSD`, `swaps`, and bridge transaction counts) expose disjoint calendar
buckets when exact boundary evidence is available. `BLOCK` rows remain unchanged.
Liquidity and other stock fields remain the original observations.

Stored top-level aggregate fields keep their rolling semantics. Internal
`exploreStats.volumeDayUSD` therefore remains the rolling 24-hour value. Workers
add versioned `calendarFlows` without replacing those fields, and seal completed
buckets while canonical block evidence is retained.

The public resolver uses durable calendar flows when available. Otherwise it
corrects a stored rolling sum by subtracting its preceding-bucket prefix and
adding its missing ending blocks. Reads use bounded type/time and type/height
indexes; every correction span must contain consecutive canonical block heights.
It never scans an entire year to correct a page of daily snapshots. Per-request
boundary reads are capped at 500,000 rows in pages of at most 1,000, and correction
results use a bounded, short-lived, per-repository cache.

For range queries, proven calendar flows are clipped to `(lower, upper]` so
adjacent comparison periods count a shared boundary once. Bounded source lookups
include a partial first/last bucket even when its stored observation time lies
outside the requested range. Public cursors retain original source positions.

Inspect `flowAggregation` before treating old history as additive:

- `CALENDAR`: exact disjoint flow interval, described by `flowBucketStart`
  (inclusive) and `flowBucketEnd` (exclusive).
- `BLOCK`: canonical per-block values.
- `LEGACY_ROLLING`: required historical boundary evidence has expired. Existing
  values are preserved for compatibility; they must not be summed as exact
  calendar buckets. The API does not substitute zero or invent historical data.

Missing blocks within the retained correction range produce the explicit
`NETWORK_FLOW_COVERAGE_UNAVAILABLE` error. Expired history is distinguished from
such corruption. Fee/volume predicates and ordering require an exact `BLOCK`
type filter because filtering rolling aggregate values before rebucketing would
give incorrect connection membership and pagination.
