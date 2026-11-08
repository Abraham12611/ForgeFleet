# Ordered work breakdown / issue-ready backlog

All items should be created as **GitHub issues** after repository creation, attached to a version milestone, and assigned to one file-owning engineer. Acceptance checks are not optional. Initial priority:

| ID | Version | Owner | Issue title | Acceptance |
|---|---|---|---|---|
| FF-001 | v0.0 | E01 | Decide Paperclip integration strategy and pin upstream | ADR + reproducible fork/plugin smoke |
| FF-002 | v0.0 | E02 | Probe installed Orca nonintrusively | Sanitized capability report and CLI guide |
| FF-003 | v0.0 | E05 | Freeze bridge API v0.1 and generated validation | Schema and contract tests pass |
| FF-004 | v0.0 | E07 | Define least-privilege auth/policy | Threat model and deny tests |
| FF-005 | v0.0 | E17 | Isolated VPS private deployment scaffold | Does not disturb existing Orca service |
| FF-006 | v0.1 | E06 | Durable attempt mapping and idempotency | Concurrent duplicate requests launch at most once |
| FF-007 | v0.1 | E03 | Muse worker start/status bridge | Recorded real runtime ID and output |
| FF-008 | v0.1 | E04 | Paperclip external adapter round trip | Task → worker → status in Paperclip |
| FF-009 | v0.1 | E15 | Crash-after-launch reconciliation test | No duplicate dispatch |
| FF-010 | v0.1 | E19 | Devin capability spike and safe fallback | Verified or explicitly unsupported |
| FF-011 | v0.2 | E11 | Context file ingestion and manifest | Version-pinned scoped references |
| FF-012 | v0.2 | E08 | Coordinator task DAG/planner | Cycles rejected, goals trace to tasks |
| FF-013 | v0.2 | E09 | Scheduler admission and leases | No double-active task; quota respected |
| FF-014 | v0.2 | E10 | Message thread and escalation routing | Worker A ↔ B, owner escalation persisted |
| FF-015 | v0.2 | E12 | Main command center and project screens | Responsive fixtures and loading/error states |
| FF-016 | v0.2 | E13 | Task/fleet details screens | Task → attempt → agent link traceable |
| FF-017 | v0.3 | E14 | Consolidated inbox and sleep mode | Only blocked dependents wait, other tasks continue |
| FF-018 | v0.3 | E16 | GitHub checks/review/merge gate | Main cannot merge without owner approval |
| FF-019 | v0.3 | E20 | Responsive mobile workflow PWA | Complete 360px acceptance walkthrough |
| FF-020 | v0.4 | E18 | Cost, health, stale-state and event metrics | Real vs estimated labels, audit trail |
| FF-021 | v0.4 | E15 | Recovery/failure-injection suite | Pass all documented crash scenarios |
| FF-022 | v1.0 | E17 | Secure Vercel/Vultr release and rollback rehearsal | Reproducible restore, authenticated split web/API, no open bridge |
| FF-023 | v1.0 | E07 | Security regression and audit gate | No privilege escalation on malicious inputs |
| FF-024 | v1.0 | E01 | End-to-end private release signoff | Goal → merged PR → owner digest with evidence |
| FF-025 | v1.1 | E20 | Capacitor Android AAB and on-device tests | Signed AAB, auth/deep-links/notifications tested on real device |
| FF-026 | v1.1 | E09 | Host registry and distributed admission | Resource-aware safe worker scaling |
| FF-027 | v0.0 | E01 | Paperclip standalone Vite UI / Vercel feasibility spike | Independent Vite build, auth/stream compatibility matrix and fallback documented |
| FF-028 | v0.2 | E17 | Secure Vercel preview to Vultr API ingress | Authenticated preview, no exposed bridge, reconnect and upload tests pass |
| FF-029 | v1.1 | E20 | Google Play internal testing publication | AAB accepted in internal track, Play policy checklist complete and real-device smoke evidence |

`FF-*` identifiers are planning IDs, **not existing GitHub issue numbers**. Do not hardcode them as GitHub issue references until issues exist. Split implementation issues further when they exceed one small PR and re-run dependency review.
