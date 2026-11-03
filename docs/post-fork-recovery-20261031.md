# Post-fork indexer recovery — 31 October 2026

Latest observation, 07:49 JST on 1 November: the archive is serving and both
private MOF2 replays are advancing. Stats trial08 has crossed the hard-fork
runtime transition without a worker error. Pi's initialized copy is still
undergoing exhaustive native index audit. Actual Pi tests exposed a missing
parent815 runtime on the normal public RPC; the recoveryworker will explicitly
use the restored canonical archive for both RPC roles. That archive passed
five-state/runtime/core checks and four exact raw post-fork payload comparisons
against the independent normal RPC, with the complete installed Pi runtime
verified before and after. Public Pi remains the canonical read-only prefix;
live indexing is not restored and entitlements are not certified. See the latest
coordination entry for exact failure and successful witness evidence.

Observation at 07:07 JST on 1 November: public Pi serves the exhaustively
audited canonical prefix through block 28,191,816 in native read-only mode.
Live indexing remains unavailable and entitlements remain uncertified. The
archive, canonical gateway, recovery node and independent full replay are active
with zero restarts. The full replay reported block 165,015 without a worker or
transport error; `/data` had 63,204,577,280 bytes available. This does not prove
that the complete replay fits on existing storage.

The separate statistics/history copy passed initialization and its exhaustive
27,428,271-document/index audit. Its earlier startup failures were independently
qualified without changing recorded errors or protected account collections.
Backend v5 eliminated duplicate exact-state metadata reads; its actual bounded
burst served twelve consumers with four wire reads, all within the unchanged
15-second limit. Private trial-04 then advanced to block 28,191,882 and stopped
cleanly on root's request. It had not completed startup or API/core acceptance.
Its measured peak of 175,735,627 new or rewritten logical bytes is partial-run
evidence, not complete suffix capacity proof.

Backend v6 removes the SDK's hidden runtime-registry lookups from the stats
header-fetch path while validating each raw header's exact hash and canonical
encoding. An immutable base passed 3,811 tests; a subsequent two-file aggregate
bound correction passed all 62 focused tests plus TypeScript/build. A five-state
Node24 witness passed all exact header, runtime, transition and reentry checks.
No single full test run of the final source is claimed. Root reviewed all 599
release files and the exact clean-stop upgrade bindings, then launched private
trial-06 from block 28,191,882 under the existing disk, memory and time bounds.
There is no automatic retry or public activation.

The deployed frontend retains its verified entitlement guards and Migration
removal. Pi's v6 package is being staged and qualified on a synthetic database;
the real Pi statistics candidate remains unopened. Its private initialization
budget and eventual production activation require separate concrete reviews.
The canonical read-only Pi service is the rollback target; abandoned-fork data
must never resume its writer.
Status: the Pi API is available in native read-only recovery mode. Live indexing
is **not restored**, and its health correctly remains unsuccessful. MOF2's
retained archive is now running in an isolated service and is served through
the canonical HTTP/WebSocket gateway at `mof2.sora.org/archive`; see
`archive-gateway.md`. Finality resumed during preparation: both production RPCs
and the archive gateway agree on finalized recovery block 28,192,030, hash
`0x458a9b7f26cb7cf09529b46de62232bbfe3754854999c827a27a51cfb40371b9`.
At 14:17 UTC, finalized block 28,192,060 reported recovery phase `Applying`,
next chunk 242, no failure, and the shipped policy commitment
`0x1f4e11427a9c0a61a4868af40c9e0bdf263bb44a9ee59886a537c52164f3cdbb`.
Finality is no longer the immediate blocker; recovery state reconciliation,
runtime witnesses and a clean indexer remain unfinished.

## Bounded legacy-history replay

Two intact Pi snapshots predate the fork. The newer one,
`restores/pi-before-pool-freshness-20261013T104342.rocksdb`, has checkpoint
28,026,743, hash
`0x5176d08f4fc0ad69c10969d08dc08b8ffa330bc957c26c18a0f61614d0594f87`,
timestamp 1,791,888,186. Its hash and timestamp match the restored archive.
The snapshot contains 468 files totaling approximately 17.55 GiB. Its source
file manifest was captured while the source had no writer or open database lock.

The immutable local copy is retained under
`/Users/takemiyamakoto/dev/private-indexer-backups/recovery-20261031/source-db`.
All 468 files matched their source SHA-256 hashes, and another full hash check
confirmed read-only inspection left every file unchanged.
The exact deployed release is retained alongside it as `source-release`;
all 13,529 regular files matched the remote SHA-256 manifest. Replay must use a
separate working database and preserve the immutable source.

The complete primary-document scan covered 27,070,768 records. No chain-data
record was above 28,026,743. The one apparent exception was the exact
`workerStatus-v1` heartbeat: its documented monotonic version is a Unix timestamp,
not a chain height. Its status schema and actual indexed height were validated
separately. Collection counters matched the complete scan. Sampling checked
862 documents, 1,486 expected index keys and 686 existing index keys, with no
missing or stale entries. This is not an exhaustive index-validation claim.

A separate APFS clone, `replay-db`, matched all 468 input hashes before opening.
At 14:31 UTC the exact deployed kernel started against that clone, exposing only
loopback port 4031. Both production-mode identity preflights passed. At 14:41 UTC,
after a graceful stop and lock release, it resumed with 32-block prefetch. The
adapter coalesces identical in-flight reads from the two checked clients and
caches only verified immutable headers/runtime versions. Its upstream socket
limits remain bounded; block/event/state payloads are not retained in that cache.
The loopback replay
adapter remains fixed at 9955. Production Pi has not been switched to this copy.
Process receipts, the explicit environment, source pins and logs are under the
private recovery directory's `operations/` folder.

`operations/finish-bounded-replay.py` is a one-shot completion guard for these
exact process identities. It waits at most 24 hours, keeps a 50 GiB workstation
disk reserve, and requires the exact cap/hash/timestamp plus completed startup.
It then gracefully stops only the owned worker and adapter, verifies the DB
lock is free, and runs the full stopped-copy document/index audit with before
and after file hashes. It cannot deploy a database or mark live recovery
complete. Six no-network guard tests passed. Its progress and final result are
`completion-progress.json` and `completion-result.json` in that operations
directory. Absence of a successful final result is not successful verification.

The full recovery replay has a separate capacity requirement. A native
10,000-journal synthetic fixture produced 11,982,351 SST bytes after compaction:
about 31.46 GiB extrapolated over 28,191,817 blocks. That deliberately minimal
fixture uses a one-byte fake block, no events/point writes and empty valuations;
it excludes all real payloads, business collections, WAL and working space.
It is a sizing diagnostic, not authenticated chain data. MOF2's 42 GiB free on
root and 27 GiB on `/data` are insufficient for a safe full replay. No retained
database or unrelated service data was removed to make room.

`serve-legacy-replay-adapter` binds only loopback and pins defaults, runtime
version, heads and subscriptions to finalized shared-prefix block 28,191,816.
It rejects later blocks and noncanonical hashes and cross-checks each served
block hash against the recovery node. This is essential because the original
and substituted recovery runtimes reuse spec version 134 with different
metadata. The deployed polkadot.js client was checked through the adapter at
the snapshot, its next block, 28,150,000 and the cap: spec 133 and the original
134 registry were selected correctly, and 28,191,817 was rejected.

This replay is an interim legacy-history repair. It does not certify burn or
points entitlements or admit recovery-chain indexing. After independent replay
validation, the hold manifest may set `dataStatus: "pre-fork-prefix"`; that mode
requires exactly block 28,191,816, hash
`0x60b63e40ce4de9b9c1408bf7455a6f5ced796825f2437a0ee8496476d80c56d6`,
and timestamp 1,792,939,554. It continues to report stopped, read-only,
unsuccessful health and explicitly uncertified entitlements. Omitting the field
preserves the existing `abandoned-fork` classification. Neither the new mode nor
the replacement database has been activated on Pi. The separate prefix API
release passed a native fixture: writes were rejected, GraphQL responded, the
checkpoint stayed fixed, and health remained unsuccessful with the correct
legacy-history classification.

## Recovery work on 1 November

At 00:58 JST the live recovery chain was in `Auditing`, with all 983 apply
chunks consumed. Runtime 138 and the final Complete anchor were not yet
available. Production Pi remains read-only and unsuccessful health is expected.

A page-size-only trial resumed the private legacy database at block 28,049,504
at 01:15 JST. The immutable source release remains unchanged. The separate
`replay-release-pages1000` differs in exactly one compiled constant, 256 to
1,000 storage entries per page; all 13,547 regular files/symlinks were compared.
Its kernel SHA-256 is
`13862f0345b737204127a0c958497e6825bd8021a3f6eecc648cf01018e303c6`.
The original source kernel remains
`fd99dae5794e773c74f47c6ed3c11ae9b548cacc2aee6ec93eb574643396a895`.
Exact valuation and document digests matched for a 32-block quiet window and
an ambiguous swap block. Full valuation scans used four storage RPCs instead
of twelve; variable load prevented a reliable elapsed-time speedup claim.
The candidate source now exposes `CHAIN_DERIVED_STORAGE_ENTRIES_PAGE_SIZE`,
default 256 and maximum 1,000. Its focused 372 tests and isolated TypeScript
build passed. The trial does not change pricing, full reloads, byte limits,
canonical checks or the fixed replay cap.

MOF2's stopped cold indexer snapshots contained identical immutable SSTs.
A lock-protected, exact-path operation consolidated 583 duplicate files across
201 hash groups. All 784 original paths still contain their original bytes;
every non-SST file is unchanged. Before/after SHA-256 manifests, per-file inode
and mtime receipts, and seven passing no-network operation tests are retained
under the web checkout's `output/ops/archive-recovery-20261031/`.
Actual `/data` free space increased by 33.70 GiB to 59.25 GiB. No database was
opened, no service was restarted, and Pi was unchanged. This creates room for
the bounded legacy replay near the archive; it does not establish capacity
for the complete genesis replay. Distinct full valuation snapshots are another
large storage input, beyond the minimal journal sizing above.

The early-history compatibility fixes passed a fresh native replay through
canonical block 4,096. All 4,096 journals, their commitment chain, BLOCK rows and
native indexes passed verification. The earlier block-91 failure was resolved
by an exact-hash, mainnet/runtime-bounded pre-denomination proof; four- and
six-field historical asset codecs are also supported. Five fixed valuation
probes spanning blocks 1,000,000 through 25,043,003 passed. This diagnostic used
a separate policy and database and must not be promoted or rebound to the
later live policy. Its 32.08 blocks/second measurement is not a full-history ETA.
The stopped database totals 66,836,243 bytes, including 25,719,176 essential
blob-file bytes. Counting only SST files would understate its size.

At 01:50 JST the bounded legacy replay moved to MOF2 beside the archive.
All 463 stopped database files (18,637,975,804 bytes), 181 release files and the
Node executable were verified before opening. Native read-only inspection left
every incoming file unchanged. The transferred checkpoint was 28,054,432,
hash `0xa053506bd539f1a783c151a647f1ecdb297914f8f8eee736c371c42819884646`.
The immutable Mac source and stopped working copy are retained. The transient
unit `polkaswap-legacy-replay-20261101` runs as `ubuntu`, with a 12 GiB memory
limit, four-CPU quota, a 30 GiB `/data` reserve and a 24-hour completion guard.
Loopback ports are 9957 for the bounded adapter, 4035 for GraphQL and 9466 for
metrics. Its exact cap remains 28,191,816. The Linux guard passed 15 no-network
tests and uses process birth identities and pidfd signaling. It stops and
fully audits the database at the cap; it cannot publish or certify recovery.
The worker passed both identity preflights and advanced to 28,054,753 at
01:51 JST. Receipts are under
`/data/polkaswap-indexer-recovery-20261101/operations`.

Pi's separate cold-SST consolidation stopped safely after 744 replacements
when a live-file guard detected a reader; the remaining 34 were not changed.
All 1,240 original SST paths retain their hashes, ownership and modes, every
non-SST file is unchanged, and temporary guards were removed. Actual reclaimed
space was 20.90 GiB, leaving 85.55 GiB free above Pi's 75 GiB reserve. No service
was changed and no retained database was opened. The guard was not weakened.

Fresh-only format-3 document compression passed a separate 4,096-block native
replay. All 39,427 decoded records across 26 collections, every journal and the
receipt root match the uncompressed reference. Only seven explicitly reported
execution-telemetry fields differ in two operational documents. Full native
indexes pass, and both databases were byte-identical before and after the
read-only comparison. Total database bytes fell from 66,836,243 to 34,590,804
(48.25%), including SSTs, blobs and logs. The 11.97 blocks/second observation
shared the host/archive with the legacy replay and cannot isolate compression
cost. Neither this early-history sample nor compression proves full-history
capacity. Existing databases and production remain unchanged; see
`docs/rocksdb-compression.md` and the attempt-5 evidence in the web checkout.

The policy generator's source/evidence binding, complete status checks and
publication order were hardened with 16 passing offline regressions. A separate
pinned-input verifier has five tests and verifies both finalized RPCs, exact
runtime boundaries and complete recovery storage before publishing a success
receipt. `operations/watch-policy-verification.py` waits at most six hours for
that final policy; its four no-network selection tests pass. It starts no
worker and changes no production service. Its receipt explicitly does not
establish admission signing or entitlement certification.

At 02:03:59 JST the archive CPU quota increased from 150% to 300% without
restarting PID 1166135. A preceding ten-second sample showed 23 throttled quota
periods and 2.74 seconds of throttling; the 12-CPU host's load was below five.
The 12 GiB memory cap was unchanged. Public block-1/checkpoint headers and
finalized recovery identity passed afterwards; the live recovery node reported
23 peers and `isSyncing:false`. The rollback command and before/after service
properties are retained in
`/var/lib/sora-retained-archive/cpu-budget-20261101.json` and copied to the web
checkout's operational evidence. This change occurred after attempt-5 replay
finished and does not alter its measurements.

At 02:07 JST the archive memory cap increased from 12 to 24 GiB, again without
a restart. The host had over 141 GiB available and the archive had accumulated
memory-limit reclaim events with zero OOM events. Later checks still showed zero
OOM/restarts and increasing replay progress. This permits filesystem cache for
the historical workload; it is not extra persistent storage. The exact previous
cap and rollback are in `memory-cache-budget-20261101.json` beside the earlier
CPU receipt.

The native APFS compression experiment on Pi also passed: 10,000 synthetic
documents, queries and native indexes remained equal, all database SHA manifests
were unchanged by read-only inspection, and existing sources retained bytes,
paths and xattrs. A separate retained 70,239,501-byte SST copied into a new
compressed destination used 3,543,040 allocated bytes. This is a sample, not a
full-database ratio. Compression is being added only for newly copied prefix
SSTs; linked sources and existing databases are not converted. Use actual free
space and allocated blocks/resource-fork sizes: APFS private-data-fork bytes may
be zero for a compressed file and do not describe its true storage use.

At 02:43:46 JST the legacy replay reached the exact cap with startup complete.
Its worker and adapter stopped cleanly; the completion guard began the full
read-only document/index audit. A cap-height observation alone is not approval
to copy or activate the database: require `verified-stopped-legacy-prefix` in
the final result and identical complete before/after file manifests.

That exhaustive audit completed successfully at 03:05:08 JST. The stopped
service exited successfully; all 499 files (18,786,660,488 bytes) remained
identical before and after inspection. The audit covered 27,428,271 documents,
all native indexes and all 165,073 replayed BLOCK rows. The retained database
has 2,133,341 BLOCK rows in total, so this is a repaired canonical legacy
history, not a claim that every block from genesis is stored. The exact terminal
checkpoint and hash match the cap. Pi return, native target audit and activation
were still pending at this observation.

The inactive Pi prefix release is staged at
`release-canonical-prefix-20261101`. It preserves all 13,529 pinned source files,
five inert extra files found on the actual remote release, and 18 symlinks.
Only the two reviewed hold entry/status modules differ. The complete candidate
manifest is `0b3cd3ee4b8d3b236038485b500abeff73161ef49b0320179600690f7e0b7ccd`;
the original release is unchanged. No launcher, service, hold manifest or
production database was changed by staging.

The fresh format-3 recovery runner is also staged, inactive, at
`/srv/pi-indexer-recovery-20261101` on MOF2. All 44 finite-runner tests passed
again on the actual Linux host. It requires the actual finalized runtime-138
policy and independent verification receipt, and refuses any existing database
path. It stops below 31 GiB free to protect the 30 GiB reserve, or after 24 hours,
and retains its partial database with a verified tail and unchanged file hashes.
That tail inspection is not an exhaustive history audit and does not admit a
public API or certify entitlements. Full-history capacity remains unproved.

After correcting the obsolete burn test fixtures to use canonical nonzero
block hashes and actual event ordinals, the complete suite passed at 02:58 JST:
3,672 tests passed, 92 skipped, no failures (138 files passed, three skipped).
This run used the installed Node 26.13.0 and Vitest 4.1.10, with 20-second test
and hook budgets. The fixture repair changed no runtime behavior. The full log
SHA-256 is `a4c183ed4f7ca7d329415e1c572a65e1d4ed69207831ce1f966bc99cab3d65e0`.
The separate prepared recovery runtime remains pinned to Node 24.16.0.

At 03:15:38 JST, independent verification accepted the actual final policy:
activation block 28,194,042 and finalized Complete anchor 28,194,043,
`0xe7c02d6f6990bc6c0f6356833db98ccdf3ed07fb628631e45236935470774e7c`.
Both live RPC witnesses, all three runtime ranges, sealed policy/economic input
bindings, zero pending incoming audit and terminal commitment passed. Policy
SHA-256 is `805a7874830d7fe19406730d0f5fec257fd6dca7df9c10e9077bf422b49e79b1`.

The isolated full replay started at 03:19:16 JST as
`polkaswap-full-replay-20261101.service` on MOF2. Its supervisor/worker PIDs were
1194275/1194286; admission SHA-256 is
`4821445dede8f02b0ce98b573c86abd7803366ddccf3d103d7564511fd84dac6`.
It reached block 792 after startup with no worker error. The 31 GiB stop
threshold, 24-hour deadline, exact policy pins and normal worker initialization
remain enforced. This is a private partial replay, not restored live indexing.

## Retained archive inspection

The public MOF1 and MOF2 endpoints serve separate recovery databases. Their
failure to return old state did not establish that the old on-disk databases
were missing. Both old databases were inspected using temporary, isolated
4.8.6 nodes matching their existing pruning modes. The inspection nodes had no
peers, private/loopback RPC port 9946, separate temporary node keys, and no
public proxy changes. Both were stopped gracefully after inspection, and both
old database locks were released. The production recovery processes were left
running throughout.

| Host | Retained database | Result |
| --- | --- | --- |
| MOF1, approved MacStadium `207.254.29.218` | `/Users/administrator/dev/sora2-network-4.8.6/db/chains/sora-substrate-main-net`, approximately 35 GiB | Block bodies available at all sampled heights; older state, events and metadata pruned. Existing pruning mode is 256. |
| MOF2, approved OVH `51.161.218.175` | `/root/sora2-network-4.8.6/db/chains/sora-substrate-main-net`, approximately 657 GiB | Historical timestamps, events and block bodies available at all nine sampled heights; runtime metadata available at all three queried heights. Existing state/block pruning mode is archive-canonical. |

Sampled heights: 1; 1,000,000; 25,043,003; 26,872,383; 27,972,954;
28,191,800; 28,191,816; 28,191,817; and 28,192,678. This is a successful
availability sample, not an exhaustive integrity check of every historical
block. The fixed genesis and audited identity anchor matched the indexer.

At the shared recovery checkpoint 28,191,817, MOF2 returned:

- Block hash: `0x7f7c253fa72f32e7b03f32bdc9ae456fd7174fb131b689be6d876006124129f0`.
- Timestamp: `1792939560002` milliseconds.
- Events: 17 bytes, BLAKE2b-256
  `0bd7309532ae4be9c2c496ac95bf5bcd101cdbe1de3a9d4e570415838abf648e`.
- Runtime metadata: 625,665 bytes, BLAKE2b-256
  `0c1d4bf5c3bc5037ad854932443c94faae6c327ecf1f38b3e77d38668cc2b4b8`.

Preserve MOF2's old archive. Its later blocks belong to the abandoned fork;
historical use must be bounded to the verified shared prefix through
28,191,817. Do not substitute this node for the live recovery-chain endpoint
or restart its old public service. Re-enabling historical access must preserve
network isolation and the existing pruning mode.

At 13:23 UTC, both production recovery RPCs reported 17 peers, `isSyncing:false`,
best height 28,191,905 and finalized height 28,191,816, hash
`0x60b63e40ce4de9b9c1408bf7455a6f5ced796825f2437a0ee8496476d80c56d6`.
Being connected and following best blocks does not prove finality is advancing.

## Pi API recovery hold

The live frontend's `env.json` selects `https://pi.soramitsu.io/graphql`. Its
actual service is `system/org.sora.pi-indexer`, port 4010, on MOF1. The separate
MOF API is not the frontend's selected endpoint and was not changed.

The retained Pi database checkpoint is 28,192,678 with hash
`0x171543e01ae0510d5aa407d5c45dc108491b45cad39defd49c7d9deac46e9fac`,
which belongs to the abandoned fork. Resuming the old writer or merely lowering
`chainState` would preserve contaminated materialized records. No checkpoint,
history, balance, aggregate or business counter was rewound or relabeled.

After verifying the launcher, process owner, release and database lock, only the
Pi combined service was stopped. The existing release was cloned and augmented
with the recovery-hold entrypoint, retaining the deployed API implementation.
The existing supervisor now invokes that entrypoint with a manifest pinning the
exact database path and retained checkpoint. The original runner and plist are
retained under `recovery-hold-20261031-backup/` in the service base directory.

Service base: `/Users/administrator/apps/pi-indexer-recovery-20261009`.

- Hold release: `release-recovery-hold-20261031`.
- Manifest: `hold-manifest.json`.
- Retained database:
  `restores/pi-return-8fcff452-4063-442e-bf1c-6fc1ef14e909.rocksdb`.
- Entrypoint: `dist/src/scripts/serve-recovery-hold.js`.

The operator-only entrypoint requires an absolute manifest path, schema version
1, RocksDB storage and an exact path match. `createRecoveryHoldStatus` validates
the complete stored checkpoint against the manifest. It opens native read-only
RocksDB and starts the existing GraphQL server without a chain worker. Health
reports `readOnly:true`, `ok:false`, `workerLifecycle:stopped`, no successful
indexing timestamp, and an explicit recovery-hold error. The observed finalized
height is a manifest snapshot, not a live chain subscription. Served historical
statistics remain retained abandoned-fork data and are not certified current.

Usage, after loading the verified service environment and stopping the writer:

```sh
node dist/src/scripts/serve-recovery-hold.js /absolute/hold-manifest.json
```

Do not restore the original combined runner merely to clear this health state.
Replacing the hold requires an independently verified canonical database and
the recovery policy/metadata evidence described in `burn-recovery.md` and
`soratopia-recovery.md`. Use an isolated rebuild; preserve the retained source
and receipts until validation proves the replacement. Full points history
requires the documented replay from block 1. A finalized post-fork anchor and
correctly bounded access to old and new history remain prerequisites to the
production recovery cutover.

## Validation and evidence

- TypeScript build passed.
- 38 focused recovery-hold, health and identity tests passed.
- A native RocksDB fixture proved writes are rejected, GraphQL remains available,
  health stays unsuccessful and the pinned checkpoint is unchanged.
- Fourteen exact frontend statistics queries passed against the held API. This
  verifies query compatibility and availability, not canonical freshness.
- The full suite reported 3,520 passed, 92 skipped and 16 failed tests. All 16
  failures are in the unchanged `chain-burn-event-boundaries.spec.ts` suite and
  reproduced on the unmodified `6e36294` baseline. The full suite is not marked
  as passing.

Local operational evidence is retained in the neighboring frontend checkout at
`output/ops/indexer-hardfork-20261031/`: the two `*-retained-probes.json` files,
probe cleanup receipts, `final-public-status.json`, the native fixture receipt,
frontend query results, hold build/tests and baseline failure reproduction.
No credentials, private node-key contents or individual user records are
included in the archive sampling receipts.
