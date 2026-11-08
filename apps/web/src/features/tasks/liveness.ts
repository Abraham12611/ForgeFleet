/**
 * E13 — Tasks/fleet UX (FF-016): liveness vs verification separation.
 *
 * Contract rule (`docs/02-experience/screens-states-and-copy.md`): the UI
 * must never label an agent "working" solely because it was dispatched; it
 * uses last-reconciled telemetry and distinguishes unknown state.
 * Companion invariant (`docs/05-contracts/state-machines.md`): `finished`
 * means the runtime ended, not that code was accepted — so a finished
 * attempt on an unverified task is "runtime done, verification pending",
 * never "complete".
 *
 * `describeLiveness` answers "is the runtime alive right now?" while task
 * `status` answers "is the work verified?". Screens render both side by
 * side (liveness freshness separately from task verification).
 */

import type { AttemptState } from "./types.ts";

export type Liveness =
  | "live"
  | "dispatched-unconfirmed"
  | "stale"
  | "unknown"
  | "terminal";

/** Human-readable liveness labels; color must never be the sole signal. */
export const LIVENESS_LABELS: Record<Liveness, string> = {
  live: "Live",
  "dispatched-unconfirmed": "Dispatched — awaiting runtime confirmation",
  stale: "Stale — no recent heartbeat",
  unknown: "Unknown — telemetry lost, reconciling",
  terminal: "Runtime ended",
};

export interface LivenessInput {
  attemptState: AttemptState;
  /** Last reconciled heartbeat (`lastHeartbeatAt`); null if never seen. */
  lastHeartbeatAt?: string | null;
  /** Observation time; defaults to now so tests can pin it. */
  now?: number;
  /** Freshness target: 5s on a healthy private network (NFR-05). */
  staleAfterMs?: number;
}

export const DEFAULT_STALE_AFTER_MS = 5_000;

export function describeLiveness(input: LivenessInput): Liveness {
  const { attemptState } = input;
  if (
    attemptState === "finished" ||
    attemptState === "failed" ||
    attemptState === "cancelled"
  ) {
    return "terminal";
  }
  if (attemptState === "unknown") {
    return "unknown";
  }
  if (attemptState === "requested" || attemptState === "accepted") {
    return "dispatched-unconfirmed";
  }
  // dispatching/running/waiting: liveness depends on reconciled telemetry,
  // never on the dispatch alone.
  const heartbeat = input.lastHeartbeatAt ? Date.parse(input.lastHeartbeatAt) : NaN;
  if (!input.lastHeartbeatAt || Number.isNaN(heartbeat)) {
    return attemptState === "dispatching"
      ? "dispatched-unconfirmed"
      : "unknown";
  }
  const now = input.now ?? Date.now();
  const staleAfter = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  return now - heartbeat <= staleAfter ? "live" : "stale";
}

/** Whole, human-scale age string for "last seen Xs ago" freshness marks. */
export function formatAge(lastSeenAt: string, now: number): string {
  const ms = Math.max(0, now - Date.parse(lastSeenAt));
  if (Number.isNaN(ms)) return "time unknown";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
