#!/bin/bash
# Run as administrator on the approved existing host, after candidate QA.
set -euo pipefail
export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
app_root=/Users/administrator/apps/polkaswap-chatgpt
service_label=org.polkaswap.chatgpt
service_domain=user/501
release_id=${1:?Pass the tested release commit in hexadecimal}
if [[ ! "$release_id" =~ ^[a-f0-9]{7,40}$ ]]; then
  echo 'Release ID must be a hexadecimal Git commit.' >&2
  exit 2
fi
if [[ $(id -u) != 501 || $(id -un) != administrator ]]; then
  echo 'Run this only as administrator (UID 501) on the approved host.' >&2
  exit 2
fi
release_dir="$app_root/releases/$release_id"
for required_file in dist/src/server.js dist/widget.html public/privacy.html plugin/assets/logo.svg; do
  test -f "$release_dir/$required_file" || { echo "Missing release artifact: $required_file" >&2; exit 2; }
done
if [[ -e "$app_root/current" && ! -L "$app_root/current" ]]; then
  echo 'Refusing to replace a current path that is not a symlink.' >&2
  exit 2
fi
install -d -m 0700 "$app_root/state" "$app_root/logs" /Users/administrator/Library/LaunchAgents
touch "$app_root/logs/server.out.log" "$app_root/logs/server.err.log"
chmod 0600 "$app_root/logs/server.out.log" "$app_root/logs/server.err.log"
previous_target=$(readlink "$app_root/current" || true)
plist_path="/Users/administrator/Library/LaunchAgents/$service_label.plist"
if [[ -n "$previous_target" ]]; then
  case "$previous_target" in "$app_root"/releases/*) ;; *) echo 'Invalid active release target.' >&2; exit 2 ;; esac
  test -f "$app_root/run-server.sh" && test -f "$plist_path" || { echo 'Prior service configuration is incomplete; refusing activation.' >&2; exit 2; }
fi
printf '%s\n' "$previous_target" > "$app_root/state/previous-target"
chmod 0600 "$app_root/state/previous-target"
runner_created=false
plist_created=false
runner_candidate="$app_root/state/runner-candidate.$$"
printf '%s\n' '#!/bin/bash' 'set -euo pipefail' 'exec /bin/bash /Users/administrator/apps/polkaswap-chatgpt/current/ops/run-server.sh' > "$runner_candidate"
if [[ -e "$app_root/run-server.sh" || -L "$app_root/run-server.sh" ]]; then
  cmp -s "$runner_candidate" "$app_root/run-server.sh" || { rm "$runner_candidate"; echo 'Stable runner differs; refusing to overwrite rollback configuration.' >&2; exit 2; }
else
  install -m 0700 "$runner_candidate" "$app_root/run-server.sh"
  runner_created=true
fi
rm "$runner_candidate"
if [[ -e "$plist_path" || -L "$plist_path" ]]; then
  cmp -s "$release_dir/ops/org.polkaswap.chatgpt.plist" "$plist_path" || { if $runner_created; then rm "$app_root/run-server.sh"; fi; echo 'Stable LaunchAgent differs; refusing to overwrite rollback configuration.' >&2; exit 2; }
else
  install -m 0600 "$release_dir/ops/org.polkaswap.chatgpt.plist" "$plist_path"
  plist_created=true
fi
if ! plutil -lint "$plist_path"; then
  if $runner_created; then rm "$app_root/run-server.sh"; fi
  if $plist_created; then rm "$plist_path"; fi
  exit 2
fi
ln -s "$release_dir" "$app_root/current.next"
/usr/bin/python3 -c 'import os,sys; os.replace(sys.argv[1],sys.argv[2])' "$app_root/current.next" "$app_root/current"
launchctl bootout "$service_domain/$service_label" 2>/dev/null || true
if ! launchctl bootstrap "$service_domain" "$plist_path"; then
  if [[ -n "$previous_target" ]]; then
    ln -s "$previous_target" "$app_root/current.next"
    /usr/bin/python3 -c 'import os,sys; os.replace(sys.argv[1],sys.argv[2])' "$app_root/current.next" "$app_root/current"
    launchctl bootstrap "$service_domain" "$plist_path" || true
  else
    rm "$app_root/current"
  fi
  if $runner_created; then rm "$app_root/run-server.sh"; fi
  if $plist_created; then rm "$plist_path"; fi
  echo 'Candidate service bootstrap failed; restored the prior release pointer.' >&2
  exit 1
fi
launchctl print "$service_domain/$service_label"
echo "Activated isolated Polkaswap ChatGPT release $release_id. Verify loopback and public MCP before recording release success."
