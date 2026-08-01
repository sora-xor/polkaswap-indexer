# Rollback Checklist

Use this when a Polkaswap indexer release causes a production-impacting issue.

## Trigger

- Roll back when `_health`, GraphQL compatibility, wallet history, Polkaswap
  data, finalized-block progress, repository integrity, or latency crosses the
  agreed production threshold.
- Assign one incident owner and one communication owner.

## Immediate Actions

- Identify the last known-good `master` tag, immutable image digest, deployment
  ID, and compatible data backup.
- Capture the failing GraphQL operation, response errors, request IDs, SORA RPC
  status, finalized-block lag, worker state, database health, and deployment ID.
- Stop or quiesce the worker before restoring data or changing storage engines.
- Revert configuration or traffic routing first when that removes the issue
  without risking indexed data.
- If code rollback is required, redeploy the last known-good artifact. Restore a
  compatible database backup or checkpoint only when the code rollback cannot
  read the current data safely.

## Hotfix Path

- Create `hotfix/<version-or-slug>` from `master`.
- Apply the smallest safe fix or revert.
- Run the branch-flow, public-artifact, TODO-debt, dependency, deployment
  evidence, production-smoke, full test, build, and container checks for the
  changed surface.
- Open a PR to `master`, tag after merge, then merge or cherry-pick the hotfix
  back to `develop`.

## After Recovery

- Re-run the production `_health` smoke and representative read-only GraphQL
  queries.
- Confirm the worker resumes from the intended finalized block without gaps or
  duplicate document corruption.
- Document root cause, affected queries and collections, user impact, data
  recovery actions, and prevention work.
- Update release notes and the cross-repo project tracker with the final
  disposition.
