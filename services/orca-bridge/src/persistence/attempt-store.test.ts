import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  assertSafeDbFile,
  AttemptStore,
  type CreateAttemptRequest,
  StoreError,
} from "./attempt-store.ts";

const FIXTURES = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "bridge-contracts",
  "tests",
  "fixtures",
);

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

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
    ...(overrides as Record<string, unknown>),
  } as CreateAttemptRequest;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Simulate process death: the runtime accepted, the bridge dies first. */
class SimulatedCrash extends Error {
  constructor() {
    super("simulated crash before reply persist");
    this.name = "SimulatedCrash";
  }
}

describe("createAttempt idempotency (durable)", () => {
  let stores: AttemptStore[] = [];
  beforeEach(() => {
    stores = [];
  });
  afterEach(() => {
    for (const s of stores) s.close();
  });
  function open(options: ConstructorParameters<typeof AttemptStore>[0] = {}) {
    const s = new AttemptStore({ testMode: true, ...options });
    stores.push(s);
    return s;
  }

  it("concurrent duplicates launch at most once and share one attempt", async () => {
    let launches = 0;
    const store = open({
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
    const ids = new Set(results.map((r) => r.receipt.attemptId));
    assert.equal(ids.size, 1);
    assert.ok(results.some((r) => r.deduplicated));
    assert.equal(results[0]!.receipt.state, "dispatching");
    assert.equal(results[0]!.receipt.orcaDispatchId, "orca_dispatch_abc");
  });

  it("replays the same attempt for the same key and payload", async () => {
    let launches = 0;
    const store = open({
      dispatch: async () => {
        launches += 1;
        return { state: "running", orcaDispatchId: "ext-1" };
      },
    });
    const first = await store.createAttempt("replay-key-1", request());
    const second = await store.createAttempt("replay-key-1", request());
    assert.equal(first.receipt.attemptId, second.receipt.attemptId);
    assert.equal(first.deduplicated, false);
    assert.equal(second.deduplicated, true);
    assert.equal(launches, 1);
  });

  it("rejects the same key with a different payload (409, no side effect)", async () => {
    let launches = 0;
    const store = open({
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
    const store = open({
      dispatch: async () => {
        launches += 1;
        return { state: "running", orcaDispatchId: `ext-${launches}` };
      },
    });
    await store.createAttempt("first-key-1", request());
    await assert.rejects(
      store.createAttempt(
        "second-key-2",
        request({ lease: { fencingEpoch: 2, leaseToken: "lease-2" } }),
      ),
      (error: unknown) =>
        error instanceof StoreError &&
        error.code === "active_lease" &&
        error.status === 409,
    );
    assert.equal(launches, 1);
  });

  it("serializes racing keys for the same task to exactly one winner", async () => {
    let launches = 0;
    const store = open({
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
    assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((o) => o.status === "rejected").length, 1);
    assert.equal(launches, 1);
  });

  it("validates key length and required fields (422), rejects unknown fields", async () => {
    const store = open();
    await assert.rejects(
      store.createAttempt("short", request()),
      (e: unknown) => e instanceof StoreError && e.status === 422,
    );
    await assert.rejects(
      store.createAttempt("valid-key-123", request({ projectId: "" })),
      (e: unknown) => e instanceof StoreError && e.status === 422,
    );
    await assert.rejects(
      store.createAttempt("valid-key-456", {
        ...request(),
        bogusField: "nope",
      } as unknown as CreateAttemptRequest),
      (e: unknown) =>
        e instanceof StoreError &&
        e.status === 422 &&
        /unknown request fields/.test(e.message),
    );
  });

  it("requires a strictly greater fencing epoch for replacements", async () => {
    let launches = 0;
    const store = open({
      dispatch: async () => {
        launches += 1;
        return { state: "running", orcaDispatchId: `ext-epoch-${launches}` };
      },
    });
    const first = await store.createAttempt("epoch-key-1", request());
    store.confirmTermination(first.receipt.attemptId, "failed", "worker exited 1");
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
    assert.notEqual(second.receipt.attemptId, first.receipt.attemptId);
  });

  it("launcher failure is unknown fate: durable prefix stays, replay never relaunches", async () => {
    let launches = 0;
    const store = open({
      dispatch: async () => {
        launches += 1;
        throw new Error("orca unreachable");
      },
    });
    await assert.rejects(
      store.createAttempt("boom-key-123", request()),
      (e: unknown) =>
        e instanceof StoreError &&
        e.code === "dispatch_unknown" &&
        e.status === 502,
    );
    // The `accepted` prefix survived: same-key retry replays it, no relaunch.
    const retry = await store.createAttempt("boom-key-123", request());
    assert.equal(retry.receipt.state, "accepted");
    assert.equal(retry.deduplicated, true);
    assert.equal(launches, 1);
  });

  it("emits receipts with exactly the contract v0.1.0 fields", async () => {
    const store = open({
      dispatch: async () => ({ state: "running", orcaDispatchId: "ext-1" }),
    });
    const { receipt } = await store.createAttempt("shape-key-12", request());
    const fixture = loadFixture("valid_attempt_receipt.json");
    assert.deepEqual(
      Object.keys(receipt).sort(),
      Object.keys(fixture).sort(),
      "receipt must carry exactly the frozen AttemptReceipt fields",
    );
  });

  it("accepts the frozen valid_create_attempt fixture", async () => {
    const store = open({
      dispatch: async () => ({ state: "dispatching", orcaDispatchId: "ext-fix" }),
    });
    const payload = loadFixture("valid_create_attempt.json");
    const { receipt } = await store.createAttempt(
      "fixture-key-1",
      payload as unknown as CreateAttemptRequest,
    );
    assert.equal(receipt.projectId, "project_123");
    assert.equal(receipt.state, "dispatching");
  });
});

describe("applyRuntimeEvent (durable inbox)", () => {
  let stores: AttemptStore[] = [];
  beforeEach(() => {
    stores = [];
  });
  afterEach(() => {
    for (const s of stores) s.close();
  });

  async function startedStore() {
    const store = new AttemptStore({
      testMode: true,
      dispatch: async () => ({ state: "dispatching", orcaDispatchId: "ext-9" }),
    });
    stores.push(store);
    const { receipt } = await store.createAttempt("evt-key-123", request());
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

  it("ignores heartbeats from a fenced (older) epoch but records the receipt", async () => {
    const { store, attemptId } = await startedStore();
    const r = store.applyRuntimeEvent({
      source: "orca-bridge",
      sourceEventId: "stale-1",
      payload: { attemptId },
      attemptId,
      eventType: "attempt.heartbeat",
      fencingEpoch: 0,
    });
    assert.equal(r.applied, false);
    assert.equal(r.reason, "stale fencing epoch");
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

  it("dedupe keys are namespaced per source", async () => {
    const { store, attemptId } = await startedStore();
    const first = store.applyRuntimeEvent({
      source: "orca-bridge",
      sourceEventId: "ns-1",
      payload: { attemptId },
      attemptId,
      eventType: "attempt.started",
      fencingEpoch: 1,
    });
    const second = store.applyRuntimeEvent({
      source: "paperclip-adapter",
      sourceEventId: "ns-1",
      payload: { attemptId },
      attemptId,
      eventType: "attempt.heartbeat",
      fencingEpoch: 1,
    });
    assert.equal(first.deduplicated, false);
    assert.equal(second.deduplicated, false);
  });
});

describe("outbox (durable)", () => {
  let stores: AttemptStore[] = [];
  beforeEach(() => {
    stores = [];
  });
  afterEach(() => {
    for (const s of stores) s.close();
  });

  it("claims due entries and marks them delivered", async () => {
    const now = Date.parse("2026-11-08T12:00:00.000Z");
    const store = new AttemptStore({ now: () => now, testMode: true });
    stores.push(store);
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
      testMode: true,
    });
    stores.push(store);
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

  it("survives close/reopen with delivery state intact", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ff006-ob-"));
    try {
      const path = join(dir, "bridge.sqlite");
      const first = new AttemptStore({ path });
      await first.createAttempt("persist-ob-1", request());
      const due = first.claimDueOutbound();
      assert.ok(due.length > 0);
      first.markDelivered(due[0]!.id);
      const pendingBefore = first.pendingOutboundCount();
      first.close();
      const second = new AttemptStore({ path });
      stores.push(second);
      assert.equal(second.pendingOutboundCount(), pendingBefore);
      assert.ok(!second.claimDueOutbound().some((e) => e.id === due[0]!.id));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("restart + crash reconciliation (real files)", () => {
  let openHandles: AttemptStore[] = [];
  let dirs: string[] = [];
  beforeEach(() => {
    openHandles = [];
    dirs = [];
  });
  afterEach(() => {
    for (const s of openHandles) {
      try {
        s.close();
      } catch {
        // Already closed by the test; ignore.
      }
    }
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  function dbFile(): string {
    const dir = mkdtempSync(join(tmpdir(), "ff006-"));
    dirs.push(dir);
    return join(dir, "bridge.sqlite");
  }

  it("committed rows survive close/reopen; uncommitted writes do not", async () => {
    const path = dbFile();
    const store = new AttemptStore({
      path,
      dispatch: async () => ({ state: "running", orcaDispatchId: "ext-dur" }),
    });
    openHandles.push(store);
    const { receipt } = await store.createAttempt("durable-key-1", request());
    store.close();

    // A writer that never commits must leave no trace (write-ahead proof).
    const raw = new DatabaseSync(path);
    raw.exec("BEGIN IMMEDIATE;");
    raw.prepare(`UPDATE execution_attempts SET state = 'cancelled' WHERE attempt_id = ?`).run(receipt.attemptId);
    raw.close(); // No COMMIT: SQLite discards the uncommitted transaction.

    const reopened = new AttemptStore({ path });
    openHandles.push(reopened);
    assert.equal(reopened.getAttempt(receipt.attemptId).state, "running");
  });

  it("crash between runtime accept and reply persist reattaches without relaunch", async () => {
    const path = dbFile();
    // Side channel standing in for the runtime's own durable state: the
    // runtime accepted the launch, but the bridge died before persisting
    // the reply (the throw stands in for process death).
    const runtimeAccepted: { externalDispatchId: string }[] = [];
    let launches = 0;
    const crashed = new AttemptStore({
      path,
      dispatch: async () => {
        launches += 1;
        runtimeAccepted.push({ externalDispatchId: "ext-crash-1" });
        throw new SimulatedCrash();
      },
    });
    openHandles.push(crashed);
    await assert.rejects(
      crashed.createAttempt("crash-key-123", request()),
      (e: unknown) => e instanceof StoreError && e.code === "dispatch_unknown",
    );
    // True crash state on disk: `accepted` + claimed, no external IDs,
    // idempotency row kept. Restart = reopen the same file.
    crashed.close();

    const restarted = new AttemptStore({
      path,
      dispatch: async () => {
        launches += 1;
        return { state: "dispatching", orcaDispatchId: "ext-should-never-happen" };
      },
    });
    openHandles.push(restarted);
    const report = restarted.reconcileAfterRestart(
      runtimeAccepted.map((r) => ({
        externalDispatchId: r.externalDispatchId,
        paperclipTaskId: "task_123",
        leaseToken: "lease-1",
        state: "running" as const,
      })),
    );
    const kept = restarted.getAttempt(report.kept[0]!);
    assert.equal(report.kept.length, 1);
    assert.deepEqual(report.heldUnknown, []);
    assert.equal(kept.state, "running");
    assert.equal(kept.orcaDispatchId, "ext-crash-1");
    assert.equal(launches, 1);
  });

  it("marks unobserved attempts unknown and blocks retry until proof (reconcile-before-retry)", async () => {
    const path = dbFile();
    const store = new AttemptStore({
      path,
      dispatch: async () => ({ state: "running", orcaDispatchId: "ext-gone" }),
    });
    openHandles.push(store);
    const { receipt } = await store.createAttempt("gone-key-123", request());
    store.close();

    const restarted = new AttemptStore({ path });
    openHandles.push(restarted);
    const report = restarted.reconcileAfterRestart([]);
    assert.deepEqual(report.heldUnknown, [receipt.attemptId]);
    assert.equal(restarted.getAttempt(receipt.attemptId).state, "unknown");
    // Lease is held: a fenced replacement is refused before proof.
    assert.equal(restarted.canDispatch("project_123", "task_123"), false);
    await assert.rejects(
      restarted.createAttempt(
        "retry-key-123",
        request({ lease: { fencingEpoch: 2, leaseToken: "lease-2" } }),
      ),
      (e: unknown) => e instanceof StoreError && e.code === "active_lease",
    );
    // Proof of termination releases the lease; only then may a fenced
    // replacement (new key, higher epoch) be created.
    restarted.confirmTermination(
      receipt.attemptId,
      "failed",
      "worktree ps shows no such terminal",
    );
    assert.equal(restarted.canDispatch("project_123", "task_123"), true);
    const retry = await restarted.createAttempt(
      "retry-key-123",
      request({ lease: { fencingEpoch: 2, leaseToken: "lease-2" } }),
    );
    assert.equal(retry.receipt.state, "dispatching");
  });

  it("releases provably-ended dispatches and reports orphans without adopting them", async () => {
    const path = dbFile();
    const store = new AttemptStore({
      path,
      dispatch: async () => ({ state: "running", orcaDispatchId: "ext-old" }),
    });
    openHandles.push(store);
    const { receipt } = await store.createAttempt("ended-key-12", request());
    const report = store.reconcileAfterRestart([
      { externalDispatchId: "ext-old", state: "terminal" },
      { externalDispatchId: "ext-orphan-1", state: "running" },
    ]);
    assert.deepEqual(report.releasedTerminal, [receipt.attemptId]);
    assert.deepEqual(report.orphans, ["ext-orphan-1"]);
    assert.equal(store.getAttempt(receipt.attemptId).state, "failed");
    assert.equal(store.canDispatch("project_123", "task_123"), true);
  });
});

describe("constructor durability gates", () => {
  it("fails startup without an explicit path (production has no default)", () => {
    assert.throws(
      () => new AttemptStore(),
      (e: unknown) =>
        e instanceof StoreError &&
        e.status === 500 &&
        /explicit durable database file path/.test(e.message),
    );
  });

  it('fails startup for ":memory:" outside explicit test mode', () => {
    assert.throws(
      () => new AttemptStore({ path: ":memory:" }),
      (e: unknown) =>
        e instanceof StoreError &&
        e.status === 500 &&
        /no crash durability/.test(e.message),
    );
    const testOnly = new AttemptStore({ testMode: true });
    assert.equal(testOnly.databasePath(), null);
    testOnly.close();
  });

  it("fails startup when the database directory does not exist", () => {
    assert.throws(
      () =>
        new AttemptStore({
          path: join(tmpdir(), `ff006-nope-${Date.now()}`, "bridge.sqlite"),
        }),
      (e: unknown) =>
        e instanceof StoreError &&
        e.status === 500 &&
        /database directory does not exist/.test(e.message),
    );
  });

  it("refuses to open a group/world-writable database file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ff006-perm-"));
    try {
      const path = join(dir, "bridge.sqlite");
      const store = new AttemptStore({ path });
      store.close();
      chmodSync(path, 0o666);
      assert.throws(
        () => new AttemptStore({ path }),
        (e: unknown) =>
          e instanceof StoreError &&
          /group\/world-writable/.test((e as Error).message),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assertSafeDbFile policy: own-uid passes, foreign uid and lax modes fail", () => {
    const euid =
      typeof process.getuid === "function" ? process.getuid() : 1000;
    assert.doesNotThrow(() =>
      assertSafeDbFile({ uid: euid, mode: 0o100600 }, euid),
    );
    assert.throws(
      () => assertSafeDbFile({ uid: euid + 100000, mode: 0o100600 }, euid),
      /owned by uid/,
    );
    assert.throws(
      () => assertSafeDbFile({ uid: euid, mode: 0o100666 }, euid),
      /writable/,
    );
    assert.throws(
      () => assertSafeDbFile({ uid: euid, mode: 0o100660 }, euid),
      /writable/,
    );
  });
});

describe("backup and restore", () => {
  it("round-trips through backup file: restore discards post-backup writes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ff006-bak-"));
    try {
      const path = join(dir, "bridge.sqlite");
      const backup = join(dir, "bridge.backup.sqlite");
      let bakLaunches = 0;
      const store = new AttemptStore({
        path,
        dispatch: async () => {
          bakLaunches += 1;
          return { state: "running", orcaDispatchId: `ext-bak-${bakLaunches}` };
        },
      });
      const { receipt: first } = await store.createAttempt(
        "backup-key-1",
        request(),
      );
      store.createBackup(backup);
      assert.ok(existsSync(backup));
      await store.createAttempt(
        "backup-key-2",
        request({
          paperclipTaskId: "task_999",
          lease: { fencingEpoch: 1, leaseToken: "lease-9" },
        }),
      );
      store.restoreFromBackup(backup);
      assert.equal(store.getAttempt(first.attemptId).state, "running");
      assert.throws(
        () => store.getAttempt("00000000-0000-4000-8000-999999999999"),
        (e: unknown) => e instanceof StoreError && e.code === "unknown_attempt",
      );
      store.close();
      // Reopen after restore: WAL replayed, schema verified, data intact.
      const reopened = new AttemptStore({ path });
      assert.equal(reopened.getAttempt(first.attemptId).state, "running");
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses backup/restore for :memory: test databases", () => {
    const store = new AttemptStore({ testMode: true });
    try {
      assert.throws(
        () => store.createBackup(join(tmpdir(), "x.sqlite")),
        /cannot back up a :memory:/,
      );
      assert.throws(
        () => store.restoreFromBackup(join(tmpdir(), "x.sqlite")),
        /cannot restore a :memory:/,
      );
    } finally {
      store.close();
    }
  });
});

describe("cross-process idempotency, fencing and crash (two OS processes)", () => {
  const CHILD = `
import { AttemptStore } from ${JSON.stringify(join(import.meta.dirname, "attempt-store.ts"))};
import { writeFileSync } from "node:fs";
const [dbPath, key, payloadJson, mode, marker] = process.argv.slice(2);
const payload = JSON.parse(payloadJson);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function launcher() {
  if (mode === "slow") {
    return async () => {
      await sleep(1200);
      writeFileSync(marker, "slow");
      return { state: "running", orcaDispatchId: "ext-slow" };
    };
  }
  if (mode === "marker") {
    return async () => {
      writeFileSync(marker, "marker");
      return { state: "running", orcaDispatchId: "ext-marker" };
    };
  }
  if (mode === "crash") {
    return async () => {
      writeFileSync(marker, JSON.stringify({ externalDispatchId: "ext-crashed" }));
      process.exit(137);
    };
  }
  return async () => ({ state: "running", orcaDispatchId: marker ?? "ext-child" });
}
const store = new AttemptStore({ path: dbPath, dispatch: launcher() });
try {
  const result = await store.createAttempt(key, payload);
  console.log(JSON.stringify({ ok: true, attemptId: result.receipt.attemptId, deduplicated: result.deduplicated, state: result.receipt.state, orcaDispatchId: result.receipt.orcaDispatchId ?? null }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error?.code ?? "unknown", status: error?.status ?? 0 }));
}
store.close();
`;

  function childFile(dir: string): string {
    const path = join(dir, "child-worker.ts");
    writeFileSync(path, CHILD);
    return path;
  }

  function runChild(
    child: string,
    args: string[],
  ): { status: number | null; stdout: string; stderr: string } {
    const proc = spawnSync(process.execPath, [child, ...args], {
      encoding: "utf8",
      timeout: 30000,
    });
    return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr };
  }

  function runChildAsync(
    child: string,
    args: string[],
  ): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [child, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d) => {
        stdout += String(d);
      });
      proc.stderr.on("data", (d) => {
        stderr += String(d);
      });
      proc.on("error", reject);
      proc.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  }

  it("two processes, one key: exactly one runtime launch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ff006-xproc-"));
    try {
      const child = childFile(dir);
      const dbPath = join(dir, "bridge.sqlite");
      const key = "xproc-key-0001";
      const payload = JSON.stringify(request());
      const markerA = join(dir, "launched-A");
      const markerB = join(dir, "launched-B");

      const procA = runChildAsync(child, [dbPath, key, payload, "slow", markerA]);
      await sleepMs(400);
      const procB = runChildAsync(child, [dbPath, key, payload, "marker", markerB]);
      const [a, b] = await Promise.all([procA, procB]);

      assert.equal(a.status, 0, `child A stderr: ${a.stderr}`);
      assert.equal(b.status, 0, `child B stderr: ${b.stderr}`);
      const ra = JSON.parse(a.stdout.trim().split("\n").pop()!);
      const rb = JSON.parse(b.stdout.trim().split("\n").pop()!);
      assert.equal(ra.ok, true);
      assert.equal(rb.ok, true);
      // Order-agnostic: whichever process won the claim, both agree on one
      // attempt and exactly one runtime launch happened.
      assert.equal(ra.attemptId, rb.attemptId);
      const markers = [markerA, markerB].filter((m) => existsSync(m));
      assert.equal(markers.length, 1, "exactly one process launched the runtime");
      const winnerExt = markers[0] === markerA ? "ext-slow" : "ext-marker";
      const verify = new AttemptStore({ path: dbPath });
      try {
        const final = verify.getAttempt(ra.attemptId);
        assert.equal(final.state, "running");
        assert.equal(final.orcaDispatchId, winnerExt);
      } finally {
        verify.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("second process with a different key is fenced by the active lease", () => {
    const dir = mkdtempSync(join(tmpdir(), "ff006-xfence-"));
    try {
      const child = childFile(dir);
      const dbPath = join(dir, "bridge.sqlite");
      const first = runChild(child, [
        dbPath,
        "xproc-first-1",
        JSON.stringify(request()),
        "normal",
        "ext-first",
      ]);
      assert.equal(first.status, 0);
      assert.equal(JSON.parse(first.stdout.trim().split("\n").pop()!).ok, true);
      const second = runChild(child, [
        dbPath,
        "xproc-second-2",
        JSON.stringify(
          request({ lease: { fencingEpoch: 2, leaseToken: "lease-2" } }),
        ),
        "normal",
        "ext-second",
      ]);
      assert.equal(second.status, 0);
      const parsed = JSON.parse(second.stdout.trim().split("\n").pop()!);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.code, "active_lease");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hard-killed dispatch process reattaches on restart with zero relaunch", () => {
    const dir = mkdtempSync(join(tmpdir(), "ff006-xcrash-"));
    try {
      const child = childFile(dir);
      const dbPath = join(dir, "bridge.sqlite");
      const sidecar = join(dir, "runtime-sidecar.json");
      const key = "xproc-crash-1";
      const payload = JSON.stringify(request());
      const crashed = runChild(child, [dbPath, key, payload, "crash", sidecar]);
      assert.notEqual(crashed.status, 0, "crash child must die without returning");
      assert.ok(existsSync(sidecar), "runtime sidecar records the accepted launch");

      // Restart in this process over the same file: reconcile, do not launch.
      let launches = 0;
      const restarted = new AttemptStore({
        path: dbPath,
        dispatch: async () => {
          launches += 1;
          return { state: "dispatching", orcaDispatchId: "ext-never" };
        },
      });
      try {
        const inventory = [JSON.parse(readFileSync(sidecar, "utf8"))].map(
          (r: { externalDispatchId: string }) => ({
            externalDispatchId: r.externalDispatchId,
            paperclipTaskId: "task_123",
            leaseToken: "lease-1",
            state: "running" as const,
          }),
        );
        const report = restarted.reconcileAfterRestart(inventory);
        assert.equal(report.kept.length, 1);
        const kept = restarted.getAttempt(report.kept[0]!);
        assert.equal(kept.state, "running");
        assert.equal(kept.orcaDispatchId, "ext-crashed");
        assert.equal(launches, 0);
      } finally {
        restarted.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
