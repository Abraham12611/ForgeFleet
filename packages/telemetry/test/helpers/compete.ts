/**
 * Two-process race participant (FF-020 concurrency test).
 *
 * One OS process per invocation: rebuilds the gate from seeded spend plus
 * the shared journal under the file lock and attempts one durable
 * admission. Stdout carries exactly one JSON line with the verdict; any
 * throw means the gate (not the policy) failed.
 *
 * Argv: journalPath lockDir seedJson|none budgetUsd requestedUsd
 *   reservationId projectId
 */

import { durableCheckAndReserve } from "../../src/reservationJournal.ts";
import type { CostEntry } from "../../src/cost.ts";

const [journalPath, lockDir, seedJson, budgetStr, requestedStr, reservationId, projectId] = process.argv.slice(2) as string[];

if (!journalPath || !lockDir || !seedJson || !budgetStr || !requestedStr || !reservationId || !projectId) {
  throw new Error("compete.ts: expected 7 argv entries");
}

const seedEntries = seedJson === "none" ? [] : (JSON.parse(seedJson) as CostEntry[]);
const result = durableCheckAndReserve({
  journalPath,
  lockDir,
  seedEntries,
  budgetUsd: Number(budgetStr),
  authorized: true,
  projectId,
  requestedUsd: Number(requestedStr),
  reservationId,
});
process.stdout.write(
  `${JSON.stringify({
    allowed: result.decision.allowed,
    reservationId: result.reservationId,
    reason: result.decision.reason,
  })}\n`,
);
