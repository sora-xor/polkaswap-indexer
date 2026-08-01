#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${PUBLIC_ARTIFACT_AUDIT_ROOT:-$(git rev-parse --show-toplevel)}"
cd "$ROOT_DIR"

fail() {
  printf 'Public artifact audit failed: %s\n' "$1" >&2
  exit 1
}

tracked_files="$(mktemp)"
matches="$(mktemp)"
trap 'rm -f "$tracked_files" "$matches"' EXIT

git ls-files > "$tracked_files"

if grep -E '(^|/)(dist|coverage|build)(/|$)' "$tracked_files" > "$matches"; then
  cat "$matches" >&2
  fail 'generated build output is tracked'
fi

if grep -E '\.(pem|p12|pfx|key|keystore|jks|mobileprovision)$' "$tracked_files" > "$matches"; then
  cat "$matches" >&2
  fail 'private key or signing artifact is tracked'
fi

if grep -E '(^|/)\.env($|\.|/)' "$tracked_files" | grep -Ev '^\.env\.example$' > "$matches"; then
  cat "$matches" >&2
  fail 'unexpected env file is tracked'
fi

if git grep -n -I -E -- '-----BEGIN (RSA |DSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----|[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com' -- . ':!yarn.lock' > "$matches"; then
  cat "$matches" >&2
  fail 'tracked content contains private key material or OAuth client IDs'
fi

for env_file in .env.example; do
  [[ -f "$env_file" ]] || continue
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" == *"="* ]] || continue
    key="${line%%=*}"
    value="${line#*=}"
    key="$(printf '%s' "$key" | tr -d '[:space:]')"
    value="$(printf '%s' "$value" | sed -E 's/^[[:space:]]*//; s/[[:space:]]*$//; s/^"//; s/"$//; s/^'\''//; s/'\''$//')"
    [[ -n "$value" ]] || continue
    if [[ "$key" =~ (^|_)(API.*KEY|API_?KEY|SECRET|TOKEN|PRIVATE_?KEY|CLIENT_?SECRET|MNEMONIC|SEED|PASSWORD)$ ]]; then
      fail "$env_file contains a non-empty sensitive value for $key"
    fi
  done < "$env_file"
done

printf 'Public artifact audit passed.\n'
