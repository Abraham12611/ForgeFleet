/**
 * E10 / FF-014 — Message thread and escalation routing: shared types.
 *
 * Reconciled with the frozen v0.1 bridge contract
 * (`packages/bridge-contracts`, CONTRACT-VERSION 0.1.0, PR #46):
 * - `MessageKind` is the frozen contract enum
 *   (`question|answer|update|unblock|instruction`). Doc-level notions from
 *   `docs/03-architecture/communications.md` map onto it via `labels`
 *   (see `LABEL_FOR_DOC_KIND`); the frozen enum is never extended here.
 * - Wire actors are contract `{type, id}` (`toContractActor`). Roles and
 *   project scope live in the service-side session resolved from the
 *   trusted transport — never in message payload.
 *
 * Depends on (open at time of writing, see PR body):
 * - E06 `packages/events` / FF-006 (#37): event names reused; persistence
 *   here is messaging-owned (`packages/messaging/**`) and does not fork
 *   the attempt store.
 * - E07 policy FF-004 (#33) / audit FF-023 (#53): authorization is an
 *   injected `PolicyPort` keyed on the authenticated caller; converge on
 *   E07 `authorize()` before v1.0.
 */

import type {
  Actor as ContractActor,
  BridgeEvent,
  EventType,
  MessageKind as ContractMessageKind,
} from "../../bridge-contracts/generated/bridge.types.ts";

export const CONTRACT_VERSION = "0.1.0";
export const EVENT_SCHEMA_VERSION = "0.1";
export const OUTBOX_SOURCE = "forgefleet-messaging";

/** Frozen contract enum (do not extend without a contract version bump). */
export const MESSAGE_KINDS: readonly ContractMessageKind[] = [
  "question",
  "answer",
  "update",
  "unblock",
  "instruction",
];

export type MessageKind = ContractMessageKind;
export type { BridgeEvent, ContractActor, EventType };

/**
 * Storage-side labels preserving communications.md notions on top of the
 * frozen kind enum. Labels never travel on the bridge wire as kinds.
 */
export const MESSAGE_LABELS = [
  "blocker",
  "artifact",
  "readiness",
  "system-notice",
] as const;

export type MessageLabel = (typeof MESSAGE_LABELS)[number];

/** How a communications.md `type` maps onto (kind, labels). */
export const LABEL_FOR_DOC_KIND: Record<string, { kind: MessageKind; labels: MessageLabel[] }> = {
  text: { kind: "update", labels: [] },
  question: { kind: "question", labels: [] },
  answer: { kind: "answer", labels: [] },
  blocker: { kind: "question", labels: ["blocker"] },
  status: { kind: "update", labels: [] },
  artifact: { kind: "update", labels: ["artifact"] },
  system: { kind: "update", labels: ["system-notice"] },
  unblock: { kind: "unblock", labels: [] },
  instruction: { kind: "instruction", labels: [] },
};

/**
 * Service-side actor identity, resolved from the trusted transport
 * (bridge service token / owner session) — never from message payload.
 * `role`, `projects` and `sessionProjectId` are session data keyed by
 * `id`; the wire carries only `{type, id}`.
 */
export interface Actor {
  type: "human" | "agent" | "service";
  id: string;
  role: "owner" | "coordinator" | "lead" | "worker" | "reviewer" | "service";
  /** Project ids the actor is scoped to. Owner may span projects. */
  projects?: string[];
  /** Project the current session was issued for (stolen-scope detection). */
  sessionProjectId?: string;
}

/** Wire form of an actor for BridgeEvent payloads (frozen contract). */
export function toContractActor(actor: Actor): ContractActor {
  return { type: actor.type, id: actor.id };
}

/**
 * Authenticated caller: identity PLUS the transport it arrived on.
 * Message content is never a transport: there is no `via: "message"`,
 * and any such claim is rejected at the facade boundary.
 */
export type CallerTransport = "service-token" | "owner-session" | "test-harness";

export interface AuthenticatedCaller {
  identity: Actor;
  via: CallerTransport;
}

/** Channel naming from communications.md. */
export type Channel =
  | `project/general`
  | `team/${string}`
  | `task/${string}`
  | `reviews`
  | `decisions`;

/** Durable message envelope (stored; receipt acked only after commit). */
export interface Message {
  messageId: string;
  threadId: string;
  channel: Channel;
  projectId: string;
  taskId: string | null;
  attemptId: string | null;
  sender: Actor;
  /** Explicit recipients; empty means thread subscribers. */
  recipientIds: string[];
  kind: MessageKind;
  /** Storage-side labels (blocker/artifact/readiness/system-notice). */
  labels: MessageLabel[];
  /** Redacted body as stored. */
  body: string;
  attachments?: AttachmentRef[];
  /** Severity/deadline required for questions (blockers included). */
  severity?: "low" | "normal" | "high" | "urgent";
  deadlineAt?: string | null;
  createdAt: string;
  traceId: string;
  idempotencyKey: string;
  /** Visibility: who may read (thread ACL snapshot). */
  visibility: string[];
}

export interface AttachmentRef {
  name: string;
  mime: string;
  bytes: number;
}

/** A thread is a view/filter over the persisted transport (never a scheduler). */
export interface Thread {
  threadId: string;
  channel: Channel;
  projectId: string;
  taskId: string | null;
  createdAt: string;
  /** Actor ids allowed to read/post. */
  acl: string[];
  closed: boolean;
}

/** Per-recipient delivery state. Committed before any ack is emitted. */
export type DeliveryState = "queued" | "delivered" | "acknowledged" | "failed";

export interface DeliveryReceipt {
  messageId: string;
  recipientId: string;
  state: DeliveryState;
  updatedAt: string;
  /** Why delivery failed or was rerouted (e.g. peer unavailable). */
  reason?: string;
}

/** Escalation raised when a peer exchange cannot resolve an issue. */
export interface Escalation {
  escalationId: string;
  threadId: string;
  projectId: string;
  taskId: string | null;
  raisedBy: Actor;
  /** Options presented to the resolver, with evidence pointers. */
  options: string[];
  evidence: string[];
  severity: "low" | "normal" | "high" | "urgent";
  deadlineAt: string | null;
  createdAt: string;
  /** Resolved by coordinator decision or owner decision item. */
  status: "open" | "coordinator_resolved" | "owner_decision" | "expired";
  resolution?: string;
  /** Durable owner decision id when routed to the human. */
  decisionId?: string;
}

/**
 * Durable human decision item (decisions channel). An expired
 * OWNER_REQUIRED decision never grants authority; an answer against a
 * changed target SHA reopens the decision.
 */
export interface DecisionItem {
  decisionId: string;
  projectId: string;
  taskId: string | null;
  escalationId: string | null;
  question: string;
  options: string[];
  risk: string;
  requestedBy: string;
  createdAt: string;
  expiresAt: string;
  status: "proposed" | "pending" | "answered" | "withdrawn" | "expired";
  answer?: string;
  answeredBy?: string;
  answeredAt?: string;
  /** Exact target state hash the answer was given against. */
  targetSha?: string;
}

/** Outcome codes for posting / routing (HTTP-mappable). */
export const OUTCOMES = [
  "stored",
  "duplicate_replay",
  "queued_while_sleeping",
  "rerouted_to_lead",
  "rerouted_to_coordinator",
  "escalated_to_owner",
] as const;

export type Outcome = (typeof OUTCOMES)[number];

/** Result of a validated post: what was stored and where it goes next. */
export interface PostResult {
  outcome: Outcome;
  message: Message;
  receipts: DeliveryReceipt[];
  escalation?: Escalation;
  decision?: DecisionItem;
}

/** Structured errors; `code` maps to HTTP status in the bridge adapter. */
export class MessageError extends Error {
  code:
    | "VALIDATION"
    | "FORBIDDEN"
    | "CONFLICT"
    | "UNKNOWN_THREAD"
    | "CLOSED_THREAD";
  httpStatus: 400 | 403 | 404 | 409 | 410;
  constructor(
    code: MessageError["code"],
    httpStatus: MessageError["httpStatus"],
    message: string,
  ) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}
