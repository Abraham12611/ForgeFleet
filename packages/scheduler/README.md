# @forgefleet/scheduler (FF-013)

Deterministic scheduler core for ForgeFleet v0.2. Implements the readiness
predicate, DAG validation, single-active lease/fencing, admission quotas,
retry backoff, and restart recovery defined in:

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
- `src/index.js` — re-exports

Run tests with `npm test` inside this directory (Node built-in runner, no deps).
