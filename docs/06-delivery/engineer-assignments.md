# 20 AI engineer allocation and parallelization protocol

This is the initial **20-engineer roster**. Slot numbers are orchestration identities, not a claim that agents have been spawned. Every engineer works in its own branch/worktree and opens a PR. Shared contracts belong to nominated custodians.

| ID | Workstream | Initial deliverable | Exclusive initial ownership | Depends on |
|---|---|---|---|---|
| E01 | Architecture / upstream | Paperclip fork-vs-plugin spike, pinned version, architecture integration baseline | `docs/07-research/paperclip-*.md`, `apps/web` foundation plan | Phase 0 |
| E02 | Orca discovery | Read-only Linux CLI/user-service probe and fixtures | `services/orca-bridge/src/runtime/discovery*` | E05 contract |
| E03 | Orca dispatch | Idempotent Muse start/status/cancel integration | `services/orca-bridge/src/runtime/dispatch*` | E02, E05 |
| E04 | Paperclip adapter | External adapter plugin with session state, callback/streaming | `packages/paperclip-orca-adapter/**` | E01, E05, E03 |
| E05 | API/schema custodian | Bridge OpenAPI/types/validation, contract test harness | `packages/bridge-contracts/**`, `docs/05-contracts/bridge.openapi.yaml` | Phase 0 |
| E06 | Persistence/events | Attempt ID mapping, durable outbox/inbox, dedupe | `services/orca-bridge/src/persistence/**`, `packages/events/**` | E05 |
| E07 | Security/policy | AuthN/AuthZ, privilege gates, threat tests | `packages/policy/**`, `docs/03-architecture/security*` | E05 |
| E08 | Coordinator/planning | Prompt/tools, DAG generation and plan revisions | `packages/coordinator/**` | E05, E07 |
| E09 | Scheduler/DAG | Readiness validator, leases, concurrency limits, retries | `packages/scheduler/**` | E06, E07, E08 |
| E10 | Messaging | Threads/agent messaging, routing, MCP facade | `packages/messaging/**` | E05, E06, E07 |
| E11 | Context/files | Upload, immutable manifests, scoped retrieval | `packages/context/**` | E07 |
| E12 | Web dashboard | Project home, overview, summary cards, responsive nav | `apps/web/src/features/dashboard/**` | E01, E05 |
| E13 | Tasks/fleet UX | Task board/DAG, agent list, attempt details | `apps/web/src/features/tasks/**`, `fleet/**` | E05, E09 |
| E14 | Inbox/chat UX | Coordinator chat, decisions, sleep-mode controls | `apps/web/src/features/inbox/**`, `chat/**` | E05, E10 |
| E15 | QA/reliability | Contract/integration fake Orca tests, failure-injection harness | `tests/**`, `tools/test-fixtures/**` | E05, E06 |
| E16 | GitHub integration | App auth, PR checks, review, merge policy integration | `integrations/github/**` | E07 |
| E17 | Operations | Vultr services + Vercel deployment/ingress, backups and rollback | `infra/**`, `scripts/deploy/**` | E01, E07, E12 |
| E18 | Observability/cost | Telemetry, status freshness, quota/cost dashboards | `packages/telemetry/**` | E05, E06 |
| E19 | Provider parity | Devin runtime capability/fallback and provider registry | `services/orca-bridge/src/providers/**` | E02, E03 |
| E20 | Android/PWA | Capacitor Android + Google Play internal track, responsive flows and notification tests | `apps/android/**`, mobile shell/components | E12, E14, E17 |

## Wave 0: parallel immediately

E01, E02 (read-only), E05, E07 (threat model), E11 (context design), E12 (fixtures-only UI), E15 (test plan), E17 (isolated environment plan), E20 (mobile prototype), E16 (GitHub policy design). **Do not let everyone modify upstream Paperclip files at once.**

## Wave 1: after v0.1 contracts

E03, E04, E06, E08, E10, E13, E18, E19; E01 and E02 review integration. Have E15 test against a fake bridge first. E07 and E16 enforce policy in CI.

## Wave 2: after integrated three-worker demo

E09 scheduler, E14 full inbox, E16 merge loop, E17 deployment automation, E18 metrics and E20 mobile app. Remaining slots take bounded review/fix issues without overlap.

## Lead grouping for coordination

- Platform lead: E01–E07, E17, E19.
- Intelligence / messaging lead: E08–E11.
- Product UX lead: E12–E14, E20.
- Delivery & reliability lead: E15, E16, E18.

One person/agent can act as overall coordinator; it should not be an extra untracked code owner. Leads own integration coordination; workers own scoped PRs.

## Shared-file protocol

Only a contract custodian may edit a shared schema while downstream engineers consume pinned generated types. Changes require a PR and explicit coordination across affected streams. No two active PRs should silently overwrite `apps/web/src/app` or `package.json` on the same branch. Upstream Paperclip repo modifications pass through E01 integration branch.

## Each engineer's initial message template

> You are ForgeFleet engineer E##. Read `AGENTS.md`, `docs/INDEX.md`, `docs/06-delivery/engineer-assignments.md` and your workstream docs. Work only in your assigned paths unless coordinator approves new scope. Base on `develop`, create one bounded PR, never merge your own PR. First deliverable: [issue]. Acceptance: [tests]. Include blocker notes and PR evidence. Do not disturb existing Vultr Orca service.
