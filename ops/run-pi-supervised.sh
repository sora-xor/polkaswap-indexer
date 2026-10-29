#!/bin/bash
# Run the existing Pi launcher unchanged, forwarding one shutdown signal and
# reaping its child before launchd restarts the service. The launcher must exec
# its service process so that this supervisor owns that exact process directly.
#
# Usage: PI_SUPERVISOR_PID_FILE=/absolute/path/pi-supervisor.pid \
#   /bin/bash /absolute/path/run-pi-supervised.sh /absolute/path/original-runner.sh
# newsyslog may send USR2 to this PID to drain the service and reopen its logs on
# launchd restart. TERM and INT have the same graceful behavior; no timeout or
# forced kill interrupts RocksDB shutdown. Keep PID files in a trusted directory.
# launchd serializes starts of the same service, including stale-PID recovery.

set -u
umask 077

pid_file=${PI_SUPERVISOR_PID_FILE-}
pid_temporary=
child_pid=
child_reaped=0
child_status=0
shutdown_requested=0
term_forwarded=0
wait_interrupted=0

# Report invalid configuration before launching any service process.
fail() {
  printf 'Pi supervisor: %s\n' "$1" >&2
  exit 1
}

# Forward TERM only once. Repeated rotation/stop signals must not interrupt the
# second wait, which is responsible for reaping a gracefully draining child.
request_shutdown() {
  shutdown_requested=1
  wait_interrupted=1
  if [[ -n "$child_pid" && "$term_forwarded" -eq 0 ]]; then
    term_forwarded=1
    trap '' TERM INT USR2
    kill -TERM "$child_pid" 2>/dev/null || :
  fi
}

# Bash wait returns early when a trapped signal arrives; wait again in that case
# instead of allowing launchd to start a replacement beside a still-running child.
wait_for_child() {
  while :; do
    wait_interrupted=0
    wait "$child_pid"
    child_status=$?
    [[ "$wait_interrupted" -eq 0 ]] && break
  done
  child_reaped=1
}

# Retain a private hard link so cleanup cannot remove a replacement PID file.
cleanup() {
  local exit_status=$1
  trap - EXIT
  if [[ -n "$child_pid" && "$child_reaped" -eq 0 ]]; then
    request_shutdown
    wait_for_child
  fi
  if [[ -n "$pid_temporary" ]]; then
    if [[ ! -L "$pid_file" && "$pid_file" -ef "$pid_temporary" ]] &&
       [[ "$(cat "$pid_file" 2>/dev/null)" == "$$" ]]; then
      rm -f -- "$pid_file"
    fi
    rm -f -- "$pid_temporary"
  fi
  exit "$exit_status"
}

trap 'cleanup "$?"' EXIT
trap request_shutdown TERM INT USR2

[[ "$#" -eq 1 ]] || fail 'expected one absolute runner script path'
runner=$1
[[ "$runner" == /* && -f "$runner" && -r "$runner" ]] ||
  fail 'runner must be an absolute, readable regular file'
[[ "$pid_file" == /* ]] || fail 'PI_SUPERVISOR_PID_FILE must be absolute'
case "$pid_file/" in
  *//*|*/./*|*/../*|*$'\n'*|*$'\r'*) fail 'malformed PI_SUPERVISOR_PID_FILE' ;;
esac
[[ ! -L "$pid_file" ]] || fail 'PID file must not be a symbolic link'
pid_directory=${pid_file%/*}
[[ -n "$pid_directory" ]] || pid_directory=/
[[ -d "$pid_directory" ]] || fail 'PID file parent directory does not exist'

if [[ -e "$pid_file" ]]; then
  [[ -f "$pid_file" ]] || fail 'PID file must be a regular file'
  existing_pid=$(cat "$pid_file") || fail 'cannot read existing PID file'
  [[ "$existing_pid" =~ ^[1-9][0-9]{0,9}$ ]] &&
    [[ "$existing_pid" -gt 1 && "$existing_pid" -le 2147483647 ]] ||
    fail 'existing PID file is malformed'
  if kill -0 "$existing_pid" 2>/dev/null ||
     [[ -n "$(ps -p "$existing_pid" -o pid= 2>/dev/null)" ]]; then
    fail 'existing supervisor PID is still alive'
  fi
  rm -- "$pid_file" || fail 'cannot remove dead supervisor PID file'
fi

[[ "$shutdown_requested" -eq 0 ]] || exit 0
pid_temporary=$(mktemp "${pid_file}.tmp.XXXXXX") || fail 'cannot create private PID file'
chmod 600 "$pid_temporary" || fail 'cannot protect private PID file'
printf '%s\n' "$$" > "$pid_temporary" || fail 'cannot write private PID file'
# Hard-link publication is atomic and does not overwrite a concurrently started
# supervisor's PID file. Both links refer to the complete, mode-600 file.
ln "$pid_temporary" "$pid_file" || fail 'another supervisor claimed the PID file'

[[ "$shutdown_requested" -eq 0 ]] || exit 0
/bin/bash "$runner" &
child_pid=$!
# A signal can arrive between launching the child and assigning its PID.
[[ "$shutdown_requested" -eq 0 ]] || request_shutdown
wait_for_child
exit "$child_status"
