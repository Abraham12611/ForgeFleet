/**
 * E10 / FF-014 — MCP facade: the agent-facing tool surface.
 *
 * Tools from `docs/03-architecture/communications.md`:
 * `send_message`, `read_thread`, `ask_coordinator`, `create_blocker`,
 * `request_decision`, `post_artifact`, `mark_task_ready_for_review`.
 *
 * Every tool validates caller identity, project scope, task ownership,
 * schema and permissions. Agent-to-agent messages never modify tasks or
 * grant authority; follow-up actions stay typed and explicit. In
 * particular `request_decision` only queues a durable owner item — an
 * answer still requires an authenticated owner action (`answerDecision`).
 */

import { EscalationStore } from "./escalation.ts";
import { applyRoutePlan, planDelivery, type PresencePort } from "./router.ts";
import { ThreadStore } from "./thread-store.ts";
import {
  MessageError,
  type Actor,
  type AttachmentRef,
  type DecisionItem,
  type Message,
  type MessageKind,
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

function requireActor(actor: unknown): Actor {
  if (typeof actor !== "object" || actor === null) {
    throw new MessageError("VALIDATION", 400, "authenticated caller identity required");
  }
  const a = actor as Record<string, unknown>;
  if (typeof a.id !== "string" || !a.id) {
    throw new MessageError("VALIDATION", 400, "caller id required");
  }
  if (!["human", "agent", "service"].includes(a.type as string)) {
    throw new MessageError("VALIDATION", 400, "caller type must be human|agent|service");
  }
  if (!["owner", "coordinator", "lead", "worker", "reviewer", "service"].includes(a.role as string)) {
    throw new MessageError("VALIDATION", 400, "unknown caller role");
  }
  return actor as Actor;
}

export class MessagingService {
  private threads: ThreadStore;
  private escalations: EscalationStore;
  private presence: PresencePort;

  constructor(
    threads: ThreadStore = new ThreadStore(),
    escalations: EscalationStore = new EscalationStore(),
    presence: PresencePort = openPresence(),
  ) {
    this.threads = threads;
    this.escalations = escalations;
    this.presence = presence;
  }

  get store(): ThreadStore {
    return this.threads;
  }

  get escalationStore(): EscalationStore {
    return this.escalations;
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
      body: string;
      recipientIds?: string[];
      attachments?: AttachmentRef[];
      severity?: string;
      deadlineAt?: string | null;
      taskId?: string | null;
      idempotencyKey: string;
    },
  ): PostResult {
    this.checkTaskOwnership(input.threadId, actor, input.taskId);
    const { message, replayed } = this.threads.postMessage({ ...input, sender: actor });
    const thread = this.threads.getThread(message.threadId);
    const plan = planDelivery(message, thread, this.presence, replayed);
    const receipts = replayed ? this.threads.receiptsFor(message.messageId) : applyRoutePlan(this.threads, message, plan);
    const outcome: Outcome = replayed ? "duplicate_replay" : plan.outcome;
    return { outcome, message, receipts };
  }

  send_message(
    actor: unknown,
    input: {
      threadId: string;
      kind: MessageKind;
      body: string;
      recipientIds?: string[];
      attachments?: AttachmentRef[];
      severity?: string;
      deadlineAt?: string | null;
      taskId?: string | null;
      idempotencyKey: string;
    },
  ): PostResult {
    return this.post(requireActor(actor), input);
  }

  read_thread(
    actor: unknown,
    input: { threadId: string; cursor?: string; limit?: number },
  ): { messages: Message[]; nextCursor: string | null } {
    return this.threads.readThread(input.threadId, requireActor(actor), input.cursor, input.limit);
  }

  /** Route a question to the coordinator (lead fallback per router). */
  ask_coordinator(
    actor: unknown,
    input: {
      threadId: string;
      question: string;
      options?: string[];
      severity?: string;
      deadlineAt?: string | null;
      idempotencyKey: string;
    },
  ): PostResult {
    const caller = requireActor(actor);
    const thread = this.threads.getThread(input.threadId);
    const coordinator = this.presence.coordinatorId(thread.projectId);
    const body = input.options?.length
      ? `${input.question}\nOptions: ${input.options.join(" | ")}`
      : input.question;
    return this.post(caller, {
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
   * File a blocker on the task thread. Records the blocker durably; the
   * scheduler (E09) owns any ready/blocked task transition.
   */
  create_blocker(
    actor: unknown,
    input: {
      threadId: string;
      reason: string;
      severity?: string;
      deadlineAt: string;
      idempotencyKey: string;
    },
  ): PostResult {
    return this.post(requireActor(actor), {
      threadId: input.threadId,
      kind: "blocker",
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
    actor: unknown,
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
    const caller = requireActor(actor);
    if (caller.role !== "owner" && !(caller.projects ?? []).includes(input.projectId)) {
      throw new MessageError("FORBIDDEN", 403, `actor ${caller.id} is not scoped to project ${input.projectId}`);
    }
    return this.escalations.openDecision({ ...input, requestedBy: caller.id });
  }

  post_artifact(
    actor: unknown,
    input: {
      threadId: string;
      summary: string;
      attachments: AttachmentRef[];
      taskId?: string | null;
      idempotencyKey: string;
    },
  ): PostResult {
    if (!input.attachments?.length) {
      throw new MessageError("VALIDATION", 400, "post_artifact requires at least one attachment");
    }
    return this.post(requireActor(actor), {
      threadId: input.threadId,
      kind: "artifact",
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
    actor: unknown,
    input: { threadId: string; summary: string; idempotencyKey: string },
  ): PostResult {
    return this.post(requireActor(actor), {
      threadId: input.threadId,
      kind: "status",
      body: `Ready for review: ${input.summary}`,
      idempotencyKey: input.idempotencyKey,
    });
  }
}
