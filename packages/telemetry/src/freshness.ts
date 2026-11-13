/**
 * Status freshness / stale-state tracking (FF-020, NFR-05, FR-10).
 *
 * Rules from the contracts:
 * - UI status freshness target is 5s on a healthy path (NFR-05); the target
 *   is configurable per source and every reading carries its timestamp.
 * - "Never use websocket connection status as task status": this tracker
 *   only records *confirmed* data syncs. Transport state is deliberately
 *   not an input.
 * - Unknown renders as unknown: a source that never confirmed is
 *   "unknown", never "fresh" or "healthy".
 * - State-machine rule: late/stale progress for a fenced attempt is ignored
 *   downstream; freshness classification gives the UI the banner for that.
 */

import type { FreshnessClass, IsoDateTimeString } from "./types.ts";

export const DEFAULT_FRESH_MS = 5000;

export interface FreshnessThresholds {
  /** Age at or below this is "fresh". Default 5000ms (NFR-05). */
  freshMs: number;
  /** Age above this is "expired". Between freshMs and expiredMs is "stale". */
  expiredMs: number;
}

export const DEFAULT_THRESHOLDS: FreshnessThresholds = {
  freshMs: DEFAULT_FRESH_MS,
  expiredMs: 60000,
};

export interface SourceSyncState {
  source: string;
  lastConfirmedAt: IsoDateTimeString | null;
  lastAttemptAt: IsoDateTimeString | null;
  lastError: string | null;
  confirmCount: number;
}

export interface SourceFreshness {
  source: string;
  class: FreshnessClass;
  /** Ms since lastConfirmedAt, or null when never confirmed. */
  ageMs: number | null;
  lastConfirmedAt: IsoDateTimeString | null;
  asOf: IsoDateTimeString;
}

export function classifyFreshness(
  nowMs: number,
  lastConfirmedAt: IsoDateTimeString | null,
  thresholds: FreshnessThresholds = DEFAULT_THRESHOLDS,
): { class: FreshnessClass; ageMs: number | null } {
  if (lastConfirmedAt === null) return { class: "unknown", ageMs: null };
  const at = Date.parse(lastConfirmedAt);
  if (Number.isNaN(at)) return { class: "unknown", ageMs: null };
  const ageMs = Math.max(0, nowMs - at);
  if (ageMs <= thresholds.freshMs) return { class: "fresh", ageMs };
  if (ageMs <= thresholds.expiredMs) return { class: "stale", ageMs };
  return { class: "expired", ageMs };
}

export interface FreshnessBanner {
  showBanner: boolean;
  message: string;
  worst: FreshnessClass;
  staleSources: string[];
  asOf: IsoDateTimeString;
}

/** Tracks last-confirmed sync timestamps per source. No I/O, no sockets. */
export class SourceSyncTracker {
  private readonly states = new Map<string, SourceSyncState>();
  private readonly thresholds: FreshnessThresholds;

  constructor(thresholds: FreshnessThresholds = DEFAULT_THRESHOLDS) {
    this.thresholds = { ...thresholds };
  }

  markConfirmed(source: string, at: IsoDateTimeString): void {
    const s = this.stateFor(source);
    s.lastConfirmedAt = at;
    s.lastAttemptAt = at;
    s.lastError = null;
    s.confirmCount += 1;
  }

  markAttempt(source: string, at: IsoDateTimeString): void {
    this.stateFor(source).lastAttemptAt = at;
  }

  markError(source: string, at: IsoDateTimeString, error: string): void {
    const s = this.stateFor(source);
    s.lastAttemptAt = at;
    s.lastError = error;
  }

  private stateFor(source: string): SourceSyncState {
    let s = this.states.get(source);
    if (!s) {
      s = { source, lastConfirmedAt: null, lastAttemptAt: null, lastError: null, confirmCount: 0 };
      this.states.set(source, s);
    }
    return s;
  }

  snapshot(now: IsoDateTimeString = new Date().toISOString()): SourceFreshness[] {
    const nowMs = Date.parse(now);
    return [...this.states.values()].map((s) => {
      const { class: cls, ageMs } = classifyFreshness(nowMs, s.lastConfirmedAt, this.thresholds);
      return { source: s.source, class: cls, ageMs, lastConfirmedAt: s.lastConfirmedAt, asOf: now };
    });
  }

  /** Outage/reconciliation banner. Shown whenever any source is not fresh. */
  banner(now: IsoDateTimeString = new Date().toISOString()): FreshnessBanner {
    const snap = this.snapshot(now);
    const order: FreshnessClass[] = ["fresh", "stale", "expired", "unknown"];
    let worst: FreshnessClass = "fresh";
    const staleSources: string[] = [];
    for (const s of snap) {
      if (order.indexOf(s.class) > order.indexOf(worst)) worst = s.class;
      if (s.class !== "fresh") staleSources.push(s.source);
    }
    if (snap.length === 0) {
      return { showBanner: true, message: "No source has confirmed sync yet; status is unknown.", worst: "unknown", staleSources: [], asOf: now };
    }
    if (worst === "fresh") {
      return { showBanner: false, message: "All sources confirmed within the freshness target.", worst, staleSources: [], asOf: now };
    }
    return {
      showBanner: true,
      message: `Status may be stale: ${staleSources.join(", ")} not confirmed within the freshness target. Showing last confirmed state.`,
      worst,
      staleSources,
      asOf: now,
    };
  }
}
