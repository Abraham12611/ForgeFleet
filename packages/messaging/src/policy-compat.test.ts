/**
 * E10 / FF-014 — Policy compatibility with FF-004 (#33) and the
 * `docs/05-contracts/policy-matrix.md`.
 *
 * Encodes the FF-004 semantics this package depends on so a divergence
 * is caught here: same-project + thread-ACL posting, cross-project
 * denial, stolen/confused session-scope denial, owner spanning
 * projects, closed world. Transport proof (service-token vs
 * owner-session) lives in the facade (`auth-boundary.test.ts`); the
 * store seam takes plain identities and never interprets transports.
 *
 * Full convergence (single `authorize()` source) is E07's #33/#53 work;
 * the seam is the injected `PolicyPort` keyed on verified identities.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "node:test";
import { MessagingDb } from "./sqlite.ts";
import { ThreadStore, defaultPolicy } from "./thread-store.ts";
import type { Actor } from "./types.ts";

const WORKER_A: Actor = { type: "agent", id: "worker-a", role: "worker", projects: ["p1"] };
const OWNER: Actor = { type: "human", id: "owner", role: "owner" };

const dbs: MessagingDb[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function thread() {
  const dir = mkdtempSync(join(tmpdir(), "ff-msg-"));
  dirs.push(dir);
  const db = new MessagingDb(join(dir, "messages.sqlite"));
  dbs.push(db);
  const store = new ThreadStore({ db });
  store.createThread({
    channel: "task/t1", projectId: "p1", taskId: "t1",
    acl: ["worker-a", "owner", "role:coordinator"], threadId: "task/t1",
  });
  return store.getThread("task/t1");
}

describe("policy compatibility (FF-004 matrix parity)", () => {
  it("same-project + thread-ACL actor may post and read; outsiders may not", () => {
    const policy = defaultPolicy();
    const t = thread();
    assert.equal(policy.canPost(WORKER_A, t), true);
    assert.equal(policy.canRead(WORKER_A, t), true);
    const outsider: Actor = { type: "agent", id: "worker-x", role: "worker", projects: ["p2"] };
    assert.equal(policy.canPost(outsider, t), false);
    assert.equal(policy.canRead(outsider, t), false);
  });

  it("owner spans projects; unknown ids are denied (closed world)", () => {
    const policy = defaultPolicy();
    const t = thread();
    assert.equal(policy.canPost(OWNER, t), true);
    // ACLs are identity-based: an unknown id is denied even with a
    // well-formed role; role shape is validated at the facade boundary.
    const stranger: Actor = { type: "agent", id: "nobody", role: "worker", projects: ["p1"] };
    assert.equal(policy.canPost(stranger, t), false);
    assert.equal(policy.canRead(stranger, t), false);
  });

  it("stolen/confused session scope is denied (SESSION_SCOPE_MISMATCH parity)", () => {
    const policy = defaultPolicy();
    const t = thread();
    const confused: Actor = { ...WORKER_A, sessionProjectId: "p2" };
    assert.equal(policy.canPost(confused, t), false);
    assert.equal(policy.canRead(confused, t), false);
    const same: Actor = { ...WORKER_A, sessionProjectId: "p1" };
    assert.equal(policy.canPost(same, t), true);
  });
});
