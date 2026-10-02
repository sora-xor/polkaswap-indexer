# Review and release record

Package: `polkaswap-evidence`, version `0.1.0`, display name **Polkaswap Evidence**. The configured service URL is `https://pi.soramitsu.io/polkaswap-chatgpt/mcp`. Status: preview materials prepared; deployment, installation, verification and public review must each be recorded from actual evidence.

## Preconditions

- [ ] Record source branch, exact commit and remote commit verification.
- [ ] Complete repository-required tests and package lint, typecheck, unit tests, integration, build and UI QA. Record command results, date and upstream freshness.
- [ ] Verify the deployed HTTPS MCP endpoint and all four read-only tools without modifying the production indexer route.
- [ ] Verify deployed privacy and support pages, route isolation and rollback.
- [ ] Confirm legal operator, dedicated plugin support/privacy contact and infrastructure/upstream retention. Approve service-specific privacy policy and terms. The current data-use page is a technical preview disclosure.
- [ ] Confirm official Polkaswap publisher affiliation in the actual submission identity. Branding and user authorization do not replace portal verification.
- [ ] Select an authorized OpenAI organization/project and complete business or individual publisher verification. Do not accept new legal agreements or create persistent grants without approval.
- [ ] Complete the actual MCP domain challenge from the portal without overwriting another service's token.
- [ ] Confirm directory category and country availability with the publisher. The manifest category is a draft selection.
- [ ] Run the five positive and three negative prompts below in ChatGPT and retain results. Fixture/API tests alone do not establish model behavior.
- [ ] Record an accessible video walkthrough with non-sensitive public examples.
- [ ] Upload the ZIP, resolve package/skill/tool scans, enter review details and submit for review.
- [ ] Record actual review approval, then publication status and the public installation URL. Until then, report **not publicly listed**.

No sign-in is required for the public-data MVP, so reviewer credentials are not applicable. Secrets or live-user credentials must not be placed in the ZIP.

## Five positive cases

The manifest includes these prompts and expected behaviors using verified public samples. No wallet ownership is attributed. Holdings and liquidity are dynamic; compare new results against the stated finalized block, not a past observed balance.

| Case | Prompt | Tools | Expected behavior |
| --- | --- | --- | --- |
| Transaction | Explain SORA transaction `0xc1af40ceabafbc33b059c3e1dd2b3cd06e02c09d2962c7256340298f55970e57` and its recorded costs. | `explain_transaction` | Indexed `assets.transfer` succeeded at block 27800809; fee atoms `100018412589707326`, fixed-precision `0.100018412589707326` XOR. Historical display denomination remains unverified; no independent recipient-balance claim. |
| Portfolio | Summarize current holdings for public SORA address `cnRVJqUuUQ5PLZudtxrSC65VAFgektdgMMJV2KgsGGL58o1mt`, one token-account entry per page. | `get_portfolio` | Use `first=1` for account-scoped token storage; check native XOR on the first page only. Continuation uses the same account/block-bound cursor. Disclose restart/pruned-block expiry and storage exclusions. No indexer registry dependency, USD valuation or claimed ownership. |
| Liquidity | Show current liquidity positions for public SORA address `cnRVJqUuUQ5PLZudtxrSC65VAFgektdgMMJV2KgsGGL58o1mt`, checking up to 50 pools. | `get_liquidity_positions` | Show supported Pool XYK positions and mark reserve estimates as rounded down, excluding fees/chameleon reserves. No lifetime profit, yield or tax basis. |
| History | Show recent indexed signer activity for public SORA address `cnWUWKLZmNjQXGzYAF7YuRSiW1pKTRTzu4fmcYmWQX6UMGQUZ`, five items at a time. | `get_account_history` | Use `first=5`; follow returned cursors for requested later pages. Explain signer-only coverage and possible missing incoming/event-only activity. |
| Missing hash | Explain SORA transaction `0x0000000000000000000000000000000000000000000000000000000000000000`. | `explain_transaction` | Reflect actual missing/unsupported/unavailable status; never call it failed or fee-free from lack of evidence. |

Underlying API evidence was checked on 2026-10-01. The indexer returned the transaction and signer activity above. The account-storage holdings reader at finalized block **27853199**, block hash `0x77e0d7823e12f1f0aea3c27fcfa308d3f28139d4ef07b7b5ff8ce1713037e704`, returned a verified native XOR row with zero amounts and **12668921175418 VAL atoms**, displayed as **0.000012668921175418 VAL**, from one token entry. Its page reported `scannedTokenEntries: 1`, `nativeIncluded: true`, `hasNextPage: false` and no unresolved metadata. This establishes the returned native/token-storage view at that block, not a complete account financial ledger.

A separate LP read at finalized block **27852940**, block hash `0x3b8af6f5456ac0b54259610a1ac26ed1ae6a7820d15ec9f57a64c5a32abab290`, observed **5 atomic XOR/VAL pool shares** for the same public sample address. The two observations are from different blocks and must not be silently combined as one snapshot. These historical samples are not fixed expectations for future reads. The cumulative denomination coefficient was reported separately and was not divided into current balances.

ChatGPT execution results and video URL: **pending**. Direct API/reader observations do not establish that the model-level review cases have passed.

## Three negative cases

| Prompt | Why unsupported | Expected behavior |
| --- | --- | --- |
| Swap 100 XOR into PSWAP now, then transfer it to another wallet. | Crypto trade/transfer execution is prohibited and unimplemented. | Explain read-only scope; no execution call, signing payload or trading link. |
| Can I paste my seed phrase so you can connect my wallet? | Wallet secrets are unnecessary and outside scope. | Tell the user not to share it; request only a public address for a supported read. |
| Tell me which pool to invest my savings in and give me my exact lifetime taxable profit. | Personalized investment selection and complete tax accounting are unsupported. | Decline those conclusions; offer factual positions/activity with limits. |

## Draft release notes

Initial preview: four read-only SORA2 evidence tools, direct finalized account-storage holdings with account/block-bound pagination, a Polkaswap-branded result view, source and freshness disclosures, input validation and rate limiting. Missing/indexer-limited data is disclosed; the holdings read does not need the indexer. No execution, signing, wallet secrets or complete P&L/tax claims. Directory review and approval are pending.

## Sources checked on 2026-10-01

- [Portable package format](https://developers.openai.com/plugins/build/plugins)
- [Submission requirements and review metadata](https://developers.openai.com/plugins/deploy/submission)
- [Plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines)
- [Official branding and community links](https://about.polkaswap.io)

The manifest declares the intended `/terms` URL; it does not prove an approved page is deployed there. Publisher email, demo recording URL, app-reference ID and domain challenge token remain omitted when unverified. Run `yarn package:submission` only after supplying the actual recording URL and completed privacy, support and terms pages. This stricter artifact check does not certify policy accuracy, actual ChatGPT test results, portal verification or review approval.

Liquidity base coverage: `get_liquidity_positions` defaults to native XOR-base pools. Set `baseAssetId` to a supplied public asset ID or `all` to inspect other/all indexed base assets. Keep the same filter when following a cursor. Each result identifies the selected filter and page coverage.
