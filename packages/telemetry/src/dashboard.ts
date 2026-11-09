/**
 * Dashboard snapshot builder (FF-020, FR-10, observability-and-cost.md
 * "Dashboard outcomes", contract-test-cases.md UX "200 virtualized workers").
 *
 * Builds the operator-facing rollup: verified merges, active work,
 * blocked decisions, spend with its real/estimated label, oldest stalled
 * task, why workers are idle, and last-confirmed sync timestamps.
 *
 * Anti-flood rules:
 * - Worker detail is rolled up by state/provider; raw lists are paged
 *   with an explicit total + truncated flag (virtualized-list friendly).
 * - Stalled-task detail is top-K with an explicit omitted count.
 * - Every figure carries asOf/labels; unmeasured spend is "unknown",
 *   never $0 and never a fabricated estimate.
 */

import type { CostLabel, FreshnessClass, HealthStatus, IsoDateTimeString } from "./types.js";

export type WorkerState =
  | "available"
  | "assigned"
  | "starting"
  | "busy"
  | "reporting"
  | "disconnected"
  | "quarantined"
  | "retiring";

export interface WorkerInfo {
  id: string;
  state: WorkerState;
  provider: string;
}

export interface WorkerRollup {
  total: number;
  byState: Record<string, number>;
  byProvider: Record<string, number>;
  /** Bounded sample for rendering; see truncated/total. */
  listed: WorkerInfo[];
  truncated: boolean;
}

export function rollupWorkers(workers: WorkerInfo[], limit = 50): WorkerRollup {
  const byState: Record<string, number> = {};
  const byProvider: Record<string, number> = {};
  for (const w of workers) {
    byState[w.state] = (byState[w.state] ?? 0) + 1;
    byProvider[w.provider] = (byProvider[w.provider] ?? 0) + 1;
  }
  const listed = workers.slice(0, Math.max(0, limit)).map((w) => ({ ...w }));
  return { total: workers.length, byState, byProvider, listed, truncated: workers.length > listed.length };
}

export interface StalledTask {
  taskId: string;
  projectId: string;
  state: string;
  /** Ms waiting in the current state, for ranking oldest-first. */
  waitingMs: number;
}

export interface DashboardSnapshot {
  asOf: IsoDateTimeString;
  health: { status: HealthStatus; unknownLegs: string[] };
  spend: { totalKnownUsd: number | null; label: CostLabel; uncoveredCount: number };
  budget: { budgetUsd: number | null; allowed: boolean | null; reason: string };
  freshness: { worst: FreshnessClass; staleSources: string[]; banner: string | null };
  events: { accepted: number; duplicates: number; staleIgnored: number; deadLetters: number; lagP95Ms: number | null };
  workers: WorkerRollup;
  verifiedMergesToday: number;
  activeTasks: number;
  blockedDecisions: number;
  oldestStalledTask: StalledTask | null;
  stalledOmitted: number;
  idleExplanation: string;
  lastConfirmedSync: Record<string, IsoDateTimeString | null>;
}

export const MAX_STALLED_DETAIL = 5;

export function buildDashboardSnapshot(args: {
  asOf?: IsoDateTimeString;
  healthStatus: HealthStatus;
  healthUnknownLegs?: string[];
  spend: { totalKnownUsd: number | null; label: CostLabel; uncoveredCount: number };
  budget: { budgetUsd: number | null; allowed: boolean | null; reason: string };
  freshnessWorst: FreshnessClass;
  freshnessStaleSources?: string[];
  freshnessBanner?: string | null;
  events: { accepted: number; duplicates: number; staleIgnored: number; deadLetters: number; lagP95Ms: number | null };
  workers: WorkerInfo[];
  workerListLimit?: number;
  verifiedMergesToday: number;
  activeTasks: number;
  blockedDecisions: number;
  stalledTasks: StalledTask[];
  idleExplanation: string;
  lastConfirmedSync?: Record<string, IsoDateTimeString | null>;
}): DashboardSnapshot {
  const asOf = args.asOf ?? new Date().toISOString();
  const ranked = [...args.stalledTasks].sort((a, b) => b.waitingMs - a.waitingMs);
  return {
    asOf,
    health: { status: args.healthStatus, unknownLegs: args.healthUnknownLegs ?? [] },
    spend: { ...args.spend },
    budget: { ...args.budget },
    freshness: {
      worst: args.freshnessWorst,
      staleSources: args.freshnessStaleSources ?? [],
      banner: args.freshnessBanner ?? null,
    },
    events: { ...args.events },
    workers: rollupWorkers(args.workers, args.workerListLimit ?? 50),
    verifiedMergesToday: args.verifiedMergesToday,
    activeTasks: args.activeTasks,
    blockedDecisions: args.blockedDecisions,
    oldestStalledTask: ranked.length > 0 ? { ...ranked[0] } : null,
    stalledOmitted: Math.max(0, ranked.length - Math.min(ranked.length, MAX_STALLED_DETAIL)),
    idleExplanation: args.idleExplanation,
    lastConfirmedSync: { ...(args.lastConfirmedSync ?? {}) },
  };
}
