/**
 * Event metrics (FF-020, events.md "Ordering and idempotence" + "Delivery
 * semantics", observability-and-cost.md "Metrics").
 *
 * Counts normalized runtime events per family/type, measures ingest lag
 * (receivedAt - occurredAt), dedupes on (source, eventId), ignores late
 * progress for fenced attempts, and parks malformed events in a bounded
 * dead-letter list with a human-visible reason.
 *
 * Cardinality is bounded: the dedupe set evicts oldest entries past
 * maxTrackedIds and only the most recent dead letters are retained
 * (totals are always exact).
 */

import type { IsoDateTimeString } from "./types.js";

export type IngestOutcome = "accepted" | "duplicate" | "stale-epoch" | "dead-letter";

export interface EventRef {
  source: string;
  eventId: string;
  eventType: string;
  family: string;
  occurredAt: IsoDateTimeString;
  receivedAt: IsoDateTimeString;
  attemptId?: string;
  /** Fencing epoch of the attempt at emit time, when known. */
  fencingEpoch?: number;
}

export interface IngestResult {
  outcome: IngestOutcome;
  reason: string;
  lagMs: number | null;
}

export interface LagStats {
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  negativeLagCount: number;
}

export interface DeadLetter {
  receivedAt: IsoDateTimeString;
  reason: string;
  source: string | null;
  eventId: string | null;
  eventType: string | null;
}

export interface EventMetricsSnapshot {
  totalAccepted: number;
  duplicates: number;
  staleEpochIgnored: number;
  deadLetters: number;
  deadLetterRecent: DeadLetter[];
  byFamily: Record<string, number>;
  byType: Record<string, number>;
  lag: LagStats;
  dedupeEvictions: number;
  asOf: IsoDateTimeString;
}

const MAX_DEAD_LETTER_RECENT = 50;

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export class EventMetrics {
  private readonly seen: Map<string, number> = new Map();
  private readonly maxTrackedIds: number;
  private totalAccepted = 0;
  private duplicates = 0;
  private staleEpochIgnored = 0;
  private deadLetters = 0;
  private readonly deadLetterRecent: DeadLetter[] = [];
  private readonly byFamily = new Map<string, number>();
  private readonly byType = new Map<string, number>();
  private readonly lags: number[] = [];
  private negativeLagCount = 0;
  private dedupeEvictions = 0;

  constructor(maxTrackedIds = 10000) {
    this.maxTrackedIds = Math.max(1, maxTrackedIds);
  }

  /**
   * Ingest one normalized event. expectedEpoch is the task's current
   * fencing epoch when known; events from an older epoch are ignored
   * (a stale attempt must not mutate an active task).
   */
  ingest(ref: EventRef, expectedEpoch?: number): IngestResult {
    if (!ref.source || !ref.eventId || !ref.occurredAt) {
      const missing = [!ref.source && "source", !ref.eventId && "eventId", !ref.occurredAt && "occurredAt"]
        .filter(Boolean)
        .join(", ");
      this.recordDeadLetter(ref, `missing required field(s): ${missing}`);
      return { outcome: "dead-letter", reason: `missing required field(s): ${missing}`, lagMs: null };
    }
    if (expectedEpoch !== undefined && ref.fencingEpoch !== undefined && ref.fencingEpoch < expectedEpoch) {
      this.staleEpochIgnored += 1;
      return { outcome: "stale-epoch", reason: `fencing epoch ${ref.fencingEpoch} < current ${expectedEpoch}; ignored`, lagMs: null };
    }
    const key = `${ref.source}\u0000${ref.eventId}`;
    if (this.seen.has(key)) {
      this.duplicates += 1;
      return { outcome: "duplicate", reason: "duplicate (source, eventId); already counted", lagMs: null };
    }
    this.seen.set(key, Date.now());
    if (this.seen.size > this.maxTrackedIds) {
      const oldest = this.seen.keys().next();
      if (!oldest.done) {
        this.seen.delete(oldest.value);
        this.dedupeEvictions += 1;
      }
    }
    const occurred = Date.parse(ref.occurredAt);
    const received = Date.parse(ref.receivedAt);
    let lagMs: number | null = null;
    if (!Number.isNaN(occurred) && !Number.isNaN(received)) {
      lagMs = received - occurred;
      if (lagMs < 0) {
        this.negativeLagCount += 1;
        lagMs = 0;
      }
      this.lags.push(lagMs);
    }
    this.totalAccepted += 1;
    this.byFamily.set(ref.family, (this.byFamily.get(ref.family) ?? 0) + 1);
    this.byType.set(ref.eventType, (this.byType.get(ref.eventType) ?? 0) + 1);
    return { outcome: "accepted", reason: "counted", lagMs };
  }

  private recordDeadLetter(ref: EventRef, reason: string): void {
    this.deadLetters += 1;
    this.deadLetterRecent.push({
      receivedAt: ref.receivedAt,
      reason,
      source: ref.source || null,
      eventId: ref.eventId || null,
      eventType: ref.eventType || null,
    });
    while (this.deadLetterRecent.length > MAX_DEAD_LETTER_RECENT) {
      this.deadLetterRecent.shift();
    }
  }

  snapshot(asOf: IsoDateTimeString = new Date().toISOString()): EventMetricsSnapshot {
    const sorted = [...this.lags].sort((a, b) => a - b);
    return {
      totalAccepted: this.totalAccepted,
      duplicates: this.duplicates,
      staleEpochIgnored: this.staleEpochIgnored,
      deadLetters: this.deadLetters,
      deadLetterRecent: this.deadLetterRecent.map((d) => ({ ...d })),
      byFamily: Object.fromEntries(this.byFamily),
      byType: Object.fromEntries(this.byType),
      lag: {
        count: this.lags.length,
        p50Ms: quantile(sorted, 0.5),
        p95Ms: quantile(sorted, 0.95),
        maxMs: sorted.length > 0 ? sorted[sorted.length - 1] : null,
        negativeLagCount: this.negativeLagCount,
      },
      dedupeEvictions: this.dedupeEvictions,
      asOf,
    };
  }
}
