/**
 * Shared telemetry primitives for ForgeFleet (E18 / FF-020).
 *
 * Design rules enforced across this package:
 * - Never invent cost figures or status. Unknown renders as unknown.
 * - Every figure shown to an operator carries its source and freshness.
 * - Rollups are cardinality-bounded so 200 listed workers cannot flood the UI.
 */

export type IsoDateTimeString = string;

export interface ActorIdentity {
  type: "service" | "human" | "agent";
  id: string;
}

/** Where a cost number came from. Controls the real-vs-estimated label. */
export type CostSource =
  | "provider-invoice"
  | "provider-api"
  | "price-table"
  | "manual-entry"
  | "unknown";

/**
 * Operator-facing cost label.
 * - `actual`: billed USD reported by the provider (invoice or provider API).
 * - `estimated`: USD derived locally (price table) or from an unverified source.
 * - `unknown`: no usable USD figure exists. Shown as unknown, never as zero.
 */
export type CostLabel = "actual" | "estimated" | "unknown";

export type HealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown";

/** Freshness of one synchronised source (NOT websocket connection state). */
export type FreshnessClass = "fresh" | "stale" | "expired" | "unknown";

export type AuditStatus = "ok" | "denied" | "failed";
