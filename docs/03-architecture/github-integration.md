# GitHub integration and delivery control

## Authentication and permissions

Use an installed GitHub App with repository-scoped permissions and short-lived installation tokens. Required permissions depend on enabled features: contents, issues, pull requests, checks/statuses and webhook metadata. Request minimum each feature needs. Keep tokens in the backend secret store; do not distribute to engineers by default.

## Main loop

1. Coordinator creates task with repo/base branch and acceptance criteria.
2. Worker uses isolated worktree and creates a bounded branch/PR referencing task ID.
3. GitHub webhook handler checks signature, timestamp/event ID and repo installation identity.
4. CI statuses and review threads attach to the correct PR head SHA.
5. Reviewer agent evaluates diff vs task criteria; reviewer must not be same worker when policy requires independent review.
6. Policy engine checks approvals, branch protection, required statuses, mergeability and permitted target branch.
7. Single integration worker serializes merges by repo/base branch. It verifies unchanged head SHA before merge.
8. Merge event closes integration task and wakes dependent tasks after verification.

## Merge policy

- Workers never merge their own PRs.
- `develop`: coordinator/integration worker may merge after checks and independent review once configured.
- `main`: human approval by default; approval refers to exact PR head SHA and expires on new commits.
- Production: deployment approval separate from merge approval.
- Destructive schema operations: require explicit human approval and a rollback plan.

## Reconciliation

Webhooks are hints, not sole truth. Periodically fetch PR/check status to repair missed webhook deliveries, associate events by repo ID + PR number + head SHA. Ignore old status for superseded commits. On branch deletion or repo permission loss, quarantine dependent tasks and report concrete error.

## CI feedback cycle

Limit auto-repair attempts, dedupe identical check failures, include direct log links and only relevant excerpt. No blind re-run loops. Track actual validated check results separately from model analysis.

## Security

GitHub issue and PR text are untrusted and may contain prompt injection; model instructions are *never* a substitute for policy decisions. Fork PRs and untrusted branches must not run with write-scoped secrets. Use repository allowlist and protected branch enforcement.
