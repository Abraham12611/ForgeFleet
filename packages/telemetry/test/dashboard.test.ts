import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDashboardSnapshot, rollupWorkers } from "../src/dashboard.js";
import type { WorkerInfo } from "../src/dashboard.js";

const AT = "2026-11-09T00:00:00Z";

function workers(n: number): WorkerInfo[] {
  const states = ["busy", "available", "reporting", "disconnected"] as const;
  return Array.from({ length: n }, (_, i) => ({
    id: `w-${i}`,
    state: states[i % states.length],
    provider: i % 2 === 0 ? "muse" : "devin",
  }));
}

test("200 workers roll up exactly without flooding the list", () => {
  const r = rollupWorkers(workers(200), 50);
  assert.equal(r.total, 200);
  assert.equal(r.listed.length, 50);
  assert.equal(r.truncated, true);
  const counted = Object.values(r.byState).reduce((a, b) => a + b, 0);
  assert.equal(counted, 200);
  assert.equal(r.byProvider["muse"], 100);
});

test("small fleets are listed in full with truncated=false", () => {
  const r = rollupWorkers(workers(3), 50);
  assert.equal(r.truncated, false);
  assert.equal(r.listed.length, 3);
});

test("snapshot keeps oldest stalled task, omits the rest with a count, preserves unknown spend", () => {
  const s = buildDashboardSnapshot({
    asOf: AT,
    healthStatus: "degraded",
    healthUnknownLegs: ["ready"],
    spend: { totalKnownUsd: null, label: "unknown", uncoveredCount: 4 },
    budget: { budgetUsd: 25, allowed: true, reason: "allowed with caution: spend is unknown" },
    freshnessWorst: "stale",
    freshnessStaleSources: ["github"],
    freshnessBanner: "Status may be stale: github not confirmed.",
    events: { accepted: 120, duplicates: 3, staleIgnored: 1, deadLetters: 0, lagP95Ms: 900 },
    workers: workers(200),
    verifiedMergesToday: 2,
    activeTasks: 7,
    blockedDecisions: 1,
    stalledTasks: [
      { taskId: "t-old", projectId: "p", state: "running", waitingMs: 900000 },
      { taskId: "t-new", projectId: "p", state: "blocked", waitingMs: 1000 },
    ],
    idleExplanation: "2 workers idle: no ready tasks match provider capability.",
    lastConfirmedSync: { github: null, orca: AT },
  });
  assert.equal(s.oldestStalledTask?.taskId, "t-old");
  assert.equal(s.workers.total, 200);
  assert.equal(s.spend.totalKnownUsd, null);
  assert.equal(s.spend.label, "unknown");
  assert.equal(s.asOf, AT);
  assert.equal(s.idleExplanation.length > 0, true);
});
