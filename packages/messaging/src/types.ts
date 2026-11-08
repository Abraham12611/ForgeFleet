/**
 * E10 / FF-014 — Message thread and escalation routing: shared types.
 *
 * Source of truth for shapes: `docs/03-architecture/communications.md`
 * (envelope fields, channels) and `docs/04-flows/agent-messaging.md`
 * (contract: unique ID, task/thread correlation, receipt acked after
 * persistence, typed follow-up actions).
 *
 * Depends on (unmerged at time of writing, see PR body):
 * - E05 `packages/bridge-contracts`: field names defined locally here and
 *   must be reconciled with the contract custodian before v0.1 integration.
 * - E06 `packages/events`: message.* event types reused by name only; this
 *   package does not import the sibling tree.
 * - E07 `packages/policy`: authorization is an injected `PolicyPort`, with a
 *   default deny-closed implementation mirroring
 *   `docs/05-contracts/policy-matrix.md`. Reconcile with E07 `authorize()`.
 */

/** Actor identity. Only this authenticated object counts as authority. */
export interface Actor {
  type: "human" | "agent" | "service";
  id: string;
  role: "owner" | "coordinator" | "lead" | "worker" | "reviewer" | "service";
  /** Project ids the actor is scoped to. Owner may span projects. */
  projects?: string[];
  /** Project the current session was issued for (stolen-scope detection). */
  sessionProjectId?: string;
}

/** Message kinds from communications.md. */
export const MESSAGE_KINDS = [
  "text",
  "question",
  "answer",
  "blocker",
  "status",
  "artifact",
  "system",
] as const;

export type MessageKind = (typeof MESSAGE_KINDS)[number];

/** Channel naming from communications.md. */
export type Channel =
  | `project/general`
  | `team/${string}`
  | `task/${string}`
  | `reviews`
  | `decisions`;

/** Durable message envelope (stored; receipt acked only after persist). */
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
  /** Redacted body as stored. */
  body: string;
  attachments?: AttachmentRef[];
  /** Severity/deadline required for questions and blockers. */
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

/** Per-recipient delivery state. Persisted before any ack is emitted. */
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
