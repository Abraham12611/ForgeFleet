/**
 * E10 / FF-014 — Durable thread/message store (SQLite-backed).
 *
 * Guarantees (from `docs/04-flows/agent-messaging.md` contract):
 * - every message has a unique ID and task/thread correlation;
 * - message + initial receipts + `message.posted` outbox event commit in
 *   ONE transaction: no ack or wake can escape before the state is
 *   durable, and a restart replays from the same rows;
 * - same `idempotencyKey` + same payload replays the original
 *   (`duplicate_replay`); same key + different payload is a 409 conflict
 *   with no side effect (UNIQUE constraint + pre-check);
 * - duplicate normalized runtime events (same external id) yield one
 *   logical message.
 *
 * Restart recovery (integration owner, #60): receipts left `queued` by a
 * crash are listed by `pendingDeliveryMessageIds()` for re-planning;
 * unclaimed outbox events are re-claimed by the sender loop.
 */

import { randomUUID } from "node:crypto";
import {
  isValidKind,
  scrubSecrets,
  validateAttachments,
  validateBody,
  validateLabels,
  validateQuestionFields,
} from "./moderation.ts";
import { MessagingDb, parseJson } from "./sqlite.ts";
import {
  MessageError,
  toContractActor,
  type Actor,
  type AttachmentRef,
  type BridgeEvent,
  type Channel,
  type DeliveryReceipt,
  type DeliveryState,
  type Message,
  type MessageKind,
  type MessageLabel,
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
 * Keyed on the authenticated caller — never on message content.
 * Reconcile with E07 `authorize()` (#33) before v1.0.
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
  labels?: MessageLabel[];
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
  db: MessagingDb;
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

type MessageRow = {
  message_id: string;
  thread_id: string;
  channel: string;
  project_id: string;
  task_id: string | null;
  attempt_id: string | null;
  sender_json: string;
  recipient_ids_json: string;
  kind: string;
  labels_json: string;
  body: string;
  attachments_json: string | null;
  severity: string | null;
  deadline_at: string | null;
  created_at: string;
  trace_id: string;
  idempotency_key: string;
  external_id: string | null;
  visibility_json: string;
};

function rowToMessage(row: MessageRow): Message {
  return {
    messageId: row.message_id,
    threadId: row.thread_id,
    channel: row.channel as Channel,
    projectId: row.project_id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    sender: JSON.parse(row.sender_json) as Actor,
    recipientIds: parseJson<string[]>(row.recipient_ids_json, []),
    kind: row.kind as MessageKind,
    labels: parseJson<MessageLabel[]>(row.labels_json, []),
    body: row.body,
    attachments: parseJson<AttachmentRef[] | undefined>(row.attachments_json, undefined),
    severity: (row.severity as Message["severity"]) ?? undefined,
    deadlineAt: row.deadline_at,
    createdAt: row.created_at,
    traceId: row.trace_id,
    idempotencyKey: row.idempotency_key,
    visibility: parseJson<string[]>(row.visibility_json, []),
  };
}

export class ThreadStore {
  private db: MessagingDb;
  private policy: PolicyPort;
  private generateId: () => string;
  private now: () => string;

  constructor(opts: StoreOptions) {
    this.db = opts.db;
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
    try {
      this.db
        .prepare(
          "INSERT INTO threads (thread_id, channel, project_id, task_id, created_at, acl_json, closed) VALUES (?, ?, ?, ?, ?, ?, 0)",
        )
        .run(thread.threadId, thread.channel, thread.projectId, thread.taskId, thread.createdAt, JSON.stringify(thread.acl));
    } catch {
      throw new MessageError("CONFLICT", 409, `thread exists: ${thread.threadId}`);
    }
    return thread;
  }

  getThread(threadId: string): Thread {
    const row = this.db.prepare("SELECT * FROM threads WHERE thread_id = ?").get(threadId) as
      | { thread_id: string; channel: string; project_id: string; task_id: string | null; created_at: string; acl_json: string; closed: number }
      | undefined;
    if (!row) throw new MessageError("UNKNOWN_THREAD", 404, `unknown thread: ${threadId}`);
    return {
      threadId: row.thread_id,
      channel: row.channel as Channel,
      projectId: row.project_id,
      taskId: row.task_id,
      createdAt: row.created_at,
      acl: JSON.parse(row.acl_json) as string[],
      closed: row.closed === 1,
    };
  }

  closeThread(threadId: string): Thread {
    const thread = this.getThread(threadId);
    this.db.prepare("UPDATE threads SET closed = 1 WHERE thread_id = ?").run(threadId);
    thread.closed = true;
    return thread;
  }

  /**
   * Persist a message, its initial receipts and the `message.posted`
   * outbox event atomically. Returns the original on idempotent replay.
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
    if (!isValidKind(input.kind as string)) {
      throw new MessageError("VALIDATION", 400, `kind must be one of question|answer|update|unblock|instruction (frozen contract v0.1)`);
    }
    const labels = validateLabels(input.labels);
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
      labels: [...(input.labels ?? [])].sort(),
      body,
      recipientIds: [...(input.recipientIds ?? [])].sort(),
    });

    const createdAt = this.now();
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
      labels: [...(input.labels ?? [])],
      body,
      attachments,
      severity,
      deadlineAt,
      createdAt,
      traceId: input.traceId ?? this.generateId(),
      idempotencyKey: input.idempotencyKey,
      visibility: [...thread.acl],
    };

    return this.db.transaction(() => {
      const prior = this.db
        .prepare("SELECT * FROM messages WHERE idempotency_key = ?")
        .get(input.idempotencyKey) as MessageRow | undefined;
      if (prior) {
        const priorHash = payloadHash({
          threadId: prior.thread_id,
          senderId: (JSON.parse(prior.sender_json) as Actor).id,
          kind: prior.kind,
          labels: parseJson<string[]>(prior.labels_json, []).sort(),
          body: prior.body,
          recipientIds: parseJson<string[]>(prior.recipient_ids_json, []).sort(),
        });
        if (priorHash !== hash) {
          throw new MessageError("CONFLICT", 409, "idempotencyKey already used with a different payload");
        }
        return { message: rowToMessage(prior), replayed: true };
      }

      if (input.externalId !== undefined) {
        const dup = this.db
          .prepare("SELECT * FROM messages WHERE external_id = ?")
          .get(input.externalId) as MessageRow | undefined;
        if (dup) return { message: rowToMessage(dup), replayed: true };
      }

      try {
        this.db
          .prepare(
            `INSERT INTO messages (message_id, thread_id, channel, project_id, task_id, attempt_id,
              sender_json, recipient_ids_json, kind, labels_json, body, attachments_json,
              severity, deadline_at, created_at, trace_id, idempotency_key, external_id, visibility_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            message.messageId, message.threadId, message.channel, message.projectId,
            message.taskId, message.attemptId, JSON.stringify(message.sender),
            JSON.stringify(message.recipientIds), message.kind, JSON.stringify(message.labels),
            message.body, message.attachments ? JSON.stringify(message.attachments) : null,
            message.severity ?? null, message.deadlineAt ?? null, message.createdAt,
            message.traceId, message.idempotencyKey, input.externalId ?? null,
            JSON.stringify(message.visibility),
          );
      } catch (err) {
        if (err instanceof MessageError) throw err;
        throw new MessageError("CONFLICT", 409, `message insert conflict: ${(err as Error).message}`);
      }

      const targets = message.recipientIds.length > 0 ? message.recipientIds : [...thread.acl];
      const receiptStmt = this.db.prepare(
        "INSERT INTO receipts (message_id, recipient_id, state, updated_at) VALUES (?, ?, 'queued', ?)",
      );
      for (const recipientId of targets) {
        receiptStmt.run(message.messageId, recipientId, message.createdAt);
      }

      this.db.enqueueOutbox([
        this.db.buildEvent({
          eventId: this.generateId(),
          eventType: "message.posted",
          occurredAt: message.createdAt,
          projectId: message.projectId,
          taskId: message.taskId,
          actor: toContractActor(message.sender),
          data: {
            messageId: message.messageId,
            threadId: message.threadId,
            kind: message.kind,
            labels: message.labels,
          },
          correlationId: message.traceId,
        }),
      ]);
      return { message, replayed: false };
    });
  }

  getMessage(messageId: string): Message {
    const row = this.db.prepare("SELECT * FROM messages WHERE message_id = ?").get(messageId) as MessageRow | undefined;
    if (!row) throw new MessageError("VALIDATION", 400, `unknown message: ${messageId}`);
    return rowToMessage(row);
  }

  receiptsFor(messageId: string): DeliveryReceipt[] {
    this.getMessage(messageId);
    const rows = this.db
      .prepare("SELECT * FROM receipts WHERE message_id = ? ORDER BY recipient_id")
      .all(messageId) as Array<{ message_id: string; recipient_id: string; state: string; updated_at: string; reason: string | null }>;
    return rows.map((r) => ({
      messageId: r.message_id,
      recipientId: r.recipient_id,
      state: r.state as DeliveryState,
      updatedAt: r.updated_at,
      ...(r.reason ? { reason: r.reason } : {}),
    }));
  }

  /**
   * Apply delivery outcomes in one transaction together with the
   * `message.delivered` outbox event. Wake targets outside the persisted
   * receipt set are reported as failed (never silently dropped).
   */
  updateReceipts(
    message: Message,
    updates: Array<{ recipientId: string; state: DeliveryState; reason?: string }>,
    deliveredEvent?: BridgeEvent,
  ): DeliveryReceipt[] {
    const updatedAt = this.now();
    return this.db.transaction(() => {
      const out: DeliveryReceipt[] = [];
      for (const u of updates) {
        const info = this.db
          .prepare("UPDATE receipts SET state = ?, updated_at = ?, reason = ? WHERE message_id = ? AND recipient_id = ?")
          .run(u.state, updatedAt, u.reason ?? null, message.messageId, u.recipientId);
        if (info.changes === 0) {
          out.push({
            messageId: message.messageId,
            recipientId: u.recipientId,
            state: "failed",
            updatedAt,
            reason: "no receipt slot; redeliver via thread read",
          });
        } else {
          out.push({ messageId: message.messageId, recipientId: u.recipientId, state: u.state, updatedAt, ...(u.reason ? { reason: u.reason } : {}) });
        }
      }
      if (deliveredEvent) this.db.enqueueOutbox([deliveredEvent]);
      return out;
    });
  }

  /**
   * Messages with receipts still `queued` — e.g. after a crash between
   * post and delivery planning. The integration layer (#60) re-plans
   * these on startup; planning itself is idempotent (replay → no re-wake).
   */
  pendingDeliveryMessageIds(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT message_id FROM receipts WHERE state = 'queued'")
      .all() as Array<{ message_id: string }>;
    return rows.map((r) => r.message_id);
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
    let rows: MessageRow[];
    if (cursor === undefined) {
      rows = this.db
        .prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY rowid LIMIT ?")
        .all(threadId, Math.max(1, limit)) as MessageRow[];
    } else {
      const anchor = this.db
        .prepare("SELECT rowid FROM messages WHERE message_id = ? AND thread_id = ?")
        .get(cursor, threadId) as { rowid: number } | undefined;
      if (!anchor) throw new MessageError("VALIDATION", 400, `unknown cursor: ${cursor}`);
      rows = this.db
        .prepare("SELECT * FROM messages WHERE thread_id = ? AND rowid > ? ORDER BY rowid LIMIT ?")
        .all(threadId, anchor.rowid, Math.max(1, limit)) as MessageRow[];
    }
    const messages = rows.map(rowToMessage);
    return {
      messages,
      nextCursor: messages.length > 0 ? messages[messages.length - 1].messageId : null,
    };
  }
}
