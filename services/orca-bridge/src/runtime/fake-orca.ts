/**
 * FF-031 integration: deterministic fake Orca runtime.
 *
 * Implements the E03 `CommandRunner` interface over the exact verified argv
 * shapes from `dispatch.ts` (`orchestration worker-start/show/stop`,
 * `orchestration request-show`). In-memory only: runtime state is supposed
 * to be ephemeral — bridge durability lives in `file-store.ts`, and the
 * restart tests reuse one FakeOrca across two server instances to model an
 * Orca service that outlives the bridge (or swap in a fresh one to model
 * runtime loss, which must surface as `unknown`, never a silent relaunch).
 *
 * NOT a live integration: every claim backed by this fake is fixture
 * evidence. The owner-authorized Vultr/Linux smoke plan is documented in
 * `docs/06-delivery/ff031-live-smoke-plan.md`.
 */

import type { CommandRunner, CommandResult } from "./dispatch.ts";

/** The fake satisfies the runner contract structurally (no runtime import). */
export function asRunner(fake: { run: CommandRunner }): CommandRunner {
  return fake.run.bind(fake);
}

export interface FakeSession {
  dispatchId: string;
  requestId: string;
  /** Raw worker status in the vocabulary `mapWorkerStatus` accepts. */
  status: string;
  runId: string | null;
  taskId: string | null;
  worktreeId: string | null;
  comment: string;
  paperclipTaskId: string | null;
  paperclipRunId: string | null;
  leaseToken: string | null;
}

function flagValue(argv: readonly string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  if (i < 0 || i + 1 >= argv.length) return null;
  return argv[i + 1];
}

function jsonResult(body: unknown): CommandResult {
  return { exitCode: 0, stdout: JSON.stringify(body), stderr: "" };
}

/** Parse `forgefleet:<taskId>:<runId>` comments written by the bridge. */
function parseComment(comment: string | null): {
  taskId: string | null;
  runId: string | null;
} {
  if (!comment) return { taskId: null, runId: null };
  const m = /^forgefleet:([^:]+):(.+)$/.exec(comment);
  if (!m) return { taskId: null, runId: null };
  return { taskId: m[1], runId: m[2] };
}

export class FakeOrca {
  private seq: number;

  /**
   * Test-only id offset: cross-process tests run one FakeOrca per bridge
   * process, so bare per-process counters would mint colliding
   * `fake-dispatch-NNNN` ids and trip the store's UNIQUE dispatch-id
   * backstop. Pass a distinct start per process there. Default 0 keeps
   * every existing in-process expectation byte-identical.
   */
  constructor(startSeq = 0) {
    this.seq = startSeq;
  }
  private readonly sessions = new Map<string, FakeSession>();
  private readonly byRequest = new Map<string, string>();
  /** How many worker-start commands actually ran (no-duplicate invariant). */
  dispatchCount = 0;
  /** When true, the next worker-start fails like a lost transport. */
  failNextStart = false;

  get executable(): string {
    return "fake-orca-ide";
  }

  async run(
    _executable: string,
    argv: readonly string[],
    _opts: { timeoutMs?: number },
  ): Promise<CommandResult> {
    const [domain, verb, ...rest] = argv;
    void rest;
    if (domain !== "orchestration") {
      return { exitCode: 1, stdout: "", stderr: "unknown domain" };
    }
    switch (verb) {
      case "worker-start":
        return this.workerStart(argv);
      case "worker-show":
        return this.workerShow(argv);
      case "worker-stop":
        return this.workerStop(argv);
      case "request-show":
        return this.requestShow(argv);
      default:
        return { exitCode: 1, stdout: "", stderr: `unknown verb ${verb}` };
    }
  }

  private workerStart(argv: readonly string[]): CommandResult {
    if (this.failNextStart) {
      this.failNextStart = false;
      throw new Error("fake transport lost");
    }
    const agent = flagValue(argv, "--agent");
    if (agent !== null && agent !== "muse") {
      return {
        exitCode: 1,
        stdout: JSON.stringify({
          result: { failedStage: "capability", workerKind: agent },
        }),
        stderr: `unsupported worker kind ${agent}`,
      };
    }
    this.seq += 1;
    this.dispatchCount += 1;
    const n = this.seq;
    const dispatchId = `fake-dispatch-${String(n).padStart(4, "0")}`;
    const comment = flagValue(argv, "--comment") ?? "";
    const { taskId, runId } = parseComment(comment);
    const session: FakeSession = {
      dispatchId,
      requestId: flagValue(argv, "--retry-request") ?? `fake-req-${n}`,
      status: "dispatching",
      runId: flagValue(argv, "--run"),
      taskId: flagValue(argv, "--task-title") ?? taskId,
      worktreeId: `fake-wt-${String(n).padStart(4, "0")}`,
      comment,
      paperclipTaskId: taskId,
      paperclipRunId: runId,
      leaseToken: null,
    };
    this.sessions.set(dispatchId, session);
    this.byRequest.set(session.requestId, dispatchId);
    return jsonResult({
      result: {
        dispatchId,
        runId: session.runId,
        taskId: session.taskId,
        worktreeId: session.worktreeId,
        requestId: session.requestId,
      },
    });
  }

  private workerShow(argv: readonly string[]): CommandResult {
    const id = flagValue(argv, "--dispatch") ?? "";
    const session = this.sessions.get(id);
    if (!session) {
      return { exitCode: 1, stdout: "", stderr: "stop_unknown" };
    }
    return jsonResult({
      result: {
        dispatchId: session.dispatchId,
        status: session.status,
        runId: session.runId,
        taskId: session.taskId,
        worktreeId: session.worktreeId,
      },
    });
  }

  private workerStop(argv: readonly string[]): CommandResult {
    const id = flagValue(argv, "--dispatch") ?? "";
    const session = this.sessions.get(id);
    if (!session) {
      return { exitCode: 1, stdout: "", stderr: "stop_unknown" };
    }
    session.status = "stopped";
    return { exitCode: 0, stdout: "stopped", stderr: "" };
  }

  private requestShow(argv: readonly string[]): CommandResult {
    const id = flagValue(argv, "--request") ?? "";
    if (this.byRequest.has(id)) {
      return jsonResult({ result: { status: "completed" } });
    }
    return jsonResult({ result: { status: "absent" } });
  }

  /** Drive the fake runtime forward (the test harness is the "worker"). */
  setStatus(dispatchId: string, status: string): void {
    const session = this.sessions.get(dispatchId);
    if (!session) throw new Error(`unknown fake dispatch ${dispatchId}`);
    session.status = status;
  }

  /** Read-only inventory for the bridge sessions endpoint + reconcile. */
  listSessions(): FakeSession[] {
    return [...this.sessions.values()].map((s) => ({ ...s }));
  }

  findByDispatch(dispatchId: string): FakeSession | null {
    const s = this.sessions.get(dispatchId);
    return s ? { ...s } : null;
  }

  hasRequest(requestId: string): boolean {
    return this.byRequest.has(requestId);
  }
}

export function isFakeRunner(runner: unknown): runner is FakeOrca {
  return runner instanceof FakeOrca;
}

export function hasSessionInventory(
  runner: unknown,
): runner is { listSessions(): FakeSession[] } {
  return (
    typeof runner === "object" &&
    runner !== null &&
    typeof (runner as { listSessions?: unknown }).listSessions === "function"
  );
}
