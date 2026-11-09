/**
 * E03 — Muse worker start/status/cancel bridge (FF-007).
 *
 * Idempotent dispatch of one supervised Muse worker through an installed
 * Orca runtime. Every argv built here uses only flags verified against the
 * installed binary (Orca 1.4.251, `skills get orchestration`,
 * `orchestration <verb> --help`, `agent-context --json`):
 *
 *   orchestration worker-start (--task|--spec|--spec-file) [--task-title]
 *     [--worktree <selector>] (--agent|--terminal) [--name] [--repo]
 *     [--base-branch] [--comment] [--retry-of] [--timeout-ms] [--run]
 *     [--retry-request <id>] [--json]
 *   orchestration worker-show --dispatch <id> [--json]
 *   orchestration worker-stop --dispatch <id> [--retry-request <id>] [--json]
 *   orchestration request-show --request <id> [--json]
 *
 * Deliberately NOT used: `send`, `terminal *`, `worktree create/rm/set`,
 * `open`/`serve`, `reset`, and any flag absent from the verified usage
 * lines. No shell is ever spawned: argv vectors are passed verbatim to the
 * injected runner, so task instructions cannot escape into shell syntax.
 *
 * Reconciliation baseline (coordinator review on PR #35):
 * - Contract #46 (frozen v0.1): `AttemptState`, `AttemptReceipt`,
 *   `AttemptLease`, and `CancelAttemptRequest` are pinned generated types
 *   imported below (type-only); this module extends them but never redefines
 *   them. `StartAttemptInput` carries the frozen `CreateAttemptRequest`
 *   fields (`contextManifestId`, `lease`) and hashes them into the
 *   idempotency record.
 * - Durable ownership #60 (FF-031, OPEN): `DispatchLedger` below is
 *   explicitly QUARANTINED volatile state. It exists so the mock-only
 *   library is testable; it must be replaced by E06 durable persistence
 *   before any live dispatch. A process restart loses un-persisted records
 *   by design, and no caller may treat a restored-but-unpersisted ledger
 *   as proof of the original attempt.
 * - Transport loss (spawn failure, timeout, unreadable reply) is recorded
 *   as `unknown` with the Orca request id and NEVER retried or cleaned up
 *   by this module: reconciliation via `request-show` (or the E06 store
 *   under #60) must prove the original's fate first. No path here can
 *   spawn a second live worker for one idempotency key.
 * - The caller supplies the already-resolved executable (E02 owns
 *   resolution via `resolveOrcaExecutable`); this module never resolves,
 *   guesses, or falls through executables. Linux G1 evidence (issue #2)
 *   remains E02's open item.
 * - Exact live receipt field names are unverified (no worker was started:
 *   the operator's Orca service must not be disturbed). Parsers accept the
 *   documented envelope shapes and fail closed to `unknown`/typed errors
 *   on anything else. Owner-authorized S-02 must capture one real receipt
 *   and tighten these; G2 stays open until then.
 */

import { createHash, randomUUID } from "node:crypto";
import type {
  AttemptLease,
  AttemptReceipt as ContractAttemptReceipt,
  AttemptState as ContractAttemptState,
  CancelAttemptRequest,
} from "../../../../packages/bridge-contracts/generated/bridge.types.ts";

// ---------------------------------------------------------------------------
// Public types (pinned by frozen contract v0.1, issue #46 — do not redefine)
// ---------------------------------------------------------------------------

/** Attempt states: pinned union from the frozen v0.1 contract. */
export type AttemptState = ContractAttemptState;

/**
 * Normalized receipt returned for every start/status/cancel call.
 * Extends the frozen contract receipt with bridge-internal tracking:
 * `orcaRequestId` (the `--retry-request` identity used for reconcile) and
 * `deduplicated` (true when the call was served from the ledger without
 * running any Orca command). Both are transport metadata, never task truth.
 */
export interface AttemptReceipt extends ContractAttemptReceipt {
  orcaDispatchId: string | null;
  orcaRequestId: string | null;
  orcaRunId: string | null;
  orcaTaskId: string | null;
  worktreeId: string | null;
  errorCode: string | null;
  /** True when the call was deduplicated and no Orca command ran. */
  deduplicated?: boolean;
}

/** Re-exported so consumers pin one source for the frozen lease shape. */
export type { AttemptLease, CancelAttemptRequest };

/** New-worker placement. Fresh isolated worktree only: shared writable
 *  checkouts are forbidden by the negative requirements. */
export interface WorkerPlacement {
  mode: "new-top-level";
  /** Repo selector such as `id:<id>`, `name:<name>`, or `path:<path>`. */
  repo: string;
  /** Optional worktree name; omitted lets Orca name it (verified help). */
  name?: string;
  baseBranch?: string;
}

/**
 * Input for one idempotent Muse worker start.
 * Carries the frozen v0.1 `CreateAttemptRequest` identity fields
 * (`contextManifestId`, `lease`); both are hashed into the idempotency
 * record so a key reused with different context or fencing conflicts
 * instead of dispatching (contract case 2, scheduler lease generation).
 */
export interface StartAttemptInput {
  projectId: string;
  paperclipTaskId: string;
  paperclipRunId: string;
  /** Only `muse` is enabled: the only agent id verified for this bridge. */
  workerKind: string;
  taskTitle: string;
  /** Scoped task prompt; passed as one argv element, never shelled. */
  instruction: string;
  /** Immutable context manifest consumed for this attempt (frozen #46). */
  contextManifestId: string;
  /** Scheduler fencing lease authorizing this dispatch (frozen #46). */
  lease: AttemptLease;
  placement: WorkerPlacement;
  /** Bridge idempotency key (OpenAPI: 8..160 chars). */
  idempotencyKey: string;
  /** Optional caller-provided start timeout (maps to --timeout-ms). */
  timeoutMs?: number;
  /** Optional Orca Run to start in; omitted lets Orca bind/create one. */
  runId?: string;
}

/** Raw process outcome from the injected runner. */
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runner owned by the host daemon (real spawn) or tests (fake). */
export type CommandRunner = (
  executable: string,
  argv: readonly string[],
  opts: { timeoutMs?: number },
) => Promise<CommandResult>;

/**
 * Explicit runtime capability evidence required before any worker start.
 * No start runs on assumption: the caller must hand the bridge a
 * version-matched probe result (E02 `CapabilityReport`, owner probe #65,
 * or a fake gate in tests). Unknown/unavailable providers never dispatch.
 *
 * Linux entrypoint correction (#65): the executable must be the packaged
 * CLI shim (`~/.local/bin/orca-ide` or
 * `/opt/orca/squashfs-root/resources/bin/orca-ide` via ELECTRON_RUN_AS_NODE),
 * never the extracted Electron GUI binary
 * (`/opt/orca/squashfs-root/orca-ide`), and never with `--no-sandbox` or
 * setuid/chown repairs. Executable resolution itself is E02-owned; this
 * gate only records which evidence authorized the launch.
 */
export interface CapabilityGate {
  /** True only when a version-matched probe proved the runtime reachable. */
  reachable: boolean;
  /** True only when a probe proved the `muse` agent id launchable. */
  museLaunchVerified: boolean;
  /** Evidence pointer, e.g. "FF-002 CapabilityReport 2026-11-08" or "owner probe #65". */
  evidence: string;
  /** Installed Orca version the evidence was captured from, when known. */
  orcaVersion?: string;
}

/** Injection point for the bridge daemon. */
export interface DispatchDeps {
  /** Pre-resolved Orca executable (E02 owns resolution). */
  executable: string;
  run: CommandRunner;
  /** Required: no `startAttempt` runs without passing this gate. */
  capabilities: CapabilityGate;
  now?: () => Date;
  newAttemptId?: () => string;
}

/** Machine-readable failure. `detail` is redacted for logs. */
export class DispatchError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly detail: string;

  constructor(code: string, message: string, detail = "", retryable = false) {
    super(message);
    this.name = "DispatchError";
    this.code = code;
    this.retryable = retryable;
    this.detail = redactForLog(detail);
  }
}

// ---------------------------------------------------------------------------
// Redaction (local minimal copy; dedupe with E02 `redactPii` post-merge)
// ---------------------------------------------------------------------------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const TOKEN_RE =
  /\b(bearer\s+[A-Za-z0-9._~+/-]+=*|sk-[A-Za-z0-9_-]+|ghp_[A-Za-z0-9_]+|xox[bap]-[A-Za-z0-9-]+)\b/gi;

/** Redact emails, secrets, and home dirs before anything is stored/logged. */
export function redactForLog(text: string): string {
  return text
    .replace(EMAIL_RE, "<redacted-email>")
    .replace(TOKEN_RE, "<redacted-secret>")
    .replace(
      /(\/Users\/[A-Za-z0-9_.-]+|\/home\/[A-Za-z0-9_.-]+)/g,
      "~",
    );
}

// ---------------------------------------------------------------------------
// Fixed-argument command mapping (verified flags only)
// ---------------------------------------------------------------------------

/** The only worker kind this bridge may launch. */
export const SUPPORTED_WORKER_KIND = "muse";

/**
 * Stable Orca request id derived from the bridge idempotency key, passed
 * as `--retry-request` so a retried start after a lost response replays
 * Orca's recorded outcome instead of spawning a second worker. Assumption
 * pending S-02 live confirmation: Orca records the id on first use.
 */
export function deriveOrcaRequestId(idempotencyKey: string): string {
  return `ff-${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32)}`;
}

/** Canonical hash of everything the key is bound to (409 on mismatch). */
export function hashStartRequest(input: StartAttemptInput): string {
  const canonical = {
    baseBranch: input.placement.baseBranch ?? null,
    contextManifestId: input.contextManifestId,
    fencingEpoch: input.lease?.fencingEpoch ?? null,
    instruction: input.instruction,
    leaseToken: input.lease?.leaseToken ?? null,
    name: input.placement.name ?? null,
    paperclipRunId: input.paperclipRunId,
    paperclipTaskId: input.paperclipTaskId,
    projectId: input.projectId,
    repo: input.placement.repo,
    runId: input.runId ?? null,
    taskTitle: input.taskTitle,
    timeoutMs: input.timeoutMs ?? null,
    workerKind: input.workerKind,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function assertValidKey(key: string): void {
  if (key.length < 8 || key.length > 160) {
    throw new DispatchError(
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key must be 8..160 chars (bridge.openapi.yaml).",
      `length=${key.length}`,
      false,
    );
  }
}

function assertValidStartInput(input: StartAttemptInput): void {
  assertValidKey(input.idempotencyKey);
  if (input.workerKind !== SUPPORTED_WORKER_KIND) {
    throw new DispatchError(
      "UNSUPPORTED_WORKER_KIND",
      `workerKind '${input.workerKind}' is not enabled on this bridge; only '${SUPPORTED_WORKER_KIND}' is verified. No CLI flags were guessed.`,
      `workerKind=${input.workerKind}`,
      false,
    );
  }
  const lease = input.lease ?? ({} as AttemptLease);
  for (const [field, value] of [
    ["projectId", input.projectId],
    ["paperclipTaskId", input.paperclipTaskId],
    ["paperclipRunId", input.paperclipRunId],
    ["taskTitle", input.taskTitle],
    ["instruction", input.instruction],
    ["contextManifestId", input.contextManifestId],
    ["lease.leaseToken", lease.leaseToken],
    ["placement.repo", input.placement.repo],
  ] as const) {
    if (!value || !value.trim()) {
      throw new DispatchError(
        "INVALID_START_REQUEST",
        `Missing required field: ${field}.`,
        field,
        false,
      );
    }
  }
  if (!Number.isInteger(lease.fencingEpoch) || lease.fencingEpoch < 1) {
    throw new DispatchError(
      "INVALID_START_REQUEST",
      "lease.fencingEpoch must be an integer >= 1 (frozen contract #46).",
      `fencingEpoch=${String(lease.fencingEpoch)}`,
      false,
    );
  }
}

/**
 * Require explicit runtime capability evidence before any worker start.
 * Read-only inspection (`worker-show`, `request-show`, status) is never
 * gated: only the mutating start path calls this. Unknown, unavailable,
 * or unevidenced providers throw without touching the runner.
 */
export function assertCapabilityGate(gate: CapabilityGate | undefined): void {
  if (!gate || !gate.reachable || !gate.museLaunchVerified) {
    throw new DispatchError(
      "CAPABILITY_UNVERIFIED",
      "Refusing worker start: no explicit capability evidence that the runtime is reachable and the muse agent is launchable. Supply a version-matched probe result (E02 report, owner probe #65).",
      `reachable=${String(gate?.reachable)} museLaunchVerified=${String(gate?.museLaunchVerified)}`,
      false,
    );
  }
  if (!gate.evidence?.trim()) {
    throw new DispatchError(
      "CAPABILITY_UNVERIFIED",
      "Refusing worker start: capability evidence pointer is empty. Name the probe (e.g. owner probe #65) so the launch is auditable.",
      "",
      false,
    );
  }
}

/** Fixed argv for `orchestration worker-start`. */
export function buildStartArgv(input: StartAttemptInput): string[] {
  assertValidStartInput(input);
  const argv = [
    "orchestration",
    "worker-start",
    "--spec",
    input.instruction,
    "--task-title",
    input.taskTitle,
    "--worktree",
    "new-top-level",
    "--repo",
    input.placement.repo,
    "--agent",
    SUPPORTED_WORKER_KIND,
  ];
  if (input.placement.name) argv.push("--name", input.placement.name);
  if (input.placement.baseBranch) {
    argv.push("--base-branch", input.placement.baseBranch);
  }
  argv.push(
    "--comment",
    `forgefleet:${input.paperclipTaskId}:${input.paperclipRunId}`,
  );
  if (input.runId) argv.push("--run", input.runId);
  if (input.timeoutMs !== undefined) {
    argv.push("--timeout-ms", String(input.timeoutMs));
  }
  argv.push("--retry-request", deriveOrcaRequestId(input.idempotencyKey));
  argv.push("--json");
  return argv;
}

/** Fixed argv for `orchestration worker-show`. */
export function buildStatusArgv(orcaDispatchId: string): string[] {
  if (!orcaDispatchId.trim()) {
    throw new DispatchError(
      "INVALID_DISPATCH_ID",
      "orcaDispatchId must be non-empty.",
      "",
      false,
    );
  }
  return ["orchestration", "worker-show", "--dispatch", orcaDispatchId, "--json"];
}

/** Fixed argv for `orchestration worker-stop` (cancel). */
export function buildCancelArgv(
  orcaDispatchId: string,
  idempotencyKey: string,
): string[] {
  if (!orcaDispatchId.trim()) {
    throw new DispatchError(
      "INVALID_DISPATCH_ID",
      "orcaDispatchId must be non-empty.",
      "",
      false,
    );
  }
  assertValidKey(idempotencyKey);
  return [
    "orchestration",
    "worker-stop",
    "--dispatch",
    orcaDispatchId,
    "--retry-request",
    deriveOrcaRequestId(idempotencyKey),
    "--json",
  ];
}

/** Fixed argv for `orchestration request-show` (reconcile a lost reply). */
export function buildRequestShowArgv(orcaRequestId: string): string[] {
  if (!orcaRequestId.trim()) {
    throw new DispatchError(
      "INVALID_REQUEST_ID",
      "orcaRequestId must be non-empty.",
      "",
      false,
    );
  }
  return ["orchestration", "request-show", "--request", orcaRequestId, "--json"];
}

// ---------------------------------------------------------------------------
// Receipt parsing (defensive: fail closed, never fabricate IDs)
// ---------------------------------------------------------------------------

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function firstString(
  ...candidates: unknown[]
): string | null {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c;
  }
  return null;
}

/**
 * Extract runtime IDs from a worker-start `--json` receipt. Accepts the
 * `result`-envelope and top-level shapes; returns null when no dispatch
 * identity is provable so the caller fails closed instead of inventing one.
 */
export function extractStartIds(
  parsed: unknown,
): {
  orcaDispatchId: string | null;
  orcaRunId: string | null;
  orcaTaskId: string | null;
  worktreeId: string | null;
  orcaRequestId: string | null;
} | null {
  const root = asRecord(parsed);
  const result = asRecord(root["result"] ?? root);
  const dispatch = asRecord(result["dispatch"] ?? result["worker"] ?? {});
  const orcaDispatchId = firstString(
    result["dispatchId"],
    result["dispatch_id"],
    dispatch["dispatchId"],
    dispatch["dispatch_id"],
    dispatch["id"],
    root["dispatchId"],
  );
  if (!orcaDispatchId) return null;
  const worktree = asRecord(result["worktree"] ?? dispatch["worktree"] ?? {});
  return {
    orcaDispatchId,
    orcaRunId: firstString(
      result["runId"],
      result["run_id"],
      dispatch["runId"],
      root["runId"],
    ),
    orcaTaskId: firstString(
      result["taskId"],
      result["task_id"],
      dispatch["taskId"],
      root["taskId"],
    ),
    worktreeId: firstString(
      result["worktreeId"],
      result["worktree_id"],
      worktree["worktreeId"],
      worktree["id"],
      dispatch["worktreeId"],
    ),
    orcaRequestId: firstString(
      result["requestId"],
      result["request_id"],
      root["requestId"],
      root["request_id"],
    ),
  };
}

function receiptBase(
  deps: DispatchDeps,
  input: { projectId: string },
  attemptId: string,
  state: AttemptState,
): AttemptReceipt {
  return {
    attemptId,
    errorCode: null,
    observedAt: (deps.now?.() ?? new Date()).toISOString(),
    orcaDispatchId: null,
    orcaRequestId: null,
    orcaRunId: null,
    orcaTaskId: null,
    projectId: input.projectId,
    state,
    worktreeId: null,
  };
}

// ---------------------------------------------------------------------------
// QUARANTINED volatile idempotency ledger (FF-031 #60: replace with E06
// durable persistence before any live dispatch; a restart loses records)
// ---------------------------------------------------------------------------

export interface LedgerRecord {
  attemptId: string;
  requestHash: string;
  projectId: string;
  /** Scheduler fencing generation authorizing this dispatch. */
  fencingEpoch: number;
  orcaDispatchId: string | null;
  orcaRequestId: string;
  orcaRunId: string | null;
  orcaTaskId: string | null;
  worktreeId: string | null;
  state: AttemptState;
}

/** Key -> record snapshot, loadable/savable for E06 adoption. */
export type LedgerSnapshot = Record<string, LedgerRecord>;

/** In-memory idempotency ledger: same key + same payload replays locally;
 *  same key + different payload conflicts WITHOUT dispatching. */
export class DispatchLedger {
  private readonly records = new Map<string, LedgerRecord>();

  get(key: string): LedgerRecord | undefined {
    return this.records.get(key);
  }

  set(key: string, record: LedgerRecord): void {
    this.records.set(key, record);
  }

  snapshot(): LedgerSnapshot {
    return Object.fromEntries(this.records);
  }

  static restore(snapshot: LedgerSnapshot): DispatchLedger {
    const ledger = new DispatchLedger();
    for (const [key, record] of Object.entries(snapshot)) {
      ledger.set(key, record);
    }
    return ledger;
  }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Idempotent Muse worker start. Exactly one Orca dispatch per
 * (key, payload): replays return the stored receipt without running any
 * command; key reuse with a different payload raises 409-equivalent
 * without side effects. Transport loss after dispatch records `unknown`
 * with the request id so `reconcileStart` can recover via request-show.
 */
export async function startAttempt(
  deps: DispatchDeps,
  ledger: DispatchLedger,
  input: StartAttemptInput,
): Promise<AttemptReceipt> {
  assertValidStartInput(input);
  assertCapabilityGate(deps.capabilities);
  const requestHash = hashStartRequest(input);
  const existing = ledger.get(input.idempotencyKey);
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new DispatchError(
        "IDEMPOTENCY_CONFLICT",
        "Idempotency-Key was already used with a different payload; refusing to dispatch (409, no side effect).",
        `key=${redactForLog(input.idempotencyKey)}`,
        false,
      );
    }
    const receipt = receiptBase(deps, input, existing.attemptId, existing.state);
    receipt.orcaDispatchId = existing.orcaDispatchId;
    receipt.orcaRequestId = existing.orcaRequestId;
    receipt.orcaRunId = existing.orcaRunId;
    receipt.orcaTaskId = existing.orcaTaskId;
    receipt.worktreeId = existing.worktreeId;
    receipt.deduplicated = true;
    return receipt;
  }

  const attemptId = deps.newAttemptId?.() ?? randomUUID();
  const orcaRequestId = deriveOrcaRequestId(input.idempotencyKey);
  let raw: CommandResult;
  try {
    raw = await deps.run(deps.executable, buildStartArgv(input), {
      timeoutMs: input.timeoutMs,
    });
  } catch (err) {
    // Spawn/transport failure: Orca may still have accepted. Record
    // `unknown` with the request id so reconcile can prove the outcome.
    // Never retry or clean up here: any second action could double-spawn
    // (F05, #60). Reconciliation must prove the original's fate first.
    const record: LedgerRecord = {
      attemptId,
      fencingEpoch: input.lease.fencingEpoch,
      orcaDispatchId: null,
      orcaRequestId,
      orcaRunId: null,
      orcaTaskId: null,
      projectId: input.projectId,
      requestHash,
      state: "unknown",
      worktreeId: null,
    };
    ledger.set(input.idempotencyKey, record);
    const receipt = receiptBase(deps, input, attemptId, "unknown");
    receipt.orcaRequestId = orcaRequestId;
    receipt.errorCode = "START_TRANSPORT_LOST";
    receipt.deduplicated = false;
    void err;
    return receipt;
  }

  const receipt = receiptBase(deps, input, attemptId, "accepted");
  receipt.orcaRequestId = orcaRequestId;
  receipt.deduplicated = false;
  if (raw.exitCode !== 0) {
    // Orca explicitly refused/failed the start: record it and throw with
    // the real stage info so the caller never mistakes this for success.
    const parsed = safeJsonParse(raw.stdout);
    const info = asRecord(asRecord(parsed)["result"] ?? parsed);
    const stage = firstString(
      info["failedStage"],
      info["failed_stage"],
      info["stage"],
      `exit:${raw.exitCode}`,
    );
    const record: LedgerRecord = {
      attemptId,
      fencingEpoch: input.lease.fencingEpoch,
      orcaDispatchId: null,
      orcaRequestId,
      orcaRunId: null,
      orcaTaskId: null,
      projectId: input.projectId,
      requestHash,
      state: "failed",
      worktreeId: null,
    };
    ledger.set(input.idempotencyKey, record);
    throw new DispatchError(
      "START_FAILED",
      "Orca refused or failed the worker start.",
      `stage=${redactForLog(stage ?? "unknown")} ${redactForLog(raw.stderr.slice(0, 500))}`,
      false,
    );
  }

  const ids = extractStartIds(safeJsonParse(raw.stdout));
  if (!ids) {
    const record: LedgerRecord = {
      attemptId,
      fencingEpoch: input.lease.fencingEpoch,
      orcaDispatchId: null,
      orcaRequestId,
      orcaRunId: null,
      orcaTaskId: null,
      projectId: input.projectId,
      requestHash,
      state: "unknown",
      worktreeId: null,
    };
    ledger.set(input.idempotencyKey, record);
    receipt.state = "unknown";
    receipt.errorCode = "RECEIPT_UNPARSEABLE";
    return receipt;
  }
  const record: LedgerRecord = {
    attemptId,
    fencingEpoch: input.lease.fencingEpoch,
    orcaDispatchId: ids.orcaDispatchId,
    orcaRequestId: ids.orcaRequestId ?? orcaRequestId,
    orcaRunId: ids.orcaRunId,
    orcaTaskId: ids.orcaTaskId,
    projectId: input.projectId,
    requestHash,
    state: "dispatching",
    worktreeId: ids.worktreeId,
  };
  ledger.set(input.idempotencyKey, record);
  receipt.state = "dispatching";
  receipt.orcaDispatchId = ids.orcaDispatchId;
  receipt.orcaRequestId = record.orcaRequestId;
  receipt.orcaRunId = ids.orcaRunId;
  receipt.orcaTaskId = ids.orcaTaskId;
  receipt.worktreeId = ids.worktreeId;
  return receipt;
}

/** Conservative Orca status vocabulary -> bridge state. Unlisted or
 *  absent statuses map to `unknown`: silence never proves exit. */
const FINISHED_TOKENS = new Set([
  "finished",
  "done",
  "completed",
  "settled",
  "closed",
]);
const FAILED_TOKENS = new Set(["failed", "error", "errored"]);
const RUNNING_TOKENS = new Set(["running", "active", "working", "started"]);
const WAITING_TOKENS = new Set(["waiting", "pending", "parked"]);

export function mapWorkerStatus(rawStatus: unknown): AttemptState {
  if (typeof rawStatus !== "string") return "unknown";
  const token = rawStatus.trim().toLowerCase();
  if (FINISHED_TOKENS.has(token)) return "finished";
  if (FAILED_TOKENS.has(token)) return "failed";
  if (RUNNING_TOKENS.has(token)) return "running";
  if (WAITING_TOKENS.has(token)) return "waiting";
  return "unknown";
}

/**
 * Read-only status for one dispatch. Never infers terminal states from
 * transport signals: runner failure or an unrecognized shape yields
 * `unknown`, not `finished`/`failed`.
 */
export async function getAttemptStatus(
  deps: DispatchDeps,
  orcaDispatchId: string,
  projectId: string,
  attemptId: string,
): Promise<AttemptReceipt> {
  const receipt = receiptBase(deps, { projectId }, attemptId, "unknown");
  let raw: CommandResult;
  try {
    raw = await deps.run(deps.executable, buildStatusArgv(orcaDispatchId), {});
  } catch {
    receipt.errorCode = "STATUS_TRANSPORT_LOST";
    return receipt;
  }
  const parsed = safeJsonParse(raw.stdout);
  if (parsed === null) {
    receipt.errorCode = "STATUS_UNPARSEABLE";
    return receipt;
  }
  const root = asRecord(parsed);
  const result = asRecord(root["result"] ?? root);
  const dispatch = asRecord(result["dispatch"] ?? result["worker"] ?? {});
  receipt.orcaDispatchId = orcaDispatchId;
  receipt.orcaRunId = firstString(result["runId"], dispatch["runId"]);
  receipt.orcaTaskId = firstString(result["taskId"], dispatch["taskId"]);
  const worktree = asRecord(result["worktree"] ?? dispatch["worktree"] ?? {});
  receipt.worktreeId = firstString(result["worktreeId"], worktree["id"]);
  const failedStage = firstString(
    result["failedStage"],
    dispatch["failedStage"],
  );
  if (failedStage) {
    receipt.state = "failed";
    receipt.errorCode = "WORKER_FAILED_STAGE";
    return receipt;
  }
  receipt.state = mapWorkerStatus(
    firstString(
      result["state"],
      result["status"],
      dispatch["state"],
      dispatch["status"],
      result["terminalState"],
    ) ?? undefined,
  );
  if (receipt.state === "unknown") receipt.errorCode = "STATUS_UNRECOGNIZED";
  return receipt;
}

/**
 * Guarded cancel: claims `cancelled` only on a confirmed stopped result.
 * `stop_unknown` (exit 1) and unrecognized receipts raise
 * CANCEL_UNCONFIRMED so the caller inspects via worker-show instead of
 * assuming the agent stopped (verified recovery guide).
 *
 * Authorization mirrors the frozen v0.1 `CancelAttemptRequest`: `reason`
 * and `approvedBy` are required, validated here, and redacted in all
 * stored detail. The CLI itself carries no identity flag, so these fields
 * authorize the bridge call (policy layer) rather than the argv.
 */
export async function cancelAttempt(
  deps: DispatchDeps,
  orcaDispatchId: string,
  projectId: string,
  attemptId: string,
  idempotencyKey: string,
  cancel: CancelAttemptRequest,
): Promise<AttemptReceipt> {
  if (!cancel.reason?.trim() || !cancel.approvedBy?.trim()) {
    throw new DispatchError(
      "INVALID_CANCEL_REQUEST",
      "Cancel requires non-empty reason and approvedBy (frozen contract #46).",
      "",
      false,
    );
  }
  const receipt = receiptBase(deps, { projectId }, attemptId, "unknown");
  receipt.orcaDispatchId = orcaDispatchId;
  let raw: CommandResult;
  try {
    raw = await deps.run(
      deps.executable,
      buildCancelArgv(orcaDispatchId, idempotencyKey),
      {},
    );
  } catch {
    receipt.errorCode = "CANCEL_TRANSPORT_LOST";
    throw new DispatchError(
      "CANCEL_UNCONFIRMED",
      "Cancel command transport failed; worker state unproven. Inspect via worker-show before acting again.",
      `dispatch=${redactForLog(orcaDispatchId)}`,
      true,
    );
  }
  const text = `${raw.stdout}\n${raw.stderr}`.toLowerCase();
  const stopped =
    text.includes("stopped") ||
    text.includes("closed_agent_terminal") ||
    (raw.exitCode === 0 &&
      (text.includes("cancelled") || text.includes("canceled")));
  if (raw.exitCode === 0 && stopped) {
    receipt.state = "cancelled";
    return receipt;
  }
  receipt.errorCode = raw.exitCode === 1 && text.includes("stop_unknown")
    ? "STOP_UNKNOWN"
    : "CANCEL_UNCONFIRMED";
  throw new DispatchError(
    "CANCEL_UNCONFIRMED",
    "Cancel outcome unproven (stop_unknown or unrecognized receipt). Check worker-show before acting again; do not blindly repeat stop.",
    `dispatch=${redactForLog(orcaDispatchId)} exit=${raw.exitCode}`,
    true,
  );
}

/**
 * Reconcile a start whose reply was lost (bridge crash between dispatch
 * and receipt). Read-only: asks Orca whether the recorded request already
 * took effect. Returns completed | pending | absent; `absent` authorizes a
 * fresh `startAttempt` under a NEW idempotency key (never reuse the old
 * key with a different payload — that path is a 409 by design).
 */
export async function reconcileStart(
  deps: DispatchDeps,
  orcaRequestId: string,
): Promise<"completed" | "pending" | "absent"> {
  let raw: CommandResult;
  try {
    raw = await deps.run(deps.executable, buildRequestShowArgv(orcaRequestId), {});
  } catch {
    return "pending";
  }
  const parsed = safeJsonParse(raw.stdout);
  if (parsed === null) return "pending";
  const root = asRecord(parsed);
  const result = asRecord(root["result"] ?? root);
  const status = firstString(
    result["status"],
    result["state"],
    root["status"],
    root["state"],
  );
  const text = `${raw.stdout}`.toLowerCase();
  if (status === "completed" || text.includes("completed")) return "completed";
  if (status === "absent" || text.includes("absent")) return "absent";
  return "pending";
}
