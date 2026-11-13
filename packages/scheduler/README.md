# @forgefleet/scheduler (FF-013 + FF-026)

Deterministic scheduler core for ForgeFleet. Implements the readiness
predicate, DAG validation, single-active lease/fencing, admission quotas,
retry backoff, and restart recovery (FF-013, v0.2), plus the worker-host
registry, secure enrollment, heartbeat/staleness, per-host capacity, safe
deregistration, and distributed admission (FF-026, v1.1), defined in:

- [orchestration](../../docs/03-architecture/orchestration.md)
- [state machines](../../docs/05-contracts/state-machines.md)
- [scaling and recovery](../../docs/03-architecture/scaling-and-recovery.md)
- [capacity model](../../docs/03-architecture/scaling-and-recovery.md)

No I/O, no network, no Orca calls. All inputs are plain data; all outputs are
deterministic given the same inputs and clock value. The caller supplies
persistence (lease rows) and runtime observations.

## Acceptance (FF-013)

- No double-active task: at most one active fenced lease per task; generation
  is monotonic; stale heartbeats for fenced epochs are ignored.
- Quota respected: per-project and global active-worker caps, provider,
  host-capacity, and budget gates deny admission with machine-readable reasons.

## Layout

- `src/dag.js` — DAG validation (cycle rejection, gating vs informational edges)
- `src/readiness.js` — readiness predicate with denial reasons
- `src/leases.js` — in-memory lease store (acquire/release/heartbeat/expire/fence)
- `src/admission.js` — quota/capacity admission + `eligibleActive` computation
- `src/retry.js` — bounded exponential backoff; `unknown` is never immediately retried
- `src/scheduler.js` — deterministic ready-queue + admit batch
- `src/recovery.js` — restart reconciliation (running/terminal/unknown/orphan)
- `src/hosts.js` — `HostRegistry`: join-token enrollment bound to a recorded
  Tailscale identity, heartbeats with resource observation
  (slots, disk/memory pressure, providers, runtimes, active leases),
  staleness timeout, draining, and deregistration that refuses to remove a
  host with active leases unless forced with an explicit fence proof.
  Retired records are retained for audit. Pure logic; injected `nowMs`.
- `src/distributed.js` — `aggregateHostCapacity` (host term = sum of free
  slots over eligible hosts), `eligibleActiveDistributed` (min over all
  gates), `selectHost` (best-fit, lexical tie-break), `admitOneDistributed`
  (quota gates first with FF-013-compatible reasons, host pin last), and
  `selectHostsForTasks` (deterministic greedy placement; bounded sync loop,
  no fan-out).
- `src/index.js` — re-exports

## Composition (FF-026 on FF-013)

FF-013 (`admission.js` `eligibleActive`/`admitOne`, `leases.js` fencing)
owns single-host admission and lease state. FF-026 adds the host registry
and distributed admission alongside it: feed `aggregateHostCapacity`'s
`totalFree` into FF-013's `hostFreeCapacity` limit, then pin each admitted
dispatch to `selectHost`'s `hostId` and record the lease holder as
`<hostId>:<attemptId>` so fencing stays per task.

## Status and limits (FF-026)

`HostRegistry` is an **in-memory policy model**, not a deployment: it holds
no durable rows, performs no Tailscale identity verification, and talks to
no hosts. Join tokens here are opaque test handles; real enrollment,
provider-limit enforcement, and cross-host recovery must remain **disabled**
until verified Tailscale identity, durable leases, and proven recovery
exist. This package is the v1.1 fixture/policy layer — it is not evidence
for 200 active agents, measured capacity, or provider pricing.

## Contract sources (FF-026)

- Capacity model: `docs/03-architecture/scaling-and-recovery.md`
  (`eligible_active = min(ready_tasks, project_limit, global_limit,
  provider_available, host_free_capacity, budget_capacity)`).
- Readiness/leases/fencing: `docs/03-architecture/orchestration.md`,
  `docs/05-contracts/state-machines.md` (single active fenced attempt per
  task; `unknown` never implicitly releases).
- Admission UX: `docs/04-flows/goal-to-worker.md` Subflow B (denials keep the
  task ready/blocked with a human-readable reason).
- Requirements: FR-14, NFR-07 (`docs/01-product/product-requirements.md`).

Run tests with `npm test` inside this directory (Node built-in runner, no deps).
