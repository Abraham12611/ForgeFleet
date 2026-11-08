# Screen states, behaviors and microcopy

Every screen must represent `loading`, `ready`, `empty`, `recoverable-error`, `permission-denied`, `offline`, and `stale` where applicable. UI must never label an agent 'working' solely because it was dispatched; use last-reconciled telemetry and distinguish unknown state.

## Dashboard

- Empty: "No active projects. Start with a goal and a repository."
- Project running: show verified tasks completed, active workers, ready tasks, blocked decisions, checks failing, and remaining budget.
- Provider throttled: "Workers are waiting for provider capacity. Independent tasks will resume automatically within limits."
- Orca unavailable: show last successful check, do not pretend workers stopped; allow diagnostic/read-only actions.

## Coordinator chat

Composer accepts text, file references and project links. Messages visually distinguish `owner`, `coordinator`, `team lead`, `worker`, and `system`. Present citations for context attachments and links to created tasks. Show turn delivery status (queued/sent/acknowledged/failed); retry does not create new logical request ID.

## Decision inbox

Every question includes `reason`, `blocked_tasks`, `choices`, `risk`, `default_on_timeout`, `last_updated`, `source_agent`, and deep links. A sleeping owner sees a digest; safety-critical actions remain blocked even when their deadline passes.

## Worker detail

Show source (Orca/other), liveness vs task state, current worktree, active PR, token/cost metadata if measurable, historical attempts and a quarantined terminal log viewer. Redact secrets in logs and mark telemetry freshness.

## Review screen

Display required checks, review verdict, changed-file summary, conflict/rebase status, policy outcome, and action to request changes. 'Merge' button is disabled with a human-readable reason when any gate is unsatisfied.

## UX errors

Never write 'all good' without evidence. Retryable errors show safe retry action; non-retryable errors show escalation instructions; destructive actions require explicit confirmation with resource identifiers.
