import { test } from "node:test";
import assert from "node:assert/strict";
import { CostLedger, labelCostEntry } from "../src/cost.js";
import type { CostEntry } from "../src/cost.js";

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

test("checkBudget: unknown spend is allowed with caution, labeled unknown", () => {
  const summary = new CostLedger().summarize("p1");
  const d = new CostLedger().checkBudget({ summary, budgetUsd: 100, authorized: true });
  assert.equal(d.allowed, true);
  assert.equal(d.spendLabel, "unknown");
  assert.match(d.reason, /unknown/);
});
