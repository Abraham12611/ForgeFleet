/**
 * Cross-process gate participant (FF-020 P0 durable tests).
 *
 * One OS process per invocation. Any throw means the gate (not the policy)
 * failed. Argv: mode dbPath jsonArgs.
 *
 * Modes:
 * - "admit": run durableCheckAndReserve({dbPath, ...jsonArgs}); stdout
 *   carries exactly one JSON verdict line. jsonArgs may include sleepMs:
 *   after the verdict, sleep that long before exiting (lets the parent
 *   SIGKILL the child AFTER its hold committed: crash-after-accept).
 * - "hold-open": open the store, BEGIN IMMEDIATE, INSERT one hold, print
 *   "holding", sleep holdMs, COMMIT, print "committed". The parent either
 *   SIGKILLs mid-transaction (crash: the hold must roll back) or lets it
 *   commit while attempting its own admission (live holder: the parent
 *   must wait, never break in, and then see the committed hold).
 */

import { DatabaseSync } from "node:sqlite";
import {
  RESERVATIONS_SCHEMA,
  durableCheckAndReserve,
} from "../../src/reservationJournal.ts";
import type { DurableGateArgs } from "../../src/reservationJournal.ts";

const [mode, dbPath, jsonArgs] = process.argv.slice(2) as string[];

if (!mode || !dbPath || !jsonArgs) {
  throw new Error("gate-child: expected mode dbPath jsonArgs");
}

const parsed = JSON.parse(jsonArgs) as Record<string, unknown>;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

if (mode === "admit") {
  const { sleepMs, ...gate } = parsed as Partial<DurableGateArgs> & { sleepMs?: number };
  const result = durableCheckAndReserve({ ...(gate as Omit<DurableGateArgs, "dbPath">), dbPath });
  process.stdout.write(
    `${JSON.stringify({
      allowed: result.decision.allowed,
      reservationId: result.reservationId,
      reason: result.decision.reason,
    })}\n`,
  );
  if (typeof sleepMs === "number" && sleepMs > 0) await sleep(sleepMs);
} else if (mode === "hold-open") {
  const { hold, holdMs } = parsed as {
    hold: {
      reservationId: string;
      projectId: string;
      taskId?: string;
      provider?: string;
      amountUsd: number;
      authorizedBy: string;
    };
    holdMs: number;
  };
  if (!hold || typeof holdMs !== "number") throw new Error("gate-child hold-open: expected hold + holdMs");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 15000");
    db.exec(RESERVATIONS_SCHEMA);
    db.exec("BEGIN IMMEDIATE");
    db.prepare(
      "INSERT INTO reservations(reservation_id, project_id, task_id, provider, amount_usd, authorized_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      hold.reservationId,
      hold.projectId,
      hold.taskId ?? null,
      hold.provider ?? null,
      hold.amountUsd,
      hold.authorizedBy,
      new Date().toISOString(),
    );
    process.stdout.write("holding\n");
    await sleep(holdMs);
    db.exec("COMMIT");
    process.stdout.write("committed\n");
  } finally {
    db.close();
  }
} else {
  throw new Error(`gate-child: unknown mode ${mode}`);
}
