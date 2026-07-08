#!/usr/bin/env bash
set -euo pipefail

BASE=${POLKASWAP_INDEXER_BASE:-/Users/administrator/apps/polkaswap-indexer}

set -a
. "$BASE/.env"
set +a

export STORAGE_ENGINE=${STORAGE_ENGINE:-rocksdb}
export ROCKSDB_PATH=${ROCKSDB_PATH:-$BASE/rocksdb/polkaswap-indexer.rocksdb}
export HOST=${HOST:-127.0.0.1}
export PORT=${PORT:-4350}

cd "$BASE/current"
echo "$$" > "$BASE/combined.pid"
echo "$$" > "$BASE/api-4350.pid"
exec /opt/homebrew/opt/node@24/bin/node dist/src/combined.js
