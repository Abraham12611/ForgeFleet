/**
 * E10 / FF-014 — Durable thread/message store.
 *
 * Guarantees (from `docs/04-flows/agent-messaging.md` contract):
 * - every message has a unique ID and task/thread correlation;
 * - a receipt is acknowledged only after persistence (receipts are stored
 *   in the same call that stores the message);
 * - same `idempotencyKey` + same payload replays the original
 *   (`duplicate_replay`); same key + different payload is a 409 conflict;
 * - duplicate normalized runtime events (same external id) yield one
 *   logical message.
 *
 * Pure in-memory map structure with injectable id/clock so tests are
 * deterministic. A future persistence adapter (E06 outbox style) can swap
 * the backing maps without changing callers.
 */

import { randomUUID } from "node:crypto";
import {
  scrubSecrets,
  validateAttachments,
  validateBody,
  validateQuestionFields,
} from "./moderation.ts";
import {
  MessageError,
  type Actor,
  type AttachmentRef,
  type Channel,
  type DeliveryReceipt,
  type DeliveryState,
  type Message,
  type MessageKind,
  type Thread,
} from "./types.ts";

/** Minimal authorization surface this store needs (E07 to own the real one). */
export interface PolicyPort {
  canPost(actor: Actor, thread: Thread): boolean;
  canRead(actor: Actor, thread: Thread): boolean;
}

/**
 * Default closed policy mirroring `docs/05-contracts/policy-matrix.md`
 * (`message.post`: same project + thread ACL; workers cannot impersonate
 * owner/coordinator, cannot cross projects; owner spans projects).
 * Reconcile with E07 `authorize()` before v0.1 integration.
 */
export function defaultPolicy(): PolicyPort {
  const inProject = (actor: Actor, thread: Thread): boolean =>
    actor.role === "owner" ||
    (actor.projects ?? []).includes(thread.projectId);
  const inAcl = (actor: Actor, thread: Thread): boolean =>
    thread.acl.includes(actor.id) || thread.acl.includes(`role:${actor.role}`);
  return {
    canPost: (actor, thread) => inProject(actor, thread) && inAcl(actor, thread),
    canRead: (actor, thread) => inProject(actor, thread) && inAcl(actor, thread),
  };
}

export interface PostInput {
  threadId: string;
  sender: Actor;
  recipientIds?: string[];
  kind: MessageKind;
  body: string;
  attachments?: AttachmentRef[];
  severity?: string;
  deadlineAt?: string | null;
  taskId?: string | null;
  attemptId?: string | null;
  idempotencyKey: string;
  traceId?: string;
  /** External runtime id for dedupe of normalized Orca events. */
  externalId?: string;
}

export interface StoreOptions {
  generateId?: () => string;
  now?: () => string;
  policy?: PolicyPort;
}

/** Deterministic payload hash (FNV-1a) for idempotency comparison. */
export function payloadHash(value: unknown): string {
  const s = JSON.stringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export class ThreadStore {
  private threads = new Map<string, Thread>();
  private messages = new Map<string, Message>();
  /** Insertion order per thread for cursor reads. */
  private threadIndex = new Map<string, string[]>();
  private byIdempotency = new Map<string, { hash: string; message: Message }>();
  private byExternalId = new Map<string, string>();
  private receipts = new Map<string, DeliveryReceipt[]>();
  private policy: PolicyPort;
  private generateId: () => string;
  private now: () => string;

  constructor(opts: StoreOptions = {}) {
    this.policy = opts.policy ?? defaultPolicy();
    this.generateId = opts.generateId ?? randomUUID;
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  createThread(input: {
    channel: Channel;
    projectId: string;
    taskId?: string | null;
    acl: string[];
    threadId?: string;
  }): Thread {
    if (!input.projectId) throw new MessageError("VALIDATION", 400, "projectId required");
    if (!Array.isArray(input.acl) || input.acl.length === 0) {
      throw new MessageError("VALIDATION", 400, "thread acl must be non-empty");
    }
    const thread: Thread = {
      threadId: input.threadId ?? `thread-${this.generateId()}`,
      channel: input.channel,
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      createdAt: this.now(),
      acl: [...input.acl],
      closed: false,
    };
    if (this.threads.has(thread.threadId)) {
      throw new MessageError("CONFLICT", 409, `thread exists: ${thread.threadId}`);
    }
    this.threads.set(thread.threadId, thread);
    this.threadIndex.set(thread.threadId, []);
    return thread;
  }

  getThread(threadId: string): Thread {
    const thread = this.threads.get(threadId);
    if (!thread) throw new MessageError("UNKNOWN_THREAD", 404, `unknown thread: ${threadId}`);
    return thread;
  }

  closeThread(threadId: string): Thread {
    const thread = this.getThread(threadId);
    thread.closed = true;
    return thread;
  }

  /**
   * Persist a message and its initial receipts atomically (in-memory:
   * single call, no ack escapes before the maps hold both). Returns the
   * original on idempotent replay.
   */
  postMessage(input: PostInput): { message: Message; replayed: boolean } {
    const thread = this.getThread(input.threadId);
    if (thread.closed) {
      throw new MessageError("CLOSED_THREAD", 410, `thread closed: ${thread.threadId}`);
    }
    if (!this.policy.canPost(input.sender, thread)) {
      throw new MessageError(
        "FORBIDDEN",
        403,
        `actor ${input.sender.id} may not post to thread ${thread.threadId}`,
      );
    }
    if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length < 8) {
      throw new MessageError("VALIDATION", 400, "idempotencyKey must be a string of >= 8 chars");
    }
    const body = scrubSecrets(validateBody(input.body));
    const attachments = validateAttachments(input.attachments);
    const { severity, deadlineAt } = validateQuestionFields(
      input.kind,
      input.severity,
      input.deadlineAt,
    );

    const hash = payloadHash({
      threadId: thread.threadId,
      senderId: input.sender.id,
      kind: input.kind,
      body,
      recipientIds: [...(input.recipientIds ?? [])].sort(),
    });

    const prior = this.byIdempotency.get(input.idempotencyKey);
    if (prior) {
      if (prior.hash !== hash) {
        throw new MessageError(
          "CONFLICT",
          409,
          "idempotencyKey already used with a different payload",
        );
      }
      return { message: prior.message, replayed: true };
    }

    if (input.externalId !== undefined) {
      const existingId = this.byExternalId.get(input.externalId);
      if (existingId !== undefined) {
        const existing = this.messages.get(existingId);
        if (existing) return { message: existing, replayed: true };
      }
    }

    const message: Message = {
      messageId: this.generateId(),
      threadId: thread.threadId,
      channel: thread.channel,
      projectId: thread.projectId,
      taskId: input.taskId ?? thread.taskId,
      attemptId: input.attemptId ?? null,
      sender: { ...input.sender },
      recipientIds: [...(input.recipientIds ?? [])],
      kind: input.kind,
      body,
      attachments,
      severity,
      deadlineAt,
      createdAt: this.now(),
      traceId: input.traceId ?? this.generateId(),
      idempotencyKey: input.idempotencyKey,
      visibility: [...thread.acl],
    };
    this.messages.set(message.messageId, message);
    this.threadIndex.get(thread.threadId)?.push(message.messageId);
    this.byIdempotency.set(input.idempotencyKey, { hash, message });
    if (input.externalId !== undefined) {
      this.byExternalId.set(input.externalId, message.messageId);
    }
    // Receipts persisted in the same call: no ack can escape first.
    const targets = message.recipientIds.length > 0
      ? message.recipientIds
      : [...thread.acl];
    this.receipts.set(
      message.messageId,
      targets.map((recipientId) => ({
        messageId: message.messageId,
        recipientId,
        state: "queued" as DeliveryState,
        updatedAt: message.createdAt,
      })),
    );
    return { message, replayed: false };
  }

  getMessage(messageId: string): Message {
    const message = this.messages.get(messageId);
    if (!message) throw new MessageError("VALIDATION", 400, `unknown message: ${messageId}`);
    return message;
  }

  receiptsFor(messageId: string): DeliveryReceipt[] {
    return [...(this.receipts.get(messageId) ?? [])];
  }

  setReceipt(messageId: string, recipientId: string, state: DeliveryState, reason?: string): DeliveryReceipt {
    const list = this.receipts.get(messageId);
    if (!list) throw new MessageError("VALIDATION", 400, `unknown message: ${messageId}`);
    const receipt = list.find((r) => r.recipientId === recipientId);
    if (!receipt) {
      throw new MessageError("VALIDATION", 400, `no receipt for ${recipientId}`);
    }
    receipt.state = state;
    receipt.updatedAt = this.now();
    if (reason !== undefined) receipt.reason = reason;
    return { ...receipt };
  }

  /**
   * Cursor read: messages after `cursor` (exclusive, a messageId), up to
   * `limit`. ACL-enforced; closed threads remain readable.
   */
  readThread(
    threadId: string,
    actor: Actor,
    cursor?: string,
    limit: number = 50,
  ): { messages: Message[]; nextCursor: string | null } {
    const thread = this.getThread(threadId);
    if (!this.policy.canRead(actor, thread)) {
      throw new MessageError("FORBIDDEN", 403, `actor ${actor.id} may not read thread ${threadId}`);
    }
    const ids = this.threadIndex.get(threadId) ?? [];
    let start = 0;
    if (cursor !== undefined) {
      const idx = ids.indexOf(cursor);
      if (idx === -1) throw new MessageError("VALIDATION", 400, `unknown cursor: ${cursor}`);
      start = idx + 1;
    }
    const slice = ids.slice(start, start + Math.max(1, limit));
    const messages = slice.map((id) => this.messages.get(id)).filter((m) => m !== undefined);
    return {
      messages,
      nextCursor: messages.length > 0 ? messages[messages.length - 1].messageId : null,
    };
  }
}
