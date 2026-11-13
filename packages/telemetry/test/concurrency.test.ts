/**
 * Cross-process atomicity and fail-closed durability for the budget gate
 * (FF-020 P0).
 *
 * The in-memory CostLedger is atomic within one process. These tests prove
 * the durable path: two real OS processes racing durableCheckAndReserve
 * against one SQLite store serialize on the write transaction, so exactly
 * one admission wins; a crash mid-transaction rolls back; a crash after
 * commit preserves the hold; a LIVE holder is waited on, never broken
 * into; corrupt/unreadable stores deny instead of admitting; and global +
 * provider ceilings count every project.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  JournalStoreError,
  RESERVATIONS_SCHEMA,
  durableCheckAndReserve,
  durableReconcile,
  durableRelease,
  readActiveReservations,
} from "../src/reservationJournal.ts";
import type { DurableGateArgs } from "../src/reservationJournal.ts";
import type { CostEntry, OwnerQuotaPolicy } from "../src/cost.ts";

const HELPER = fileURLToPath(new URL("./helpers/gate-child.ts", import.meta.url));
const OWNER = "owner-test";

function seedEntry(overrides: Partial<CostEntry> = {}): CostEntry {
  return {
    entryId: "seed-1",
    projectId: "p1",
    provider: "acme-models",
    model: "worker-large",
    inputTokens: 100,
    outputTokens: 50,
    billedUsd: 0,
    source: "provider-api",
    recordedAt: "2026-11-09T00:00:00Z",
    recordedBy: { type: "service", id: "concurrency-test" },
    ...overrides,
  };
}

interface Verdict {
  allowed: boolean;
  reservationId: string | null;
  reason: string;
}

type AdmitArgs = Omit<DurableGateArgs, "dbPath">;

function admitArgs(overrides: Partial<AdmitArgs> = {}): AdmitArgs {
  return {
    seedEntries: [seedEntry()],
    ownerIdentity: OWNER,
    budgetUsd: 10,
    authorized: true,
    projectId: "p1",
    requestedUsd: 6,
    reservationId: "r-x",
    ...overrides,
  };
}

/** In-process durable admission against one store file. */
function gate(dbPath: string, overrides: Partial<AdmitArgs> = {}): DurableGateArgs {
  return { ...admitArgs(overrides), dbPath };
}

function raceOnce(dbPath: string, args: AdmitArgs, timeoutMs = 30_000): Promise<Verdict> {
  const payload: DurableGateArgs = { ...args, dbPath };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HELPER, "admit", dbPath, JSON.stringify(payload)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`gate-child admit ${args.reservationId} timed out: ${err}`));
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    child.on("error", (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`gate-child admit ${args.reservationId} exited ${code}: ${err}`));
        return;
      }
      try {
        resolve(JSON.parse(out.trim().split("\n")[0]) as Verdict);
      } catch {
        reject(new Error(`gate-child admit ${args.reservationId} printed non-JSON: ${out} ${err}`));
      }
    });
  });
}

/** Spawns a holder and resolves once it prints "holding" (txn open, uncommitted). */
function startHolder(
  dbPath: string,
  hold: { reservationId: string; projectId: string; amountUsd: number },
  holdMs: number,
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        HELPER,
        "hold-open",
        dbPath,
        JSON.stringify({ hold: { ...hold, authorizedBy: OWNER }, holdMs }),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`gate-child hold-open timed out waiting for holding: ${err}`));
    }, 15_000);
    timer.unref?.();
    child.stderr?.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    child.on("error", (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString("utf8").includes("holding")) {
        clearTimeout(timer);
        resolve(child);
      }
    });
  });
}

function closed(child: ChildProcess, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error("child did not exit in time")), timeoutMs);
    timer.unref?.();
    child.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

test("two processes racing admit exactly one when headroom fits one", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ff020-race-"));
  const dbPath = join(dir, "reservations.db");

  // Known spend 0, budget 10, each process requests 6: at most one may win.
  const [a, b] = await Promise.all([
    raceOnce(dbPath, admitArgs({ reservationId: "r-race-a" })),
    raceOnce(dbPath, admitArgs({ reservationId: "r-race-b" })),
  ]);
  const winners = [a, b].filter((v) => v.allowed);
  const losers = [a, b].filter((v) => !v.allowed);
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.ok(winners[0].reservationId === "r-race-a" || winners[0].reservationId === "r-race-b");
  assert.match(losers[0].reason, /exceeds budget/);

  // The store holds exactly the winner's 6.00 and nothing else.
  const replay = readActiveReservations(dbPath);
  assert.equal(replay.active.length, 1);
  assert.equal(replay.active[0].amountUsd, 6);
  assert.equal(replay.active[0].authorizedBy, OWNER);

  // After the winner's owner releases (failure path), the loser retries
  // with its own id and is admitted: no headroom leaked, no double-hold.
  assert.equal(durableRelease(dbPath, winners[0].reservationId as string), true);
  const retry = await raceOnce(dbPath, admitArgs({ reservationId: "r-race-b" }));
  assert.equal(retry.allowed, true);
  assert.equal(retry.reservationId, "r-race-b");
  const after = readActiveReservations(dbPath);
  assert.equal(after.active.length, 1);
  assert.equal(after.active[0].reservationId, "r-race-b");
});

test("crash mid-transaction rolls back: no phantom hold, gate stays usable", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ff020-crash-"));
  const dbPath = join(dir, "reservations.db");
  mkdirSync(dir, { recursive: true });

  const holder = await startHolder(dbPath, { reservationId: "r-doomed", projectId: "p1", amountUsd: 9 }, 30_000);
  holder.kill("SIGKILL");
  await closed(holder);

  // The uncommitted hold must be gone; full headroom is admittable.
  const verdict = durableCheckAndReserve(gate(dbPath, { reservationId: "r-after-crash", requestedUsd: 10 }));
  assert.equal(verdict.decision.allowed, true);
  assert.equal(verdict.reservationId, "r-after-crash");
  const replay = readActiveReservations(dbPath);
  assert.equal(replay.active.length, 1);
  assert.equal(replay.active[0].reservationId, "r-after-crash");
});

test("crash after commit preserves the hold: no double admission", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ff020-crashcommit-"));
  const dbPath = join(dir, "reservations.db");

  // Child admits 6 (COMMIT succeeds, fsync-durable) then sleeps; the parent
  // SIGKILLs it to simulate a crash after an accepted launch.
  const child = spawn(
    process.execPath,
    [HELPER, "admit", dbPath, JSON.stringify({ ...admitArgs({ reservationId: "r-accepted" }), sleepMs: 30_000 })],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const firstLine = await new Promise<string>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("admit child never printed a verdict"));
    }, 15_000);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.includes("\n")) {
        clearTimeout(timer);
        resolve(out.trim().split("\n")[0]);
      }
    });
    child.on("error", (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
  });
  const first = JSON.parse(firstLine) as Verdict;
  assert.equal(first.allowed, true);
  child.kill("SIGKILL");
  await closed(child);

  // The committed hold survived the crash: a second 6.00 does not fit.
  const second = durableCheckAndReserve(gate(dbPath, { reservationId: "r-after-accept", requestedUsd: 6 }));
  assert.equal(second.decision.allowed, false);
  assert.match(second.decision.reason, /exceeds budget/);
  const replay = readActiveReservations(dbPath);
  assert.equal(replay.active.length, 1);
  assert.equal(replay.active[0].reservationId, "r-accepted");
});

test("a live holder is waited on, never broken into (no stale-lock steal)", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ff020-liveholder-"));
  const dbPath = join(dir, "reservations.db");
  mkdirSync(dir, { recursive: true });

  // Holder opens a write transaction and commits only after 3s — far
  // longer than any timestamp stale threshold the old lock used.
  const holder = await startHolder(dbPath, { reservationId: "r-live", projectId: "p1", amountUsd: 6 }, 3_000);

  // A short busy timeout fails closed instead of stealing the live lock.
  const impatient = durableCheckAndReserve(
    gate(dbPath, { reservationId: "r-impatient", busyTimeoutMs: 200 }),
  );
  assert.equal(impatient.decision.allowed, false);
  assert.match(impatient.decision.reason, /live admission|busy|locked/i);

  // A patient admission waits for the live holder, then decides against
  // the COMMITTED hold: 6 held + 6 requested exceeds the 10 budget.
  const started = Date.now();
  const patient = durableCheckAndReserve(gate(dbPath, { reservationId: "r-patient" }));
  const waitedMs = Date.now() - started;
  assert.equal(patient.decision.allowed, false);
  assert.match(patient.decision.reason, /exceeds budget/);
  assert.ok(waitedMs >= 1_500, `expected to wait for the live holder, waited ${waitedMs}ms`);
  await closed(holder);

  const replay = readActiveReservations(dbPath);
  assert.equal(replay.active.length, 1);
  assert.equal(replay.active[0].reservationId, "r-live");
});

test("malformed store denies admission; strict reader throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "ff020-malformed-"));

  const garbage = join(dir, "garbage.db");
  writeFileSync(garbage, "not a sqlite file at all........................");
  assert.throws(() => readActiveReservations(garbage), JournalStoreError);
  const deniedGarbage = durableCheckAndReserve(gate(garbage));
  assert.equal(deniedGarbage.decision.allowed, false);
  assert.match(deniedGarbage.decision.reason, /corrupt|unreadable/i);

  const badRow = join(dir, "badrow.db");
  {
    const db = new DatabaseSync(badRow);
    db.exec(RESERVATIONS_SCHEMA);
    db.prepare(
      "INSERT INTO reservations(reservation_id, project_id, task_id, provider, amount_usd, authorized_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("r-neg", "p1", null, null, -5, OWNER, "2026-11-09T00:00:00Z");
    db.close();
  }
  assert.throws(() => readActiveReservations(badRow), JournalStoreError);
  const deniedRow = durableCheckAndReserve(gate(badRow));
  assert.equal(deniedRow.decision.allowed, false);
  assert.match(deniedRow.decision.reason, /invalid reservation row/);
});

test("unreadable store denies admission instead of reading as zero holds", () => {
  const dir = mkdtempSync(join(tmpdir(), "ff020-unreadable-"));
  const dbPath = join(dir, "reservations.db");

  const held = durableCheckAndReserve(gate(dbPath, { reservationId: "r-held", requestedUsd: 9 }));
  assert.equal(held.decision.allowed, true);

  chmodSync(dbPath, 0o000);
  try {
    assert.throws(() => readActiveReservations(dbPath), JournalStoreError);
    const denied = durableCheckAndReserve(gate(dbPath, { reservationId: "r-sneak", requestedUsd: 1 }));
    assert.equal(denied.decision.allowed, false);
    assert.match(denied.decision.reason, /cannot be opened|unreadable/i);
  } finally {
    chmodSync(dbPath, 0o644);
  }

  // The 9.00 hold survived: only 1.00 of headroom remains.
  const replay = readActiveReservations(dbPath);
  assert.equal(replay.active.length, 1);
  assert.equal(replay.active[0].reservationId, "r-held");
});

test("missing store is genuinely new state; a directory is not", () => {
  const dir = mkdtempSync(join(tmpdir(), "ff020-missing-"));
  const fresh = join(dir, "fresh.db");
  assert.equal(existsSync(fresh), false);
  assert.deepEqual(readActiveReservations(fresh), { active: [] });
  const first = durableCheckAndReserve(gate(fresh));
  assert.equal(first.decision.allowed, true);

  const asDir = join(dir, "as-dir");
  mkdirSync(asDir);
  assert.throws(() => readActiveReservations(asDir), JournalStoreError);
  const denied = durableCheckAndReserve(gate(asDir));
  assert.equal(denied.decision.allowed, false);
  assert.match(denied.decision.reason, /cannot be opened|corrupt/i);
});

test("durable admission requires owner provenance; mismatched signer denied", () => {
  const dir = mkdtempSync(join(tmpdir(), "ff020-owner-"));
  const dbPath = join(dir, "reservations.db");

  const noOwner = durableCheckAndReserve(gate(dbPath, { ownerIdentity: "" }));
  assert.equal(noOwner.decision.allowed, false);
  assert.match(noOwner.decision.reason, /explicit owner identity/);
  assert.equal(noOwner.reservationId, null);

  const forged: DurableGateArgs = {
    ...gate(dbPath, { reservationId: "r-forged", requestedUsd: 1 }),
    seedEntries: [],
    unknownPolicy: "reserve",
    ownerPolicy: { unknownCapUsd: 5, authorizedBy: "someone-else" },
  };
  const deniedForged = durableCheckAndReserve(forged);
  assert.equal(deniedForged.decision.allowed, false);
  assert.match(deniedForged.decision.reason, /signed by the gate owner/);

  const signed: DurableGateArgs = {
    ...forged,
    reservationId: "r-signed",
    ownerPolicy: { unknownCapUsd: 5, authorizedBy: OWNER } satisfies OwnerQuotaPolicy,
  };
  const allowed = durableCheckAndReserve(signed);
  assert.equal(allowed.decision.allowed, true);
  assert.equal(allowed.reservationId, "r-signed");
  const replay = readActiveReservations(dbPath);
  assert.equal(replay.active[0].authorizedBy, OWNER);
});

test("global cap counts every project: two projects cannot each exhaust it", () => {
  const dir = mkdtempSync(join(tmpdir(), "ff020-twoproject-"));
  const dbPath = join(dir, "reservations.db");
  const seeds: CostEntry[] = [
    seedEntry({ entryId: "known-p1", projectId: "p1", billedUsd: 6 }),
    seedEntry({ entryId: "known-p2", projectId: "p2", billedUsd: 6 }),
  ];

  // Project-level math fits (6 + 1 <= 100) but global 6 + 6 + 1 > 10 denies.
  const denied = durableCheckAndReserve(
    gate(
      dbPath,
      {
      seedEntries: seeds,
      budgetUsd: 100,
      projectId: "p2",
      requestedUsd: 1,
      reservationId: "r-p2",
      globalCapUsd: 10,
    }),
  );
  assert.equal(denied.decision.allowed, false);
  assert.match(denied.decision.reason, /global hard cap/);
});

test("provider quota counts every project, including earlier recorded spend", () => {
  const dir = mkdtempSync(join(tmpdir(), "ff020-provider-"));
  const dbPath = join(dir, "reservations.db");
  const seeds: CostEntry[] = [
    seedEntry({ entryId: "known-p1", projectId: "p1", billedUsd: 5 }),
    seedEntry({ entryId: "known-p2", projectId: "p2", billedUsd: 5 }),
  ];

  // Project-p2 math alone fits the quota (5 + 1 <= 7) but account-wide
  // 5 + 5 + 1 > 7 denies.
  const denied = durableCheckAndReserve(
    gate(
      dbPath,
      {
      seedEntries: seeds,
      budgetUsd: 100,
      projectId: "p2",
      provider: "acme-models",
      requestedUsd: 1,
      reservationId: "r-p2q",
      providerQuotas: { "acme-models": 7 },
    }),
  );
  assert.equal(denied.decision.allowed, false);
  assert.match(denied.decision.reason, /quota exhausted/);
});

test("holds in another project count toward the global cap", () => {
  const dir = mkdtempSync(join(tmpdir(), "ff020-crosshold-"));
  const dbPath = join(dir, "reservations.db");
  const seeds: CostEntry[] = [
    seedEntry({ entryId: "known-p1", projectId: "p1", billedUsd: 0 }),
    seedEntry({ entryId: "known-p2", projectId: "p2", billedUsd: 0 }),
  ];

  const first = durableCheckAndReserve(
    gate(dbPath, { seedEntries: seeds, projectId: "p1", requestedUsd: 8, reservationId: "r-p1", globalCapUsd: 10 }),
  );
  assert.equal(first.decision.allowed, true);

  const second = durableCheckAndReserve(
    gate(dbPath, { seedEntries: seeds, projectId: "p2", requestedUsd: 3, reservationId: "r-p2", globalCapUsd: 10 }),
  );
  assert.equal(second.decision.allowed, false);
  assert.match(second.decision.reason, /global hard cap/);
});

test("durable release frees headroom; reconcile drops only orphaned holds", () => {
  const dir = mkdtempSync(join(tmpdir(), "ff020-lifecycle-"));
  const dbPath = join(dir, "reservations.db");

  assert.equal(
    durableCheckAndReserve(gate(dbPath, { reservationId: "r-live", requestedUsd: 4 })).decision.allowed,
    true,
  );
  assert.equal(
    durableCheckAndReserve(gate(dbPath, { reservationId: "r-orphan", requestedUsd: 4 })).decision.allowed,
    true,
  );
  assert.equal(durableRelease(dbPath, "r-missing"), false);
  assert.equal(durableRelease(dbPath, "r-live"), true);

  // The freed headroom is reusable: orphan 4 + new 6 fits the 10 budget.
  const readmit = durableCheckAndReserve(gate(dbPath, { reservationId: "r-new", requestedUsd: 6 }));
  assert.equal(readmit.decision.allowed, true);

  // Restart recovery drops only holds with no live owner.
  const { released } = durableReconcile(dbPath, ["r-new"]);
  assert.deepEqual(released, ["r-orphan"]);
  const replay = readActiveReservations(dbPath);
  assert.equal(replay.active.length, 1);
  assert.equal(replay.active[0].reservationId, "r-new");

  const again = durableReconcile(dbPath, ["r-new"]);
  assert.deepEqual(again.released, []);
});
