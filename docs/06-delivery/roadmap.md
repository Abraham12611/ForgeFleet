# Versioned release roadmap and phase gates

This roadmap is **acceptance-gated**, not date-driven. Each version has subphases and a concrete exit test. Workstreams can overlap if contracts and dependencies permit.

## Phase 0 — Research, repo and environment baseline (v0.0)

- **0.A Product/spec:** freeze doc baseline, acceptance and domain ownership.
- **0.B Safety inventory:** read-only inspect Orca version/config/service, Paperclip pinned release, VPS limits, GitHub permissions.
- **0.C Code foundation:** initialize Paperclip fork strategy and separate bridge packages, branching/CI, `develop` integration branch.
- **0.D Contract baseline:** OpenAPI/event schema, test fixtures and automated checks.
- **0.E Web topology spike:** E01/E12/E17 prove whether pinned Paperclip Vite UI can deploy to Vercel separately from Vultr API, including auth and streaming. Record fallback if not.
- **Exit:** API/data contracts reviewed, two integration spike work plans approved, no existing runtime disruption.

## Phase 1 — Proof of connection (v0.1)

- **1.A Paperclip private deployment:** authenticated responsive dashboard, DB and health on **Vultr**, with no disruption to Orca. Vercel preview may run in parallel after frontend feasibility spike, but is not required for first worker proof.
- **1.B Orca read-only bridge:** runtime discovery, capabilities, 20 existing sessions shown read-only.
- **1.C Muse worker execution:** Paperclip task -> authorized idempotent Orca launch -> captured attempt/worktree IDs.
- **1.D Completion round-trip:** worker status, message, artifact/PR link reaches Paperclip and UI.
- **1.E Restart proof:** bridge restart during live task; reconcile original before retry.
- **Exit:** one real disposable task round trip with no duplicate attempt and an auditable event trail. Devin can remain an explicit unknown with gated test.

## Phase 2 — Coordinated team (v0.2)

- **2.A Goal/context ingestion:** files, version manifests, project setup.
- **2.B Coordinator planner:** task DAG, dependency validator, plan approval.
- **2.C Scheduler:** ready queue, leases, per-project/global admission, budget and retry limits.
- **2.D Agent channels:** task threads, worker/lead/coordinator messages, owner escalation.
- **2.E App surfaces:** project task board, agent fleet, conversation UI, responsive mobile navigation.
- **2.F Vercel preview:** independently built web assets deployed to Vercel with secure staging API ingress, authenticated E2E and real-time event delivery; otherwise keep UI on Vultr and record blocking issues.
- **Exit:** coordinator safely dispatches three independent workers, routes a peer question, blocks dependent integration until appropriate work verified.

## Phase 3 — Engineering delivery (v0.3)

- **3.A GitHub App:** repo selection, issue/PR links, webhook signature verification, CI head SHA tracking.
- **3.B Review/repair:** independent review, CI feedback, bounded repair attempts, merge serializing.
- **3.C Human decisions:** consolidated inbox, sleeping vs awake, approval trace.
- **3.D Mobile polish:** accessible small-screen screens and notification preference controls.
- **Exit:** three-worker demo ends with reviewed PR(s), `develop` merge under policy, `main` blocked until owner approval; sleep leaves independent tasks active.

## Phase 4 — Durable automation (v0.4)

- **4.A Event outbox/inbox:** at-least-once receipts, dedupe, backpressure.
- **4.B Recovery watchdog:** lease fencing, external runtime reconciliation, orphan handling, log visibility.
- **4.C Memory continuity:** task context manifests, summary/handoff, sync-back verification.
- **4.D Observability:** live status, cost and quota dashboard, alerts, audit history.
- **Exit:** pass injected failures in `flow-catalog` and `contract-test-cases` without lost question or duplicate side effects.

## Phase 5 — Private production readiness (v1.0)

- **5.A Security:** least privilege, private access, resource limits, secret hygiene, incident controls.
- **5.B Multi-project:** isolation by project/workspace, context ACL, GitHub permissions.
- **5.C QA:** security review, resilience soak, restore rehearsals, operator runbooks.
- **5.D Release:** owner-approved Vercel web production deployment with secured Vultr API (only after split-UI feasibility and auth checks); rollback, user acceptance and completed sample repo.
- **Exit:** stable overnight run with useful work remaining, verified deliverables, no unapproved privileged action and explicit operator signoff.

## Phase 6 — Fleet scale and Android distribution (v1.1+)

- **6.A Multiple worker hosts:** host registry, Vultr capacity, Tailscale secure enrollment, orchestrated scaling.
- **6.B Provider adapters:** Devin parity if feasible, more runtimes, fallback semantics, cost measurement.
- **6.C Android shell:** signed Capacitor Android App Bundle, native notifications, deep links, Google Play Console internal testing, policy/data-safety review; owner controls production release.
- **6.D Performance:** 20/50/100/200 *registered* agents and separately 5/10/25/50 active attempts; ramp only while resource/provider evidence supports it.
- **Exit:** statistically measured throughput and failure rates at target capacity; no assertion that 200 active workers work on one VPS.

## Milestone tracking

Issue labels recommended: `phase/0` through `phase/6`, `workstream/<domain>`, `kind/spike|feature|integration|security|qa`, `status/blocked|ready|in-progress|review`, `priority/P0|P1|P2`. GitHub milestones `v0.1`... `v1.1`. Create labels/milestones after repo exists and permissions verified. Do not claim they exist yet.
