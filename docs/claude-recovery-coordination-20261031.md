# Recovery coordination for the archive and indexer — 31 October 2026

From Claude (the Production launch preparation session), for Codex, written 22:45 JST
(13:45 UTC). Everything here was read-only. No MOF service, Pi service, indexer database or
production node was changed.

How it was checked: a throwaway full node (release node 4.8.13-0acfac57d, macOS build)
started from a copy-on-write clone of the release snapshot, using the release spec named
"SORA". It synced the live network through MOF1 and MOF2 as reserved nodes, with RPC on
localhost only, no telemetry and no keys. The other sources were the release work bundle
(`~/dev/sora-recovery-work-bundle-v7`, `BUNDLE.json` SHA-256 `ff68e6e6…`) and the release
source at commit `0acfac57d` (GitHub tag `recovery-28191817`).

## 1. Finality stalled, then resumed around 23:00 JST

**Update at 23:04:34 JST:** the recovery chain is finalizing again, with best 28,191,950 and finalized 28,191,948 (`0xfd136df8bb57bdb2942b7c1a1d6004a6470961343ad6ac0b2332c28727777138`). The recovery was at chunk 132, Applying, with no failure. At 6-second blocks, the remaining Apply chunks take about 1.5 h, the audits and code staging about 2 h more, and runtime 138 follows. The analysis below is from 22:32, while it was stalled.

At 22:32 JST: best 28,191,909; finalized 28,191,816 (`0x60b63e40…`), 93 blocks behind;
16 peers.

The table lists the BABE authors of blocks 28,191,818–28,191,909 by authority index. Indices
follow `Session.Validators` order, and all 15 stashes are in the release roll call.

| Index | Stash | Blocks authored |
|---|---|---|
| 1 | `cnSbSN9Fbkn2DBQZHdgMP1EVfeEXRWjrpdafJHLJqrW7ZBfYH` | 20 |
| 2 | `cnSgNFZaSoRGMVqTenCDaPLQhTur42Es5kVL5bQE3jRBHV9un` | 1 |
| 3 | `cnSu6uWhoCJHvLLRooUyTuJGRzMR4YgNMBPV3GHoBsvLYaSAp` | 3 |
| 5 | `cnTd2LcRRAi2yaqtof3URkjDEFADPAsFGF5UF4gsqwbBWiSHQ` | 29 |
| 6 | `cnUG7rnJxpe49dnDuYv4gn5XbXrFUJsQX4LsLos4JENcFEzsg` | 15 |
| 14 | `cnXCoCUXWTCZqkR3Lfo4Hs9HJ8VUP4HKX5m1a6UGzPj6zqzkY` | 24 |

Not authoring:

| Index | Stash |
|---|---|
| 0 | `cnRpgnq8YUZtTtqcLYPzH4Yb8Vs27EJY2pN8wrJm71ThfGrn4` |
| 4 | `cnTTL4ihCzLkRT7wyjZA2JQeTjmiwwczxJAsih2eJwZG6ttfq` |
| 7 | `cnULofTPpy7mxwv1jrYtNmVkwjVF6myAmYZmmbAEE3Vy9Sa9y` |
| 8 | `cnUS6ssUq8sRZB48UNNsVd2BfQWBww8vw6Ayt2iT52rCaZ6cs` |
| 9 | `cnUrZR2Gd5FPSFQGGUWZweYxWM58zEoHY7aQySmqDMjBW15Lq` |
| 10 | `cnVCuEDifwFEuNxTgf6NxrtwYJ56SEiC4mVse6iLQADpHKxZK` |
| 11 | `cnVNzYq884MufA4qN5JQCG1PSjCvnErfiC3uS3s6k85iSb8Re` |
| 12 | `cnVS46aLyfRHTossU1ZEXaw6Eok1Lk9NeMdhJsSNzp7ywJLEq` |
| 13 | `cnWHoJkvECM4MzWGm9fyZQmtiaMkBfiX8hqNfKAbt5B8Wunk7` |

- **What was observed:** six BABE authors, and finality stalled at 28,191,816. GRANDPA set 7957 has the same 15 authorities as at the checkpoint, and a round needs 11 votes.
- **What isn't known:** there is no per-voter evidence. This node build doesn't expose `grandpa_roundState`, so authorship doesn't establish how many validators are voting. A running validator can vote without authoring, especially under the backoff described below.
- **Leading hypothesis: missing participation,** meaning fewer than 11 validators running with loaded GRANDPA keys. A validator whose keys didn't load would neither author nor vote.
- **Nothing else points to a problem.** The 11-validator practice network ran on this snapshot and these runtimes. It finalized 2–3 blocks behind best, reached Complete, and activated runtime 138 at 28,194,044.
- **Blocks are slowing down.** With finality more than 50 blocks behind, BABE backoff stretches the block interval: 1 block in 90 s at 21:46, growing toward about 10 minutes. The recovery crawls as a result: chunk 91 of 983 Apply chunks at 22:32.
- **When 11 vote:** the backlog should finalize in one go and 6-second blocks resume. After that, roughly 1.5 h finishes the Apply chunks, about 2 h of audits follows, and runtime 138 activates.
- **MOF1 and MOF2** are full/RPC nodes and do not count toward finality.

## 2. Shared prefix and anchor

- **Shared history:** blocks 0 through 28,191,817 inclusive, with identical hashes.
  - 28,191,817: `0x7f7c253fa72f32e7b03f32bdc9ae456fd7174fb131b689be6d876006124129f0`.
  - Its parent, 28,191,816: `0x60b63e40ce4de9b9c1408bf7455a6f5ced796825f2437a0ee8496476d80c56d6`.
- **The chains diverge at 28,191,818.**
  - The new chain's block is `0x15f8dc66c3be19d8de14acfe2558209a9140bc94c64aaf00b36507020f6aae75`, with parent `0x7f7c…`.
  - Every old-chain block from 28,191,818 on belongs to the abandoned fork. Pi's retained checkpoint, 28,192,678 (`0x171543e0…`), is 861 blocks into it.
- **Block 28,191,817 executed identically on both chains.**
  - The code substitute is used only for blocks built on 28,191,817, so 817 itself ran on the old runtime. Its header and state root are the shared ones.
  - The new chain has not finalized 817 yet; its finalized block is still 28,191,816. Every recovery block descends from 817, and the recovery policy is bound to its hash, so 817 is the anchor.
  - Commit new-chain data only from finalized blocks (none yet), or index with reorg handling.
- **Timestamp gap.** 28,191,817 is 1792939560002 ms (2026-10-25 14:46:00 UTC). 28,191,818 is 1793448666029 ms (2026-10-31 12:11:06 UTC). Time-bucketed aggregates will see about 5 days 21 hours without blocks.

## 3. Post-fork metadata

The runtime version is identical across the fork: specName `sora-substrate`, specVersion 134,
implVersion 1, transactionVersion 131. The metadata is not:

| Runtime | Where it applies | Metadata | BLAKE2b-256 |
|---|---|---|---|
| Old 134 | State at 28,191,816 and earlier on either chain; 28,191,817 on the old chain (matches MOF2's sample) | 625,665 bytes | `0c1d4bf5c3bc5037ad854932443c94faae6c327ecf1f38b3e77d38668cc2b4b8` |
| Recovery 134 (code substitute `0x146fcae72031b1739463e30c5147a5a4de9070efbf6030d3e0e4269a9b7440ab` from block 28,191,817) | New chain at 28,191,817 and later | 626,869 bytes | `e6d4a5514a6c529c541844aad50597a60a798ae966e4f96b38af565cd78e2f9d` |

- **Never select metadata by (specName, specVersion) across this fork.**
- **Don't select it by the stored `:code` hash during the 134 interval either.** Stored `:code` stays the original (`0xa92a8b807c6e69ef336b1ea822706b98ad4c5220e9d13b6d8a360e1dad047543`) until the recovery installs the hold runtime. The substitute is applied by the client, not stored.
- **Select by chain and block range:**
  - 28,191,817 and earlier: the old metadata, as already indexed.
  - 28,191,818 and later on the new chain: fetch the metadata from a new-chain node at the block's parent.
- **Keep 817's existing decoding.** A new-chain node returns the recovery metadata even "at 28,191,817", which is wrong for decoding 817's own events.
- **Later upgrades are installed by the recovery near its end:** hold runtime 135 (`0xa35e1847e4711e021654483efd56377846ec990026faa9b46f676727f0665a5f`), then final 138 (`0x5585b306f87edbeeb7329f52ca23d709ad6f9d6bd10bb9c5a07de5a8a63a7bf3`).
  - Detect them by the runtime version at each block, not by `System.CodeUpdated` events.
  - The release's exchange notice draft gives the final activation as runtime 138 / transaction version 134.

## 4. Records that need repair beyond ordinary block events

Yes, repair is required.

- **What recovery blocks contain:**
  - Exactly two bare inherents: call `1.0`, the timestamp, and call `0.0`, a `System.remark` carrying the recovery envelope (up to about 43 KB).
  - Exactly two events, no signed extrinsics, and no business events. These remarks are not user calls.
- **How state changes:**
  - Each `RecoveryAction::Apply` chunk is a list of `GuardedStorageEdit { scope, key, before-hash, after-value }`. The recovery executive writes these directly to storage, and they emit no pallet events.
  - The bundle has 983 Apply envelopes with 125,528 edits, none in child tries.
- **About 94,300 edits go to recovery-only keys,** which hold evidence and history rather than business tables:
  - `:sora-nexus:historical-hashi-req…` 59,821;
  - `:sora-nexus:historical-outgoing-…` 28,741;
  - `:sora-nexus:historical-signing-…` 3,828;
  - `:sora-nexus:hashi-incoming-owner…` 1,864.
- **About 31,000 edits go to 66 pallet storage maps:**
  - **Balances:** `Tokens.Accounts` 3,242; `System.Account` 1,422 (XOR); `Balances.Locks` 482.
  - **Staking:** `Nominators` 1,326, `ErasStakersPaged` 1,164, `ErasValidatorPrefs` 824, `ErasStakersOverview` 824, `SpanSlash` 464, `Bonded`/`Ledger`/`Payee` 366 each, `SlashingSpans` 166, `ErasRewardPoints` 85; `BagsList.ListNodes` 285.
  - **Liquidity and rewards:** `PoolXYK.PoolProviders` 704, `PoolXYK.AccountPools` 256; `DemeterFarmingPlatform.UserInfos` 222; `VestedRewards.Rewards` 224; one `PswapDistribution` map 228.
  - **Ownership and control:** `Assets.AssetOwners` 87; `Permissions.Owners` 227, `Permissions.Permissions` 174; `Session.KeyOwner` 92, `Session.NextKeys` 46.
  - **Governance and referrals:** `Democracy.VotingOf` 408; `ElectionsPhragmen.Voting` 330; `Referrals.Referrers` 44.
  - **Bridge:** `EthBridge.AccountRequests` 192; `BridgeProxy.Transactions` 2,004, `BridgeProxy.Senders` 1,002; `BridgeMultisig.Multisigs` 2,049.
  - **Other:** `IrohaMigration.MigratedAccounts` 533; `Offences.Reports` 8,100 plus 2,618 in a second Offences map; two Polkamarkt maps, 99.
- **Consequence:** anything the indexer derives from events, or from older state, for these maps is wrong after the recovery. That covers balances, locks, staking, LP positions, farming, vesting rewards, asset ownership and permissions, governance votes, referrals, bridge request records, Polkamarkt and Iroha migration.
- **Repair: re-baseline from post-recovery state.**
  - Business state stops changing after the last Apply chunk, since audits and code staging don't touch these maps. Transactions resume only after activation, though, so the simplest baseline is the first finalized block with phase Complete (runtime 138).
  - Read state at that block for every affected entity, or re-snapshot whole maps (`Tokens.Accounts` and `System.Account` are iterable), and replace the materialized values.
- **Affected ids:** `/Users/takemiyamakoto/dev/sora-recovery-release-v7/analysis/recovery-apply-touched-ids.csv`.
  - 4,503 distinct 32-byte ids, decoded from the Blake2_128Concat parts of edited pallet keys, with edit counts per map.
  - Asset ids and technical pool accounts that appear as keys are included too. They are rendered as SS58 for uniformity; asset ids are not accounts.
  - 717 of the 760 old accounts in `mapping.csv`, and their 717 replacements, appear.
  - The mapping is `/Users/takemiyamakoto/dev/sora2-network/artifacts/recovery-28191817/production-inputs-v4/mapping.csv`, with columns `old_address,new_address`.
- **Effective owners:** the release's exchange notice draft is `misc/incident_recovery/EXCHANGE_NOTICE.md` in the release source.
  - Mapped replacements take over compromised accounts throughout mutable ownership and control.
  - Keep original identifiers as audit evidence while attributing recovered positions and entitlements to the effective owner.
  - Soratopia and TS/SS history up to the checkpoint is recovered for the replacement owner. Activity on the abandoned fork earns nothing.

## 5. Other facts for the cutover

- **No signed user transactions until activation, but the recovery's storage changes still need indexing.** Every Apply chunk changes indexed state without events, as section 4 describes. The absence of user transactions doesn't make recovery blocks skippable.
- **Bridges stay halted after activation.** The `:sora-nexus:recovery:bridge-halt:v1` key is present, and only governance removes it.
- **Probe status.** My throwaway node is still running locally on loopback RPC 39981 for further checks. It changes nothing on the network.

## 6. Review of the archive router and gateway (Codex's files, read-only review)

Reviewed `src/archive-router.ts`, `src/archive-gateway.ts` and their tests at about 23:10 JST.

- **Resolved by Codex:** the swapped or misconfigured upstream case. Both chains share genesis and block 28,191,817, so the original `verify()` would admit swapped URLs. It now pins the recovery first child (`RECOVERY_FIRST_CHILD`) and its parent, and has a swapped-upstream test.
- **Resolved by Codex:** admission checked only once. A 30-second identity recheck now closes all clients on failure.
- **Sound:**
  - Boundary routing by height and canonical hash: state at 28,191,817 and below goes to the archive.
  - Metadata, runtime version and `state_call` at 28,191,817 go to the recovery node, which is correct for decoding 818 at its parent.
  - Abandoned-fork hashes are rejected, including when both nodes keep the header.
  - Range queries and writes are refused, sizes, time and concurrency are bounded, and subscriptions go only to the live node.
- **High, indexer side: the polkadot.js registry reuse trap.**
  - `@polkadot/api` 16.5.6 reuses block registries by (specName, specVersion) (`base/Init.js:129`). An `ApiPromise` initialised through the gateway takes its default registry from the live head, which is the recovery runtime 134.
  - Every pre-fork block from the original 134 era that is decoded through `api.at` would then use the recovery metadata. On `/archive`, that era covers at least 28,100,000–28,191,816; at 28,026,743 the runtime is still 133.
  - The two metadata versions differ in structure. The recovery registry has 11 more types (1,217 versus 1,206 in polkadot.js), and every signed-extension type id is shifted. It also has new bridge items such as `Acknowledgements`, `DeferredTransferResults` and `RecoveryHalted`.
  - The worker's pinned-witness path (`decodeRecoveryBlock`) covers only heights from `policy.metadata[0].firstBlock` on.
  - Fix for any history decoding: make the API's defaults resolve at a pre-fork block, as in section 7, or extend pinned witnesses back to the first original-134 block.
- **Medium: pre-fork state has a single source.** Only MOF2's old archive holds state below 28,191,816; MOF1 and the recovery nodes are pruned.
  - The worker's primary/block-data payload cross-check can't be independent for that history.
  - Block identity can still be cross-checked independently, because recovery nodes keep every header and body.
- **Low:**
  - The hash regex accepts lowercase only.
  - `chain_getRuntimeVersion` (alias) is unsupported.
  - The archive is queried first even for recovery-chain hashes, which costs latency.
  - Justifications for blocks up to 817 come from the old node.

## 7. Bounded pre-fork replay through 28,191,816: safety assessment

The request: replay the retained Pi snapshot at 28,026,743 (hash matches the archive) up to finalized block 28,191,816 on the local workstation, using the exact deployed release, as an interim canonical legacy-history API. It does not admit any recovery policy.

**Recorded before implementing; none of these blocks the path, if the adapter enforces the conditions below:**

1. **Metadata trap.** The replay range crosses the 133→134 upgrade and then runs on the original 134 runtime. Without intervention, polkadot.js would decode most of the range with the recovery 134 metadata, as described in section 6.
   - Condition: every default (hash-less) read and the runtime-version subscription must resolve at block 28,191,816. The API's default registry is then the original 134 (`0c1d4bf5…`).
   - Must be proven against the live archive before any run (done; see section 8).
2. **Single-source state.** Events, timestamps and storage below 28,191,816 come only from MOF2's archive.
   - Mitigation: cross-check every block hash the adapter serves against the recovery RPC, which keeps all headers. A hash match pins the header, and with it the extrinsics root and state root.
   - Values read from the archive's state trie have no second source. This is accepted for an interim rebuild.
3. **Nothing later than the cap.** The adapter must reject every height above 28,191,816, including the shared 817, and every hash that isn't canonical at or below the cap.
   - Heads, the finalized head and subscriptions report 28,191,816 only, and never emit a second head.
   - That alone keeps both abandoned-fork and recovery-chain data out.
4. **Finality.** The cap must be finalized on the real recovery chain, and the adapter re-verifies that.
   - It is: the recovery finalized head is exactly 28,191,816 `0x60b63e40…`.
   - The worker stays below `RECOVERY_CHECKPOINT` with no recovery policy configured. Its post-checkpoint admission and its policy-only anchor checks (28,191,817) are never reached. The legacy identity anchor, 26,872,383, is below the cap.
5. **Inputs.** Replay a separate copy, never the source copy. The snapshot and the deployed release must be the pair that produced it; Codex is copying both.
6. **Not certification.** This is legacy history as of 2026-10-25 14:46 UTC. API health must not claim currency, and points or entitlements are not certified by it.
7. **Speed.** Measured from this workstation against `/archive`:
   - 0.51 s per block with one reused connection;
   - 0.041 s per block with 16 parallel connections, for three core calls.
   - 165,073 blocks then take roughly 2 hours, or about 4–5 hours including polkadot.js's per-block header and version reads.
   - Set `CHAIN_BACKFILL_PREFETCH_CONCURRENCY` accordingly; the worker requires RPC capacity of at least 3× that value.

## 8. Bounded pre-fork replay adapter: implemented locally and proven against `/archive`

These are new files only. Codex's gateway and router files and all production services are untouched.

- **`src/legacy-replay-adapter.ts`:** `LegacyReplayAdapter`, a keep-alive `jsonRpcClient`, and `createLegacyReplayServer`.
- **`src/scripts/serve-legacy-replay-adapter.ts`:** a runner bound to loopback.
  - `LEGACY_REPLAY_ARCHIVE_URL` defaults to `https://mof2.sora.org/archive`.
  - `LEGACY_REPLAY_RECOVERY_URL` defaults to `https://mof2.sora.org`.
  - `LEGACY_REPLAY_PORT` defaults to 9955.
  - It re-verifies every 30 s and closes all clients and exits on failure.
- **`tests/legacy-replay-adapter.spec.ts`:** 8 tests pass, and `tsc --noEmit` is clean for the whole project.

Behaviour:

- **Pinned values:** the cap 28,191,816 `0x60b63e40…` and genesis.
- **Admission:** both upstreams must agree on genesis and the cap, and the real recovery chain's finalized head must be at or above the cap.
- **Default and head reads:** heads, the finalized head, `chain_getBlockHash()` and every read without a block hash resolve to the cap.
- **Subscriptions:** new, finalized and all heads, runtime version and storage each answer exactly once from the cap, and never again.
- **Explicit hashes:**
  - A hash must be canonical on the archive at or below the cap, and it is cross-checked against the recovery chain's hash at that height.
  - 28,191,817, both first children and every later or unknown block are rejected.
  - Range queries, writes and unsafe reads (`state_queryStorage`, `author_*`, `state_getPairs`) are rejected.
- **`system_*` reads** pass through, because they carry no chain data.

Live proof at 23:05 JST, using polkadot.js 16.5.6 from this repository's `node_modules`:

| | Through the replay adapter | Gateway direct |
|---|---|---|
| Default registry | 1,206 types, no recovery-only storage, so the **original 134** | 1,217 types, `DeferredTransferResults` present, so the **recovery 134** |
| 28,026,744 | spec 133, its own registry | spec 133, its own registry |
| 28,150,000 and 28,191,816 | spec 134, default registry = original | spec 134, default registry = **recovery** (the section 6 trap) |
| 28,191,817 | rejected | served |
| Finalized head | the cap | the live recovery head |

Running the replay. Codex owns these steps and the production cutover.

1. Wait for Codex to report the copies in `private-indexer-backups/recovery-20261031/` as verified. Copy `source-db` to a separate working path and never open the source.
2. Start the adapter: `cd ~/dev/polkaswap-indexer && LEGACY_REPLAY_PORT=9955 npx tsx src/scripts/serve-legacy-replay-adapter.ts`.
3. Run the deployed legacy kernel from `source-release` against the working copy:
   - set `soraWsEndpoint` to `ws://127.0.0.1:9955` and leave the archive endpoint unset, or set it to the same URL;
   - configure no recovery policy;
   - set `CHAIN_BACKFILL_PREFETCH_CONCURRENCY` to about 8–16, with RPC capacity at least 3× that.

   The deployed kernel's configuration names may differ from the current source, so check them in `source-release`. The worker stops by itself at the finalized head, 28,191,816.
4. Verify before any cutover:
   - the last indexed block is 28,191,816 with hash `0x60b63e40…`;
   - spot-checked balances and aggregates at 816 match archive state.

   Then serve the result in recovery-hold mode as legacy history "as of 2026-10-25 14:46 UTC".

**Remaining limits:**
- State below 816 has a single source, MOF2's archive; block identity is cross-checked.
- This is neither recovery-policy admission nor entitlement certification.

## 9. From bounded legacy history to live statistics (assessment, 23:45 JST)

Analysis only. I did not touch `source-db`, `source-release`, the replay database, port 9955 or any production service.

### Where things stand

- **Recovery progress:** at 23:33 JST the chain had finalized 28,192,192, with the recovery Applying at chunk 377 of 983 and no failure. About 1,847 recovery blocks remain, so runtime 138 should activate around 02:40 JST at 6-second blocks.
- **Admission cannot promote the bounded legacy replay at 28,191,816; it is interim history only.**
  - `initializePointsRecovery` requires a start block of 1 or less and an empty point source.
  - Startup refuses to relabel a materialized database onto recovery.
  - So the only admissible route to live statistics is a fresh, isolated block-1 replay under the live policy. There is deliberately no admissible shortcut, such as a policy database that starts after the checkpoint, and none should be added.

### Sealed inputs for the live policy (values verified)

| Field | Value | Binding |
|---|---|---|
| `genesisHash` | `0x7e4e32d0feafd4f9c9414b0be86373f9a1efa904809b683453a9af6856d38ad5` | chain |
| `checkpoint` | 28,191,817 `0x7f7c253fa72f32e7b03f32bdc9ae456fd7174fb131b689be6d876006124129f0` | constant |
| `policyHash` (recommended) | `0x1f4e11427a9c0a61a4868af40c9e0bdf263bb44a9ee59886a537c52164f3cdbb` | BLAKE2-256 of `recovery.policyScale` in the release chain spec. It equals the commitment the runtime status reports on the live chain. Confirm that any preactivation burn-allocation policy already prepared used the same value. |
| `substitutions` | 760 `{old,new}` pairs | Decoded from `policyScale` (`RecoveryPolicy.replacements`, format 2). Set-identical to `production-inputs-v4/mapping.csv` (760 rows, including the trust-account row). Derive them from the chain-bound `policyScale`, not from a loose copy of the CSV. |
| `attackerAccounts` | from the sealed economic inputs (`economic.json` `attackers`) plus `ATTACKER_ACCOUNT` | Not in `policyScale`. The release tooling must show it is bound by the evidence commitment `0x019272a20f3241caeac056371b5a16c05b36d9c47377376a1ef63e3f185026f7` (gate G4). |
| `releaseManifestHash` | not sealed yet | v7.1 has no single sealed manifest JSON (gate G3). |
| `postForkAnchor` | recommended: the first finalized block after activation in phase Complete | Must be finalized, and present on both the primary and the archive endpoint. |
| `metadata` | the three witnesses below | Measured as described in the table. |

**Metadata witnesses.** Boundaries are counted in blocks executed by a runtime. The worker checks each block against its parent's metadata.

| firstBlock | lastBlock | executionCodeHash | metadataHash | Evidence |
|---|---|---|---|---|
| 28,073,393 | 28,191,817 | `0xa92a8b807c6e69ef336b1ea822706b98ad4c5220e9d13b6d8a360e1dad047543` (original 134) | `0x0c1d4bf5c3bc5037ad854932443c94faae6c327ecf1f38b3e77d38668cc2b4b8` | The upgrade block is 28,073,392 `0x2f2f6666f47f43f5ea077aa1848adb75e482f092a5bafbbd0261de7779db339e`; it carries the `RuntimeEnvironmentUpdated` digest. The archive's `:code` and metadata were read there and at 28,191,816. |
| 28,191,818 | A, the live activation block (28,194,044 in practice) | `0x146fcae72031b1739463e30c5147a5a4de9070efbf6030d3e0e4269a9b7440ab` (recovery substitute, the spec's `bootstrapCodeHash`) | `0xe6d4a5514a6c529c541844aad50597a60a798ae966e4f96b38af565cd78e2f9d` | Live chain at 817, 818 and the head; practice chain at 28,194,043. |
| A + 1 | open until the next upgrade | `0x5585b306f87edbeeb7329f52ca23d709ad6f9d6bd10bb9c5a07de5a8a63a7bf3` (final 138, the spec's `finalCodeHash`) | `0x5b277f5ece9a2ca90240e5e02337fc2f92118d3e5924c039362e64f85559ace0` | Practice chain at 28,194,044 and later, read offline from the same artifacts. Spec 138, transaction version 134. Re-verify on the live chain after activation. |
| only if Hold occurs | | `0xa35e1847e4711e021654483efd56377846ec990026faa9b46f676727f0665a5f` (hold 135) | measure then | Never active in practice. |

**Why the first witness starts at 28,073,393 and not 28,191,818.** Through the gateway, polkadot.js's default registry is the live head's runtime. Before activation that is the recovery 134, which would be reused for every pre-fork block the original 134 executed (section 6). A witness from the first original-134 block decodes those blocks with pinned metadata whenever the replay runs. After activation the default becomes 138 and the risk recedes, but the witness keeps the decoding exact.

### State reconciliation

- **What the worker re-reads.** Recovery blocks carry no business events. The worker's derived-storage refresh re-reads 12 domains, fully every 250 blocks (`fullReconciliationIntervalBlocks`): `assetMetadata`, `assetSupply`, `poolMetadata`, `poolReserves`, `poolIssuance`, `poolProviders`, `orderBooks`, `polkamarkt`, `farming`, `staking`, `referrals` and `vaults`. That pass picks up the recovery's edits to `PoolXYK` providers and account pools, Demeter farming, staking, referrals and Polkamarkt.
- **R1:** force one full derived-storage reconciliation at block A + 1, and verify it, instead of relying on the 250-block cadence. Acceptance: at the anchor, the derived domains equal a direct chain read at the same block, by counts and by hashes of provider sets and reserves.
- **R2: not covered by derived storage.** `System.Account` and `Tokens.Accounts` balances, `Balances.Locks`, `VestedRewards`, `PswapDistribution`, `Assets.AssetOwners`, `Permissions`, governance votes, bridge records, `IrohaMigration`, `Offences` and `Session`. For every API field backed by these, re-read the state at the anchor, or document that the field is not served (gate G7).
- **Event-derived history** (transfers, swaps, account activity, burn receipts) rightly shows no recovery movements, because there were no events. Points and entitlements follow the substitutions through `claimOwner`.

### Remaining gates

| Gate | Condition |
|---|---|
| G1 | Runtime 138 activation is finalized (around 02:40 JST). Read A from the finalized chain: the first block whose state is spec 138, which also carries the `RuntimeEnvironmentUpdated` digest. |
| G2 | Re-verify witness 3 on the live chain at A + 1. If the chain enters Hold, measure the 135 witness and re-plan. |
| G3 | Seal one immutable v7.1 release manifest. It should list: source commit `0acfac57d` (tag `recovery-28191817`); node `4.8.13-0acfac57d`; spec SHA-256 for v7.1 `6e39ce84…` and v7.0 `f2afe673…` (they differ only by name); bundle `ff68e6e6…`; policy commitment `0x1f4e11…`; evidence commitment `0x019272a2…`; snapshot `b1a6cfae…`; kit `deb5dba9…`; image `491331fd…`; the code hashes of runtimes 134-sub, 135 and 138. Its SHA-256 is `releaseManifestHash`. Keep the live policy out of the manifest, so the graph stays acyclic. |
| G4 | The release tooling ties `attackerAccounts` to the evidence commitment. |
| G5 | Produce the live policy JSON and sign the separate admission addendum that pins its SHA-256. |
| G6 | Run the fresh isolated block-1 replay with `SORA_RECOVERY_POLICY_FILE` and `SORA_RECOVERY_POLICY_SHA256`, through the archive gateway, which contains both the checkpoint and the anchor. Placement: from this workstation, 28.19 M blocks at the measured 0.04–0.1 s per block would take weeks; next to MOF2's archive it should be days or less, but measure first. Pre-fork state stays single-source (MOF2), with block identity cross-checked. |
| G7 | R1 and the R2 inventory of API fields are complete before cutover. |
| G8 | Codex makes the cutover from the hold to the certified database, after verification. |

### Safe interim route (no admission change)

- **Until G6 completes:** keep serving the bounded legacy history (Codex's replay to 28,191,816) in recovery-hold mode, labelled "pre-incident history as of 2026-10-25 14:46 UTC", with health unsuccessful. Show post-fork statistics as unavailable.
- **Cost before activation is zero,** because the chain accepts no transactions until runtime 138 is active. After activation, statistics stay paused until the certified database is live.
- **Don't build an uncertified live-statistics path into the indexer.** If the product needs one, make it a separate service, explicitly uncertified and with its own review, not a change to recovery admission.

## 10. Gates G3–G5 prepared (00:00 JST, 1 November)

These are local files only. Nothing in production or in the indexer was changed, and nothing is signed.

- **G4, attacker accounts: closed.**
  - The sealed input set is `~/dev/sora-bridge-launch-preparation-2026-10-31/inputs-v5/`. The canonical serialization of its `build-input.json` hashes exactly to the release spec's `evidenceCommitment` `0x019272a2…`.
  - Correction to section 9: `production-inputs-v4` in the main repository (`0xa7f8f175…`) and Codex's `inputs-v4` are earlier, unsealed sets. Only their mapping matches.
  - In inputs-v5, `economic.json` (`21a882f1…`) and `mapping.csv` (`95682dc6…`) match their bound digests. The mapping is identical to the 760 sealed replacements.
  - `attackerAccounts` = `["0x64650caa38ca952fc214cbb38cb625d779d1387b52910e664012cbd7d7593a7d"]`, with no EVM addresses. The runtime also hard-codes this account (`common/src/recovery.rs` `ATTACKER_ACCOUNT`) and rejects any replacement involving it.
- **G3, release manifest: drafted, unsigned.**
  - The file is `~/dev/sora-recovery-release-v7/release-manifest-v7.1.json`: canonical JSON of the shipped artifacts and sealed identities, written by a script that first checks the policy and evidence commitments.
  - Proposed `releaseManifestHash` (SHA-256) = `0xe3e09baf9cc015c64d309b49e782e75e24e3c3ad425b47d6d3c64a6978fde080`.
  - It deliberately excludes the live policy and the anchor. Review and sign it before use.
- **G5, live policy: generator ready.** The script is `~/dev/sora-recovery-release-v7/live-policy/make_live_policy.py`.
  - Run it after runtime 138 activation is finalized; before that it refuses. Checked just now: "activation is not finalized yet".
  - What it does:
    - finds the activation block A on both live RPCs;
    - verifies the final code and metadata at A, the runtime-change digest, and the recovery metadata at A−1;
    - re-verifies the original-134 witness on the archive;
    - picks the first finalized Complete block after A as the anchor, with both RPCs agreeing.
  - What it writes: the policy, once and never overwritten, with witnesses 28,073,393–28,191,817, 28,191,818–A and A+1–open. It prints `SORA_RECOVERY_POLICY_SHA256` for the signed admission addendum.
  - Self-test: the indexer's own `validateBurnRecoveryPolicy` accepted the format, using a stand-in anchor and writing nothing.
- **Reviewer decision: the final witness is open-ended** (`lastBlock` 9,007,199,254,740,991). Live indexing then continues past the anchor, and the next runtime upgrade fails closed on metadata mismatch until a new policy and addendum exist. A bounded `lastBlock` would stop live indexing at that block.
- **Still open:**
  - G1 and G2: activation, expected around 02:40 JST;
  - signing the manifest and the addendum;
  - G6: the block-1 replay, which Codex owns;
  - G7: the derived-storage and API-field reconciliation;
  - G8: the cutover.

## 11. G3 artifact binding verified; G5 policy generation automated (00:15 JST, 1 November)

Ownership as agreed:
- **Claude:** G3, G4 and G5 (artifact binding and policy generation).
- **Codex:** the R1/R2 reconciliation audit, replay placement, and every production change. There is no cutover yet.

- **G3: the shipped artifacts contain exactly the code the manifest names.**
  - The release chain spec's `codeSubstitutes["28191817"]` hashes to `bootstrapCodeHash` `0x146fcae7…` (recovery runtime 134).
  - The work bundle (`BUNDLE.json` `ff68e6e6…`, every envelope's SHA-256 checked) stages only **Final** code: 33 contiguous `StageCode` chunks, 2,128,514 bytes. Joined, they hash to `finalCodeHash` `0x5585b306…`, the runtime 138 that activates.
  - The bundle stages **no Hold code.** Hold 135's hash is pinned in the spec, but the runtime isn't shipped, so it can only appear through a separately authorized staging (`AuthorizeRepairStaging`). That would need a new policy and addendum anyway, so the live policy gets no 135 witness.
  - The kit and the image carry this spec and bundle (verified at release).
- **G5: automated.**
  - `~/dev/sora-recovery-release-v7/live-policy/watch_and_generate.py` re-runs `make_live_policy.py` every minute. It stops at the first written policy, or at any refusal other than "not finalized yet", after 6 hours at most.
  - Started at 00:10 JST. It runs inside Claude's session, so it stops if that session restarts.
  - The output will be `live-policy/recovery-policy-anchor-<block>.json` plus its `SORA_RECOVERY_POLICY_SHA256`, which goes into the signed admission addendum. Nothing is deployed.
- **Measurements for Codex's storage and placement plan:**
  - The retained Pi database is 17.55 GiB at block 28,026,743. A block-1 policy database should be about the same size, plus burn receipts and the points journal; plan for 25–40 GiB including RocksDB compaction headroom.
  - That doesn't fit MOF2's 27 GiB free on `/data` with any margin.
  - At the legacy replay's observed 7 blocks/s, a block-1 replay of 28.19 M blocks would take about 47 days. A co-located placement must be at least about 50× faster to finish within a day. Measure blocks/s on the candidate host before committing.

## 12. Focused review: valuation cache and api.at storage decoding (00:50 JST, 1 November)

This is a review only. Codex's active replay and production are unchanged.

### Finding 1: stale valuation cache during the recovery interval. Not reachable; no unconditional reload needed.

- **What `prepareHistoricalValuationAdvance` does** (`chain.ts:7469`): it re-reads `assets.assetInfosV2` and `poolXYK.reserves` only for assets and pools touched by extrinsics or events. With zero touches it carries the parent's valuation state forward. The order-book flag also comes only from touches.
- **The recovery never writes a valuation input.** All 983 Apply envelopes decode to edits in 70 storage maps. They include no `Assets.AssetInfosV2`, `PoolXYK.Reserves`, order-book, XST, price-tools or total-issuance edits.
  - The only `Assets` and `PoolXYK` maps edited are `Assets.AssetOwners` (87), `PoolXYK.PoolProviders` (704) and `PoolXYK.AccountPools` (256). Those are ownership and LP positions, which belong to derived-storage reconciliation (R1).
  - Audit and terminal-audit envelopes only read. `StageCode` writes staging keys only, and the bundle has no Incoming or Outgoing actions.
- **Activation doesn't touch them either.** Runtime 138's migrations (`runtime/src/migrations.rs`) are `RecoverFeeClocks`, `ScheduleMainnetPlainEpochConfig`, `RemapStakingRewardPointsToStash`, `PublishValStakingRewards`, `MigrateSyncStaking`, storage-version bumps for EthBridge, VestedRewards and Kensetsu, Polkamarkt v6 and v7, and the multi-block `AccountRequestsV3ToV4`. None touches assets or pools.
- **So carrying the valuation state across 28,191,818 to activation is correct.**
- **Recommendation, defense in depth rather than a fix:**
  1. Add one assertion to the bounded replay completion checks: at the first block after activation, the carried valuation state must equal a fresh `loadHistoricalValuationBaseline` at the same block.
  2. Optionally, force a baseline reload at the first block after any header carrying a `RuntimeEnvironmentUpdated` digest. The worker currently has no runtime-change reload at all.

### Finding 2: the api.at registry collision for storage. Real, but benign for every storage item the indexer reads today.

- **Confirmed:**
  - `getHistoricalValuationQueryAt` (`chain.ts:7152`) and `getProjectionQueryAt` (`chain.ts:7122`) use `fetchApiAtFrom`, which calls `api.at`.
  - polkadot.js takes the runtime version at the block's parent, then reuses any registry with the same (specName, specVersion) (`Init.js:129`).
  - So whichever 134 registry is created first, original or recovery, decodes storage for both intervals.
- **Measured exposure.** For every one of the 19 distinct `query.<pallet>.<item>` reads in `src/`, I compared resolved key, value, hasher and modifier signatures, ignoring type ids and paths, between the original 134 (archive, block 28,191,816) and the recovery 134 (live, block 28,191,818). **All 19 are structurally identical**: `assets.assetInfosV2`, `poolXYK.reserves`, `poolXYK.poolProviders`, `poolXYK.properties`, `poolXYK.totalIssuances`, `orderBook.asks`, `orderBook.bids`, `orderBook.limitOrders`, `orderBook.orderBooks`, `farming.poolFarmers`, `kensetsu.cdpDepository`, `staking.currentEra`, `staking.erasRewardPoints`, `staking.erasValidatorReward`, `staking.nominators`, `staking.validators`, `referrals.referrers`, `tokens.totalIssuance` and `denomination.denominator`. Either registry therefore decodes them identically.
- **Where the two 134 runtimes do differ** (none read by the indexer): `EthereumBeaconClient` FinalizedBeaconState, CurrentSyncCommittee and NextSyncCommittee; `Beefy` Authorities and NextAuthorities; `ApolloPlatform` UserLendingInfo, UserBorrowingInfo and PoolData; `ExtendedAssets.SoulboundAsset`. The recovery runtime adds `SubstrateBridgeApp.DeferredTransferResults`.
- **Recommended narrow fix: a guard, not a decoder change.**
  - Add a unit test with both pinned 134 metadata blobs as fixtures (`0x0c1d4bf5…` and `0xe6d4a551…`).
  - It asserts that every storage item the indexer reads has identical id-free signatures in both.
  - It fails the build the day a change starts reading one of the differing items.
  - At that point, and only then, decode storage in the witnessed range from pinned metadata, as `decodeRecoveryBlock` already does for blocks and events: a fresh registry per witness metadata hash, keys from `expandMetadata`, values over raw `state_getStorage`/`state_getStorageSize` at the exact hash. Nothing in the current replay needs to change.
- **For the R2 inventory (the 138 activation):**
  - Between recovery 134 and final 138, all 19 reads are structurally unchanged except `staking.erasRewardPoints`.
  - There, `individual` gains a single-field bounded-map wrapper (`{total,individual:{…}}` becomes `{total,individual:{{…}}}`). It is wire-compatible, but the decoded codec shape changes, so check the staking parser handles both.
  - Runtime 138's staking and Polkamarkt migrations change state without events at the first 138 block. That is another reason for the R1 forced full derived-storage reconciliation there.
- **Evidence:**
  - Runtime 138 metadata was read offline from the practice database (the same artifacts): `0x5b277f5e…`, 650,553 bytes.
  - The comparison scripts are in Claude's scratchpad (`structural_diff.mjs`, `bundle_edits.py`).

## 13. Codex follow-up — verified at 15:32 UTC / 00:32 JST

The R1/R2 source inventory is in `recovery-api-state-audit-20261101.md`.
Startup already awaits a forced full projection refresh before readiness;
the actual cutover still needs database-versus-chain comparison at one fixed
finalized post-activation height. The audit distinguishes current projections
from historical activity and identifies fields the API does not serve.

**Capacity correction to section 11:** the 17.55 GiB source snapshot does not
contain 28 million contiguous BLOCK records; its complete scan found 1,968,268.
A separate native 10,000-row diagnostic measured the new per-block points
journal alone at 11,982,351 SST bytes after compaction. Extrapolated over the
full interval, that is 31.46 GiB with one-byte fake blocks, no events/point
writes and empty valuations, before all real payloads, business data and
working space. Thus 25–40 GiB is not an adequate whole-database capacity plan.
The diagnostic is synthetic sizing evidence, not chain or entitlement evidence.
No unrelated data or retained database was deleted to make room.

**Block-1 compatibility:** live genesis and block-1 metadata contain
`assets.assetInfos` tuples, not `assetInfosV2` structs. Codex added historical
map selection, strict tuple normalization, and size-based absence checks for
legacy ValueQuery point reads. The existing reviewed legacy type bundle now
also applies to the primary RPC when `CHAIN_LEGACY_SORA_BLOCK_TYPES=true`, so
both checked RPC roles can decode early history. Set that flag for the full
replay. A bounded in-memory diagnostic using the real decoder/valuation path
reached canonical block 10; it published no API or persistent database and is
not a complete history or points-certification claim.

TypeScript compilation passed. The full suite has 3,555 passing and 92 skipped
tests, plus the same 16 baseline burn-boundary failures already reproduced on
unmodified `6e36294`. The active legacy replay remains on its unchanged kernel
`fd99dae5794e773c74f47c6ed3c11ae9b548cacc2aee6ec93eb574643396a895`.
It is protected by a one-shot guard that stops its exact process at the cap
and audits the stopped copy; it performs no production promotion.

The isolated archive's memory cap was raised from 4 to 12 GiB after measured
cache thrashing. Its PID/restart count, CPU quota and private network isolation
are unchanged. All public historical/boundary checks passed afterward.

## 13. Fixes from section 12 (01:00 JST, 1 November)

These are new files only. `chain.ts`, Codex's replay and production are unchanged.

- **Runtime 134 collision guard: added and passing.**
  - `tests/recovery-134-storage-guard.spec.ts` uses fixtures in `tests/fixtures/recovery-134/`: both runtime 134 metadata blobs gzip-compressed, about 136 KB each, pinned to `0x0c1d4bf5…` and `0xe6d4a551…`.
  - It scans `src/` for every `query.<section>.<method>` read. It fails if any read item differs structurally (id-free key, value, hashers and modifier) between the original and the recovery 134, naming the items to move to pinned-metadata decoding.
  - It passes 2 of 2 under the default configuration; the comparison test has its own 120-second timeout. `tsc --noEmit` is clean.
- **Staking reward points through runtime 138: verified, no fix needed.**
  - A real stored `staking.erasRewardPoints` entry (15 validators, 71,760 points) decodes identically with the recovery 134 and the final 138 registries.
  - polkadot.js unwraps 138's single-field bounded-map wrapper, so the parser's `individual.entries()` still yields 15 AccountId → `u32` pairs. Both encode back to the exact stored bytes.
- **Valuation cache (finding 1): no code change.** The section 12 assertion, that carried valuation equals a fresh baseline at the first block after activation, belongs in Codex's bounded replay completion checks.

## 14. Live-policy generator hardened after Codex's technical review (01:35 JST, 1 November)

The watcher was stopped before any policy was published. It was restarted on the hardened generator after the regressions and live checks below. The active replay, its database and `chain.ts` are untouched.

**Gap 1, attacker binding: closed.**
- `sealed_inputs` now pins `release-manifest-v7.1.json` by SHA-256 (`e3e09baf…`).
- It decodes the complete `RecoveryPolicy` from `policyScale`, with no trailing bytes allowed: format 2; checkpoint hash and state root (`79bda41a…`, equal to block 817's state root); 760 replacements, 8 council members, 983 Apply and 1,200 audit chunk hashes, all matching the manifest counts; the production authorization domain and release nonce; a non-zero terminal audit commitment.
- The **decoded** evidence commitment must equal both the manifest's and the spec sidecar's.
- inputs-v5 `build-input.json` must reproduce that commitment. `economic.json` and `mapping.csv` must match their bound digests. The attacker list must equal the pinned `0x64650caa…`.
- The mapping must equal the policy's replacements: no overlaps and no attacker involvement.
- The spec's three code hashes must equal the manifest's.

**Gap 2, anchor: closed.** `anchor_after` reads the status at the same hash, A+1, on **both** live RPCs. Both must equal exactly the sealed 50-byte terminal status:
- format 1;
- policy `0x1f4e11…`;
- phase Complete (4);
- next chunk 983;
- operation counter 0;
- failure None, with no trailing bytes.

The practice chain run of this exact bundle and policy measured exactly this, from activation onward. `activation()` now also requires spec 138 at the finalized head on both RPCs and the 134→138 boundary on both. `check_witnesses` also checks that the stored code before activation is the original 134.

**Gap 3, publication: closed.**
- The policy is written to a private `mkstemp` file in the same directory, fsynced and validated by the indexer's `validateBurnRecoveryPolicy`.
- It is published with `os.link` to the final name, which fails if the name exists, then the directory is fsynced.
- The temporary file is always removed. A failed validation publishes nothing, and an existing policy is never replaced.

**Evidence:**
- `live-policy/test_make_live_policy.py`: 16 offline regressions pass, with no RPC, no indexer and never the real policy directory. They cover the sealed release accepted, consistent attacker tampering with and without a sidecar change, policy byte changes with a matching sidecar, decoder truncation and trailing bytes, manifest tampering, the seven terminal-status deviations, a disagreeing second RPC, differing block hashes, the unfinalized-wait message, failed validation, an existing policy, exact publication with mode 0644, and the self-test.
- Codex's `audit-live-policy-generator.py` now fails all three of its gap demonstrations, as intended: two `SystemExit` refusals, and the policy file absent after a failed validation.
- Live: `--self-test` was accepted by the indexer validator and published nothing. Real mode refuses: "runtime 138 activation is not finalized yet".


## Codex update — 1 November, 01:54 JST

The public canonical archive remains available. The bounded legacy replay has
moved beside it on MOF2, using the same verified page-1000 kernel and exact
cap 28,191,816. All 463 transferred files and 181 release files passed SHA-256
verification; native incoming inspection left every file unchanged. It reached
28,061,280 at 01:53 JST with no worker error. The supervisor enforces a 30 GiB
reserve and a 24-hour deadline, stops only its own processes and performs the
full stopped database audit. No production indexer cutover has occurred.

A fresh recovery diagnostic now passes blocks 1–4,096, all journals, continuity
and native indexes. Both historical asset tuple versions and the proven
pre-denomination interval are handled. The raw database is 66.84 MB including
25.72 MB essential blob files. A fresh-only compressed format is under native
parity testing; no existing database is converted. Full-history capacity and
replay duration remain unresolved. The final runtime-138 policy is still
pending and the independent verifier watcher remains active.

Closed snapshot consolidation reclaimed 33.70 GiB on MOF2 and 20.90 GiB on Pi,
with all paths and bytes retained. Pi has 85.55 GiB free, above its 75 GiB
reserve. Its operation stopped on the live-file guard; no guard was weakened.


### Codex validation update — 02:15 JST

Fresh format-3 replay passed all 4,096 journals and 39,427 documents across 26
collections against the uncompressed reference. Native indexes and before/after
file SHA checks pass. Total bytes including blobs fell from 66,836,243 to
34,590,804 (48.25%). Only seven explicitly retained execution-telemetry fields
differ. The candidate and all 255 exact frozen source files are preserved.
The full test run passed 3,654 tests with only the 16 known obsolete burn
fixtures failing; those fixtures now use block-hash/event-index identities and
the focused suite passes all 19 cases, including rejection-before-write checks.
TypeScript validation passes. No runtime behavior was changed for that test repair.

The independent policy checker now also requires the exact terminal operation
counter of zero; its five offline tests pass. Its watcher still waits for the
actual finalized runtime-138 policy. A bounded fresh replay runner is being
prepared with exact source/policy pins, normal startup, a 30 GiB root reserve,
owned-process shutdown and a 24-hour deadline. It does not publish or certify
partial history. No actual live-policy replay has started.


### Codex update — 02:48 JST

The bounded replay reached its exact canonical cap 28,191,816 with startup
complete at 17:43:46 UTC. Its worker and adapter stopped cleanly; the native
read-only audit is now checking every document and compact index. Production
Pi is unchanged. The two-file prefix API overlay is staged inactive on Pi,
with all 13,529 pinned source files, five unchanged inert remote extras and
18 symlinks verified; the old source release remained unchanged.

The isolated fresh recovery runner is staged at
`/srv/pi-indexer-recovery-20261101` on MOF2. All 44 runner tests passed again
on that actual Linux host. No full replay database or worker exists yet.
The actual finalized runtime-138 policy and independent receipt remain required;
the diagnostic 134 policy will never be reused. The current recovery chain was
at finalized 28,193,826, Auditing 1,025/1,200, runtime 134 at 17:45:30 UTC.

New copied SSTs can use tested APFS compression on Pi while preserving their
logical bytes and all retained source databases. The transfer remains bounded
by Pi's 75 GiB reserve plus a 1 GiB working margin; final capacity is not assumed
from the sample ratio. A separate return-copy/native audit is required before
any prefix API activation. Full-history capacity and live indexer recovery
remain unresolved. No source or policy attestation is being treated as an
entitlement certification.


### Codex full-suite result — 02:58 JST

After the test-only canonical burn-fixture repair, the complete indexer suite
passes: 3,672 passed, 92 skipped, zero failures (138 passing files, three
skipped). Actual installed test runtime: Node26.13.0/Vitest4.1.10, 20-second
budgets. The full log SHA is
`a4c183ed4f7ca7d329415e1c572a65e1d4ed69207831ce1f966bc99cab3d65e0`.
No runtime or frozen replay release changed for this fixture correction.

## 15. Recovery complete; live admission policy published (03:15 JST, 1 November)

- **Runtime 138 activated at block 28,194,042,** the first state on spec 138, transaction version 134. The recovery status is the sealed terminal Complete value.
- **Live at 03:15 JST on both public RPCs:** finalized about 28,194,066–068, 2–3 blocks behind best; the bridge halt is still present.
- Activation came 2 blocks earlier than on the practice chain (28,194,044). The practice run had its rekey pauses; the generator derived A from the live chain.
- **Policy, published by the hardened watcher at 03:14:10:** `~/dev/sora-recovery-release-v7/live-policy/recovery-policy-anchor-28194043.json`, accepted by the indexer's `validateBurnRecoveryPolicy`.
  - `SORA_RECOVERY_POLICY_SHA256=805a7874830d7fe19406730d0f5fec257fd6dca7df9c10e9077bf422b49e79b1`.
  - `postForkAnchor` 28,194,043 `0xe7c02d6f6990bc6c0f6356833db98ccdf3ed07fb628631e45236935470774e7c`, the first block executed by runtime 138.
  - Witnesses: 28,073,393–28,191,817 on the original 134; 28,191,818–28,194,042 on the recovery 134; 28,194,043 onward on the final 138.
  - `policyHash` `0x1f4e11…`, `releaseManifestHash` `0xe3e09baf…`, 760 substitutions, attacker `0x64650caa…`.
  - Re-verified independently after publication: the file hash, every field, and the anchor's hash, status and runtime on both RPCs.
- **Remaining:**
  - The user signs the release manifest (`0xe3e09baf…`) and the admission addendum pinning the policy SHA-256.
  - Codex then owns G6, the block-1 replay with this policy (placement still open); G7, R1 and R2; and G8, the cutover.
- Claude's throwaway monitoring node has been stopped and its snapshot clone removed.


### Codex recovery admission and replay — 03:19 JST

The actual final policy was independently verified at 18:15:38 UTC. Runtime
activation is block 28,194,042; the finalized Complete anchor is 28,194,043,
`0xe7c02d6f6990bc6c0f6356833db98ccdf3ed07fb628631e45236935470774e7c`.
Both approved live RPCs confirm the same activation hash, terminal Complete
status, 983 apply chunks, zero operation counter, 1,200 audit chunks, no pending
incoming audit, and the sealed terminal commitment. The exact policy SHA is
`805a7874830d7fe19406730d0f5fec257fd6dca7df9c10e9077bf422b49e79b1`;
independent receipt SHA is
`8b5630fd2fc71e7be6180b5760eb3e9cade6c7cf67bd864c4df36080daf95ff6`.
A separate agent also re-derived the sealed policy and checked the frozen worker
loader and concrete admission. This admits only an isolated fresh replay;
it is not signed public admission or entitlement certification.

The full format-3 replay started on MOF2 at 18:19:16 UTC as
`polkaswap-full-replay-20261101.service`, supervisor 1194275, worker 1194286,
under `/srv/pi-indexer-recovery-20261101`. Admission SHA:
`4821445dede8f02b0ce98b573c86abd7803366ddccf3d103d7564511fd84dac6`.
It reached block 792 at 18:19:50 with no worker error. Normal startup, complete
historical receipts, exact policy pins, 31 GiB free-space stop threshold and
24-hour deadline remain enabled. Full-history fit and production readiness
are still unproved. No public API was published from this partial database.

The bounded legacy source audit passed at 18:05:08 UTC: all 27,428,271 documents,
165,073 replayed BLOCK rows and native indexes passed; all 499 files were
unchanged. The source is byte-verified; its APFS-compressed return copy is now
in progress on Pi, where final target verification is still pending. A second
full native audit is required there before the read-only prefix
API can replace the old abandoned-fork hold. Existing source/rollback databases
and Pi's 75 GiB reserve remain protected.

### Codex existing-storage result — 03:38 JST

The approved MOF2 `/data` ext4 reservation was reduced from 11,721,143 to
2,344,228 blocks after UUID, layout, tool, mount-health and live-process checks.
This made exactly 38,407,843,840 bytes (35.77 GiB) available, leaving 8.94 GiB
reserved and the application's separate 30 GiB guard unchanged. Available space
was 77.50 GiB after both immediate and delayed verification. No physical resize,
service restart, database move or deletion occurred. The active archive and
prefix-transfer identities and source lock were unchanged. Evidence is in the
web checkout's `output/ops/archive-recovery-20261031/mof2-data-reservation-result-20261101/`.

This adjustment affects `/data`, not the root filesystem hosting the full replay.
At 18:37:21 UTC that replay reached block 16,132 with no worker error, but root
free space was 35,036,467,200 bytes, close to its unchanged 31 GiB stop threshold.
The growth is being investigated; no successful full-history fit is claimed.
Any later relocation/continuation requires a stopped, fully qualified source and
the same actual policy, not a fresh-only guard bypass or policy rebinding.

### Codex replay guard and Pi transfer — 03:48 JST

The full replay stopped cleanly at 18:38:33 UTC when root free space crossed
the unchanged reserve threshold. The worker exited zero at block 16,946,
hash `0xfdee5f76b4df5d2654cf99cfbe4c913a5c30857ebebd27acc901a3648881f99b`.
The normal stopped-copy tail/continuity check passed; policy pins and complete
file hashes were unchanged. Its database is retained (about 191 MB). Root space
subsequently recovered to about 42.8 GiB; the archive and recovery node remained
healthy with their original identities. A later 20-second metadata sample
attributed 99.89% of the current root-space decrease to an unrelated store plus
minor recovery-node growth; the retained archive was byte-stable. This supports
an external workload explanation but does not retrospectively prove the earlier
transient peak. No unrelated files or services were changed.
A separate, reviewed same-policy
continuation on `/data` is being prepared. The fresh-only launcher is unchanged.

The Pi return transfer completed successfully at 18:44:41 UTC. All 499 target
files match the source: 429 copied files plus 70 unchanged hardlinked SSTs.
Copied files use 2,437,091,328 allocated bytes; Pi retains about 82.77 GiB free.
Source posthash and continuous LOCK ownership passed, both remote groups exited
zero without signals, and both local SSH children exited zero. Receiver proof
SHA is `bfaa8e4df2853d6294146e6ee34052189db81e3bf3e9d09d4b71153a7b17043f`;
transport proof SHA is
`f3ad140f6f09ee2ba607cffa9be28dc8c4d08e4534a91fffeeab4a9cf2080921`.
The complete native Pi audit and read-only prefix activation remain pending.

### Codex private continuation and native Pi audit — 04:05 JST

The isolated replay resumed at 18:59:34 UTC from a byte-verified copy at
`/data/pi-indexer-recovery-continuation-20261101/recovery.rocksdb`.
Unit `polkaswap-full-replay-continuation-20261101.service`, invocation
`d7979838f5b74678b5dde1492b9ba736`, supervisor 1198683 and worker 1198721 retain
the original frozen runtime, actual policy, normal startup and private ports.
The unchanged source on root is retained. All 27 source/clone files matched,
and the native tail inspection was byte-identical to the original stopped
inspection. Admission SHA is
`b93435e4a1e48f18f7d9d2d3e8f38c763a247a58073c1bc2dda575b4454f2723`;
clone receipt SHA is
`3553bdbf60238b6fd30030053539fce776b32b89d335ec644f452e2f0472503f`.
All 49 operation tests passed on MOF2. The actual `/data` UUID/device/free-space
guard is checked every second; the 31 GiB stop threshold and 24-hour deadline
remain. Atomic progress reached 21,242 at 19:03:21 UTC with no worker/transport
error and 83,273,740,288 bytes available. This remains a private partial replay,
not complete-history certification or public recovery.

Pi's first native launch stopped before opening the database: Apple's Python
trampoline briefly appeared in `ps` before its final interpreter path. The owned
child exited by TERM, no native output directory existed, no database references
remained, and all 499 files were rehashed unchanged. A harmless exact-command
fixture reproduced the 4.6 ms trampoline and 30.7 ms final identity. The corrected
launcher allows only that exact transition for at most five seconds while
preserving PID/UID/PGID/session/birth checks; 30 tests and independent review pass.
All failed-attempt evidence remains retained.

The new `return-02` audit launched at 18:59:16 UTC, executor 85984 and native
read-only child 86013 (UID501). Its complete before-manifest passed, exhaustive
native index validation is running, and no failure receipt exists. The only
native stderr is the frozen inspector's documented progress line. No READY,
fresh finality observation or public API activation has happened yet.

A separate explicit statistics/history capability is being implemented as an
inactive candidate. The existing full-recovery writer cannot adopt the legacy
prefix through configuration; its genesis/continuity guards remain intact.
Any derivative must withhold entitlements, preserve a distinct suffix identity,
and pass independent source/native/API validation. The exact deployed frontend
still permits legacy/direct-chain burn fallback, so a tested frontend capability
gate is mandatory before a public statistics-only service can be promoted.
Neither candidate is deployed or a substitute for the full historical verifier.

### Codex canonical prefix is now public — 04:28 JST

Pi's native audit completed successfully at 19:22 UTC. Its native output is
byte-identical to the MOF2 source audit (SHA
`786455fba448810322010a84badc80e4f1a122da3b683cbcee397ec09db96c1f`), including
27,428,271 documents and exhaustive native indexes. All 499 files were unchanged
before and after inspection; the executor and native child exited. The native
wrapper receipt SHA is
`650d350b22371d2795f0cb43b08f175d269feb39d625cec2743ce4d2910c35a6`.

The separately reviewed READY contract
`41c72841be3c8fb12cbc5cd2df151998792c1308ead4c469265b94cd70c348d3`
was activated through the existing service label with its single graceful TERM,
retained rollback source, unchanged supervisor and native read-only entrypoint.
Acceptance completed successfully. The actual public Pi GraphQL endpoint now
reports block 28,191,816, hash
`0x60b63e40ce4de9b9c1408bf7455a6f5ced796825f2437a0ee8496476d80c56d6`,
`readOnly:true`, `ok:false`, stopped lifecycle and an explicit uncertified-history
message. It no longer serves the abandoned-fork checkpoint. This is a canonical
history repair, not healthy live indexing. Fresh finality provenance for this
activation was the shared block 28,194,663 on both approved live RPCs.

The independent full replay reached block 51,658 at 19:27:37 UTC without a worker
or transport error, with 83,096,383,488 bytes available on `/data`. Full-history
capacity and entitlement certification remain unproved. The inactive statistics
candidate now separates core assets/pools/order books from unqualified account
positions and entitlement views. Its required frontend guard has 673 focused
tests and 13 translation tests passing; the full frontend run passed 11,034 tests
but reported one unchanged browser-crypto suite-load failure under investigation.
No statistics candidate, frontend origin change or Bunny update has occurred.

### Codex frontend protection is public; private statistics copy qualified — 04:57 JST

The prerequisite frontend release is now public. Production CID is
`bafybeicx4dys6utqk5ll7ncsysaqyfdhn3tpxdil6fvchtpggqu5k44tju`; paired testnet CID is
`bafybeic5wsqettwkebtlpw3wuw4tjazzufdw6rraglnprozwywlnl7iipu`.
Both DAGs were separately imported and fully pin-verified on Pi. Bunny's exact
Polkaswap zone was saved and purged using its existing private API configuration;
all required settings and edge rules were preserved. All five required live
WebKit routes plus Burn passed with zero failed requests or console errors.
All 930 complete public responses (42,293,015 bytes) matched the built release.
The live verification receipt SHA is
`dab051e0684f480dfd40d1313d3555cd504908deed83f5063705339229d62ad9`.
Migration remains removed. Uncertified claims and estimates are unavailable;
ordinary burn submission remains available. No wallet signing was performed.

The separate MOF2 statistics candidate has an independent, stopped copy of all
499 prefix files. Source and target bytes match; all original 27,428,271
normalized documents were scanned and committed by digest. The prior complete
native audit is inherited explicitly from exact source bytes, rather than
misrepresented as a second clone index scan. Qualification receipt SHA is
`c9b959cfd6361814780d135edf2584cdf14e6879f3424a240eb8016d038597f9`.
No initializer or worker has opened this candidate. The reviewed finite
initializer and post-initialization exhaustive audit are being prepared.
Its separate mode cannot certify entitlements or replace full recovery.

The full replay reached block 82,441 at 19:56:54 UTC without worker or transport
errors; `/data` retained 64,081,817,600 bytes at 19:57 UTC. The retained archive,
gateway, recovery node and replay services remain active with zero restarts.
Pi still serves the canonical read-only prefix through 28,191,816, explicitly
unhealthy for live indexing. A synthetic Pi APFS clone fixture proved distinct
inodes, shared initial extents and source preservation, but also proved that a
small write can expand a compressed clone to its logical size. No real Pi
statistics clone or service transition has been performed; its 76 GiB stop
threshold remains unchanged.

### Codex private initializer and pre-promotion findings — 05:15 JST

The MOF2 one-shot statistics initializer completed with exit zero, no stderr,
no signals and observed native WRITE LOCK ownership by its UID1000 child. It
closed and was reaped before the controller acquired the candidate lock for the
read-only post-audit. The initializer uses frozen release-v2 manifest
`573e3748095ddc593d8ba449e2c6f5b4dbaf32387a674125a5a064cf34078f34`;
the admitted request is
`cd21e9cd4a1581c80e4338145cff095fc5318bdf84c058cb807d15117caae52e`.
The exhaustive current native index audit remains running; successful
initialization alone is not qualification. No statistics worker has started.

Independent review found two candidate defects before any public promotion:
current-core pagination could mix reconciliation generations, and `api.at`
reused the original-134 registry for substituted-134 state. The raw metadata
witnesses are correct, but the reused query registry omits a recovery storage
item. Comparing raw V14 metadata bytes directly with the API's negotiated V16
representation is insufficient; the decoder correction uses a fresh, pinned
state context with the existing retained types. A separate candidate version
will include this adapter and generation-bound cursors/operation coherence.
The already running full replay and frozen initializer/auditor are unchanged.

The guarded Pi copy-only operation has now been reviewed and authorized using
tools-v2 package `a1287a63bb0ded49b56a6c47bced1f1e98b0ce9732d9c520e5c054eb8bb0a9cc`
and admission `f91b0140173ecc7bb6decadb9a4cad99ec83d067ffe291ef6bfbdf3349261e6f`.
It has a 76 GiB protected floor and 128 MiB observed clone-allocation budget,
and permits only fresh APFS clones, with independent inodes and complete byte
verification. A pre-execution umask issue was found and corrected in v2;
25 tests and an actual root-to-UID501 access fixture passed. The older staged
tools remain retained and were never run against the real database. The Pi
operation does not open a native database, initialize it, change any service,
or qualify a future writable suffix. The public canonical-prefix API remains
the rollback service throughout.


### Codex private qualification completed — 05:39 JST

The MOF2 initializer and exhaustive post-audit completed with exit zero; all
children were reaped. All 27,428,271 original normalized documents retain digest
`1497ab33d6e532a458d4c825ecf5401ea703a75f363606f8d9905cfbd3286c7e`, exactly three
seed rows were verified, and exhaustive current native indexes passed. The
read-only audit and the whole operation preserved candidate and source bytes
respectively. `INITIALIZED.json` SHA is
`cc62fd611b496f3c05c22653fed9c2af3073e265a43280540b90401033d3f41d`; native output
SHA is `54b51d1ba920d0e4a9eb9fb0abd8060a17a7a0f3e2e3f57042f743fbf7cb11f1`.
The exact stopped candidate file map is
`37a7cb7c3500875479adbba3ce6b1fda20b6365e601a1c2955a3698fa9795270`.

Frozen backend v3 manifest
`c418cdb2b4c56923ce3842408731b81f400ac93d039b9dd01c3cf24399e5d758` passed 3,764 tests
and an actual five-state read-only witness on MOF2 Node 24.16.0. The probe made
98 sequential RPC calls and verified all 591 release files before and after.
The activation state at 28,194,042 uses its dedicated fixed context (state 138,
parent 134); reentry after 28,194,043 passed. Witness SHA is
`d54b38378f5cbcd281ea4aa231dc16738d15edefdf3616253be345d61aa5a76e`.
No worker or listener was started by this probe. The first bounded private
suffix trial is under final review, not yet running or publicly promoted.

Pi's APFS copy completed and all 499 files matched with independent inodes.
Source bytes/POSIX metadata and the existing canonical API remained unchanged.
Clone receipt SHA is
`eef09d60a40d43b6fad725ab702a0c2942ead1503800845c7ac554b55db00482`.
This is byte-clone evidence, not a Pi native initialization or writable capacity
claim. Separate Pi initializer preparation is underway; its working-space budget
remains unset until actual suffix rewrite measurements are available.

The public GraphQL service still reports the canonical read-only cap 28,191,816,
workerReady=false and uncertified entitlements. Polkaswap still serves the
verified capability-guard release, with Migration removed. The independent full
replay reached block 110,342 at 20:37 UTC without a worker or transport error;
63,787,913,216 bytes remained available on `/data`. Full replay capacity and
entitlement certification remain unproved.


### Codex first private suffix trial — 05:48 JST

The first MOF2 statistics/history trial is now active with frozen backend v3.
The tools-v4 package is
`d1fecef290f68fa4f733852932379968a1e013eb29169a686fd62b2617d78b1f`, and the exact
one-hour request is
`7c10a94fe4da212e1b02a145a82b29fb372ab3a483a40911736c8d2348d7e18e`.
All 56 offline tests passed locally and on MOF2, followed by independent review.
Tools-v3 and its request remain retained and were never executed. The corrected
monitor distinguishes explicit moving-checkpoint responses from genuine errors,
resets its readiness observation window on an inconclusive sample, and measures
consecutive listener unavailability rather than total process uptime.

The pre-reader exited zero and was reaped, with no stderr. It read the actual
inherited stopped/no-error heartbeat without synthesizing or changing it.
Worker PID 1210263 was starting without errors at 20:47:35 UTC, with about
1.095 GiB RSS and 59.32 GiB free on `/data`. The operation retains a 31 GiB free
space floor, 4 GiB net-growth limit, 8 GiB worker RSS cap and 8 GiB host memory
floor. It exposes only loopback ports 4037/9468 and cannot promote the public API.
After it stops, the held read-only inspector will retain exact per-block
statistics for a separate bounded raw-chain comparison. No automatic restart or
public switch is authorized by this first trial.

Pi preparation passed the full 3,828-test suite and TypeScript checking. Its
synthetic Darwin lock fixture observed the correct UID501 child kernel write
lock and release, with unchanged fixture bytes. The real Pi candidate is still
inactive; its initializer working budget remains unset until measured suffix
rewrite evidence is reviewed. No existing authenticated Pi-to-MOF2 GraphQL
transport was found in the approved topology, so no proxy/tunnel fallback has
been created and the separate Pi preparation remains the intended route.


### Codex first trial startup failure — 05:50 JST

The private worker exited with code 1 and was reaped before advancing the
initialized prefix checkpoint. Its actual native write lock was observed; no
termination signal was needed. The exact failure was the 100,000-row scan limit
in `initializeNetworkBackfillWindows`. The boundary query used descending block
height while excluding all recent-month timestamps, forcing a scan through the
entire month. The following ascending-height page query also lacked an explicit
lower block bound. The correction will use the existing timestamp index to find
the preceding boundary and a bounded height range for contiguous replay input.
The scan guard, original source, and public read-only API remain unchanged.

No automatic retry occurred. Frozen backend v3, tools-v4, request and failure
artifacts remain retained. A separate read-only failure qualifier is being
prepared to verify the stopped candidate and preserve its actual recorded error
before any manually reviewed retry. The new backend release will receive a
native low-scan-budget regression fixture and the required test/build checks.
Pi release freezing is held until that corrected backend is available; Pi
initialization and public promotion have not occurred.


### Codex failed-prefix qualification completed — 06:01 JST

The reviewed read-only forensic operation completed in 54 seconds with exit
zero, empty stderr, no signal and all children reaped. Its receipt SHA is
`4e7a4156134d04c96605941eb468516d8c1b83f952198a74723d4b33839ded40`; native output
SHA is `097da2cfca177cf6a98da9e5699782d5f14b64311b3367fe912fe8ff71f14e7b`.
The candidate before/after map is
`a205f3a5d23eff9d6ffbe8bf895e77251ece62eec534f5585b769158166a406d`, and the source
retains its exact original `987715ca…` map. The checkpoint remains 28,191,816,
with exact source chainIdentity/prefix BLOCK equality, unchanged three seed
records and unchanged protected collection digests. Full-recovery identities
remain absent. This was not another exhaustive current-index/document scan.

The actual failed heartbeat is preserved, including its scan-limit error and
lastSuccessfulIndexTimestamp 1,792,939,554, which ordinary startup loaded from
the persisted block timestamp. Its normalized digest is
`61bab956c4781322ff60efb123df06a5c3a7ad4956f3064cd0a72d5d54faf21d`.
The receipt is explicitly qualified-failed-prefix, successfulTrial=false and
retryAuthorized=false. A separate tools-v5 manual retry is being prepared to
bind this exact state to corrected backend v4; no stored status is being cleared
or synthesized. The normal worker must initialize its own status.

The corrected boundary search and explicit rolling-height range passed 56
focused stats tests, including native RocksDB regressions with a four-row scan
budget, equal-timestamp block IDs across a digit boundary, future-height
outliers, malformed boundary records, ordering and gap failures. Full tests and
build of the isolated v4 assembly are running. Its source is frozen v3 plus
only the reviewed worker, test and documentation changes; separate Pi additions
will be overlaid on that corrected baseline.


The manual retry tools-v5 runtime is frozen at
`dcaadb10cb5e7dc7a80a4a71f577e6e6c1b86077ada45c316d7661b682eaa2c9`.
All 65 offline checks and independent review passed. Trial-02 requires the exact
qualified failed-prefix files and heartbeat; its post-inspection still requires
a clean stopped worker with no error. Trial-03 would require a separate request
bound to a clean trial-02 stop and cannot carry the failed-heartbeat exception.
Final corrected backend v4 release/witness/request pins are pending; no retry has
been launched. The full test run is advancing through native disk flush tests,
with no reported assertion failures; no unrelated process is being changed.

At 21:02:28 UTC the independent full replay had reached block 123,362, with no
worker or transport error and 63,618,805,760 bytes free on `/data`. The retained
archive, gateway, recovery node and replay service were active with zero
restarts. These operational observations do not certify full-history completion
or the capacity needed to reach the head.

### Codex corrected runtime validation — 06:22 JST

Frozen backend v4 is release manifest
`e1bdcce6ccdc03c4ad95be024661d3ea920842f2692fe7d0f89a6cab6f7000af`, source manifest
`62c4f02904a370e907374982cc423d58d105eaa591d0dbf0363e959926f3f06e`. Root independently
verified all 591 release files. TypeScript and the private build passed. The full
isolated run passed 3,752 tests and failed 18: 17 required operational test assets
omitted by the frozen snapshot, and one unchanged native fixture's ten-second
afterEach close timeout. All four affected suites (48 tests) then passed in a
source-identical test fixture with the exact missing assets and a sixty-second
cleanup hook limit. Both logs are retained; this is combined validation, not a
claim that the first full run was clean.

The actual MOF2 Node 24 five-state witness passed, SHA
`e7233af2fa337b0881af1ee42acb0821bfe8cbde35b870d3307c0278919c3795`, with all frozen
files unchanged. It made 98 sequential RPCs and verified the state138/parent134
transition and later reentry to every earlier context. Inactive tools-v5 staging
also passed its 28 Python and 37 Node checks on MOF2. The separate manual retry
request is SHA `35a025ba9ea8efa97ed682ae2e0fa7d858670d5f6b09b8bb2f16b2d7c12c93f2`;
independent final request review is SHA
`7ac1bc3348ca5131ae87d0fab0d64fc94328542e565a2a8062594566164a551d`. These records
prepare trial-02; they do not claim it has run or permit public promotion.

At 21:21:29 UTC the independent full replay reported block 134,918, no worker or
transport error, and 63,490,404,352 bytes available on `/data`. Archive, gateway,
recovery node and replay were active with zero restarts. The live frontend still
uses `https://pi.soramitsu.io/graphql`; its API returns the canonical prefix
28,191,816 with repositoryReady=true, workerReady=false and ok=false. No live
indexing recovery is claimed. Pi's v4 overlay and synthetic-only runtime
qualification are progressing separately; real Pi initialization remains gated
on completed validation and an observed suffix working-space budget.

At 21:23 UTC root launched the exact trial-02 request after final validation
`33ee5757582788001107f8d75d0728a1da4320e3fed60f6ebe361f807cb72c94` and root review
`f6cbec31b6d5bca914a0a687d06b68ee9e31f6d8dceada73ad600de3ac2ebf4c`. The before
reader exited cleanly, and the worker entered normal startup on the private
candidate. Its first resource sample reported no worker error and about 1.15 GB
RSS; this is startup evidence only. Root owns the bounded supervisor, with no
automatic restart or public switch. The separate full replay and public
canonical read-only service continue unchanged.

### Codex trial-02 metadata timeout — 06:28 JST

Trial-02 advanced past the earlier rolling-window failure, but its worker exited
with code 1 at 21:26:42 UTC. The last sampled checkpoint was 28,191,828; the exact
stored checkpoint still requires read-only qualification. The recorded fatal
error was a 15-second `recovery.metadata` timeout for parent hash
`0x434eaa44a62c6d298ac62ea1de4064dfc80714e1abc322f53e88b7ca637d3bc0`.
Worker stderr SHA is `6d2ea29659d1220047201a3e68a1b4b0b194f780e05e0cb4e74a06c1b6d71c86`.
The supervisor observed its native write lock and reaped the worker without a
signal. This is a failed trial, not a clean stop or a completed suffix audit;
the exit receipt's `reason=deadline` is the runner's initial default label, not
evidence that its one-hour limit elapsed. There is no STOPPED receipt or retry.

Before failure, progress was slow (ten new blocks at 166 seconds, CPU 46 seconds)
with ample RAM and disk, suggesting waits rather than a compute bottleneck.
Separate read-only investigations cover the worker's metadata request path and
actual gateway/backend latency. A new advanced-state failure qualifier is being
prepared; it must preserve the actual checkpoint/error and cannot reuse the
first failure's unchanged-prefix admission. No timeout, public service or frozen
release has been modified. Pi initialization remains unapproved.

### Codex advanced stopped-state qualification — 06:40 JST

The separate read-only qualifier passed with no signal, empty native stderr and
all children reaped. Receipt SHA is
`bbc366410f4a6c56067d4e4092ee02b5053b229594fbb8d35151769efd906023`; native output
SHA is `a48a595ead28beefd3d1fca8ddef7e85ff501c2d83c1c75d94bfd752ca6bbc69`. The
actual checkpoint is 28,191,828 at the timeout's hash, timestamp 1,793,449,134.
Candidate before/after file maps match
`b1e49206497119030fac4868b704a9c73b345e0e748720404b5f6c19dc61e39c`; the original
source map remains `987715ca…`. The actual failed heartbeat digest is
`5b4c44797772d6151d177a5130c2f80076098ae6158990e6bf815bb058df665f`. Protected account
collections, source identity, original prefix row and immutable admission remain
unchanged. The advanced cursor and pending reconciliation were captured honestly.

Twelve committed suffix rows have canonical parent continuity and raw timestamp
proofs. Their exact ordered row digest is
`42ba7ec2b1a298da3263322c9f96a78f059e509cba3cb35666fd7e961b62537f`. Persisted swap,
transaction and volume totals are zero; this is not independent raw-event or
pricing validation. The eventual raw audit must cover these rows as well as any
later retry. This qualification preserves failure and does not authorize a retry.

The recovery node has no CPU quota or observed throttling, ample host RAM, and
compiled Wasm with pooling-copy-on-write. Its binary defaults to two cached
runtimes; max runtime instances is explicitly 32. Eight sequential metadata
probes showed variable latency from milliseconds to several seconds, with
identical response bytes. Slow calls consumed CPU without disk reads; no service
or resource setting was changed. Separately, exact-state duplicate reads through
identical primary/archive origins are confirmed. A stats-only bounded cache
preserves origin/state/witness identity, all per-consumer validation and finite
cancellation/deadlines. Isolated v5 passed all 3,793 tests (92 skipped), TypeScript
and private build. Its runtime witness and small concurrent read diagnostic are
being completed before another private trial.


### Codex clean trial-04 and raw-header trial-06 — 07:07 JST

The actual v5 metadata burst passed: twelve borrowers across four exact states
produced four metadata wire calls, maximum concurrency four and maximum metadata
latency 5.38 seconds. No RPC timeout or node setting changed. Result SHA is
`e34595c0d5741dbd69cc07500c4c3951d80fab7c669b5ea9239fc7cceb8745ab`.

Root gracefully stopped trial-04 to apply the separately tested header-path fix.
Its clean receipt is `1963a5ec765d3fc0e2b57f0b02f344f7ba0a64c59946b865d6cede729fbf9e84`;
checkpoint 28,191,882, hash
`0x8c63ff28cd96d5734a51e3e0fc99e3b10013a3162e87f423764a499e9dc401c2`, timestamp
1,793,450,778. The worker exited zero and was reaped. Source and protected account
collections were unchanged. Startup/API/core acceptance remained false. Native
inspection SHA is `a382c2578e21c0448217ddc592e7d3cb1be566a24f7bf8b8c937f64418334105`;
stopped file map SHA is `65aa3b8f6d0c8f2300a3295db7a6579a7005df42148cf4fe9c123a373f44966f`.
The eventual raw audit must join the first twelve forensic rows, these fifty-four
rows and all later rows. Partial peak rewritten bytes 175,735,627 are not full
suffix capacity proof.

Backend v6 release SHA is
`8586aa7483324725160714c540edf6313445a73ac9ade30718a0225b1927b1f8`.
Combined validation SHA `77fbd0e91b95b379acf7d4394d9170e00bcad360b194af3192e1d51081264857`
records 3,811 passing tests on the immutable base, the exact final two-file
aggregate-bound delta with 62 focused tests, TypeScript/build and the five-state
Node24 header/runtime witness. It explicitly does not claim a single full run
of the final source. All repository/index/normalizer bytes match v5.

Root independently checked all release/package bytes and launched one bounded
trial-06 using tools-v7 package
`57464bd59017ca4ce0e85f52934bec471286bb15b6afbde34d67460e21e286ac` and request
`eecd2fa91c7ad41d05ebfaedcab3085b9cb1edf082244433391d97625ce5f5f2`.
All 67 local and Linux tools tests passed. Root review is
`34d847d65efe0ecf83fc0f18312a3c2f444f85586270c29c3e9c69aabd10d9a1`.
The exact prior clean stop and full heartbeat are required; there is no failed
heartbeat exception or automatic retry. Public Pi remains at the canonical
read-only prefix. Full replay is independently at 165,015 with no reported error.
No user message has been copied to Claude; this file records technical evidence.


### Codex runtime-cache diagnosis and preserved pauses — 07:21 JST

Private trial-06 stopped cleanly at 28,191,982, hash
`0xda79e17c90bb1342c6d516a12cc33795bc7412dbce4d8eb7b2c3d1ed446d89d1`, timestamp
1,793,455,680. STOPPED SHA is
`204072975794ccdf878d23abba78656859d843987afd2c3ca71a7856ee7b9f2f`;
after-inspection SHA `4755a0971cad20619f93a7913adda3797eb82a5264d607e62a7dd20859f6678f`.
It added 100 rows, had no persisted worker error, and still had not reached
startup/API/core readiness. Shutdown stderr contains two known AuthorizeCall
warnings and three metadata RPC Normal Closure cancellations at the stop time.
No RPC node settings have changed yet.

Pinned SDK source independently confirms an important missing cache consumer:
code_provider reads the original on-chain runtime version before selecting a
code substitute, using the same executor cache. Historical Metadata execution
then uses substituted runtime134; current head calls/imports use runtime138.
Thus three known code identities can contend in the recovery node's default
two-entry cache even though pre-fork gateway traffic uses the separate retained
archive. Independent review SHA is
`7edb8c71397847a37076b6ba1e438e6a6c2bb44883dac60eca37a53dafef8b04`.
This establishes the mechanism, not measured cache-hit attribution or a
performance guarantee. A reversible cache-size-eight adjustment is being
prepared. The baseline unit SHA is
`9d1200c1a58d389e19c5aa0a0c742ec5a26b9cead67934aaf2f1ce5df0a70778`;
SendSIGKILL must be disabled before its owned graceful stop.

Root also stopped the private full replay supervisor for this adjustment. Its
worker exited zero and the native tail inspection reached 168,867, hash
`0xc946574a2c22c6ec0dfe6872c29deccabd6e747dba92783765455a8ce14695ed`, timestamp
1,620,582,222. Its final port-bind guard reported Address already in use, so the
original STOPPED correctly remains stopped-needs-review, SHA
`441233856d6750de0ec53a23e402535c7af0bb9cb24a7224d685b7cfc3dd2d87`.
Both ports now have no listener and bind successfully. The past cause is not
proven; separate qualification must preserve the failure and bind the actual
stopped files/native tail before same-database resume. Neither replay is running
while the cache change and their bounded resume admissions are prepared.

Pi v6 installed runtime and synthetic native fixture passed, receipt
`e986997a53ecdd654a38b1f03b09c0c233c27057e941860fcd010406240e5b5d`.
Root reviewed one private initialization with a 4GiB working allowance, 1GiB
drain margin and unchanged 76GiB reserve. This is an initializer-only operational
limit, not a proven full-suffix capacity bound. Request SHA is
`934d398cacb85c7b88cf1179a9b162d6e91504c6b1838f26e2ce09d4659dafb6`.
The native initializer exited zero, with all three seed row hashes and empty
stderr. Output SHA is `3d6c74568c9c546e47cc8a3fb8a46acea194190d59fd0c87339598bc18624f0b`.
Its immediate post-exit lsof guard reported a holder and stopped before the
native audit. The holder was not recorded and cannot be attributed; a later
check found none. Original FAILED SHA
`35e20b19fd4737540debf630052572b1793d8800d1f0189078f35a77fe58e3fe` remains intact.
A separately reviewed audit-only continuation is being prepared; the initializer
must not run again. The source canonical Pi API remains untouched and live
indexing remains unavailable.


### Codex cache adjustment and replay resumes — 07:34 JST

Root applied the reviewed cache-size-eight adjustment on the existing MOF2
recovery full node. APPLIED SHA is
`4f8798f6b7c8f469376f6572d4afd96f0710ec314d553a6113fdab6d3af41068`.
The baseline unit and chain/database arguments remain unchanged; the exact
new wrapper/node arguments differ only by `--runtime-cache-size 8`. The old
processes stopped cleanly without forced termination. The retained service
guard now keeps SendSIGKILL=no and a ten-minute stop timeout. New wrapper/node
PIDs are 1224488/1224506. The archive gateway restarted once during the node
maintenance under its existing fail-closed identity checks, then recovered;
the retained archive/proxy/nginx processes did not change.

A direct sixteen-RPC postcheck completed in 0.068 seconds. Alternating exact
substituted134/current138 metadata calls measured 8.124–10.549ms and matched
both admitted metadata witnesses; runtime-version calls took 0.242–0.382ms.
Probe SHA is `901c1dfcaf0677a04216442b3e010bbbcbb9be3418708f20cc88355a4b6c6e80`.
The public gateway separately passed genesis, pre-fork/post-fork/anchor state,
header, timestamp, runtime and synchronized/peered health checks, SHA
`548be6f8ae355c97801fbf6c27f621731ebcae2e83e28121f482223dab406d23`.
All six selected public runtime/timestamp results matched their direct backend.
The public finalized sample was block 28,196,244; this is an observation, not
a fixed live-head assertion. Public HTTPS latency includes network/TLS overhead.

Root launched private stats trial-08 from its preserved 28,191,982 checkpoint,
request `53100c04972dc9c42867ffb9493cea59af36d67d944335e7859f71b02c360c13`,
and the same-database full replay resume from qualified block168,867, admission
`13daa60d1528b5836ae4784e69b0135dc9ee144c9633e8a68a876e67cc553f9d`.
The original full-replay port-check failure remains intact and is bound by
separate qualification `9b82d88136007fe47981b9efbf9c21eedf55db48775a323f73ec853f145d4c4d`.
Actual resumed progress/readiness must still be observed. Existing storage and
resource ceilings remain active; no storage purchase or host was added.

Pi's separately reviewed read-only audit continuation is running under parent
25829 with native reader26002. The original successful initializer is not
reexecuted. The audit preserves the original authorization deadline, source
files, reserve and allocation allowance, and will issue a distinct continuation
receipt only after complete document/index/seed checks. Public Pi remains the
canonical read-only prefix; there is no public API transition or entitlement
certification yet.


### Codex Pi ingestion witness and continued replay — 07:49 JST

Actual Node24 WebSocket testing on Pi found a precise limitation of the normal
public RPC: `state_getRuntimeVersion` at block28,191,815's hash
`0x1c2ab8bf2527b2d7deabbe51f82dae82515daef274517968381dd7878cd32a98`
returns4003 (`:code` hash not found), while state28,191,816 is available. This
is a dependency of the prefix816 historical query context. The failed
dual-origin witness is retained unchanged, SHA
`0fd33d209a17f204e1d03eb9a7fb587046c38171b814a8a4167fbf7f7b3a3b44`,
with reaped/verified-runtime EXIT
`bbd0005063bb5a39e8e55b91d439b351652de194db2f37ba7c77429764d62198`.
Four additional read-only HTTP calls on Pi confirmed that the canonical archive
serves both parent815 and prefix816. No source data was modified.

The recovery worker proposal now uses the fixed canonical archive
`wss://mof2.sora.org/archive` for both primary and archive roles, as the private
MOF2 trial already does. This is an explicit configuration, not automatic
fallback. The public wallet RPC, frontend and public Pi API remain unchanged.
The normal public RPC is not represented as historically complete.

A separately reviewed actual-Pi witness of that configuration passed206read RPCs
with maximum concurrencyone. Archive coverage includes all five original,
substituted and current-runtime states,20metadata borrowers with five context
wire reads, exact registry/core samples, transition state138/parent134, and
later-context reentry. Four post-prefix states and all four raw block/event/
timestamp payloads exactly match independent `ws.mof.sora.org` reads. Its
result SHA is `b110a3425527c8e584bdb914779b9c2960e765c2e2ed6d7611b2a9e6ec8d3f8b`
and EXIT SHA `bc08373889785909836a31176ca55b67b0e48643ad01fd39812834a0f18d7a45`.
The pinned Pi release/dependency/native-loader graph passed before and after;
the reader exited zero and was reaped. Stderr contains only same-version
CJS/ESM duplicate-instance notices caused by diagnostic imports and known
AuthorizeCall warnings, reviewed explicitly. No database was opened.

Stats trial08 has crossed the28,194,042 runtime transition and reached28,194,994
in the latest sample, without a worker error. Its initial catch-up target is
28,196,251; final readiness and current-head catch-up remain to be observed.
Pi's full native index audit is still running after its normalized-document
scan completed. No Pi suffix worker or public service transition has started.
