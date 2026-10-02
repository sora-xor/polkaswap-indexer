# Polkaswap Evidence

A Polkaswap-branded, read-only MCP service and portable ChatGPT/Codex plugin package for SORA2 transaction evidence and public-wallet inspection.

The initial scope is transaction outcomes and recorded costs, available wallet holdings, current liquidity positions, and paginated indexed activity. Results expose source, freshness and coverage limits. No transaction execution, signing, wallet secrets, personalized trading recommendations, lifetime P&L or tax accounting are provided.

| Tool | Input | Supported purpose |
| --- | --- | --- |
| `explain_transaction` | `hash` | Explain recorded transaction evidence; disclose missing outcomes and costs. |
| `get_portfolio` | `address`, `first`, `after` | Read the public account's token-storage entries at a finalized block, plus native XOR on the first page. |
| `get_liquidity_positions` | `address`, `first`, `after` | Read available current liquidity positions and their limits. |
| `get_account_history` | `address`, `first`, `after` | Read bounded pages of indexed account activity. |

The configured public MCP URL is `https://pi.soramitsu.io/polkaswap-chatgpt/mcp`. Configuration is not deployment evidence; check the current endpoint and release report before registering it. The portable plugin source is in `plugin/`. `yarn package` validates local package structure and creates `dist/polkaswap-evidence-0.1.0.zip`.

## Development

Use Node.js 24+ and the package's pinned Yarn version.

```sh
yarn install --immutable
yarn lint
yarn typecheck
yarn test
yarn build
yarn test:integration
yarn test:ui
yarn package
```

Integration checks require reachable public upstream services. Build and local test success do not demonstrate a public endpoint, completed ChatGPT installation, publisher verification, or directory approval. See the repository `AGENTS.md` for root-repository verification requirements.

## Data and limits

The implementation reads historical transaction and signer activity from the Polkaswap indexer. Holdings are read directly from account-scoped `tokens.accounts.entriesPaged` storage at a finalized SORA2 block; they do not depend on the indexer's asset registry. Native XOR is checked only on the first page. `first` limits token-account entries, defaults to 25 and is capped at 50; the native XOR check is additional. Follow the returned opaque, signed cursor to continue the same account at the same finalized block. Cursors become unusable after a service restart or if the node prunes that block; start a new read rather than combining pages from different blocks.

The holdings view covers native and token-account storage, including returned reserved or locked quantities, but does not enumerate separate vault, staking, held LP-share or other account-specific storage. No USD valuation is calculated. Pool XYK provider shares still use paginated indexed pool-registry entries ordered by descending registry ID. Each LP page reads finalized chain storage. Its proportional reserve amounts are rounded-down estimates excluding withdrawal fees and chameleon reserves; they are not withdrawal quotes. Follow LP cursors to inspect more pools and check each page's block.

Upstream services receive the public identifiers needed for the lookup. Indexer history can be missing, partial or stale; incoming transfers and event-only account involvement may be absent. Historical LP snapshots have limited retention, and this MVP does not use them to calculate historical profit. Fee atoms and fixed-precision amounts retain their historical units; current denomination must not be applied to them. Actual dispatch failure causes may be unavailable because the indexer stores placeholder error indices. Amounts remain decimal strings. Missing balances, fees and valuations remain unknown rather than becoming zero.

The service emits operational method/coarse-route/status/duration logs rather than request bodies or wallet identifiers. For rate limiting, the configured nginx proxy supplies its connecting client's IP in `X-Real-IP`; the service trusts this header only from the configured loopback proxy and otherwise uses the socket address. It hashes that address with a random process salt and retains one-minute buckets in memory. The UI uses no analytics, cookies or persistent browser storage. Infrastructure and upstream logging are separate and must be confirmed before making a service-wide retention promise. See [data-use disclosure](docs/PRIVACY.md).

## Installation and public review

See [result model](docs/OUTPUT_MODEL.md) for pagination and output interpretation, [installation](docs/INSTALLATION.md) for developer testing and [submission](docs/SUBMISSION.md) for the release checklist and unresolved publisher/legal requirements. The ZIP is a preview package. A public directory listing requires OpenAI review, approval and an explicit publish action; no such status is implied here.

Brand artwork is the official [Polkaswap logo](https://about.polkaswap.io/logo.svg). The [official Polkaswap site](https://about.polkaswap.io) links [the community Telegram channel](https://t.me/polkaswap); this verified community link is not a substitute for an appointed plugin support contact.

Liquidity base coverage: `get_liquidity_positions` defaults to native XOR-base pools. Set `baseAssetId` to a supplied public asset ID or `all` to inspect other/all indexed base assets. Keep the same filter when following a cursor. Each result identifies the selected filter and page coverage.
