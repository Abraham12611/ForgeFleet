/**
 * Health model (FF-020, observability-and-cost.md "Health endpoints",
 * bridge.openapi.yaml liveness/capabilities).
 *
 * Separate process liveness (/health/live) from dependency readiness
 * (/health/ready) and capability probing (/health/capabilities).
 * This module is pure: it never spawns workers, never mutates projects,
 * and never performs I/O. Callers inject probe results obtained through
 * read-only transports.
 */

import type { HealthStatus, IsoDateTimeString } from "./types.js";

export type ProviderStatus = "verified" | "unsupported" | "unknown" | "unavailable";

export interface LiveReport {
  alive: true;
  startedAt: IsoDateTimeString;
  uptimeMs: number;
  version: string;
}

export interface ComponentReport {
  name: string;
  status: HealthStatus;
  checkedAt: IsoDateTimeString;
  latencyMs?: number;
  detail?: string;
  lastError?: string;
}

export interface ReadyReport {
  status: HealthStatus;
  checks: ComponentReport[];
  checkedAt: IsoDateTimeString;
}

export interface ProviderCapability {
  name: string;
  status: ProviderStatus;
  notes?: string;
}

export interface CapabilitiesReport {
  reachable: boolean;
  checkedAt: IsoDateTimeString;
  cliVersion: string | null;
  commandPath: string | null;
  providers: ProviderCapability[];
}

export interface CombinedHealth {
  status: HealthStatus;
  live: LiveReport | null;
  ready: ReadyReport | null;
  capabilities: CapabilitiesReport | null;
  /** True when any leg is missing or unknown: render as unknown, not healthy. */
  unknownLegs: string[];
}

const RANK: Record<HealthStatus, number> = {
  unknown: 0,
  healthy: 1,
  degraded: 2,
  unhealthy: 3,
};

function worst(a: HealthStatus, b: HealthStatus): HealthStatus {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * Readiness is the worst of its checks. An empty check list means
 * "unknown" — never claim ready without evidence.
 */
export function summarizeReadiness(checks: ComponentReport[], checkedAt: IsoDateTimeString): ReadyReport {
  if (checks.length === 0) return { status: "unknown", checks: [], checkedAt };
  let status: HealthStatus = "healthy";
  for (const c of checks) status = worst(status, c.status);
  return { status, checks: checks.map((c) => ({ ...c })), checkedAt };
}

/**
 * Capability rollup: reachable=false forces degraded (the runtime cannot be
 * confirmed), never healthy. Provider detail is preserved for the UI.
 */
export function summarizeCapabilities(report: CapabilitiesReport): HealthStatus {
  if (!report.reachable) return "degraded";
  let status: HealthStatus = "healthy";
  for (const p of report.providers) {
    if (p.status === "unavailable") status = worst(status, "unhealthy");
    else if (p.status === "unknown" || p.status === "unsupported") status = worst(status, "degraded");
  }
  return status;
}

export function combineHealth(args: {
  live: LiveReport | null;
  ready: ReadyReport | null;
  capabilities: CapabilitiesReport | null;
}): CombinedHealth {
  const { live, ready, capabilities } = args;
  const unknownLegs: string[] = [];
  if (live === null) unknownLegs.push("live");
  if (ready === null) unknownLegs.push("ready");
  if (capabilities === null) unknownLegs.push("capabilities");
  if (ready !== null && ready.status === "unknown") unknownLegs.push("ready:checks-unknown");
  // Unknown renders as unknown: an unconfirmed leg must never read as
  // healthy/degraded. A confirmed unhealthy leg still wins over unknown.
  let status: HealthStatus = "unknown";
  if (live !== null) status = worst(status, "healthy");
  if (ready !== null && ready.status !== "unknown") status = worst(status, ready.status);
  if (capabilities !== null) status = worst(status, summarizeCapabilities(capabilities));
  if (unknownLegs.length > 0 && status !== "unhealthy") status = "unknown";
  return { status, live, ready, capabilities, unknownLegs };
}
