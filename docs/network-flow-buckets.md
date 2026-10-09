# Network flow buckets

The October 7, 2026 stats API correction separates additive calendar flows from stored rolling observations. It changes neither prices, fee rules, token denomination, nor the operations included in network volume.

## API semantics

`networkSnapshots` projects seven flow fields into disjoint intervals when canonical evidence proves coverage: `accounts` (accounts first seen), `transactions`, `fees`, `volumeUSD`, `swaps`, `bridgeIncomingTransactions`, and `bridgeOutgoingTransactions`. DEFAULT, HOUR, DAY, and MONTH retain fixed 300-second, 3,600-second, 86,400-second, and 30-day bucket identities; MONTH is not a civil calendar month. Fees remain codec strings and USD volume remains a natural decimal string. Aggregation uses exact integer arithmetic.

The response includes:

- `flowAggregation: CALENDAR` for a verified bucket or requested-range portion.
- `flowAggregation: BLOCK` for the original canonical per-block flow.
- `flowAggregation: LEGACY_ROLLING` when retained rolling history cannot be proven as a disjoint interval.
- `flowBucketStart`, exclusive `flowBucketEnd`, and `flowThroughBlock` for corrected interval evidence.

Adjacent comparisons own their lower time boundary exclusively. Historical partial upper buckets require their stored observation and canonical boundary blocks. Flow filtering/ordering requires BLOCK queries because filtering stored rolling totals before calendar projection would produce incorrect pagination and membership.

Stock fields such as liquidity and active pools retain their original values. Metadata-only and stock-only queries do not reconstruct flows. Stored rolling rows remain intact: internal `exploreStats.volumeDayUSD` retains rolling 24-hour semantics, and asset/pool analytics keep their existing inputs.

## Historical coverage

Production retains approximately 31 days of canonical network BLOCK rows. During the October 7 investigation, the oldest available row was September 6. A nonempty bucket is insufficient: exact reconstruction requires contiguous block heights and the interval's boundary evidence.

Older rows without durable verified calendar evidence remain explicitly `LEGACY_ROLLING`. They are not replaced with zeros or labeled corrected. Existing clients that do not request the new metadata cannot show this distinction. One-month previous-period comparisons and longer histories can still include legacy data; correcting those intervals requires separate trustworthy historical evidence.

## Durable worker evidence

The worker adds `calendarFlows` beside existing rolling data. Its version-1 shape records `bucketStart`, exclusive `bucketEnd`, `throughBlock`, `throughTimestamp`, `complete`, and all seven flow fields. A prefix requires its predecessor and contiguous included blocks; a complete bucket additionally requires its successor beyond the boundary.

Calendar totals update incrementally beside the existing compact block cache. Cold loads and replaced inputs rebuild those totals; ordinary refreshes add only new deltas. Historical backfill closes traversed buckets. Normal refreshes seal newly completed HOUR/DAY buckets, including refresh gaps. Startup also seals existing, fully proved retained HOUR/DAY rows from already loaded inputs, using batches of at most 100 document IDs and writing only changed metadata. It invents no missing historical rows. Completion progress advances only after successful normal worker writes, preserving proved history after raw-block retirement.

The newer development checkout's memory-bounded streaming analytics fallback is preserved. That path does not manufacture a second retained calendar cache; unsealed data remains subject to API coverage verification.

## Validation

The release candidate passed 148 existing chain tests plus six calendar-worker regressions. New tests cover adjacent buckets and late tails, missing predecessors/interior blocks, corrected inputs and account counters, historical closure, startup sealing/idempotency, and refresh gaps. The candidate's existing startup fixture was aligned with its deployed finalized-chain-time contract; the primary checkout's differing startup fixture was left untouched.

API validation must cover current/prior ranges, shared boundaries, historical partial upper buckets, pagination, metadata/stock-only caching, durable complete rows after raw retirement, and explicit legacy classification. Public post-deployment checks compare corrected totals with canonical BLOCK sums and verify unchanged Explore rolling values and liquidity.
