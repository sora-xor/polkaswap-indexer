# TONSWAP XOR burn campaign data

The TS reservation campaign starts at finalized SORA mainnet block **27,720,478**. Its source SORA signer owns the future claim on tonswap.org; there is no Nexus or TON destination in the burn transaction.

A qualifying transaction is a successful atomic `utility.batchAll` containing exactly these two calls, in order:

1. `assets.burn` for the canonical XOR asset.
2. `system.remark` containing UTF-8 JSON `{"app":"polkaswap","kind":"tonswap-xor-burn","version":1}` (encoded as hex bytes for the extrinsic).

The marker accepts exactly those three fields. Ordinary burns, Nexus remarks, non-atomic `utility.batch`, extra calls and markers with recipient fields do not qualify. Compact `xorBurns` rows now expose optional `campaign: "tonswap"` and `extrinsicIndex` fields. Existing fields and record IDs remain compatible. Frontend SOLSWAP accounting must exclude rows tagged `tonswap`.

## Complete finalized snapshots

`tonswapBurnSnapshot(first: 100, after: Cursor, atBlock: Int, allowStale: Boolean = false)` returns `fresh`, `genesisHash`, `startBlock`, `indexedThroughBlock`, current `checkpointBlock` / `checkpointTimestamp`, `nodes`, and `pageInfo`. Omit `atBlock` on the first request; send that page's `indexedThroughBlock` unchanged on every subsequent request. Continue until `hasNextPage` is false, even when `nodes` is empty: pagination traverses the bounded compact ID index and omits unrelated burns. Reject GraphQL errors, missing metadata, stale timestamps, non-advancing cursors and conflicting transaction identities. The first snapshot block freezes the complete global history; clients order accepted rows by `(blockHeight, extrinsicIndex)`, never by transaction hash or address.

Coverage is persisted as `updatesStreams/tonswapBurnCoverage-v1`. On startup the worker replays every campaign block through the actual caught-up finalized chain checkpoint, including an empty start block. Each replay batch commits its burn documents and coverage atomically. Normal finalized block writes extend coverage only contiguously and in the same transaction as burn records. No normal chain checkpoint is rewound. Missing/pruned historical data prevents certification rather than certifying a partial stream.

The dedicated endpoint bypasses cache and rejects missing/incomplete coverage, an unready worker, more than two finalized blocks of lag, a block timestamp older than 60 seconds, or a checkpoint inconsistent with normal finalized indexing. Campaign coverage contains the reviewed SORA mainnet genesis and canonical block hash. The deployment-compatible implementation additionally compares archive block identity with the primary mainnet RPC before certifying each campaign block.

For read-only historical display, clients may explicitly pass `allowStale: true`. A proved-complete stored finalized snapshot can then return `fresh: false` when the finalized chain stalls, the worker is unready/unavailable, or its lag exceeds two blocks. This does not include unfinalized burns or invent new rewards. Missing/incomplete coverage, foreign-chain or malformed identity, future block timestamps, an unreadable repository, and disagreement with the stored finalized checkpoint still reject. A mismatched concurrent checkpoint read is retried once to avoid straddling an atomic commit; persistent mismatches reject.

Default requests and `allowStale: false` retain the original fresh-only behavior. A client must preserve history and clearly pause burning when any page reports `fresh: false`; it must request a new fresh-only complete snapshot immediately before signing. Never infer current availability from a successful historical response, replace the historical checkpoint timestamp with wall-clock time, or grant rewards from wallet-pending records.

## Allocation and limits

The frontend/claim implementation consumes the complete global finalized stream. It integrates the marginal rate `50 - 45 * eligibleXor / 1753357` TS per XOR. Only the first 1,753,357 XOR in execution order earns TS; the final crossing burn receives the reward on its remaining eligible portion. Extra XOR is irreversibly burned without TS. Maximum integrated TS entitlement is 48,217,317.5. Use exact fixed-point arithmetic and cumulative entitlement differences, including fractional XOR.

The ordinary burn extrinsic does not impose a chain-level campaign cap or reward reservation. A displayed quote is an estimate until finalized execution order is known. Optimistic wallet entries may be displayed as pending, but cannot establish the current price, global cap or final entitlement. Future TS distribution and source-wallet claim proof belong to tonswap.org at launch.

## SORA Trust exclusion

Burns by SORA Trust (`cnRus2m2Rn776v88H5RUtyiaXtr3daN6ePn6yenLKepx1SqYo`, AccountId32 `0x12bed8da37e42af92986e9c0988b588da0e23422c287aa81a4bec9bb1e82db02`) are excluded from TS rewards, cumulative eligible XOR, the rewarded cap, and the marginal rate. Snapshot filtering compares the decoded 32-byte account identity, so alternate SS58 prefixes and hexadecimal encodings cannot bypass this rule.

The underlying `xorBurns` documents are retained unchanged for audit. Pagination continues through excluded rows using the original compact-index cursor; an empty snapshot page can therefore still have `hasNextPage: true`. Finalized coverage includes all scanned blocks and is unaffected by account eligibility.
