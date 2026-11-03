# Canonical statistics/history candidate

This is an inactive, separately admitted recovery mode for SORA Nexus mainnet.
It does not replace the independent full-history replay or certify recovery
entitlements. No production database is initialized by setting an environment
variable. The ordinary and full-recovery workers reject a database carrying this
mode's durable classification.

The candidate must be an independently verified copy of the canonical prefix
ending at block 28,191,816, hash
`0x60b63e40ce4de9b9c1408bf7455a6f5ced796825f2437a0ee8496476d80c56d6`.
Its explicit admission pins the source and candidate paths, native qualification,
complete file manifest, completed `networkVolumeRepair-v2` marker, and actual
finalized recovery policy. `SORA_STATS_RECOVERY_ADMISSION_FILE` and
`SORA_STATS_RECOVERY_ADMISSION_SHA256` must be supplied together. The file uses
compact `JSON.stringify` encoding; duplicate keys, invalid UTF-8, symlinks,
unknown admission fields, changed bytes and files over 16 MiB are rejected.
`CHAIN_START_BLOCK` must be 28,191,817 and snapshot retention must be `all`.

The worker requires an already persisted admission and a separate cursor matching
`chainState`. It verifies the normal live/archive chain anchors, exact recovery
runtime metadata and canonical payloads. Each suffix block must be the next
child of the persisted hash. Transaction valuation uses the exact parent state;
the next baseline is fully reloaded at that child's hash because recovery hooks
may mutate storage without familiar pallet events. The block, checkpoint and
stats cursor commit atomically. The mode never creates full point journals,
recovery ownership/projection evidence, burn entitlements, referral entitlements,
account point metadata or point eras. Original history addresses remain original.

The admitted prefix is preserved. Legacy startup routines that rewrite price,
supply, transaction-counter, aggregate or bridge history do not run. Qualification
must pin the completed exchange-only/calendar volume repair before initialization;
it cannot be fabricated or silently skipped. Restart reconstructs rolling inputs
from retained canonical BLOCK rows with a preceding boundary and contiguous
coverage through the prefix. The API preserves retained history coverage and
legacy calendar warnings; neither the retained prefix nor this mode claims all
blocks since genesis are present. Account creation counts are unavailable, stored
and returned as `null`; filters and ordering on those counts are rejected. Active
account activity remains a distinct, history-derived metric.

Rolling startup seeks the preceding timestamp directly through the native
type/timestamp index, then examines only that exact timestamp group to select
its maximum admitted block height (document-ID ordering is not numeric height
ordering). The retained window starts at that height plus one through the
type/block-height index. Per-query scan and page-byte limits remain unchanged;
the timestamp group also has an aggregate row bound. Missing or malformed rows,
height gaps, backwards timestamps and a missing checkpoint still fail startup.
This avoids scanning an entire month or older retained history merely to locate
the boundary; it does not relax canonical-prefix qualification.

The exact retained marker is complete version 2 with semantics
`verified-block-exchange-volume-calendar-v2`, through block 27,159,179 and latest
snapshot timestamp 1,785,761,832. Its normalized document digest is
`28ddafd9e177edb13f9b588e293ba7913f6509ab787a4a1d5ddcc4a145e8e169`.
Admission requires that exact independently observed marker. Later canonical
prefix replay retains its separately audited calendar/BLOCK evidence; the marker
does not claim complete genesis history.

`indexerCapabilities` separates partial functionality from complete health:

- `schemaVersion: 1`, exact `genesisHash`, nullable `policyHash` only for legacy,
  and `mode: legacy | full-recovery | canonical-stats-history`.
- `statsReady` and `historyReady` require actual repository/worker readiness,
  coherent canonical checkpoint and freshness.
- `coreViewsReady` requires that readiness plus complete verified core assets,
  Pool XYK pools, order books, and price/APY/asset-registration streams at the
  exact current checkpoint. Each full refresh compares bounded normalized row
  sets, including retired-row removal, before publishing its receipt last.
- `currentViewsReady` stays false in stats mode. Account positions, individual
  order status, provider liquidity, vault and staking views remain unavailable
  until their own authoritative reconciliation is implemented and qualified.
- `entitlementsReady` is false in **every currently implemented mode**. Worker
  freshness, ownership rows or a replay reaching the head do not implement the
  independent complete-history certification gate.
- `indexedBlock`, `indexedBlockHash` and bounded `reason` explain the observed
  state. Full-service `_health.ok` remains false for the partial mode.

Every live suffix block awaits a complete core refresh. Backfill refreshes at
catch-up. This mode loads the authoritative asset, pool, order-book and farming
inputs needed for the core; it skips unrelated provider, vault, staking and
Polkamarkt reconciliation. Core reads are blocked before any multi-batch refresh begins and while
its checkpoint differs. They bypass ordinary TTL caches in stats mode and
recheck the exact generation and checkpoint after materialization. Core connection
cursors carry that same receipt generation, block and hash; a later page rejects
a changed generation and the client must restart the complete paginated read.
Collection, filter and order bindings remain mandatory. Statistics mode only
admits forward cursor pagination for these core collections. All current-core
roots and affirmative core capability fields in one query share a generation
anchor, so aliases cannot combine two completed refreshes. Subscription emissions
use fresh per-emission checkpoint and generation contexts while retaining the
transport's aggregate-budgeted repository; later reconciled emissions remain
valid, and a refresh crossing one emission rejects it. A stopped, lagging, stale or incoherent worker
cannot expose the current core through an old reconciliation receipt. A failed
refresh remains unavailable and retains its data for review.

Before any public activation, the shipped frontend must enforce a fresh,
network-only capability check on the same captured indexer transport before
points, burns, referral scoring and TONSWAP claims. Missing/unknown/malformed
capabilities must disable every raw-history, direct-RPC, embedded-hint and cache
fallback, and display unavailable rather than zero. Server-side claim rejection
alone cannot disable the previously shipped frontend's local fallbacks.

Qualification remains a separate reviewed operation: preserve the exact source;
copy to a new private candidate; prove complete file equality and independent
inodes; inherit the exact same-host source native audit with explicit
`nativeValidationMode: inherited-exact-source-bytes`,
`exhaustiveNativeExecutedOnClone: false` and
`normalizedScanExecutedOnClone: true`; scan the actual clone's normalized
documents read-only with unchanged file manifests; pin the actual repair marker
and policy; then atomically seed only its admission, cursor and pending core
receipt. After the new writer prepares its private indexes and seeds those three
rows, require full normalized-document equality allowing only those additions,
plus exhaustive current-index validation. The retained native audit is not
misreported as a second exhaustive scan of the clone. A private native trial must
cover the fork checkpoint and recovery suffix, actual swap valuation, restart,
interrupted refresh, exact row-set retirement, all seven shipped stats queries,
and unchanged entitlement rows. Measure cadence and disk growth; unit fixtures
are not evidence of full-history completeness or production capacity. No source
copy, native open, trial launch or production activation is performed by this
source change.

The initializer is deliberately restricted to the reviewed MOF2 trial paths.
Public promotion would retain `https://pi.soramitsu.io/graphql` and require a
separate, explicitly reviewed Pi clone admission and supervisor package. An
independently verified APFS clone of the read-only canonical Pi prefix may reduce
initial disk allocation, but later index writes and compaction consume new
blocks. Measure that growth against Pi's existing reserve before promotion;
neither copy-on-write nor a short trial proves the entire future database fits.
# Exact-state metadata reuse in the private candidate

The private stats worker shares raw `state_getMetadata` reads between its block
decoder and historical-state adapter only when the configured origin, exact
state hash and policy metadata hash all match. Primary/archive connections to
the same origin share this single-flight; different origins remain separate.
The cache never selects metadata by specVersion or by a block-height interval.
Each consumer still chooses its own execution or next-execution witness and
checks the raw hash; canonical headers, parent identity, runtime versions and
storage declarations are unchanged.

The worker-owned cache retains at most 32 entries and 16 MiB of raw hex strings.
Every load keeps the existing 15-second RPC deadline. Failed, cancelled and
timed-out entries are removed; late completions cannot repopulate them. A
cancelled borrower does not cancel another live borrower. Shutdown closes all
pending cache reads. Ordinary and full-recovery workers keep their existing
metadata path. This removes duplicate exact-state reads; it does not prove that
a cold backend call or a complete suffix replay can meet the trial bounds.

The stats-only block decoder obtains its preliminary header with the SDK's raw
`chain_getHeader` method. A fixed Substrate Header codec validates its requested
hash, bounded block number, parent and roots, and exact SCALE digest bytes before
any metadata or payload fetch. The installed SDK's decorated historical header
method first looks up a runtime registry, which adds another header and parent
runtime-version read, and sometimes another metadata read. Raw header decoding
avoids that implicit work; it does not bypass the separately witnessed execution
metadata, canonical block identity, parent continuity or storage-context proofs.
Ordinary and full-recovery header paths remain unchanged. An offline real SDK
fixture verifies the wire-call reduction; throughput still requires a new
bounded private trial.

