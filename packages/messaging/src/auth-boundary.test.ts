/**
 * E10 / FF-014 — Public-boundary authority tests (coordinator review).
 *
 * The facade mints identity ONLY from backend-verified credentials.
 * These tests attack the public boundary directly:
 * - forged bearer tokens and owner sessions are rejected;
 * - a smuggled `via` string is ignored (the backend-verified transport wins);
 * - smuggled `sender`/`actorId`/`role` keys in the input body are ignored
 *   (the sender is set from the verified identity after the spread);
 * - unbound worker filings are rejected;
 * - cross-project reads are rejected;
 * - with no backend wired, every credential is denied (fail-closed).
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessagingService, type BackendAuthPort } from "./mcp.ts";
import { BRIDGE_CRED, OWNER_CRED, fakeAuth } from "./test-helpers.ts";
import { MessagingDb } from "./sqlite.ts";
import { MessageError } from "./types.ts";

const dbs: MessagingDb[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(auth?: BackendAuthPort) {
  const dir = mkdtempSync(join(tmpdir(), "ff-msg-"));
  dirs.push(dir);
  let n = 0;
  const db = new MessagingDb(join(dir, "messages.sqlite"));
  dbs.push(db);
  const svc = new MessagingService(db, auth ?? fakeAuth(), {
    generateId: () => `id-${++n}`,
    now: () => "2026-11-08T12:00:00.000Z",
  });
  svc.store.createThread({
    channel: "task/t1", projectId: "p1", taskId: "t1",
    acl: ["worker-a", "worker-b", "owner", "orca-bridge"], threadId: "task/t1",
  });
  return svc;
}

describe("public-boundary authority", () => {
  it("forged tokens and sessions are rejected; deny-all is the default", () => {
    const svc = setup();
    assert.throws(
      () => svc.send_message({ transport: "service-token", token: "forged" }, {
        threadId: "task/t1", kind: "update", body: "hi", idempotencyKey: "key-auth-11",
      }),
      (e: unknown) => e instanceof MessageError && e.httpStatus === 403,
    );
    assert.throws(
      () => svc.read_thread({ transport: "owner-session", sessionId: "forged" }, { threadId: "task/t1" }),
      (e: unknown) => e instanceof MessageError && e.httpStatus === 403,
    );
    const dir = mkdtempSync(join(tmpdir(), "ff-msg-"));
    dirs.push(dir);
    const db = new MessagingDb(join(dir, "locked.sqlite"));
    dbs.push(db);
    const bare = new MessagingService(db);
    bare.store.createThread({
      channel: "task/t1", projectId: "p1", taskId: "t1", acl: ["owner"], threadId: "task/t1",
    });
    assert.throws(
      () => bare.send_message(BRIDGE_CRED, { threadId: "task/t1", kind: "update", body: "hi", idempotencyKey: "key-auth-12" }),
      (e: unknown) => e instanceof MessageError && e.httpStatus === 403,
    );
  });

  it("a smuggled via string cannot upgrade a service token to an owner session", () => {
    const svc = setup();
    const decision = svc.request_decision(OWNER_CRED, {
      projectId: "p1", question: "Merge?", options: ["yes", "no"], risk: "r",
    });
    // Attacker presents a valid service token but asserts via owner-session.
    const forged = { transport: "service-token", token: "tok-bridge", via: "owner-session" };
    assert.throws(
      () => svc.answer_decision(forged, { decisionId: decision.decisionId, answer: "yes" }),
      (e: unknown) => e instanceof MessageError && e.httpStatus === 403,
    );
    assert.equal(svc.escalationStore.getDecision(decision.decisionId).status, "pending");
    // The legitimate owner session still answers.
    const { decision: answered } = svc.answer_decision(OWNER_CRED, { decisionId: decision.decisionId, answer: "yes" });
    assert.equal(answered.status, "answered");
  });

  it("smuggled sender/actorId/role keys in the input are ignored", () => {
    const svc = setup();
    const res = svc.send_message(OWNER_CRED, {
      threadId: "task/t1", kind: "update", body: "owner note",
      idempotencyKey: "key-auth-13",
      sender: { type: "agent", id: "worker-a", role: "worker" },
      actorId: "worker-a",
      role: "coordinator",
    } as unknown as { threadId: string; kind: "update"; body: string; idempotencyKey: string });
    assert.equal(res.message.sender.id, "owner");
    assert.equal(res.message.sender.role, "owner");
    const filed = svc.file_runtime_message({ ...BRIDGE_CRED, workerId: "worker-a" }, {
      projectId: "p1", taskId: "t1", workerId: "worker-a", kind: "update",
      body: "status", idempotencyKey: "key-auth-14", externalId: "orca:auth-14",
    });
    assert.equal(filed.message.sender.id, "worker-a");
    assert.equal(filed.message.sender.role, "worker");
  });

  it("unbound worker filings are rejected even with a valid token", () => {
    const svc = setup();
    assert.throws(
      () => svc.file_runtime_message({ ...BRIDGE_CRED, workerId: "worker-evil" }, {
        projectId: "p1", taskId: "t1", workerId: "worker-evil", kind: "update",
        body: "spoofed", idempotencyKey: "key-auth-15", externalId: "orca:auth-15",
      }),
      (e: unknown) => e instanceof MessageError && e.httpStatus === 403,
    );
    // A caller-asserted workerId that the backend did not bind is ignored:
    // filing lands on the bound worker or is rejected, never the asserted one.
    assert.throws(
      () => svc.file_runtime_message(BRIDGE_CRED, {
        projectId: "p1", taskId: "t1", workerId: "worker-a", kind: "update",
        body: "no binding presented", idempotencyKey: "key-auth-16", externalId: "orca:auth-16",
      }),
      (e: unknown) => e instanceof MessageError && e.httpStatus === 403,
    );
  });

  it("cross-project reads are rejected at the facade", () => {
    const svc = setup();
    svc.store.createThread({
      channel: "task/t9", projectId: "p9", taskId: "t9",
      acl: ["owner"], threadId: "task/t9",
    });
    assert.throws(
      () => svc.read_thread(BRIDGE_CRED, { threadId: "task/t9" }),
      (e: unknown) => e instanceof MessageError && e.httpStatus === 403,
    );
    const read = svc.read_thread(OWNER_CRED, { threadId: "task/t9" });
    assert.equal(read.messages.length, 0);
  });
});
