#!/usr/bin/env bash
set -euo pipefail

BASE=${POLKASWAP_INDEXER_BASE:-/Users/administrator/apps/polkaswap-indexer}
PID_FILES=("$BASE/combined.pid" "$BASE/api-4350.pid")
child_pid=''

cleanup_pid_files() {
  local pid_file
  for pid_file in "${PID_FILES[@]}"; do
    if [[ -f "$pid_file" ]] && [[ "$(<"$pid_file")" == "$$" ]]; then
      rm -f "$pid_file"
    fi
  done
}

write_pid_file() {
  local pid_file=$1
  local temporary="${pid_file}.$$"
  printf '%s\n' "$$" > "$temporary"
  chmod 600 "$temporary"
  mv -f "$temporary" "$pid_file"
}

stop_child() {
  local forwarded_signal=${1:-TERM}
  local status=0
  # Ignore duplicate rotation/stop signals while the child drains. Resetting
  # them to their default would kill this supervisor early and orphan Node.
  trap '' TERM INT USR2
  if [[ -n "$child_pid" ]] && kill -0 "$child_pid" 2>/dev/null; then
    kill -"$forwarded_signal" "$child_pid" 2>/dev/null || true
    wait "$child_pid" || status=$?
  fi
  cleanup_pid_files
  trap - EXIT
  exit "$status"
}

set -a
. "$BASE/.env"
set +a

export STORAGE_ENGINE=${STORAGE_ENGINE:-rocksdb}
export ROCKSDB_PATH=${ROCKSDB_PATH:-$BASE/rocksdb/polkaswap-indexer.rocksdb}
export HOST=${HOST:-127.0.0.1}
export PORT=${PORT:-4350}
NODE_BINARY=${POLKASWAP_INDEXER_NODE_BINARY:-/opt/homebrew/opt/node@24/bin/node}
ENTRYPOINT=${POLKASWAP_INDEXER_ENTRYPOINT:-dist/src/combined.js}

# newsyslog sends USR2 after rotating the inherited launchd descriptor. Exit
# only after the Node process drains; KeepAlive then starts a process whose
# stdout/stderr are attached to the new file.
trap 'stop_child TERM' TERM
trap 'stop_child INT' INT
trap 'stop_child TERM' USR2
trap cleanup_pid_files EXIT

cd "$BASE/current"
write_pid_file "${PID_FILES[0]}"
write_pid_file "${PID_FILES[1]}"

"$NODE_BINARY" "$ENTRYPOINT" &
child_pid=$!
child_status=0
wait "$child_pid" || child_status=$?
cleanup_pid_files
trap - EXIT
exit "$child_status"
