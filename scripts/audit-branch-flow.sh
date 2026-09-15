#!/usr/bin/env bash
set -euo pipefail

RAW_SCRIPT_PATH="${BASH_SOURCE[0]}"
if [[ "$RAW_SCRIPT_PATH" == /* ]]; then
  SCRIPT_PATH="$RAW_SCRIPT_PATH"
else
  SCRIPT_PATH="$PWD/${RAW_SCRIPT_PATH#./}"
fi
SCRIPT_DIR="$(cd -P -- "$(dirname -- "$SCRIPT_PATH")" && pwd)"
DEFAULT_ROOT_DIR="$(cd -P -- "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="${BRANCH_FLOW_AUDIT_ROOT:-${1:-$DEFAULT_ROOT_DIR}}"
FAILURES=()

record_failure() {
  FAILURES+=("$1")
  printf '[branch-flow-audit][error] %s\n' "$1" >&2
}

require_regular_file() {
  local file="$1"
  local label="$2"
  if [[ ! -f "$file" || -L "$file" ]]; then
    record_failure "$label must be a regular, non-symlink file: ${file#$ROOT_DIR/}"
    return 1
  fi
}

require_pattern() {
  local file="$1"
  local pattern="$2"
  local message="$3"
  grep -Eq -- "$pattern" "$file" || record_failure "$message in ${file#$ROOT_DIR/}"
}

reject_pattern() {
  local file="$1"
  local pattern="$2"
  local message="$3"
  if grep -Eq -- "$pattern" "$file"; then
    record_failure "$message in ${file#$ROOT_DIR/}"
  fi
}

[[ "$ROOT_DIR" == /* ]] || {
  printf '[branch-flow-audit][error] repository root must be absolute\n' >&2
  exit 1
}
[[ -d "$ROOT_DIR" && ! -L "$ROOT_DIR" ]] || {
  printf '[branch-flow-audit][error] repository root must be a non-symlink directory\n' >&2
  exit 1
}
ROOT_DIR="$(cd -P -- "$ROOT_DIR" && pwd)"

WORKFLOW_DIR="$ROOT_DIR/.github/workflows"
CI_WORKFLOW="$WORKFLOW_DIR/ci.yml"
BRANCH_FLOW_WORKFLOW="$WORKFLOW_DIR/branch-flow.yml"
PR_TEMPLATE="$ROOT_DIR/.github/pull_request_template.md"
CONTRIBUTING="$ROOT_DIR/CONTRIBUTING.md"
TARGET_VALIDATOR="$ROOT_DIR/scripts/validate-pr-target.sh"
SELF_TEST="$ROOT_DIR/scripts/test-branch-flow-audit.sh"

for item in \
  "$CI_WORKFLOW:CI workflow" \
  "$BRANCH_FLOW_WORKFLOW:Branch Flow workflow" \
  "$PR_TEMPLATE:pull request template" \
  "$CONTRIBUTING:contribution guide" \
  "$TARGET_VALIDATOR:PR target validator" \
  "$SELF_TEST:branch-flow self-test"; do
  file="${item%%:*}"
  label="${item#*:}"
  require_regular_file "$file" "$label" || continue
done

if [[ -f "$CI_WORKFLOW" && ! -L "$CI_WORKFLOW" ]]; then
  require_pattern "$CI_WORKFLOW" '(^|[[:space:]])push:' "CI must run for pushes"
  require_pattern "$CI_WORKFLOW" '(^|[[:space:]])pull_request:' "CI must run for pull requests"
  require_pattern "$CI_WORKFLOW" '(^|[^[:alnum:]_])develop([^[:alnum:]_]|$)' "CI must cover develop"
  require_pattern "$CI_WORKFLOW" '(^|[^[:alnum:]_])master([^[:alnum:]_]|$)' "CI must cover master"
  require_pattern "$CI_WORKFLOW" 'bash scripts/test-branch-flow-audit\.sh' "CI must run the branch-flow self-test"
  require_pattern "$CI_WORKFLOW" 'bash scripts/audit-branch-flow\.sh' "CI must run the branch-flow audit"
fi

if [[ -f "$BRANCH_FLOW_WORKFLOW" && ! -L "$BRANCH_FLOW_WORKFLOW" ]]; then
  require_pattern "$BRANCH_FLOW_WORKFLOW" '(^|[[:space:]])pull_request:' "Branch Flow must run for pull requests"
  require_pattern "$BRANCH_FLOW_WORKFLOW" '^  branch-flow:' "Branch Flow must expose a unique branch-flow status check"
  require_pattern "$BRANCH_FLOW_WORKFLOW" 'name:[[:space:]]*branch-flow' "Branch Flow must emit the required branch-flow context"
  require_pattern "$BRANCH_FLOW_WORKFLOW" 'BASE_BRANCH:' "Branch Flow must inspect the PR base branch"
  require_pattern "$BRANCH_FLOW_WORKFLOW" 'HEAD_BRANCH:' "Branch Flow must inspect the PR head branch"
  require_pattern "$BRANCH_FLOW_WORKFLOW" 'bash scripts/test-branch-flow-audit\.sh' "Branch Flow must run its self-test"
  require_pattern "$BRANCH_FLOW_WORKFLOW" 'bash scripts/audit-branch-flow\.sh' "Branch Flow must run its audit"
  require_pattern "$BRANCH_FLOW_WORKFLOW" 'bash scripts/validate-pr-target\.sh' "Branch Flow must run the PR target validator"
fi

if [[ -f "$TARGET_VALIDATOR" && ! -L "$TARGET_VALIDATOR" ]]; then
  [[ -x "$TARGET_VALIDATOR" ]] ||
    record_failure "PR target validator is not executable: ${TARGET_VALIDATOR#$ROOT_DIR/}"
  require_pattern "$TARGET_VALIDATOR" '"\$head_branch"[[:space:]]*==[[:space:]]*"develop"[[:space:]]*\|\|[[:space:]]*"\$head_branch"[[:space:]]*==[[:space:]]*release/\*[[:space:]]*\|\|[[:space:]]*"\$head_branch"[[:space:]]*==[[:space:]]*hotfix/\*' \
    "PR target validator must preserve the exact master promotion allowlist"
  require_pattern "$TARGET_VALIDATOR" 'master is releasable' "PR target validator must preserve master as releasable"
fi

if [[ -f "$PR_TEMPLATE" && ! -L "$PR_TEMPLATE" ]]; then
  reject_pattern "$PR_TEMPLATE" '(^|[^[:alnum:]_])staging([^[:alnum:]_]|$)' "staging branch reference is forbidden"
  require_pattern "$PR_TEMPLATE" 'targets `develop`' "PR template must direct normal work to develop"
  require_pattern "$PR_TEMPLATE" 'targets `master`.*release or hotfix' "PR template must restrict master PRs to release or hotfix"
  require_pattern "$PR_TEMPLATE" 'No direct-to-`master` workflow' "PR template must reject direct master workflow"
fi

if [[ -f "$CONTRIBUTING" && ! -L "$CONTRIBUTING" ]]; then
  reject_pattern "$CONTRIBUTING" '(^|[^[:alnum:]_])staging([^[:alnum:]_]|$)' "staging branch reference is forbidden"
  require_pattern "$CONTRIBUTING" 'Git Flow' "CONTRIBUTING must document Git Flow"
  require_pattern "$CONTRIBUTING" 'starts from `develop`' "CONTRIBUTING must start normal work from develop"
  require_pattern "$CONTRIBUTING" '`master` is the releasable branch' "CONTRIBUTING must keep master releasable"
  require_pattern "$CONTRIBUTING" 'release/\*' "CONTRIBUTING must document release branches"
  require_pattern "$CONTRIBUTING" 'hotfix/\*' "CONTRIBUTING must document hotfix branches"
  require_pattern "$CONTRIBUTING" 'Direct pushes and force pushes.*prohibited' "CONTRIBUTING must prohibit direct and force pushes"
  require_pattern "$CONTRIBUTING" 'approval after the last push' "CONTRIBUTING must require approval after the last push"
fi

if [[ -d "$WORKFLOW_DIR" && ! -L "$WORKFLOW_DIR" ]]; then
  WORKFLOW_COUNT=0
  while IFS= read -r -d '' workflow; do
    WORKFLOW_COUNT=$((WORKFLOW_COUNT + 1))
    reject_pattern "$workflow" '(^|[^[:alnum:]_])staging([^[:alnum:]_]|$)' "staging branch reference is forbidden"
    while IFS= read -r action; do
      [[ "$action" =~ @[0-9a-f]{40}([[:space:]]*#.*)?$ ]] ||
        record_failure "workflow action must be pinned to a 40-hex commit in ${workflow#$ROOT_DIR/}: $action"
    done < <(grep -E '^[[:space:]]*-?[[:space:]]*uses:[[:space:]]*[^./][^[:space:]]*' "$workflow" || true)
  done < <(find "$WORKFLOW_DIR" -type f \( -name '*.yml' -o -name '*.yaml' \) -print0)
  ((WORKFLOW_COUNT > 0)) || record_failure "no GitHub workflow files found"
else
  record_failure ".github/workflows must be a non-symlink directory"
fi

if ((${#FAILURES[@]} > 0)); then
  exit 1
fi

printf '[branch-flow-audit] Branch flow audit passed.\n'
