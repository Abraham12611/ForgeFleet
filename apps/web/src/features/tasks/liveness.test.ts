/**
 * E13 — Tasks/fleet UX (FF-016): liveness vs verification tests.
 *
 * Core contract: the UI must never label an agent "working" solely because
 * it was dispatched. Liveness comes from reconciled heartbeats; task
 * verification comes from the task machine. Zero dependencies, stdlib only.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  describeLiveness,
  formatAge,
  LIVENESS_LABELS,
} from "./liveness.ts";

const NOW = Date.parse("2026-11-08T12:05:00Z");
const fresh = new Date(NOW - 2_000).toISOString();
const stale = new Date(NOW - 60_000).toISOString();

describe("describeLiveness", () => {
  it("never reports live for a bare dispatch without heartbeat", () => {
    assert.equal(
      describeLiveness({ attemptState: "dispatching", now: NOW }),
      "dispatched-unconfirmed",
    );
    assert.equal(
      describeLiveness({ attemptState: "accepted", lastHeartbeatAt: fresh, now: NOW }),
      "dispatched-unconfirmed",
    );
  });

  it("reports live only with a fresh reconciled heartbeat", () => {
    assert.equal(
      describeLiveness({ attemptState: "running", lastHeartbeatAt: fresh, now: NOW }),
      "live",
    );
  });

  it("reports stale when the heartbeat is older than the freshness target", () => {
    assert.equal(
      describeLiveness({ attemptState: "running", lastHeartbeatAt: stale, now: NOW }),
      "stale",
    );
  });

  it("reports unknown for lost telemetry, including running without any heartbeat", () => {
    assert.equal(
      describeLiveness({ attemptState: "unknown", lastHeartbeatAt: fresh, now: NOW }),
      "unknown",
    );
    assert.equal(
      describeLiveness({ attemptState: "running", now: NOW }),
      "unknown",
    );
    assert.equal(
      describeLiveness({ attemptState: "waiting", now: NOW }),
      "unknown",
    );
  });

  it("reports terminal for ended runtimes regardless of heartbeat freshness", () => {
    for (const state of ["finished", "failed", "cancelled"] as const) {
      assert.equal(
        describeLiveness({ attemptState: state, lastHeartbeatAt: fresh, now: NOW }),
        "terminal",
      );
    }
  });

  it("honours a custom staleness threshold", () => {
    assert.equal(
      describeLiveness({
        attemptState: "running",
        lastHeartbeatAt: stale,
        now: NOW,
        staleAfterMs: 120_000,
      }),
      "live",
    );
  });

  it("labels every liveness without relying on color alone", () => {
    for (const key of [
      "live",
      "dispatched-unconfirmed",
      "stale",
      "unknown",
      "terminal",
    ] as const) {
      assert.match(LIVENESS_LABELS[key], /\S/);
    }
    assert.match(LIVENESS_LABELS["dispatched-unconfirmed"], /awaiting runtime confirmation/);
    assert.match(LIVENESS_LABELS.unknown, /Unknown/);
  });
});

describe("formatAge", () => {
  it("formats seconds, minutes, hours, days", () => {
    assert.equal(formatAge(new Date(NOW - 9_000).toISOString(), NOW), "9s ago");
    assert.equal(formatAge(new Date(NOW - 5 * 60_000).toISOString(), NOW), "5m ago");
    assert.equal(
      formatAge(new Date(NOW - 3 * 3_600_000).toISOString(), NOW),
      "3h ago",
    );
    assert.equal(
      formatAge(new Date(NOW - 3 * 86_400_000).toISOString(), NOW),
      "3d ago",
    );
  });

  it("handles invalid timestamps without throwing", () => {
    assert.equal(formatAge("not-a-time", NOW), "time unknown");
  });
});
