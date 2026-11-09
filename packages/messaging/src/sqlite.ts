/**
 * E10 / FF-014 — Transactional SQLite backing for messaging state.
 *
 * Review-driven replacement for the process-memory maps: every mutation
 * (message + receipts, escalation + decision, receipt updates) commits in
 * a single SQLite transaction together with its outbox events, so a crash
 * can neither lose an acknowledged decision/peer message nor emit an ack
 * for state that was never persisted.
 *
 * - Unique keys enforced by the storage layer: `messages.idempotency_key`,
 *   `messages.external_id`, `receipts(message_id, recipient_id)`,
 *   `outbox.event_id`.
 * - Outbox (at-least-once, dedupe by `event_id`): events are enqueued in
 *   the same transaction as the state change; a separate claim/deliver
 *   loop (owned by the #60 integration) redelivers after restart.
 *   `requeueStaleClaims` recovers claims orphaned by a crash.
 * - Stdlib only (`node:sqlite`). One file per deployment; the bridge
 *   adapter owns backup/restore.
 */

import { DatabaseSync } from "node:sqlite";
import { MessageError, type BridgeEvent, type EventType } from "./types.ts";

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS threads (
  thread_id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  project_id TEXT NOT NULL,
  task_id TEXT,
  created_at TEXT NOT NULL,
  acl_json TEXT NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(thread_id),
  channel TEXT NOT NULL,
  project_id TEXT NOT NULL,
  task_id TEXT,
  attempt_id TEXT,
  sender_json TEXT NOT NULL,
  recipient_ids_json TEXT NOT NULL,
  kind TEXT NOT NULL,
  labels_json TEXT NOT NULL DEFAULT '[]',
  body TEXT NOT NULL,
  attachments_json TEXT,
  severity TEXT,
  deadline_at TEXT,
  created_at TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  external_id TEXT UNIQUE,
  visibility_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
CREATE TABLE IF NOT EXISTS receipts (
  message_id TEXT NOT NULL REFERENCES messages(message_id),
  recipient_id TEXT NOT NULL,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reason TEXT,
  PRIMARY KEY (message_id, recipient_id)
);
CREATE TABLE IF NOT EXISTS escalations (
  escalation_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(thread_id),
  project_id TEXT NOT NULL,
  task_id TEXT,
  raised_by_json TEXT NOT NULL,
  options_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  severity TEXT NOT NULL,
  deadline_at TEXT,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  resolution TEXT,
  decision_id TEXT
);
CREATE TABLE IF NOT EXISTS decisions (
  decision_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT,
  escalation_id TEXT,
  question TEXT NOT NULL,
  options_json TEXT NOT NULL,
  risk TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL,
  answer TEXT,
  answered_by TEXT,
  answered_at TEXT,
  target_sha TEXT
);
CREATE TABLE IF NOT EXISTS outbox (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  project_id TEXT NOT NULL,
  task_id TEXT,
  payload_json TEXT NOT NULL,
  claimed_at TEXT,
  delivered_at TEXT
);
`;

export interface OutboxClaim {
  eventId: string;
  event: BridgeEvent;
}

export function parseJson<T>(value: string | null, fallback: T): T {
  if (value === null) return fallback;
  return JSON.parse(value) as T;
}

export class MessagingDb {
  private db: DatabaseSync;

  constructor(path: string) {
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(path);
    } catch (err) {
      throw new MessageError("VALIDATION", 400, `cannot open messaging database: ${(err as Error).message}`);
    }
    this.db = db;
    this.db.exec("PRAGMA journal_mode = DELETE");
    this.db.exec(SCHEMA);
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (row.user_version === 0) {
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    } else if (row.user_version !== SCHEMA_VERSION) {
      throw new MessageError(
        "VALIDATION",
        400,
        `unsupported messaging schema version: ${row.user_version}`,
      );
    }
  }

  close(): void {
    this.db.close();
  }

  /** Run fn inside a single transaction; rolls back on throw. */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Rollback can fail only if the transaction already ended.
      }
      throw err;
    }
  }

  prepare(sql: string) {
    return this.db.prepare(sql);
  }

  /**
   * Build a frozen-contract BridgeEvent, rejecting malformed envelopes
   * before they can enter the outbox.
   */
  buildEvent(input: {
    eventId: string;
    eventType: EventType;
    occurredAt: string;
    projectId: string;
    taskId?: string | null;
    actor: { type: "service" | "human" | "agent"; id: string };
    data?: Record<string, unknown>;
    source?: string;
    correlationId?: string;
  }): BridgeEvent {
    if (!input.eventId || !input.eventType || !input.occurredAt || !input.projectId) {
      throw new MessageError("VALIDATION", 400, "outbox event requires eventId, eventType, occurredAt, projectId");
    }
    if (!input.actor || !input.actor.id || !input.actor.type) {
      throw new MessageError("VALIDATION", 400, "outbox event requires actor {type,id}");
    }
    return {
      eventId: input.eventId,
      schemaVersion: "0.1",
      eventType: input.eventType,
      occurredAt: input.occurredAt,
      source: input.source ?? "forgefleet-messaging",
      projectId: input.projectId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      actor: { type: input.actor.type, id: input.actor.id },
      data: input.data ?? {},
    };
  }

  /** Enqueue events; call inside the owning state-change transaction. */
  enqueueOutbox(events: BridgeEvent[]): void {
    const stmt = this.db.prepare(
      "INSERT INTO outbox (event_id, event_type, occurred_at, project_id, task_id, payload_json) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const event of events) {
      try {
        stmt.run(
          event.eventId,
          event.eventType,
          event.occurredAt,
          event.projectId,
          event.taskId ?? null,
          JSON.stringify(event),
        );
      } catch (err) {
        throw new MessageError("CONFLICT", 409, `duplicate outbox event: ${(err as Error).message}`);
      }
    }
  }

  /** Claim up to `limit` undelivered events for sending (single-process atomic). */
  claimOutbox(limit: number, now: string): OutboxClaim[] {
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          "SELECT event_id, payload_json FROM outbox WHERE delivered_at IS NULL AND claimed_at IS NULL ORDER BY occurred_at LIMIT ?",
        )
        .all(limit) as Array<{ event_id: string; payload_json: string }>;
      const claim = this.db.prepare("UPDATE outbox SET claimed_at = ? WHERE event_id = ?");
      return rows.map((row) => {
        claim.run(now, row.event_id);
        return { eventId: row.event_id, event: JSON.parse(row.payload_json) as BridgeEvent };
      });
    });
  }

  markOutboxDelivered(eventId: string, now: string): void {
    const info = this.db
      .prepare("UPDATE outbox SET delivered_at = ? WHERE event_id = ? AND delivered_at IS NULL")
      .run(now, eventId);
    if (info.changes === 0) {
      throw new MessageError("VALIDATION", 400, `unknown or already delivered outbox event: ${eventId}`);
    }
  }

  /** Recover claims orphaned by a crash: claimed but never delivered. */
  requeueStaleClaims(olderThanMs: number, now: string): number {
    const cutoff = new Date(Date.parse(now) - olderThanMs).toISOString();
    const info = this.db
      .prepare("UPDATE outbox SET claimed_at = NULL WHERE delivered_at IS NULL AND claimed_at IS NOT NULL AND claimed_at < ?")
      .run(cutoff);
    return Number(info.changes);
  }

  outboxPendingCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM outbox WHERE delivered_at IS NULL")
      .get() as { n: number };
    return row.n;
  }
}
