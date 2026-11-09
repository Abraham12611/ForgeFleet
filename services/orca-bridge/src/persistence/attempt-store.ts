/**
 * E06 — Durable attempt mapping and idempotency (FF-006).
 *
 * SQLite-backed store implementing the policy/state semantics required by
 * the frozen contract v0.1.0 (`packages/bridge-contracts`, PR #46):
 * idempotent `createAttempt`, transactional `(source, sourceEventId)`
 * receipts with an at-least-once outbox, and restart reconciliation that
 * adopts provable dispatches and never relaunches blindly.
 *
 * Durability design (answers coordinator review on PR #37):
 * - Every state prefix is committed to SQLite (WAL mode, `synchronous=FULL`)
 *   **before** the runtime launcher is invoked, so a crash between
 *   "Orca accepted" and "bridge persisted the reply" leaves a durable
 *   `accepted` row that restart reconciliation reattaches by
 *   `(paperclipTaskId, leaseToken)` instead of spawning a duplicate.
 * - `dispatch_requests.idempotency_key` is the PRIMARY KEY and
 *   `execution_attempts.orca_dispatch_id` is UNIQUE: concurrent duplicates
 *   collapse at the constraint level even across processes, and all
 *   check-then-insert sequences run inside `BEGIN IMMEDIATE` transactions.
 * - Receipts, attempt transitions and outbox enqueueing share one
 *   transaction: a receipt is never acknowledged without its outbox write.
 * - Restart = reopen the same database file. The integration tests prove
 *   this with real files: committed rows survive close/reopen, uncommitted
 *   transactions do not, and reconciliation reattaches without relaunch.
 *
 * Type shapes (`CreateAttemptRequest`, `AttemptReceipt`, `AttemptState`)
 * are imported from the frozen generated contract — this module adds no
 * competing field names. `AttemptReceipt` carries exactly the contract
 * fields (no `orcaSessionId`, no `deduplicated` flag); internal mapping
 * columns such as `orca_session_id` are persisted per the domain model but
 * never serialized into the API receipt.
 */

import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import type {
  AttemptReceipt,
  AttemptState,
  CreateAttemptRequest,
} from "../../../../packages/bridge-contracts/generated/bridge.types.ts";

/** Contract v0.1.0: `IdempotencyKey` is 8–160 chars with no charset rule. */
const IDEMPOTENCY_KEY_MIN = 8;
const IDEMPOTENCY_KEY_MAX = 160;

/** Non-terminal attempt states: the task lease is held. */
const ACTIVE_ATTEMPT_STATES: readonly AttemptState[] = [
  "accepted",
  "dispatching",
  "running",
  "waiting",
  "unknown",
];

/** Terminal attempt states: the lease is released. */
const TERMINAL_ATTEMPT_STATES: readonly AttemptState[] = [
  "finished",
  "failed",
  "cancelled",
];

/** Top-level `CreateAttemptRequest` fields per the normative API schema. */
const CREATE_REQUEST_FIELDS = [
  "projectId",
  "paperclipTaskId",
  "paperclipRunId",
  "workerKind",
  "taskTitle",
  "instruction",
  "contextManifestId",
  "repositoryId",
  "lease",
] as const;

export interface ExternalDispatchIds {
  orcaRunId?: string | null;
  orcaTaskId?: string | null;
  orcaDispatchId?: string | null;
  orcaSessionId?: string | null;
  worktreeId?: string | null;
}

export interface OutboxEntry {
  id: string;
  eventType: string;
  body: Record<string, unknown>;
  destination: string;
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  deliveredAt: string | null;
  deadLettered: boolean;
  deadLetterReason: string | null;
}

export interface ObservedDispatch {
  externalDispatchId: string;
  paperclipTaskId?: string;
  leaseToken?: string;
  state: "running" | "terminal";
}

export interface ReconcileReport {
  /** Attempts reattached to a provably still-running dispatch. */
  kept: string[];
  /** Attempts whose dispatch provably ended; lease released as failed. */
  releasedTerminal: string[];
  /** Ambiguous attempts: held as `unknown`, never retried without proof. */
  heldUnknown: string[];
  /** Observed dispatches matching no attempt: reported, never adopted. */
  orphans: string[];
  alreadyTerminal: string[];
}

export type StoreErrorCode =
  | "validation"
  | "idempotency_conflict"
  | "active_lease"
  | "unknown_attempt"
  | "stale_epoch"
  | "dispatch_unknown";

export class StoreError extends Error {
  readonly code: StoreErrorCode;
  /** HTTP status the bridge should surface for this failure. */
  readonly status: number;
  constructor(code: StoreErrorCode, status: number, message: string) {
    super(message);
    this.name = "StoreError";
    this.code = code;
    this.status = status;
  }
}

/** Result of the injected runtime launcher (owned by E03 in production). */
export interface DispatchResult {
  orcaRunId?: string | null;
  orcaTaskId?: string | null;
  orcaDispatchId?: string | null;
  orcaSessionId?: string | null;
  worktreeId?: string | null;
  /** State the runtime accepted the attempt into. */
  state: "dispatching" | "running";
}

export interface AttemptStoreOptions {
  /**
   * Explicit durable database file path. **Required in production**: the
   * constructor fails startup when no path is given. Crash durability
   * (close + reopen = process restart) only holds for real files.
   */
  path?: string;
  /**
   * Explicit test mode. The only way to use `":memory:"` (or omit `path`):
   * production code must never set this. `:memory:` databases have no
   * crash durability and no backup story.
   */
  testMode?: boolean;
  /** Milliseconds clock; inject a fake in tests. Defaults to Date.now. */
  now?: () => number;
  /**
   * Runtime launcher. Invoked at most once per accepted attempt: the
   * durable `accepted` row (plus idempotency row and outbox entry) and a
   * single-launch claim commit first, and concurrent duplicates replay the
   * committed row without reaching the launcher. A throw means unknown
   * fate (the bridge may have died mid-dispatch): the `accepted` prefix
   * stays durable and the error propagates, so a same-key retry replays
   * without relaunching until reconciliation resolves the fate.
   */
  dispatch?: (attempt: {
    attemptId: string;
    projectId: string;
    paperclipTaskId: string;
  }) => Promise<DispatchResult>;
  maxOutboxAttempts?: number;
  outboxBaseDelayMs?: number;
  outboxMaxDelayMs?: number;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(",")}}}`;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isActive(state: AttemptState): boolean {
  return (ACTIVE_ATTEMPT_STATES as readonly string[]).includes(state);
}

function isConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === "ERR_SQLITE_ERROR" &&
    /UNIQUE constraint failed|PRIMARY KEY must be unique/i.test(error.message)
  );
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS execution_attempts (
  attempt_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  paperclip_task_id TEXT NOT NULL,
  paperclip_run_id TEXT NOT NULL,
  worker_kind TEXT NOT NULL,
  task_title TEXT,
  instruction TEXT,
  context_manifest_id TEXT NOT NULL,
  repository_id TEXT,
  fencing_epoch INTEGER NOT NULL,
  lease_token TEXT NOT NULL,
  launch_claimed INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  orca_run_id TEXT,
  orca_task_id TEXT,
  orca_dispatch_id TEXT UNIQUE,
  orca_session_id TEXT,
  worktree_id TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_task
  ON execution_attempts(project_id, paperclip_task_id);
CREATE TABLE IF NOT EXISTS dispatch_requests (
  idempotency_key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES execution_attempts(attempt_id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runtime_event_receipts (
  source TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (source, source_event_id)
);
CREATE TABLE IF NOT EXISTS outbound_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  body TEXT NOT NULL,
  destination TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  delivered_at TEXT,
  dead_lettered INTEGER NOT NULL DEFAULT 0,
  dead_letter_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_due
  ON outbound_events(delivered_at, dead_lettered, next_attempt_at);
`;

interface AttemptRow {
  attempt_id: string;
  project_id: string;
  paperclip_task_id: string;
  paperclip_run_id: string;
  worker_kind: string;
  task_title: string | null;
  instruction: string | null;
  context_manifest_id: string;
  repository_id: string | null;
  fencing_epoch: number;
  lease_token: string;
  launch_claimed: number;
  state: AttemptState;
  orca_run_id: string | null;
  orca_task_id: string | null;
  orca_dispatch_id: string | null;
  orca_session_id: string | null;
  worktree_id: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Minimal stat shape for the database-file ownership check (kept narrow so
 * tests can exercise the policy with fabricated stats and production passes
 * the real `fs.statSync` result).
 */
export interface DbFileStat {
  uid: number;
  mode: number;
}

/**
 * Fail closed on unsafe database files: the file must be owned by the
 * bridge's own uid and must not be group/world-writable. Pure function so
 * the policy itself is unit-testable.
 */
export function assertSafeDbFile(
  stat: DbFileStat,
  euid: number | undefined,
): void {
  if (euid !== undefined && stat.uid !== euid) {
    throw new StoreError(
      "validation",
      500,
      `refusing database file owned by uid ${stat.uid} (process uid ${euid})`,
    );
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new StoreError(
      "validation",
      500,
      "refusing group/world-writable database file",
    );
  }
}

export class AttemptStore {
  private db: DatabaseSync;
  private readonly dbPath: string | null;
  private readonly clock: () => number;
  private readonly launcher: (
    attempt: { attemptId: string; projectId: string; paperclipTaskId: string },
  ) => Promise<DispatchResult>;
  private readonly maxOutboxAttempts: number;
  private readonly outboxBaseDelayMs: number;
  private readonly outboxMaxDelayMs: number;

  constructor(options: AttemptStoreOptions = {}) {
    const testMode = options.testMode ?? false;
    if (options.path === undefined && !testMode) {
      throw new StoreError(
        "validation",
        500,
        "AttemptStore requires an explicit durable database file path; pass testMode:true only for :memory: unit tests",
      );
    }
    if (options.path === ":memory:" && !testMode) {
      throw new StoreError(
        "validation",
        500,
        '":memory:" databases have no crash durability; pass an explicit file path (testMode:true reserves :memory: for unit tests)',
      );
    }
    const resolved = options.path ?? ":memory:";
    this.dbPath = resolved === ":memory:" ? null : resolved;
    if (this.dbPath !== null) {
      const parent = dirname(this.dbPath);
      if (!existsSync(parent)) {
        throw new StoreError(
          "validation",
          500,
          `database directory does not exist: ${parent} (refusing to auto-create storage)`,
        );
      }
      if (existsSync(this.dbPath)) {
        const stat = statSync(this.dbPath);
        assertSafeDbFile(
          stat,
          typeof process.getuid === "function" ? process.getuid() : undefined,
        );
      }
    }
    this.db = new DatabaseSync(resolved);
    this.applyPragmas();
    this.db.exec(SCHEMA);
    this.clock = options.now ?? (() => Date.now());
    this.launcher =
      options.dispatch ??
      (async () => ({ state: "dispatching" as const }));
    this.maxOutboxAttempts = options.maxOutboxAttempts ?? 10;
    this.outboxBaseDelayMs = options.outboxBaseDelayMs ?? 1000;
    this.outboxMaxDelayMs = options.outboxMaxDelayMs ?? 5 * 60 * 1000;
  }

  /** Enforce WAL + FULL synchronous; fail startup when WAL is unavailable. */
  private applyPragmas(): void {
    if (this.dbPath === null) return; // :memory: has no WAL; test-only.
    this.db.exec("PRAGMA journal_mode = WAL;");
    const row = this.db
      .prepare("PRAGMA journal_mode")
      .get() as { journal_mode: string } | undefined;
    if (row?.journal_mode !== "wal") {
      throw new StoreError(
        "validation",
        500,
        `database filesystem does not support WAL journal mode (got ${row?.journal_mode ?? "unknown"})`,
      );
    }
    this.db.exec("PRAGMA synchronous = FULL;");
    // Multi-process bridge: wait on transient write locks instead of
    // failing fast (single-process callers never notice this).
    this.db.exec("PRAGMA busy_timeout = 5000;");
  }

  /** Release the database handle. Reopen the same path to simulate restart. */
  close(): void {
    this.db.close();
  }

  /** File path of this store, or null for `:memory:` test databases. */
  databasePath(): string | null {
    return this.dbPath;
  }

  /**
   * Checkpoint the WAL and copy the database file to `backupPath`.
   * File-backed stores only; `:memory:` test databases cannot be backed up.
   */
  createBackup(backupPath: string): void {
    if (this.dbPath === null) {
      throw new StoreError(
        "validation",
        500,
        "cannot back up a :memory: test database",
      );
    }
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    copyFileSync(this.dbPath, backupPath);
  }

  /**
   * Restore this store's file from a backup created by `createBackup` and
   * reopen it (replaying any WAL, re-verifying journal mode). The store
   * must be file-backed; callers must re-run reconciliation after restore
   * because the runtime may have moved on while the backup aged.
   */
  restoreFromBackup(backupPath: string): void {
    if (this.dbPath === null) {
      throw new StoreError(
        "validation",
        500,
        "cannot restore a :memory: test database",
      );
    }
    this.db.close();
    copyFileSync(backupPath, this.dbPath);
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${this.dbPath}${suffix}`;
      if (existsSync(sidecar)) unlinkSync(sidecar);
    }
    this.db = new DatabaseSync(this.dbPath);
    this.applyPragmas();
    this.db.exec(SCHEMA);
  }

  private isoNow(): string {
    return new Date(this.clock()).toISOString();
  }

  /** Run `fn` inside `BEGIN IMMEDIATE … COMMIT` (rollback on throw). */
  private transact<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn();
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        // Already rolled back by SQLite on constraint failure; ignore.
      }
      throw error;
    }
  }

  private enqueueOutbound(
    eventType: string,
    body: Record<string, unknown>,
    destination: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO outbound_events
           (id, event_type, body, destination, attempts, next_attempt_at)
         VALUES (?, ?, ?, ?, 0, ?)`,
      )
      .run(
        randomUUID(),
        eventType,
        JSON.stringify(body),
        destination,
        this.isoNow(),
      );
  }

  private rowToReceipt(row: AttemptRow): AttemptReceipt {
    return {
      attemptId: row.attempt_id,
      projectId: row.project_id,
      state: row.state,
      observedAt: this.isoNow(),
      orcaRunId: row.orca_run_id,
      orcaTaskId: row.orca_task_id,
      orcaDispatchId: row.orca_dispatch_id,
      worktreeId: row.worktree_id,
      errorCode: row.error_code,
    };
  }

  private getAttemptRow(attemptId: string): AttemptRow | undefined {
    return this.db
      .prepare(`SELECT * FROM execution_attempts WHERE attempt_id = ?`)
      .get(attemptId) as AttemptRow | undefined;
  }

  private activeAttemptRow(
    projectId: string,
    paperclipTaskId: string,
  ): AttemptRow | undefined {
    const rows = this.db
      .prepare(
        `SELECT * FROM execution_attempts
         WHERE project_id = ? AND paperclip_task_id = ?
         ORDER BY fencing_epoch DESC`,
      )
      .all(projectId, paperclipTaskId) as unknown as AttemptRow[];
    return rows.find((r) => isActive(r.state));
  }

  private maxEpochFor(projectId: string, paperclipTaskId: string): number {
    const row = this.db
      .prepare(
        `SELECT MAX(fencing_epoch) AS m FROM execution_attempts
         WHERE project_id = ? AND paperclip_task_id = ?`,
      )
      .get(projectId, paperclipTaskId) as { m: number | null };
    return row.m ?? 0;
  }

  private validateCreateInput(
    idempotencyKey: string,
    request: CreateAttemptRequest,
  ): string[] {
    const errors: string[] = [];
    if (
      typeof idempotencyKey !== "string" ||
      idempotencyKey.length < IDEMPOTENCY_KEY_MIN ||
      idempotencyKey.length > IDEMPOTENCY_KEY_MAX
    ) {
      errors.push(
        `Idempotency-Key must be ${IDEMPOTENCY_KEY_MIN}-${IDEMPOTENCY_KEY_MAX} characters (contract v0.1.0)`,
      );
    }
    const unknown = Object.keys(request).filter(
      (k) => !(CREATE_REQUEST_FIELDS as readonly string[]).includes(k),
    );
    if (unknown.length > 0) {
      errors.push(
        `unknown request fields rejected by contract v0.1.0: ${unknown.join(", ")}`,
      );
    }
    for (const field of [
      "projectId",
      "paperclipTaskId",
      "paperclipRunId",
      "workerKind",
      "contextManifestId",
    ] as const) {
      if (!request[field]) errors.push(`${field} is required`);
    }
    const lease = request.lease;
    if (
      !lease ||
      !Number.isInteger(lease.fencingEpoch) ||
      lease.fencingEpoch < 1
    ) {
      errors.push("lease.fencingEpoch must be an integer >= 1");
    }
    if (!lease || !lease.leaseToken) {
      errors.push("lease.leaseToken is required");
    }
    return errors;
  }

  /**
   * Create (or replay) an attempt. The durable prefix — attempt row,
   * idempotency row and `attempt.accepted` outbox entry — commits first;
   * then exactly one caller wins the single-launch claim and invokes the
   * runtime launcher. Concurrent duplicates with the same key and payload
   * replay one attempt and launch at most once; the same key with a
   * different payload fails 409 with no side effect; a held task lease
   * fails 409 without dispatching. A launcher throw propagates as 502
   * `dispatch_unknown` with the `accepted` prefix left durable — never a
   * silent second launch.
   */
  async createAttempt(
    idempotencyKey: string,
    request: CreateAttemptRequest,
  ): Promise<{ receipt: AttemptReceipt; deduplicated: boolean }> {
    const errors = this.validateCreateInput(idempotencyKey, request);
    if (errors.length > 0) {
      throw new StoreError("validation", 422, errors.join("; "));
    }
    const requestHash = sha256Hex(stableStringify(request));

    const prefix = this.transact(() => {
      const existing = this.db
        .prepare(`SELECT request_hash, attempt_id FROM dispatch_requests WHERE idempotency_key = ?`)
        .get(idempotencyKey) as
        | { request_hash: string; attempt_id: string }
        | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new StoreError(
            "idempotency_conflict",
            409,
            "Idempotency-Key was already used with a different payload",
          );
        }
        const attempt = this.getAttemptRow(existing.attempt_id);
        if (!attempt) {
          throw new StoreError(
            "unknown_attempt",
            404,
            "idempotency record points at a missing attempt",
          );
        }
        return { attemptId: attempt.attempt_id, created: false as const };
      }

      const holder = this.activeAttemptRow(
        request.projectId,
        request.paperclipTaskId,
      );
      if (holder) {
        throw new StoreError(
          "active_lease",
          409,
          `task already has active attempt ${holder.attempt_id} in state ${holder.state}`,
        );
      }
      if (
        request.lease.fencingEpoch <=
        this.maxEpochFor(request.projectId, request.paperclipTaskId)
      ) {
        throw new StoreError(
          "stale_epoch",
          409,
          "lease.fencingEpoch must exceed every prior attempt generation for this task",
        );
      }

      const now = this.isoNow();
      const attemptId = randomUUID();
      try {
        this.db
          .prepare(
            `INSERT INTO execution_attempts
               (attempt_id, project_id, paperclip_task_id, paperclip_run_id,
                worker_kind, task_title, instruction, context_manifest_id,
                repository_id, fencing_epoch, lease_token, state,
                created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?)`,
          )
          .run(
            attemptId,
            request.projectId,
            request.paperclipTaskId,
            request.paperclipRunId,
            request.workerKind,
            request.taskTitle ?? null,
            request.instruction ?? null,
            request.contextManifestId,
            request.repositoryId ?? null,
            request.lease.fencingEpoch,
            request.lease.leaseToken,
            now,
            now,
          );
        this.db
          .prepare(
            `INSERT INTO dispatch_requests
               (idempotency_key, request_hash, attempt_id, created_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(idempotencyKey, requestHash, attemptId, now);
      } catch (error) {
        if (isConstraintError(error)) {
          // Lost a cross-process race on the UNIQUE key: re-read and replay.
          const winner = this.db
            .prepare(`SELECT request_hash, attempt_id FROM dispatch_requests WHERE idempotency_key = ?`)
            .get(idempotencyKey) as
            | { request_hash: string; attempt_id: string }
            | undefined;
          if (winner && winner.request_hash === requestHash) {
            return { attemptId: winner.attempt_id, created: false as const };
          }
          throw new StoreError(
            "idempotency_conflict",
            409,
            "Idempotency-Key was already used with a different payload",
          );
        }
        throw error;
      }
      this.enqueueOutbound(
        "attempt.accepted",
        { attemptId, paperclipTaskId: request.paperclipTaskId },
        "paperclip-adapter",
      );
      return { attemptId, created: true as const };
    });

    // Single-launch claim: exactly one caller (even across processes) wins
    // the right to invoke the runtime launcher for this attempt. Losers
    // replay the durable row. The claim commits before the launcher runs,
    // so a crash after the claim leaves an `accepted`, claimed row that
    // restart reconciliation reattaches instead of relaunching.
    const claimed = this.transact(() => {
      const result = this.db
        .prepare(
          `UPDATE execution_attempts
           SET launch_claimed = 1 WHERE attempt_id = ? AND launch_claimed = 0`,
        )
        .run(prefix.attemptId);
      return Number(result.changes) === 1;
    });
    if (!claimed) {
      const attempt = this.getAttemptRow(prefix.attemptId);
      if (!attempt) {
        throw new StoreError(
          "unknown_attempt",
          404,
          "idempotency record points at a missing attempt",
        );
      }
      return { receipt: this.rowToReceipt(attempt), deduplicated: true };
    }

    let launched: DispatchResult;
    try {
      launched = await this.launcher({
        attemptId: prefix.attemptId,
        projectId: request.projectId,
        paperclipTaskId: request.paperclipTaskId,
      });
    } catch (error) {
      // Fate unknown (bridge may have died mid-dispatch): the durable
      // `accepted` prefix stays, the caller sees 502, and a same-key retry
      // replays without relaunching until reconciliation resolves the fate.
      throw new StoreError(
        "dispatch_unknown",
        502,
        `launcher fate unknown for attempt ${prefix.attemptId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const updated = this.transact(() => {
      this.db
        .prepare(
          `UPDATE execution_attempts
           SET orca_run_id = ?, orca_task_id = ?, orca_dispatch_id = ?,
               orca_session_id = ?, worktree_id = ?, state = ?, updated_at = ?
           WHERE attempt_id = ?`,
        )
        .run(
          launched.orcaRunId ?? null,
          launched.orcaTaskId ?? null,
          launched.orcaDispatchId ?? null,
          launched.orcaSessionId ?? null,
          launched.worktreeId ?? null,
          launched.state,
          this.isoNow(),
          prefix.attemptId,
        );
      return this.getAttemptRow(prefix.attemptId);
    });
    if (!updated) {
      throw new StoreError("unknown_attempt", 404, "attempt vanished");
    }
    return { receipt: this.rowToReceipt(updated), deduplicated: !prefix.created };
  }

  /** Read an attempt as an API receipt. */
  getAttempt(attemptId: string): AttemptReceipt {
    const attempt = this.getAttemptRow(attemptId);
    if (!attempt) {
      throw new StoreError(
        "unknown_attempt",
        404,
        `unknown attempt ${attemptId}`,
      );
    }
    return this.rowToReceipt(attempt);
  }

  /** True when no non-terminal attempt holds the task lease. */
  canDispatch(projectId: string, paperclipTaskId: string): boolean {
    return (
      this.activeAttemptRow(projectId, paperclipTaskId) === undefined
    );
  }

  /**
   * Persist the runtime's accepted-launch reply. This is the write a crash
   * between dispatch and persistence would skip; reconciliation later
   * re-derives it from observed runtime inventory instead of relaunching.
   */
  recordExternalDispatch(
    attemptId: string,
    ids: ExternalDispatchIds,
  ): AttemptReceipt {
    const updated = this.transact(() => {
      const attempt = this.getAttemptRow(attemptId);
      if (!attempt) {
        throw new StoreError(
          "unknown_attempt",
          404,
          `unknown attempt ${attemptId}`,
        );
      }
      this.db
        .prepare(
          `UPDATE execution_attempts
           SET orca_run_id = COALESCE(?, orca_run_id),
               orca_task_id = COALESCE(?, orca_task_id),
               orca_dispatch_id = COALESCE(?, orca_dispatch_id),
               orca_session_id = COALESCE(?, orca_session_id),
               worktree_id = COALESCE(?, worktree_id),
               state = CASE WHEN state IN ('accepted') THEN 'dispatching' ELSE state END,
               updated_at = ?
           WHERE attempt_id = ?`,
        )
        .run(
          ids.orcaRunId ?? null,
          ids.orcaTaskId ?? null,
          ids.orcaDispatchId ?? null,
          ids.orcaSessionId ?? null,
          ids.worktreeId ?? null,
          this.isoNow(),
          attemptId,
        );
      return this.getAttemptRow(attemptId);
    });
    if (!updated) {
      throw new StoreError("unknown_attempt", 404, `unknown attempt ${attemptId}`);
    }
    return this.rowToReceipt(updated);
  }

  /**
   * Apply one runtime event transactionally: dedupe by
   * `(source, sourceEventId)`, enforce fencing, advance attempt state and
   * enqueue the normalized outbound event — all in one `BEGIN IMMEDIATE`
   * transaction, so a receipt is never acknowledged without its outbox
   * write.
   */
  applyRuntimeEvent(input: {
    source: string;
    sourceEventId: string;
    payload: Record<string, unknown>;
    attemptId: string;
    eventType: string;
    fencingEpoch: number;
  }): { deduplicated: boolean; applied: boolean; reason: string } {
    const payloadSha = sha256Hex(stableStringify(input.payload));
    return this.transact(() => {
      let duplicate = false;
      try {
        this.db
          .prepare(
            `INSERT INTO runtime_event_receipts
               (source, source_event_id, payload_sha256, received_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(input.source, input.sourceEventId, payloadSha, this.isoNow());
      } catch (error) {
        if (isConstraintError(error)) duplicate = true;
        else throw error;
      }
      if (duplicate) {
        return { deduplicated: true, applied: false, reason: "duplicate receipt" };
      }
      const attempt = this.getAttemptRow(input.attemptId);
      if (!attempt) {
        throw new StoreError(
          "unknown_attempt",
          404,
          `unknown attempt ${input.attemptId}`,
        );
      }
      if (input.fencingEpoch < attempt.fencing_epoch) {
        return {
          deduplicated: false,
          applied: false,
          reason: "stale fencing epoch",
        };
      }
      const next = nextStateForEvent(attempt.state, input.eventType);
      if (next === null) {
        return {
          deduplicated: false,
          applied: false,
          reason: "no transition for event in current state",
        };
      }
      if (next !== attempt.state) {
        this.db
          .prepare(
            `UPDATE execution_attempts SET state = ?, updated_at = ? WHERE attempt_id = ?`,
          )
          .run(next, this.isoNow(), input.attemptId);
      }
      this.enqueueOutbound(
        input.eventType,
        { ...input.payload },
        "paperclip-adapter",
      );
      return { deduplicated: false, applied: true, reason: "applied" };
    });
  }

  /** Mark telemetry-loss: running/dispatching attempts become `unknown`. */
  markUnknown(attemptId: string): AttemptReceipt {
    const updated = this.transact(() => {
      const attempt = this.getAttemptRow(attemptId);
      if (!attempt) {
        throw new StoreError(
          "unknown_attempt",
          404,
          `unknown attempt ${attemptId}`,
        );
      }
      if (attempt.state === "dispatching" || attempt.state === "running") {
        this.db
          .prepare(
            `UPDATE execution_attempts SET state = 'unknown', updated_at = ? WHERE attempt_id = ?`,
          )
          .run(this.isoNow(), attemptId);
        this.enqueueOutbound(
          "attempt.unknown",
          { attemptId, fencingEpoch: attempt.fencing_epoch },
          "paperclip-adapter",
        );
      }
      return this.getAttemptRow(attemptId);
    });
    if (!updated) {
      throw new StoreError("unknown_attempt", 404, `unknown attempt ${attemptId}`);
    }
    return this.rowToReceipt(updated);
  }

  /**
   * Record proof the original runtime process is definitively gone
   * (read-only discovery + external ID match per F05). Only after this
   * may a fenced replacement attempt be created — never on `unknown`
   * alone.
   */
  confirmTermination(
    attemptId: string,
    outcome: "failed" | "cancelled",
    evidence: string,
  ): AttemptReceipt {
    if (!evidence) {
      throw new StoreError("validation", 422, "termination evidence is required");
    }
    const updated = this.transact(() => {
      const attempt = this.getAttemptRow(attemptId);
      if (!attempt) {
        throw new StoreError(
          "unknown_attempt",
          404,
          `unknown attempt ${attemptId}`,
        );
      }
      if (!isActive(attempt.state)) {
        throw new StoreError(
          "validation",
          422,
          `attempt ${attemptId} is already terminal (${attempt.state})`,
        );
      }
      this.db
        .prepare(
          `UPDATE execution_attempts
           SET state = ?, error_code = 'original_terminated', updated_at = ?
           WHERE attempt_id = ?`,
        )
        .run(outcome, this.isoNow(), attemptId);
      this.enqueueOutbound(
        outcome === "failed" ? "attempt.failed" : "attempt.cancelled",
        { attemptId, evidence },
        "paperclip-adapter",
      );
      return this.getAttemptRow(attemptId);
    });
    if (!updated) {
      throw new StoreError("unknown_attempt", 404, `unknown attempt ${attemptId}`);
    }
    return this.rowToReceipt(updated);
  }

  /**
   * Boot reconciliation over a read-only runtime inventory. Every active
   * attempt is categorized like the scheduler's `reconcile()`:
   * provably-running dispatches are kept (reattached, adopting a
   * late-observed external ID when the accepted-launch reply was never
   * persisted); provably-ended dispatches release the lease as failed;
   * everything ambiguous is held `unknown`; observed dispatches matching
   * no attempt are reported as orphans and never adopted. Nothing here
   * relaunches — a retry requires a new idempotency key, a higher fencing
   * epoch, and prior `confirmTermination` proof.
   */
  reconcileAfterRestart(observed: ObservedDispatch[]): ReconcileReport {
    return this.transact(() => {
      const report: ReconcileReport = {
        kept: [],
        releasedTerminal: [],
        heldUnknown: [],
        orphans: [],
        alreadyTerminal: [],
      };
      const matched = new Set<string>();
      const rows = this.db
        .prepare(`SELECT * FROM execution_attempts`)
        .all() as unknown as AttemptRow[];
      for (const attempt of rows) {
        if (!isActive(attempt.state)) {
          report.alreadyTerminal.push(attempt.attempt_id);
          continue;
        }
        const direct =
          attempt.orca_dispatch_id != null
            ? observed.find(
                (o) => o.externalDispatchId === attempt.orca_dispatch_id,
              )
            : undefined;
        if (direct) {
          matched.add(direct.externalDispatchId);
          if (direct.state === "running") {
            this.setState(attempt.attempt_id, "running");
            report.kept.push(attempt.attempt_id);
            continue;
          }
          this.setState(attempt.attempt_id, "failed", "runtime_reported_terminal");
          this.enqueueOutbound(
            "attempt.failed",
            {
              attemptId: attempt.attempt_id,
              errorCode: "runtime_reported_terminal",
            },
            "paperclip-adapter",
          );
          report.releasedTerminal.push(attempt.attempt_id);
          continue;
        }
        if (attempt.orca_dispatch_id == null) {
          const inferred = observed.find(
            (o) =>
              o.state === "running" &&
              o.paperclipTaskId === attempt.paperclip_task_id &&
              o.leaseToken === attempt.lease_token,
          );
          if (inferred) {
            matched.add(inferred.externalDispatchId);
            this.db
              .prepare(
                `UPDATE execution_attempts
                 SET orca_dispatch_id = ?, state = 'running', updated_at = ?
                 WHERE attempt_id = ?`,
              )
              .run(inferred.externalDispatchId, this.isoNow(), attempt.attempt_id);
            report.kept.push(attempt.attempt_id);
            continue;
          }
        }
        if (attempt.state !== "unknown") {
          this.setState(attempt.attempt_id, "unknown");
        }
        report.heldUnknown.push(attempt.attempt_id);
      }
      for (const o of observed) {
        if (!matched.has(o.externalDispatchId)) {
          const known = rows.some((r) => r.orca_dispatch_id === o.externalDispatchId);
          if (!known) report.orphans.push(o.externalDispatchId);
        }
      }
      return report;
    });
  }

  private setState(
    attemptId: string,
    state: AttemptState,
    errorCode?: string,
  ): void {
    this.db
      .prepare(
        `UPDATE execution_attempts
         SET state = ?, error_code = COALESCE(?, error_code), updated_at = ?
         WHERE attempt_id = ?`,
      )
      .run(state, errorCode ?? null, this.isoNow(), attemptId);
  }

  /** Claim due, undelivered, non-dead-letter entries for one delivery pass. */
  claimDueOutbound(limit = 50): OutboxEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM outbound_events
         WHERE dead_lettered = 0 AND delivered_at IS NULL AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC LIMIT ?`,
      )
      .all(this.isoNow(), limit) as Record<string, unknown>[];
    return rows.map(toOutboxEntry);
  }

  markDelivered(entryId: string): void {
    this.db
      .prepare(
        `UPDATE outbound_events SET delivered_at = ?
         WHERE id = ? AND delivered_at IS NULL AND dead_lettered = 0`,
      )
      .run(this.isoNow(), entryId);
  }

  /**
   * Record a failed delivery attempt with exponential backoff; exhausting
   * `maxOutboxAttempts` dead-letters the entry with a human-visible reason.
   */
  markDeliveryFailed(entryId: string, error: string): void {
    this.transact(() => {
      const row = this.db
        .prepare(`SELECT * FROM outbound_events WHERE id = ?`)
        .get(entryId) as Record<string, unknown> | undefined;
      if (!row || row["delivered_at"] !== null || row["dead_lettered"] !== 0) {
        return;
      }
      const attempts = (row["attempts"] as number) + 1;
      if (attempts >= this.maxOutboxAttempts) {
        this.db
          .prepare(
            `UPDATE outbound_events
             SET attempts = ?, last_error = ?, dead_lettered = 1, dead_letter_reason = ?
             WHERE id = ?`,
          )
          .run(
            attempts,
            error,
            `gave up after ${attempts} attempts: ${error}`,
            entryId,
          );
        return;
      }
      const delay = Math.min(
        this.outboxBaseDelayMs * 2 ** (attempts - 1),
        this.outboxMaxDelayMs,
      );
      this.db
        .prepare(
          `UPDATE outbound_events
           SET attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?`,
        )
        .run(
          attempts,
          error,
          new Date(this.clock() + delay).toISOString(),
          entryId,
        );
    });
  }

  listDeadLetter(): OutboxEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM outbound_events WHERE dead_lettered = 1`)
      .all() as Record<string, unknown>[];
    return rows.map(toOutboxEntry);
  }

  /** Test/ops introspection: pending (undelivered, non-dead-letter) count. */
  pendingOutboundCount(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM outbound_events
         WHERE delivered_at IS NULL AND dead_lettered = 0`,
      )
      .get() as { n: number };
    return row.n;
  }
}

function toOutboxEntry(row: Record<string, unknown>): OutboxEntry {
  return {
    id: row["id"] as string,
    eventType: row["event_type"] as string,
    body: JSON.parse(row["body"] as string) as Record<string, unknown>,
    destination: row["destination"] as string,
    attempts: row["attempts"] as number,
    nextAttemptAt: row["next_attempt_at"] as string,
    lastError: row["last_error"] as string | null,
    deliveredAt: row["delivered_at"] as string | null,
    deadLettered: (row["dead_lettered"] as number) !== 0,
    deadLetterReason: row["dead_letter_reason"] as string | null,
  };
}

function nextStateForEvent(
  current: AttemptState,
  eventType: string,
): AttemptState | null {
  switch (eventType) {
    case "attempt.heartbeat":
      return current === "dispatching" || current === "running" ? current : null;
    case "attempt.started":
      return current === "accepted" || current === "dispatching" ||
          current === "unknown"
        ? "running"
        : null;
    case "attempt.question":
      return current === "running" ? current : null;
    case "attempt.finished":
      return isActive(current) ? "finished" : null;
    case "attempt.failed":
      return isActive(current) ? "failed" : null;
    case "attempt.cancelled":
      return isActive(current) ? "cancelled" : null;
    case "attempt.unknown":
      return current === "dispatching" || current === "running"
        ? "unknown"
        : null;
    default:
      return null;
  }
}

export type { AttemptReceipt, AttemptState, CreateAttemptRequest };
