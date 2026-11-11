import { test } from "node:test";
import assert from "node:assert/strict";
import { AuditTrail, MAX_SUMMARY_CHARS, redactValue } from "../src/audit.ts";

const AT = "2026-11-09T00:00:00Z";

test("append assigns sequence; trace lookup returns copies", () => {
  const trail = new AuditTrail();
  const a = trail.append({
    at: AT,
    traceId: "t1",
    actor: { type: "service", id: "orca-bridge" },
    operation: "attempt.dispatch",
    status: "ok",
    summary: "dispatched",
  });
  assert.equal(a.seq, 1);
  trail.append({
    at: AT,
    traceId: "t1",
    actor: { type: "human", id: "owner" },
    operation: "decision.answer",
    status: "ok",
    summary: "approved",
  });
  assert.equal(trail.size, 2);
  assert.equal(trail.byTrace("t1").length, 2);
  assert.equal(trail.byTrace("other").length, 0);
});

test("sensitive keys are redacted, including nested and array values", () => {
  const out = redactValue("", {
    authorization: "Bearer abc",
    nested: { apiKey: "k", safe: "keep" },
    list: [{ token: "t", n: 1 }],
  }) as Record<string, unknown>;
  assert.equal(out["authorization"], "[REDACTED]");
  assert.equal((out["nested"] as Record<string, unknown>)["apiKey"], "[REDACTED]");
  assert.equal((out["nested"] as Record<string, unknown>)["safe"], "keep");

  const trail = new AuditTrail();
  const e = trail.append({
    at: AT,
    traceId: "t2",
    actor: { type: "service", id: "github-svc" },
    operation: "webhook.ingest",
    status: "ok",
    summary: "ingested",
    detail: { signature: "sig", secret: "s3cr3t", deliveryId: "d1" },
  });
  assert.equal((e.detail as Record<string, unknown>)["secret"], "[REDACTED]");
  assert.equal((e.detail as Record<string, unknown>)["deliveryId"], "d1");
});

test("summaries are length-bounded", () => {
  const trail = new AuditTrail();
  const e = trail.append({
    at: AT,
    traceId: "t3",
    actor: { type: "agent", id: "worker-1" },
    operation: "message.post",
    status: "ok",
    summary: "x".repeat(MAX_SUMMARY_CHARS + 100),
  });
  assert.ok(e.summary.length <= MAX_SUMMARY_CHARS);
});

test("denials are first-class entries with correlation lookup and JSONL export", () => {
  const trail = new AuditTrail();
  trail.append({
    at: AT,
    traceId: "t4",
    correlationId: "c9",
    actor: { type: "service", id: "scheduler" },
    operation: "dispatch.authorize",
    status: "denied",
    summary: "denied: missing budget authorization",
    errorCode: "BUDGET_UNAUTHORIZED",
  });
  assert.equal(trail.byCorrelation("c9").length, 1);
  const lines = trail.toJsonLines().trim().split("\n");
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]) as { status: string; errorCode: string };
  assert.equal(parsed.status, "denied");
  assert.equal(parsed.errorCode, "BUDGET_UNAUTHORIZED");
});
