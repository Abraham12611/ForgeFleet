/**
 * FF-031 trusted scheduler lease: unit proof for the HMAC grant verifier.
 * Offline, no bridge, no backend. Each P0 refusal mode from the coordinator
 * directive gets its own case: forged task in an allowed project, replay
 * under a new key, expired grant, wrong run, stale epoch — plus the
 * idempotent same-key retry the crash-reconcile path depends on and the
 * fail-closed deny-all default.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createHmacLeaseVerifier,
  denyAllLeaseVerifier,
  issueSchedulerLease,
} from "./scheduler-lease.ts";

const SECRET = "unit-test-lease-secret";
const NOW = 1_700_000_000_000;

function mint(overrides: Record<string, unknown> = {}): { token: string; exp: number } {
  const { leaseToken, expiresAtMs } = issueSchedulerLease({
    secret: SECRET,
    projectId: "proj-a",
    taskId: "task-1",
    runId: "r1",
    fencingEpoch: 1,
    ttlMs: 600_000,
    nowMs: NOW,
    nonce: `n-${Math.random().toString(36).slice(2)}`,
    ...overrides,
  } as Parameters<typeof issueSchedulerLease>[0]);
  return { token: leaseToken, exp: expiresAtMs };
}

function grantFor(token: string, overrides: Record<string, unknown> = {}) {
  return {
    projectId: "proj-a",
    taskId: "task-1",
    runId: "r1",
    fencingEpoch: 1,
    leaseToken: token,
    ...overrides,
  };
}

test("a scheduler-signed grant verifies for its exact project/task/run/epoch", () => {
  const verifier = createHmacLeaseVerifier({ secret: SECRET });
  const { token } = mint();
  assert.deepEqual(verifier.verify(grantFor(token), { idempotencyKey: "k-1", nowMs: NOW }), {
    ok: true,
  });
});

test("forged task in an allowed project is refused (token bound to another task)", () => {
  const verifier = createHmacLeaseVerifier({ secret: SECRET });
  const { token } = mint();
  const result = verifier.verify(grantFor(token, { taskId: "task-evil" }), {
    idempotencyKey: "k-evil",
    nowMs: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "lease_unverified");
});

test("garbage token with no scheduler signature is refused", () => {
  const verifier = createHmacLeaseVerifier({ secret: SECRET });
  const result = verifier.verify(grantFor("not-a-signed-grant"), {
    idempotencyKey: "k-1",
    nowMs: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "lease_unverified");
});

test("token signed under a different secret is refused", () => {
  const verifier = createHmacLeaseVerifier({ secret: SECRET });
  const { token } = mint({ secret: "attacker-secret" });
  const result = verifier.verify(grantFor(token), { idempotencyKey: "k-1", nowMs: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.code, "lease_unverified");
});

test("wrong-run presentation of a valid grant is refused", () => {
  const verifier = createHmacLeaseVerifier({ secret: SECRET });
  const { token } = mint();
  const result = verifier.verify(grantFor(token, { runId: "r2" }), {
    idempotencyKey: "k-1",
    nowMs: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "lease_run_mismatch");
});

test("expired grant is refused", () => {
  const verifier = createHmacLeaseVerifier({ secret: SECRET });
  const { token } = mint({ ttlMs: -1 });
  const result = verifier.verify(grantFor(token), { idempotencyKey: "k-1", nowMs: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.code, "lease_expired");
});

test("same token under a different idempotency key is a replay and refused", () => {
  const verifier = createHmacLeaseVerifier({ secret: SECRET });
  const { token } = mint();
  assert.equal(verifier.verify(grantFor(token), { idempotencyKey: "k-1", nowMs: NOW }).ok, true);
  const replay = verifier.verify(grantFor(token), { idempotencyKey: "k-2", nowMs: NOW });
  assert.equal(replay.ok, false);
  assert.equal(replay.code, "lease_replay");
});

test("same token under the same key verifies idempotently (crash-retry path)", () => {
  const verifier = createHmacLeaseVerifier({ secret: SECRET });
  const { token } = mint();
  assert.equal(verifier.verify(grantFor(token), { idempotencyKey: "k-1", nowMs: NOW }).ok, true);
  assert.equal(verifier.verify(grantFor(token), { idempotencyKey: "k-1", nowMs: NOW }).ok, true);
});

test("a superseded epoch is refused as stale", () => {
  const verifier = createHmacLeaseVerifier({ secret: SECRET });
  const epoch3 = mint({ fencingEpoch: 3, nonce: "n3" });
  assert.equal(
    verifier.verify(grantFor(epoch3.token, { fencingEpoch: 3 }), {
      idempotencyKey: "k-3",
      nowMs: NOW,
    }).ok,
    true,
  );
  const stale = mint({ fencingEpoch: 1, nonce: "n1" });
  const result = verifier.verify(grantFor(stale.token, { fencingEpoch: 1 }), {
    idempotencyKey: "k-1",
    nowMs: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "lease_stale_epoch");
});

test("a token minted for task-1 reused for task-2 is refused", () => {
  const verifier = createHmacLeaseVerifier({ secret: SECRET });
  const { token } = mint();
  assert.equal(verifier.verify(grantFor(token), { idempotencyKey: "k-1", nowMs: NOW }).ok, true);
  const crossTask = verifier.verify(grantFor(token, { taskId: "task-2" }), {
    idempotencyKey: "k-2",
    nowMs: NOW,
  });
  assert.equal(crossTask.ok, false);
  // Exact task binding fails before the replay check: the grant never
  // authorized task-2, so it is unverified rather than a replay.
  assert.equal(crossTask.code, "lease_unverified");
});

test("deny-all default refuses every grant", () => {
  const verifier = denyAllLeaseVerifier();
  const { token } = mint();
  const result = verifier.verify(grantFor(token), { idempotencyKey: "k-1", nowMs: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.code, "lease_unverified");
});
