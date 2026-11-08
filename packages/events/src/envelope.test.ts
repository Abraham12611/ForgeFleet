import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildEnvelope,
  dedupeKey,
  EVENT_SCHEMA_VERSION,
  isStaleProgress,
  redactForLog,
  validateEnvelope,
} from "./envelope.ts";

const BASE = {
  eventType: "attempt.heartbeat",
  occurredAt: "2026-11-08T12:00:00.000Z",
  source: "orca-bridge",
  projectId: "project_123",
  taskId: "task_123",
  attemptId: "00000000-0000-4000-8000-000000000001",
  correlationId: "corr-1",
  fencingEpoch: 1,
  actor: { type: "service", id: "orca-bridge" } as const,
  data: { externalDispatchId: "orca_dispatch_abc" },
};

describe("buildEnvelope", () => {
  it("fills generated fields and keeps caller fields", () => {
    const event = buildEnvelope(BASE, () => "2026-11-08T12:00:01.000Z");
    assert.equal(event.schemaVersion, EVENT_SCHEMA_VERSION);
    assert.equal(event.receivedAt, "2026-11-08T12:00:01.000Z");
    assert.ok(event.eventId.length > 0);
    assert.equal(event.taskId, "task_123");
  });

  it("throws on missing required fields", () => {
    assert.throws(() =>
      buildEnvelope({ ...BASE, projectId: "" }),
    );
    assert.throws(() =>
      buildEnvelope({ ...BASE, occurredAt: "not-a-date" }),
    );
    assert.throws(() =>
      buildEnvelope({ ...BASE, fencingEpoch: 0 }),
    );
  });
});

describe("validateEnvelope", () => {
  it("accepts a built envelope as known", () => {
    const result = validateEnvelope(buildEnvelope(BASE));
    assert.ok("event" in result);
    if ("event" in result) {
      assert.equal(result.known, true);
      assert.equal(result.event.eventType, "attempt.heartbeat");
    }
  });

  it("accepts unknown future event types as known:false (forward compat)", () => {
    const result = validateEnvelope(
      buildEnvelope({ ...BASE, eventType: "attempt.superpower.v9" }),
    );
    assert.ok("event" in result);
    if ("event" in result) assert.equal(result.known, false);
  });

  it("rejects wrong schema versions and bad shapes", () => {
    const badVersion = { ...buildEnvelope(BASE), schemaVersion: "0.2" };
    const r1 = validateEnvelope(badVersion);
    assert.ok("errors" in r1);

    const missing: Record<string, unknown> = { ...buildEnvelope(BASE) };
    delete missing["eventId"];
    const r2 = validateEnvelope(missing);
    assert.ok("errors" in r2);
    if ("errors" in r2) assert.ok(r2.errors.length > 0);

    assert.ok("errors" in validateEnvelope(null));
    assert.ok("errors" in validateEnvelope("heartbeat"));
  });
});

describe("dedupeKey", () => {
  it("namespaces event ids by source", () => {
    assert.equal(dedupeKey("a", "1"), "a::1");
    assert.notEqual(dedupeKey("a", "1"), dedupeKey("b", "1"));
  });
});

describe("isStaleProgress", () => {
  it("drops events from an older fencing epoch", () => {
    assert.equal(
      isStaleProgress(
        { eventType: "attempt.finished", fencingEpoch: 1 },
        { fencingEpoch: 2, state: "running" },
      ),
      true,
    );
  });

  it("drops heartbeats for terminal attempts but keeps lifecycle events", () => {
    const terminal = { fencingEpoch: 1, state: "finished" };
    assert.equal(
      isStaleProgress(
        { eventType: "attempt.heartbeat", fencingEpoch: 1 },
        terminal,
      ),
      true,
    );
    assert.equal(
      isStaleProgress(
        { eventType: "attempt.finished", fencingEpoch: 1 },
        terminal,
      ),
      false,
    );
  });

  it("keeps current-epoch progress for live attempts", () => {
    assert.equal(
      isStaleProgress(
        { eventType: "attempt.heartbeat", fencingEpoch: 2 },
        { fencingEpoch: 2, state: "running" },
      ),
      false,
    );
  });
});

describe("redactForLog", () => {
  it("scrubs secret keys, secret values and emails without mutating input", () => {
    const input = {
      serviceToken: "abc123",
      nested: { webhook_secret: "shh", note: "contact someone@example.com" },
      list: ["bearer abc.def_ghi", "clean"],
    };
    const out = redactForLog(input);
    assert.equal(out.serviceToken, "<redacted-secret>");
    assert.equal(out.nested.webhook_secret, "<redacted-secret>");
    assert.equal(out.nested.note, "contact <redacted-email>");
    assert.equal(out.list[0], "<redacted-secret>");
    assert.equal(out.list[1], "clean");
    assert.equal(input.nested.webhook_secret, "shh");
  });
});
