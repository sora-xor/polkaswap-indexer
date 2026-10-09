# Verified network volume and calendar-flow repair

The v2 offline repair corrects transfers and bridge movements previously counted
as trading volume. It reconstructs each retained BLOCK from successful Liquidity
Proxy history, using persisted `exchangeVolumeUSD` when available and the strict
legacy swap valuation otherwise. Every BLOCK swap count must match its history;
an unvalued swap, malformed amount, or inconsistent history timestamp aborts
before any write.

Legacy aggregate transaction-counter repairs sometimes left counters with source
metadata from a different window. The v2 repair does not trust those counters as
proof of historical coverage. It recalculates a rolling volume only when canonical
BLOCK heights form a contiguous range from a preceding boundary anchor through
the exact source height and timestamp. Source-height ownership excludes later
blocks with an identical timestamp. Existing stock observations and legacy raw
counters remain unchanged. The summary records independently reconciled aggregate
count mismatches.

Unprovable rolling amounts remain intact and receive
`networkFlowRepair: { version: 2, status: 'LEGACY_UNVERIFIED', reason: ... }`.
The repair independently reconstructs all seven calendar flow fields from corrected
BLOCK records wherever bucket boundaries and interior coverage are proven. Complete
calendar evidence takes precedence over the legacy warning in the API; otherwise
the API reports `LEGACY_ROLLING` and preserves the legacy values.

Stop the exact combined service before using the command. Dry run is the default
and takes the same exclusive database lock as apply. First qualify the repair on
a separate native checkpoint copied from the retained pre-repair checkpoint.
Review the changed-row counts, preserved unverified rows, calendar coverage,
estimated writes, eight-times write-amplification reserve, and free space.

```sh
node dist/src/scripts/repair-network-volume.js
NETWORK_VOLUME_REPAIR_APPLY=true \
NETWORK_VOLUME_REPAIR_CONFIRM=REPAIR:networkSnapshots.volumeUSD:v2 \
node dist/src/scripts/repair-network-volume.js
```

Pi's measured snapshot inventory exceeds the default caps. Its reviewed run uses
`NETWORK_VOLUME_REPAIR_MAX_SNAPSHOTS=3000000` and
`NETWORK_VOLUME_REPAIR_MAX_AGGREGATE_SNAPSHOTS=50000`; all other caps stay at their
defaults unless new measured evidence requires changing them. These are resource
bounds, never coverage overrides.

Writes use bounded batches, preserve other snapshot fields, and verify full
aggregate contents. The `networkVolumeRepair-v2` completion marker is written last.
A partial repair can resume, including after its own calendar metadata has been
written. Unknown preexisting calendar metadata aborts; v1 markers remain untouched
and cannot suppress v2. Run the corrected worker immediately after applying the
repair so future BLOCK records retain the same exchange-only semantics. Never
restart old volume-counting code after an applied repair without a reviewed plan.
