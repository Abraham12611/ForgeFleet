/**
 * E10 / FF-014 — MCP facade: the agent-facing tool surface.
 *
 * Tools from `docs/03-architecture/communications.md`:
 * `send_message`, `read_thread`, `ask_coordinator`, `create_blocker`,
 * `request_decision`, `post_artifact`, `mark_task_ready_for_review`,
 * `file_runtime_message`, plus escalation/decision transitions
 * (`raise_escalation`, `answer_decision`, `withdraw_decision`,
 * `resolve_escalation`).
 *
 * Authentication boundary: the facade obtains caller identity ONLY from
 * a trusted backend-authenticated context. Every method takes a
 * `BackendCredential` (service token or owner session) which is verified
 * through the injected `BackendAuthPort`; the port mints the identity
 * (and any worker binding). There is no `via` string, no `sender` field,
 * and no `actorId` accepted from the caller — message content and request
 * bodies can never become authority. Unknown/forged credentials are 403;
 * malformed ones are 400. The default port denies everything.
 *
 * Agent-to-agent messages never modify tasks or grant authority;
 * follow-up actions stay typed and explicit.
 */

import { EscalationStore } from "./escalation.ts";
import { isValidKind, validateLabels } from "./moderation.ts";
import { planDelivery, type PresencePort } from "./router.ts";
import { ThreadStore } from "./thread-store.ts";
import { MessagingDb } from "./sqlite.ts";
import {
  MessageError,
  toContractActor,
  type Actor,
  type AttachmentRef,
  type DecisionItem,
  type Escalation,
  type Message,
  type MessageKind,
  type MessageLabel,
  type Outcome,
  type PostResult,
} from "./types.ts";

/** Everyone reachable: used when no runtime presence adapter is wired. */
export function openPresence(): PresencePort {
  return {
    isAvailable: () => true,
    leadFor: () => null,
    coordinatorId: () => null,
    ownerId: () => "owner",
    isOwnerSleeping: () => false,
  };
}

/**
 * Credential presented at the public boundary. Verified by the backend
 * auth port — never trusted raw. `workerId` on a service token names the
 * runtime worker the bridge is filing for; the port checks it against
 * the bridge's own session table and attests the binding.
 */
export type ServiceTokenCredential = {
  transport: "service-token";
  token: string;
  workerId?: string;
};
export type OwnerSessionCredential = { transport: "owner-session"; sessionId: string };
export type BackendCredential = ServiceTokenCredential | OwnerSessionCredential;

/**
 * Identity minted by backend verification (facade-internal; never
 * accepted from the wire). `via` records which credential type the
 * backend verified — it is assigned here, not asserted by the caller.
 */
export interface VerifiedCaller {
  actor: Actor;
  via: "service-token" | "owner-session";
  /** Worker binding attested by the backend (bridge session table). */
  onBehalfOf?: { workerId: string; projectId: string };
}

/** Backend-owned credential verification (E07 to own the real one). */
export interface BackendAuthPort {
  verify(credential: BackendCredential): VerifiedCaller;
}

/** Fail-closed default: no credential verifies until a backend wires one. */
export function denyAllAuth(): BackendAuthPort {
  const deny = (): never => {
    throw new MessageError("FORBIDDEN", 403, "no backend auth configured; credential rejected");
  };
  return { verify: deny };
}

function requireKind(kind: unknown): MessageKind {
  if (!isValidKind(kind as string)) {
    throw new MessageError("VALIDATION", 400, `kind must be one of question|answer|update|unblock|instruction (frozen contract v0.1)`);
  }
  return kind as MessageKind;
}

export interface ServiceOptions {
  presence?: PresencePort;
  generateId?: () => string;
  now?: () => string;
}

export class MessagingService {
  private db: MessagingDb;
  private auth: BackendAuthPort;
  private threads: ThreadStore;
  private escalations: EscalationStore;
  private presence: PresencePort;
  private generateId: () => string;
  private now: () => string;

  constructor(db: MessagingDb, auth: BackendAuthPort = denyAllAuth(), opts: ServiceOptions = {}) {
    this.db = db;
    this.auth = auth;
    this.presence = opts.presence ?? openPresence();
    this.generateId = opts.generateId ?? (() => crypto.randomUUID());
    this.now = opts.now ?? (() => new Date().toISOString());
    this.threads = new ThreadStore({ db, generateId: this.generateId, now: this.now });
    this.escalations = new EscalationStore({ db, generateId: this.generateId, now: this.now });
  }

  get store(): ThreadStore {
    return this.threads;
  }

  get escalationStore(): EscalationStore {
    return this.escalations;
  }

  get database(): MessagingDb {
    return this.db;
  }

  /** Verify the credential through the backend port (throws 400/403). */
  private resolve(credential: unknown): VerifiedCaller {
    if (typeof credential !== "object" || credential === null) {
      throw new MessageError("VALIDATION", 400, "backend credential required");
    }
    const c = credential as Record<string, unknown>;
    if (c.transport !== "service-token" && c.transport !== "owner-session") {
      throw new MessageError("FORBIDDEN", 403, "unknown credential transport; authority requires a backend-verified credential");
    }
    if (c.transport === "service-token" && (typeof c.token !== "string" || !c.token)) {
      throw new MessageError("VALIDATION", 400, "service-token credential requires a token");
    }
    if (c.transport === "owner-session" && (typeof c.sessionId !== "string" || !c.sessionId)) {
      throw new MessageError("VALIDATION", 400, "owner-session credential requires a sessionId");
    }
    const verified = this.auth.verify(credential as BackendCredential);
    if (!verified || typeof verified.actor !== "object" || !verified.actor.id) {
      throw new MessageError("FORBIDDEN", 403, "backend could not verify credential");
    }
    return verified;
  }

  /** Owner answers require a verified owner session (service tokens refused). */
  private requireOwnerSession(caller: VerifiedCaller): Actor {
    if (caller.via !== "owner-session") {
      throw new MessageError("FORBIDDEN", 403, "owner answers require a verified owner session; service tokens are never authority");
    }
    if (caller.actor.role !== "owner" || caller.actor.type !== "human") {
      throw new MessageError("FORBIDDEN", 403, "only the authenticated owner answers a decision");
    }
    return caller.actor;
  }

  /** Coordinator transitions: coordinator via bridge, or owner either way. */
  private requireCoordinatorOrOwner(caller: VerifiedCaller): Actor {
    const { actor, via } = caller;
    if (actor.role === "owner") return actor;
    if (actor.role === "coordinator" && via === "service-token") return actor;
    throw new MessageError("FORBIDDEN", 403, "coordinator transitions require the bridge service identity or the owner");
  }

  /** Task ownership: posts to a task thread must carry the thread's task. */
  private checkTaskOwnership(threadId: string, actor: Actor, taskId: string | null | undefined): void {
    const thread = this.threads.getThread(threadId);
    if (thread.taskId !== null && taskId !== undefined && taskId !== null && taskId !== thread.taskId) {
      throw new MessageError(
        "FORBIDDEN",
        403,
        `actor ${actor.id} may not file task ${taskId} work into thread of task ${thread.taskId}`,
      );
    }
  }

  private post(
    actor: Actor,
    input: {
      threadId: string;
      kind: MessageKind;
      labels?: MessageLabel[];
      body: string;
      recipientIds?: string[];
      attachments?: AttachmentRef[];
      severity?: string;
      deadlineAt?: string | null;
      taskId?: string | null;
      idempotencyKey: string;
      externalId?: string;
    },
  ): PostResult {
    this.checkTaskOwnership(input.threadId, actor, input.taskId);
    const { message, replayed } = this.threads.postMessage({ ...input, sender: actor });
    if (replayed) {
      return { outcome: "duplicate_replay", message, receipts: this.threads.receiptsFor(message.messageId) };
    }
    const thread = this.threads.getThread(message.threadId);
    const plan = planDelivery(message, thread, this.presence, false);
    const deliveredEvent = this.db.buildEvent({
      eventId: this.generateId(),
      eventType: "message.delivered",
      occurredAt: this.now(),
      projectId: message.projectId,
      taskId: message.taskId,
      actor: toContractActor(actor),
      data: {
        messageId: message.messageId,
        threadId: message.threadId,
        deliveredTo: plan.wake,
        reroutedTo: plan.reroutedTo,
        outcome: plan.outcome,
      },
      correlationId: message.traceId,
    });
    const receipts = this.threads.updateReceipts(
      message,
      plan.wake.map((recipientId) => ({
        recipientId,
        state: "delivered" as const,
        reason: plan.reroutedTo.includes(recipientId) ? `rerouted: ${plan.outcome}` : undefined,
      })),
      plan.wake.length > 0 ? deliveredEvent : undefined,
    );
    const outcome: Outcome = plan.outcome;
    return { outcome, message, receipts };
  }

  /**
   * Post as the verified identity; sender is always the backend-resolved
   * actor. Any `sender`/`via`/`actorId` keys smuggled in the input object
   * are ignored (the input type has no such fields; the sender is set
   * here, after the spread).
   */
  send_message(
    credential: unknown,
    input: {
      threadId: string;
      kind: MessageKind;
      labels?: MessageLabel[];
      body: string;
      recipientIds?: string[];
      attachments?: AttachmentRef[];
      severity?: string;
      deadlineAt?: string | null;
      taskId?: string | null;
      idempotencyKey: string;
    },
  ): PostResult {
    const actor = this.resolve(credential).actor;
    return this.post(actor, {
      ...input,
      kind: requireKind(input.kind),
      labels: validateLabels(input.labels),
    });
  }

  /**
   * File a normalized Orca runtime message. Only the bridge service
   * identity may call this, and only for a worker binding the backend
   * attests; the sender role is forced to `worker` regardless of what
   * the runtime text claims.
   */
  file_runtime_message(
    credential: unknown,
    input: {
      projectId: string;
      taskId: string;
      workerId: string;
      kind: "question" | "answer" | "update";
      body: string;
      threadId?: string;
      idempotencyKey: string;
      externalId: string;
      severity?: string;
      deadlineAt?: string | null;
      labels?: MessageLabel[];
      recipientIds?: string[];
    },
  ): PostResult {
    const caller = this.resolve(credential);
    if (caller.via !== "service-token") {
      throw new MessageError("FORBIDDEN", 403, "runtime messages are filed by the bridge service identity only");
    }
    const binding = caller.onBehalfOf;
    if (!binding || binding.workerId !== input.workerId || binding.projectId !== input.projectId) {
      throw new MessageError("FORBIDDEN", 403, "no backend-attested worker binding for this filing");
    }
    const sender: Actor = {
      type: "agent",
      id: input.workerId,
      role: "worker",
      projects: [input.projectId],
    };
    return this.post(sender, {
      threadId: input.threadId ?? `task/${input.taskId}`,
      kind: requireKind(input.kind),
      labels: validateLabels(input.labels),
      body: input.body,
      recipientIds: input.recipientIds,
      taskId: input.taskId,
      severity: input.severity,
      deadlineAt: input.deadlineAt,
      idempotencyKey: input.idempotencyKey,
      externalId: input.externalId,
    });
  }

  read_thread(
    credential: unknown,
    input: { threadId: string; cursor?: string; limit?: number },
  ): { messages: Message[]; nextCursor: string | null } {
    const actor = this.resolve(credential).actor;
    return this.threads.readThread(input.threadId, actor, input.cursor, input.limit);
  }

  /** Route a question to the coordinator (lead fallback per router). */
  ask_coordinator(
    credential: unknown,
    input: {
      threadId: string;
      question: string;
      options?: string[];
      severity?: string;
      deadlineAt?: string | null;
      idempotencyKey: string;
    },
  ): PostResult {
    const actor = this.resolve(credential).actor;
    const thread = this.threads.getThread(input.threadId);
    const coordinator = this.presence.coordinatorId(thread.projectId);
    const body = input.options?.length
      ? `${input.question}\nOptions: ${input.options.join(" | ")}`
      : input.question;
    return this.post(actor, {
      threadId: input.threadId,
      kind: "question",
      body,
      recipientIds: coordinator ? [coordinator] : [],
      severity: input.severity ?? "normal",
      deadlineAt: input.deadlineAt ?? null,
      idempotencyKey: input.idempotencyKey,
    });
  }

  /**
   * File a blocker on the task thread (a question with the `blocker`
   * label). Records the blocker durably; the scheduler (E09) owns any
   * ready/blocked task transition.
   */
  create_blocker(
    credential: unknown,
    input: {
      threadId: string;
      reason: string;
      severity?: string;
      deadlineAt: string;
      idempotencyKey: string;
    },
  ): PostResult {
    const actor = this.resolve(credential).actor;
    return this.post(actor, {
      threadId: input.threadId,
      kind: "question",
      labels: ["blocker"],
      body: input.reason,
      severity: input.severity ?? "high",
      deadlineAt: input.deadlineAt,
      idempotencyKey: input.idempotencyKey,
    });
  }

  /**
   * Queue a durable owner decision. Never executes anything and never
   * bypasses approval: the owner answers via `answer_decision` on a
   * verified owner session.
   */
  request_decision(
    credential: unknown,
    input: {
      projectId: string;
      taskId?: string | null;
      question: string;
      options: string[];
      risk: string;
      escalationId?: string | null;
      ttlMs?: number;
      targetSha?: string;
    },
  ): DecisionItem {
    const actor = this.resolve(credential).actor;
    if (actor.role !== "owner" && !(actor.projects ?? []).includes(input.projectId)) {
      throw new MessageError("FORBIDDEN", 403, `actor ${actor.id} is not scoped to project ${input.projectId}`);
    }
    return this.escalations.openDecision({ ...input, requestedBy: actor.id });
  }

  post_artifact(
    credential: unknown,
    input: {
      threadId: string;
      summary: string;
      attachments: AttachmentRef[];
      taskId?: string | null;
      idempotencyKey: string;
    },
  ): PostResult {
    const actor = this.resolve(credential).actor;
    if (!input.attachments?.length) {
      throw new MessageError("VALIDATION", 400, "post_artifact requires at least one attachment");
    }
    return this.post(actor, {
      threadId: input.threadId,
      kind: "update",
      labels: ["artifact"],
      body: input.summary,
      attachments: input.attachments,
      taskId: input.taskId,
      idempotencyKey: input.idempotencyKey,
    });
  }

  /**
   * Note readiness for review on the thread. Does not change task state:
   * review/merge stay with the reviewer, policy service and GitHub truth.
   */
  mark_task_ready_for_review(
    credential: unknown,
    input: { threadId: string; summary: string; idempotencyKey: string },
  ): PostResult {
    const actor = this.resolve(credential).actor;
    return this.post(actor, {
      threadId: input.threadId,
      kind: "update",
      labels: ["readiness"],
      body: `Ready for review: ${input.summary}`,
      idempotencyKey: input.idempotencyKey,
    });
  }

  /**
   * Raise an escalation from a thread. The raiser is the verified caller,
   * never a message-supplied identity.
   */
  raise_escalation(
    credential: unknown,
    input: {
      threadId: string;
      options: string[];
      evidence: string[];
      severity?: Escalation["severity"];
      deadlineAt?: string | null;
      ownerOnly?: boolean;
      decisionTtlMs?: number;
      risk?: string;
    },
  ): { escalation: Escalation; decision?: DecisionItem } {
    const actor = this.resolve(credential).actor;
    return this.escalations.raiseEscalation(this.threads, { ...input, raisedBy: actor });
  }

  /** Coordinator resolution: rationale recorded, never an owner approval. */
  resolve_escalation(
    credential: unknown,
    input: { escalationId: string; resolution: string },
  ): Escalation {
    const actor = this.requireCoordinatorOrOwner(this.resolve(credential));
    return this.escalations.resolveByCoordinator(input.escalationId, actor, input.resolution);
  }

  /** Record an owner answer; requires a verified owner session. */
  answer_decision(
    credential: unknown,
    input: { decisionId: string; answer: string; targetSha?: string },
  ): { decision: DecisionItem; reopened?: DecisionItem } {
    const owner = this.requireOwnerSession(this.resolve(credential));
    return this.escalations.answerDecision(input.decisionId, owner, input.answer, input.targetSha);
  }

  withdraw_decision(
    credential: unknown,
    input: { decisionId: string },
  ): DecisionItem {
    const actor = this.requireCoordinatorOrOwner(this.resolve(credential));
    return this.escalations.withdrawDecision(input.decisionId, actor);
  }
}
