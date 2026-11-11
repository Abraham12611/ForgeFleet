import { test } from "node:test";
import assert from "node:assert/strict";
import { CostLedger, labelCostEntry } from "../src/cost.ts";
import type { CostEntry } from "../src/cost.ts";

function entry(overrides: Partial<CostEntry> = {}): CostEntry {
  return {
    entryId: "e1",
    projectId: "p1",
    provider: "acme-models",
    model: "worker-large",
    inputTokens: 100,
    outputTokens: 50,
    billedUsd: null,
    source: "unknown",
    recordedAt: "2026-11-09T00:00:00Z",
    recordedBy: { type: "service", id: "test" },
    ...overrides,
  };
}

test("label: provider invoice with amount is actual", () => {
  assert.equal(labelCostEntry({ billedUsd: 1.5, source: "provider-invoice" }), "actual");
  assert.equal(labelCostEntry({ billedUsd: 1.5, source: "provider-api" }), "actual");
});

test("label: price-table or unknown source with amount is estimated, never actual", () => {
  assert.equal(labelCostEntry({ billedUsd: 1.5, source: "price-table" }), "estimated");
  assert.equal(labelCostEntry({ billedUsd: 1.5, source: "manual-entry" }), "estimated");
  assert.equal(labelCostEntry({ billedUsd: 1.5, source: "unknown" }), "estimated");
});

test("label: missing amount is unknown, never zero", () => {
  assert.equal(labelCostEntry({ billedUsd: null, source: "provider-invoice" }), "unknown");
  assert.equal(labelCostEntry({ billedUsd: null, source: "unknown" }), "unknown");
});

test("record rejects invalid entries and duplicate ids", () => {
  const ledger = new CostLedger();
  const bad = ledger.record(entry({ inputTokens: -1 }));
  assert.equal(bad.accepted, false);
  assert.ok(bad.errors.some((e) => e.field === "inputTokens"));

  const ok = ledger.record(entry());
  assert.equal(ok.accepted, true);
  const dup = ledger.record(entry());
  assert.equal(dup.accepted, false);
  assert.ok(dup.errors.some((e) => e.field === "entryId"));
});

test("summarize: empty ledger is unknown with null total", () => {
  const s = new CostLedger().summarize("p1", "2026-11-09T00:00:00Z");
  assert.equal(s.label, "unknown");
  assert.equal(s.totalKnownUsd, null);
  assert.equal(s.entryCount, 0);
});

test("summarize: all-actual stays actual; any estimate or gap rolls up to estimated", () => {
  const ledger = new CostLedger();
  ledger.record(entry({ entryId: "a", billedUsd: 2, source: "provider-api" }));
  assert.equal(ledger.summarize("p1").label, "actual");

  ledger.record(entry({ entryId: "b", billedUsd: 3, source: "price-table" }));
  const mixed = ledger.summarize("p1");
  assert.equal(mixed.label, "estimated");
  assert.equal(mixed.totalKnownUsd, 5);
  assert.equal(mixed.actualUsd, 2);
  assert.equal(mixed.estimatedUsd, 3);

  ledger.record(entry({ entryId: "c" }));
  const gap = ledger.summarize("p1");
  assert.equal(gap.label, "estimated");
  assert.equal(gap.uncoveredCount, 1);
  assert.equal(gap.totalKnownUsd, 5);
});

test("checkBudget: missing authorization denies visibly; over-budget denies", () => {
  const ledger = new CostLedger();
  ledger.record(entry({ entryId: "a", billedUsd: 9, source: "provider-api" }));
  const summary = ledger.summarize("p1");

  const noAuth = ledger.checkBudget({ summary, budgetUsd: 100, authorized: false });
  assert.equal(noAuth.allowed, false);
  assert.match(noAuth.reason, /authorization/);

  const over = ledger.checkBudget({ summary, budgetUsd: 5, authorized: true });
  assert.equal(over.allowed, false);
  assert.match(over.reason, /budget/);

  const ok = ledger.checkBudget({ summary, budgetUsd: 100, authorized: true });
  assert.equal(ok.allowed, true);
});

test("checkBudget: unknown spend is denied by default (fail-closed), label preserved", () => {
  const ledger = new CostLedger();
  const summary = ledger.summarize("p1");
  assert.equal(summary.label, "unknown");
  const d = ledger.checkBudget({ summary, budgetUsd: 100, authorized: true, requestedUsd: 1 });
  assert.equal(d.allowed, false);
  assert.equal(d.spendLabel, "unknown");
  assert.match(d.reason, /unknown/);
  assert.match(d.reason, /fail-closed/);
});

test("checkBudget: unknown spend allowed only under an explicit owner quota cap", () => {
  const ledger = new CostLedger();
  const summary = ledger.summarize("p1");
  const noPolicy = ledger.checkBudget({ summary, budgetUsd: 100, authorized: true, requestedUsd: 4, unknownPolicy: "reserve" });
  assert.equal(noPolicy.allowed, false);
  assert.match(noPolicy.reason, /owner quota/);

  const noAuth = ledger.checkBudget({
    summary, budgetUsd: 100, authorized: true, requestedUsd: 4,
    unknownPolicy: "reserve", ownerPolicy: { unknownCapUsd: 5, authorizedBy: "" },
  });
  assert.equal(noAuth.allowed, false);

  const withinCap = ledger.checkBudget({
    summary, budgetUsd: 100, authorized: true, requestedUsd: 4,
    unknownPolicy: "reserve", ownerPolicy: { unknownCapUsd: 5, authorizedBy: "owner" },
  });
  assert.equal(withinCap.allowed, true);

  const overCap = ledger.checkBudget({
    summary, budgetUsd: 100, authorized: true, requestedUsd: 6,
    unknownPolicy: "reserve", ownerPolicy: { unknownCapUsd: 5, authorizedBy: "owner" },
  });
  assert.equal(overCap.allowed, false);
  assert.match(overCap.reason, /cap/);
});

test("checkBudget: requested cost counts atomically (known + reserved + requested)", () => {
  const ledger = new CostLedger();
  ledger.record(entry({ entryId: "a", billedUsd: 9, source: "provider-api" }));
  const summary = ledger.summarize("p1");
  // Known alone fits, but known + requested exceeds: deny.
  const d = ledger.checkBudget({ summary, budgetUsd: 10, authorized: true, requestedUsd: 5 });
  assert.equal(d.allowed, false);
  assert.equal(d.exposureUsd, 14);
  assert.match(d.reason, /exceeds budget/);

  const fits = ledger.checkBudget({ summary, budgetUsd: 10, authorized: true, requestedUsd: 1 });
  assert.equal(fits.allowed, true);
  assert.equal(fits.exposureUsd, 10);
});

test("checkAndReserve: concurrent admissions cannot both spend the same headroom", () => {
  const ledger = new CostLedger();
  ledger.record(entry({ entryId: "a", billedUsd: 0, source: "provider-api" }));
  const summary = () => ledger.summarize("p1");

  const first = ledger.checkAndReserve({ summary: summary(), budgetUsd: 10, authorized: true, requestedUsd: 6, reservationId: "r-1" });
  assert.equal(first.decision.allowed, true);
  assert.equal(first.reservationId, "r-1");

  const second = ledger.checkAndReserve({ summary: summary(), budgetUsd: 10, authorized: true, requestedUsd: 5, reservationId: "r-2" });
  assert.equal(second.decision.allowed, false);
  assert.equal(second.reservationId, null);
  assert.match(second.decision.reason, /exceeds budget/);

  assert.equal(ledger.release("r-1"), true);
  const retry = ledger.checkAndReserve({ summary: summary(), budgetUsd: 10, authorized: true, requestedUsd: 5, reservationId: "r-2" });
  assert.equal(retry.decision.allowed, true);
  assert.equal(retry.reservationId, "r-2");

  const identical = ledger.reserve({ reservationId: "r-2", projectId: "p1", amountUsd: 5, authorizedBy: "owner" });
  assert.equal(identical.accepted, true);
  assert.equal(identical.duplicate, true);
  assert.equal(ledger.reservedFor("p1"), 5);

  const conflict = ledger.reserve({ reservationId: "r-2", projectId: "p1", amountUsd: 1, authorizedBy: "owner" });
  assert.equal(conflict.accepted, false);
  assert.match(conflict.errors[0].message, /different terms/);
  assert.equal(ledger.reservedFor("p1"), 5);
});

test("checkAndReserve: identical retry is idempotent, conflicting reuse is denied", () => {
  const ledger = new CostLedger();
  ledger.record(entry({ entryId: "a", billedUsd: 0, source: "provider-api" }));
  const summary = () => ledger.summarize("p1");
  const req = { summary: summary(), budgetUsd: 10, authorized: true, requestedUsd: 4, reservationId: "r-i" };

  const first = ledger.checkAndReserve(req);
  assert.equal(first.decision.allowed, true);
  assert.equal(first.reservationId, "r-i");

  const replay = ledger.checkAndReserve({ ...req, summary: summary() });
  assert.equal(replay.decision.allowed, true);
  assert.equal(replay.reservationId, "r-i");
  assert.match(replay.decision.reason, /idempotent replay/);
  assert.equal(ledger.reservedFor("p1"), 4);

  const conflict = ledger.checkAndReserve({ ...req, summary: summary(), requestedUsd: 9 });
  assert.equal(conflict.decision.allowed, false);
  assert.equal(conflict.reservationId, null);
  assert.match(conflict.decision.reason, /different terms/);
});

test("checkBudget: provider quota exhaustion denies with per-provider math", () => {
  const ledger = new CostLedger();
  assert.equal(ledger.setProviderQuota("muse", 5).accepted, true);
  ledger.record(entry({ entryId: "a", provider: "muse", billedUsd: 3, source: "provider-api" }));
  const summary = ledger.summarize("p1");

  const over = ledger.checkBudget({ summary, budgetUsd: 100, authorized: true, requestedUsd: 3, provider: "muse" });
  assert.equal(over.allowed, false);
  assert.match(over.reason, /quota exhausted/);

  const fits = ledger.checkBudget({ summary, budgetUsd: 100, authorized: true, requestedUsd: 2, provider: "muse" });
  assert.equal(fits.allowed, true);

  // Other providers are unaffected by the muse quota.
  const other = ledger.checkBudget({ summary, budgetUsd: 100, authorized: true, requestedUsd: 50, provider: "devin" });
  assert.equal(other.allowed, true);
});

test("money validation: non-finite and negative amounts are rejected everywhere", () => {
  const ledger = new CostLedger();
  for (const bad of [Infinity, -Infinity, NaN, -1]) {
    assert.equal(ledger.record(entry({ entryId: `e-${String(bad)}`, billedUsd: bad as number })).accepted, false);
    assert.equal(ledger.setProviderQuota("muse", bad as number).accepted, false);
    assert.equal(ledger.reserve({ reservationId: `r-${String(bad)}`, projectId: "p1", amountUsd: bad as number, authorizedBy: "owner" }).accepted, false);
  }
  const summary = ledger.summarize("p1");
  for (const bad of [Infinity, NaN, -1]) {
    assert.equal(ledger.checkBudget({ summary, budgetUsd: bad as number, authorized: true }).allowed, false);
    assert.equal(ledger.checkBudget({ summary, budgetUsd: 100, authorized: true, requestedUsd: bad as number }).allowed, false);
  }
  const noAuth = ledger.reserve({ reservationId: "r-x", projectId: "p1", amountUsd: 1, authorizedBy: "" });
  assert.equal(noAuth.accepted, false);
  assert.ok(noAuth.errors.some((e) => e.field === "authorizedBy"));

  // Caps and settle consume the same finite-money rule: no NaN/Infinity/negative.
  for (const bad of [Infinity, -Infinity, NaN, -1]) {
    assert.equal(ledger.setGlobalCap(bad as number, "owner").accepted, false);
    assert.equal(ledger.setProjectCap("p1", bad as number, "owner").accepted, false);
  }
  assert.equal(ledger.setGlobalCap(10, "").accepted, false);
  assert.equal(ledger.setProjectCap("p1", 10, "").accepted, false);

  const held = ledger.reserve({ reservationId: "r-nan", projectId: "p1", amountUsd: 2, authorizedBy: "owner" });
  assert.equal(held.accepted, true);
  const nanEntry = entry({ entryId: "nan-1", billedUsd: NaN as unknown as number, source: "provider-api" });
  const nanSettle = ledger.settle("r-nan", nanEntry);
  assert.equal(nanSettle.accepted, false);
  assert.equal(ledger.release("r-nan"), true);

  const imported = ledger.importReservations([
    { reservationId: "r-bad", projectId: "p1", amountUsd: NaN as unknown as number, authorizedBy: "owner", at: "2026-11-09T00:00:00Z" },
    { reservationId: "", projectId: "p1", amountUsd: 1, authorizedBy: "owner", at: "2026-11-09T00:00:00Z" },
  ]);
  assert.equal(imported.imported, 0);
  assert.equal(imported.skipped.length, 2);
});

test("caps: global and project hard caps deny even when the dispatch budget fits", () => {
  const ledger = new CostLedger();
  ledger.record(entry({ entryId: "a", billedUsd: 9, source: "provider-api" }));
  assert.equal(ledger.setGlobalCap(100, "owner").accepted, true);
  assert.equal(ledger.setProjectCap("p1", 100, "owner").accepted, true);

  const fits = ledger.checkBudget({ summary: ledger.summarize("p1"), budgetUsd: 100, authorized: true, requestedUsd: 1 });
  assert.equal(fits.allowed, true);

  assert.equal(ledger.setGlobalCap(9, "owner").accepted, true);
  const overGlobal = ledger.checkBudget({ summary: ledger.summarize("p1"), budgetUsd: 100, authorized: true, requestedUsd: 1 });
  assert.equal(overGlobal.allowed, false);
  assert.match(overGlobal.reason, /global hard cap/);
  assert.equal(ledger.setGlobalCap(100, "owner").accepted, true);

  assert.equal(ledger.setProjectCap("p1", 9, "owner").accepted, true);
  const overProject = ledger.checkBudget({ summary: ledger.summarize("p1"), budgetUsd: 100, authorized: true, requestedUsd: 1 });
  assert.equal(overProject.allowed, false);
  assert.match(overProject.reason, /project hard cap/);

  // Another project is unaffected by p1's cap; caps read back.
  const other = ledger.checkBudget({ summary: ledger.summarize("p2"), budgetUsd: 100, authorized: true, requestedUsd: 1, unknownPolicy: "reserve", ownerPolicy: { unknownCapUsd: 5, authorizedBy: "owner" } });
  assert.equal(other.allowed, true);
  assert.equal(ledger.globalCap(), 100);
  assert.equal(ledger.projectCap("p1"), 9);
  assert.equal(ledger.projectCap("p2"), null);
});

test("settle: success consumes the hold into spend; failure keeps the hold", () => {
  const ledger = new CostLedger();
  ledger.record(entry({ entryId: "a", billedUsd: 0, source: "provider-api" }));
  const admitted = ledger.checkAndReserve({ summary: ledger.summarize("p1"), budgetUsd: 10, authorized: true, requestedUsd: 6, reservationId: "r-s" });
  assert.equal(admitted.decision.allowed, true);

  const settled = ledger.settle("r-s", entry({ entryId: "spend-1", billedUsd: 6, source: "provider-api" }));
  assert.equal(settled.accepted, true);
  assert.equal(ledger.reservedFor("p1"), 0);
  const summary = ledger.summarize("p1");
  assert.equal(summary.totalKnownUsd, 6);

  // Headroom consumed: only 4 remains of the 10 budget.
  const next = ledger.checkBudget({ summary, budgetUsd: 10, authorized: true, requestedUsd: 5 });
  assert.equal(next.allowed, false);

  // Settling without a hold fails closed.
  const ghost = ledger.settle("r-ghost", entry({ entryId: "spend-2", billedUsd: 1, source: "provider-api" }));
  assert.equal(ghost.accepted, false);
  assert.match(ghost.errors[0].message, /admit before consuming/);
});

test("settle: invalid entry or project mismatch keeps the hold (no half-state)", () => {
  const ledger = new CostLedger();
  ledger.record(entry({ entryId: "a", billedUsd: 0, source: "provider-api" }));
  const admitted = ledger.checkAndReserve({ summary: ledger.summarize("p1"), budgetUsd: 10, authorized: true, requestedUsd: 6, reservationId: "r-k" });
  assert.equal(admitted.decision.allowed, true);

  const bad = ledger.settle("r-k", entry({ entryId: "bad-1", billedUsd: -1 as unknown as number, source: "provider-api" }));
  assert.equal(bad.accepted, false);
  const wrongProject = ledger.settle("r-k", entry({ entryId: "bad-2", projectId: "p2", billedUsd: 1, source: "provider-api" }));
  assert.equal(wrongProject.accepted, false);
  assert.equal(ledger.reservedFor("p1"), 6);
});

test("reconcile: drops orphaned holds, keeps live ones (restart recovery)", () => {
  const ledger = new CostLedger();
  ledger.reserve({ reservationId: "r-live", projectId: "p1", amountUsd: 3, authorizedBy: "owner" });
  ledger.reserve({ reservationId: "r-orphan", projectId: "p1", amountUsd: 4, authorizedBy: "owner" });
  assert.equal(ledger.reservedFor("p1"), 7);

  const { released } = ledger.reconcile(["r-live"]);
  assert.deepEqual(released, ["r-orphan"]);
  assert.equal(ledger.reservedFor("p1"), 3);

  const again = ledger.reconcile(["r-live"]);
  assert.deepEqual(again.released, []);
});

test("importReservations: loads journal holds, skips invalid and duplicate rows", () => {
  const ledger = new CostLedger();
  const { imported, skipped } = ledger.importReservations([
    { reservationId: "r-1", projectId: "p1", amountUsd: 2, authorizedBy: "owner", at: "2026-11-09T00:00:00Z" },
    { reservationId: "r-1", projectId: "p1", amountUsd: 2, authorizedBy: "owner", at: "2026-11-09T00:00:00Z" },
    { reservationId: "r-neg", projectId: "p1", amountUsd: -2, authorizedBy: "owner", at: "2026-11-09T00:00:00Z" },
  ]);
  assert.equal(imported, 1);
  assert.equal(skipped.length, 2);
  assert.equal(ledger.reservedFor("p1"), 2);
});
