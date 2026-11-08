# Domain and persistence model

## Entities

- `Organization` / `Project`: tenant boundary, repo bindings, policies, context versions, status.
- `Goal`: natural-language objective, constraints, acceptance criteria, parent project.
- `PlanRevision`: coordinator plan, DAG nodes/edges, proposer/approval, immutable version hash.
- `Task`: durable unit of work and dependencies, acceptance, assignee role, status, priority.
- `TaskAttempt`: taskID, provider, runtime, generation/fencing token, dispatch ID, session ID, start/end, exit evidence.
- `AgentIdentity`: role, runtime capabilities, team, active context, provider, display identity.
- `WorktreeLease`: repo, path, branch, agent, attempt, expiry, fencing token, ownership source.
- `Message`: threadID, actor, recipient(s), project/task/attempt correlation, delivery state, dedupe key.
- `Decision`: type/risk, requester, options, required human authority, status, answer and audit.
- `PRReview`: GitHub repo/PR/headSHA, checks, verdict, gate evaluation, attempts.
- `ContextAsset`: project, hash/version, MIME, extraction result, ACL, object pointer, deleted state.
- `IntegrationConnection`: scoped GitHub/Orca/provider configs, auth reference, health.
- `UsageLedger`: tokens/cost/resource measurements with source/uncertainty markers.
- `AuditEvent`: immutable actor, action, policy result, correlation ID, timestamp.

## Cross-system ID invariants

Each task and attempt has a **ForgeFleet UUID/ULID**; persist `paperclipTaskId`, `paperclipRunId`, `orcaTaskId`, `orcaRunId`, `orcaDispatchId`, `orcaTerminalId`, `orcaWorktreeId` (where available), `githubRepoId`, `githubPrNumber`, `githubHeadSha` separately and nullable. Never repurpose external ID as primary key or assume one task = one attempt or one PR.

## Suggested bridge tables (proposal, not an applied migration)

```sql
CREATE TABLE execution_attempts (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  paperclip_task_id text NOT NULL,
  paperclip_run_id text,
  orca_run_id text,
  orca_task_id text,
  orca_dispatch_id text UNIQUE,
  orca_session_id text,
  worktree_id text,
  state text NOT NULL,
  fencing_epoch bigint NOT NULL DEFAULT 1,
  provider text,
  worker_kind text,
  started_at timestamptz,
  last_heartbeat_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE dispatch_requests (
  id uuid PRIMARY KEY,
  task_id text NOT NULL,
  idempotency_key text UNIQUE NOT NULL,
  desired_action text NOT NULL,
  request_hash text NOT NULL,
  state text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE runtime_event_receipts (
  id uuid PRIMARY KEY,
  source text NOT NULL,
  source_event_id text NOT NULL,
  payload_sha256 text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source, source_event_id)
);
CREATE TABLE outbound_events (
  id uuid PRIMARY KEY,
  event_type text NOT NULL,
  body jsonb NOT NULL,
  destination text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
```

Production DB design must align with Paperclip's own schema and migration conventions. This illustrative schema is a separation-of-concerns reference; do **not** apply it verbatim without review.

## Consistency

All state-changing requests have idempotency keys and actor IDs. Bridge receipt + outbox write share one DB transaction; external events are delivered at least once and consumed idempotently. Background reconciliation regularly compares state with Orca/GitHub. Deleted context assets must invalidate cached excerpts and future task access.
