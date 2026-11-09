import { test } from "node:test";
import assert from "node:assert/strict";
import { SourceSyncTracker, classifyFreshness } from "../src/freshness.js";

const T0 = Date.parse("2026-11-09T00:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

test("never-confirmed and invalid timestamps classify as unknown", () => {
  assert.equal(classifyFreshness(T0, null).class, "unknown");
  assert.equal(classifyFreshness(T0, null).ageMs, null);
  assert.equal(classifyFreshness(T0, "not-a-date").class, "unknown");
});

test("fresh/stale/expired boundaries follow the 5s default target", () => {
  assert.equal(classifyFreshness(T0, iso(T0 - 1000)).class, "fresh");
  assert.equal(classifyFreshness(T0, iso(T0 - 5000)).class, "fresh");
  assert.equal(classifyFreshness(T0, iso(T0 - 5001)).class, "stale");
  assert.equal(classifyFreshness(T0, iso(T0 - 60000)).class, "stale");
  assert.equal(classifyFreshness(T0, iso(T0 - 60001)).class, "expired");
});

test("tracker snapshot reports per-source age and class", () => {
  const t = new SourceSyncTracker();
  t.markConfirmed("github", iso(T0 - 2000));
  t.markConfirmed("orca", iso(T0 - 90000));
  const snap = t.snapshot(iso(T0));
  const bySource = Object.fromEntries(snap.map((s) => [s.source, s]));
  assert.equal(bySource["github"].class, "fresh");
  assert.equal(bySource["orca"].class, "expired");
});

test("banner shows when any source is not fresh; clean when all fresh", () => {
  const t = new SourceSyncTracker();
  t.markConfirmed("github", iso(T0 - 1000));
  const clean = t.banner(iso(T0));
  assert.equal(clean.showBanner, false);

  t.markError("orca", iso(T0), "probe failed");
  const shown = t.banner(iso(T0));
  assert.equal(shown.showBanner, true);
  assert.ok(shown.staleSources.includes("orca"));
  assert.match(shown.message, /last confirmed/);
});

test("empty tracker banners as unknown, never as fresh", () => {
  const b = new SourceSyncTracker().banner(iso(T0));
  assert.equal(b.showBanner, true);
  assert.equal(b.worst, "unknown");
});
