import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AttemptStore,
  type CreateAttemptRequest,
  StoreError,
} from "./attempt-store.ts";

function request(overrides: Partial<CreateAttemptRequest> = {}): CreateAttemptRequest {
  return {
    projectId: "project_123",
    paperclipTaskId: "task_123",
    paperclipRunId: "run_123",
    workerKind: "muse",
    taskTitle: "Do the thing",
    instruction: "scoped prompt, no secrets",
    contextManifestId: "ctx_1",
    lease: { fencingEpoch: 1, leaseToken: "lease-1" },
    ...overrides,
  };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createAttempt idempotency", () => {
  it("concurrent duplicates launch at most once and share one attempt", async () => {
    let launches = 0;
    const store = new AttemptStore({
      dispatch: async () => {
        launches += 1;
        await delay(20);
        return { state: "dispatching", orcaDispatchId: "orca_dispatch_abc" };
      },
    });
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        store.createAttempt("key-abcdef-1234", request()),
      ),
    );
    assert.equal(launches, 1);
    const ids = new Set(results.map((r) => r.attemptId));
    assert.equal(ids.size, 1);
    assert.ok(results.some((r) => r.deduplicated));
  });

  it("replays the same attempt for the same key and payload", async () => {
    let launches = 0;
    const store = new AttemptStore({
      dispatch: async () => {
        launches += 1;
        return { state: "running", orcaDispatchId: "ext-1" };
      },
    });
    const first = await store.createAttempt("replay-key-1", request());
    const second = await store.createAttempt("replay-key-1", request());
    assert.equal(first.attemptId, second.attemptId);
    assert.equal(second.deduplicated, true);
    assert.equal(launches, 1);
  });

  it("rejects the same key with a different payload (409, no side effect)", async () => {
    let launches = 0;
    const store = new AttemptStore({
      dispatch: async () => {
        launches += 1;
        return { state: "running", orcaDispatchId: "ext-1" };
      },
    });
    await store.createAttempt("conflict-key", request());
    await assert.rejects(
      store.createAttempt(
        "conflict-key",
        request({ paperclipTaskId: "task_OTHER" }),
      ),
      (error: unknown) =>
        error instanceof StoreError &&
        error.code === "idempotency_conflict" &&
        error.status === 409,
    );
    assert.equal(launches, 1);
  });

  it("rejects a second active attempt for the same task (409, no dispatch)", async () => {
    let launches = 0;
    const store = new AttemptStore({
      dispatch: async () => {
        launches += 1;
        return { state: "running", orcaDispatchId: `ext-${launches}` };
      },
    });
    await store.createAttempt("first-key-1", request());
    await assert.rejects(
      store.createAttempt("second-key-2", request({ lease: { fencingEpoch: 2, leaseToken: "lease-2" } })),
      (error: unknown) =>
        error instanceof StoreError &&
        error.code === "active_lease" &&
        error.status === 409,
    );
    assert.equal(launches, 1);
  });

  it("serializes racing keys for the same task to exactly one winner", async () => {
    let launches = 0;
    const store = new AttemptStore({
      dispatch: async () => {
        launches += 1;
        await delay(10);
        return { state: "running", orcaDispatchId: `ext-${launches}` };
      },
    });
    const outcomes = await Promise.allSettled([
      store.createAttempt("race-key-aaa", request()),
      store.createAttempt("race-key-bbb", request()),
    ]);
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(launches, 1);
  });

  it("validates idempotency keys and required fields (422)", async () => {
    const store = new AttemptStore();
    await assert.rejects(
      store.createAttempt("short", request()),
      (e: unknown) => e instanceof StoreError && e.status === 422,
    );
    await assert.rejects(
      store.createAttempt("valid-key-123", request({ projectId: "" })),
      (e: unknown) => e instanceof StoreError && e.status === 422,
    );
  });

  it("requires a strictly greater fencing epoch for replacements", async () => {
    const store = new AttemptStore({
      dispatch: async () => ({ state: "running", orcaDispatchId: "ext-1" }),
    });
    const first = await store.createAttempt("epoch-key-1", request());
    store.confirmTermination(first.attemptId, "failed", "worker exited 1");
    await assert.rejects(
      store.createAttempt(
        "epoch-key-2",
        request({ lease: { fencingEpoch: 1, leaseToken: "lease-2" } }),
      ),
      (e: unknown) => e instanceof StoreError && e.code === "stale_epoch",
    );
    const second = await store.createAttempt(
      "epoch-key-2",
      request({ lease: { fencingEpoch: 2, leaseToken: "lease-2" } }),
    );
    assert.notEqual(second.attemptId, first.attemptId);
  });

  it("marks attempts failed when the launcher throws, keeping replay stable", async () => {
    const store = new AttemptStore({
      dispatch: async () => {
        throw new Error("orca unreachable");
      },
    });
    const first = await store.createAttempt("boom-key-123", request());
    assert.equal(first.state, "failed");
    const second = await store.createAttempt("boom-key-123", request());
    assert.equal(second.attemptId, first.attemptId);
    assert.equal(second.deduplicated, true);
  });
});

describe("applyRuntimeEvent", () => {
  async function startedStore() {
    const store = new AttemptStore({
      dispatch: async () => ({ state: "dispatching", orcaDispatchId: "ext-9" }),
    });
    const receipt = await store.createAttempt("evt-key-123", request());
    return { store, attemptId: receipt.attemptId };
  }

  it("dedupes triple-delivered and reordered events to one outcome", async () => {
    const { store, attemptId } = await startedStore();
    const payload = { attemptId, fencingEpoch: 1 };
    const events = [
      { source: "orca-bridge", sourceEventId: "e1", eventType: "attempt.started" },
      { source: "orca-bridge", sourceEventId: "e1", eventType: "attempt.started" },
      { source: "orca-bridge", sourceEventId: "e2", eventType: "attempt.heartbeat" },
      { source: "orca-bridge", sourceEventId: "e1", eventType: "attempt.started" },
      { source: "orca-bridge", sourceEventId: "e3", eventType: "attempt.finished" },
      { source: "orca-bridge", sourceEventId: "e2", eventType: "attempt.heartbeat" },
    ];
    let applied = 0;
    let deduplicated = 0;
    for (const e of events) {
      const r = store.applyRuntimeEvent({ ...e, payload, attemptId, fencingEpoch: 1 });
      if (r.applied) applied += 1;
      if (r.deduplicated) deduplicated += 1;
    }
    assert.equal(applied, 3);
    assert.equal(deduplicated, 3);
    assert.equal(store.getAttempt(attemptId).state, "finished");
  });

  it("ignores heartbeats from a fenced (older) epoch", async () => {
    const { store, attemptId } = await startedStore();
    const r = store.applyRuntimeEvent({
      source: "orca-bridge",
      sourceEventId: "stale-1",
      payload: { attemptId },
      attemptId,
      eventType: "attempt.heartbeat",
      fencingEpoch: 0,
    });
    // fencingEpoch 0 < 1: stale, no transition, but receipt recorded.
    assert.equal(r.applied, false);
    assert.equal(store.getAttempt(attemptId).state, "dispatching");
    const replay = store.applyRuntimeEvent({
      source: "orca-bridge",
      sourceEventId: "stale-1",
      payload: { attemptId },
      attemptId,
      eventType: "attempt.heartbeat",
      fencingEpoch: 0,
    });
    assert.equal(replay.deduplicated, true);
  });

  it("never acknowledges a receipt without its outbox write", async () => {
    const { store, attemptId } = await startedStore();
    const before = store.pendingOutboundCount();
    store.applyRuntimeEvent({
      source: "orca-bridge",
      sourceEventId: "atomic-1",
      payload: { attemptId },
      attemptId,
      eventType: "attempt.started",
      fencingEpoch: 1,
    });
    assert.equal(store.pendingOutboundCount(), before + 1);
    const again = store.applyRuntimeEvent({
      source: "orca-bridge",
      sourceEventId: "atomic-1",
      payload: { attemptId },
      attemptId,
      eventType: "attempt.started",
      fencingEpoch: 1,
    });
    assert.equal(again.deduplicated, true);
    assert.equal(store.pendingOutboundCount(), before + 1);
  });
});

describe("outbox", () => {
  it("claims due entries and marks them delivered", async () => {
    const now = Date.parse("2026-11-08T12:00:00.000Z");
    const store = new AttemptStore({ now: () => now });
    assert.equal(store.claimDueOutbound().length, 0);
    await store.createAttempt("ob-key-1234", request());
    const due = store.claimDueOutbound();
    const accepted = due.find((e) => e.eventType === "attempt.accepted");
    assert.ok(accepted);
    const pendingBefore = store.pendingOutboundCount();
    store.markDelivered(accepted!.id);
    assert.equal(store.pendingOutboundCount(), pendingBefore - 1);
    assert.ok(!store.claimDueOutbound().some((e) => e.id === accepted!.id));
  });

  it("retries with backoff and dead-letters after the limit", async () => {
    let now = Date.parse("2026-11-08T12:00:00.000Z");
    const store = new AttemptStore({
      now: () => now,
      maxOutboxAttempts: 3,
      outboxBaseDelayMs: 1000,
    });
    await store.createAttempt("dlq-key-1234", request());
    const first = store.claimDueOutbound().find((e) => e.eventType === "attempt.accepted");
    assert.ok(first);
    store.markDeliveryFailed(first!.id, "paperclip unreachable");
    assert.equal(store.claimDueOutbound().length, 0);
    now += 1000;
    assert.equal(store.claimDueOutbound().length, 1);
    store.markDeliveryFailed(first!.id, "paperclip unreachable");
    now += 2000;
    assert.equal(store.claimDueOutbound().length, 1);
    store.markDeliveryFailed(first!.id, "paperclip unreachable");
    const dead = store.listDeadLetter();
    assert.equal(dead.length, 1);
    assert.match(dead[0]!.deadLetterReason ?? "", /gave up after 3 attempts/);
    assert.equal(store.claimDueOutbound().length, 0);
  });
});

describe("restart reconciliation", () => {
  it("reconciles the original dispatch after a crash instead of relaunching", async () => {
    let launches = 0;
    let crashedBeforeReplyPersist = false;
    const options = {
      dispatch: async () => {
        launches += 1;
        crashedBeforeReplyPersist = true;
        // Crash window: reply accepted by the runtime but the process dies
        // before recordExternalDispatch persists it. Simulate by throwing
        // away the reply below via snapshot surgery in the test.
        return { state: "dispatching" as const, orcaDispatchId: "ext-crash-1" };
      },
    };
    const before = new AttemptStore(options);
    const created = await before.createAttempt("crash-key-123", request());
    assert.ok(crashedBeforeReplyPersist);
    // Simulate the crash: strip the reply the dead process never persisted.
    const snap = before.snapshot();
    const victim = snap.attempts.find((a) => a.attemptId === created.attemptId)!;
    victim.orcaDispatchId = undefined;
    victim.state = "accepted";
    const after = AttemptStore.restore(snap, {
      dispatch: async () => {
        launches += 1;
        return { state: "dispatching" as const, orcaDispatchId: "ext-should-never-happen" };
      },
    });
    const report = after.reconcileAfterRestart([
      {
        externalDispatchId: "ext-crash-1",
        paperclipTaskId: "task_123",
        leaseToken: "lease-1",
        state: "running",
      },
    ]);
    assert.deepEqual(report.adopted, [created.attemptId]);
    assert.deepEqual(report.markedUnknown, []);
    assert.equal(after.getAttempt(created.attemptId).state, "running");
    assert.equal(
      after.getAttempt(created.attemptId).orcaDispatchId,
      "ext-crash-1",
    );
    assert.equal(launches, 1);
  });

  it("marks unobserved attempts unknown and blocks relaunch until proof", async () => {
    const store = new AttemptStore({
      dispatch: async () => ({ state: "running", orcaDispatchId: "ext-gone" }),
    });
    const created = await store.createAttempt("gone-key-123", request());
    const report = store.reconcileAfterRestart([]);
    assert.deepEqual(report.markedUnknown, [created.attemptId]);
    assert.equal(store.getAttempt(created.attemptId).state, "unknown");
    assert.equal(store.canDispatch("project_123", "task_123"), false);
    // Proof of termination releases the lease; unknown alone never does.
    store.confirmTermination(created.attemptId, "failed", "worktree ps shows no such terminal");
    assert.equal(store.canDispatch("project_123", "task_123"), true);
  });
});
