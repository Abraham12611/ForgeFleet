# Product requirements (PRD) — ForgeFleet

**Stage:** proposed requirements for a private-first single-operator launch. **Problem:** a human currently manually checks roughly 20 individual Orca agent sessions; scaling this to 100+ creates supervision overhead, lost questions, context fragmentation, PR bottlenecks and idle workers.

## Product statement

A command center in which the operator submits a goal, attaches relevant context, sets risk/budget/autonomy limits and supervises one coordinator. That coordinator delegates to dynamic functional teams whose workers can communicate, recover, verify output and ship code within explicit authority boundaries.

## Prioritized functional requirements

| ID | Requirement | Acceptance criterion | Target |
|---|---|---|---|
| FR-01 | Connect to existing Orca | Read-only discovery of active sessions/worktrees without disruption | v0.1 |
| FR-02 | Launch agent worker | One Paperclip task launches one Muse worker in Orca; correlate IDs | v0.1 |
| FR-03 | Durable task/goal context | Goals, specs, dependencies, acceptance and artifacts survive restarts | v0.2 |
| FR-04 | Coordinator task decomposition | Produce DAG and eligible dispatches; no circular dependencies | v0.2 |
| FR-05 | Dynamic worker allocation | Ready tasks scheduled within configured resource/provider limits | v0.2 |
| FR-06 | Threaded inter-agent collaboration | Worker questions and answers durable, routed, searchable and task-linked | v0.2 |
| FR-07 | Unified inbox + sleep mode | Noncritical human questions queued; independent work proceeds | v0.3 |
| FR-08 | GitHub PR automation | Issues, PRs, checks, review, repair cycle and authorized merge | v0.3 |
| FR-09 | Recovery and idempotency | Restart mid-dispatch does not duplicate side effects | v0.4 |
| FR-10 | Observability and cost | Run status, audit, actionable errors, budgets and usage snapshots | v0.4 |
| FR-11 | Mobile-ready web UI | Key operations usable on 360px viewport via Tailscale | v0.3 |
| FR-12 | Formal risk/permission policies | Human approval required for privileged operations; audited | v1.0 |
| FR-13 | Multiple repos/projects | Isolation, project-specific budgets, credentials and contexts | v1.0 |
| FR-14 | Distributed execution | Additional worker hosts with capacity planning and admission control | v1.1 |
| FR-15 | Android app | Native packaging and tested push notifications | v1.1 |

## Functional details

### Context ingestion

User can paste goals, upload Markdown/PDF/images/specs, attach GitHub URLs and define constraints. Extraction is asynchronous, retains source pointers, handles parsing failures and excludes secrets. Agents receive least-necessary excerpts plus links, not a giant prompt dump. User can see which context version was used for each task.

### Coordinator

Creates projects and task DAG, assigns roles, negotiates routine questions, spots dependencies, maintains readiness, dispatches only through policy engine, and requests approval when necessary. Every coordinator instruction has a run ID and deterministic audit record. It cannot secretly grant itself more permissions.

### Agent fleet

Supports pooled worker identities, runtime capability metadata, session continuity, task attempt lifecycle, suspend/retry/reassign. Simultaneous registered agents and actively executing sessions are separate counters.

### Review and shipping

One PR per bounded task or integration slice; CI check ingestion; independent review before merge; conflicts serialized; staging deployment tested; production changes gated. Shipping counts only after verification, not agent self-report.

### Decision inbox

Includes decision urgency, project, task, evidence, recommended options, impact, safe default and deadline. Sleep mode queues noncritical questions. Expired decisions block their dependent actions; never silently approve.

## Nonfunctional requirements

- NFR-01: No loss/duplicate effects across worker/bridge restart; transactional event receipts.
- NFR-02: Availability of dashboard must not control execution continuity; scheduler runs server-side.
- NFR-03: Least-privilege, strict project isolation, auditable privileged writes.
- NFR-04: Backpressure on event ingestion; bounded logs and sensitive data redaction.
- NFR-05: UI status freshness target 5 seconds on healthy private network; eventual reconciliation with outage banners.
- NFR-06: Mobile accessibility: keyboard navigation, readable status, color not sole signal, touch targets.
- NFR-07: Scalable task throughput, capacity admission, provider limits; do not promise 200 concurrent workers on one VPS.

## Negative requirements

No autonomous unlimited paid infrastructure; no silent force merges; no shared writable worktrees; no dangerous web security testing of third-party URLs; no storing user passwords in agent prompts; no blind execution from untrusted PR bodies; no requirements to replace user's installed Orca service.

## Acceptance at v1.0

One real repository completed end-to-end under configured limits, with reproducible CI evidence, GitHub review history, operator sleep cycle, restart recovery, zero unapproved privileged actions, and clear project outcome summary.
