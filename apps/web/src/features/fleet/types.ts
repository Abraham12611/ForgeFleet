/**
 * E13 — Tasks/fleet UX (FF-016): fleet view-model types.
 *
 * Covers the `/fleet` center, `/fleet/:agentId` agent detail, and
 * `/projects/:id/agents` project fleet screens (web-app-map). Derived from
 * the worker machine (`docs/05-contracts/state-machines.md`), the bridge
 * `RuntimeSession` schema, and the worker-detail copy rules
 * (`docs/02-experience/screens-states-and-copy.md`): show source,
 * liveness vs task state, current worktree, active PR, token/cost metadata
 * if measurable, historical attempts, and a quarantined terminal log
 * viewer. Secrets are redacted in logs and telemetry freshness is marked.
 *
 * Cost rule (`docs/03-architecture/observability-and-cost.md`): never
 * fabricate costs. Every figure carries `source` (measured vs estimated)
 * and the UI labels estimates as estimates.
 */

import type { WorkerState } from "../tasks/types.ts";

export type CostSource = "measured" | "estimated" | "unavailable";

/** Token/cost metadata; absent figures stay absent, never zero-filled. */
export interface CostMetadata {
  inputTokens?: number | null;
  outputTokens?: number | null;
  billedUsd?: number | null;
  source: CostSource;
  /** e.g. "provider invoice" vs "token-price heuristic". */
  sourceNote?: string | null;
}

/** A registered runtime worker identity. */
export interface FleetAgent {
  agentId: string;
  displayName: string;
  provider: string;
  workerState: WorkerState;
  /** Task the agent currently owns; null when idle/retiring. */
  currentTaskId: string | null;
  currentProjectId: string | null;
  /** All attempt IDs owned by this agent, newest-first preferred. */
  attemptIds: string[];
  worktreeId: string | null;
  /** Terminal/session handle for the quarantined log viewer. */
  terminalId: string | null;
  /** Last time this agent was reconciled against the runtime. */
  lastObservedAt: string | null;
  cost?: CostMetadata | null;
}

/** Filters for the fleet center list. */
export interface FleetFilter {
  provider?: string | null;
  workerState?: WorkerState | null;
  /** Case-insensitive substring over display name / agent ID. */
  query?: string | null;
  /** When true, hide idle (`available`) agents. */
  activeOnly?: boolean;
}

/**
 * Pure windowing helper for virtualized rendering of large fleets
 * (E13 brief: 200 listed agents need virtualized rendering; UX contract
 * tests render 200 virtualized workers). Given a scroll offset and a
 * viewport height in item units, returns the inclusive-exclusive slice to
 * render, expanded by `overscan` rows on each side.
 */
export interface WindowInput {
  total: number;
  /** Zero-based index of the first visible row (may be fractional). */
  scrollOffset: number;
  /** Visible row count. */
  viewportSize: number;
  overscan?: number;
}

export interface WindowSlice {
  start: number;
  end: number;
}

export function windowSlice(input: WindowInput): WindowSlice {
  const overscan = Math.max(0, Math.floor(input.overscan ?? 4));
  const total = Math.max(0, Math.floor(input.total));
  if (total === 0) return { start: 0, end: 0 };
  const start = Math.max(0, Math.floor(input.scrollOffset) - overscan);
  const end = Math.min(
    total,
    Math.ceil(input.scrollOffset + input.viewportSize) + overscan,
  );
  return { start, end: Math.max(start, end) };
}
