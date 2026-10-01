# Installation and connection

The source folder `plugin/` is a portable Agent Plugins package. Its root `plugin.json` contains identity, presentation and review metadata; `mcp.json` configures one remote Streamable HTTP server; `skills/` contains the read-only workflow. There are no lifecycle hooks, local execution scripts, app-reference IDs or credentials in the plugin.

## Validate the package

Run `yarn package` in this package. It checks the manifest's required local fields, relative asset paths, one HTTPS MCP endpoint and skill frontmatter, then creates a ZIP from an explicit file allowlist. This is a local structural check; the official submission portal performs the authoritative package and tool scans.

## Test in ChatGPT developer mode

1. Confirm the deployed HTTPS MCP endpoint responds to initialization and lists the four expected read-only tools. The configured candidate is `https://pi.soramitsu.io/polkaswap-chatgpt/mcp`.
2. In ChatGPT, open Settings → Security and login and enable Developer mode, if available for the account.
3. Open [ChatGPT Plugins](https://chatgpt.com/plugins), select the plus button and register the remote MCP URL. The public-data service uses no wallet connection or user sign-in.
4. Test in a new chat with a public hash or address. Check the result view, evidence, missing-data behavior and pagination. Read [SUBMISSION.md](SUBMISSION.md) for positive and negative cases.
5. Record the registration result and technical plugin ID if the host supplies one. Registration and testing do not establish a public directory release.

Never enter a seed phrase, private key or persistent credential. Installation must not require a signing grant or new paid service. If the host asks for a permission or credential outside the read-only public-data scope, stop and investigate.

For local package distribution in Work/Codex, the [official package guide](https://developers.openai.com/plugins/build/plugins) describes repository and personal marketplaces. Configure a marketplace only within an authorized location; package availability varies by host surface. A local marketplace install is separate from registering the MCP server and from a public directory submission.

## Public directory submission

Upload the built ZIP to the [OpenAI Plugins dashboard](https://platform.openai.com/plugins) under the verified organization and developer identity. Connect the declared remote server, complete the actual domain challenge shown in the portal, resolve scans and finish required review materials. Do not invent an app ID or challenge token. Never replace an existing challenge token used by another plugin.

The operator must approve the service-specific policy, terms and support contact before submitting. A directory release can be reported only after the portal records approval and publication. See [official submission instructions](https://developers.openai.com/plugins/deploy/submission).
