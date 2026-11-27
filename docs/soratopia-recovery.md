# SORA Nexus Soratopia checkpoint points

This indexer implementation preserves the current scoring inputs and formulas. It does not modify a live service, database, frontend checkout, or runtime.

## Supported state

A new isolated recovery indexer must replay canonical blocks from block 1. Its existing finalized genesis/checkpoint/post-fork anchor and executing-code metadata admission remains mandatory. The points schema refuses an existing materialized checkpoint, missing continuity on restart, noncontiguous/repeated blocks and a different recovery identity. Every block atomically commits point metadata, independent version-1 era deltas, actual-event referral totals, the rolling receipt commitment and chainState. Address spellings are retained as bounded provenance while AccountId32 is the unique points owner. Ordinary non-recovery worker arithmetic is unchanged.

Recovery indexing requires a historical valuation state at the exact parent height **and hash**. Missing inputs cannot fall back to live metadata or prices. Baseline queries retain their actual historical hash, changed-key queries and full reloads must match the indexed block hash, and the hash advances with the state only after the atomic block write succeeds. Unbound live-cache refreshes cannot replace this recovery state. Ordinary indexing retains its existing cache behavior.

Each recovery block receipt commits the parent height/hash and the SHA-256 of its exact metadata, raw XYK reserves and scaled prices. The normalized inputs use sorted asset/pool keys, exact integer strings and 18-decimal price scaling; one content-addressed `updatesStreams/soratopiaValuationInputs-v1:<digest>` record retains the inspectable snapshot. Repeated identical snapshots reuse the same record. A snapshot is limited to 8,192 combined asset/pool/price entries and 4 MiB of encoded JSON. Snapshot, points, referrals and cursor share the same atomic write. Recovery continuity without this valuation-receipt schema is rejected and requires a fresh replay.

These snapshots are **input provenance, not authenticated storage proofs** (`storageProofsVerified: false`). Historical map completeness and inferred mutation coverage still need independent native verification, as do historical era and staking-reward rules. No release gate is cleared by the snapshot or its receipt.

Recovery blocks also retain `updatesStreams/soratopiaPointJournal-v1:<10-digit-height>` in that same atomic write. Each journal contains the exact raw block bytes, ordered event bytes, point/referral document writes, parent/child identities, previous/new receipt roots, allocation identity and valuation reference. The existing document (32 MiB) and atomic write (64 MiB) limits apply: an oversized block fails before committing, never by splitting its journal from its points. An existing next-height journal is rejected rather than overwritten. This uses the worker's existing single-writer/contiguous-block contract; it does not add a cross-process compare-and-swap protocol. Recovery continuity without the journal schema requires a fresh isolated replay. Ordinary indexing stores no journal and its scoring is unchanged.

The journal preserves evidence of what this worker calculated. It does not add historical eras, fill absent staking rewards, authenticate storage, or turn recorded point writes into an independently re-executed score.

At checkpoint 28,191,817, each affected owner is projected in one bounded atomic transaction: exact source metadata, all eras, referral source, unused destination checks, replacement records or retirement marker, immutable evidence row and cursor. No child can progress until all owners are committed. Restarts reverify the committed prefix; they cannot copy the baseline twice. Creation age, each era's starting block and all exact amount strings are retained. Missing metadata/era sources remain absent instead of inventing an age or zero entitlement. A referral-only owner still retains its entitlement. Attacker ownership is extinguished, with original evidence retained. Ordinary history is not relabelled.

Referral points are the exact raw XOR amounts from actual `xorFee.ReferrerRewarded` events, accumulated once separately from generic referral history refreshes. Each event is u128; the cumulative amount is a canonical integer of at most 80 digits. They are transferred once and future new-owner events add to the transferred total. This changes neither the frontend XOR-decimal conversion nor its scoring coefficient.

## Public query contract

`soratopiaPointOwnership(id: String!)` returns `status`, `ready`, canonical hex `accountId`, `policyHash`, `checkpointBlock`, `checkpointHash`, `referralRewardsCodec`, and bounded `sources { account firstBlock lastBlock }`. Incomplete or inconsistent recovery fails the query. Retired/extinguished owners have no sources and zero claimable referral rewards. Historical aliases use `[1, checkpoint]`; actual post-fork aliases use `[checkpoint+1, null]`. A legacy response has null recovery identity and the requested account over `[1,null]`.

Recovery `accountMeta` and `accountPointSystems` resolve canonical owners and never expose retired/attacker ownership. Metadata and era queries expose `recoveryPolicyHash` for the frontend's same-client owner/policy join. Era queries keep an exact bounded account selector. Replacement source membership uses one immutable-root validation cache per repository with concurrent-request deduplication; subsequent selected-owner reads compare the exact retained row hash. Policy/checkpoint/projection changes invalidate it.

The companion frontend implementation guards V1 and V2. V2 preserves metadata/creation/rates and uses the admitted referral amount. V1 recovery is explicitly unavailable because its raw history/count/burn-fallback path is not yet a certified recovery scoring path. A referral-only owner without metadata remains UI-unavailable rather than inventing creation age; the canonical ledger retains its reward.

## Executable data preparation and live export

After the normal TypeScript build:

```
node dist/src/scripts/derive-points-recovery.js --policy allocation.json --policy-sha256 SHA256 --capture checkpoint-owners.json --capture-sha256 SHA256 --output NEW-ledger.json
```

The allocation API and CLI accept the existing `BurnAllocationPolicy` shape only; they require no outer release manifest or future anchor. The source capture schema is `sora-nexus-soratopia-checkpoint-owner-sources-v1` with exact checkpoint identity, `checkpointReceiptRoot`, and a complete ordered `sources` list for all policy replacements and attackers. Each entry contains `original`, exact `sourceMeta`, `sourceEras`, `referralSource`, and null/empty destination evidence. This is pure deterministic preparation of **caller-supplied data**, not authentication of that data. Its receipt and ledger retain `externalReplayVerified:false` and `productionReady:false`.

For an already running recovery's isolated repository, first prepare an independent stopped **indexer database copy** (never a live database or the retained client/node database), then:

```
node dist/src/scripts/export-points-recovery.js --database-copy /absolute/OWNED_STOPPED_COPY --policy live-policy.json --policy-sha256 SHA256 --output /absolute/NEW_DIRECTORY
```

This uses a fixed read-only RocksDB repository, no environment credentials, RPC or service connection. Full file hashes before and after detect an active writer or read-only engine side effects. It creates `STARTED.json`, `soratopia-entitlements.json` and `EXPORT.json` exclusively, retaining exact input and output pins. A changed copy or policy fails. This is post-activation internal-integrity export only; `preReleaseGenerationVerified:false` remains explicit.

For a finite **pre-checkpoint journal segment** in a stopped isolated indexer copy, use an allocation policy (no outer manifest or future anchor):

```
node dist/src/scripts/points-journal.js export --database-copy /absolute/OWNED_STOPPED_COPY --policy allocation.json --policy-sha256 SHA256 --first 1 --last 4096 --output /absolute/NEW_SEGMENT
node dist/src/scripts/points-journal.js validate --manifest /absolute/NEW_SEGMENT/EXPORT.json --manifest-sha256 SHA256 --policy allocation.json --policy-sha256 SHA256 --output /absolute/NEW_VALIDATION.json
```

The exporter uses direct keyed reads and streams `journal.jsonl`, retaining the referenced valuation snapshot alongside each journal. Segments are limited to 4,096 blocks and 512 MiB; choose a shorter range when needed. The standalone validator bounds each line before JSON parsing, hashes the exact parsed stream, rejects missing/reordered/repeated heights and conflicting inputs, and recomputes the existing receipt formula without changing numeric strings or scoring. New outputs never overwrite earlier evidence. The exporter hashes the complete stopped database before/after and both commands recheck input pins after publication; only a successful process completion counts as a successful export/validation.

`commitmentChainVerified:true` means internal segment consistency only. A later segment's supplied starting cursor is not an authenticated full prefix. Every result keeps `suppliedSegmentStartAuthenticated:false`, `storageProofsVerified:false`, `scoringReexecuted:false`, `historicalCoverageVerified:false`, `externalReplayVerified:false` and `productionReady:false`. Neither this validator nor a collection of segments clears the native historical rederivation gate. The production checkpoint data has not been exported or replayed by adding this tooling.

The canonical ledger schema is `sora-nexus-soratopia-checkpoint-projection-v1`. It commits policy/genesis/checkpoint and `allocationPolicyDigest`, `checkpointReceiptRoot`, `projectionLedgerRoot`, and immutable affected-owner `records`. The canonical data excludes `releaseManifestHash`, post-fork anchor and live policy digest. Those live fields exist only in persisted admission records and the separate live export receipt, avoiding a circular Wasm/release commitment.

## Release gate still missing actual verification

The root package requires `soratopiaAllocationPolicy`, `soratopiaCheckpointEvidenceManifest`, `soratopiaEntitlements`, `soratopiaRecoveryVerifier`, `soratopiaRecoveryVerifierProvenance`, `soratopiaNodeBinary`, and `soratopiaNativeVerifier` for `soratopiaPointsOwnershipAndConservation`.

This candidate does **not** provide the native complete-history/valuation authentication pipeline. A production gate needs a fresh pinned invocation that authenticates the entire canonical input stream through the checkpoint (including the historical valuation inputs used by the existing point kernel), runs the same point extractor and independent-era/referral accumulation, proves destination absence/coverage, and reproduces exact canonical ledger bytes. An archived successful report, live exporter, source JSON, mock test, or policy CSV cannot substitute for that verifier. Actual full replay and final CSV/operator/external evidence remain pending. The pure allocation API is executable before release, but does not turn unauthenticated aggregates into proof.

On-chain `Soratopia.LastCheckIn` is handled separately by `soratopia-live-owner-candidate-v1`; that scanner inspects actual metadata/state and never assumes a row exists from local runtime source alone.
