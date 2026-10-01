#!/bin/bash
# Roll back only this component; nginx is handled by configure-nginx.py.
set -euo pipefail
export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
app_root=/Users/administrator/apps/polkaswap-chatgpt
service_label=org.polkaswap.chatgpt
service_domain=user/501
test -f "$app_root/state/previous-target"
previous_target=$(cat "$app_root/state/previous-target")
if [[ -n "$previous_target" ]]; then
  case "$previous_target" in "$app_root"/releases/*) ;; *) echo 'Invalid previous release target.' >&2; exit 2 ;; esac
  test -f "$previous_target/dist/src/server.js"
  launchctl bootout "$service_domain/$service_label" 2>/dev/null || true
  ln -s "$previous_target" "$app_root/current.next"
  /usr/bin/python3 -c 'import os,sys; os.replace(sys.argv[1],sys.argv[2])' "$app_root/current.next" "$app_root/current"
  launchctl bootstrap "$service_domain" "/Users/administrator/Library/LaunchAgents/$service_label.plist"
  echo 'Restored previous isolated ChatGPT component release.'
else
  launchctl bootout "$service_domain/$service_label" 2>/dev/null || true
  if [[ -L "$app_root/current" ]]; then rm "$app_root/current"; fi
  echo 'Stopped first release of the isolated ChatGPT component.'
fi
