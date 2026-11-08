# Operational observability, auditing and budgets

## Event stream

`task.*`, `attempt.*`, `runtime.*`, `message.*`, `decision.*`, `github.*`, `context.*`, `budget.*`, `security.*` with `traceId` and service-scoped actor identity. See [events.md](../05-contracts/events.md).

## Structured log fields

`timestamp`, `level`, `service`, `projectId`, `taskId?`, `attemptId?`, `actorId`, `eventId?`, `correlationId`, `operation`, `status`, `durationMs`, `source`, `errorCode` and sanitized `summary`. Never include raw auth headers or arbitrary uploaded file contents.

## Metrics

Pending/ready/running/blocked tasks; active workers by provider; bridge/Orca liveness; event lag; dispatch dedupe; worktree count; PRs in review; CI pass/fail by commit; human interruptions; budgets consumed; restart recovery time; queue dead letters; provider throttling.

## Cost ledger

Track `provider`, `model`, `inputTokens`, `outputTokens`, `billedUsd`, `source`, `confidence` where available. Never fabricate costs or equate token consumption with billed USD when no price data exists. Budget check is pre-dispatch, and actions denied on missing budget authorization should be visible.

## Dashboard outcomes

Today's verified merges, active work, blocked decisions, current best estimate of spend, oldest stalled task, and a concise explanation of why workers are idle. Show timestamp of last confirmed GitHub/Orca sync.

## Health endpoints

Separate process live (`/health/live`) from dependency readiness (`/health/ready`) and capability probe (`/health/capabilities`); use internal auth for detailed diagnostics. Health test must not spawn workers or mutate projects.
