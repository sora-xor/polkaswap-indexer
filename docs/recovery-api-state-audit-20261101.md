# Recovery API state audit — 1 November 2026

This is a source audit of the current candidate, not a production cutover or a
claim that the replay has completed. The retained production database still
contains the abandoned fork and remains in read-only hold. The separate legacy
replay is bounded at block 28,191,816.

## Current-state refresh before readiness

`ChainIndexer.startInternal` awaits the historical backfill and then
`runStartupMaintenance` before subscribing and setting `startupComplete`.
Maintenance calls `refreshDerivedState(block, timestamp, true, true)`: the last
argument already forces a full storage refresh. `indexedProjectionTimestamp`
requires the exact timestamped BLOCK document. `getProjectionQueryAt` pins the
reads to the selected block hash; projection refreshes are serialized.

Therefore a fresh recovery replay does not need a second periodic-refresh
switch merely to force startup reconciliation. At cutover, record the actual
completed projection height P and its canonical hash, require P to be after
final recovery activation, and compare the database and direct chain reads at
that same P. Do not compare a database at P with a moving RPC head. The existing
tests in `tests/chain.spec.ts` check that maintenance precedes subscription and
readiness, and that startup passes both snapshot and full-reconciliation flags.
Those tests do not replace the required live comparison.

The refreshed inputs are asset metadata and issuance, XYK metadata/reserves/
issuance/providers, order-book state, Polkamarkt state, `farming.poolFarmers`,
staking, referral relationships, and Kensetsu CDPs. In particular,
`farming.poolFarmers` must not be described as a complete refresh of all Demeter
user positions.

Reconciliation must verify authoritative removal as well as upserts. Current
assets, pools, order books, markets, positions, nominators and validators have
explicit authoritative collection reconciliation. Historical snapshots and
event records retain their original identities and timestamps. Their presence
is not evidence of a current balance or continuing ownership.

## API inventory for other affected storage

The public query surface is defined in `src/graphql/schema.ts`; resolvers read
repository documents rather than arbitrary chain storage. The `account` JSON
record is created by `createFinalAccountDocuments`: it contains an account ID
and latest history-element ID, not a System.Account balance object.

| Affected chain storage | Public indexer representation | Recovery handling |
| --- | --- | --- |
| `System.Account`, `Tokens.Accounts`, `Balances.Locks` | No current wallet balance, nonce, lock or freeze query | No account-balance projection to migrate. Wallet balances must continue to come from the chain. `Asset.supply` is different: it is refreshed from native/token total issuance. |
| `VestedRewards`, `PswapDistribution` | No vesting or claimable-distribution-state query | Not represented as current claimable balances. Event-derived burn and points outputs have separate recovery admission and verification requirements. |
| `Assets.AssetOwners`, `Permissions` | No current asset-owner or permission query | Asset metadata/issuance is refreshed, but that does not establish ownership or permissions. |
| Governance votes | Historical account points; Polkamarkt governance descriptors | Historical point ownership follows the recovery projection. Current Polkamarkt records are refreshed from Polkamarkt state. The indexer has no query for current general governance voting storage. |
| Bridge request and migration records | Historical calls/events, including bridge transfers | Preserve historical source identities. No API query exposes the full current bridge request map or `IrohaMigration` state. Do not invent migration transfers where no event exists. |
| `Offences`, `Session` | No complete offences/session-state query | Validator projections use the explicitly queried staking inputs; they are not a projection of all session or offence storage. |
| Referral relationships | `referrerRewards` records combine historic rewards with discovered pairs | New relationships are read from state; prior reward rows remain historical. Recovery claimable referral totals use the separate event-derived points projection, not these generic rows. |
| XYK providers | Timestamped `accountLiquiditySnapshots` | New provider keys are read at the projection block. Old snapshots remain historical and must not be presented as current wallet ownership. Compare the new provider set and quantities at P. |
| Kensetsu CDPs | `vaults` keyed by CDP ID and `ownerId`; historical `vaultEvents` | Current CDP owners are refreshed under the same CDP ID; historical vault events retain their source identity. Verify missing/closed CDPs against the final state rather than assuming upsert alone proves completeness. |

## Additional findings requiring resolution before full recovery replay

1. Block/event decoding already uses execution-metadata witnesses. Historical
   valuation and projection queries still use `api.at`, whose installed
   polkadot.js implementation caches registries by `specName`/`specVersion`.
   Original runtime 134 and the substituted recovery runtime 134 have different
   metadata. Storage decoding must be checked independently; block/event pins
   do not prove that these query registries are correct.
2. `prepareHistoricalValuationAdvance` normally invalidates its cache from
   decoded calls/events. Recovery applies raw state writes without those
   business events. Verify the sealed work bundle's affected storage against
   the valuation inputs (`assets.assetInfosV2`, `poolXYK.reserves`) before
   accepting hash-labelled cached values through that interval.

Claude's artifact review reports that the sealed recovery edits and activation
migrations do not change either valuation-input map. It also found matching
wire layouts for 19 statically identified storage reads across the two 134
metadata versions. Those findings narrow the risk; they do not replace the
final live comparison or establish coverage of every dynamically selected
storage reader. In particular, validate the staking reward-points codec after
runtime 138 activation. See section 12 of the coordination report.

## Historical replay compatibility correction

Live archive inspection confirmed that genesis, block 1 and block 1,000,000
declare `assets.assetInfos`, not `assetInfosV2`. Values use the four-field
`(symbol, name, precision, isMintable)` tuple. The existing historical valuation
reader required the later map and struct, so it could not start a block-1 replay.

The candidate now chooses the map declared by the exact historical query,
normalizes that tuple, and preserves exact precision. A declared but broken v2
reader still fails; it cannot fall back to legacy data. Legacy point reads
require a pinned size query so an absent ValueQuery entry cannot become a
fabricated zero-precision asset. This changes no amount or pricing formula.

Set `CHAIN_LEGACY_SORA_BLOCK_TYPES=true` for the full historical replay. The
existing reviewed local type bundle now applies to both primary and archive
clients when that setting is enabled. No new schema package was installed and
the reviewed JSON definitions were not changed.

After compilation, a separate in-memory diagnostic replayed canonical blocks
1–10 from the restored archive using the real block decoder and historical
valuation path. It reached block 10, hash
`0xb535cd57fae49a4d1fd50fba6c2660293e2ed4774bfc939572f8f3c6c6d3d4d6`.
It published no API, used no persistent database and bypassed current-state
startup maintenance solely to bound the diagnostic. It proves those early
reads decode successfully, not full-history completeness or recovery points
certification. The active legacy replay still runs the unchanged deployed
release from `source-release`.

## Remaining live acceptance

At one finalized post-activation height, compare exact issuance, reserves,
provider identities and amounts, orders, staking sets, CDP owners and
Polkamarkt records. Record counts and deterministic digests of sorted inputs,
including removals. Verify all frontend queries against the actual Pi endpoint
after a validated service replacement. Keep claims and
points certification distinct from query availability.

No source-policy identity, database checkpoint, old receipt, or worker admission
condition was changed by this audit.
