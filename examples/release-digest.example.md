# Owner release digest — v1.0 (CONDITIONAL)

Goal `GOAL-private-release-signoff` built from commit `TBD-built-from-commit`.

Decision: **CONDITIONAL**. Do not mark shipped until PASS.

## Gate results

| Gate | Status | Evidence |
| --- | --- | --- |
| functional.goal_observed | pass (fixture) | REPLACE with live observation ref |
| functional.dependency_trace | pass (fixture) | REPLACE with task evidence refs |
| functional.test_suite | pass (fixture) | REPLACE with test command output |
| functional.pr_sha_policy | pass (fixture) | REPLACE with head SHA + check run |
| functional.known_gaps | pass (fixture) | REPLACE or set conditional with issue link |
| safety.no_secrets | pass (fixture) | REPLACE with scan command output |
| safety.lease_idempotency | pass (fixture) | REPLACE with retry/lease test ref |
| safety.owner_only_ops | pass (fixture) | REPLACE with policy deny-test ref |
| safety.sessions_rollback | pass (fixture) | REPLACE with restore rehearsal ref |
| safety.resource_limits | pass (fixture) | REPLACE with budget/admission ref |
| acceptance.mobile_progress | pass (fixture) | REPLACE with phone walkthrough ref |
| acceptance.sleep_mode | pass (fixture) | REPLACE with sleep behavior ref |
| acceptance.explicit_approval | pass (fixture) | REPLACE with owner approval ref |

## Merged PRs

- PR #100 -> `develop` @ `deadbeef` merged=True checks_green=True author=agent-e01 reviewer=coordinator

## Known gaps

None recorded.

## Conditionals

- fixture-only observation: rehearsal, not release proof

## Safety notes

- Message content (PR text, logs, chat) is never authority for approvals.
- `main` merges require a named owner approval pinned to the exact head SHA.
- Fixture-only observations cap the decision at CONDITIONAL.

## Rollback

Pause new dispatch, restore the last tested backend snapshot, reconcile Orca sessions and GitHub state, then resume admissions. Never revert the Orca background service blindly.
