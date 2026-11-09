import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessagingDb } from "./sqlite.ts";
import { MessageError } from "./types.ts";
import { ThreadStore } from "./thread-store.ts";
import type { Actor } from "./types.ts";

const WORKER_A: Actor = { type: "agent", id: "worker-a", role: "worker", projects: ["p1"] };
const WORKER_B: Actor = { type: "agent", id: "worker-b", role: "worker", projects: ["p1"] };
const OUTSIDER: Actor = { type: "agent", id: "worker-x", role: "worker", projects: ["p2"] };

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
  const store = new ThreadStore({
    db,
    generateId: () => `id-${++n}`,
    now: () => "2026-11-08T12:00:00.000Z",
  });
  store.createThread({
    channel: "task/t1",
    projectId: "p1",
    taskId: "t1",
    acl: ["worker-a", "worker-b", "role:coordinator"],
    threadId: "task/t1",
  });
  return { db, store };
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
    const { db, store } = setup();
    const { message, replayed } = post(store);
    assert.equal(replayed, false);
    assert.ok(message.messageId);
    assert.equal(message.taskId, "t1");
    const receipts = store.receiptsFor(message.messageId);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].recipientId, "worker-b");
    assert.equal(receipts[0].state, "queued");
    // Posting also enqueues exactly one frozen-contract outbox event.
    assert.equal(db.outboxPendingCount(), 1);
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

  it("FNV-1a-colliding payloads are still distinguished (SHA-256 digest)", () => {
    // "probe-message-7pf8" and "probe-message-orj6" collide under the
    // original 32-bit FNV-1a idempotency hash (both 108d46cb) for the
    // payload shape below. The SHA-256 digest must tell them apart: the
    // second post is a 409 conflict, never a false replay.
    const fnv1a = (s: string): string => {
      let h = 0x811c9dc5;
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
      return (h >>> 0).toString(16).padStart(8, "0");
    };
    const canonical = (body: string): string =>
      JSON.stringify({
        threadId: "task/t1",
        senderId: "worker-a",
        kind: "update",
        labels: [],
        body,
        recipientIds: ["worker-b"],
      });
    assert.equal(fnv1a(canonical("probe-message-7pf8")), "108d46cb");
    assert.equal(fnv1a(canonical("probe-message-orj6")), "108d46cb");
    const { store } = setup();
    store.postMessage({
      threadId: "task/t1", sender: WORKER_A, recipientIds: ["worker-b"],
      kind: "update", body: "probe-message-7pf8", idempotencyKey: "key-fnv-11",
    });
    assert.throws(
      () => store.postMessage({
        threadId: "task/t1", sender: WORKER_A, recipientIds: ["worker-b"],
        kind: "update", body: "probe-message-orj6", idempotencyKey: "key-fnv-11",
      }),
      (e: unknown) => e instanceof MessageError && e.code === "CONFLICT" && e.httpStatus === 409,
    );
  });

  it("duplicate normalized Orca events yield one logical message", () => {
    const { store } = setup();
    const base = {
      threadId: "task/t1",
      sender: WORKER_A,
      kind: "update" as const,
      body: "heartbeat ok",
      idempotencyKey: "key-ext-1",
      externalId: "orca:evt-9",
    };
    const first = store.postMessage(base);
    const second = store.postMessage({ ...base, idempotencyKey: "key-ext-2" });
    assert.equal(second.replayed, true);
    assert.equal(second.message.messageId, first.message.messageId);
  });

  it("receipt keys are unique at the storage layer", () => {
    const { db, store } = setup();
    const { message } = post(store);
    assert.throws(() =>
      db.prepare("INSERT INTO receipts (message_id, recipient_id, state, updated_at) VALUES (?, ?, 'queued', ?)").run(
        message.messageId, "worker-b", "2026-11-08T12:00:00.000Z",
      ),
    );
  });
});

describe("authorization and validation", () => {
  it("cross-project actor cannot post or read (403)", () => {
    const { store } = setup();
    assert.throws(
      () => post(store, { sender: OUTSIDER }),
      (e: unknown) => e instanceof MessageError && e.code === "FORBIDDEN" && e.httpStatus === 403,
    );
    post(store);
    assert.throws(
      () => store.readThread("task/t1", OUTSIDER),
      (e: unknown) => e instanceof MessageError && e.code === "FORBIDDEN",
    );
  });

  it("unknown thread is 404, closed thread is 410 but stays readable", () => {
    const { store } = setup();
    assert.throws(() => store.readThread("task/nope", WORKER_A),
      (e: unknown) => e instanceof MessageError && e.httpStatus === 404);
    store.closeThread("task/t1");
    assert.throws(() => post(store, { idempotencyKey: "key-closed-1" }),
      (e: unknown) => e instanceof MessageError && e.httpStatus === 410);
    assert.equal(store.readThread("task/t1", WORKER_A).messages.length, 0);
  });

  it("short idempotency keys are rejected", () => {
    const { store } = setup();
    assert.throws(() => post(store, { idempotencyKey: "short" }),
      (e: unknown) => e instanceof MessageError && e.httpStatus === 400);
  });

  it("unknown kinds and labels are rejected (frozen contract v0.1)", () => {
    const { store } = setup();
    assert.throws(() => post(store, { kind: "text" as never, idempotencyKey: "key-kk-11" }),
      (e: unknown) => e instanceof MessageError && e.httpStatus === 400);
  });
});

describe("moderation", () => {
  it("scrubs secrets before storage", () => {
    const { store } = setup();
    // Fake fixture token, concatenated so the committed file carries no
    // token-shaped literal (repo hygiene gate scripts/ci/check_hygiene.py).
    const fakeToken = ["ghp", "abcdefghijklmnop123456"].join("_");
    const { message } = post(store, {
      kind: "update",
      body: `token leak: ${fakeToken} and password: s3cr3t-value`,
      idempotencyKey: "key-secret-1",
    });
    assert.match(message.body, /\[REDACTED:TOKEN\]/);
    assert.match(message.body, /\[REDACTED:SECRET_VALUE\]/);
    assert.doesNotMatch(message.body, /ghp_abcdefghijklmnop/);
  });

  it("questions require severity + deadline; labels are validated", () => {
    const { store } = setup();
    assert.throws(() => post(store, { kind: "question", severity: undefined, idempotencyKey: "key-qq-11" }));
    assert.throws(() => post(store, {
      kind: "question", severity: "normal", deadlineAt: "2026-11-08T16:00:00.000Z",
      labels: ["nonsense" as never], idempotencyKey: "key-ll-11",
    }));
  });

  it("oversized bodies and bad MIME are rejected", () => {
    const { store } = setup();
    assert.throws(() => post(store, { kind: "update", body: "x".repeat(20001), idempotencyKey: "key-big-11" }));
    assert.throws(() =>
      post(store, {
        kind: "update",
        attachments: [{ name: "run.exe", mime: "application/x-msdownload", bytes: 10 }],
        idempotencyKey: "key-mime-11",
      }),
    );
  });
});

describe("cursor reads", () => {
  it("reads after cursor with limit", () => {
    const { store } = setup();
    const m1 = post(store, { kind: "update", body: "one", idempotencyKey: "key-cc-11" }).message;
    post(store, { kind: "update", body: "two", idempotencyKey: "key-cc-22" });
    post(store, { kind: "update", body: "three", idempotencyKey: "key-cc-33" });
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
