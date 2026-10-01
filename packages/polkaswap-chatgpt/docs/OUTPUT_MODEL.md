# Result and pagination model

Each tool returns structured evidence with `kind`, `status`, `title`, `summary`, `provenance`, `warnings` and `data`. The accompanying text and result view summarize that evidence. The tools use `ok`, `not_found` and `unavailable`; a partially covered page can still have `status: ok`, with the limitation stated in `warnings`. Do not interpret `ok` as complete account coverage.

`provenance` identifies the available source, retrieval time and chain/indexer anchor. Read the fields actually returned: an unavailable source may have no verified block. Indexer freshness and finalized chain freshness are different observations and must not be silently combined. A page from an older pinned block is a snapshot at that block, even if retrieved now.

Amounts are strings. Preserve atomic integers, token precision and the returned precision-based decimal amounts. Missing values remain unknown. The cumulative denomination coefficient is metadata, not an additional decimal divisor for current balances. Historical transaction fees retain their historical units; current denomination must not be applied to them. No USD portfolio valuation or full accounting is calculated.

## `explain_transaction`

Input: one public SORA2 transaction `hash`. The returned transaction evidence comes from the indexer. It may establish a recorded success/failure, historical fee and call data, but call amounts are not independent proof of recipient balance changes. The actual dispatch failure cause can be unavailable because the indexer stores placeholder error indices. `not_found` means no indexed matching record, not an established transaction failure.

## `get_portfolio`

Input: one public SORA `address`, optional `first` and optional `after`. `first` defaults to **25** and is capped at **50 token-account storage entries**. The tool enumerates `tokens.accounts.entriesPaged` for that account directly on finalized chain storage and does not need an indexer asset registry. Native XOR is checked additionally on the first page only. The account is canonicalized to SORA address format without claiming its ownership.

`data.assets` contains returned holdings with asset identifiers, available token metadata, atomic balance categories and precision-based amounts. The first page may contain up to `first + 1` balance rows because native XOR is additional; its verified native row may show zero. `data.unresolvedAssets` entries contain `assetId`, `atomic` balance categories (`free`, `reserved`, `frozen`, `bonded`, `total`, `transferable`, `locked`) and `reason`. They preserve exact observed atoms when registered metadata or precision is unavailable, without inventing a symbol or decimal amount. A warning identifies a failed or unsupported read; omitted unavailable data is not a zero balance. The view does not enumerate separate vault, staking, held LP-share or other account-specific storage.

`data.pagination.hasNextPage` and `nextCursor` describe continuation. `scannedTokenEntries` reports the entries in this page; `nativeIncluded` identifies the first page on which the native check was attempted, not a guarantee that an unavailable native read succeeded. Use only the returned cursor for `after`. The signed, opaque cursor pins the same account and finalized block; its contents are not encrypted or secret. Later pages omit the first page's native XOR check. A cursor for another account, a changed cursor, a process restart or a pruned block cannot establish a valid continuation. If resumption fails, explain the limitation and start a new first page; do not merge blocks into a single wallet snapshot.

## `get_liquidity_positions`

Input: `address`, optional `first` and `after`. This tool still enumerates indexed **Pool XYK registry pages**, ordered by descending ID, then reads current provider shares at a finalized chain block for that page. `data.positions` contains returned supported positions. The page is not proof that no position exists in unvisited pools; follow `data.pagination` to inspect additional pools and check the block of each page.

Provider shares are chain quantities. Proportional reserve amounts and share percentages are rounded-down estimates. They exclude withdrawal fees and chameleon reserves and are not withdrawal quotes, lifetime P&L, annual yield, cost basis or tax figures.

## `get_account_history`

Input: `address`, optional `first` and `after`. `data.items` contains a bounded newest-first page of indexed signer activity, with `data.pagination` for continuation. Incoming transfers and event-only involvement may be absent. An empty page or the end of this indexer result does not establish a complete financial ledger. Do not derive complete wallet reconciliation or tax calculations from it.

## Operational results

Missing, unsupported, stale, busy or unreachable data must be described as returned, with the available warnings and evidence. Do not convert these states into invented balances, zero fees or a guessed transaction outcome. Portfolio pagination tokens are read-only continuation data; they do not authorize or sign chain transactions.

Liquidity base coverage: `get_liquidity_positions` defaults to native XOR-base pools. Set `baseAssetId` to a supplied public asset ID or `all` to inspect other/all indexed base assets. Keep the same filter when following a cursor. Each result identifies the selected filter and page coverage.
