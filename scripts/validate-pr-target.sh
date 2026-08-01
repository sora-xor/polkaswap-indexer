#!/usr/bin/env bash
set -euo pipefail

base_branch="${BASE_BRANCH:-${1:-}}"
head_branch="${HEAD_BRANCH:-${2:-}}"

if [[ -z "$base_branch" || -z "$head_branch" ]]; then
  echo "[branch-flow-target] ERROR: BASE_BRANCH and HEAD_BRANCH are required" >&2
  exit 2
fi

echo "PR branch flow: ${head_branch} -> ${base_branch}"

if [[ "$base_branch" == "develop" ]]; then
  if [[ "$head_branch" == "master" ]]; then
    echo "[branch-flow-target] ERROR: Do not open normal work from master to develop. Use a feature/fix/chore/refactor, release, hotfix, or explicit sync branch." >&2
    exit 1
  fi
  exit 0
fi

if [[ "$base_branch" == "master" ]]; then
  if [[ "$head_branch" == "develop" || "$head_branch" == release/* || "$head_branch" == hotfix/* ]]; then
    exit 0
  fi
  echo "[branch-flow-target] ERROR: master is releasable. Only develop, release/*, or hotfix/* branches may target master." >&2
  exit 1
fi

echo "[branch-flow-target] ERROR: Pull requests must target develop for normal work or master for release/hotfix promotion." >&2
exit 1
