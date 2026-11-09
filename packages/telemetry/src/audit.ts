/**
 * Audit trail (FF-020 acceptance criterion, observability-and-cost.md
 * "Structured log fields", NFR-04 backpressure/redaction).
 *
 * Every externally triggered action is recorded with actor identity,
 * correlation IDs and a sanitized summary. Append-only: entries are
 * never updated or deleted through this API.
 *
 * Redaction: object keys matching a sensitive pattern (auth headers,
 * tokens, secrets, passwords, keys) are replaced before storage, and
 * summaries are length-bounded so logs stay bounded.
 */

import type { ActorIdentity, AuditStatus, IsoDateTimeString } from "./types.js";

export const MAX_SUMMARY_CHARS = 500;

const SENSITIVE_KEY = /(authoriz|token|secret|password|passwd|api[-_]?key|cookie|session|private[-_]?key|credentials)/i;

export function redactValue(key: string, value: unknown): unknown {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((v) => redactValue(key, v));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(k, v);
    }
    return out;
  }
  return value;
}

export function sanitizeSummary(summary: string): string {
  if (summary.length <= MAX_SUMMARY_CHARS) return summary;
  return summary.slice(0, MAX_SUMMARY_CHARS - 1) + "…";
}

export interface AuditEntryInput {
  at: IsoDateTimeString;
  traceId: string;
  correlationId?: string;
  actor: ActorIdentity;
  operation: string;
  status: AuditStatus;
  summary: string;
  projectId?: string;
  taskId?: string;
  attemptId?: string;
  eventId?: string;
  durationMs?: number;
  errorCode?: string;
  /** Cost label attached when the operation touches spend. */
  costLabel?: string;
  /** Structured detail; sensitive keys are redacted on append. */
  detail?: Record<string, unknown>;
}

export interface AuditEntry extends AuditEntryInput {
  seq: number;
}

export class AuditTrail {
  private readonly entries: AuditEntry[] = [];
  private nextSeq = 1;

  append(input: AuditEntryInput): AuditEntry {
    const entry: AuditEntry = {
      ...input,
      detail: input.detail ? (redactValue("", input.detail) as Record<string, unknown>) : undefined,
      summary: sanitizeSummary(input.summary),
      seq: this.nextSeq++,
    };
    this.entries.push(entry);
    return { ...entry };
  }

  byTrace(traceId: string): AuditEntry[] {
    return this.entries.filter((e) => e.traceId === traceId).map((e) => ({ ...e }));
  }

  byCorrelation(correlationId: string): AuditEntry[] {
    return this.entries.filter((e) => e.correlationId === correlationId).map((e) => ({ ...e }));
  }

  /** Newline-delimited JSON for ship-to-log pipelines. Redacted at append. */
  toJsonLines(): string {
    return this.entries.map((e) => JSON.stringify(e)).join("\n") + (this.entries.length > 0 ? "\n" : "");
  }

  get size(): number {
    return this.entries.length;
  }
}
