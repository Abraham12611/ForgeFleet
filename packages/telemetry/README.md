# @forgefleet/telemetry (E18 / FF-020)

Observability primitives for ForgeFleet: cost ledger with real-vs-estimated
labels, health separation, status freshness, event metrics, audit trail, and
bounded dashboard rollups.

- Contracts: `docs/03-architecture/observability-and-cost.md`,
  `docs/05-contracts/events.md`, `docs/05-contracts/bridge.openapi.yaml`
  (`RuntimeCapabilities`), `docs/05-contracts/state-machines.md`.
- Zero runtime dependencies. Pure functions plus two in-memory stores
  (`CostLedger`, `AuditTrail`, `EventMetrics`, `SourceSyncTracker`).
  Durable persistence belongs to E06; this package owns labeling,
  aggregation and gating semantics only.
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
npm run build      # tsc -> dist/
npm run typecheck  # tsc --noEmit
npm test           # build + node --test dist/test/
```
