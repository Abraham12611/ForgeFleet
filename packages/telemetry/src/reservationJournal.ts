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
 * Owner provenance: every durable admission requires a VERIFIED owner
 * session (`ownerSession`), never a bare identity string. The session
 * must carry a backend-issued `sessionId` with real entropy plus a valid
 * (unexpired) issuance window; holds are recorded under
 * `session.ownerId`, and an unknown-spend `ownerPolicy` is honored only
 * when its `authorizedBy` equals that `ownerId`. Structural/freshness
 * verification happens here; cryptographic signature checks against the
 * backend session store belong to the trusted backend policy boundary
 * (E05/E06), which must only construct sessions it actually issued.
 *
 * Ledger identity: every store carries a stable `ledger_id` in
 * `ledger_meta`, stamped explicitly by `initializeLedger()` on first run.
 * Pass that id back as `expectedLedgerId` on every later admission (the
 * supervisor keeps it in durable inventory): a missing, legacy
 * (no-marker), or mismatched store then DENIES instead of silently
 * starting from empty headroom, so a deleted or recreated database
 * cannot reopen budget after active spending.
 *
 * Integrity/durability proof: every open configures
 * `journal_mode = DELETE` + `synchronous = FULL` and runs
 * `PRAGMA integrity_check` (must return exactly one `ok` row), so
 * `allowed: true` is returned only after the hold's COMMIT is
 * fsync-durable. `storeProof()` reports the effective settings for tests
 * and audits.
 *
 * Only erasable TypeScript is used (no enums, namespaces or parameter
 * properties) so the file also runs under Node type stripping.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
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

/**
 * Verified owner-session provenance for one durable admission. This is
 * deliberately NOT a bare identity string: `sessionId` must be a
 * backend-issued token (minimum length enforced), `issuedAt` must be a
 * valid timestamp that is not in the future, and `expiresAt` (when
 * present) must still be in the future. Full signature verification
 * against the backend session store belongs to the trusted backend
 * policy boundary that issues these sessions.
 */
export interface OwnerSessionProvenance {
  ownerId: string;
  sessionId: string;
  issuedAt: string;
  expiresAt?: string;
}

/** Minimum sessionId length: short strings carry no token entropy. */
export const MIN_SESSION_ID_LENGTH = 12;

/** Clock skew tolerated for issuedAt (1 minute). */
const SESSION_CLOCK_SKEW_MS = 60_000;

export function verifyOwnerSession(
  session: unknown,
  nowMs: number = Date.now(),
): { ok: true; ownerId: string } | { ok: false; reason: string } {
  if (typeof session !== "object" || session === null || Array.isArray(session)) {
    return {
      ok: false,
      reason:
        "denied: durable admission requires a verified owner session (ownerId + sessionId + issuedAt); a bare identity string is not provenance",
    };
  }
  const { ownerId, sessionId, issuedAt, expiresAt } = session as {
    ownerId?: unknown;
    sessionId?: unknown;
    issuedAt?: unknown;
    expiresAt?: unknown;
  };
  if (typeof ownerId !== "string" || ownerId === "") {
    return { ok: false, reason: "denied: owner session carries no ownerId; refusing to hold under an anonymous session" };
  }
  if (typeof sessionId !== "string" || sessionId.length < MIN_SESSION_ID_LENGTH) {
    return {
      ok: false,
      reason: `denied: owner sessionId must be a backend-issued token of at least ${MIN_SESSION_ID_LENGTH} characters; short or missing tokens are not verifiable provenance`,
    };
  }
  if (typeof issuedAt !== "string" || Number.isNaN(Date.parse(issuedAt))) {
    return { ok: false, reason: "denied: owner session has no valid issuedAt timestamp" };
  }
  if (Date.parse(issuedAt) > nowMs + SESSION_CLOCK_SKEW_MS) {
    return { ok: false, reason: "denied: owner session issuedAt is in the future; refusing a session that is not yet valid" };
  }
  if (expiresAt !== undefined) {
    if (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt))) {
      return { ok: false, reason: "denied: owner session expiresAt is not a valid timestamp" };
    }
    if (Date.parse(expiresAt) <= nowMs) {
      return {
        ok: false,
        reason: "denied: owner session is expired; re-authenticate at the trusted policy boundary before dispatching",
      };
    }
  }
  return { ok: true, ownerId };
}

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

/** Ledger identity marker DDL: one stable ledger_id per store, stamped at init. */
export const LEDGER_META_SCHEMA = `CREATE TABLE IF NOT EXISTS ledger_meta(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`;

/**
 * Opens (creating parent dirs) and schema-validates the store. Throws
 * JournalStoreError when the store cannot be opened or is not a valid
 * reservation database. A missing file is NOT an error here: callers
 * decide whether creation is allowed (fresh state) or must fail closed.
 *
 * Every open pins `journal_mode = DELETE` + `synchronous = FULL` and
 * verifies `PRAGMA integrity_check` returns exactly one `ok` row, so any
 * handle this module admits through is fsync-durable and structurally
 * sound. A store that fails the check throws JOURNAL_CORRUPT and every
 * caller fails closed.
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
    db.exec(LEDGER_META_SCHEMA);
    db.exec("PRAGMA journal_mode = DELETE");
    db.exec("PRAGMA synchronous = FULL");
    const integrity = db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: unknown }>;
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {
      throw new JournalStoreError(
        "JOURNAL_CORRUPT",
        `denied: reservation store at ${dbPath} failed PRAGMA integrity_check; no admission until repaired`,
      );
    }
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

function readLedgerId(db: DatabaseSync): string | null {
  const row = db
    .prepare("SELECT value FROM ledger_meta WHERE key = 'ledger_id'")
    .get() as { value: unknown } | undefined;
  return typeof row?.value === "string" && row.value !== "" ? row.value : null;
}

export type LedgerIdentityStatus =
  | { status: "missing" }
  | { status: "legacy" }
  | { status: "initialized"; ledgerId: string };

/**
 * Distinguishes first run from an existing ledger. `missing` means no
 * store file exists (genuinely new state). `initialized` carries the
 * stable ledger id. `legacy` means a readable store with no identity
 * marker: either a pre-identity database or a foreign/recreated file
 * that happens to open — callers holding an expected id must treat it
 * as untrusted and deny.
 */
export function readLedgerIdentity(dbPath: string): LedgerIdentityStatus {
  if (!existsSync(dbPath)) return { status: "missing" };
  const db = openStore(dbPath, 5_000);
  try {
    const ledgerId = readLedgerId(db);
    return ledgerId === null ? { status: "legacy" } : { status: "initialized", ledgerId };
  } finally {
    closeQuietly(db);
  }
}

/**
 * Explicit trusted new-ledger initialization. Verifies the owner
 * session, creates the store when missing, stamps a fresh `ledger_id`
 * (plus which owner initialized it and when) when the store carries
 * none, and returns the id the supervisor must keep in durable
 * inventory and pass back as `expectedLedgerId`. An already-initialized
 * store is adopted, never re-stamped: its id is returned with
 * `fresh: false`.
 */
export function initializeLedger(
  dbPath: string,
  ownerSession: OwnerSessionProvenance,
): { ledgerId: string; fresh: boolean } {
  const verified = verifyOwnerSession(ownerSession);
  if (!verified.ok) {
    throw new Error(`cannot initialize ledger: ${verified.reason}`);
  }
  mkdirSync(dirname(dbPath), { recursive: true });
  const fresh = !existsSync(dbPath);
  const db = openStore(dbPath, 5_000);
  try {
    const existing = readLedgerId(db);
    if (existing !== null) return { ledgerId: existing, fresh: false };
    const ledgerId = randomUUID();
    const now = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT INTO ledger_meta(key, value) VALUES ('ledger_id', ?)").run(ledgerId);
      db.prepare("INSERT INTO ledger_meta(key, value) VALUES ('initialized_by', ?)").run(verified.ownerId);
      db.prepare("INSERT INTO ledger_meta(key, value) VALUES ('initialized_at', ?)").run(now);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Best effort; the original error carries the verdict.
      }
      throw error;
    }
    return { ledgerId, fresh };
  } finally {
    closeQuietly(db);
  }
}

export interface StoreProof {
  journalMode: string;
  /** PRAGMA synchronous level: 2 means FULL. */
  synchronous: number;
  integrity: "ok";
  ledgerId: string | null;
}

/**
 * Reports the effective durability/integrity posture of a store for
 * tests and audits. Opening applies the module's pinned settings, so
 * the reported values are the ones admissions actually run under;
 * reaching the return also proves `integrity_check` passed (openStore
 * throws otherwise).
 */
export function storeProof(dbPath: string): StoreProof {
  const db = openStore(dbPath, 5_000);
  try {
    const journalMode = (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
    const synchronous = (db.prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous;
    return { journalMode, synchronous, integrity: "ok", ledgerId: readLedgerId(db) };
  } finally {
    closeQuietly(db);
  }
}

export interface DurableAdmitResult extends CheckAndReserveResult {
  /** Stable ledger id of the store that decided ("" when identity is unknown). */
  ledgerId: string;
  /** True when this call created a brand-new ledger (first run). */
  ledgerFresh: boolean;
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
   * Verified owner session from the trusted backend policy boundary.
   * REQUIRED: a bare identity string is rejected — the session must be
   * verifiable (backend-issued sessionId, valid unexpired window), and
   * its ownerId signs caps, holds, and unknown-spend policy.
   */
  ownerSession: OwnerSessionProvenance;
  /**
   * Expected ledger identity from the supervisor's durable inventory
   * (see initializeLedger). When set, a missing, legacy (no-marker),
   * or mismatched store DENIES instead of starting from empty
   * headroom. When unset, a missing/legacy store is initialized or
   * adopted implicitly — convenient for tests, unsafe for production
   * dispatch after active spending.
   */
  expectedLedgerId?: string;
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
export function durableCheckAndReserve(args: DurableGateArgs): DurableAdmitResult {
  const denied = (reason: string, ledgerId = "", ledgerFresh = false): DurableAdmitResult => ({
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
    ledgerId,
    ledgerFresh,
  });

  const verified = verifyOwnerSession(args.ownerSession);
  if (!verified.ok) {
    return denied(verified.reason);
  }
  const ownerId = verified.ownerId;
  if (args.unknownPolicy === "reserve") {
    if (!args.ownerPolicy || args.ownerPolicy.authorizedBy !== ownerId) {
      return denied(
        "denied: unknown-spend owner quota must be signed by the gate owner (ownerPolicy.authorizedBy must equal ownerSession.ownerId); unknown spend stays fail-closed",
      );
    }
  }

  mkdirSync(dirname(args.dbPath), { recursive: true });
  const existedBefore = existsSync(args.dbPath);
  if (args.expectedLedgerId !== undefined && !existedBefore) {
    // Fail closed BEFORE openStore would create a replacement file: a
    // denied admission must not mint store state implicitly.
    return denied(
      `denied: expected ledger ${args.expectedLedgerId} but the reservation store at ${args.dbPath} is missing (deleted or never initialized); refusing to mint a replacement implicitly — re-establish trust with initializeLedger`,
    );
  }
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
    let ledgerId: string | null = null;
    let ledgerFresh = false;
    try {
      // Ledger identity checkpoint: distinguish first run from a
      // missing/recreated database. With an expectation, only the exact
      // ledger proceeds; anything else denies inside the transaction.
      ledgerId = readLedgerId(db);
      if (args.expectedLedgerId !== undefined) {
        if (ledgerId === null) {
          // Missing files are rejected before open above; reaching here
          // means a readable store with no identity marker (legacy or a
          // file recreated in the check-then-open race): never adopt it.
          return rollbackWith(db, () =>
            denied(
              `denied: reservation store at ${args.dbPath} carries no ledger identity marker (legacy or recreated database); refusing to adopt it blindly under expected ledger ${args.expectedLedgerId} — re-establish trust with initializeLedger`,
            ),
          );
        }
        if (ledgerId !== args.expectedLedgerId) {
          return rollbackWith(db, () =>
            denied(
              `denied: ledger identity mismatch at ${args.dbPath}: expected ${args.expectedLedgerId} but found ${ledgerId}; the store may have been replaced — no admission until reconciled`,
            ),
          );
        }
      } else if (ledgerId === null) {
        ledgerId = randomUUID();
        db.prepare("INSERT INTO ledger_meta(key, value) VALUES ('ledger_id', ?)").run(ledgerId);
        db.prepare("INSERT INTO ledger_meta(key, value) VALUES ('initialized_by', ?)").run(ownerId);
        db.prepare("INSERT INTO ledger_meta(key, value) VALUES ('initialized_at', ?)").run(new Date().toISOString());
        ledgerFresh = !existedBefore;
      }
      const rollbackDenied = (reason: string): DurableAdmitResult =>
        rollbackWith(db, () => denied(reason, ledgerId as string, ledgerFresh));

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
        const capped = ledger.setGlobalCap(args.globalCapUsd, ownerId);
        if (!capped.accepted) {
          return rollbackDenied(`denied: invalid global cap (${capped.errors.map((e) => e.message).join("; ")})`);
        }
      }
      for (const [projectId, cap] of Object.entries(args.projectCaps ?? {})) {
        const capped = ledger.setProjectCap(projectId, cap, ownerId);
        if (!capped.accepted) {
          return rollbackDenied(
            `denied: invalid project cap for ${projectId} (${capped.errors.map((e) => e.message).join("; ")})`,
          );
        }
      }
      for (const [provider, quota] of Object.entries(args.providerQuotas ?? {})) {
        const set = ledger.setProviderQuota(provider, quota);
        if (!set.accepted) {
          return rollbackDenied(
            `denied: invalid provider quota for ${provider} (${set.errors.map((e) => e.message).join("; ")})`,
          );
        }
      }
      const active = loadActive(db);
      const imported = ledger.importReservations(active);
      if (imported.skipped.length > 0) {
        return rollbackDenied(
          `denied: reservation store holds ${imported.skipped.length} unloadable row(s) (${imported.skipped.map((s) => s.reason).join("; ")}); no admission until repaired`,
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
        authorizedBy: ownerId,
      };
      if (args.provider !== undefined) checkArgs.provider = args.provider;
      if (args.taskId !== undefined) checkArgs.taskId = args.taskId;
      if (args.unknownPolicy !== undefined) checkArgs.unknownPolicy = args.unknownPolicy;
      if (args.ownerPolicy !== undefined) checkArgs.ownerPolicy = args.ownerPolicy;

      const result = ledger.checkAndReserve(checkArgs);
      if (!result.decision.allowed || result.reservationId === null) {
        return rollbackWith(db, () => ({ ...result, ledgerId: ledgerId as string, ledgerFresh }));
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
          ownerId,
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
          return rollbackDenied(
            `denied: reservationId ${result.reservationId} is already held with different terms; retry with a fresh id`,
          );
        }
        // Idempotent cross-process replay: the hold is already durable.
      }
      db.exec("COMMIT");
      return { ...result, ledgerId: ledgerId as string, ledgerFresh };
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Best effort; the original error carries the verdict.
      }
      if (error instanceof JournalStoreError) return denied(error.message, ledgerId ?? "", ledgerFresh);
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
