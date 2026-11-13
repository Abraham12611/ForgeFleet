/**
 * Durable reservation store (FF-020, FR-10 "Cost ledger").
 *
 * The in-memory CostLedger gate is atomic within one process (synchronous
 * methods). Across processes and restarts, atomicity and durability come
 * from this module: every admission runs inside one SQLite transaction
 * (`BEGIN IMMEDIATE` ... `COMMIT`) against a file-backed database, so two
 * OS processes cannot admit against the same headroom.
 *
 * Why SQLite instead of a JSONL journal + mkdir lock:
 * - Locking: `BEGIN IMMEDIATE` serializes writers across processes in the
 *   OS / SQLite layer. There is no timestamp-based stale lock to steal: a
 *   second process waits on `busy_timeout` while the holder is LIVE and
 *   never breaks in. A crashed holder's transaction is rolled back by
 *   SQLite on the next open (rollback journal), so crash residue needs no
 *   PID-liveness heuristics.
 * - Durability: `COMMIT` on a file-backed database fsyncs before it
 *   returns. `allowed: true` is only returned AFTER the hold's `COMMIT`
 *   succeeds, so a crash/power loss cannot destroy an admitted reservation.
 * - Integrity: a missing store file means genuinely new state (empty);
 *   anything else that cannot be opened, read, or schema-validated
 *   (EACCES, I/O error, garbage bytes, invalid rows) FAILS CLOSED: the
 *   admission is denied as data, never admitted against zero headroom.
 *
 * Owner provenance: every durable admission requires an explicit
 * `ownerIdentity`. Holds are recorded under that identity, and an
 * unknown-spend `ownerPolicy` is honored only when its `authorizedBy`
 * matches the gate's `ownerIdentity`. The caller is the trusted backend
 * policy boundary; this module never invents a default owner.
 *
 * Only erasable TypeScript is used (no enums, namespaces or parameter
 * properties) so the file also runs under Node type stripping.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CostLedger, isValidMoney } from "./cost.ts";
import type {
  BudgetCheckArgs,
  CheckAndReserveResult,
  CostEntry,
  OwnerQuotaPolicy,
  Reservation,
  UnknownSpendPolicy,
} from "./cost.ts";

/** Reservation table DDL, exported so cross-process test helpers open the same schema. */
export const RESERVATIONS_SCHEMA = `CREATE TABLE IF NOT EXISTS reservations(
  reservation_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT,
  provider TEXT,
  amount_usd REAL NOT NULL,
  authorized_by TEXT NOT NULL,
  created_at TEXT NOT NULL
)`;

/** Fail-closed store failure. Denied admissions carry this message; they never admit. */
export class JournalStoreError extends Error {
  readonly code: "JOURNAL_UNREADABLE" | "JOURNAL_CORRUPT" | "JOURNAL_BUSY";
  constructor(code: JournalStoreError["code"], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "JournalStoreError";
    this.code = code;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] : String(error);
}

function isBusyError(error: unknown): boolean {
  const message = describeError(error).toLowerCase();
  return (
    message.includes("database is locked") ||
    message.includes("database table is locked") ||
    message.includes("database is busy")
  );
}

/**
 * Opens (creating parent dirs) and schema-validates the store. Throws
 * JournalStoreError when the store cannot be opened or is not a valid
 * reservation database. A missing file is NOT an error here: callers
 * decide whether creation is allowed (fresh state) or must fail closed.
 */
function openStore(dbPath: string, busyTimeoutMs: number): DatabaseSync {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath);
  } catch (error) {
    throw new JournalStoreError(
      "JOURNAL_UNREADABLE",
      `denied: reservation store at ${dbPath} cannot be opened (${describeError(error)}); refusing to admit against unknown headroom`,
      { cause: error },
    );
  }
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
    db.exec(RESERVATIONS_SCHEMA);
  } catch (error) {
    try {
      db.close();
    } catch {
      // Best effort; the open already failed validation.
    }
    if (isBusyError(error)) {
      throw new JournalStoreError(
        "JOURNAL_BUSY",
        `denied: reservation store at ${dbPath} is held by a live admission (${describeError(error)}); retry after it settles`,
        { cause: error },
      );
    }
    throw new JournalStoreError(
      "JOURNAL_CORRUPT",
      `denied: reservation store at ${dbPath} is corrupt or has an unexpected schema (${describeError(error)}); no admission until repaired`,
      { cause: error },
    );
  }
  return db;
}

function closeQuietly(db: DatabaseSync): void {
  try {
    db.close();
  } catch {
    // Best effort on a failing path.
  }
}

interface ReservationRow {
  reservation_id: unknown;
  project_id: unknown;
  task_id: unknown;
  provider: unknown;
  amount_usd: unknown;
  authorized_by: unknown;
  created_at: unknown;
}

/** Validates one stored row. Invalid rows fail closed: the store is corrupt. */
function toReservation(row: ReservationRow): Reservation {
  const fail = (detail: string): never => {
    throw new JournalStoreError(
      "JOURNAL_CORRUPT",
      `denied: reservation store holds an invalid reservation row (${detail}); no admission until repaired`,
    );
  };
  if (typeof row.reservation_id !== "string" || row.reservation_id === "") fail("empty reservation_id");
  if (typeof row.project_id !== "string" || row.project_id === "") fail("empty project_id");
  if (typeof row.authorized_by !== "string" || row.authorized_by === "") fail("empty authorized_by");
  if (!isValidMoney(row.amount_usd)) fail(`invalid amount_usd ${String(row.amount_usd)}`);
  if (row.task_id !== null && row.task_id !== undefined && typeof row.task_id !== "string") {
    fail("invalid task_id");
  }
  if (row.provider !== null && row.provider !== undefined && typeof row.provider !== "string") {
    fail("invalid provider");
  }
  if (typeof row.created_at !== "string" || row.created_at === "") fail("empty created_at");
  const reservation: Reservation = {
    reservationId: row.reservation_id as string,
    projectId: row.project_id as string,
    amountUsd: row.amount_usd as number,
    authorizedBy: row.authorized_by as string,
    at: row.created_at as string,
  };
  if (typeof row.task_id === "string") reservation.taskId = row.task_id;
  if (typeof row.provider === "string") reservation.provider = row.provider;
  return reservation;
}

function loadActive(db: DatabaseSync): Reservation[] {
  const rows = db
    .prepare(
      "SELECT reservation_id, project_id, task_id, provider, amount_usd, authorized_by, created_at FROM reservations",
    )
    .all() as unknown as ReservationRow[];
  return rows.map(toReservation);
}

/**
 * Reads live holds. A missing store file replays as empty (genuinely new
 * state). An unreadable or corrupt store THROWS JournalStoreError:
 * callers must fail closed, never treat it as zero headroom.
 */
export function readActiveReservations(dbPath: string): { active: Reservation[] } {
  if (!existsSync(dbPath)) return { active: [] };
  const db = openStore(dbPath, 5_000);
  try {
    return { active: loadActive(db) };
  } finally {
    closeQuietly(db);
  }
}

export interface DurableGateArgs {
  /** File path of the SQLite reservation store. Missing file = new state. */
  dbPath: string;
  /** Known spend entries loaded into the gate before deciding. */
  seedEntries: CostEntry[];
  globalCapUsd?: number | null;
  projectCaps?: Record<string, number>;
  providerQuotas?: Record<string, number>;
  /**
   * Authenticated owner identity from the trusted backend policy boundary.
   * REQUIRED: empty/missing denies the admission (no default identity).
   */
  ownerIdentity: string;
  /** How long to wait for a LIVE holder's transaction before failing closed. */
  busyTimeoutMs?: number;
  budgetUsd: number;
  authorized: boolean;
  projectId: string;
  taskId?: string;
  provider?: string;
  requestedUsd?: number | null;
  reservationId: string;
  unknownPolicy?: UnknownSpendPolicy;
  ownerPolicy?: OwnerQuotaPolicy;
}

/**
 * The ONE durable atomic admission path for multi-process use: under a
 * single SQLite write transaction it rebuilds a ledger (seeded spend +
 * caps + quotas + stored holds), runs checkAndReserve, and persists the
 * hold before COMMIT. Two processes racing here serialize on the
 * transaction lock, so the second sees the first's hold. `allowed: true`
 * is returned only after the hold's COMMIT succeeds (durable). Denials
 * are data, never throws; unexpected I/O failures during commit throw.
 */
export function durableCheckAndReserve(args: DurableGateArgs): CheckAndReserveResult {
  const denied = (reason: string): CheckAndReserveResult => ({
    decision: {
      allowed: false,
      reason,
      spendKnownUsd: null,
      spendLabel: "unknown",
      budgetUsd: args.budgetUsd,
      reservedUsd: 0,
      exposureUsd: 0,
      requestedUsd: 0,
    },
    reservationId: null,
  });

  if (typeof args.ownerIdentity !== "string" || args.ownerIdentity === "") {
    return denied(
      "denied: durable admission requires an explicit owner identity (owner-signed policy provenance); refusing to hold under a default identity",
    );
  }
  if (args.unknownPolicy === "reserve") {
    if (!args.ownerPolicy || args.ownerPolicy.authorizedBy !== args.ownerIdentity) {
      return denied(
        "denied: unknown-spend owner quota must be signed by the gate owner (ownerPolicy.authorizedBy must equal ownerIdentity); unknown spend stays fail-closed",
      );
    }
  }

  mkdirSync(dirname(args.dbPath), { recursive: true });
  let db: DatabaseSync;
  try {
    db = openStore(args.dbPath, args.busyTimeoutMs ?? 15_000);
  } catch (error) {
    if (error instanceof JournalStoreError) return denied(error.message);
    throw error;
  }
  try {
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      if (!isBusyError(error)) throw error;
      // A LIVE holder owns the write transaction: never break in, fail
      // closed with a retryable denial. The finally below closes the handle.
      return denied(
        `denied: reservation store is held by a live admission (${describeError(error)}); retry after it settles`,
      );
    }
    try {
      const ledger = new CostLedger();
      for (const entry of args.seedEntries) {
        const recorded = ledger.record(entry);
        if (!recorded.accepted) {
          throw new JournalStoreError(
            "JOURNAL_CORRUPT",
            `denied: invalid seed spend entry (${recorded.errors.map((e) => e.message).join("; ")})`,
          );
        }
      }
      if (args.globalCapUsd !== undefined && args.globalCapUsd !== null) {
        const capped = ledger.setGlobalCap(args.globalCapUsd, args.ownerIdentity);
        if (!capped.accepted) {
          return rollbackWith(db, () =>
            denied(`denied: invalid global cap (${capped.errors.map((e) => e.message).join("; ")})`),
          );
        }
      }
      for (const [projectId, cap] of Object.entries(args.projectCaps ?? {})) {
        const capped = ledger.setProjectCap(projectId, cap, args.ownerIdentity);
        if (!capped.accepted) {
          return rollbackWith(db, () =>
            denied(`denied: invalid project cap for ${projectId} (${capped.errors.map((e) => e.message).join("; ")})`),
          );
        }
      }
      for (const [provider, quota] of Object.entries(args.providerQuotas ?? {})) {
        const set = ledger.setProviderQuota(provider, quota);
        if (!set.accepted) {
          return rollbackWith(db, () =>
            denied(`denied: invalid provider quota for ${provider} (${set.errors.map((e) => e.message).join("; ")})`),
          );
        }
      }
      const active = loadActive(db);
      const imported = ledger.importReservations(active);
      if (imported.skipped.length > 0) {
        return rollbackWith(db, () =>
          denied(
            `denied: reservation store holds ${imported.skipped.length} unloadable row(s) (${imported.skipped.map((s) => s.reason).join("; ")}); no admission until repaired`,
          ),
        );
      }

      const checkArgs: BudgetCheckArgs & {
        reservationId: string;
        taskId?: string;
        authorizedBy?: string;
      } = {
        summary: ledger.summarize(args.projectId),
        budgetUsd: args.budgetUsd,
        authorized: args.authorized,
        requestedUsd: args.requestedUsd,
        reservationId: args.reservationId,
        authorizedBy: args.ownerIdentity,
      };
      if (args.provider !== undefined) checkArgs.provider = args.provider;
      if (args.taskId !== undefined) checkArgs.taskId = args.taskId;
      if (args.unknownPolicy !== undefined) checkArgs.unknownPolicy = args.unknownPolicy;
      if (args.ownerPolicy !== undefined) checkArgs.ownerPolicy = args.ownerPolicy;

      const result = ledger.checkAndReserve(checkArgs);
      if (!result.decision.allowed || result.reservationId === null) {
        return rollbackWith(db, () => result);
      }
      const existing = db
        .prepare("SELECT reservation_id, project_id, task_id, provider, amount_usd, authorized_by, created_at FROM reservations WHERE reservation_id = ?")
        .get(result.reservationId) as ReservationRow | undefined;
      if (existing === undefined) {
        db.prepare(
          "INSERT INTO reservations(reservation_id, project_id, task_id, provider, amount_usd, authorized_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(
          result.reservationId,
          args.projectId,
          args.taskId ?? null,
          args.provider ?? null,
          result.decision.requestedUsd,
          args.ownerIdentity,
          new Date().toISOString(),
        );
      } else {
        const kept = toReservation(existing);
        const identical =
          kept.projectId === args.projectId &&
          kept.amountUsd === result.decision.requestedUsd &&
          (kept.provider ?? null) === (args.provider ?? null) &&
          (kept.taskId ?? null) === (args.taskId ?? null);
        if (!identical) {
          return rollbackWith(db, () =>
            denied(
              `denied: reservationId ${result.reservationId} is already held with different terms; retry with a fresh id`,
            ),
          );
        }
        // Idempotent cross-process replay: the hold is already durable.
      }
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Best effort; the original error carries the verdict.
      }
      if (error instanceof JournalStoreError) return denied(error.message);
      throw error;
    }
  } finally {
    closeQuietly(db);
  }
}

function rollbackWith<T>(db: DatabaseSync, produce: () => T): T {
  try {
    db.exec("ROLLBACK");
  } catch {
    // Best effort; the denial below is the verdict.
  }
  return produce();
}

/**
 * Failure-path release: frees one hold. Returns true when a hold existed.
 * Runs in its own transaction; a missing store means nothing held.
 */
export function durableRelease(dbPath: string, reservationId: string): boolean {
  if (!existsSync(dbPath)) return false;
  const db = openStore(dbPath, 15_000);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const outcome = db.prepare("DELETE FROM reservations WHERE reservation_id = ?").run(reservationId);
      db.exec("COMMIT");
      return Number(outcome.changes) > 0;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Best effort; the original error carries the verdict.
      }
      throw error;
    }
  } finally {
    closeQuietly(db);
  }
}

/**
 * Restart/failure recovery: drops every held reservation that is not in
 * the live set (e.g. attempts still running after a crash) and returns
 * the released ids. A missing store means nothing held.
 */
export function durableReconcile(dbPath: string, activeReservationIds: Iterable<string>): { released: string[] } {
  if (!existsSync(dbPath)) return { released: [] };
  const db = openStore(dbPath, 15_000);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const live = [...new Set(activeReservationIds)];
      const current = (db.prepare("SELECT reservation_id FROM reservations").all() as Array<{
        reservation_id: unknown;
      }>).map((row) => String(row.reservation_id));
      const liveSet = new Set(live);
      const released = current.filter((id) => !liveSet.has(id)).sort();
      if (released.length === 0) {
        db.exec("ROLLBACK");
        return { released };
      }
      const stmt = db.prepare("DELETE FROM reservations WHERE reservation_id = ?");
      for (const id of released) stmt.run(id);
      db.exec("COMMIT");
      return { released };
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Best effort; the original error carries the verdict.
      }
      throw error;
    }
  } finally {
    closeQuietly(db);
  }
}
