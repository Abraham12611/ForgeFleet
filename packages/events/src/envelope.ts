/**
 * E06 — Normalized ForgeFleet event envelope (FF-006).
 *
 * Implements the `docs/05-contracts/events.md` v0.1 envelope with validation
 * pinned to the frozen contract v0.1.0 (`packages/bridge-contracts`,
 * `schemas/bridge-events.schema.json`, PR #46): required fields, closed
 * `EventType` enum, `additionalProperties: false`, and optional-field
 * shapes. `CONTRACT_VERSION` names the contract this validator enforces;
 * any breaking field change must bump the contract and this module together.
 *
 * Also provides `(source, eventId)` dedupe keys, fencing-epoch staleness
 * and secret redaction for logs.
 */

import type { EventType } from "../../bridge-contracts/generated/bridge.types.ts";

export const EVENT_SCHEMA_VERSION = "0.1";

/** Frozen contract version this validator enforces. */
export const CONTRACT_VERSION = "0.1.0";

/**
 * Closed event-type enum mirroring the normative
 * `bridge-events.schema.json` `EventType` (contract v0.1.0). Unknown types
 * fail validation: producers must not send undeclared types under v0.1,
 * and adding one requires a contract version bump.
 */
export const EVENT_TYPES: readonly EventType[] = [
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
];

/** Required envelope fields per the normative schema. */
const REQUIRED_FIELDS = [
  "eventId",
  "schemaVersion",
  "eventType",
  "occurredAt",
  "source",
  "projectId",
] as const;

/** All allowed top-level fields (`additionalProperties: false`). */
const ALLOWED_FIELDS = [
  ...REQUIRED_FIELDS,
  "receivedAt",
  "taskId",
  "attemptId",
  "correlationId",
  "fencingEpoch",
  "actor",
  "data",
] as const;

export interface EventActor {
  type: "service" | "human" | "agent";
  id: string;
}

/** Producer-side complete envelope (defaults filled by `buildEnvelope`). */
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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoDateTime(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  return Number.isFinite(Date.parse(value));
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
 * Build a complete v0.1 envelope, filling `eventId`, `receivedAt`,
 * `correlationId` and `fencingEpoch` defaults. Throws on missing/invalid
 * required fields.
 */
export function buildEnvelope(
  input: BuildEnvelopeInput,
  now: () => string = () => new Date().toISOString(),
): ForgeFleetEvent {
  const errors: string[] = [];
  const eventId = input.eventId ?? generateId();
  if (!input.eventType) errors.push("eventType is required");
  else if (!(EVENT_TYPES as readonly string[]).includes(input.eventType)) {
    errors.push(`eventType ${input.eventType} is not in contract v0.1.0`);
  }
  if (!isIsoDateTime(input.occurredAt)) {
    errors.push("occurredAt must be an ISO-8601 date-time");
  }
  if (!input.source) errors.push("source is required");
  if (!input.projectId) errors.push("projectId is required");
  if (!isRecord(input.actor) || !input.actor["type"] || !input.actor["id"]) {
    errors.push("actor.type and actor.id are required");
  } else if (!["service", "human", "agent"].includes(input.actor["type"] as string)) {
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
    eventId,
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
    actor: { type: input.actor["type"] as EventActor["type"], id: input.actor["id"] as string },
    data: input.data ?? {},
  };
}

export interface InvalidEnvelope {
  errors: string[];
}

/**
 * Validate an unknown value against the frozen v0.1 envelope schema:
 * required fields present, closed event-type enum, no unknown top-level
 * fields, and optional-field shapes (`attemptId` UUID, `fencingEpoch`
 * integer >= 1, `actor` type/id, `data` object).
 */
export function validateEnvelope(
  value: unknown,
): { event: Record<string, unknown> } | InvalidEnvelope {
  if (!isRecord(value)) return { errors: ["envelope must be an object"] };
  const errors: string[] = [];
  for (const key of Object.keys(value)) {
    if (!(ALLOWED_FIELDS as readonly string[]).includes(key)) {
      errors.push(`unknown field rejected by contract v0.1.0: ${key}`);
    }
  }
  for (const field of REQUIRED_FIELDS) {
    if (value[field] === undefined || value[field] === null || value[field] === "") {
      errors.push(`${field} is required`);
    }
  }
  if (
    value["schemaVersion"] !== undefined &&
    value["schemaVersion"] !== EVENT_SCHEMA_VERSION
  ) {
    errors.push(
      `schemaVersion must be ${EVENT_SCHEMA_VERSION} (breaking changes require migration)`,
    );
  }
  if (
    value["eventType"] !== undefined &&
    !(EVENT_TYPES as readonly string[]).includes(value["eventType"] as string)
  ) {
    errors.push(
      `eventType ${String(value["eventType"])} is not in contract v0.1.0`,
    );
  }
  for (const field of ["occurredAt", "receivedAt"] as const) {
    if (value[field] !== undefined && !isIsoDateTime(value[field])) {
      errors.push(`${field} must be an ISO-8601 date-time`);
    }
  }
  for (const field of ["taskId", "correlationId"] as const) {
    const v = value[field];
    if (v !== undefined && v !== null && (typeof v !== "string" || !v)) {
      errors.push(`${field} must be a non-empty string`);
    }
  }
  const attemptId = value["attemptId"];
  if (
    attemptId !== undefined &&
    attemptId !== null &&
    (typeof attemptId !== "string" || !UUID_RE.test(attemptId))
  ) {
    errors.push("attemptId must be a UUID");
  }
  if (
    value["fencingEpoch"] !== undefined &&
    (!Number.isInteger(value["fencingEpoch"]) ||
      (value["fencingEpoch"] as number) < 1)
  ) {
    errors.push("fencingEpoch must be an integer >= 1");
  }
  const actor = value["actor"];
  if (actor !== undefined) {
    if (
      !isRecord(actor) ||
      !["service", "human", "agent"].includes(actor["type"] as string) ||
      typeof actor["id"] !== "string" ||
      !actor["id"]
    ) {
      errors.push("actor must have a valid type and id");
    }
  }
  if (value["data"] !== undefined && !isRecord(value["data"])) {
    errors.push("data must be an object");
  }
  if (errors.length > 0) return { errors };
  return { event: value };
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
