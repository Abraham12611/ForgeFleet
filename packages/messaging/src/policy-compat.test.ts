/**
 * E10 / FF-014 — Policy compatibility with FF-004 (#33) and the
 * `docs/05-contracts/policy-matrix.md`.
 *
 * Encodes the FF-004 semantics this package depends on so a divergence
 * is caught here: same-project + thread-ACL posting, cross-project
 * denial, stolen/confused session-scope denial, owner spanning
 * projects, unknown-role closed world, and message-never-authority
 * (message content cannot become a transport).
 *
 * Full convergence (single `authorize()` source) is E07's #33/#53 work;
 * the seam is the injected `PolicyPort`, keyed on the authenticated
 * caller — never on message content.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "node:test";
import { MessagingService, requireCaller } from "./mcp.ts";
import { MessagingDb } from "./sqlite.ts";
import { defaultPolicy } from "./thread-store.ts";
import { MessageError, type Actor, type AuthenticatedCaller } from "./types.ts";

const WORKER_A: Actor = { type: "agent", id: "worker-a", role: "worker", projects: ["p1"] };
const OWNER: Actor = { type: "human", id: "owner", role: "owner" };

const as = (identity: Actor): AuthenticatedCaller => ({ identity, via: "test-harness" });

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
  const svc = new MessagingService(db, {
    generateId: () => `id-${++n}`,
    now: () => "2026-11-08T12:00:00.000Z",
  });
  svc.store.createThread({
    channel: "task/t1", projectId: "p1", taskId: "t1",
    acl: ["worker-a", "owner", "role:coordinator"], threadId: "task/t1",
  });
  return svc;
}

describe("policy compatibility (FF-004 matrix parity)", () => {
  it("same-project + thread-ACL actor may post and read; outsiders may not", () => {
    const svc = setup();
    const policy = defaultPolicy();
    const thread = svc.store.getThread("task/t1");
    assert.equal(policy.canPost(WORKER_A, thread), true);
    assert.equal(policy.canRead(WORKER_A, thread), true);
    const outsider: Actor = { type: "agent", id: "worker-x", role: "worker", projects: ["p2"] };
    assert.equal(policy.canPost(outsider, thread), false);
    assert.equal(policy.canRead(outsider, thread), false);
  });

  it("owner spans projects; unknown roles are denied (closed world)", () => {
    const svc = setup();
    const policy = defaultPolicy();
    const thread = svc.store.getThread("task/t1");
    assert.equal(policy.canPost(OWNER, thread), true);
    // ACLs are identity-based: an unknown id is denied even with a known
    // role shape, and an unknown role is rejected at the facade boundary.
    const stranger: Actor = { type: "agent", id: "nobody", role: "worker", projects: ["p1"] };
    assert.equal(policy.canPost(stranger, thread), false);
    assert.throws(
      () => requireCaller({ identity: { ...WORKER_A, role: "stranger" }, via: "test-harness" }),
      (e: unknown) => e instanceof MessageError && e.httpStatus === 400,
    );
  });

  it("stolen/confused session scope is denied (SESSION_SCOPE_MISMATCH parity)", () => {
    const svc = setup();
    const policy = defaultPolicy();
    const thread = svc.store.getThread("task/t1");
    const confused: Actor = { ...WORKER_A, sessionProjectId: "p2" };
    assert.equal(policy.canPost(confused, thread), false);
    assert.equal(policy.canRead(confused, thread), false);
    assert.equal(svc.send_message !== undefined, true);
    assert.throws(
      () => svc.send_message(as(confused), { threadId: "task/t1", kind: "update", body: "hi", idempotencyKey: "key-scope-1" }),
      (e: unknown) => e instanceof MessageError && e.httpStatus === 403,
    );
  });

  it("message content can never become a transport (claimedViaMessage parity)", () => {
    assert.throws(
      () => requireCaller({ identity: WORKER_A, via: "message" }),
      (e: unknown) => e instanceof MessageError && e.httpStatus === 403,
    );
    assert.throws(
      () => requireCaller({ identity: WORKER_A, via: "chat-utterance" }),
      (e: unknown) => e instanceof MessageError && e.httpStatus === 403,
    );
  });
});
