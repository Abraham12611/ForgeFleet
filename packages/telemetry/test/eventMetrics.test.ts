import { test } from "node:test";
import assert from "node:assert/strict";
import { EventMetrics } from "../src/eventMetrics.js";
import type { EventRef } from "../src/eventMetrics.js";

const T0 = "2026-11-09T00:00:00.000Z";
const T1 = "2026-11-09T00:00:01.500Z";

function ref(overrides: Partial<EventRef> = {}): EventRef {
  return {
    source: "orca-bridge",
    eventId: "evt-1",
    eventType: "attempt.started",
    family: "attempt",
    occurredAt: T0,
    receivedAt: T1,
    fencingEpoch: 3,
    ...overrides,
  };
}

test("accept, then duplicate on same (source, eventId)", () => {
  const m = new EventMetrics();
  const first = m.ingest(ref());
  assert.equal(first.outcome, "accepted");
  assert.equal(first.lagMs, 1500);
  const dup = m.ingest(ref());
  assert.equal(dup.outcome, "duplicate");
  const snap = m.snapshot(T1);
  assert.equal(snap.totalAccepted, 1);
  assert.equal(snap.duplicates, 1);
});

test("same eventId from a different source is a different event", () => {
  const m = new EventMetrics();
  m.ingest(ref());
  assert.equal(m.ingest(ref({ source: "other" })).outcome, "accepted");
});

test("older fencing epoch is ignored, never applied", () => {
  const m = new EventMetrics();
  const r = m.ingest(ref({ eventId: "old" }), 5);
  assert.equal(r.outcome, "stale-epoch");
  assert.equal(m.snapshot(T1).staleEpochIgnored, 1);
  assert.equal(m.snapshot(T1).totalAccepted, 0);
});

test("malformed events become dead letters with a human-visible reason", () => {
  const m = new EventMetrics();
  const r = m.ingest(ref({ eventId: "" }));
  assert.equal(r.outcome, "dead-letter");
  assert.match(r.reason, /eventId/);
  const snap = m.snapshot(T1);
  assert.equal(snap.deadLetters, 1);
  assert.equal(snap.deadLetterRecent.length, 1);
});

test("lag stats and per-family counts are exact", () => {
  const m = new EventMetrics();
  m.ingest(ref({ eventId: "a", receivedAt: "2026-11-09T00:00:01.000Z" }));
  m.ingest(ref({ eventId: "b", eventType: "task.ready", family: "task", receivedAt: "2026-11-09T00:00:03.000Z" }));
  const snap = m.snapshot(T1);
  assert.equal(snap.lag.count, 2);
  assert.equal(snap.lag.p50Ms, 1000);
  assert.equal(snap.lag.p95Ms, 3000);
  assert.equal(snap.lag.maxMs, 3000);
  assert.deepEqual(snap.byFamily, { attempt: 1, task: 1 });
});

test("dedupe set and dead-letter list stay bounded", () => {
  const m = new EventMetrics(10);
  for (let i = 0; i < 25; i++) m.ingest(ref({ eventId: `e-${i}` }));
  const snap = m.snapshot(T1);
  assert.equal(snap.totalAccepted, 25);
  assert.ok(snap.dedupeEvictions > 0);

  for (let i = 0; i < 60; i++) m.ingest(ref({ eventId: "" }));
  const snap2 = m.snapshot(T1);
  assert.equal(snap2.deadLetters, 60);
  assert.equal(snap2.deadLetterRecent.length, 50);
});
