/**
 * E10 / FF-014 — MCP facade: the agent-facing tool surface.
 *
 * Tools from `docs/03-architecture/communications.md`:
 * `send_message`, `read_thread`, `ask_coordinator`, `create_blocker`,
 * `request_decision`, `post_artifact`, `mark_task_ready_for_review`,
 * plus `file_runtime_message` for bridge-normalized Orca traffic.
 *
 * Authentication boundary (review: auth from trusted service identity,
 * not message payload):
 * - every tool takes an `AuthenticatedCaller` (identity + transport).
 *   `via: "message"` does not exist and is rejected: message content can
 *   never be the transport.
 * - a caller posts AS ITSELF (`sender = caller.identity`), except the
 *   bridge service identity via `file_runtime_message`, which files on
 *   behalf of a runtime worker with the sender role forced to `worker`.
 *   Workers cannot file as owner/coordinator/each other; text claiming
 *   authority stays text.
 * - `answerDecision` additionally requires an owner human on an owner
 *   session (service tokens refused).
 *
 * Agent-to-agent messages never modify tasks or grant authority;
 * follow-up actions stay typed and explicit. `request_decision` only
 * queues a durable owner item.
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
  type AuthenticatedCaller,
  type CallerTransport,
  type DecisionItem,
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

const TRANSPORTS: readonly CallerTransport[] = ["service-token", "owner-session", "test-harness"];

/** Validate the authenticated caller; message content is never a transport. */
export function requireCaller(caller: unknown): AuthenticatedCaller {
  if (typeof caller !== "object" || caller === null) {
    throw new MessageError("VALIDATION", 400, "authenticated caller identity required");
  }
  const { identity, via } = caller as Record<string, unknown>;
  if (!TRANSPORTS.includes(via as CallerTransport)) {
    throw new MessageError(
      "FORBIDDEN",
      403,
      `untrusted caller transport: ${String(via)}; authority requires service-token or owner-session`,
    );
  }
  if (typeof identity !== "object" || identity === null) {
    throw new MessageError("VALIDATION", 400, "caller identity required");
  }
  const id = identity as Record<string, unknown>;
  if (typeof id.id !== "string" || !id.id) {
    throw new MessageError("VALIDATION", 400, "caller id required");
  }
  if (!["human", "agent", "service"].includes(id.type as string)) {
    throw new MessageError("VALIDATION", 400, "caller type must be human|agent|service");
  }
  if (!["owner", "coordinator", "lead", "worker", "reviewer", "service"].includes(id.role as string)) {
    throw new MessageError("VALIDATION", 400, "unknown caller role");
  }
  return caller as AuthenticatedCaller;
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
  private threads: ThreadStore;
  private escalations: EscalationStore;
  private presence: PresencePort;
  private generateId: () => string;
  private now: () => string;

  constructor(db: MessagingDb, opts: ServiceOptions = {}) {
    this.db = db;
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

  /** Post as yourself; sender is always the authenticated caller. */
  send_message(
    caller: unknown,
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
    const actor = requireCaller(caller).identity;
    return this.post(actor, {
      ...input,
      kind: requireKind(input.kind),
      labels: validateLabels(input.labels),
    });
  }

  /**
   * File a normalized Orca runtime message on behalf of a worker.
   * Only the bridge service identity may call this; the sender role is
   * forced to `worker` regardless of what the runtime text claims.
   */
  file_runtime_message(
    caller: unknown,
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
    const { identity, via } = requireCaller(caller);
    if (via !== "service-token" && via !== "test-harness") {
      throw new MessageError("FORBIDDEN", 403, "runtime messages are filed by the bridge service identity only");
    }
    if (identity.role !== "service") {
      throw new MessageError("FORBIDDEN", 403, "only the bridge service identity files runtime messages");
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
    caller: unknown,
    input: { threadId: string; cursor?: string; limit?: number },
  ): { messages: Message[]; nextCursor: string | null } {
    const actor = requireCaller(caller).identity;
    return this.threads.readThread(input.threadId, actor, input.cursor, input.limit);
  }

  /** Route a question to the coordinator (lead fallback per router). */
  ask_coordinator(
    caller: unknown,
    input: {
      threadId: string;
      question: string;
      options?: string[];
      severity?: string;
      deadlineAt?: string | null;
      idempotencyKey: string;
    },
  ): PostResult {
    const actor = requireCaller(caller).identity;
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
    caller: unknown,
    input: {
      threadId: string;
      reason: string;
      severity?: string;
      deadlineAt: string;
      idempotencyKey: string;
    },
  ): PostResult {
    const actor = requireCaller(caller).identity;
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
   * bypasses approval: the owner answers out-of-band via `answerDecision`.
   */
  request_decision(
    caller: unknown,
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
    const actor = requireCaller(caller).identity;
    if (actor.role !== "owner" && !(actor.projects ?? []).includes(input.projectId)) {
      throw new MessageError("FORBIDDEN", 403, `actor ${actor.id} is not scoped to project ${input.projectId}`);
    }
    return this.escalations.openDecision({ ...input, requestedBy: actor.id });
  }

  post_artifact(
    caller: unknown,
    input: {
      threadId: string;
      summary: string;
      attachments: AttachmentRef[];
      taskId?: string | null;
      idempotencyKey: string;
    },
  ): PostResult {
    const actor = requireCaller(caller).identity;
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
    caller: unknown,
    input: { threadId: string; summary: string; idempotencyKey: string },
  ): PostResult {
    const actor = requireCaller(caller).identity;
    return this.post(actor, {
      threadId: input.threadId,
      kind: "update",
      labels: ["readiness"],
      body: `Ready for review: ${input.summary}`,
      idempotencyKey: input.idempotencyKey,
    });
  }
}
