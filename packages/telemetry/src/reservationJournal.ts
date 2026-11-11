/**
 * Durable reservation journal (FF-020, FR-10 "Cost ledger").
 *
 * The in-memory CostLedger gate is atomic within one process (synchronous
 * methods). Across processes and restarts, atomicity and durability come
 * from this module:
 * - every hold/release is appended to a JSONL journal file;
 * - every read-modify-write runs under an exclusive mkdir file lock, so
 *   two OS processes cannot admit against the same headroom;
 * - after a crash or restart, replay the journal and reconcile() away
 *   holds whose owner is no longer live.
 *
 * Only erasable TypeScript is used (no enums, namespaces or parameter
 * properties) so the file also runs under Node type stripping.
 */

import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { CostLedger, isValidMoney } from "./cost.ts";
import type {
  BudgetCheckArgs,
  CheckAndReserveResult,
  CostEntry,
  OwnerQuotaPolicy,
  Reservation,
  UnknownSpendPolicy,
} from "./cost.ts";

export interface JournalHold {
  v: 1;
  op: "hold";
  reservation: Reservation;
}

export interface JournalRelease {
  v: 1;
  op: "release";
  reservationId: string;
  at: string;
  reason: string;
}

export type JournalRecord = JournalHold | JournalRelease;

function isReservationLike(value: unknown): value is Reservation {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r["reservationId"] === "string" &&
    typeof r["projectId"] === "string" &&
    typeof r["authorizedBy"] === "string" &&
    isValidMoney(r["amountUsd"])
  );
}

/** Appends one hold row. Creates parent dirs. Throws on I/O failure. */
export function appendJournalHold(journalPath: string, reservation: Reservation): void {
  mkdirSync(dirname(journalPath), { recursive: true });
  const row: JournalHold = { v: 1, op: "hold", reservation };
  appendFileSync(journalPath, `${JSON.stringify(row)}\n`, "utf8");
}

/** Appends one release row. Missing journal file means nothing held: no-op. */
export function appendJournalRelease(journalPath: string, reservationId: string, reason: string): void {
  mkdirSync(dirname(journalPath), { recursive: true });
  const row: JournalRelease = { v: 1, op: "release", reservationId, at: new Date().toISOString(), reason };
  appendFileSync(journalPath, `${JSON.stringify(row)}\n`, "utf8");
}

export interface JournalReplay {
  /** Holds with no later release. First hold wins on duplicate ids. */
  active: Reservation[];
  /** Rows skipped fail-closed (bad JSON, wrong shape, non-finite money). */
  corrupt: number;
}

/**
 * Replays the journal into the live hold set. Corrupt rows are counted
 * and skipped, never admitted. Missing file replays as empty.
 */
export function readActiveReservations(journalPath: string): JournalReplay {
  let raw: string;
  try {
    raw = readFileSync(journalPath, "utf8");
  } catch {
    return { active: [], corrupt: 0 };
  }
  const active = new Map<string, Reservation>();
  let corrupt = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let row: unknown;
    try {
      row = JSON.parse(trimmed) as unknown;
    } catch {
      corrupt += 1;
      continue;
    }
    if (typeof row !== "object" || row === null) {
      corrupt += 1;
      continue;
    }
    const op = (row as Record<string, unknown>)["op"];
    if (op === "hold") {
      const reservation = (row as { reservation?: unknown })["reservation"];
      if (!isReservationLike(reservation)) {
        corrupt += 1;
        continue;
      }
      if (!active.has(reservation.reservationId)) {
        active.set(reservation.reservationId, { ...reservation });
      }
    } else if (op === "release") {
      const id = (row as { reservationId?: unknown })["reservationId"];
      if (typeof id !== "string" || id === "") {
        corrupt += 1;
        continue;
      }
      active.delete(id);
    } else {
      corrupt += 1;
    }
  }
  return { active: [...active.values()], corrupt };
}

export interface FileLockOptions {
  /** Lock older than this is treated as crash residue and removed. */
  staleAfterMs?: number;
  /** Wait between acquisition attempts. */
  retryMs?: number;
  /** Give up after this long. */
  timeoutMs?: number;
}

/**
 * Runs fn under an exclusive lock directory. Lock creation is atomic
 * (mkdir fails when the dir exists), so two processes cannot both hold
 * it. A stale lock left by a crashed holder is broken after staleAfterMs;
 * keep critical sections far shorter than that. Always released.
 */
export function withFileLock<T>(lockDir: string, fn: () => T, opts: FileLockOptions = {}): T {
  const staleAfterMs = opts.staleAfterMs ?? 30_000;
  const retryMs = opts.retryMs ?? 20;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  mkdirSync(dirname(lockDir), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (error) {
      const code = (error as { code?: unknown })["code"];
      if (code !== "EEXIST") throw error;
      let mtime = 0;
      try {
        mtime = statSync(lockDir).mtimeMs;
      } catch {
        continue;
      }
      if (mtime > 0 && Date.now() - mtime > staleAfterMs) {
        try {
          rmSync(lockDir, { recursive: true, force: true });
        } catch {
          // Lost the race to another waiter; retry acquisition.
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timeout acquiring file lock ${lockDir}`);
      }
      Atomics.wait(sleeper, 0, 0, retryMs);
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmSync(lockDir, { recursive: true, force: true });
    } catch {
      // Best effort: a leftover lock self-heals via staleAfterMs.
    }
  }
}

export interface DurableGateArgs {
  journalPath: string;
  lockDir: string;
  /** Known spend entries loaded into the gate before deciding. */
  seedEntries: CostEntry[];
  globalCapUsd?: number | null;
  projectCaps?: Record<string, number>;
  providerQuotas?: Record<string, number>;
  /** Owner identity signing caps, quotas and journal holds. */
  ownerIdentity?: string;
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
 * The ONE durable atomic admission path for multi-process use: under the
 * file lock it rebuilds a ledger (seeded spend + caps + quotas + journal
 * holds), runs checkAndReserve, and journals the hold on success. Two
 * processes racing here serialize on the lock, so the second sees the
 * first's hold. Denials are data, never throws (I/O failures throw).
 */
export function durableCheckAndReserve(args: DurableGateArgs): CheckAndReserveResult {
  mkdirSync(dirname(args.journalPath), { recursive: true });
  return withFileLock(args.lockDir, () => {
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

    const ledger = new CostLedger();
    for (const entry of args.seedEntries) {
      const recorded = ledger.record(entry);
      if (!recorded.accepted) {
        return denied(`denied: invalid seed spend entry (${recorded.errors.map((e) => e.message).join("; ")})`);
      }
    }
    const owner = args.ownerIdentity ?? "budget-gate";
    if (args.globalCapUsd !== undefined && args.globalCapUsd !== null) {
      const capped = ledger.setGlobalCap(args.globalCapUsd, owner);
      if (!capped.accepted) {
        return denied(`denied: invalid global cap (${capped.errors.map((e) => e.message).join("; ")})`);
      }
    }
    for (const [projectId, cap] of Object.entries(args.projectCaps ?? {})) {
      const capped = ledger.setProjectCap(projectId, cap, owner);
      if (!capped.accepted) {
        return denied(`denied: invalid project cap for ${projectId} (${capped.errors.map((e) => e.message).join("; ")})`);
      }
    }
    for (const [provider, quota] of Object.entries(args.providerQuotas ?? {})) {
      const set = ledger.setProviderQuota(provider, quota);
      if (!set.accepted) {
        return denied(`denied: invalid provider quota for ${provider} (${set.errors.map((e) => e.message).join("; ")})`);
      }
    }
    const replay = readActiveReservations(args.journalPath);
    ledger.importReservations(replay.active);

    const checkArgs: BudgetCheckArgs & { reservationId: string; taskId?: string } = {
      summary: ledger.summarize(args.projectId),
      budgetUsd: args.budgetUsd,
      authorized: args.authorized,
      requestedUsd: args.requestedUsd,
      reservationId: args.reservationId,
    };
    if (args.provider !== undefined) checkArgs.provider = args.provider;
    if (args.taskId !== undefined) checkArgs.taskId = args.taskId;
    if (args.unknownPolicy !== undefined) checkArgs.unknownPolicy = args.unknownPolicy;
    if (args.ownerPolicy !== undefined) checkArgs.ownerPolicy = args.ownerPolicy;

    const result = ledger.checkAndReserve(checkArgs);
    if (result.decision.allowed && result.reservationId !== null) {
      appendJournalHold(args.journalPath, {
        reservationId: result.reservationId,
        projectId: args.projectId,
        taskId: args.taskId,
        provider: args.provider,
        amountUsd: result.decision.requestedUsd,
        authorizedBy: owner,
        at: new Date().toISOString(),
      });
    }
    return result;
  });
}
