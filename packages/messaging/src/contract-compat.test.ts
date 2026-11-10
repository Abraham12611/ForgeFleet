/**
 * E10 / FF-014 — Frozen-contract envelope compatibility (bridge v0.1).
 *
 * Every outbox event this package emits must carry the frozen
 * `BridgeEvent` envelope (`packages/bridge-contracts`, CONTRACT-VERSION
 * 0.1.0): required fields present, `schemaVersion` const "0.1", a known
 * `message.*`/`decision.*` event type, and a contract `{type, id}`
 * actor. The repo's own Python validator (`validate_bridge_event`) is
 * the cross-language proof, run as PR evidence across all six emitted
 * types; this suite locks the envelope shape for every producer path.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessagingService } from "./mcp.ts";
import { MessagingDb } from "./sqlite.ts";
import type { Actor, AuthenticatedCaller, BridgeEvent, EventType } from "./types.ts";

const WORKER_A: Actor = { type: "agent", id: "worker-a", role: "worker", projects: ["p1"] };
const OWNER: Actor = { type: "human", id: "owner", role: "owner" };

const as = (identity: Actor): AuthenticatedCaller => ({ identity, via: "test-harness" });

const EMITTED_TYPES: readonly EventType[] = [
  "message.posted",
  "message.delivered",
  "decision.requested",
  "decision.answered",
  "decision.expired",
  "decision.withdrawn",
];

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
  let clock = "2026-11-08T12:00:00.000Z";
  const db = new MessagingDb(join(dir, "messages.sqlite"));
  dbs.push(db);
  const svc = new MessagingService(db, { generateId: () => `id-${++n}`, now: () => clock });
  svc.store.createThread({
    channel: "task/t1", projectId: "p1", taskId: "t1",
    acl: ["worker-a", "owner"], threadId: "task/t1",
  });
  return { svc, db, setClock: (t: string) => { clock = t; } };
}

function assertFrozenEnvelope(event: BridgeEvent): void {
  assert.ok(event.eventId, "eventId required");
  assert.equal(event.schemaVersion, "0.1", "frozen schema version");
  assert.ok((EMITTED_TYPES as readonly string[]).includes(event.eventType), `known emitted type: ${event.eventType}`);
  assert.ok(event.occurredAt && !Number.isNaN(Date.parse(event.occurredAt)), "occurredAt is ISO time");
  assert.ok(event.source, "source required");
  assert.ok(event.projectId, "projectId required");
  assert.ok(event.actor && event.actor.id && event.actor.type, "contract actor {type,id} required");
  assert.ok(!("role" in event.actor), "wire actor carries no role (service-side session only)");
  assert.ok(event.data && typeof event.data === "object", "data object required");
}

describe("frozen-contract outbox envelopes (bridge v0.1)", () => {
  it("every emitted event carries the frozen envelope", () => {
    const { svc, db, setClock } = setup();
    svc.send_message(as(WORKER_A), {
      threadId: "task/t1", kind: "question", body: "Approve?",
      recipientIds: ["owner"], severity: "normal",
      deadlineAt: "2026-11-08T16:00:00.000Z", idempotencyKey: "key-env-11",
    });
    const { decision } = svc.escalationStore.raiseEscalation(svc.store, {
      threadId: "task/t1", caller: as(WORKER_A),
      options: ["yes", "no"], evidence: ["e"], ownerOnly: true,
    });
    assert.ok(decision);
    svc.escalationStore.answerDecision(decision.decisionId, as(OWNER), "no");
    const expiring = svc.escalationStore.openDecision({
      projectId: "p1", question: "Stale?", options: ["a"], risk: "r",
      requestedBy: "worker-a", ttlMs: 1,
    });
    setClock("2026-11-08T13:00:00.000Z");
    svc.escalationStore.expireDue();
    const withdrawn = svc.escalationStore.openDecision({
      projectId: "p1", question: "Drop?", options: ["a"], risk: "r", requestedBy: "worker-a",
    });
    svc.escalationStore.withdrawDecision(withdrawn.decisionId, as(OWNER));

    const claims = db.claimOutbox(50, "2026-11-08T13:00:00.000Z");
    const seen = new Set(claims.map((c) => c.event.eventType));
    for (const t of ["message.posted", "message.delivered", "decision.requested", "decision.answered", "decision.expired", "decision.withdrawn"] as const) {
      assert.ok(seen.has(t), `emitted ${t}`);
    }
    for (const claim of claims) assertFrozenEnvelope(claim.event);
    void expiring;
  });
});
