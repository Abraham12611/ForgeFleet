# Coordinator API and tool interface (proposed)

The LLM coordinator uses typed tools exposed by a backend service; it does not shell out to GitHub or Orca directly. Every tool takes project-scoped session identity and emits a durable audit event.

| Tool | Required input | Output / guard |
|---|---|---|
| `list_project_context` | projectId, requested manifest | Versioned source references, scoped retrieval |
| `propose_plan` | projectId, goalId, tasks/DAG | Validated plan revision, or conflict details |
| `approve_plan` | planId, human or policy grant | Immutable approved plan revision |
| `get_ready_tasks` | projectId, filters | Readiness reasons and capacity |
| `propose_dispatch` | taskId, desired workerKind | Policy verdict/lease or denial; dispatch not direct LLM side effect |
| `read_thread` | threadId, cursor | Authorized messages |
| `send_message` | threadId, recipient, body, key | Durable message receipt |
| `ask_owner` | projectId, taskId, choices, risk | Durable decision, never direct mobile notification bypass |
| `inspect_attempt` | attemptId | Correlated Orca runtime evidence and freshness |
| `request_review` | taskId, PR ref/head SHA | Review job and acceptance evidence |
| `propose_merge` | repo, PR, expected SHA | Policy evaluation and permission-specific action |
| `pause_project` | projectId, reason | Stops new dispatch; in-flight semantics explicit |
| `report_status` | projectId, period | Verifiable summary with source event IDs |

### Tool call control

Validate against JSON schemas, project and role ACLs, current object version and idempotency keys; reject stale contexts. For `OWNER_REQUIRED` result, create a decision request, not an executable action. Apply provider quotas and loop budgets to task-generation calls. Keep human-readable denial reasons.
