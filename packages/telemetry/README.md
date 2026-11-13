# @forgefleet/telemetry (E18 / FF-020)

Observability primitives for ForgeFleet: cost ledger with real-vs-estimated
labels, health separation, status freshness, event metrics, audit trail, and
bounded dashboard rollups.

- Contracts: `docs/03-architecture/observability-and-cost.md`,
  `docs/05-contracts/events.md`, `docs/05-contracts/bridge.openapi.yaml`
  (`RuntimeCapabilities`), `docs/05-contracts/state-machines.md`.
- Zero npm dependencies (node builtins only). Pure functions plus
  in-memory stores (`CostLedger`, `AuditTrail`, `EventMetrics`,
  `SourceSyncTracker`) and a SQLite reservation store (`node:sqlite`)
  for cross-process admission. Canonical durable persistence belongs to
  E06; this package owns labeling, aggregation, reservations and gating
  only.
- Budget admission is fail-closed: unknown spend denies new billable
  dispatches unless an explicit owner quota (`OwnerQuotaPolicy`,
  `unknownPolicy: "reserve"`) covers the request; the gate decides on
  known + reserved + requested atomically — use `checkAndReserve()` so a
  passed check holds its reservation. Provider quotas, per-project caps
  and the global cap are hard ceilings alongside the per-dispatch budget;
  every money input must be finite and non-negative (`NaN`/`Infinity` deny).
- Reservation lifecycle: `settle()` consumes a hold into recorded spend on
  success, `release()` frees it on failure, `reconcile()` drops holds with
  no live owner after a failure or restart, and `importReservations()`
  reloads holds. Identical `reserve()`/`checkAndReserve()` retries are
  idempotent (no double-count); reusing an id for different terms is denied.
- Multi-process durability (`src/reservationJournal.ts`): every admission
  runs in one SQLite write transaction (`BEGIN IMMEDIATE` … `COMMIT`;
  `allowed: true` is returned only after the hold commits, so it is
  fsync-durable) — use `durableCheckAndReserve()` when two processes may
  admit concurrently. There is no stealable stale lock: a second process
  waits on the live holder, never breaks in. Missing store means new
  state; unreadable/corrupt stores deny instead of admitting. Global and
  provider ceilings count every project; durable admission requires an
  explicit owner identity and an owner-matching unknown-spend policy.
- E05/E06 are not implemented yet in this repo, so this package defines its
  own minimal types and ships fixture-friendly constructors. When
  `packages/bridge-contracts` and `packages/events` land, align the
  `EventRef` / envelope field names with them (no silent divergence).

## Rules (acceptance)

- Real vs estimated: `actual` requires provider-reported USD
  (`provider-invoice` / `provider-api`); anything else priced is
  `estimated`; missing USD is `unknown` — never `$0`, never fabricated.
- Budget denials (including missing authorization) are returned as data
  so the UI can show them.
- Health keeps `live` / `ready` / `capabilities` separate; unknown legs
  render overall `unknown` (a confirmed `unhealthy` still wins).
- Freshness tracks last-*confirmed* syncs only (default target 5s,
  NFR-05); socket state is never an input.
- Event ingest dedupes on `(source, eventId)`, ignores older fencing
  epochs, and parks malformed events in a bounded dead-letter list with
  reasons. Dedupe/dead-letter storage is bounded; totals stay exact.
- Audit entries are append-only with redacted sensitive keys and
  length-bounded summaries.

## Commands

```sh
npm run typecheck  # tsc --noEmit
npm test           # node --test test/*.test.ts (sources run directly, no build)
```
