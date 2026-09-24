# Contributing to Polkaswap Indexer

## Git Flow

All normal work starts from `develop` and is submitted back to `develop`.
Use short-lived branches named `feature/<ticket>-<slug>`, `fix/<ticket>-<slug>`,
`chore/<slug>`, or `refactor/<slug>`.

`master` is the releasable branch. Do not target `master` except for release
pull requests from `develop`, `release/*` stabilization branches, or urgent
`hotfix/*` branches. Every commit on `master` must be safe to deploy, and
release tags must point at commits already merged to `master`.

Direct pushes and force pushes to release branches are prohibited. Required
status checks, code-owner review, stale-review dismissal, review-thread
resolution, and approval after the last push must be enforced by repository
rules before merging to `develop` or `master`.

Feature PRs are squash-merged after review and green CI. Release PRs to
`master` use merge commits so the release boundary remains visible. Hotfixes
must be merged or cherry-picked back to `develop` after release.

## Local Checks

Run these before submitting a PR:

```sh
corepack enable
yarn install --immutable
bash scripts/test-branch-flow-audit.sh
bash scripts/audit-branch-flow.sh
bash scripts/test-public-artifacts-audit.sh
bash scripts/audit-public-artifacts.sh
bash scripts/test-todo-debt-audit.sh
bash scripts/audit-todo-debt.sh
yarn test:deployment-manifest
yarn audit:dependencies
yarn audit:dependencies:production
yarn test
yarn build
```

## Pull Requests

- Target `develop` for normal work.
- Target `master` only for release or hotfix PRs.
- Include GraphQL compatibility notes for schema, resolver, filter, or ordering
  changes.
- Include migration, backup, and rollback notes for repository or storage
  changes.
- Keep the public GraphQL API read-only and preserve integer-safe chain amount
  handling.
- Do not commit secrets, local environment files, database files, backups, or
  generated build output.
