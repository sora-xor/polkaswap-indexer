#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
FAILURES=0

record_failure() {
  echo "[branch-flow-audit] ERROR: $*" >&2
  FAILURES=1
}

require_file() {
  local file="$1"
  local label="$2"
  if [[ ! -f "$file" ]]; then
    record_failure "$label is missing: ${file#$ROOT_DIR/}"
    return 1
  fi
}

require_pattern() {
  local file="$1"
  local pattern="$2"
  local message="$3"
  if ! grep -Eq "$pattern" "$file"; then
    record_failure "$message in ${file#$ROOT_DIR/}"
  fi
}

scan_for_staging() {
  local file="$1"
  local matches
  matches="$(grep -nE '(^|[^[:alnum:]_])staging([^[:alnum:]_]|$)' "$file" || true)"
  if [[ -n "$matches" ]]; then
    record_failure "staging branch reference found in ${file#$ROOT_DIR/}:"
    printf '%s\n' "$matches" >&2
  fi
}

if [[ ! -d "$ROOT_DIR" ]]; then
  record_failure "repo root does not exist: $ROOT_DIR"
fi

WORKFLOW_DIR="$ROOT_DIR/.github/workflows"
CI_WORKFLOW="$WORKFLOW_DIR/ci.yml"
BRANCH_FLOW_WORKFLOW="$WORKFLOW_DIR/branch-flow.yml"
PR_TEMPLATE="$ROOT_DIR/.github/pull_request_template.md"
CONTRIBUTING="$ROOT_DIR/CONTRIBUTING.md"
TARGET_VALIDATOR="$ROOT_DIR/scripts/validate-pr-target.sh"

if [[ ! -d "$WORKFLOW_DIR" ]]; then
  record_failure ".github/workflows is missing"
else
  WORKFLOW_COUNT=0
  while IFS= read -r -d '' workflow; do
    WORKFLOW_COUNT=$((WORKFLOW_COUNT + 1))
    scan_for_staging "$workflow"
  done < <(find "$WORKFLOW_DIR" -type f \( -name '*.yml' -o -name '*.yaml' \) -print0)
  if [[ "$WORKFLOW_COUNT" -eq 0 ]]; then
    record_failure "no GitHub workflow files found"
  fi
fi

if require_file "$CI_WORKFLOW" "CI workflow"; then
  require_pattern "$CI_WORKFLOW" '(^|[[:space:]])push:' "CI workflow must run on pushes"
  require_pattern "$CI_WORKFLOW" '(^|[[:space:]])pull_request:' "CI workflow must run on pull requests"
  require_pattern "$CI_WORKFLOW" '(^|[^[:alnum:]_])develop([^[:alnum:]_]|$)' "CI workflow must include develop"
  require_pattern "$CI_WORKFLOW" '(^|[^[:alnum:]_])master([^[:alnum:]_]|$)' "CI workflow must include master"
fi

if require_file "$BRANCH_FLOW_WORKFLOW" "Branch Flow workflow"; then
  require_pattern "$BRANCH_FLOW_WORKFLOW" '(^|[[:space:]])pull_request:' "Branch Flow workflow must run on pull requests"
  require_pattern "$BRANCH_FLOW_WORKFLOW" '^  branch-flow:' "Branch Flow workflow must expose a unique branch-flow status check"
  require_pattern "$BRANCH_FLOW_WORKFLOW" 'BASE_BRANCH' "Branch Flow workflow must inspect the PR base branch"
  require_pattern "$BRANCH_FLOW_WORKFLOW" 'HEAD_BRANCH' "Branch Flow workflow must inspect the PR head branch"
  require_pattern "$BRANCH_FLOW_WORKFLOW" 'scripts/validate-pr-target\.sh' "Branch Flow workflow must run the PR target validator"
fi

if require_file "$TARGET_VALIDATOR" "PR target validator"; then
  if [[ ! -x "$TARGET_VALIDATOR" ]]; then
    record_failure "PR target validator is not executable: ${TARGET_VALIDATOR#$ROOT_DIR/}"
  fi
  require_pattern "$TARGET_VALIDATOR" 'release/\*' "PR target validator must allow release branches into master"
  require_pattern "$TARGET_VALIDATOR" 'hotfix/\*' "PR target validator must allow hotfix branches into master"
  require_pattern "$TARGET_VALIDATOR" 'master is releasable' "PR target validator must preserve master as releasable"
fi

if require_file "$PR_TEMPLATE" "pull request template"; then
  scan_for_staging "$PR_TEMPLATE"
  require_pattern "$PR_TEMPLATE" 'targets `develop`' "PR template must ask normal work to target develop"
  require_pattern "$PR_TEMPLATE" 'targets `master`.*release or hotfix' "PR template must restrict master PRs to release or hotfix"
  require_pattern "$PR_TEMPLATE" 'No direct-to-`master` workflow' "PR template must reject direct-to-master workflow drift"
fi

if require_file "$CONTRIBUTING" "CONTRIBUTING.md"; then
  scan_for_staging "$CONTRIBUTING"
  require_pattern "$CONTRIBUTING" 'Git Flow' "CONTRIBUTING.md must document Git Flow"
  require_pattern "$CONTRIBUTING" 'starts from `develop`' "CONTRIBUTING.md must require normal work from develop"
  require_pattern "$CONTRIBUTING" '`master` is the releasable branch' "CONTRIBUTING.md must keep master releasable"
  require_pattern "$CONTRIBUTING" 'release/\*' "CONTRIBUTING.md must document release branches"
  require_pattern "$CONTRIBUTING" 'hotfix/\*' "CONTRIBUTING.md must document hotfix branches"
fi

if [[ "$FAILURES" -ne 0 ]]; then
  exit 1
fi

echo "[branch-flow-audit] Branch flow audit passed."
