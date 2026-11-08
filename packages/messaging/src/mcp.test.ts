import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MessagingService } from "./mcp.ts";
import { ThreadStore } from "./thread-store.ts";
import { EscalationStore } from "./escalation.ts";
import { MessageError, type Actor } from "./types.ts";

const WORKER_A: Actor = { type: "agent", id: "worker-a", role: "worker", projects: ["p1"] };
const WORKER_B: Actor = { type: "agent", id: "worker-b", role: "worker", projects: ["p1"] };
const COORD: Actor = { type: "agent", id: "coord-1", role: "coordinator", projects: ["p1"] };
const OUTSIDER: Actor = { type: "agent", id: "worker-x", role: "worker", projects: ["p2"] };

function setup() {
  let n = 0;
  const svc = new MessagingService(
    new ThreadStore({ generateId: () => `id-${++n}`, now: () => "2026-11-08T12:00:00.000Z" }),
    new EscalationStore({ generateId: () => `esc-${++n}`, now: () => "2026-11-08T12:00:00.000Z" }),
  );
  svc.store.createThread({
    channel: "task/t1", projectId: "p1", taskId: "t1",
    acl: ["worker-a", "worker-b", "coord-1", "role:coordinator"], threadId: "task/t1",
  });
  return svc;
}

describe("MCP facade", () => {
  it("send_message + read_thread round trip (A -> B)", () => {
    const svc = setup();
    const res = svc.send_message(WORKER_A, {
      threadId: "task/t1", kind: "question", body: "API response format?",
      recipientIds: ["worker-b"], severity: "normal",
      deadlineAt: "2026-11-08T16:00:00.000Z", idempotencyKey: "mcp-key-1",
    });
    assert.equal(res.outcome, "stored");
    assert.equal(res.receipts[0].state, "delivered");
    const read = svc.read_thread(WORKER_B, { threadId: "task/t1" });
    assert.equal(read.messages.length, 1);
    assert.equal(read.messages[0].body, "API response format?");
  });

  it("requires an authenticated caller identity", () => {
    const svc = setup();
    assert.throws(
      () => svc.send_message(null, { threadId: "task/t1", kind: "text", body: "hi", idempotencyKey: "mcp-key-2" }),
      (e: unknown) => e instanceof MessageError && e.httpStatus === 400,
    );
  });

  it("rejects cross-project posts and cross-task filing", () => {
    const svc = setup();
    assert.throws(
      () => svc.send_message(OUTSIDER, { threadId: "task/t1", kind: "text", body: "hi", idempotencyKey: "mcp-key-3" }),
      (e: unknown) => e instanceof MessageError && e.httpStatus === 403,
    );
    assert.throws(
      () => svc.send_message(WORKER_A, { threadId: "task/t1", kind: "text", body: "hi", taskId: "t2", idempotencyKey: "mcp-key-4" }),
      (e: unknown) => e instanceof MessageError && e.httpStatus === 403,
    );
  });

  it("ask_coordinator addresses the coordinator; create_blocker files a blocker", () => {
    const svc = setup();
    const asked = svc.ask_coordinator(WORKER_A, {
      threadId: "task/t1", question: "Which retry budget applies?",
      options: ["3", "5"], severity: "normal",
      deadlineAt: "2026-11-08T16:00:00.000Z", idempotencyKey: "mcp-key-5",
    });
    assert.equal(asked.message.kind, "question");
    assert.match(asked.message.body, /Which retry budget applies\?/);
    const blocked = svc.create_blocker(WORKER_B, {
      threadId: "task/t1", reason: "Waiting on auth API contract",
      deadlineAt: "2026-11-08T18:00:00.000Z", idempotencyKey: "mcp-key-6",
    });
    assert.equal(blocked.message.kind, "blocker");
    assert.equal(blocked.message.severity, "high");
  });

  it("request_decision queues a pending owner item and executes nothing", () => {
    const svc = setup();
    const decision = svc.request_decision(COORD, {
      projectId: "p1", taskId: "t1", question: "Approve extra CI spend?",
      options: ["approve", "defer"], risk: "May exhaust the weekly budget.",
    });
    assert.equal(decision.status, "pending");
    assert.equal(decision.projectId, "p1");
    // Outsider projects cannot queue decisions for p1.
    assert.throws(
      () => svc.request_decision(OUTSIDER, {
        projectId: "p1", question: "q?", options: ["a"], risk: "r",
      }),
      (e: unknown) => e instanceof MessageError && e.httpStatus === 403,
    );
  });

  it("post_artifact requires attachments; ready-for-review is a note, not a transition", () => {
    const svc = setup();
    assert.throws(
      () => svc.post_artifact(WORKER_A, { threadId: "task/t1", summary: "empty", attachments: [], idempotencyKey: "mcp-key-7" }),
      (e: unknown) => e instanceof MessageError && e.httpStatus === 400,
    );
    const art = svc.post_artifact(WORKER_A, {
      threadId: "task/t1", summary: "Auth API diff",
      attachments: [{ name: "auth.diff", mime: "text/plain", bytes: 512 }],
      idempotencyKey: "mcp-key-8",
    });
    assert.equal(art.message.kind, "artifact");
    const ready = svc.mark_task_ready_for_review(WORKER_A, {
      threadId: "task/t1", summary: "auth-api complete, tests green", idempotencyKey: "mcp-key-9",
    });
    assert.equal(ready.message.kind, "status");
    assert.match(ready.message.body, /Ready for review/);
  });
});
