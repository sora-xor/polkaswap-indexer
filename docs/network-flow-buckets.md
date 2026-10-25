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

## Worker scan responsiveness

The October 9, 2026 recovery exposed event-loop starvation during the bounded-memory analytics fallback. A cold projection coincided with a 20-second loopback metrics timeout followed by a 5.676-second response; completed HTTP handlers still reported at most 254 ms. RocksDB page reads are synchronous operations wrapped in resolved promises. Awaiting those promises or async-generator rows alone does not give sockets and timers an event-loop turn.

The worker now yields through Node's `setImmediate` between validated repository pages, including the optional list-backed path. It preserves the complete ordered horizon, source-block filters, cursor-progress checks, row/byte budgets, exact arithmetic, error propagation and caller cancellation. It neither increases request timeouts or cache limits nor changes the 25-block projection cadence. No partial scan becomes a completed analytics result.

Seven scheduling regressions exercise real event-loop callbacks with immediately resolved page reads, retained cold loads, streaming fallback, list-backed pages, repository errors, overlapping cursors and early consumer closure. Four fairness assertions failed before the repair; the corrected candidate passed all seven, the existing 174 chain tests, the full 2,058-test suite (25 existing skips), and TypeScript build. Retained evidence is under the migration's `cooperative-scan-evidence` directory. Deployment acceptance must additionally observe responsiveness across a real cold projection and pass the unchanged public API/browser checks; a warm-cache smoke success alone is insufficient.

Production acceptance passed on October 9 with `release-cooperative-scan-v6` on the existing MOF database. During 76 paired observations over 154 seconds, both cold-load and streaming counters advanced from 2 to 3; another 377,762 rows were scanned while the checkpoint stayed at block 27,972,952, before it advanced to 27,972,954. The same process (PID 91815) remained active. Maximum sampled health and metrics response times were 131.066 ms and 138.341 ms, with no timeout under the unchanged 10-second request budget.

The public Pi qualification passed 71 requests and all 49 client contracts. The official WebKit checks passed `/swap`, `/bots`, `/store`, `/buy-xor`, and `/get-ts`, each with mounted route UI, zero failed requests, and zero console errors. Retained acceptance receipts are `pi-v6-projection-responsiveness.json` (SHA-256 `50d6114e7137c6c67e94149bf3bf6cbcfb0d31ad8a23667d943ccf5cdcb13d93`), `pi-public-api-v6-final.json` (`cb4adef6fbd81eb9c8cf9736877198a8e0f73e5aa2b7b4b557c70607ba1287eb`), and `pi-post-v6-webkit/verified-final-v6.json` (`1a9d158a3964b0904499e2593ee6adcf0a321bc1ef446707c0a37842e47c636d`).
