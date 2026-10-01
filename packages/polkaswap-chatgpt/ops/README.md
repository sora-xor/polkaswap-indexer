# Existing-host deployment

This component is independent of the production indexer database and static
Polkaswap site. It uses the already approved macOS host `208.83.1.62`, account
`administrator` (UID 501), its existing Node runtime, and existing Pi HTTPS
certificate. It does not require a new host, DNS record, wallet, API key,
credential, account grant, or paid service.

On 1 October 2026, read-only checks verified Node `v25.9.0`, npm `11.12.1`,
Corepack, about 193 GiB available on the APFS volume, no listener on port 4380,
and the existing administrator-owned nginx master/config. The live indexer
reported a ready running worker, no error, and four blocks of lag. These checks
are observations, not ongoing guarantees; repeat them immediately before
deployment. The old `indexer-creds.txt` target/password was stale. Existing
operator credentials whose target is exactly the approved host work; read them
inside the local authentication helper without printing or passing secrets as
command arguments.

The remote SSH environment omits Homebrew from its PATH. Set
`PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin` for remote commands.
Use Corepack for this package's pinned Yarn 4.10.3; the host's plain `yarn`
command is Yarn 1.22.22.

## Candidate and activation

1. Finish the package's lint, typecheck, unit tests, live integration checks,
   build, and UI QA. Record the source commit and artifact SHA-256. Copy only
   this package's candidate into
   `/Users/administrator/apps/polkaswap-chatgpt/releases/<commit>/`, excluding
   Git metadata, credentials, unrelated indexer code, databases, and local
   development output. Never replace another service's directory.
2. Install runtime dependencies with the pinned lockfile in this isolated
   release. A source upload can use
   `YARN_ENABLE_IMMUTABLE_INSTALLS=true corepack yarn workspaces focus --all --production`.
   Alternatively transfer verified production-only dependencies from the same
   darwin-arm64 platform. Verify the lockfile hash after installation. Do not
   replace the pinned dependency graph with an unrecorded npm resolution.
3. Retain the candidate's `dist/`, `public/`, `plugin/assets/`, `ops/`,
   `package.json`, and runtime `node_modules/`. Run
   `bash ops/activate-release.sh <commit>` as administrator. This atomically
   changes only this component's release symlink and initially installs a stable
   runner that delegates to `current/ops/run-server.sh`, plus a user LaunchAgent
   at `user/501/org.polkaswap.chatgpt`. Verify `/health` and MCP initialize,
   tools/list, resources/read, and representative tools over loopback port 4380.
4. Review `ops/nginx-location.inc` and run
   `python3 ops/configure-nginx.py` for a dry run. Then run
   `python3 ops/configure-nginx.py --apply`. It adds one include inside the
   existing Pi HTTPS server, preserves `/graphql`, `/metrics`, and `/ipfs/`,
   saves prior configuration/include bytes, atomically updates both even when
   the include line already exists, tests the complete nginx configuration,
   and reloads. It restores both files on validation or reload failure. No sudo is
   required by the currently inspected nginx ownership.
5. Verify the public production endpoint
   `https://pi.soramitsu.io/polkaswap-chatgpt/mcp` and public privacy/support
   pages, then repeat the existing GraphQL health and IPFS origin checks. Record
   commit, candidate hashes, service status, live MCP responses, and deployment
   time. A service bootstrap alone does not establish release success.

The route disables access logs, discards incoming X-Forwarded-For, overwrites
X-Real-IP with nginx's actual network peer, disables cache/buffering, caps bodies
at 64 KiB, and permits no arbitrary proxy target. The application trusts that
address only from a loopback proxy with the expected public Host and uses an
ephemeral salted hash for rate limiting; it must also bound global concurrency.
A ChatGPT network peer does not identify the originating ChatGPT user.
Process logs are owner-private;
they contain request method, a coarse route label, status and duration, plus
generic startup/error categories. They must contain no wallet addresses,
transaction hashes, request bodies, raw client IPs, credentials, or conversation
content. This service installs no log
retention policy for existing, unrelated infrastructure. The route inherits
nginx error logging, which can contain transport/IP/URI metadata during errors;
the shared infrastructure's retention has not been verified. Do not promise
zero IP collection by every infrastructure layer.

## Rollback

For a failed **first deployment**, run
`python3 ops/configure-nginx.py --remove --apply` first, then
`bash ops/rollback.sh`. The removal is surgical and preserves all other current
configuration bytes. Retain release artifacts and private state backups as
rollback evidence.

For a failed **update**, leave the route in place and run `bash ops/rollback.sh`
to restore the previous release symlink and relaunch only this component. Verify
the previous public MCP contract again. The stable runner follows the restored
symlink, so it executes the prior release's exact runner. Activation refuses a
changed centralized runner or LaunchAgent rather than overwriting configuration
needed by a prior release. A failed first bootstrap removes newly installed
runner/LaunchAgent files; candidate artifacts remain available for inspection.
Do not restore an entire older nginx
configuration over later unrelated edits.

The LaunchAgent is supervised in the existing user domain. Test restart recovery
without rebooting the shared production host. Do not claim recovery after host
reboot until the existing host's watchdog/login lifecycle has been reviewed.

## ChatGPT installation and public publication

Test the hosted endpoint in ChatGPT developer mode, then test the complete
packaged plugin. Current developer-mode navigation is Settings → Security and
login → Developer mode, then the plus button at ChatGPT Plugins. Refresh the
connection after tool/metadata changes. This is separate from public directory
publication.

The current package uses root `plugin.json` and `mcp.json` with Agent Plugins
schemas, plus OpenAI presentation/review metadata under `extensions.com.openai`.
Public submission requires a verified publisher, Apps Management Write,
production HTTPS, a completed domain challenge, automated checks, five positive
and three negative test cases, and an accessible walkthrough recording. Required
MCP listing URLs include website, support, privacy policy, and terms. Do not
invent contact addresses or accept new legal agreements on the user's behalf.
Host the exact verification token only after the dashboard supplies it, avoiding
replacement of another plugin's token. Submit for review, then publish only
after actual approval. Report each installation/submission/publication state
separately.

Verified documentation:

- [Package your plugin](https://developers.openai.com/plugins/build/plugins)
- [Connect and test](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [Submission and publication](https://developers.openai.com/plugins/deploy/submission)
- [Remote MCP review](https://developers.openai.com/plugins/deploy/app-review)
- [Plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines)

Local ops verification: `python3 ops/test_configure_nginx.py`,
`python3 ops/test_activation.py`,
`bash -n ops/*.sh`, and `plutil -lint ops/org.polkaswap.chatgpt.plist`.
