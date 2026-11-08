import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MessageError } from "./types.ts";
import { ThreadStore } from "./thread-store.ts";
import type { Actor } from "./types.ts";

const WORKER_A: Actor = { type: "agent", id: "worker-a", role: "worker", projects: ["p1"] };
const WORKER_B: Actor = { type: "agent", id: "worker-b", role: "worker", projects: ["p1"] };
const OUTSIDER: Actor = { type: "agent", id: "worker-x", role: "worker", projects: ["p2"] };

function setup() {
  let n = 0;
  const store = new ThreadStore({
    generateId: () => `id-${++n}`,
    now: () => "2026-11-08T12:00:00.000Z",
  });
  const thread = store.createThread({
    channel: "task/t1",
    projectId: "p1",
    taskId: "t1",
    acl: ["worker-a", "worker-b", "role:coordinator"],
    threadId: "task/t1",
  });
  return { store, thread };
}

const post = (store: ThreadStore, overrides = {}) =>
  store.postMessage({
    threadId: "task/t1",
    sender: WORKER_A,
    recipientIds: ["worker-b"],
    kind: "question",
    body: "What shape is the auth response?",
    severity: "normal",
    deadlineAt: "2026-11-08T16:00:00.000Z",
    idempotencyKey: "key-00001",
    ...overrides,
  });

describe("idempotent post", () => {
  it("stores message with receipts before any ack", () => {
    const { store } = setup();
    const { message, replayed } = post(store);
    assert.equal(replayed, false);
    assert.ok(message.messageId);
    assert.equal(message.taskId, "t1");
    const receipts = store.receiptsFor(message.messageId);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].recipientId, "worker-b");
    assert.equal(receipts[0].state, "queued");
  });

  it("same key + same payload replays the original", () => {
    const { store } = setup();
    const first = post(store);
    const second = post(store);
    assert.equal(second.replayed, true);
    assert.equal(second.message.messageId, first.message.messageId);
  });

  it("same key + different payload is a 409 conflict", () => {
    const { store } = setup();
    post(store);
    assert.throws(
      () => post(store, { body: "A completely different question" }),
      (e: unknown) => e instanceof MessageError && e.code === "CONFLICT" && e.httpStatus === 409,
    );
  });

  it("duplicate normalized Orca events yield one logical message", () => {
    const { store } = setup();
    const base = {
      threadId: "task/t1",
      sender: WORKER_A,
      kind: "status" as const,
      body: "heartbeat ok",
      idempotencyKey: "key-ext-1",
      externalId: "orca:evt-9",
    };
    const first = store.postMessage(base);
    const second = store.postMessage({ ...base, idempotencyKey: "key-ext-2" });
    assert.equal(second.replayed, true);
    assert.equal(second.message.messageId, first.message.messageId);
  });
});

describe("authorization and validation", () => {
  it("cross-project actor cannot post (403)", () => {
    const { store } = setup();
    assert.throws(
      () => post(store, { sender: OUTSIDER }),
      (e: unknown) => e instanceof MessageError && e.code === "FORBIDDEN" && e.httpStatus === 403,
    );
  });

  it("cross-project actor cannot read (403)", () => {
    const { store } = setup();
    post(store);
    assert.throws(
      () => store.readThread("task/t1", OUTSIDER),
      (e: unknown) => e instanceof MessageError && e.code === "FORBIDDEN",
    );
  });

  it("unknown thread is 404, closed thread is 410", () => {
    const { store } = setup();
    assert.throws(() => store.readThread("task/nope", WORKER_A),
      (e: unknown) => e instanceof MessageError && e.httpStatus === 404);
    store.closeThread("task/t1");
    assert.throws(() => post(store, { idempotencyKey: "key-closed-1" }),
      (e: unknown) => e instanceof MessageError && e.httpStatus === 410);
    // Closed threads remain readable.
    assert.equal(store.readThread("task/t1", WORKER_A).messages.length, 0);
  });

  it("short idempotency keys are rejected", () => {
    const { store } = setup();
    assert.throws(() => post(store, { idempotencyKey: "short" }),
      (e: unknown) => e instanceof MessageError && e.httpStatus === 400);
  });
});

describe("moderation", () => {
  it("scrubs secrets before storage", () => {
    const { store } = setup();
    const { message } = post(store, {
      kind: "text",
      body: "token leak: ghp_abcdefghijklmnop123456 and password: s3cr3t-value",
      idempotencyKey: "key-secret-1",
    });
    assert.match(message.body, /\[REDACTED:TOKEN\]/);
    assert.match(message.body, /\[REDACTED:SECRET_VALUE\]/);
    assert.doesNotMatch(message.body, /ghp_abcdefghijklmnop/);
  });

  it("questions require severity + deadline", () => {
    const { store } = setup();
    assert.throws(() => post(store, { kind: "question", severity: undefined, idempotencyKey: "key-qq-1" }));
    assert.throws(() => post(store, { kind: "blocker", deadlineAt: undefined, idempotencyKey: "key-bb-1" }));
  });

  it("oversized bodies and bad MIME are rejected", () => {
    const { store } = setup();
    assert.throws(() => post(store, { kind: "text", body: "x".repeat(20001), idempotencyKey: "key-big-1" }));
    assert.throws(() =>
      post(store, {
        kind: "text",
        attachments: [{ name: "run.exe", mime: "application/x-msdownload", bytes: 10 }],
        idempotencyKey: "key-mime-1",
      }),
    );
  });
});

describe("cursor reads", () => {
  it("reads after cursor with limit", () => {
    const { store } = setup();
    const m1 = post(store, { kind: "text", body: "one", idempotencyKey: "key-cc-1" }).message;
    post(store, { kind: "text", body: "two", idempotencyKey: "key-cc-2" });
    post(store, { kind: "text", body: "three", idempotencyKey: "key-cc-3" });
    const page1 = store.readThread("task/t1", WORKER_B, undefined, 2);
    assert.equal(page1.messages.length, 2);
    assert.equal(page1.messages[0].messageId, m1.messageId);
    const page2 = store.readThread("task/t1", WORKER_B, page1.messages[1].messageId, 10);
    assert.equal(page2.messages.length, 1);
    assert.equal(page2.messages[0].body, "three");
    assert.throws(() => store.readThread("task/t1", WORKER_B, "cursor-nope"),
      (e: unknown) => e instanceof MessageError && e.httpStatus === 400);
  });
});
