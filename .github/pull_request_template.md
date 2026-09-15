## Summary

Describe the change and why it is needed.

## Related Issue

Closes #<issue-number> (or) Relates to #<issue-number>

## Target Branch

- [ ] This PR targets `develop`
- [ ] This PR targets `master` and is a release or hotfix PR

## API And Storage Impact

- [ ] No public GraphQL or storage change
- [ ] Backward-compatible GraphQL or storage addition
- [ ] Breaking change with migration and compatibility notes

## Test Plan

Commands run locally:

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

Additional checks and scenarios covered:
-

## Release / Rollback Notes

Deployment impact, environment changes, data compatibility, migration, backup,
or rollback steps.

## Checklist

- [ ] Linked an issue and added a clear description
- [ ] Updated GraphQL schema/docs when public behavior changed
- [ ] Added or updated tests for changed behavior, including failure cases
- [ ] Verified the public GraphQL API remains read-only
- [ ] Preserved string or integer-safe handling for chain amounts
- [ ] Documented storage migration and rollback when persistence changed
- [ ] Verified the production image excludes development-only dependencies
- [ ] No secrets, local environment files, or generated build output committed
- [ ] `bash scripts/audit-public-artifacts.sh` passes
- [ ] No direct-to-`master` workflow is introduced
