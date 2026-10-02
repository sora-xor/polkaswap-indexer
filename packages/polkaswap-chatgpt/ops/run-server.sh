#!/bin/bash
# Launch only the independently deployed, read-only ChatGPT component.
set -euo pipefail
export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
export NODE_ENV=production
export HOST=127.0.0.1
export PORT=4380
export PUBLIC_BASE_URL=https://pi.soramitsu.io/polkaswap-chatgpt
export INDEXER_URL=https://pi.soramitsu.io/graphql
export SORA_WS_ENDPOINT=wss://ws.mof.sora.org
export RELEASE_COMMIT
RELEASE_COMMIT=$(basename "$(readlink /Users/administrator/apps/polkaswap-chatgpt/current)")
if [[ ! "$RELEASE_COMMIT" =~ ^[a-f0-9]{7,40}$ ]]; then
  echo 'Invalid active release commit.' >&2
  exit 2
fi
cd /Users/administrator/apps/polkaswap-chatgpt/current
exec /opt/homebrew/bin/node dist/src/server.js
