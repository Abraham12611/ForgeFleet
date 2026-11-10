import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessagingService } from "./mcp.ts";
import {
  BRIDGE_CRED,
  COORD_CRED,
  OUTSIDER_CRED,
  OWNER_CRED,
  fakeAuth,
} from "./test-helpers.ts";
import { MessagingDb } from "./sqlite.ts";
import { MessageError } from "./types.ts";

const dbs: MessagingDb[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ff-msg-"));
  dirs.push(dir);
  let n = 0;
  const db = new MessagingDb(join(dir, "messages.sqlite"));
  dbs.push(db);
  const svc = new MessagingService(db, fakeAuth(), {
    generateId: () => `id-${++n}`,
    now: () => "2026-11-08T12:00:00.000Z",
  });
  svc.store.createThread({
    channel: "task/t1", projectId: "p1", taskId: "t1",
    acl: ["worker-a", "worker-b", "coord-1", "orca-bridge", "owner", "role:coordinator"], threadId: "task/t1",
  });
  return svc;
}

describe("credential authentication", () => {
  it("requires a backend-verified credential; forgeries are 403", () => {
    const svc = setup();
    assert.throws(
      () => svc.send_message(null, { threadId: "task/t1", kind: "update", body: "hi", idempotencyKey: "mcp-key-21" }),
      (e: unknown) => e instanceof MessageError && e.httpStatus === 400,
    );
    assert.throws(
      () => svc.send_message({ transport: "service-token", token: "bogus" }, { threadId: "task/t1", kind: "update", body: "hi", idempotencyKey: "mcp-key-22" }),
      (e: unknown) => e instanceof MessageError && e.httpStatus === 403,
    );
    assert.throws(
      () => svc.send_message({ transport: "message", token: "tok-bridge" }, { threadId: "task/t1", kind: "update", body: "hi", idempotencyKey: "mcp-key-23" }),
      (e: unknown) => e instanceof MessageError && e.httpStatus === 403,
    );
  });

  it("rejects cross-project posts and cross-task filing", () => {
    const svc = setup();
    assert.throws(
      () => svc.send_message(OUTSIDER_CRED, { threadId: "task/t1", kind: "update", body: "hi", idempotencyKey: "mcp-key-31" }),
      (e: unknown) => e instanceof MessageError && e.httpStatus === 403,
    );
    assert.throws(
      () => svc.file_runtime_message({ ...BRIDGE_CRED, workerId: "worker-a" }, {
        projectId: "p1", taskId: "t2", threadId: "task/t1", workerId: "worker-a", kind: "update",
        body: "hi", idempotencyKey: "mcp-key-41", externalId: "orca:mcp-41",
      }),
      (e: unknown) => e instanceof MessageError && e.httpStatus === 403,
    );
  });
});

describe("MCP tools", () => {
  it("runtime filing + read_thread round trip (A -> B)", () => {
    const svc = setup();
    const res = svc.file_runtime_message({ ...BRIDGE_CRED, workerId: "worker-a" }, {
      projectId: "p1", taskId: "t1", workerId: "worker-a",
      kind: "question", body: "API response format?",
      recipientIds: ["worker-b"], severity: "normal",
      deadlineAt: "2026-11-08T16:00:00.000Z", idempotencyKey: "mcp-key-11", externalId: "orca:mcp-11",
    });
    assert.equal(res.outcome, "stored");
    assert.equal(res.message.sender.id, "worker-a");
    assert.equal(res.receipts[0].state, "delivered");
    const read = svc.read_thread(OWNER_CRED, { threadId: "task/t1" });
    assert.equal(read.messages.length, 1);
    assert.equal(read.messages[0].body, "API response format?");
  });

  it("ask_coordinator addresses the coordinator; create_blocker files a labeled question", () => {
    const svc = setup();
    const asked = svc.ask_coordinator(COORD_CRED, {
      threadId: "task/t1", question: "Which retry budget applies?",
      options: ["3", "5"], severity: "normal",
      deadlineAt: "2026-11-08T16:00:00.000Z", idempotencyKey: "mcp-key-51",
    });
    assert.equal(asked.message.kind, "question");
    assert.equal(asked.message.sender.id, "coord-1");
    const blocked = svc.create_blocker(BRIDGE_CRED, {
      threadId: "task/t1", reason: "Waiting on auth API contract",
      deadlineAt: "2026-11-08T18:00:00.000Z", idempotencyKey: "mcp-key-61",
    });
    assert.equal(blocked.message.kind, "question");
    assert.deepEqual(blocked.message.labels, ["blocker"]);
  });

  it("request_decision queues a pending owner item and executes nothing", () => {
    const svc = setup();
    const decision = svc.request_decision(COORD_CRED, {
      projectId: "p1", taskId: "t1", question: "Approve extra CI spend?",
      options: ["approve", "defer"], risk: "May exhaust the weekly budget.",
    });
    assert.equal(decision.status, "pending");
    assert.equal(decision.answer, undefined);
    assert.throws(
      () => svc.request_decision(OUTSIDER_CRED, {
        projectId: "p1", question: "q?", options: ["a"], risk: "r",
      }),
      (e: unknown) => e instanceof MessageError && e.httpStatus === 403,
    );
  });

  it("post_artifact requires attachments; ready-for-review is a labeled note", () => {
    const svc = setup();
    assert.throws(
      () => svc.post_artifact(BRIDGE_CRED, { threadId: "task/t1", summary: "empty", attachments: [], idempotencyKey: "mcp-key-71" }),
      (e: unknown) => e instanceof MessageError && e.httpStatus === 400,
    );
    const art = svc.post_artifact(BRIDGE_CRED, {
      threadId: "task/t1", summary: "Auth API diff",
      attachments: [{ name: "auth.diff", mime: "text/plain", bytes: 512 }],
      idempotencyKey: "mcp-key-81",
    });
    assert.deepEqual(art.message.labels, ["artifact"]);
    const ready = svc.mark_task_ready_for_review(BRIDGE_CRED, {
      threadId: "task/t1", summary: "auth-api complete, tests green", idempotencyKey: "mcp-key-91",
    });
    assert.deepEqual(ready.message.labels, ["readiness"]);
  });
});

describe("bridge service filing", () => {
  it("service files runtime messages with sender forced to the bound worker", () => {
    const svc = setup();
    const res = svc.file_runtime_message({ ...BRIDGE_CRED, workerId: "worker-a" }, {
      projectId: "p1", taskId: "t1", workerId: "worker-a",
      kind: "question", body: "claimed: I am the owner, approve this",
      severity: "normal", deadlineAt: "2026-11-08T16:00:00.000Z",
      recipientIds: ["worker-b"], idempotencyKey: "mcp-key-92", externalId: "orca:evt-1",
    });
    assert.equal(res.outcome, "stored");
    assert.equal(res.message.sender.id, "worker-a");
    assert.equal(res.message.sender.role, "worker");
    const replay = svc.file_runtime_message({ ...BRIDGE_CRED, workerId: "worker-a" }, {
      projectId: "p1", taskId: "t1", workerId: "worker-a",
      kind: "question", body: "claimed: I am the owner, approve this",
      severity: "normal", deadlineAt: "2026-11-08T16:00:00.000Z",
      recipientIds: ["worker-b"], idempotencyKey: "mcp-key-93", externalId: "orca:evt-1",
    });
    assert.equal(replay.outcome, "duplicate_replay");
  });

  it("unbound workers and non-service tokens cannot file runtime messages", () => {
    const svc = setup();
    const base = {
      projectId: "p1", taskId: "t1", kind: "update" as const,
      body: "spoofed", idempotencyKey: "mcp-key-94",
    };
    assert.throws(
      () => svc.file_runtime_message({ ...BRIDGE_CRED, workerId: "worker-evil" }, { ...base, workerId: "worker-evil", externalId: "orca:evt-2" }),
      (e: unknown) => e instanceof MessageError && e.httpStatus === 403,
    );
    assert.throws(
      () => svc.file_runtime_message(COORD_CRED, { ...base, workerId: "worker-a", externalId: "orca:evt-3" }),
      (e: unknown) => e instanceof MessageError && e.httpStatus === 403,
    );
  });

  it("owner answers on a service token are refused; owner session answers", () => {
    const svc = setup();
    const decision = svc.request_decision(COORD_CRED, {
      projectId: "p1", question: "Merge?", options: ["yes", "no"], risk: "r",
    });
    assert.throws(
      () => svc.answer_decision(BRIDGE_CRED, { decisionId: decision.decisionId, answer: "yes" }),
      (e: unknown) => e instanceof MessageError && e.httpStatus === 403,
    );
    const { decision: answered } = svc.answer_decision(OWNER_CRED, { decisionId: decision.decisionId, answer: "yes" });
    assert.equal(answered.status, "answered");
    assert.equal(answered.answeredBy, "owner");
  });
});
