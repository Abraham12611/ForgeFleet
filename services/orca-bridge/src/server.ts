/**
 * FF-031 integration: internal authenticated Orca bridge HTTP server.
 *
 * Implements the frozen v0.1 contract
 * (`docs/05-contracts/bridge.openapi.yaml`, `CONTRACT-VERSION 0.1.0`) with:
 * - E02 read-only discovery for executable resolution + capabilities probe.
 * - E03 fixed-argv dispatch (verified flags only) via an injected runner.
 * - E06 canonical SQLite store (`attempts.db`: WAL, synchronous=FULL,
 *   unique-key single-launch claims) as the authoritative attempt ledger.
 * - E06-adjacent `BridgeExtras` (`bridge-extras.db`, same WAL discipline)
 *   for bridge-level correlation only: attempt index, message/cancel
 *   idempotency, SSE replay buffer. Never the attempt ledger.
 * - E07 policy gate (`dispatch.execute`, service role, project-scoped).
 *   Worker-supplied `approvedBy` is audit evidence, never authority.
 * - Unseen runtime sessions reported as `managed:false, state:unknown`.
 * - No new live dispatch when history is ambiguous (real backend only).
 * - Launcher fate unknown (502 `dispatch_unknown`): the durable `accepted`
 *   prefix stands; a same-key retry replays without relaunching until
 *   reconciliation (inventory adopt, inventory-proven single dispatch, or
 *   fail-closed `unknown`) resolves the fate. Never a silent relaunch.
 *
 * Loopback-only by deployment; the server binds an explicitly provided
 * host (default 127.0.0.1). Auth: `Authorization: Bearer <token>` on every
 * route except `GET /v1/health/live`.
 *
 * Test-only surface (requires `FORGEFLEET_ALLOW_TEST_INGEST=1`):
 * `POST /v1/test/events/ingest` feeds deterministic fake-Orca events into
 * the transactional receipt path. Production wires a runtime poller, not
 * this endpoint. Every claim backed by it is fixture evidence.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { basename, join } from "node:path";
import { mkdirSync, statSync } from "node:fs";
import {
  AttemptStore,
  StoreError,
  assertSafeDbFile,
  type AttemptReceipt,
  type AttemptState,
  type CreateAttemptRequest,
  type DispatchResult,
  type ExternalDispatchIds,
} from "./persistence/attempt-store.ts";
import { resolveOrcaExecutable } from "./runtime/discovery.ts";
import {
  buildStartArgv,
  cancelAttempt as dispatchCancel,
  DispatchError,
  extractStartIds,
  getAttemptStatus,
  type CommandRunner,
  type DispatchDeps,
  type StartAttemptInput,
} from "./runtime/dispatch.ts";
import { authorize } from "../../../packages/policy/src/policy.js";
import { BridgeExtras } from "./persistence/bridge-extras.ts";

export const CONTRACT_VERSION = "0.1.0";
const BODY_LIMIT_BYTES = 1_000_000;

export interface ProviderCapability {
  name: string;
  status: "verified" | "unsupported" | "unknown" | "unavailable";
  notes?: string;
}

/** Minimal runtime inventory a backend may expose (fake Orca does). */
export interface RuntimeSessionInventory {
  dispatchId: string;
  requestId: string;
  status: string;
  runId: string | null;
  taskId: string | null;
  worktreeId: string | null;
  comment: string;
  paperclipTaskId: string | null;
  paperclipRunId: string | null;
  leaseToken: string | null;
}

/** Runnable backend: a command runner plus optional full inventory. */
export interface RuntimeBackend {
  run: CommandRunner;
  listSessions?: () => RuntimeSessionInventory[];
}

function backendHasInventory(
  backend: RuntimeBackend,
): backend is RuntimeBackend & { listSessions: () => RuntimeSessionInventory[] } {
  return typeof backend.listSessions === "function";
}

export interface BridgeServerOptions {
  dataDir: string;
  token: string;
  executable?: string;
  /** Full backend (preferred: preserves inventory for reconcile). */
  backend?: RuntimeBackend;
  /** Bare runner (no inventory: unseen sessions stay unknown, ambiguity gates). */
  run?: CommandRunner;
  platform?: string;
  providers?: ProviderCapability[];
  host?: string;
  port?: number;
  /** Test-only: allow the fake-event ingest endpoint. */
  allowTestIngest?: boolean;
}

interface PendingExtras {
  taskTitle: string;
  instruction: string;
  contextManifestId: string;
  repositoryId?: string;
  timeoutMs?: number;
  workerKind: string;
  lease: { fencingEpoch: number; leaseToken: string };
  idempotencyKey: string;
  paperclipRunId: string;
}

interface SessionView {
  externalId: string;
  provider: string | null;
  state: "running" | "waiting" | "stopped" | "failed" | "unknown";
  managed: boolean;
  taskId: string | null;
  worktreeId: string | null;
  lastObservedAt: string | null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function err(status: number, code: string, message: string): { status: number; body: Record<string, unknown> } {
  return { status, body: { error: code, message } };
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers["authorization"];
  if (!header || !header.startsWith("Bearer ")) return false;
  const presented = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf-8");
      if (!text) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function toContractReceipt(receipt: AttemptReceipt): Record<string, unknown> {
  return {
    attemptId: receipt.attemptId,
    projectId: receipt.projectId,
    state: receipt.state,
    observedAt: receipt.observedAt,
    orcaRunId: receipt.orcaRunId ?? null,
    orcaTaskId: receipt.orcaTaskId ?? null,
    orcaDispatchId: receipt.orcaDispatchId ?? null,
    worktreeId: receipt.worktreeId ?? null,
    errorCode: receipt.errorCode ?? null,
  };
}

function storeErrorToResponse(e: StoreError): { status: number; body: Record<string, unknown> } {
  if (e.code === "idempotency_conflict" || e.code === "active_lease" || e.code === "stale_epoch") {
    return err(409, e.code, e.message);
  }
  if (e.code === "unknown_attempt") {
    return err(404, e.code, e.message);
  }
  if (e.code === "dispatch_unknown") {
    return err(502, e.code, e.message);
  }
  return err(e.status >= 400 && e.status < 600 ? e.status : 422, e.code, e.message);
}

/** Attempt state -> RuntimeSession state vocabulary. */
function toSessionState(state: string): SessionView["state"] {
  switch (state) {
    case "running":
    case "accepted":
    case "dispatching":
      return "running";
    case "waiting":
      return "waiting";
    case "finished":
    case "cancelled":
      return "stopped";
    case "failed":
      return "failed";
    default:
      return "unknown";
  }
}

function taskKeyOf(projectId: string, paperclipTaskId: string): string {
  return `${projectId}::${paperclipTaskId}`;
}

interface LaunchContext {
  executable: string;
  backend: RuntimeBackend;
  pendingExtras: Map<string, PendingExtras>;
}

/**
 * Runtime launcher given to the canonical store. Runs at most once per
 * accepted attempt (the store's single-launch claim guarantees it, even
 * across processes). A throw means unknown fate: the durable `accepted`
 * prefix stands and the store surfaces 502 — never a silent relaunch.
 */
async function runLaunch(
  ctx: LaunchContext,
  input: { attemptId: string; projectId: string; paperclipTaskId: string },
): Promise<DispatchResult> {
  const staged = ctx.pendingExtras.get(taskKeyOf(input.projectId, input.paperclipTaskId));
  if (!staged) {
    throw new Error(`no dispatch input staged for ${input.projectId}/${input.paperclipTaskId}; refusing to guess`);
  }
  const start: StartAttemptInput = {
    projectId: input.projectId,
    paperclipTaskId: input.paperclipTaskId,
    paperclipRunId: staged.paperclipRunId,
    workerKind: staged.workerKind,
    taskTitle: staged.taskTitle,
    instruction: staged.instruction,
    contextManifestId: staged.contextManifestId,
    lease: staged.lease,
    placement: { mode: "new-top-level", repo: staged.repositoryId ?? "default" },
    idempotencyKey: staged.idempotencyKey,
    ...(staged.timeoutMs !== undefined ? { timeoutMs: staged.timeoutMs } : {}),
  };
  const raw = await ctx.backend.run(ctx.executable, buildStartArgv(start), {
    timeoutMs: staged.timeoutMs,
  });
  if (raw.exitCode !== 0) {
    throw new Error(`worker-start refused (exit ${raw.exitCode})`);
  }
  const ids = extractStartIds(safeJsonParse(raw.stdout));
  if (!ids) {
    throw new Error("worker-start receipt unparseable; fate unknown, refusing to invent ids");
  }
  return {
    orcaRunId: ids.orcaRunId,
    orcaTaskId: ids.orcaTaskId,
    orcaDispatchId: ids.orcaDispatchId,
    worktreeId: ids.worktreeId,
    state: "dispatching",
  };
}

export class BridgeServer {
  private readonly store: AttemptStore;
  private readonly extras: BridgeExtras;
  private readonly token: string;
  private readonly executable: string;
  private readonly backend: RuntimeBackend;
  private readonly runner: CommandRunner;
  private readonly deps: DispatchDeps;
  private readonly providers: ProviderCapability[];
  private readonly host: string;
  private readonly port: number;
  private readonly allowTestIngest: boolean;
  private readonly pendingExtras = new Map<string, PendingExtras>();
  private server: Server | null = null;
  private cliVersion: string | null = null;
  private pollSeq = 0;

  private constructor(
    store: AttemptStore,
    extras: BridgeExtras,
    opts: {
      token: string;
      executable: string;
      backend: RuntimeBackend;
      pendingExtras: Map<string, PendingExtras>;
      providers: ProviderCapability[];
      host: string;
      port: number;
      allowTestIngest: boolean;
    },
  ) {
    this.store = store;
    this.extras = extras;
    this.token = opts.token;
    this.executable = opts.executable;
    this.backend = opts.backend;
    this.runner = opts.backend.run;
    this.pendingExtras = opts.pendingExtras;
    this.providers = opts.providers;
    this.host = opts.host;
    this.port = opts.port;
    this.allowTestIngest = opts.allowTestIngest;
    this.deps = { executable: opts.executable, run: opts.backend.run };
  }

  static async create(opts: BridgeServerOptions): Promise<BridgeServer> {
    const token = opts.token;
    if (!token) throw new Error("bridge token is required (FORGEFLEET_BRIDGE_TOKEN)");
    const env = { ORCA_CLI_COMMAND: process.env.ORCA_CLI_COMMAND ?? "" };
    const platform = opts.platform ?? process.platform;
    const resolved = opts.executable ?? resolveOrcaExecutable(env, platform).executable;
    const rawBackend: RuntimeBackend =
      opts.backend ??
      (opts.run
        ? { run: opts.run }
        : {
            run: async () => {
              throw new Error("no Orca runner configured: refusing live dispatch without a backend");
            },
          });
    // Bind methods: the server stores bare function references, so instance
    // state (fake sessions, spawn handles) must not depend on call-site `this`.
    const backend: RuntimeBackend = {
      run: rawBackend.run.bind(rawBackend),
      ...(typeof rawBackend.listSessions === "function"
        ? { listSessions: rawBackend.listSessions.bind(rawBackend) }
        : {}),
    };

    const pendingExtras = new Map<string, PendingExtras>();
    // The canonical store refuses to auto-create storage: the daemon owns
    // its data-dir lifecycle explicitly, before opening either database.
    mkdirSync(opts.dataDir, { recursive: true });
    // Concurrent first boot on a fresh data dir races DB creation/journal
    // setup (both files, both processes). Retry briefly: construction is
    // idempotent and the single-launch claim below is unaffected.
    let store: AttemptStore | null = null;
    let extras: BridgeExtras | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        store?.close();
        extras?.close();
      } catch {
        // best effort; retry with fresh handles
      }
      store = null;
      extras = null;
      try {
        store = new AttemptStore({
          path: join(opts.dataDir, "attempts.db"),
          // Canonical single-launch claim wraps this launcher: it runs at
          // most once per accepted attempt; a throw means unknown fate
          // (502) with the durable accept prefix left standing — never a
          // silent relaunch.
          dispatch: (input) =>
            runLaunch({ executable: resolved, backend, pendingExtras }, input),
        });
        extras = BridgeExtras.open(opts.dataDir);
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (!store || !extras) {
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }
    if (typeof process.geteuid === "function") {
      assertSafeDbFile(statSync(join(opts.dataDir, "attempts.db")), process.geteuid());
      extras.assertOwnership();
    }
    const server = new BridgeServer(store, extras, {
      token,
      executable: resolved,
      backend,
      pendingExtras,
      providers:
        opts.providers ??
        [
          { name: "muse", status: "verified" },
          { name: "devin", status: "unknown" },
        ],
      host: opts.host ?? "127.0.0.1",
      port: opts.port ?? 4387,
      allowTestIngest:
        opts.allowTestIngest ?? process.env.FORGEFLEET_ALLOW_TEST_INGEST === "1",
    });
    await server.boot();
    return server;
  }

  /** Probe `--version` (best effort) and reconcile persisted attempts. */
  private async boot(): Promise<void> {
    try {
      const out = await this.runner(this.executable, ["--version"], { timeoutMs: 5000 });
      const first = out.stdout.split("\n")[0]?.trim().slice(0, 120);
      this.cliVersion = first ? first : null;
    } catch {
      this.cliVersion = null;
    }
    const report = this.store.reconcileAfterRestart(this.inventoryForReconcile());
    // Canonical reconcile vocabulary: kept (reattached running),
    // releasedTerminal (dispatch provably ended -> failed), heldUnknown
    // (ambiguous, never retried without proof). Orphans are reported by
    // the store and never adopted — the mirror follows, never leads.
    for (const id of report.kept) this.extras.noteState(id, "running");
    for (const id of report.heldUnknown) this.extras.noteState(id, "unknown");
    for (const id of report.releasedTerminal) this.extras.noteState(id, "failed");
  }

  private inventoryForReconcile(): {
    externalDispatchId: string;
    state: "running" | "terminal";
    paperclipTaskId?: string;
    leaseToken?: string;
  }[] {
    if (!backendHasInventory(this.backend)) return [];
    return this.backend.listSessions().map((s) => ({
      externalDispatchId: s.dispatchId,
      state: s.status === "running" || s.status === "dispatching" || s.status === "waiting"
        ? ("running" as const)
        : ("terminal" as const),
      paperclipTaskId: s.paperclipTaskId ?? undefined,
      leaseToken: s.leaseToken ?? undefined,
    }));
  }

  private providerStatus(workerKind: string): ProviderCapability | null {
    return this.providers.find((p) => p.name === workerKind) ?? null;
  }

  // -- dispatch plumbing --

  /** Launcher given to the canonical store (single-launch claim inside). */
  private async launchDispatch(input: {
    attemptId: string;
    projectId: string;
    paperclipTaskId: string;
  }): Promise<DispatchResult> {
    return runLaunch(
      { executable: this.executable, backend: this.backend, pendingExtras: this.pendingExtras },
      input,
    );
  }
  /**
   * Resolve a durable `accepted` attempt that owns no external dispatch
   * (crash window, or 502 retry): adopt a proven runtime, or — only with a
   * complete inventory proving absence — perform the single launch, or fail
   * closed to `unknown`. Never a blind relaunch.
   */
  private async resolveAmbiguousAccept(
    receipt: AttemptReceipt,
    body: Record<string, unknown>,
  ): Promise<AttemptReceipt> {
    const current = this.store.getAttempt(receipt.attemptId);
    if (current.orcaDispatchId) return current;
    const taskId = String(body.paperclipTaskId ?? "");
    const runId = String(body.paperclipRunId ?? "");
    if (backendHasInventory(this.backend)) {
      const sessions = this.backend.listSessions();
      const found = sessions.find((s) => s.comment === `forgefleet:${taskId}:${runId}`);
      if (found && ["running", "dispatching", "waiting"].includes(found.status)) {
        // Proven live runtime: record ids, then lift `unknown` via the
        // transactional event path (recordExternalDispatch alone only
        // lifts `accepted`). A terminal observed dispatch is NOT adopted —
        // its fate needs event proof, so it falls through to unknown.
        const adopted = this.store.recordExternalDispatch(receipt.attemptId, {
          orcaRunId: found.runId,
          orcaTaskId: found.taskId,
          orcaDispatchId: found.dispatchId,
          worktreeId: found.worktreeId,
        });
        if (adopted.state === "unknown") {
          this.store.applyRuntimeEvent({
            source: "orca-bridge-resolve",
            sourceEventId: `resolve-${receipt.attemptId}-adopted`,
            payload: { orcaDispatchId: found.dispatchId },
            attemptId: receipt.attemptId,
            eventType: "attempt.started",
            fencingEpoch: this.extras.epochOf(receipt.attemptId) ?? 1,
          });
          const lifted = this.store.getAttempt(receipt.attemptId);
          this.extras.noteState(receipt.attemptId, lifted.state);
          return lifted;
        }
        this.extras.noteState(receipt.attemptId, adopted.state);
        return adopted;
      }
      // Inventory is complete and no live dispatch exists: the single launch.
      const key = taskKeyOf(receipt.projectId, taskId);
      const staged = this.pendingExtras.get(key);
      if (!staged) {
        const marked = this.store.markUnknown(receipt.attemptId);
        this.extras.noteState(receipt.attemptId, "unknown");
        return marked;
      }
      const launched = await this.launchDispatch({
        attemptId: receipt.attemptId,
        projectId: receipt.projectId,
        paperclipTaskId: taskId,
      });
      const recorded = this.store.recordExternalDispatch(receipt.attemptId, launched);
      if (recorded.state === "unknown") {
        // Fresh runtime proof in hand: lift via the event path, same as adopt.
        this.store.applyRuntimeEvent({
          source: "orca-bridge-resolve",
          sourceEventId: `resolve-${receipt.attemptId}-launched`,
          payload: { orcaDispatchId: launched.orcaDispatchId },
          attemptId: receipt.attemptId,
          eventType: "attempt.started",
          fencingEpoch: this.extras.epochOf(receipt.attemptId) ?? 1,
        });
        const lifted = this.store.getAttempt(receipt.attemptId);
        this.extras.noteState(receipt.attemptId, lifted.state);
        return lifted;
      }
      this.extras.noteState(receipt.attemptId, recorded.state);
      return recorded;
    }
    // No inventory: absence is unprovable. Fail closed, never relaunch.
    if (current.state === "accepted" || current.state === "dispatching") {
      const marked = this.store.markUnknown(receipt.attemptId);
      this.extras.noteState(receipt.attemptId, "unknown");
      return marked;
    }
    return current;
  }

  /** Merge live runtime truth into a stored receipt (poll, never invent). */
  private async withLiveStatus(receipt: AttemptReceipt): Promise<Record<string, unknown>> {
    const dispatchId = receipt.orcaDispatchId;
    if (
      !dispatchId ||
      !["accepted", "dispatching", "running", "waiting", "unknown"].includes(receipt.state)
    ) {
      this.extras.noteState(receipt.attemptId, receipt.state);
      return toContractReceipt(receipt);
    }
    let live;
    try {
      live = await getAttemptStatus(this.deps, dispatchId, receipt.projectId, receipt.attemptId);
    } catch {
      return toContractReceipt(receipt);
    }
    if (live.state === receipt.state) return toContractReceipt(receipt);
    // Startup grace: a fresh dispatch the runtime acknowledged but has not
    // reported progress on is not telemetry loss. `unknown` from a
    // successful poll only applies once the attempt was running/waiting.
    if (live.state === "unknown" && ["accepted", "dispatching"].includes(receipt.state)) {
      return toContractReceipt(receipt);
    }
    // Heartbeats that change nothing are not logged (no event spam on GET).
    if (live.state === "running" && receipt.state === "running") {
      return toContractReceipt(receipt);
    }
    this.pollSeq += 1;
    const epoch = this.extras.epochOf(receipt.attemptId) ?? 1;
    const eventType =
      live.state === "finished"
        ? "attempt.finished"
        : live.state === "failed"
          ? "attempt.failed"
          : live.state === "cancelled"
            ? "attempt.cancelled"
            : live.state === "running" && ["accepted", "dispatching", "unknown"].includes(receipt.state)
              ? "attempt.started"
              : live.state === "unknown"
                ? "attempt.unknown"
                : "attempt.heartbeat";
    try {
      const outcome = this.store.applyRuntimeEvent({
        source: "orca-bridge-poll",
        sourceEventId: `poll-${receipt.attemptId}-${this.pollSeq}`,
        payload: { orcaDispatchId: dispatchId, observedState: live.state },
        attemptId: receipt.attemptId,
        eventType,
        fencingEpoch: epoch,
      });
      if (outcome.applied) {
        const updated = this.store.getAttempt(receipt.attemptId);
        this.extras.noteState(receipt.attemptId, updated.state);
        this.extras.appendEvent(
          eventType,
          { attemptId: receipt.attemptId, observedState: live.state },
          { attemptId: receipt.attemptId, projectId: receipt.projectId, fencingEpoch: epoch },
        );
        return toContractReceipt(updated);
      }
    } catch {
      return toContractReceipt(receipt);
    }
    return toContractReceipt(receipt);
  }

  // -- HTTP plumbing --

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";
    const path = url.pathname;

    if (method === "GET" && path === "/v1/health/live") {
      sendJson(res, 200, { ok: true, contractVersion: CONTRACT_VERSION });
      return;
    }

    if (!authorized(req, this.token)) {
      sendJson(res, 401, err(401, "unauthorized", "missing or invalid service token").body);
      return;
    }

    try {
      if (method === "GET" && path === "/v1/runtime/capabilities") {
        sendJson(res, 200, {
          reachable: true,
          checkedAt: new Date().toISOString(),
          cliVersion: this.cliVersion,
          commandPath: basename(this.executable),
          providers: this.providers,
        });
        return;
      }

      if (method === "GET" && path === "/v1/runtime/sessions") {
        sendJson(res, 200, { sessions: this.listSessions() });
        return;
      }

      if (method === "GET" && path === "/v1/events") {
        const cursor =
          req.headers["last-event-id"] ?? url.searchParams.get("lastEventId") ?? null;
        this.sendEvents(res, Array.isArray(cursor) ? cursor[0] : cursor);
        return;
      }

      if (method === "POST" && path === "/v1/attempts") {
        await this.handleCreate(req, res);
        return;
      }

      const attemptMatch = /^\/v1\/attempts\/([^/]+)(\/(cancel|messages))?$/.exec(path);
      if (attemptMatch) {
        const attemptId = decodeURIComponent(attemptMatch[1]);
        const sub = attemptMatch[3];
        if (method === "GET" && !sub) {
          await this.handleGetAttempt(res, attemptId);
          return;
        }
        if (method === "POST" && sub === "cancel") {
          await this.handleCancel(req, res, attemptId);
          return;
        }
        if (method === "POST" && sub === "messages") {
          await this.handleMessage(req, res, attemptId);
          return;
        }
        sendJson(res, 405, err(405, "method_not_allowed", "unsupported method for this path").body);
        return;
      }

      if (method === "POST" && path === "/v1/test/events/ingest") {
        await this.handleTestIngest(req, res);
        return;
      }

      sendJson(res, 404, err(404, "not_found", "unknown path").body);
    } catch (e) {
      sendJson(res, 500, err(500, "internal", e instanceof Error ? e.message : "internal error").body);
    }
  }

  // -- route handlers --

  private async handleCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || key.length === 0) {
      sendJson(res, 422, err(422, "missing_idempotency_key", "Idempotency-Key header is required").body);
      return;
    }
    let raw: unknown;
    try {
      raw = await readBody(req);
    } catch {
      sendJson(res, 422, err(422, "invalid_json", "request body must be valid JSON").body);
      return;
    }
    const body = asRecord(raw);
    const problems = validateCreateBody(body);
    if (problems.length > 0) {
      sendJson(res, 422, err(422, "validation", problems.join("; ")).body);
      return;
    }
    const workerKind = String(body.workerKind);
    const provider = this.providerStatus(workerKind);
    if (!provider || provider.status !== "verified") {
      sendJson(res, 422, err(
        422,
        "capability_unavailable",
        `workerKind '${workerKind}' is not verified (status=${provider ? provider.status : "unknown"}); refusing dispatch`,
      ).body);
      return;
    }
    const projectId = String(body.projectId);
    const decision = authorize({
      actor: { type: "service", id: "orca-bridge", role: "service", projects: [projectId] },
      action: "dispatch.execute",
      resource: { kind: "attempt", projectId },
      context: {},
    }) as { verdict: string; reason?: string };
    if (decision.verdict !== "allow") {
      sendJson(res, 403, err(403, "forbidden", `policy denied dispatch: ${decision.reason ?? decision.verdict}`).body);
      return;
    }
    // No new live dispatch when history is ambiguous (real backend only:
    // runners without a full inventory cannot prove the old worker is gone).
    if (!backendHasInventory(this.backend) && this.extras.hasAmbiguousHistory()) {
      sendJson(res, 429, err(
        429,
        "ambiguous_history",
        "an earlier attempt is in unknown state with an unproven runtime; confirm termination before new dispatch",
      ).body);
      return;
    }
    const lease = body.lease as Record<string, unknown>;
    const storeRequest: CreateAttemptRequest = {
      projectId,
      paperclipTaskId: String(body.paperclipTaskId),
      paperclipRunId: String(body.paperclipRunId),
      workerKind,
      contextManifestId: String(body.contextManifestId),
      lease: {
        fencingEpoch: Number(lease.fencingEpoch),
        leaseToken: String(lease.leaseToken),
      },
    };
    if (typeof body.taskTitle === "string") storeRequest.taskTitle = body.taskTitle;
    if (typeof body.instruction === "string") storeRequest.instruction = body.instruction;
    if (typeof body.repositoryId === "string") storeRequest.repositoryId = body.repositoryId;
    const staged: PendingExtras = {
      taskTitle: typeof body.taskTitle === "string" && body.taskTitle ? body.taskTitle : String(body.paperclipTaskId),
      instruction: typeof body.instruction === "string" ? body.instruction : "",
      contextManifestId: String(body.contextManifestId),
      repositoryId: typeof body.repositoryId === "string" ? body.repositoryId : undefined,
      timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
      workerKind,
      lease: {
        fencingEpoch: Number(lease.fencingEpoch),
        leaseToken: String(lease.leaseToken),
      },
      idempotencyKey: key,
      paperclipRunId: String(body.paperclipRunId),
    };
    const taskKey = taskKeyOf(projectId, String(body.paperclipTaskId));
    this.pendingExtras.set(taskKey, staged);
    try {
      try {
        const { receipt, deduplicated } = await this.store.createAttempt(key, storeRequest);
        this.extras.noteAttempt({
          attemptId: receipt.attemptId,
          projectId: receipt.projectId,
          paperclipTaskId: String(body.paperclipTaskId),
          workerKind,
          state: receipt.state,
          fencingEpoch: Number(lease.fencingEpoch),
        });
        if (!deduplicated) {
          this.extras.appendEvent(
            "attempt.accepted",
            { attemptId: receipt.attemptId, paperclipTaskId: String(body.paperclipTaskId) },
            {
              attemptId: receipt.attemptId,
              projectId: receipt.projectId,
              taskId: String(body.paperclipTaskId),
              fencingEpoch: Number(lease.fencingEpoch),
            },
          );
        }
        const resolved = await this.resolveAmbiguousAccept(receipt, body);
        const merged = await this.withLiveStatus(resolved);
        sendJson(res, 202, merged);
      } catch (e) {
        if (e instanceof StoreError && e.code === "dispatch_unknown") {
          // Fate unknown after the durable accept: same-key retry replays
          // without relaunching; this response carries no invented state.
          sendJson(res, 502, err(
            502,
            "dispatch_unknown",
            `${e.message}; retry the same Idempotency-Key to reconcile (no second launch)`,
          ).body);
          return;
        }
        if (e instanceof StoreError) {
          const mapped = storeErrorToResponse(e);
          sendJson(res, mapped.status, mapped.body);
          return;
        }
        throw e;
      }
    } finally {
      this.pendingExtras.delete(taskKey);
    }
  }

  private async handleGetAttempt(res: ServerResponse, attemptId: string): Promise<void> {
    try {
      const receipt = this.store.getAttempt(attemptId);
      sendJson(res, 200, await this.withLiveStatus(receipt));
    } catch (e) {
      if (e instanceof StoreError) {
        const mapped = storeErrorToResponse(e);
        sendJson(res, mapped.status, mapped.body);
        return;
      }
      throw e;
    }
  }

  private async handleCancel(req: IncomingMessage, res: ServerResponse, attemptId: string): Promise<void> {
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || key.length === 0) {
      sendJson(res, 422, err(422, "missing_idempotency_key", "Idempotency-Key header is required").body);
      return;
    }
    let raw: unknown;
    try {
      raw = await readBody(req);
    } catch {
      sendJson(res, 422, err(422, "invalid_json", "request body must be valid JSON").body);
      return;
    }
    const body = asRecord(raw);
    if (!nonEmptyString(body.reason) || !nonEmptyString(body.approvedBy)) {
      sendJson(res, 422, err(422, "validation", "cancel requires non-empty reason and approvedBy").body);
      return;
    }
    let receipt: AttemptReceipt;
    try {
      receipt = this.store.getAttempt(attemptId);
    } catch (e) {
      if (e instanceof StoreError) {
        const mapped = storeErrorToResponse(e);
        sendJson(res, mapped.status, mapped.body);
        return;
      }
      throw e;
    }
    const keyState = this.extras.checkCancelKey(key, attemptId);
    if (keyState === "conflict") {
      sendJson(res, 409, err(409, "idempotency_conflict", "Idempotency-Key was already used for a different attempt").body);
      return;
    }
    if (keyState === "replay") {
      sendJson(res, 202, { requested: true, attemptId, deduplicated: true });
      return;
    }
    // Authority is the service Bearer [REDACTED] + project-scoped service role.
    // `approvedBy` is recorded as audit evidence only; it never authorizes.
    const decision = authorize({
      actor: { type: "service", id: "orca-bridge", role: "service", projects: [receipt.projectId] },
      action: "dispatch.execute",
      resource: { kind: "attempt", id: attemptId, projectId: receipt.projectId },
      context: {},
    }) as { verdict: string; reason?: string };
    if (decision.verdict !== "allow") {
      sendJson(res, 403, err(403, "forbidden", `policy denied cancel: ${decision.reason ?? decision.verdict}`).body);
      return;
    }
    if (["finished", "failed", "cancelled"].includes(receipt.state)) {
      this.extras.bindCancelKey(key, attemptId);
      sendJson(res, 202, { requested: true, attemptId, state: receipt.state });
      return;
    }
    if (!receipt.orcaDispatchId) {
      const confirmed = this.store.confirmTermination(
        attemptId,
        "cancelled",
        `cancel-requested:${String(body.approvedBy)}:no-external-dispatch`,
      );
      this.extras.noteState(attemptId, confirmed.state);
      this.extras.bindCancelKey(key, attemptId);
      sendJson(res, 202, { requested: true, attemptId, state: "cancelled" });
      return;
    }
    try {
      await dispatchCancel(
        this.deps,
        receipt.orcaDispatchId,
        receipt.projectId,
        attemptId,
        key,
        { reason: String(body.reason), approvedBy: String(body.approvedBy) },
      );
      const confirmed = this.store.confirmTermination(
        attemptId,
        "cancelled",
        `cancel-confirmed:${receipt.orcaDispatchId}:by:${String(body.approvedBy)}`,
      );
      this.extras.noteState(attemptId, confirmed.state);
      this.extras.bindCancelKey(key, attemptId);
      sendJson(res, 202, { requested: true, attemptId, state: "cancelled" });
    } catch (e) {
      // Unproven outcome: 202 requested, confirmation pending — never claim
      // a stop the runtime did not confirm.
      if (e instanceof DispatchError && e.code === "CANCEL_UNCONFIRMED") {
        const marked = this.store.markUnknown(attemptId);
        this.extras.noteState(attemptId, marked.state);
        this.extras.bindCancelKey(key, attemptId);
        sendJson(res, 202, { requested: true, attemptId, state: "unknown", confirmation: "pending" });
        return;
      }
      throw e;
    }
  }

  private async handleMessage(req: IncomingMessage, res: ServerResponse, attemptId: string): Promise<void> {
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || key.length === 0) {
      sendJson(res, 422, err(422, "missing_idempotency_key", "Idempotency-Key header is required").body);
      return;
    }
    let raw: unknown;
    try {
      raw = await readBody(req);
    } catch {
      sendJson(res, 422, err(422, "invalid_json", "request body must be valid JSON").body);
      return;
    }
    const body = asRecord(raw);
    for (const field of ["projectId", "threadId", "actorId", "body"]) {
      if (!nonEmptyString(body[field])) {
        sendJson(res, 422, err(422, "validation", `message requires non-empty ${field}`).body);
        return;
      }
    }
    if (String(body.body).length > 20000) {
      sendJson(res, 422, err(422, "validation", "message body exceeds 20000 chars").body);
      return;
    }
    let receipt: AttemptReceipt;
    try {
      receipt = this.store.getAttempt(attemptId);
    } catch (e) {
      if (e instanceof StoreError) {
        const mapped = storeErrorToResponse(e);
        sendJson(res, mapped.status, mapped.body);
        return;
      }
      throw e;
    }
    if (!["running", "waiting"].includes(receipt.state)) {
      sendJson(res, 409, err(409, "attempt_not_messageable", `attempt is ${receipt.state}; messages require running or waiting`).body);
      return;
    }
    const { record, deduplicated } = this.extras.logMessage({
      idempotencyKey: key,
      attemptId,
      projectId: String(body.projectId),
      threadId: String(body.threadId),
      actorId: String(body.actorId),
      body: String(body.body),
      kind: typeof body.kind === "string" ? body.kind : "update",
    });
    if (!deduplicated) {
      this.extras.appendEvent(
        "message.posted",
        {
          messageId: record.messageId,
          attemptId: record.attemptId,
          threadId: record.threadId,
          kind: record.kind,
        },
        { attemptId, projectId: receipt.projectId, fencingEpoch: this.extras.epochOf(attemptId) ?? 1 },
      );
    }
    sendJson(res, 202, {
      messageId: record.messageId,
      attemptId,
      threadId: record.threadId,
      state: "queued",
      deduplicated,
    });
  }

  private listSessions(): SessionView[] {
    const views: SessionView[] = [];
    const seen = new Set<string>();
    const now = new Date().toISOString();
    for (const indexed of this.extras.indexedAttempts()) {
      let receipt: AttemptReceipt | null = null;
      try {
        receipt = this.store.getAttempt(indexed.attemptId);
      } catch {
        continue;
      }
      if (!receipt.orcaDispatchId) continue;
      seen.add(receipt.orcaDispatchId);
      views.push({
        externalId: receipt.orcaDispatchId,
        provider: indexed.workerKind,
        state: toSessionState(receipt.state),
        managed: true,
        taskId: indexed.paperclipTaskId,
        worktreeId: receipt.worktreeId ?? null,
        lastObservedAt: now,
      });
    }
    // Unmanaged inventory: reported, never adopted, always UNKNOWN.
    if (backendHasInventory(this.backend)) {
      for (const s of this.backend.listSessions()) {
        if (seen.has(s.dispatchId)) continue;
        views.push({
          externalId: s.dispatchId,
          provider: null,
          state: "unknown",
          managed: false,
          taskId: null,
          worktreeId: null,
          lastObservedAt: null,
        });
      }
    }
    return views;
  }

  /**
   * Finite SSE replay: buffered frames since `Last-Event-ID`, then close.
   * The pinned adapter client (`streamEvents`) awaits the full body per
   * wake, so v0.1 is poll-compatible; long-lived streaming is future work
   * (see the integration matrix). State GET stays authoritative.
   */
  private sendEvents(res: ServerResponse, cursor: string | null): void {
    const frames = this.extras.eventsSince(cursor && cursor.length > 0 ? cursor : null);
    const text = frames
      .map((f) => `id: ${f.eventId}\ndata: ${JSON.stringify(f.event)}\n`)
      .join("\n");
    const body = text ? `${text}\n` : ": no-events\n\n";
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "content-length": Buffer.byteLength(body),
      connection: "close",
    });
    res.end(body);
  }

  private async handleTestIngest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.allowTestIngest) {
      sendJson(res, 403, err(403, "forbidden", "test ingest is disabled on this bridge").body);
      return;
    }
    let raw: unknown;
    try {
      raw = await readBody(req);
    } catch {
      sendJson(res, 422, err(422, "invalid_json", "request body must be valid JSON").body);
      return;
    }
    const body = asRecord(raw);
    if (!nonEmptyString(body.attemptId) || !nonEmptyString(body.eventType)) {
      sendJson(res, 422, err(422, "validation", "ingest requires attemptId and eventType").body);
      return;
    }
    if (!Number.isInteger(body.fencingEpoch)) {
      sendJson(res, 422, err(422, "validation", "ingest requires integer fencingEpoch").body);
      return;
    }
    const source = typeof body.source === "string" && body.source ? body.source : "fake-orca";
    const sourceEventId =
      typeof body.sourceEventId === "string" && body.sourceEventId
        ? body.sourceEventId
        : `ingest-${Date.now()}-${this.pollSeq}`;
    try {
      const outcome = this.store.applyRuntimeEvent({
        source,
        sourceEventId,
        payload: asRecord(body.payload),
        attemptId: String(body.attemptId),
        eventType: String(body.eventType),
        fencingEpoch: Number(body.fencingEpoch),
      });
      const receipt = this.store.getAttempt(String(body.attemptId));
      this.extras.noteState(String(body.attemptId), receipt.state);
      if (outcome.applied) {
        this.extras.appendEvent(
          String(body.eventType),
          { ...(asRecord(body.payload)), attemptId: String(body.attemptId) },
          {
            attemptId: String(body.attemptId),
            projectId: receipt.projectId,
            fencingEpoch: Number(body.fencingEpoch),
          },
        );
      }
      sendJson(res, 202, { ...outcome, state: receipt.state });
    } catch (e) {
      if (e instanceof StoreError) {
        const mapped = storeErrorToResponse(e);
        sendJson(res, mapped.status, mapped.body);
        return;
      }
      throw e;
    }
  }

  // -- lifecycle --

  listen(): Promise<string> {
    return new Promise((resolve, reject) => {
      const handler = (req: IncomingMessage, res: ServerResponse): void => {
        void this.handle(req, res);
      };
      this.server = createServer(handler);
      this.server.on("error", reject);
      this.server.listen(this.port, this.host, () => {
        const addr = this.server?.address();
        const port = typeof addr === "object" && addr ? addr.port : this.port;
        resolve(`http://${this.host}:${port}`);
      });
    });
  }

  async close(): Promise<void> {
    if (this.server) {
      const open = this.server;
      this.server = null;
      await new Promise<void>((resolve, reject) => {
        open.close((e) => (e ? reject(e) : resolve()));
      });
    }
    this.store.close();
    this.extras.close();
  }

  get lastEventId(): string | null {
    return this.extras.lastEventId;
  }
}

export function validateCreateBody(body: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const allowed = new Set([
    "projectId",
    "paperclipTaskId",
    "paperclipRunId",
    "workerKind",
    "taskTitle",
    "instruction",
    "contextManifestId",
    "repositoryId",
    "lease",
    "timeoutMs",
  ]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) problems.push(`unexpected field: ${key}`);
  }
  for (const field of ["projectId", "paperclipTaskId", "paperclipRunId", "workerKind", "contextManifestId"]) {
    if (!nonEmptyString(body[field])) problems.push(`missing required field: ${field}`);
  }
  const lease = asRecord(body.lease);
  if (!body.lease || typeof body.lease !== "object") {
    problems.push("missing required field: lease");
  } else {
    if (!Number.isInteger(lease.fencingEpoch) || Number(lease.fencingEpoch) < 1) {
      problems.push("lease.fencingEpoch must be an integer >= 1");
    }
    if (!nonEmptyString(lease.leaseToken)) problems.push("lease.leaseToken must be non-empty");
    for (const key of Object.keys(lease)) {
      if (key !== "fencingEpoch" && key !== "leaseToken") problems.push(`unexpected lease field: ${key}`);
    }
  }
  return problems;
}

export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export type { AttemptReceipt, AttemptState, CommandRunner, DispatchDeps, ExternalDispatchIds };
