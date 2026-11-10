/**
 * FF-031 integration: bridge-owned correlation extras (SQLite WAL).
 *
 * The canonical E06 `AttemptStore` (`attempts.db`) is the authoritative
 * attempt/outbox ledger. This companion database holds strictly
 * bridge-level correlation state that the ledger does not model:
 *
 * - `attempt_index`: bridge-known (attempt_id -> project/task/worker,
 *   last known state, fencing epoch). Backs the sessions inventory and
 *   the ambiguous-history gate without a ledger scan API.
 * - `message_keys` / `messages`: send idempotency + queued records.
 * - `cancel_keys`: cancel idempotency bound per attempt.
 * - `event_log`: ordered, monotonically-id'd normalized event frames that
 *   back `GET /v1/events` resume (`Last-Event-ID`) and the adapter's
 *   `streamEvents` polling.
 *
 * Same durability discipline as the ledger (WAL, `synchronous=FULL`,
 * fail-closed when WAL is unavailable, ownership check on boot). It is
 * never a substitute for the attempt ledger: attempt fate is read from
 * `AttemptStore`, never from this mirror.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === "ERR_SQLITE_ERROR" &&
    /UNIQUE constraint failed/i.test(error.message)
  );
}

export interface ExtraMessageRecord {
  messageId: string;
  attemptId: string;
  projectId: string;
  threadId: string;
  actorId: string;
  body: string;
  kind: string;
  idempotencyKey: string;
  state: "queued";
  queuedAt: string;
}

export interface ExtraEventFrame {
  eventId: string;
  event: Record<string, unknown>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS attempt_index (
  attempt_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  paperclip_task_id TEXT NOT NULL,
  worker_kind TEXT NOT NULL,
  last_known_state TEXT NOT NULL,
  fencing_epoch INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  idempotency_key TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE,
  attempt_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL,
  queued_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cancel_keys (
  idempotency_key TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS event_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  event_json TEXT NOT NULL
);
`;

export class BridgeExtras {
  private db: DatabaseSync;
  private readonly dbPath: string | null;
  private eventSeq = 0;

  private constructor(db: DatabaseSync, dbPath: string | null) {
    this.db = db;
    this.dbPath = dbPath;
  }

  /**
   * Open (creating parent dirs) the extras database. Production passes a
   * real file; tests may use `:memory:` only with explicit `testMode`.
   */
  static open(dataDir: string, options: { testMode?: boolean } = {}): BridgeExtras {
    let dbPath: string | null;
    let db: DatabaseSync;
    if (options.testMode === true) {
      dbPath = null;
      db = new DatabaseSync(":memory:");
    } else {
      mkdirSync(dataDir, { recursive: true });
      dbPath = join(dataDir, "bridge-extras.db");
      db = new DatabaseSync(dbPath);
    }
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = FULL;");
    // Cross-process writers (two bridge processes, one extras file) must
    // wait out a sibling's brief write lock instead of failing with
    // SQLITE_BUSY. Mirrors the canonical ledger's own busy_timeout.
    db.exec("PRAGMA busy_timeout = 5000;");
    if (dbPath !== null) {
      const row = db.prepare("PRAGMA journal_mode;").get() as { journal_mode?: string } | undefined;
      if (row?.journal_mode !== "wal") {
        db.close();
        throw new Error(
          `refusing extras database without WAL journal mode (got ${row?.journal_mode ?? "unknown"})`,
        );
      }
    }
    db.exec(SCHEMA);
    const extras = new BridgeExtras(db, dbPath);
    const maxSeq = db.prepare("SELECT MAX(seq) AS m FROM event_log;").get() as { m: number | null } | undefined;
    extras.eventSeq = maxSeq?.m ?? 0;
    return extras;
  }

  /** Fail closed on unsafe database files (mirrors the ledger policy). */
  static assertSafeDbFile(stat: { uid: number; mode: number }, euid: number | undefined): void {
    if (euid !== undefined && stat.uid !== euid) {
      throw new Error(`refusing extras database owned by uid ${stat.uid} (process uid ${euid})`);
    }
    if ((stat.mode & 0o022) !== 0) {
      throw new Error("refusing group/world-writable extras database");
    }
  }

  assertOwnership(): void {
    if (this.dbPath === null) return;
    if (typeof process.geteuid !== "function") return;
    BridgeExtras.assertSafeDbFile(statSync(this.dbPath), process.geteuid());
  }

  close(): void {
    this.db.close();
  }

  get path(): string | null {
    return this.dbPath;
  }

  // -- attempt index (correlation mirror; fate stays in the ledger) --

  noteAttempt(input: {
    attemptId: string;
    projectId: string;
    paperclipTaskId: string;
    workerKind: string;
    state: string;
    fencingEpoch: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO attempt_index
           (attempt_id, project_id, paperclip_task_id, worker_kind, last_known_state, fencing_epoch, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(attempt_id) DO UPDATE SET
           last_known_state = excluded.last_known_state,
           fencing_epoch = excluded.fencing_epoch,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.attemptId,
        input.projectId,
        input.paperclipTaskId,
        input.workerKind,
        input.state,
        input.fencingEpoch,
        new Date().toISOString(),
      );
  }

  noteState(attemptId: string, state: string): void {
    this.db
      .prepare(`UPDATE attempt_index SET last_known_state = ?, updated_at = ? WHERE attempt_id = ?`)
      .run(state, new Date().toISOString(), attemptId);
  }

  indexedAttempts(): {
    attemptId: string;
    projectId: string;
    paperclipTaskId: string;
    workerKind: string;
    state: string;
    fencingEpoch: number;
  }[] {
    return (this.db.prepare(`SELECT * FROM attempt_index;`).all() as {
      attempt_id: string;
      project_id: string;
      paperclip_task_id: string;
      worker_kind: string;
      last_known_state: string;
      fencing_epoch: number;
    }[]).map((r) => ({
      attemptId: r.attempt_id,
      projectId: r.project_id,
      paperclipTaskId: r.paperclip_task_id,
      workerKind: r.worker_kind,
      state: r.last_known_state,
      fencingEpoch: r.fencing_epoch,
    }));
  }

  epochOf(attemptId: string): number | null {
    const row = this.db
      .prepare(`SELECT fencing_epoch FROM attempt_index WHERE attempt_id = ?`)
      .get(attemptId) as { fencing_epoch: number } | undefined;
    return row ? row.fencing_epoch : null;
  }

  /** True when any mirrored attempt sits in non-terminal `unknown`. */
  hasAmbiguousHistory(): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM attempt_index WHERE last_known_state = 'unknown' LIMIT 1`)
      .get() as unknown;
    return row !== undefined;
  }

  // -- messages --

  logMessage(input: {
    idempotencyKey: string;
    attemptId: string;
    projectId: string;
    threadId: string;
    actorId: string;
    body: string;
    kind: string;
  }): { record: ExtraMessageRecord; deduplicated: boolean } {
    const existing = this.db
      .prepare(`SELECT * FROM messages WHERE idempotency_key = ?`)
      .get(input.idempotencyKey) as
      | {
          message_id: string;
          attempt_id: string;
          project_id: string;
          thread_id: string;
          actor_id: string;
          body: string;
          kind: string;
          idempotency_key: string;
          queued_at: string;
        }
      | undefined;
    if (existing) {
      return {
        record: {
          messageId: existing.message_id,
          attemptId: existing.attempt_id,
          projectId: existing.project_id,
          threadId: existing.thread_id,
          actorId: existing.actor_id,
          body: existing.body,
          kind: existing.kind,
          idempotencyKey: existing.idempotency_key,
          state: "queued",
          queuedAt: existing.queued_at,
        },
        deduplicated: true,
      };
    }
    const record: ExtraMessageRecord = {
      messageId: randomUUID(),
      attemptId: input.attemptId,
      projectId: input.projectId,
      threadId: input.threadId,
      actorId: input.actorId,
      body: input.body,
      kind: input.kind,
      idempotencyKey: input.idempotencyKey,
      state: "queued",
      queuedAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO messages
           (idempotency_key, message_id, attempt_id, project_id, thread_id, actor_id, body, kind, queued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.idempotencyKey,
        record.messageId,
        record.attemptId,
        record.projectId,
        record.threadId,
        record.actorId,
        record.body,
        record.kind,
        record.queuedAt,
      );
    return { record: { ...record }, deduplicated: false };
  }

  // -- cancel keys --

  checkCancelKey(idempotencyKey: string, attemptId: string): "ok" | "replay" | "conflict" {
    const row = this.db
      .prepare(`SELECT attempt_id FROM cancel_keys WHERE idempotency_key = ?`)
      .get(idempotencyKey) as { attempt_id: string } | undefined;
    if (!row) return "ok";
    return row.attempt_id === attemptId ? "replay" : "conflict";
  }

  bindCancelKey(idempotencyKey: string, attemptId: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO cancel_keys (idempotency_key, attempt_id, created_at) VALUES (?, ?, ?)`,
      )
      .run(idempotencyKey, attemptId, new Date().toISOString());
  }

  // -- event log (SSE resume source) --

  appendEvent(
    eventType: string,
    data: Record<string, unknown>,
    ids: { attemptId?: string; projectId?: string; taskId?: string; fencingEpoch?: number },
  ): ExtraEventFrame {
    // Two bridge processes share one extras file but mint ids from
    // per-process counters, so concurrent appends can collide on
    // event_log.event_id. Re-sync the counter from the table and retry a
    // bounded number of times; each retry observes the winner's row, so
    // two writers always converge instead of 500ing the second POST.
    for (let attempt = 0; ; attempt++) {
      const maxRow = this.db.prepare(`SELECT MAX(seq) AS m FROM event_log;`).get() as
        | { m: number | null }
        | undefined;
      this.eventSeq = Math.max(this.eventSeq, maxRow?.m ?? 0) + 1;
      const eventId = `e${String(this.eventSeq).padStart(6, "0")}`;
      const now = new Date().toISOString();
      const event: Record<string, unknown> = {
        schemaVersion: "0.1",
        eventId,
        eventType,
        occurredAt: now,
        receivedAt: now,
        source: "orca-bridge",
        projectId: ids.projectId ?? "",
        taskId: ids.taskId ?? "",
        attemptId: ids.attemptId ?? "",
        correlationId: eventId,
        fencingEpoch: ids.fencingEpoch ?? 1,
        actor: { type: "service", id: "orca-bridge" },
        data: { ...data },
      };
      try {
        this.db
          .prepare(`INSERT INTO event_log (event_id, event_json) VALUES (?, ?)`)
          .run(eventId, JSON.stringify(event));
        return { eventId, event };
      } catch (error) {
        if (!isUniqueViolation(error) || attempt >= 9) throw error;
      }
    }
  }

  eventsSince(cursor: string | null): ExtraEventFrame[] {
    let rows: { event_id: string; event_json: string }[];
    if (!cursor) {
      rows = this.db.prepare(`SELECT event_id, event_json FROM event_log ORDER BY seq;`).all() as {
        event_id: string;
        event_json: string;
      }[];
    } else {
      const anchor = this.db.prepare(`SELECT seq FROM event_log WHERE event_id = ?`).get(cursor) as {
        seq: number;
      } | undefined;
      if (!anchor) {
        rows = this.db.prepare(`SELECT event_id, event_json FROM event_log ORDER BY seq;`).all() as {
          event_id: string;
          event_json: string;
        }[];
      } else {
        rows = this.db.prepare(
          `SELECT event_id, event_json FROM event_log WHERE seq > ? ORDER BY seq;`,
        ).all(anchor.seq) as { event_id: string; event_json: string }[];
      }
    }
    return rows.map((r) => ({ eventId: r.event_id, event: JSON.parse(r.event_json) as Record<string, unknown> }));
  }

  get lastEventId(): string | null {
    const row = this.db.prepare(`SELECT event_id FROM event_log ORDER BY seq DESC LIMIT 1`).get() as {
      event_id: string;
    } | undefined;
    return row ? row.event_id : null;
  }
}
