#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${TODO_AUDIT_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
BASELINE_FILE="${TODO_AUDIT_BASELINE:-$ROOT_DIR/config/todo-debt-baseline.tsv}"

log() { echo "[todo-audit] $*"; }
fail() {
  echo "[todo-audit][error] $*" >&2
  exit 1
}

[[ -d "$ROOT_DIR" ]] || fail "Root directory does not exist: $ROOT_DIR"
[[ -f "$BASELINE_FILE" ]] || fail "Baseline file does not exist: $BASELINE_FILE"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

current="$tmp_dir/current.tsv"
baseline_raw="$tmp_dir/baseline-raw.tsv"
baseline="$tmp_dir/baseline.tsv"
duplicate_baseline="$tmp_dir/duplicate-baseline.tsv"
new_markers="$tmp_dir/new.tsv"
stale_markers="$tmp_dir/stale.tsv"
crashing_placeholders="$tmp_dir/crashing-placeholders.txt"

scan_source_pattern() {
  local rg_pattern="$1"
  local grep_pattern="$2"
  (
    cd "$ROOT_DIR"
    if [[ "${TODO_AUDIT_FORCE_GREP:-0}" != "1" ]] && command -v rg >/dev/null 2>&1; then
      rg -n --no-heading -i "$rg_pattern" \
        --glob '*.{js,jsx,ts,tsx,vue,mjs,cjs}' \
        --glob '!node_modules/**' \
        --glob '!dist/**' \
        --glob '!build/**' \
        --glob '!coverage/**' \
        --glob '!.yarn/**' \
        --glob '!**/.git/**' \
        . || true
      return
    fi

    find . -type f \( \
      -name '*.js' -o -name '*.jsx' -o -name '*.ts' -o -name '*.tsx' -o \
      -name '*.vue' -o -name '*.mjs' -o -name '*.cjs' \
    \) \
      ! -path './node_modules/*' \
      ! -path './dist/*' \
      ! -path './build/*' \
      ! -path './coverage/*' \
      ! -path './.yarn/*' \
      ! -path './.git/*' \
      -print | while IFS= read -r file; do
        grep -HInEi "$grep_pattern" "$file" || true
      done
  )
}

scan_marker_debt() {
  scan_source_pattern \
    '\b(todo|fixme|stopship)\b' \
    '(^|[^[:alnum:]_])(todo|fixme|stopship)([^[:alnum:]_]|$)' | awk -F: '
    {
      line = $0
      sub(/^[^:]+:[0-9]+:/, "", line)
      path = $1
      sub(/^\.\//, "", path)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", line)
      print path "\t" line
    }
  ' | LC_ALL=C sort -u
}

scan_crashing_placeholders() {
  scan_source_pattern \
    'throw[[:space:]]+(new[[:space:]]+)?Error[[:space:]]*\([^)]*(TODO|FIXME|STOPSHIP)' \
    'throw[[:space:]]+(new[[:space:]]+)?Error[[:space:]]*\([^)]*(TODO|FIXME|STOPSHIP)'
}

awk 'NF && $0 !~ /^#/' "$BASELINE_FILE" > "$baseline_raw"
LC_ALL=C sort "$baseline_raw" > "$baseline"
LC_ALL=C sort "$baseline_raw" | uniq -d > "$duplicate_baseline"
scan_marker_debt > "$current"
scan_crashing_placeholders > "$crashing_placeholders"

if [[ -s "$duplicate_baseline" ]]; then
  echo "Duplicate TODO debt baseline entries are forbidden:" >&2
  sed -n '1,40p' "$duplicate_baseline" >&2
  fail "Remove duplicate entries from config/todo-debt-baseline.tsv."
fi

if [[ -s "$crashing_placeholders" ]]; then
  echo "Crashing TODO/FIXME placeholders are forbidden:" >&2
  sed -n '1,40p' "$crashing_placeholders" >&2
  fail "Remove throw Error TODO placeholders instead of baselining them."
fi

comm -23 "$current" "$baseline" > "$new_markers"
comm -13 "$current" "$baseline" > "$stale_markers"

if [[ -s "$new_markers" ]]; then
  echo "New TODO/FIXME/STOPSHIP markers found outside the baseline:" >&2
  sed -n '1,80p' "$new_markers" >&2
  fail "Resolve the markers or intentionally update config/todo-debt-baseline.tsv."
fi

if [[ -s "$stale_markers" ]]; then
  echo "Baseline entries no longer exist in source:" >&2
  sed -n '1,80p' "$stale_markers" >&2
  fail "Remove stale entries from config/todo-debt-baseline.tsv."
fi

log "TODO/FIXME debt matches baseline."
