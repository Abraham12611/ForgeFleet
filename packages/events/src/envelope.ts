/**
 * E06 — Normalized ForgeFleet event envelope (FF-006).
 *
 * Implements the `docs/05-contracts/events.md` v0.1 envelope: shape
 * validation, `(source, eventId)` dedupe keys, fencing-epoch staleness and
 * secret redaction. Dependency-free; shared by the bridge persistence layer
 * (`services/orca-bridge/src/persistence/`) and future consumers.
 *
 * Compatibility rule honored here: unknown `eventType` values validate
 * successfully with `known: false` so older clients safely ignore event
 * types added by newer producers.
 */

export const EVENT_SCHEMA_VERSION = "0.1";

/** Event families from `docs/05-contracts/events.md`. */
export const KNOWN_EVENT_TYPES = [
  "project.created",
  "project.paused",
  "project.resumed",
  "task.ready",
  "task.claimed",
  "task.blocked",
  "task.unblocked",
  "task.submitted",
  "task.verified",
  "task.failed",
  "attempt.accepted",
  "attempt.started",
  "attempt.heartbeat",
  "attempt.question",
  "attempt.finished",
  "attempt.failed",
  "attempt.unknown",
  "attempt.cancelled",
  "message.posted",
  "message.delivered",
  "message.acknowledged",
  "message.failed",
  "decision.requested",
  "decision.answered",
  "decision.expired",
  "decision.withdrawn",
  "github.pr.opened",
  "github.checks.updated",
  "github.review.submitted",
  "github.merged",
  "github.closed",
  "runtime.connected",
  "runtime.disconnected",
  "runtime.capacity.changed",
  "budget.threshold",
  "budget.exhausted",
] as const;

export type KnownEventType = (typeof KNOWN_EVENT_TYPES)[number];

export interface EventActor {
  type: "service" | "human" | "agent";
  id: string;
}

export interface ForgeFleetEvent {
  eventId: string;
  schemaVersion: string;
  eventType: string;
  occurredAt: string;
  receivedAt: string;
  source: string;
  projectId: string;
  taskId: string | null;
  attemptId: string | null;
  correlationId: string;
  fencingEpoch: number;
  actor: EventActor;
  data: Record<string, unknown>;
}

export interface BuildEnvelopeInput {
  eventId?: string;
  eventType: string;
  occurredAt: string;
  receivedAt?: string;
  source: string;
  projectId: string;
  taskId?: string | null;
  attemptId?: string | null;
  correlationId?: string;
  fencingEpoch?: number;
  actor: EventActor;
  data?: Record<string, unknown>;
}

export interface ValidEnvelope {
  event: ForgeFleetEvent;
  /** False for event types newer than this module; consume-or-ignore, never reject. */
  known: boolean;
}

export interface InvalidEnvelope {
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoDateTime(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  const t = Date.parse(value);
  return Number.isFinite(t);
}

function generateId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `evt-${Date.now().toString(36)}-${Math.floor(Math.random() * 2 ** 32).toString(36)}`;
}

/**
 * Build a v0.1 envelope, filling `eventId`, `receivedAt`, `correlationId`
 * and `fencingEpoch` defaults. Throws on missing/invalid required fields.
 */
export function buildEnvelope(
  input: BuildEnvelopeInput,
  now: () => string = () => new Date().toISOString(),
): ForgeFleetEvent {
  const errors: string[] = [];
  if (!input.eventType) errors.push("eventType is required");
  if (!isIsoDateTime(input.occurredAt)) {
    errors.push("occurredAt must be an ISO-8601 date-time");
  }
  if (!input.source) errors.push("source is required");
  if (!input.projectId) errors.push("projectId is required");
  if (!isRecord(input.actor) || !input.actor.type || !input.actor.id) {
    errors.push("actor.type and actor.id are required");
  } else if (!["service", "human", "agent"].includes(input.actor.type)) {
    errors.push("actor.type must be service, human or agent");
  }
  if (
    input.fencingEpoch !== undefined &&
    (!Number.isInteger(input.fencingEpoch) || input.fencingEpoch < 1)
  ) {
    errors.push("fencingEpoch must be an integer >= 1");
  }
  if (errors.length > 0) throw new Error(errors.join("; "));
  return {
    eventId: input.eventId ?? generateId(),
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventType: input.eventType,
    occurredAt: input.occurredAt,
    receivedAt: input.receivedAt ?? now(),
    source: input.source,
    projectId: input.projectId,
    taskId: input.taskId ?? null,
    attemptId: input.attemptId ?? null,
    correlationId: input.correlationId ?? generateId(),
    fencingEpoch: input.fencingEpoch ?? 1,
    actor: { type: input.actor.type, id: input.actor.id },
    data: input.data ?? {},
  };
}

/**
 * Validate an unknown value against the v0.1 envelope. Returns
 * `{ event, known }` on success; unknown event types succeed with
 * `known: false` per the forward-compatibility rule. Breaking field
 * changes (wrong `schemaVersion`) fail.
 */
export function validateEnvelope(
  value: unknown,
): ValidEnvelope | InvalidEnvelope {
  if (!isRecord(value)) return { errors: ["envelope must be an object"] };
  const errors: string[] = [];
  if (typeof value["eventId"] !== "string" || !value["eventId"]) {
    errors.push("eventId must be a non-empty string");
  }
  if (value["schemaVersion"] !== EVENT_SCHEMA_VERSION) {
    errors.push(
      `schemaVersion must be ${EVENT_SCHEMA_VERSION} (breaking changes require migration)`,
    );
  }
  if (typeof value["eventType"] !== "string" || !value["eventType"]) {
    errors.push("eventType must be a non-empty string");
  }
  if (!isIsoDateTime(value["occurredAt"])) {
    errors.push("occurredAt must be an ISO-8601 date-time");
  }
  if (!isIsoDateTime(value["receivedAt"])) {
    errors.push("receivedAt must be an ISO-8601 date-time");
  }
  if (typeof value["source"] !== "string" || !value["source"]) {
    errors.push("source must be a non-empty string");
  }
  if (typeof value["projectId"] !== "string" || !value["projectId"]) {
    errors.push("projectId must be a non-empty string");
  }
  for (const field of ["taskId", "attemptId", "correlationId"] as const) {
    const v = value[field];
    if (field === "correlationId") {
      if (typeof v !== "string" || !v) errors.push(`${field} is required`);
    } else if (v !== null && (typeof v !== "string" || !v)) {
      errors.push(`${field} must be a string or null`);
    }
  }
  if (
    !Number.isInteger(value["fencingEpoch"]) ||
    (value["fencingEpoch"] as number) < 1
  ) {
    errors.push("fencingEpoch must be an integer >= 1");
  }
  const actor = value["actor"];
  if (
    !isRecord(actor) ||
    !["service", "human", "agent"].includes(
      actor["type"] as string,
    ) ||
    typeof actor["id"] !== "string" ||
    !actor["id"]
  ) {
    errors.push("actor must have a valid type and id");
  }
  if (!isRecord(value["data"])) errors.push("data must be an object");
  if (errors.length > 0) return { errors };
  const event = value as unknown as ForgeFleetEvent;
  return {
    event,
    known: (KNOWN_EVENT_TYPES as readonly string[]).includes(event.eventType),
  };
}

/**
 * Canonical `(source, eventId)` dedupe key. Handlers must treat a repeated
 * key as already-received regardless of arrival order.
 */
export function dedupeKey(source: string, eventId: string): string {
  return `${source}::${eventId}`;
}

/** Progress-type events that are safe to drop once the attempt moved on. */
const STALEABLE_PROGRESS_TYPES: readonly string[] = ["attempt.heartbeat"];

/** Terminal attempt states: the runtime will never produce more progress. */
const TERMINAL_ATTEMPT_STATES: readonly string[] = [
  "finished",
  "failed",
  "cancelled",
];

export interface AttemptPosition {
  fencingEpoch: number;
  state: string;
}

/**
 * True when `event` must be ignored for the attempt's current position:
 * an older fencing epoch always loses, and progress heartbeats for a
 * terminal attempt are late duplicates. Terminal lifecycle events
 * (`finished`/`failed`/`cancelled`) are never stale — recording them is
 * what closes the attempt.
 */
export function isStaleProgress(
  event: Pick<ForgeFleetEvent, "eventType" | "fencingEpoch">,
  current: AttemptPosition,
): boolean {
  if (event.fencingEpoch < current.fencingEpoch) return true;
  if (
    TERMINAL_ATTEMPT_STATES.includes(current.state) &&
    STALEABLE_PROGRESS_TYPES.includes(event.eventType)
  ) {
    return true;
  }
  return false;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SECRET_VALUE_RE =
  /\b(bearer\s+[A-Za-z0-9._~+/-]+=*|sk-[A-Za-z0-9_-]+|ghp_[A-Za-z0-9_]+|xox[bap]-[A-Za-z0-9-]+)\b/gi;
const SECRET_KEY_RE =
  /(token|secret|password|passwd|api[-_]?key|authorization|auth[-_]?token|hmac|signature|private[-_]?key|webhook[-_]?secret|client[-_]?secret)/i;

/**
 * Deep-clone `value` with secrets scrubbed for logs/audit/UI: secret-valued
 * keys become `<redacted-secret>`, emails become `<redacted-email>`. The
 * input is never mutated.
 */
export function redactForLog<T>(value: T): T {
  if (typeof value === "string") {
    return value
      .replace(SECRET_VALUE_RE, "<redacted-secret>")
      .replace(EMAIL_RE, "<redacted-email>") as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactForLog(item)) as unknown as T;
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_RE.test(k) ? "<redacted-secret>" : redactForLog(v);
    }
    return out as unknown as T;
  }
  return value;
}
