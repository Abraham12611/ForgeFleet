/**
 * Cross-process atomicity for the budget gate (FF-020 P0).
 *
 * The in-memory CostLedger is atomic within one process. These tests prove
 * the durable path: two real OS processes racing durableCheckAndReserve
 * against one journal serialize on the file lock, so exactly one admission
 * wins; plus lock recovery and corrupt-journal fail-closed behavior.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendJournalRelease,
  readActiveReservations,
  withFileLock,
} from "../src/reservationJournal.ts";

const HELPER = fileURLToPath(new URL("./helpers/compete.ts", import.meta.url));

const SEED = JSON.stringify([
  {
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
  },
]);

interface Verdict {
  allowed: boolean;
  reservationId: string | null;
  reason: string;
}

function raceOnce(
  journalPath: string,
  lockDir: string,
  reservationId: string,
  budgetUsd: number,
  requestedUsd: number,
): Promise<Verdict> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [HELPER, journalPath, lockDir, SEED, String(budgetUsd), String(requestedUsd), reservationId, "p1"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`compete child ${reservationId} timed out: ${err}`));
    }, 30_000);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    child.on("error", (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`compete child ${reservationId} exited ${code}: ${err}`));
        return;
      }
      try {
        resolve(JSON.parse(out.trim()) as Verdict);
      } catch {
        reject(new Error(`compete child ${reservationId} printed non-JSON: ${out} ${err}`));
      }
    });
  });
}

test("two processes racing admit exactly one when headroom fits one", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ff020-race-"));
  const journalPath = join(dir, "journal.jsonl");
  const lockDir = join(dir, "gate.lock");

  // Known spend 0, budget 10, each process requests 6: at most one may win.
  const [a, b] = await Promise.all([
    raceOnce(journalPath, lockDir, "r-race-a", 10, 6),
    raceOnce(journalPath, lockDir, "r-race-b", 10, 6),
  ]);
  const winners = [a, b].filter((v) => v.allowed);
  const losers = [a, b].filter((v) => !v.allowed);
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.ok(winners[0].reservationId === "r-race-a" || winners[0].reservationId === "r-race-b");
  assert.match(losers[0].reason, /exceeds budget/);

  // The journal holds exactly the winner's 6.00 and nothing else.
  const replay = readActiveReservations(journalPath);
  assert.equal(replay.corrupt, 0);
  assert.equal(replay.active.length, 1);
  assert.equal(replay.active[0].amountUsd, 6);

  // After the winner's owner releases (failure path), the loser retries
  // with its own id and is admitted: no headroom leaked, no double-hold.
  appendJournalRelease(journalPath, winners[0].reservationId as string, "owner released after failure");
  const retry = await raceOnce(journalPath, lockDir, "r-race-b", 10, 6);
  assert.equal(retry.allowed, true);
  assert.equal(retry.reservationId, "r-race-b");
  const after = readActiveReservations(journalPath);
  assert.equal(after.active.length, 1);
  assert.equal(after.active[0].reservationId, "r-race-b");
});

test("stale lock from a crashed holder is broken, live lock is respected", () => {
  const dir = mkdtempSync(join(tmpdir(), "ff020-lock-"));
  const lockDir = join(dir, "gate.lock");

  mkdirSync(lockDir);
  const ancient = new Date(Date.now() - 120_000);
  utimesSync(lockDir, ancient, ancient);
  const recovered = withFileLock(lockDir, () => "recovered", { staleAfterMs: 1_000, timeoutMs: 10_000 });
  assert.equal(recovered, "recovered");

  mkdirSync(lockDir);
  assert.throws(() => withFileLock(lockDir, () => "never", { staleAfterMs: 60_000, timeoutMs: 200, retryMs: 20 }), /timeout acquiring file lock/);
});

test("journal replay skips corrupt rows fail-closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "ff020-journal-"));
  const journalPath = join(dir, "journal.jsonl");
  writeFileSync(
    journalPath,
    [
      "not json at all",
      JSON.stringify({ v: 1, op: "hold", reservation: { reservationId: "r-neg", projectId: "p1", amountUsd: -5, authorizedBy: "o", at: "t" } }),
      JSON.stringify({ v: 1, op: "hold" }),
      JSON.stringify({ v: 1, op: "hold", reservation: { reservationId: "r-ok", projectId: "p1", amountUsd: 2.5, authorizedBy: "o", at: "t" } }),
      JSON.stringify({ v: 1, op: "release", reservationId: "r-gone", at: "t", reason: "x" }),
    ].join("\n"),
  );
  const replay = readActiveReservations(journalPath);
  assert.equal(replay.active.length, 1);
  assert.equal(replay.active[0].reservationId, "r-ok");
  assert.equal(replay.corrupt, 3);
});
