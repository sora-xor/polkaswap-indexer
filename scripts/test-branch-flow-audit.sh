#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
AUDIT_SCRIPT="$SCRIPT_DIR/audit-branch-flow.sh"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/polkaswap-branch-flow.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT
CASES=0
EXPECTED_AUDIT_CASES=15

write_valid_repo() {
  local repo="$1"
  mkdir -p "$repo/.github/workflows" "$repo/scripts"

  cat > "$repo/.github/workflows/ci.yml" <<'EOF'
name: CI
on:
  push:
    branches: [develop, master]
  pull_request:
    branches: [develop, master]
jobs:
  test:
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4
      - run: bash scripts/test-branch-flow-audit.sh
      - run: bash scripts/audit-branch-flow.sh
EOF

  cat > "$repo/.github/workflows/branch-flow.yml" <<'EOF'
name: Branch Flow
on:
  pull_request:
jobs:
  branch-flow:
    name: branch-flow
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4
      - run: bash scripts/test-branch-flow-audit.sh
      - run: bash scripts/audit-branch-flow.sh
      - name: Validate PR target
        env:
          BASE_BRANCH: ${{ github.base_ref }}
          HEAD_BRANCH: ${{ github.head_ref }}
        run: bash scripts/validate-pr-target.sh
EOF

  cat > "$repo/scripts/validate-pr-target.sh" <<'EOF'
#!/usr/bin/env bash
base_branch="${BASE_BRANCH:-}"
head_branch="${HEAD_BRANCH:-}"
if [[ "$base_branch" == "master" ]]; then
  if [[ "$head_branch" == "develop" || "$head_branch" == release/* || "$head_branch" == hotfix/* ]]; then
    exit 0
  fi
  echo "master is releasable"
  exit 1
fi
exit 0
EOF
  chmod +x "$repo/scripts/validate-pr-target.sh"

  cat > "$repo/scripts/test-branch-flow-audit.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

  cat > "$repo/.github/pull_request_template.md" <<'EOF'
## Target Branch
- [ ] This PR targets `develop`
- [ ] This PR targets `master` and is a release or hotfix PR
- [ ] No direct-to-`master` workflow is introduced
EOF

  cat > "$repo/CONTRIBUTING.md" <<'EOF'
# Contributing
## Git Flow
All normal work starts from `develop` and is submitted back to `develop`.
Use `release/*` and `hotfix/*` branches only for promotion to `master`.
`master` is the releasable branch.
Direct pushes and force pushes to release branches are prohibited.
Code-owner approval after the last push is required.
EOF
}

expect_pass() {
  local repo="$1"
  local label="$2"
  CASES=$((CASES + 1))
  BRANCH_FLOW_AUDIT_ROOT="$repo" bash "$AUDIT_SCRIPT" >/dev/null ||
    { echo "[branch-flow-audit-test] ERROR: expected pass for $label" >&2; exit 1; }
}

expect_failure() {
  local repo="$1"
  local label="$2"
  local expected="$3"
  local output="$TMP_DIR/$label.out"
  CASES=$((CASES + 1))
  if BRANCH_FLOW_AUDIT_ROOT="$repo" bash "$AUDIT_SCRIPT" >"$output" 2>&1; then
    echo "[branch-flow-audit-test] ERROR: expected failure for $label" >&2
    exit 1
  fi
  if ! grep -Fq "$expected" "$output"; then
    echo "[branch-flow-audit-test] ERROR: $label did not report: $expected" >&2
    cat "$output" >&2
    exit 1
  fi
}

VALID_REPO="$TMP_DIR/valid"
write_valid_repo "$VALID_REPO"
expect_pass "$VALID_REPO" "valid contract"

STAGING_REPO="$TMP_DIR/staging"
write_valid_repo "$STAGING_REPO"
printf '\n# staging\n' >> "$STAGING_REPO/.github/workflows/ci.yml"
expect_failure "$STAGING_REPO" "staging" "staging branch reference is forbidden"

MISSING_BRANCH_FLOW_REPO="$TMP_DIR/missing-branch-flow"
write_valid_repo "$MISSING_BRANCH_FLOW_REPO"
rm "$MISSING_BRANCH_FLOW_REPO/.github/workflows/branch-flow.yml"
expect_failure "$MISSING_BRANCH_FLOW_REPO" "missing-branch-flow" "Branch Flow workflow must be a regular"

MISSING_TARGET_VALIDATOR_REPO="$TMP_DIR/missing-target-validator"
write_valid_repo "$MISSING_TARGET_VALIDATOR_REPO"
rm "$MISSING_TARGET_VALIDATOR_REPO/scripts/validate-pr-target.sh"
expect_failure "$MISSING_TARGET_VALIDATOR_REPO" "missing-target-validator" "PR target validator must be a regular"

MISSING_CI_TARGET_REPO="$TMP_DIR/missing-ci-target"
write_valid_repo "$MISSING_CI_TARGET_REPO"
sed -i.bak '/develop/d' "$MISSING_CI_TARGET_REPO/.github/workflows/ci.yml"
rm -f "$MISSING_CI_TARGET_REPO/.github/workflows/ci.yml.bak"
expect_failure "$MISSING_CI_TARGET_REPO" "missing-ci-target" "CI must cover develop"

UNRESTRICTED_TEMPLATE_REPO="$TMP_DIR/unrestricted-template"
write_valid_repo "$UNRESTRICTED_TEMPLATE_REPO"
sed -i.bak 's/targets `master` and is a release or hotfix PR/targets `master`/' \
  "$UNRESTRICTED_TEMPLATE_REPO/.github/pull_request_template.md"
rm -f "$UNRESTRICTED_TEMPLATE_REPO/.github/pull_request_template.md.bak"
expect_failure "$UNRESTRICTED_TEMPLATE_REPO" "unrestricted-template" "restrict master PRs to release or hotfix"

MISSING_HOTFIX_REPO="$TMP_DIR/missing-hotfix"
write_valid_repo "$MISSING_HOTFIX_REPO"
sed -i.bak 's/hotfix\/\*/fix\/\*/g' "$MISSING_HOTFIX_REPO/CONTRIBUTING.md"
rm -f "$MISSING_HOTFIX_REPO/CONTRIBUTING.md.bak"
expect_failure "$MISSING_HOTFIX_REPO" "missing-hotfix" "document hotfix branches"

FLOATING_ACTION_REPO="$TMP_DIR/floating-action"
write_valid_repo "$FLOATING_ACTION_REPO"
perl -0pi -e 's{actions/checkout@[0-9a-f]{40}}{actions/checkout@v4}' \
  "$FLOATING_ACTION_REPO/.github/workflows/branch-flow.yml"
expect_failure "$FLOATING_ACTION_REPO" "floating-action" "workflow action must be pinned"

NO_SELF_TEST_REPO="$TMP_DIR/no-self-test"
write_valid_repo "$NO_SELF_TEST_REPO"
perl -0pi -e 's{bash scripts/test-branch-flow-audit\.sh}{true # removed}' \
  "$NO_SELF_TEST_REPO/.github/workflows/ci.yml"
expect_failure "$NO_SELF_TEST_REPO" "no-self-test" "CI must run the branch-flow self-test"

NO_AUDIT_REPO="$TMP_DIR/no-audit"
write_valid_repo "$NO_AUDIT_REPO"
perl -0pi -e 's{bash scripts/audit-branch-flow\.sh}{true # removed}' \
  "$NO_AUDIT_REPO/.github/workflows/ci.yml"
expect_failure "$NO_AUDIT_REPO" "no-audit" "CI must run the branch-flow audit"

UNRESTRICTED_MASTER_REPO="$TMP_DIR/unrestricted-master"
write_valid_repo "$UNRESTRICTED_MASTER_REPO"
perl -0pi -e 's{\|\| "\$head_branch" == hotfix/\*}{|| "$head_branch" == *}' \
  "$UNRESTRICTED_MASTER_REPO/scripts/validate-pr-target.sh"
expect_failure "$UNRESTRICTED_MASTER_REPO" "unrestricted-master" "exact master promotion allowlist"

NO_LAST_PUSH_REPO="$TMP_DIR/no-last-push"
write_valid_repo "$NO_LAST_PUSH_REPO"
perl -0pi -e 's/approval after the last push/approval after any push/' \
  "$NO_LAST_PUSH_REPO/CONTRIBUTING.md"
expect_failure "$NO_LAST_PUSH_REPO" "no-last-push" "approval after the last push"

SYMLINK_REPO="$TMP_DIR/symlink"
write_valid_repo "$SYMLINK_REPO"
rm "$SYMLINK_REPO/.github/pull_request_template.md"
ln -s "$VALID_REPO/.github/pull_request_template.md" "$SYMLINK_REPO/.github/pull_request_template.md"
expect_failure "$SYMLINK_REPO" "symlink" "pull request template must be a regular"

WRONG_CONTEXT_REPO="$TMP_DIR/wrong-context"
write_valid_repo "$WRONG_CONTEXT_REPO"
perl -0pi -e 's/name: branch-flow/name: branch-check/' \
  "$WRONG_CONTEXT_REPO/.github/workflows/branch-flow.yml"
expect_failure "$WRONG_CONTEXT_REPO" "wrong-context" "required branch-flow context"

NONEXECUTABLE_VALIDATOR_REPO="$TMP_DIR/nonexecutable-validator"
write_valid_repo "$NONEXECUTABLE_VALIDATOR_REPO"
chmod -x "$NONEXECUTABLE_VALIDATOR_REPO/scripts/validate-pr-target.sh"
expect_failure "$NONEXECUTABLE_VALIDATOR_REPO" "nonexecutable-validator" "PR target validator is not executable"

if ((CASES != EXPECTED_AUDIT_CASES)); then
  echo "[branch-flow-audit-test] ERROR: executed $CASES audit cases; expected $EXPECTED_AUDIT_CASES" >&2
  exit 1
fi

assert_target_passes() {
  BASE_BRANCH="$1" HEAD_BRANCH="$2" bash "$SCRIPT_DIR/validate-pr-target.sh" >/dev/null
}

assert_target_fails() {
  local base="$1"
  local head="$2"
  local expected="$3"
  local output
  set +e
  output="$(BASE_BRANCH="$base" HEAD_BRANCH="$head" bash "$SCRIPT_DIR/validate-pr-target.sh" 2>&1)"
  local status=$?
  set -e
  if [[ "$status" -eq 0 || "$output" != *"$expected"* ]]; then
    echo "[branch-flow-audit-test] ERROR: unexpected target result for $head -> $base" >&2
    echo "$output" >&2
    exit 1
  fi
}

assert_target_passes develop feature/pi-governance
assert_target_passes master develop
assert_target_passes master release/v1.0.0
assert_target_passes master hotfix/pi-health
assert_target_fails develop master "Do not open normal work from master to develop"
assert_target_fails master feature/pi-governance "Only develop, release/*, or hotfix/*"
assert_target_fails production feature/pi-governance "must target develop"

set +e
missing_output="$(env -u BASE_BRANCH -u HEAD_BRANCH bash "$SCRIPT_DIR/validate-pr-target.sh" 2>&1)"
missing_status=$?
set -e
if [[ "$missing_status" -ne 2 || "$missing_output" != *"are required"* ]]; then
  echo "[branch-flow-audit-test] ERROR: missing target variables were not rejected" >&2
  echo "$missing_output" >&2
  exit 1
fi

echo "[branch-flow-audit-test] All 15 audit cases (1 positive + 14 negative/adversarial) and 8 target-policy cases passed."
