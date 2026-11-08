# Normalized events and delivery contract

## Envelope (JSON v0.1)

```json
{
  "eventId": "01H...",
  "schemaVersion": "0.1",
  "eventType": "attempt.started",
  "occurredAt": "2026-11-08T12:00:00Z",
  "receivedAt": "2026-11-08T12:00:01Z",
  "source": "orca-bridge",
  "projectId": "project_123",
  "taskId": "task_123",
  "attemptId": "00000000-0000-4000-8000-000000000001",
  "correlationId": "01H...",
  "fencingEpoch": 1,
  "actor": {"type": "service", "id": "orca-bridge"},
  "data": {"externalDispatchId": "orca_dispatch_abc"}
}
```

Example only, not a real captured runtime event.

## Event families

| Family | Types | Consumer impact |
|---|---|---|
| `project` | `created`, `paused`, `resumed` | Admission changed |
| `task` | `ready`, `claimed`, `blocked`, `unblocked`, `submitted`, `verified`, `failed` | Recompute DAG readiness |
| `attempt` | `accepted`, `started`, `heartbeat`, `question`, `finished`, `failed`, `unknown`, `cancelled` | Update attempt state |
| `message` | `posted`, `delivered`, `acknowledged`, `failed` | Deliver to thread, wake recipient |
| `decision` | `requested`, `answered`, `expired`, `withdrawn` | Gate transitions |
| `github` | `pr.opened`, `checks.updated`, `review.submitted`, `merged`, `closed` | Reconcile PR/acceptance |
| `runtime` | `connected`, `disconnected`, `capacity.changed` | Admission and UI banners |
| `budget` | `threshold`, `exhausted` | Stop new work as appropriate |

## Ordering and idempotence

`eventId` unique by source; handlers use `(source,eventId)` dedupe and per-attempt sequence or fencing epoch. No global total ordering assumption. Consumer must be safe on duplicated/reordered events. A stale attempt cannot mutate an active task after lease is fenced. Store original timestamp and ingest timestamp; ignore late stale progress when task attempt advanced.

## Delivery semantics

At least once, persist receipt before ack. Outbox retry with exponential backoff; dead-letter queue with human-visible reason. Runtime event streaming to UI is best-effort; state retrieval API must be authoritative fallback. Never use websocket connection status as task status.

## Compatibility rules

New event types must be safely ignored by older clients; breaking field changes increment schema version, require migration and contract tests. Redact sensitive payloads before events enter logs/audit and UI.
