#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AUDIT_SCRIPT="$SCRIPT_DIR/audit-branch-flow.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

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
EOF

  cat > "$repo/.github/workflows/branch-flow.yml" <<'EOF'
name: Branch Flow
on:
  pull_request:
jobs:
  branch-flow:
    steps:
      - name: Validate PR target
        env:
          BASE_BRANCH: ${{ github.base_ref }}
          HEAD_BRANCH: ${{ github.head_ref }}
        run: bash scripts/validate-pr-target.sh
EOF

  cat > "$repo/scripts/validate-pr-target.sh" <<'EOF'
#!/usr/bin/env bash
if [[ "$BASE_BRANCH" == "master" ]]; then
  if [[ "$HEAD_BRANCH" == "develop" || "$HEAD_BRANCH" == release/* || "$HEAD_BRANCH" == hotfix/* ]]; then
    exit 0
  fi
  echo "master is releasable"
fi
EOF
  chmod +x "$repo/scripts/validate-pr-target.sh"

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
EOF
}

expect_failure() {
  local repo="$1"
  local label="$2"
  local expected="$3"
  local output="$TMP_DIR/$label.out"
  if bash "$AUDIT_SCRIPT" "$repo" >"$output" 2>&1; then
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
bash "$AUDIT_SCRIPT" "$VALID_REPO" >/dev/null

STAGING_REPO="$TMP_DIR/staging"
write_valid_repo "$STAGING_REPO"
printf '\n# staging\n' >> "$STAGING_REPO/.github/workflows/ci.yml"
expect_failure "$STAGING_REPO" "staging" "staging branch reference"

MISSING_BRANCH_FLOW_REPO="$TMP_DIR/missing-branch-flow"
write_valid_repo "$MISSING_BRANCH_FLOW_REPO"
rm "$MISSING_BRANCH_FLOW_REPO/.github/workflows/branch-flow.yml"
expect_failure "$MISSING_BRANCH_FLOW_REPO" "missing-branch-flow" "Branch Flow workflow is missing"

MISSING_TARGET_VALIDATOR_REPO="$TMP_DIR/missing-target-validator"
write_valid_repo "$MISSING_TARGET_VALIDATOR_REPO"
rm "$MISSING_TARGET_VALIDATOR_REPO/scripts/validate-pr-target.sh"
expect_failure "$MISSING_TARGET_VALIDATOR_REPO" "missing-target-validator" "PR target validator is missing"

MISSING_CI_TARGET_REPO="$TMP_DIR/missing-ci-target"
write_valid_repo "$MISSING_CI_TARGET_REPO"
sed -i.bak '/develop/d' "$MISSING_CI_TARGET_REPO/.github/workflows/ci.yml"
rm -f "$MISSING_CI_TARGET_REPO/.github/workflows/ci.yml.bak"
expect_failure "$MISSING_CI_TARGET_REPO" "missing-ci-target" "CI workflow must include develop"

UNRESTRICTED_MASTER_REPO="$TMP_DIR/unrestricted-master"
write_valid_repo "$UNRESTRICTED_MASTER_REPO"
sed -i.bak 's/targets `master` and is a release or hotfix PR/targets `master`/' "$UNRESTRICTED_MASTER_REPO/.github/pull_request_template.md"
rm -f "$UNRESTRICTED_MASTER_REPO/.github/pull_request_template.md.bak"
expect_failure "$UNRESTRICTED_MASTER_REPO" "unrestricted-master" "restrict master PRs to release or hotfix"

MISSING_BACKPORT_REPO="$TMP_DIR/missing-hotfix"
write_valid_repo "$MISSING_BACKPORT_REPO"
sed -i.bak 's/hotfix\/\*/fix\/\*/g' "$MISSING_BACKPORT_REPO/CONTRIBUTING.md"
rm -f "$MISSING_BACKPORT_REPO/CONTRIBUTING.md.bak"
expect_failure "$MISSING_BACKPORT_REPO" "missing-hotfix" "document hotfix branches"

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

echo "[branch-flow-audit-test] Branch flow audit self-test passed."
