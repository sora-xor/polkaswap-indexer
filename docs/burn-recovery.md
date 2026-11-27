# SORA Nexus burn recovery

The recovery checkpoint is block **28,191,817**, hash
`0x7f7c253fa72f32e7b03f32bdc9ae456fd7174fb131b689be6d876006124129f0`.
No mapping, post-fork anchor, or execution metadata is guessed or shipped as a production value.

Burn receipts use actual `assets.Burn` event amounts and IDs `<blockHash>:<eventIndex>`.
The live worker and historical backfill share the extractor. Calls establish only
campaign and recipient association. A missing event never establishes a burn.
The historical source address is immutable; `claimOwner` is the effective owner.
Account queries use `xorBurns(orderBy: [ID_ASC], filter: { claimOwner: { equalTo:
"<canonical replacement AccountId32 hex>" } })`. Exact owner equality or nonempty
`in` selectors are required; receipt IDs, cursors and original addresses are preserved.
The native owner index bounds reads to selected owners and retains the query scan
budget for residual filters and total counts. Writable RocksDB preparation re-derives
this index in bounded batches before serving, including after an older format-2
writer was used. Read-only preparation rejects missing owner keys; it never silently
returns incomplete entitlements. Existing receipt documents are not rewritten.
`claimStatus=extinguished` cancels attacker entitlements after the normal allocation
curve, and `recipient-confirmation-required` holds a replaced account's linked
SORA Nexus XOR destination until the replacement key authorizes it.

## Isolated rebuild

Back up and retain the old indexer. Create a separate empty RocksDB path/database.
Do not lower `chainState`, clear history, or mix old transaction-hash receipt IDs
with event receipt IDs. Startup refuses legacy burn data without the new receipt
schema, recovery data without its policy, a policy change on an existing recovery
database, or an existing materialized database being relabelled onto recovery.
Startup and block admission reject post-checkpoint indexing without a policy.

Set `SORA_RECOVERY_POLICY_FILE` to the public policy JSON and
`SORA_RECOVERY_POLICY_SHA256` to its exact SHA-256 from the reviewed outer release.
The policy contains version 1, policyHash, releaseManifestHash, genesisHash,
checkpoint `{block,hash}`, a finalized postForkAnchor `{block,hash}`,
substitutions `[{old,new}]`, attackerAccounts, and contiguous metadata witnesses
`[{firstBlock,lastBlock,executionCodeHash,metadataHash}]` covering every recovery
block through the post-fork anchor. A contiguous historical prefix may start at
block 1 or later, up to the first recovery child. Every block at or after that
first witness requires a matching witness; an expired range fails closed. Hashes use lowercase `0x` 32-byte strings;
metadataHash is BLAKE2-256 of exact SCALE metadata bytes. The outer release must
bind these witnesses to the shipped substitute/code artifacts. The indexer does
not infer substitute code from `:code`, which still names the old stored runtime.

Both primary and archive endpoints must contain the checkpoint and post-fork
anchor. The anchor must be finalized before the worker starts. During witnessed
recovery intervals, blocks and event storage are decoded with fresh registries
from the executing parent's exact metadata, bypassing spec-version caches.

A restarted database must use the identical policy bytes. Recovery-ledger and
code/metadata witnesses must undergo the release verification independently;
this configuration is not an on-chain proof or permission to publish claims.

## Offline entitlement preparation

First obtain a complete authenticated historical event capture from the SORA
Nexus recovery tooling. `src/scripts/extract-burn-history.ts` runs the SHA-pinned
native verifier afresh; it checks the complete interval, headers, extrinsics and
storage proofs and then uses the shared event extractor. Run it with explicit
`--verifier`, `--verifier-sha256`, `--manifest`, `--verified-output` (a new
directory), and `--output` (a new receipt file). A diagnostic or incomplete
interval is rejected. It makes no network requests or database changes.

Run the existing local TypeScript runner:

```sh
yarn tsx src/scripts/prepare-burn-recovery.ts \
  --capture checkpoint-burn-events.json --capture-sha256 CAPTURE_SHA256 \
  --policy recovery-policy.json --policy-sha256 POLICY_SHA256 \
  --output new-recovery-burn-ledger.json
```

The preparation policy is `BurnAllocationPolicy`: version 1, policyHash,
genesisHash, the exact checkpoint, substitutions and attackerAccounts. It can
be bound before restart and does not need a post-fork anchor or outer release
hash. The live worker's `BurnRecoveryPolicy` extends it with the later finalized
anchor, executing-metadata witnesses and outer release hash; live admission
continues to reject the preparation policy on its own.

Keep the commitment graph acyclic. The recovery policy binds raw event evidence,
mapping and source inputs; the derived allocation ledger refers to that policy
commitment. The outer release binds the derived ledger and runtime artifacts.
Do not include the derived ledger back in the source policy commitment.

The capture has version 1, the exact checkpoint, coverage
`{firstBlock:25043003,lastBlock:28191817,evidenceHash:"0x…"}`, and `receipts`.
Each receipt has `id`, `blockHash`, `eventIndex`, `blockHeight`, `extrinsicIndex`,
`txHash`, `address`, exact natural-unit `amount`, and optional `campaign:"tonswap"`
and `nexusRecipient`. All identities and amounts come from verified finalized
events. The capture hash and complete range evidence must be reviewed separately;
this compiler cannot prove completeness from a list of receipts.

The compiler performs exact 18-decimal arithmetic, preserves TS ordering/cap,
checks SS tier boundaries, maps ownership after allocation, and marks attacker
allocations extinguished without redistributing their TS curve intervals. It
creates a new file exclusively and never mutates a database. The output remains
`prepared-requires-release-verification`; TS/SS distribution systems are not
implemented by this tool. Replacement recipient authorization belongs to the
separate claim-service release.

## Bound release verification

`scripts/build-burn-release-verifier.mjs --output NEW_DIRECTORY` builds one
self-contained offline verifier from the existing local dependencies. It writes
the exact bundle hash and every transitive source/lock hash to provenance and
refuses to overwrite an output directory. The SORA Nexus release packager pins
that bundle, the Node executable and the native recovery verifier independently.

`verify-burn-release` runs the full native proof verification, common event
extractor and allocation compiler afresh, then requires exact equality with the
packaged ledger. Neither a capture's declared coverage nor a saved success report
can replace that execution. Failed verification leaves no completion receipt.
The historical extractor and preparation library remain shared with their
original script entry points; the bundled verifier introduces no alternative
allocation or event-extraction rules.

The live admission policy is produced only after its finalized post-fork anchor
exists. Its releaseManifestHash refers to the already sealed recovery release;
pin the later policy using a separately signed admission addendum. Do not put a
live policy containing a manifest hash back inside that same manifest. The
preactivation allocation policy and resulting TS/SS ledger remain acyclic.
