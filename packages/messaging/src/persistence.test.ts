/**
 * E10 / FF-014 — Durability proof: restart survival and crash recovery.
 *
 * Directly answers the review: state lives in SQLite transactions, so a
 * crash cannot discard an acknowledged decision or peer message, and the
 * outbox redelivers without duplicating sends. These tests close and
 * reopen the database file to simulate a bridge restart.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessagingService } from "./mcp.ts";
import { planDelivery } from "./router.ts";
import { MessagingDb } from "./sqlite.ts";
import { MessageError, type Actor, type AuthenticatedCaller } from "./types.ts";

const WORKER_A: Actor = { type: "agent", id: "worker-a", role: "worker", projects: ["p1"] };
const WORKER_B: Actor = { type: "agent", id: "worker-b", role: "worker", projects: ["p1"] };
const OWNER: Actor = { type: "human", id: "owner", role: "owner" };

const as = (identity: Actor): AuthenticatedCaller => ({ identity, via: "test-harness" });

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function openService(path: string, clock: () => string) {
  let n = 0;
  const db = new MessagingDb(path);
  const svc = new MessagingService(db, { generateId: () => `id-${++n}`, now: clock });
  return { db, svc };
}

function seedThread(svc: MessagingService): void {
  svc.store.createThread({
    channel: "task/t1", projectId: "p1", taskId: "t1",
    acl: ["worker-a", "worker-b", "owner"], threadId: "task/t1",
  });
}

describe("restart survival", () => {
  it("messages, receipts, escalations and answered decisions survive a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "ff-msg-"));
    dirs.push(dir);
    const file = join(dir, "messages.sqlite");
    let clock = "2026-11-08T12:00:00.000Z";

    let first = openService(file, () => clock);
    seedThread(first.svc);
    const posted = first.svc.send_message(as(WORKER_A), {
      threadId: "task/t1", kind: "question", body: "API response format?",
      recipientIds: ["worker-b"], severity: "normal",
      deadlineAt: "2026-11-08T16:00:00.000Z", idempotencyKey: "restart-key-1",
    });
    assert.equal(posted.outcome, "stored");
    const { escalation, decision } = first.svc.escalationStore.raiseEscalation(first.svc.store, {
      threadId: "task/t1", raisedBy: WORKER_A,
      options: ["approve deploy", "hold"], evidence: ["msg:id-1"], ownerOnly: true,
    });
    assert.ok(decision);
    first.svc.escalationStore.answerDecision(decision.decisionId, as(OWNER), "hold");
    first.db.close();

    // --- simulated bridge restart ---
    first = openService(file, () => clock);
    const msg = first.svc.store.getMessage(posted.message.messageId);
    assert.equal(msg.body, "API response format?");
    const receipts = first.svc.store.receiptsFor(msg.messageId);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].state, "delivered");
    const esc = first.svc.escalationStore.getEscalation(escalation.escalationId);
    assert.equal(esc.status, "owner_decision");
    const dec = first.svc.escalationStore.getDecision(decision.decisionId);
    assert.equal(dec.status, "answered");
    assert.equal(dec.answeredBy, "owner");
    // Outbox survived too: posted + delivered + requested + answered.
    assert.ok(first.db.outboxPendingCount() >= 4);
    first.db.close();
  });

  it("idempotency keys survive a restart: replay replays, conflicts conflict", () => {
    const dir = mkdtempSync(join(tmpdir(), "ff-msg-"));
    dirs.push(dir);
    const file = join(dir, "messages.sqlite");
    let first = openService(file, () => "2026-11-08T12:00:00.000Z");
    seedThread(first.svc);
    const original = first.svc.store.postMessage({
      threadId: "task/t1", sender: WORKER_A, recipientIds: ["worker-b"],
      kind: "update", body: "ping", idempotencyKey: "restart-key-2",
    });
    first.db.close();

    first = openService(file, () => "2026-11-08T12:00:00.000Z");
    const replay = first.svc.store.postMessage({
      threadId: "task/t1", sender: WORKER_A, recipientIds: ["worker-b"],
      kind: "update", body: "ping", idempotencyKey: "restart-key-2",
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.message.messageId, original.message.messageId);
    assert.throws(
      () => first.svc.store.postMessage({
        threadId: "task/t1", sender: WORKER_A, recipientIds: ["worker-b"],
        kind: "update", body: "different", idempotencyKey: "restart-key-2",
      }),
      (e: unknown) => e instanceof MessageError && e.httpStatus === 409,
    );
    first.db.close();
  });

  it("queued receipts after a crash are re-planned, not lost or double-woken", () => {
    const dir = mkdtempSync(join(tmpdir(), "ff-msg-"));
    dirs.push(dir);
    const file = join(dir, "messages.sqlite");

    // Crash between post and delivery planning: post directly (no apply).
    let first = openService(file, () => "2026-11-08T12:00:00.000Z");
    seedThread(first.svc);
    const { message } = first.svc.store.postMessage({
      threadId: "task/t1", sender: WORKER_A, recipientIds: ["worker-b"],
      kind: "update", body: "status before crash", idempotencyKey: "restart-key-3",
    });
    first.db.close();

    // --- restart: recovery re-plans queued deliveries ---
    first = openService(file, () => "2026-11-08T12:01:00.000Z");
    const pending = first.svc.store.pendingDeliveryMessageIds();
    assert.ok(pending.includes(message.messageId));
    const stored = first.svc.store.getMessage(message.messageId);
    const plan = planDelivery(stored, first.svc.store.getThread("task/t1"), {
      isAvailable: () => true,
      leadFor: () => null,
      coordinatorId: () => null,
      ownerId: () => "owner",
      isOwnerSleeping: () => false,
    }, false);
    assert.deepEqual(plan.wake, ["worker-b"]);
    const receipts = first.svc.store.updateReceipts(
      stored,
      plan.wake.map((recipientId) => ({ recipientId, state: "delivered" as const })),
      first.db.buildEvent({
        eventId: "evt-recovery-1",
        eventType: "message.delivered",
        occurredAt: "2026-11-08T12:01:00.000Z",
        projectId: "p1",
        taskId: "t1",
        actor: { type: "agent", id: "worker-a" },
        data: { messageId: message.messageId, recovered: true },
      }),
    );
    assert.equal(receipts[0].state, "delivered");
    assert.deepEqual(first.svc.store.pendingDeliveryMessageIds(), []);
    first.db.close();
  });
});

describe("outbox crash recovery", () => {
  it("claimed-but-undelivered events are requeued after a crash, never duplicated", () => {
    const dir = mkdtempSync(join(tmpdir(), "ff-msg-"));
    dirs.push(dir);
    const file = join(dir, "messages.sqlite");
    let first = openService(file, () => "2026-11-08T12:00:00.000Z");
    seedThread(first.svc);
    first.svc.send_message(as(WORKER_A), {
      threadId: "task/t1", kind: "update", body: "hello",
      recipientIds: ["worker-b"], idempotencyKey: "restart-key-4",
    });
    const claimed = first.db.claimOutbox(10, "2026-11-08T12:00:30.000Z");
    assert.ok(claimed.length >= 1);
    const firstId = claimed[0].eventId;
    // Crash before markOutboxDelivered: nothing marked, claim persists.
    first.db.close();

    first = openService(file, () => "2026-11-08T12:05:00.000Z");
    // Stale claims (older than 60s) are recovered...
    const requeued = first.db.requeueStaleClaims(60_000, "2026-11-08T12:05:00.000Z");
    assert.ok(requeued >= 1);
    // ...and the same event is claimed exactly once more, not duplicated.
    const again = first.db.claimOutbox(10, "2026-11-08T12:05:00.000Z");
    assert.ok(again.some((c) => c.eventId === firstId));
    assert.equal(again.filter((c) => c.eventId === firstId).length, 1);
    first.db.markOutboxDelivered(firstId, "2026-11-08T12:05:01.000Z");
    const after = first.db.claimOutbox(10, "2026-11-08T12:05:02.000Z");
    assert.ok(!after.some((c) => c.eventId === firstId));
    first.db.close();
  });

  it("failed posts leave no partial rows (no ack for uncommitted state)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ff-msg-"));
    dirs.push(dir);
    const file = join(dir, "messages.sqlite");
    const first = openService(file, () => "2026-11-08T12:00:00.000Z");
    seedThread(first.svc);
    first.svc.store.postMessage({
      threadId: "task/t1", sender: WORKER_A,
      kind: "update", body: "ok", idempotencyKey: "restart-key-5",
    });
    const before = first.svc.store.readThread("task/t1", WORKER_B).messages.length;
    assert.throws(() =>
      first.svc.store.postMessage({
        threadId: "task/t1", sender: WORKER_A,
        kind: "update", body: "conflicting payload", idempotencyKey: "restart-key-5",
      }),
    );
    assert.equal(first.svc.store.readThread("task/t1", WORKER_B).messages.length, before);
    first.db.close();
  });
});
