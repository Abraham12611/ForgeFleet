/**
 * E06 — Durable attempt mapping and idempotency (FF-006).
 *
 * In-memory store implementing the policy/state semantics required by
 * `docs/05-contracts/bridge.openapi.yaml` (createAttempt idempotency),
 * `docs/05-contracts/events.md` (receipt-before-ack, at-least-once outbox),
 * `docs/05-contracts/state-machines.md` (attempt machine, fencing) and
 * `docs/03-architecture/domain-and-data-model.md` (cross-system ID mapping).
 *
 * Guarantees:
 * - Same `Idempotency-Key` + same request hash returns the same attempt
 *   without a second runtime dispatch, even for concurrent duplicates.
 * - Same key + different request hash is a 409 with no side effect.
 * - At most one non-terminal attempt per task; a replacement requires a
 *   strictly greater fencing epoch and proof the prior attempt is gone.
 * - Runtime event receipts `(source, sourceEventId)` are deduplicated and
 *   applied transactionally with outbox enqueueing (receipt + outbox share
 *   one synchronous critical section — no ack before persistence).
 * - Outbox delivery is at-least-once with exponential backoff and a
 *   dead-letter queue carrying a human-visible reason.
 * - Restart reconciliation adopts provable original dispatches and marks
 *   everything else `unknown`; nothing relaunches blindly.
 *
 * Durability note: this module owns the semantics and transactional
 * boundaries. Snapshot/restore (`snapshot()` / `AttemptStore.restore()`)
 * carries full state across a process restart in tests. The PostgreSQL
 * backing (aligned with Paperclip's schema conventions) is future work
 * with E01/E05; the SQL migration must preserve these exact invariants.
 */

import { createHash, randomUUID } from "node:crypto";

/** Non-terminal attempt states that hold the task lease. */
export const ACTIVE_ATTEMPT_STATES = [
  "requested",
  "accepted",
  "dispatching",
  "running",
  "waiting",
  "unknown",
] as const;

/** Terminal attempt states: the lease is released. */
export const TERMINAL_ATTEMPT_STATES = ["finished", "failed", "cancelled"] as const;

export type AttemptState =
  | (typeof ACTIVE_ATTEMPT_STATES)[number]
  | (typeof TERMINAL_ATTEMPT_STATES)[number];

export interface AttemptLease {
  fencingEpoch: number;
  leaseToken: string;
}

/** Mirrors `CreateAttemptRequest` in `bridge.openapi.yaml` v0.1 draft. */
export interface CreateAttemptRequest {
  projectId: string;
  paperclipTaskId: string;
  paperclipRunId: string;
  workerKind: string;
  taskTitle?: string;
  instruction?: string;
  contextManifestId: string;
  repositoryId?: string;
  lease: AttemptLease;
}

export interface ExternalDispatchIds {
  orcaRunId?: string;
  orcaTaskId?: string;
  orcaDispatchId?: string;
  orcaSessionId?: string;
  worktreeId?: string;
}

export interface ExecutionAttempt extends ExternalDispatchIds {
  attemptId: string;
  projectId: string;
  paperclipTaskId: string;
  paperclipRunId: string;
  workerKind: string;
  fencingEpoch: number;
  leaseToken: string;
  state: AttemptState;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `AttemptReceipt` shape from `bridge.openapi.yaml`. */
export interface AttemptReceipt extends ExternalDispatchIds {
  attemptId: string;
  projectId: string;
  state: AttemptState;
  observedAt: string;
  errorCode: string | null;
  /** True when this response replayed an earlier accepted request. */
  deduplicated: boolean;
}

interface DispatchRequestRecord {
  idempotencyKey: string;
  requestHash: string;
  attemptId: string;
  createdAt: string;
}

interface EventReceiptRecord {
  payloadSha256: string;
  receivedAt: string;
}

export interface OutboxEntry {
  id: string;
  eventType: string;
  body: Record<string, unknown>;
  destination: string;
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  deliveredAt: string | null;
  deadLettered: boolean;
  deadLetterReason: string | null;
}

export interface ObservedDispatch {
  externalDispatchId: string;
  paperclipTaskId?: string;
  leaseToken?: string;
  state: "running" | "terminal";
}

export interface ReconcileReport {
  adopted: string[];
  markedUnknown: string[];
  alreadyTerminal: string[];
}

export type StoreErrorCode =
  | "validation"
  | "idempotency_conflict"
  | "active_lease"
  | "unknown_attempt"
  | "stale_epoch";

export class StoreError extends Error {
  readonly code: StoreErrorCode;
  /** HTTP status the bridge should surface for this failure. */
  readonly status: number;
  constructor(code: StoreErrorCode, status: number, message: string) {
    super(message);
    this.name = "StoreError";
    this.code = code;
    this.status = status;
  }
}

/** Result of the injected runtime launcher (owned by E03 in production). */
export interface DispatchResult extends ExternalDispatchIds {
  /** State the runtime accepted the attempt into. */
  state: "dispatching" | "running";
}

/** Snapshot carried across a process restart. */
export interface StoreSnapshot {
  version: 1;
  attempts: ExecutionAttempt[];
  dispatchRequests: DispatchRequestRecord[];
  receipts: [string, EventReceiptRecord][];
  outbox: OutboxEntry[];
}

export interface AttemptStoreOptions {
  /** Milliseconds clock; inject a fake in tests. Defaults to Date.now. */
  now?: () => number;
  /**
   * Runtime launcher. Called at most once per accepted attempt while the
   * store holds the creation lock — concurrent duplicates never reach it
   * twice for the same idempotency key. Throwing marks the attempt
   * `failed` with the launcher error; the dispatch request row is kept so
   * retries replay deterministically.
   */
  dispatch?: (attempt: ExecutionAttempt) => Promise<DispatchResult>;
  maxOutboxAttempts?: number;
  outboxBaseDelayMs?: number;
  outboxMaxDelayMs?: number;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const body = keys
    .map(
      (k) =>
        `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
    )
    .join(",");
  return `{${body}}`;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isActive(state: AttemptState): boolean {
  return (ACTIVE_ATTEMPT_STATES as readonly string[]).includes(state);
}

const IDEMPOTENCY_KEY_RE = /^[\x21-\x7E]{8,160}$/;

function validateCreateInput(
  idempotencyKey: string,
  request: CreateAttemptRequest,
): string[] {
  const errors: string[] = [];
  if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    errors.push("Idempotency-Key must be 8-160 printable ASCII characters");
  }
  if (!request.projectId) errors.push("projectId is required");
  if (!request.paperclipTaskId) errors.push("paperclipTaskId is required");
  if (!request.paperclipRunId) errors.push("paperclipRunId is required");
  if (!request.workerKind) errors.push("workerKind is required");
  if (!request.contextManifestId) errors.push("contextManifestId is required");
  const lease = request.lease;
  if (
    !lease ||
    !Number.isInteger(lease.fencingEpoch) ||
    lease.fencingEpoch < 1
  ) {
    errors.push("lease.fencingEpoch must be an integer >= 1");
  }
  if (!lease || !lease.leaseToken) errors.push("lease.leaseToken is required");
  return errors;
}

export class AttemptStore {
  private readonly clock: () => number;
  private readonly launcher: (
    attempt: ExecutionAttempt,
  ) => Promise<DispatchResult>;
  private readonly maxOutboxAttempts: number;
  private readonly outboxBaseDelayMs: number;
  private readonly outboxMaxDelayMs: number;

  private attempts = new Map<string, ExecutionAttempt>();
  private attemptsByTask = new Map<string, string[]>();
  private dispatchRequests = new Map<string, DispatchRequestRecord>();
  private receipts = new Map<string, EventReceiptRecord>();
  private outbox = new Map<string, OutboxEntry>();
  /** Serializes critical sections; keyed so unrelated work is not blocked. */
  private tails = new Map<string, Promise<void>>();

  constructor(options: AttemptStoreOptions = {}) {
    this.clock = options.now ?? (() => Date.now());
    this.launcher =
      options.dispatch ??
      (async () => ({ state: "dispatching" as const }));
    this.maxOutboxAttempts = options.maxOutboxAttempts ?? 10;
    this.outboxBaseDelayMs = options.outboxBaseDelayMs ?? 1000;
    this.outboxMaxDelayMs = options.outboxMaxDelayMs ?? 5 * 60 * 1000;
  }

  static restore(snapshot: StoreSnapshot, options: AttemptStoreOptions = {}): AttemptStore {
    if (snapshot.version !== 1) {
      throw new StoreError(
        "validation",
        422,
        `unsupported snapshot version ${String((snapshot as { version?: unknown }).version)}`,
      );
    }
    const store = new AttemptStore(options);
    for (const attempt of snapshot.attempts) {
      store.attempts.set(attempt.attemptId, { ...attempt });
      const key = store.taskKey(attempt.projectId, attempt.paperclipTaskId);
      const list = store.attemptsByTask.get(key) ?? [];
      list.push(attempt.attemptId);
      store.attemptsByTask.set(key, list);
    }
    for (const record of snapshot.dispatchRequests) {
      store.dispatchRequests.set(record.idempotencyKey, { ...record });
    }
    for (const [key, receipt] of snapshot.receipts) {
      store.receipts.set(key, { ...receipt });
    }
    for (const entry of snapshot.outbox) {
      store.outbox.set(entry.id, { ...entry, body: { ...entry.body } });
    }
    return store;
  }

  snapshot(): StoreSnapshot {
    return {
      version: 1,
      attempts: [...this.attempts.values()].map((a) => ({ ...a })),
      dispatchRequests: [...this.dispatchRequests.values()].map((r) => ({
        ...r,
      })),
      receipts: [...this.receipts.entries()].map(([k, v]) => [k, { ...v }]),
      outbox: [...this.outbox.values()].map((e) => ({
        ...e,
        body: { ...e.body },
      })),
    };
  }

  private isoNow(): string {
    return new Date(this.clock()).toISOString();
  }

  private taskKey(projectId: string, paperclipTaskId: string): string {
    return `${projectId}::${paperclipTaskId}`;
  }

  private async withLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(keys)].sort();
    const prevs = ordered.map((k) => this.tails.get(k) ?? Promise.resolve());
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (const k of ordered) {
      const prev = this.tails.get(k) ?? Promise.resolve();
      this.tails.set(
        k,
        prev.then(
          () => current,
          () => current,
        ),
      );
    }
    await Promise.allSettled(prevs);
    try {
      return await fn();
    } finally {
      release();
      for (const k of ordered) {
        if (this.tails.get(k) === current) this.tails.delete(k);
      }
    }
  }

  private toReceipt(
    attempt: ExecutionAttempt,
    deduplicated: boolean,
  ): AttemptReceipt {
    return {
      attemptId: attempt.attemptId,
      projectId: attempt.projectId,
      state: attempt.state,
      observedAt: this.isoNow(),
      orcaRunId: attempt.orcaRunId,
      orcaTaskId: attempt.orcaTaskId,
      orcaDispatchId: attempt.orcaDispatchId,
      orcaSessionId: attempt.orcaSessionId,
      worktreeId: attempt.worktreeId,
      errorCode: attempt.errorCode,
      deduplicated,
    };
  }

  private activeAttemptFor(
    projectId: string,
    paperclipTaskId: string,
  ): ExecutionAttempt | null {
    const ids = this.attemptsByTask.get(
      this.taskKey(projectId, paperclipTaskId),
    ) ?? [];
    for (const id of ids) {
      const attempt = this.attempts.get(id);
      if (attempt && isActive(attempt.state)) return attempt;
    }
    return null;
  }

  private maxEpochFor(projectId: string, paperclipTaskId: string): number {
    const ids = this.attemptsByTask.get(
      this.taskKey(projectId, paperclipTaskId),
    ) ?? [];
    let max = 0;
    for (const id of ids) {
      const attempt = this.attempts.get(id);
      if (attempt && attempt.fencingEpoch > max) max = attempt.fencingEpoch;
    }
    return max;
  }

  private enqueueOutbound(
    eventType: string,
    body: Record<string, unknown>,
    destination: string,
  ): void {
    const id = randomUUID();
    this.outbox.set(id, {
      id,
      eventType,
      body: { ...body },
      destination,
      attempts: 0,
      nextAttemptAt: this.isoNow(),
      lastError: null,
      deliveredAt: null,
      deadLettered: false,
      deadLetterReason: null,
    });
  }

  /**
   * Create (or replay) an attempt. Concurrent duplicates with the same key
   * and payload launch the runtime at most once; the same key with a
   * different payload fails 409 with no side effect; a held task lease
   * fails 409 without dispatching.
   */
  async createAttempt(
    idempotencyKey: string,
    request: CreateAttemptRequest,
  ): Promise<AttemptReceipt> {
    const errors = validateCreateInput(idempotencyKey, request);
    if (errors.length > 0) {
      throw new StoreError("validation", 422, errors.join("; "));
    }
    const requestHash = sha256Hex(stableStringify(request));
    return this.withLocks(
      [`idem:${idempotencyKey}`, `task:${this.taskKey(request.projectId, request.paperclipTaskId)}`],
      async () => {
        const existing = this.dispatchRequests.get(idempotencyKey);
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new StoreError(
              "idempotency_conflict",
              409,
              "Idempotency-Key was already used with a different payload",
            );
          }
          const attempt = this.attempts.get(existing.attemptId);
          if (!attempt) {
            throw new StoreError(
              "unknown_attempt",
              404,
              "idempotency record points at a missing attempt",
            );
          }
          return this.toReceipt(attempt, true);
        }

        const holder = this.activeAttemptFor(
          request.projectId,
          request.paperclipTaskId,
        );
        if (holder) {
          throw new StoreError(
            "active_lease",
            409,
            `task already has active attempt ${holder.attemptId} in state ${holder.state}`,
          );
        }
        if (request.lease.fencingEpoch <= this.maxEpochFor(
          request.projectId,
          request.paperclipTaskId,
        )) {
          throw new StoreError(
            "stale_epoch",
            409,
            "lease.fencingEpoch must exceed every prior attempt generation for this task",
          );
        }

        const now = this.isoNow();
        const attempt: ExecutionAttempt = {
          attemptId: randomUUID(),
          projectId: request.projectId,
          paperclipTaskId: request.paperclipTaskId,
          paperclipRunId: request.paperclipRunId,
          workerKind: request.workerKind,
          fencingEpoch: request.lease.fencingEpoch,
          leaseToken: request.lease.leaseToken,
          state: "accepted",
          errorCode: null,
          createdAt: now,
          updatedAt: now,
        };
        this.attempts.set(attempt.attemptId, attempt);
        const taskKey = this.taskKey(request.projectId, request.paperclipTaskId);
        this.attemptsByTask.set(taskKey, [
          ...(this.attemptsByTask.get(taskKey) ?? []),
          attempt.attemptId,
        ]);
        this.dispatchRequests.set(idempotencyKey, {
          idempotencyKey,
          requestHash,
          attemptId: attempt.attemptId,
          createdAt: now,
        });
        this.enqueueOutbound(
          "attempt.accepted",
          { attemptId: attempt.attemptId, paperclipTaskId: attempt.paperclipTaskId },
          "paperclip-adapter",
        );

        let launched: DispatchResult;
        try {
          launched = await this.launcher({ ...attempt });
        } catch (error) {
          attempt.state = "failed";
          attempt.errorCode = "dispatch_failed";
          attempt.updatedAt = this.isoNow();
          this.enqueueOutbound(
            "attempt.failed",
            {
              attemptId: attempt.attemptId,
              errorCode: attempt.errorCode,
              reason: error instanceof Error ? error.message : String(error),
            },
            "paperclip-adapter",
          );
          return this.toReceipt(attempt, false);
        }
        attempt.orcaRunId = launched.orcaRunId;
        attempt.orcaTaskId = launched.orcaTaskId;
        attempt.orcaDispatchId = launched.orcaDispatchId;
        attempt.orcaSessionId = launched.orcaSessionId;
        attempt.worktreeId = launched.worktreeId;
        attempt.state = launched.state;
        attempt.updatedAt = this.isoNow();
        return this.toReceipt(attempt, false);
      },
    );
  }

  /** Read an attempt as an API receipt. */
  getAttempt(attemptId: string): AttemptReceipt {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) {
      throw new StoreError("unknown_attempt", 404, `unknown attempt ${attemptId}`);
    }
    return this.toReceipt(attempt, false);
  }

  /** True when no non-terminal attempt holds the task lease. */
  canDispatch(projectId: string, paperclipTaskId: string): boolean {
    return this.activeAttemptFor(projectId, paperclipTaskId) === null;
  }

  /**
   * Persist the runtime's accepted-launch reply. This is the write a crash
   * between dispatch and persistence would skip; reconciliation later
   * re-derives it from observed runtime inventory instead of relaunching.
   */
  recordExternalDispatch(
    attemptId: string,
    ids: ExternalDispatchIds,
  ): AttemptReceipt {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) {
      throw new StoreError("unknown_attempt", 404, `unknown attempt ${attemptId}`);
    }
    Object.assign(attempt, ids);
    if (attempt.state === "accepted" || attempt.state === "requested") {
      attempt.state = "dispatching";
    }
    attempt.updatedAt = this.isoNow();
    return this.toReceipt(attempt, false);
  }

  /**
   * Apply one runtime event transactionally: dedupe by
   * `(source, sourceEventId)`, enforce fencing, advance attempt state and
   * enqueue the normalized outbound event — all in one critical section so
   * a receipt is never acknowledged without its outbox write.
   */
  applyRuntimeEvent(input: {
    source: string;
    sourceEventId: string;
    payload: Record<string, unknown>;
    attemptId: string;
    eventType: string;
    fencingEpoch: number;
  }): { deduplicated: boolean; applied: boolean; reason: string } {
    const key = `${input.source}::${input.sourceEventId}`;
    const seen = this.receipts.get(key);
    const payloadSha = sha256Hex(stableStringify(input.payload));
    if (seen) {
      return { deduplicated: true, applied: false, reason: "duplicate receipt" };
    }
    const attempt = this.attempts.get(input.attemptId);
    if (!attempt) {
      throw new StoreError(
        "unknown_attempt",
        404,
        `unknown attempt ${input.attemptId}`,
      );
    }
    if (input.fencingEpoch < attempt.fencingEpoch) {
      this.receipts.set(key, { payloadSha256: payloadSha, receivedAt: this.isoNow() });
      return { deduplicated: false, applied: false, reason: "stale fencing epoch" };
    }
    const next = nextStateForEvent(attempt.state, input.eventType);
    this.receipts.set(key, { payloadSha256: payloadSha, receivedAt: this.isoNow() });
    if (next === null) {
      return { deduplicated: false, applied: false, reason: "no transition for event in current state" };
    }
    attempt.state = next;
    attempt.updatedAt = this.isoNow();
    this.enqueueOutbound(input.eventType, { ...input.payload }, "paperclip-adapter");
    return { deduplicated: false, applied: true, reason: "applied" };
  }

  /** Mark telemetry-loss: running/dispatching attempts become `unknown`. */
  markUnknown(attemptId: string): AttemptReceipt {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) {
      throw new StoreError("unknown_attempt", 404, `unknown attempt ${attemptId}`);
    }
    if (attempt.state === "dispatching" || attempt.state === "running") {
      attempt.state = "unknown";
      attempt.updatedAt = this.isoNow();
      this.enqueueOutbound(
        "attempt.unknown",
        { attemptId, fencingEpoch: attempt.fencingEpoch },
        "paperclip-adapter",
      );
    }
    return this.toReceipt(attempt, false);
  }

  /**
   * Record proof the original runtime process is definitively gone
   * (read-only discovery + external ID match per F05). Only after this
   * may a fenced replacement attempt be created — never on `unknown`
   * alone.
   */
  confirmTermination(
    attemptId: string,
    outcome: "failed" | "cancelled",
    evidence: string,
  ): AttemptReceipt {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) {
      throw new StoreError("unknown_attempt", 404, `unknown attempt ${attemptId}`);
    }
    if (!evidence) {
      throw new StoreError("validation", 422, "termination evidence is required");
    }
    if (!isActive(attempt.state)) {
      throw new StoreError(
        "validation",
        422,
        `attempt ${attemptId} is already terminal (${attempt.state})`,
      );
    }
    attempt.state = outcome;
    attempt.errorCode = "original_terminated";
    attempt.updatedAt = this.isoNow();
    this.enqueueOutbound(
      outcome === "failed" ? "attempt.failed" : "attempt.cancelled",
      { attemptId, evidence },
      "paperclip-adapter",
    );
    return this.toReceipt(attempt, false);
  }

  /**
   * Boot reconciliation: adopt every provable original dispatch, mark the
   * rest `unknown`, and never relaunch. Matches first on persisted
   * `orcaDispatchId`, then on `(paperclipTaskId, leaseToken)` for attempts
   * whose accepted-launch reply was never persisted (crash in the window).
   */
  reconcileAfterRestart(observed: ObservedDispatch[]): ReconcileReport {
    const report: ReconcileReport = {
      adopted: [],
      markedUnknown: [],
      alreadyTerminal: [],
    };
    const byExternal = new Map(
      observed.map((o) => [o.externalDispatchId, o]),
    );
    for (const attempt of this.attempts.values()) {
      if (!isActive(attempt.state)) {
        report.alreadyTerminal.push(attempt.attemptId);
        continue;
      }
      const direct =
        attempt.orcaDispatchId !== undefined
          ? byExternal.get(attempt.orcaDispatchId)
          : undefined;
      if (direct && direct.state === "running") {
        attempt.state = "running";
        attempt.updatedAt = this.isoNow();
        report.adopted.push(attempt.attemptId);
        continue;
      }
      if (!attempt.orcaDispatchId) {
        const inferred = observed.find(
          (o) =>
            o.state === "running" &&
            o.paperclipTaskId === attempt.paperclipTaskId &&
            o.leaseToken === attempt.leaseToken,
        );
        if (inferred) {
          attempt.orcaDispatchId = inferred.externalDispatchId;
          attempt.state = "running";
          attempt.updatedAt = this.isoNow();
          report.adopted.push(attempt.attemptId);
          continue;
        }
      }
      if (attempt.state !== "unknown") {
        attempt.state = "unknown";
        attempt.updatedAt = this.isoNow();
      }
      report.markedUnknown.push(attempt.attemptId);
    }
    return report;
  }

  /** Claim due, undelivered, non-dead-letter entries for one delivery pass. */
  claimDueOutbound(limit = 50): OutboxEntry[] {
    const now = this.clock();
    const due = [...this.outbox.values()]
      .filter(
        (e) =>
          !e.deadLettered &&
          e.deliveredAt === null &&
          Date.parse(e.nextAttemptAt) <= now,
      )
      .sort((a, b) => a.nextAttemptAt.localeCompare(b.nextAttemptAt))
      .slice(0, limit);
    return due.map((e) => ({ ...e, body: { ...e.body } }));
  }

  markDelivered(entryId: string): void {
    const entry = this.outbox.get(entryId);
    if (!entry || entry.deliveredAt !== null || entry.deadLettered) return;
    entry.deliveredAt = this.isoNow();
  }

  /**
   * Record a failed delivery attempt with exponential backoff; exhausting
   * `maxOutboxAttempts` dead-letters the entry with a human-visible reason.
   */
  markDeliveryFailed(entryId: string, error: string): void {
    const entry = this.outbox.get(entryId);
    if (!entry || entry.deliveredAt !== null || entry.deadLettered) return;
    entry.attempts += 1;
    entry.lastError = error;
    if (entry.attempts >= this.maxOutboxAttempts) {
      entry.deadLettered = true;
      entry.deadLetterReason =
        `gave up after ${entry.attempts} attempts: ${error}`;
      return;
    }
    const delay = Math.min(
      this.outboxBaseDelayMs * 2 ** (entry.attempts - 1),
      this.outboxMaxDelayMs,
    );
    entry.nextAttemptAt = new Date(this.clock() + delay).toISOString();
  }

  listDeadLetter(): OutboxEntry[] {
    return [...this.outbox.values()]
      .filter((e) => e.deadLettered)
      .map((e) => ({ ...e, body: { ...e.body } }));
  }

  /** Test/ops introspection: pending (undelivered, non-dead-letter) count. */
  pendingOutboundCount(): number {
    let count = 0;
    for (const e of this.outbox.values()) {
      if (e.deliveredAt === null && !e.deadLettered) count += 1;
    }
    return count;
  }
}

function nextStateForEvent(
  current: AttemptState,
  eventType: string,
): AttemptState | null {
  switch (eventType) {
    case "attempt.heartbeat":
      return current === "dispatching" || current === "running" ? current : null;
    case "attempt.started":
      return current === "accepted" || current === "dispatching" ||
          current === "unknown"
        ? "running"
        : null;
    case "attempt.question":
      return current === "running" ? current : null;
    case "attempt.finished":
      return isActive(current) ? "finished" : null;
    case "attempt.failed":
      return isActive(current) ? "failed" : null;
    case "attempt.cancelled":
      return isActive(current) ? "cancelled" : null;
    case "attempt.unknown":
      return current === "dispatching" || current === "running"
        ? "unknown"
        : null;
    default:
      return null;
  }
}
