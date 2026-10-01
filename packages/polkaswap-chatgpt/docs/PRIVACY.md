# Technical data-use disclosure

This document describes the preview implementation. It is not an operator-approved legal privacy policy. The deployed `/polkaswap-chatgpt/privacy` page carries the same limitation.

## Inputs and purposes

The service accepts a public SORA2 transaction hash or wallet address, plus bounded pagination parameters. It uses those identifiers to retrieve transaction evidence, holdings, liquidity positions and activity from the configured Polkaswap indexer and SORA2 node. A public address may still be linkable to an individual. Query only addresses the user chooses to inspect and do not identify an owner by inference.

The service needs no wallet connection, private key, seed phrase or transaction signature. Such secrets must not be submitted. No transaction execution tools are provided.

## What leaves the service

The configured chain node receives the public address needed for direct holdings reads; portfolio pagination does not require the indexer. Transaction and signer-history identifiers go to the configured indexer, and liquidity reads combine its pool catalog with chain reads. Retrieved evidence returns to ChatGPT or the MCP client, where the client's policies and conversation controls apply. The plugin does not receive unrelated conversation history; it receives tool-call arguments. Runtime network infrastructure also handles requests, including network metadata. Its retention and access controls require operator confirmation.

## Application storage and logs

The plugin application does not persist request bodies, public wallet addresses, transaction hashes or results. Its operational logging is limited to request method, a coarse route label, status and duration. It does not emit raw client IP addresses in those application logs. For rate limiting, the configured nginx reverse proxy replaces `X-Real-IP` with the IP of its connecting client. The service accepts that header only from a loopback connection for its configured public hostname and otherwise uses the socket's IP. It hashes the selected IP with a random process salt and retains one-minute request-count buckets in memory. Expired buckets are removed on a subsequent request; restarting the process discards all buckets. The result UI uses no analytics, cookies or persistent browser storage.

Portfolio continuation cursors carry the information needed to resume the same public account and finalized block. They are validated with a temporary server signing key; restart invalidates existing cursors. The cursor contents are not encrypted or secret. They do not sign or authorize wallet transactions, and the application does not persist cursor contents in a database or operational log.

These application statements do not cover reverse proxies, hosting, ChatGPT, the indexer or chain node. Upstream and infrastructure logging, retention, security contacts and deletion procedures have not been established by this document. Do not advertise end-to-end anonymity, zero logging or a retention guarantee.

## Required before directory submission

- Confirm the legal operator and publisher identity.
- Appoint a plugin support and privacy contact without inventing an address or reusing an unverified legacy contact.
- Confirm production infrastructure and upstream logging and retention.
- Publish an operator-approved service-specific policy and terms, with accessible URLs reflecting the actual deployment.

The [official Polkaswap site](https://about.polkaswap.io) links an [existing Polkaswap privacy policy](https://wiki.sora.org/polkaswap/privacy). That legacy document does not, by itself, establish the operator or data practices of this new plugin.
