/**
 * E03 — tests for dispatch.ts (FF-007).
 *
 * Run: node --test services/orca-bridge/src/runtime/dispatch.test.ts
 * Stdlib only (node:test + node:assert/strict), mirroring E02's harness.
 * All Orca interaction goes through an injected fake runner: no process is
 * spawned, no live session is touched.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DispatchError,
  DispatchLedger,
  buildCancelArgv,
  buildRequestShowArgv,
  buildStartArgv,
  buildStatusArgv,
  cancelAttempt,
  deriveOrcaRequestId,
  extractStartIds,
  getAttemptStatus,
  hashStartRequest,
  mapWorkerStatus,
  reconcileStart,
  redactForLog,
  startAttempt,
  type CommandResult,
  type DispatchDeps,
  type StartAttemptInput,
} from "./dispatch.ts";

function baseInput(overrides: Partial<StartAttemptInput> = {}): StartAttemptInput {
  return {
    contextManifestId: "ctx-manifest-1",
    idempotencyKey: "test-key-0123456789",
    instruction: "Summarize the repo layout. Do not edit anything.",
    lease: { fencingEpoch: 1, leaseToken: "lease-token-1" },
    paperclipRunId: "run-1",
    paperclipTaskId: "task-1",
    placement: { mode: "new-top-level", repo: "id:repo-1" },
    projectId: "project-1",
    taskTitle: "Probe task",
    workerKind: "muse",
    ...overrides,
  };
}

const cancelAuth = { approvedBy: "owner:abraham", reason: "test cancel" };

interface SeenCall {
  executable: string;
  argv: readonly string[];
}

function fakeDeps(
  script: CommandResult[] | ((call: SeenCall) => CommandResult),
  opts: { throwOn?: number[] } = {},
): { deps: DispatchDeps; calls: SeenCall[] } {
  const calls: SeenCall[] = [];
  let n = 0;
  const deps: DispatchDeps = {
    executable: "orca-ide",
    newAttemptId: () => `attempt-${n}`,
    now: () => new Date("2026-11-08T12:00:00.000Z"),
    run: async (executable, argv) => {
      const call = { argv: [...argv], executable };
      calls.push(call);
      const idx = n;
      n += 1;
      if (opts.throwOn?.includes(idx)) throw new Error("spawn ENOENT");
      if (typeof script === "function") return script(call);
      const next = script[idx] ?? script[script.length - 1];
      return next;
    },
  };
  return { calls, deps };
}

const okStart: CommandResult = {
  exitCode: 0,
  stderr: "",
  stdout: JSON.stringify({
    result: {
      dispatchId: "dispatch-abc",
      requestId: "ff-req-1",
      runId: "run-9",
      taskId: "otask-7",
      worktree: { id: "wt-3" },
    },
  }),
};

describe("buildStartArgv uses only verified flags", () => {
  it("maps to a fixed worker-start shape with --json and --agent muse", () => {
    const argv = buildStartArgv(baseInput());
    assert.deepEqual(argv.slice(0, 3), [
      "orchestration",
      "worker-start",
      "--spec",
    ]);
    const flagSet = new Set(argv);
    for (const required of [
      "--task-title",
      "--worktree",
      "--repo",
      "--agent",
      "--comment",
      "--retry-request",
      "--json",
    ]) {
      assert.ok(flagSet.has(required), `missing ${required}`);
    }
    assert.equal(argv[argv.indexOf("--agent") + 1], "muse");
    assert.equal(argv[argv.indexOf("--worktree") + 1], "new-top-level");
    assert.ok(!flagSet.has("--terminal"), "must not reuse terminals");
    assert.ok(!flagSet.has("--model"), "no model guessing");
    assert.ok(!flagSet.has("--effort"), "no effort guessing");
    assert.ok(!flagSet.has("--on"), "no remote routing by default");
  });

  it("passes the instruction as one argv element (no shell)", () => {
    const evil = 'x"; rm -rf /; echo "';
    const argv = buildStartArgv(baseInput({ instruction: evil }));
    assert.equal(argv[argv.indexOf("--spec") + 1], evil);
    assert.equal(argv.length, argv.filter((t) => typeof t === "string").length);
  });

  it("derives a stable --retry-request from the idempotency key", () => {
    const a = buildStartArgv(baseInput());
    const b = buildStartArgv(baseInput());
    assert.equal(
      a[a.indexOf("--retry-request") + 1],
      b[b.indexOf("--retry-request") + 1],
    );
    assert.equal(
      a[a.indexOf("--retry-request") + 1],
      deriveOrcaRequestId("test-key-0123456789"),
    );
  });

  it("rejects non-muse worker kinds without touching the runner", async () => {
    const { calls, deps } = fakeDeps([okStart]);
    await assert.rejects(
      startAttempt(deps, new DispatchLedger(), baseInput({ workerKind: "codex" })),
      (e: unknown) =>
        e instanceof DispatchError && e.code === "UNSUPPORTED_WORKER_KIND",
    );
    assert.equal(calls.length, 0);
  });

  it("rejects short idempotency keys", () => {
    assert.throws(
      () => buildStartArgv(baseInput({ idempotencyKey: "short" })),
      (e: unknown) =>
        e instanceof DispatchError && e.code === "INVALID_IDEMPOTENCY_KEY",
    );
  });
});

describe("idempotent start ledger", () => {
  it("same key + same payload dispatches once and replays", async () => {
    const { calls, deps } = fakeDeps([okStart]);
    const ledger = new DispatchLedger();
    const first = await startAttempt(deps, ledger, baseInput());
    assert.equal(first.state, "dispatching");
    assert.equal(first.orcaDispatchId, "dispatch-abc");
    assert.equal(first.orcaRunId, "run-9");
    assert.equal(first.worktreeId, "wt-3");
    assert.equal(first.deduplicated, false);

    const second = await startAttempt(deps, ledger, baseInput());
    assert.equal(second.state, "dispatching");
    assert.equal(second.attemptId, first.attemptId);
    assert.equal(second.deduplicated, true);
    assert.equal(calls.length, 1);
  });

  it("same key + different payload conflicts with no second dispatch", async () => {
    const { calls, deps } = fakeDeps([okStart]);
    const ledger = new DispatchLedger();
    await startAttempt(deps, ledger, baseInput());
    await assert.rejects(
      startAttempt(
        deps,
        ledger,
        baseInput({ instruction: "Do something completely different." }),
      ),
      (e: unknown) =>
        e instanceof DispatchError && e.code === "IDEMPOTENCY_CONFLICT",
    );
    assert.equal(calls.length, 1);
  });

  it("explicit Orca failure throws START_FAILED and pins the key", async () => {
    const failed: CommandResult = {
      exitCode: 1,
      stderr: "boom",
      stdout: JSON.stringify({ result: { failedStage: "agent_launch" } }),
    };
    const { calls, deps } = fakeDeps([failed]);
    const ledger = new DispatchLedger();
    await assert.rejects(startAttempt(deps, ledger, baseInput()), (e: unknown) => {
      assert.ok(e instanceof DispatchError && e.code === "START_FAILED");
      assert.match(e.detail, /agent_launch/);
      return true;
    });
    // Same key+payload now replays the failed record instead of redispatching.
    const replay = await startAttempt(deps, ledger, baseInput());
    assert.equal(replay.state, "failed");
    assert.equal(replay.deduplicated, true);
    assert.equal(calls.length, 1);
  });

  it("unparseable success receipt fails closed to unknown", async () => {
    const { deps } = fakeDeps([
      { exitCode: 0, stderr: "", stdout: "not json{{{" },
    ]);
    const receipt = await startAttempt(
      deps,
      new DispatchLedger(),
      baseInput(),
    );
    assert.equal(receipt.state, "unknown");
    assert.equal(receipt.errorCode, "RECEIPT_UNPARSEABLE");
    assert.equal(receipt.orcaDispatchId, null);
  });

  it("transport loss records unknown with request id for reconcile", async () => {
    const { deps } = fakeDeps([], { throwOn: [0] });
    const receipt = await startAttempt(
      deps,
      new DispatchLedger(),
      baseInput(),
    );
    assert.equal(receipt.state, "unknown");
    assert.equal(receipt.errorCode, "START_TRANSPORT_LOST");
    assert.equal(
      receipt.orcaRequestId,
      deriveOrcaRequestId("test-key-0123456789"),
    );
  });

  it("request hash is order- and default-stable", () => {
    assert.equal(hashStartRequest(baseInput()), hashStartRequest(baseInput()));
  });

  it("ledger snapshot/restore survives a bridge restart", async () => {
    const { deps } = fakeDeps([okStart]);
    const ledger = new DispatchLedger();
    const first = await startAttempt(deps, ledger, baseInput());
    const restored = DispatchLedger.restore(ledger.snapshot());
    const replay = await startAttempt(deps, restored, baseInput());
    assert.equal(replay.attemptId, first.attemptId);
    assert.equal(replay.deduplicated, true);
  });
});

describe("extractStartIds is defensive", () => {
  it("reads the result envelope", () => {
    const ids = extractStartIds(JSON.parse(okStart.stdout));
    assert.equal(ids?.orcaDispatchId, "dispatch-abc");
    assert.equal(ids?.orcaRunId, "run-9");
  });

  it("reads a top-level shape", () => {
    const ids = extractStartIds({ dispatch_id: "d-1", run_id: "r-1" });
    assert.equal(ids?.orcaDispatchId, "d-1");
    assert.equal(ids?.orcaRunId, "r-1");
  });

  it("returns null when no dispatch identity is provable", () => {
    assert.equal(extractStartIds({ result: { ok: true } }), null);
    assert.equal(extractStartIds("garbage"), null);
    assert.equal(extractStartIds(null), null);
  });
});

describe("status mapping fails closed", () => {
  it("maps known tokens and unknowns", () => {
    assert.equal(mapWorkerStatus("running"), "running");
    assert.equal(mapWorkerStatus("finished"), "finished");
    assert.equal(mapWorkerStatus("failed"), "failed");
    assert.equal(mapWorkerStatus("waiting"), "waiting");
    assert.equal(mapWorkerStatus("mystery-state"), "unknown");
    assert.equal(mapWorkerStatus(undefined), "unknown");
    assert.equal(mapWorkerStatus(null), "unknown");
  });

  it("buildStatusArgv targets one dispatch read-only", () => {
    assert.deepEqual(buildStatusArgv("d-1"), [
      "orchestration",
      "worker-show",
      "--dispatch",
      "d-1",
      "--json",
    ]);
  });

  it("failedStage in worker-show means failed", async () => {
    const { deps } = fakeDeps([
      {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({ result: { failedStage: "setup" } }),
      },
    ]);
    const r = await getAttemptStatus(deps, "d-1", "p-1", "a-1");
    assert.equal(r.state, "failed");
    assert.equal(r.errorCode, "WORKER_FAILED_STAGE");
  });

  it("unrecognized shape means unknown, never finished", async () => {
    const { deps } = fakeDeps([
      { exitCode: 0, stderr: "", stdout: JSON.stringify({ result: {} }) },
    ]);
    const r = await getAttemptStatus(deps, "d-1", "p-1", "a-1");
    assert.equal(r.state, "unknown");
    assert.notEqual(r.state, "finished");
  });

  it("runner failure means unknown with transport marker", async () => {
    const { deps } = fakeDeps([], { throwOn: [0] });
    const r = await getAttemptStatus(deps, "d-1", "p-1", "a-1");
    assert.equal(r.state, "unknown");
    assert.equal(r.errorCode, "STATUS_TRANSPORT_LOST");
  });
});

describe("guarded cancel", () => {
  it("claims cancelled only on confirmed stop", async () => {
    const { deps } = fakeDeps([
      {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          result: { processAction: "closed_agent_terminal" },
        }),
      },
    ]);
    const r = await cancelAttempt(deps, "d-1", "p-1", "a-1", "test-key-0123456789", cancelAuth);
    assert.equal(r.state, "cancelled");
  });

  it("stop_unknown raises CANCEL_UNCONFIRMED", async () => {
    const { deps } = fakeDeps([
      {
        exitCode: 1,
        stderr: "stop_unknown",
        stdout: JSON.stringify({ result: { stop: "stop_unknown" } }),
      },
    ]);
    await assert.rejects(
      cancelAttempt(deps, "d-1", "p-1", "a-1", "test-key-0123456789", cancelAuth),
      (e: unknown) =>
        e instanceof DispatchError && e.code === "CANCEL_UNCONFIRMED",
    );
  });

  it("cancel argv carries --retry-request for safe retry", () => {
    const argv = buildCancelArgv("d-1", "test-key-0123456789");
    assert.deepEqual(argv.slice(0, 3), [
      "orchestration",
      "worker-stop",
      "--dispatch",
    ]);
    assert.equal(
      argv[argv.indexOf("--retry-request") + 1],
      deriveOrcaRequestId("test-key-0123456789"),
    );
  });
});

describe("reconcileStart", () => {
  it("parses completed / absent, defaults to pending", async () => {
    const completed: CommandResult = {
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({ result: { status: "completed" } }),
    };
    const absent: CommandResult = {
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({ result: { status: "absent" } }),
    };
    const pending: CommandResult = {
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({ result: { status: "pending" } }),
    };
    assert.equal(
      await reconcileStart(fakeDeps([completed]).deps, "ff-x"),
      "completed",
    );
    assert.equal(
      await reconcileStart(fakeDeps([absent]).deps, "ff-x"),
      "absent",
    );
    assert.equal(
      await reconcileStart(fakeDeps([pending]).deps, "ff-x"),
      "pending",
    );
    assert.deepEqual(buildRequestShowArgv("ff-x"), [
      "orchestration",
      "request-show",
      "--request",
      "ff-x",
      "--json",
    ]);
  });

  it("transport loss means pending, never absent", async () => {
    assert.equal(
      await reconcileStart(fakeDeps([], { throwOn: [0] }).deps, "ff-x"),
      "pending",
    );
  });
});

describe("frozen contract v0.1 alignment (#46)", () => {
  it("rejects a missing contextManifestId", async () => {
    const { calls, deps } = fakeDeps([okStart]);
    await assert.rejects(
      startAttempt(
        deps,
        new DispatchLedger(),
        baseInput({ contextManifestId: "  " }),
      ),
      (e: unknown) =>
        e instanceof DispatchError && e.code === "INVALID_START_REQUEST",
    );
    assert.equal(calls.length, 0);
  });

  it("rejects fencingEpoch below 1", async () => {
    const { calls, deps } = fakeDeps([okStart]);
    await assert.rejects(
      startAttempt(
        deps,
        new DispatchLedger(),
        baseInput({ lease: { fencingEpoch: 0, leaseToken: "t" } }),
      ),
      (e: unknown) =>
        e instanceof DispatchError && e.code === "INVALID_START_REQUEST",
    );
    assert.equal(calls.length, 0);
  });

  it("a new fencing generation under the same key conflicts", async () => {
    const { calls, deps } = fakeDeps([okStart]);
    const ledger = new DispatchLedger();
    await startAttempt(deps, ledger, baseInput());
    await assert.rejects(
      startAttempt(
        deps,
        ledger,
        baseInput({ lease: { fencingEpoch: 2, leaseToken: "lease-token-2" } }),
      ),
      (e: unknown) =>
        e instanceof DispatchError && e.code === "IDEMPOTENCY_CONFLICT",
    );
    assert.equal(calls.length, 1);
  });

  it("cancel without reason/approvedBy is refused before any command", async () => {
    const { calls, deps } = fakeDeps([okStart]);
    await assert.rejects(
      cancelAttempt(deps, "d-1", "p-1", "a-1", "test-key-0123456789", {
        approvedBy: "",
        reason: "",
      }),
      (e: unknown) =>
        e instanceof DispatchError && e.code === "INVALID_CANCEL_REQUEST",
    );
    assert.equal(calls.length, 0);
  });

  it("emitted states stay inside the frozen AttemptState union", async () => {
    // Tripwire: mirror of the pinned union in
    // packages/bridge-contracts/generated/bridge.types.ts (contract v0.1.0).
    const frozen: ReadonlySet<string> = new Set([
      "accepted",
      "dispatching",
      "running",
      "waiting",
      "unknown",
      "finished",
      "failed",
      "cancelled",
    ]);
    const { deps } = fakeDeps([okStart]);
    const started = await startAttempt(deps, new DispatchLedger(), baseInput());
    assert.ok(frozen.has(started.state), `state ${started.state} not in frozen union`);
    for (const token of ["running", "finished", "failed", "waiting", "nope", undefined]) {
      assert.ok(frozen.has(mapWorkerStatus(token)), `mapping leaked ${String(token)}`);
    }
  });
});

describe("redaction", () => {
  it("scrubs emails, tokens, and home dirs", () => {
    const dirty =
      "user alice@example.com bearer ABC123.xyz_~-token bob /Users/alice/x failed: sk-secretkey part ghp_abc123def";
    const clean = redactForLog(dirty);
    assert.ok(!clean.includes("alice@example.com"));
    assert.ok(!clean.includes("sk-secretkey"));
    assert.ok(!clean.includes("ghp_abc123def"));
    assert.ok(!clean.includes("/Users/alice"));
  });
});
