/**
 * E10 / FF-014 — Escalation and durable owner decisions (SQLite-backed).
 *
 * From `docs/04-flows/agent-messaging.md` and
 * `docs/05-contracts/state-machines.md` (decision machine):
 * `proposed -> pending -> answered | withdrawn | expired`.
 * - An expired OWNER_REQUIRED approval never grants authority.
 * - An answer against a changed target SHA is invalid and reopens
 *   the decision as a fresh item linked to the old one.
 * - While the owner sleeps, decisions queue; independent work proceeds.
 *
 * Every transition commits with its outbox event (`decision.requested`,
 * `decision.answered`, `decision.expired`, `decision.withdrawn`) in one
 * transaction: a crash cannot lose an answered decision or emit an ack
 * for one that was never stored.
 *
 * Authority: answering requires an authenticated owner human arriving on
 * an owner session (or the test harness). A service token, and any
 * message-derived claim, is rejected — messages are never authority.
 */

import { randomUUID } from "node:crypto";
import { MessagingDb } from "./sqlite.ts";
import { ThreadStore } from "./thread-store.ts";
import {
  MessageError,
  toContractActor,
  type Actor,
  type AuthenticatedCaller,
  type DecisionItem,
  type Escalation,
} from "./types.ts";

export interface EscalationStoreOptions {
  db: MessagingDb;
  generateId?: () => string;
  now?: () => string;
  defaultDecisionTtlMs?: number;
}

type DecisionRow = {
  decision_id: string;
  project_id: string;
  task_id: string | null;
  escalation_id: string | null;
  question: string;
  options_json: string;
  risk: string;
  requested_by: string;
  created_at: string;
  expires_at: string;
  status: string;
  answer: string | null;
  answered_by: string | null;
  answered_at: string | null;
  target_sha: string | null;
};

type EscalationRow = {
  escalation_id: string;
  thread_id: string;
  project_id: string;
  task_id: string | null;
  raised_by_json: string;
  options_json: string;
  evidence_json: string;
  severity: string;
  deadline_at: string | null;
  created_at: string;
  status: string;
  resolution: string | null;
  decision_id: string | null;
};

function rowToDecision(row: DecisionRow): DecisionItem {
  return {
    decisionId: row.decision_id,
    projectId: row.project_id,
    taskId: row.task_id,
    escalationId: row.escalation_id,
    question: row.question,
    options: JSON.parse(row.options_json) as string[],
    risk: row.risk,
    requestedBy: row.requested_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status: row.status as DecisionItem["status"],
    ...(row.answer ? { answer: row.answer } : {}),
    ...(row.answered_by ? { answeredBy: row.answered_by } : {}),
    ...(row.answered_at ? { answeredAt: row.answered_at } : {}),
    ...(row.target_sha ? { targetSha: row.target_sha } : {}),
  };
}

function rowToEscalation(row: EscalationRow): Escalation {
  return {
    escalationId: row.escalation_id,
    threadId: row.thread_id,
    projectId: row.project_id,
    taskId: row.task_id,
    raisedBy: JSON.parse(row.raised_by_json) as Actor,
    options: JSON.parse(row.options_json) as string[],
    evidence: JSON.parse(row.evidence_json) as string[],
    severity: row.severity as Escalation["severity"],
    deadlineAt: row.deadline_at,
    createdAt: row.created_at,
    status: row.status as Escalation["status"],
    ...(row.resolution ? { resolution: row.resolution } : {}),
    ...(row.decision_id ? { decisionId: row.decision_id } : {}),
  };
}

/** Owner answers must arrive on an owner session (or the test harness). */
function requireOwnerHuman(caller: AuthenticatedCaller): Actor {
  const { identity, via } = caller;
  if (via !== "owner-session" && via !== "test-harness") {
    throw new MessageError(
      "FORBIDDEN",
      403,
      `owner answers require an owner session transport (got ${via}); service tokens and message content are never authority`,
    );
  }
  if (identity.role !== "owner" || identity.type !== "human") {
    throw new MessageError(
      "FORBIDDEN",
      403,
      "only an authenticated owner human answers a decision; messages are never authority",
    );
  }
  return identity;
}

export class EscalationStore {
  private db: MessagingDb;
  private generateId: () => string;
  private now: () => string;
  private defaultDecisionTtlMs: number;

  constructor(opts: EscalationStoreOptions) {
    this.db = opts.db;
    this.generateId = opts.generateId ?? randomUUID;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.defaultDecisionTtlMs = opts.defaultDecisionTtlMs ?? 4 * 60 * 60 * 1000;
  }

  /**
   * Raise an escalation from a thread. Requires options + evidence.
   * Enqueues a `message.posted` notice so subscribers learn of it without
   * a new (frozen-contract-breaking) event type. With `ownerOnly`, opens
   * a durable owner decision in the same transaction.
   */
  raiseEscalation(
    threads: ThreadStore,
    input: {
      threadId: string;
      raisedBy: Actor;
      options: string[];
      evidence: string[];
      severity?: Escalation["severity"];
      deadlineAt?: string | null;
      ownerOnly?: boolean;
      decisionTtlMs?: number;
      risk?: string;
    },
  ): { escalation: Escalation; decision?: DecisionItem } {
    const thread = threads.getThread(input.threadId);
    if (!Array.isArray(input.options) || input.options.length === 0) {
      throw new MessageError("VALIDATION", 400, "escalation requires at least one option");
    }
    if (!Array.isArray(input.evidence) || input.evidence.length === 0) {
      throw new MessageError("VALIDATION", 400, "escalation requires evidence pointers");
    }
    const createdAt = this.now();
    const escalation: Escalation = {
      escalationId: this.generateId(),
      threadId: thread.threadId,
      projectId: thread.projectId,
      taskId: thread.taskId,
      raisedBy: { ...input.raisedBy },
      options: [...input.options],
      evidence: [...input.evidence],
      severity: input.severity ?? "normal",
      deadlineAt: input.deadlineAt ?? null,
      createdAt,
      status: "open",
    };

    return this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO escalations (escalation_id, thread_id, project_id, task_id, raised_by_json,
            options_json, evidence_json, severity, deadline_at, created_at, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
        )
        .run(
          escalation.escalationId, escalation.threadId, escalation.projectId, escalation.taskId,
          JSON.stringify(escalation.raisedBy), JSON.stringify(escalation.options),
          JSON.stringify(escalation.evidence), escalation.severity, escalation.deadlineAt,
          escalation.createdAt,
        );
      this.db.enqueueOutbox([
        this.db.buildEvent({
          eventId: this.generateId(),
          eventType: "message.posted",
          occurredAt: createdAt,
          projectId: thread.projectId,
          taskId: thread.taskId,
          actor: toContractActor(escalation.raisedBy),
          data: { escalationId: escalation.escalationId, threadId: thread.threadId, severity: escalation.severity },
          correlationId: escalation.escalationId,
        }),
      ]);

      if (input.ownerOnly === true) {
        const decision = this.insertDecision({
          projectId: thread.projectId,
          taskId: thread.taskId,
          escalationId: escalation.escalationId,
          question: `Escalation ${escalation.escalationId} needs an owner decision`,
          options: escalation.options,
          risk: input.risk ?? "Owner-only call; no safe default applied.",
          requestedBy: input.raisedBy.id,
          ttlMs: input.decisionTtlMs,
          createdAt,
        });
        this.db
          .prepare("UPDATE escalations SET status = 'owner_decision', decision_id = ? WHERE escalation_id = ?")
          .run(decision.decisionId, escalation.escalationId);
        escalation.status = "owner_decision";
        escalation.decisionId = decision.decisionId;
        return { escalation: { ...escalation }, decision };
      }
      return { escalation: { ...escalation } };
    });
  }

  private insertDecision(input: {
    projectId: string;
    taskId?: string | null;
    escalationId?: string | null;
    question: string;
    options: string[];
    risk: string;
    requestedBy: string;
    ttlMs?: number;
    targetSha?: string;
    createdAt?: string;
  }): DecisionItem {
    if (!input.question) throw new MessageError("VALIDATION", 400, "decision question required");
    if (!Array.isArray(input.options) || input.options.length === 0) {
      throw new MessageError("VALIDATION", 400, "decision requires options");
    }
    const createdAt = input.createdAt ?? this.now();
    const decision: DecisionItem = {
      decisionId: this.generateId(),
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      escalationId: input.escalationId ?? null,
      question: input.question,
      options: [...input.options],
      risk: input.risk,
      requestedBy: input.requestedBy,
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + (input.ttlMs ?? this.defaultDecisionTtlMs)).toISOString(),
      status: "pending",
      ...(input.targetSha ? { targetSha: input.targetSha } : {}),
    };
    this.db
      .prepare(
        `INSERT INTO decisions (decision_id, project_id, task_id, escalation_id, question, options_json,
          risk, requested_by, created_at, expires_at, status, target_sha)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        decision.decisionId, decision.projectId, decision.taskId, decision.escalationId,
        decision.question, JSON.stringify(decision.options), decision.risk, decision.requestedBy,
        decision.createdAt, decision.expiresAt, decision.targetSha ?? null,
      );
    this.db.enqueueOutbox([
      this.db.buildEvent({
        eventId: this.generateId(),
        eventType: "decision.requested",
        occurredAt: createdAt,
        projectId: decision.projectId,
        taskId: decision.taskId,
        actor: { type: "service", id: "forgefleet-messaging" },
        data: {
          decisionId: decision.decisionId,
          escalationId: decision.escalationId,
          question: decision.question,
          options: decision.options,
          expiresAt: decision.expiresAt,
        },
        correlationId: decision.escalationId ?? decision.decisionId,
      }),
    ]);
    return { ...decision };
  }

  openDecision(input: {
    projectId: string;
    taskId?: string | null;
    escalationId?: string | null;
    question: string;
    options: string[];
    risk: string;
    requestedBy: string;
    ttlMs?: number;
    targetSha?: string;
  }): DecisionItem {
    return this.db.transaction(() => this.insertDecision(input));
  }

  getDecision(decisionId: string): DecisionItem {
    const row = this.db.prepare("SELECT * FROM decisions WHERE decision_id = ?").get(decisionId) as DecisionRow | undefined;
    if (!row) throw new MessageError("VALIDATION", 400, `unknown decision: ${decisionId}`);
    return rowToDecision(row);
  }

  getEscalation(escalationId: string): Escalation {
    const row = this.db.prepare("SELECT * FROM escalations WHERE escalation_id = ?").get(escalationId) as EscalationRow | undefined;
    if (!row) throw new MessageError("VALIDATION", 400, `unknown escalation: ${escalationId}`);
    return rowToEscalation(row);
  }

  /** Coordinator resolution: rationale recorded, never an owner approval. */
  resolveByCoordinator(escalationId: string, caller: AuthenticatedCaller, resolution: string): Escalation {
    if (caller.identity.role !== "coordinator" && caller.identity.role !== "owner") {
      throw new MessageError("FORBIDDEN", 403, "only the coordinator (or owner) resolves escalations");
    }
    if (!resolution) throw new MessageError("VALIDATION", 400, "resolution rationale required");
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM escalations WHERE escalation_id = ?").get(escalationId) as EscalationRow | undefined;
      if (!row) throw new MessageError("VALIDATION", 400, `unknown escalation: ${escalationId}`);
      if (row.status !== "open") throw new MessageError("CONFLICT", 409, `escalation already ${row.status}`);
      this.db.prepare("UPDATE escalations SET status = 'coordinator_resolved', resolution = ? WHERE escalation_id = ?").run(resolution, escalationId);
      return this.getEscalation(escalationId);
    });
  }

  /**
   * Record an authenticated owner answer. Expired items cannot be
   * answered (expiry grants nothing). An answer against a changed target
   * SHA is invalid and reopens the decision as a fresh item.
   */
  answerDecision(
    decisionId: string,
    caller: AuthenticatedCaller,
    answer: string,
    targetSha?: string,
  ): { decision: DecisionItem; reopened?: DecisionItem } {
    const owner = requireOwnerHuman(caller);
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM decisions WHERE decision_id = ?").get(decisionId) as DecisionRow | undefined;
      if (!row) throw new MessageError("VALIDATION", 400, `unknown decision: ${decisionId}`);
      if (row.status === "answered" || row.status === "withdrawn") {
        throw new MessageError("CONFLICT", 409, `decision already ${row.status}`);
      }
      if (Date.parse(this.now()) >= Date.parse(row.expires_at)) {
        this.db.prepare("UPDATE decisions SET status = 'expired' WHERE decision_id = ?").run(decisionId);
        this.enqueueDecisionEvent(row, "decision.expired", {});
        throw new MessageError("CONFLICT", 409, "decision expired; expiry grants no authority");
      }
      const options = JSON.parse(row.options_json) as string[];
      if (!options.includes(answer)) {
        throw new MessageError("VALIDATION", 400, "answer must be one of the presented options");
      }
      if (row.target_sha !== null && targetSha !== undefined && row.target_sha !== targetSha) {
        const reopened = this.insertDecision({
          projectId: row.project_id,
          taskId: row.task_id,
          escalationId: row.escalation_id,
          question: `${row.question} (reopened: target changed)`,
          options,
          risk: row.risk,
          requestedBy: row.requested_by,
          targetSha,
        });
        this.db.prepare("UPDATE decisions SET status = 'withdrawn' WHERE decision_id = ?").run(decisionId);
        this.enqueueDecisionEvent(row, "decision.withdrawn", { reason: "target changed; reopened", reopenedDecisionId: reopened.decisionId });
        return { decision: this.getDecision(decisionId), reopened };
      }
      const answeredAt = this.now();
      this.db
        .prepare("UPDATE decisions SET status = 'answered', answer = ?, answered_by = ?, answered_at = ?, target_sha = COALESCE(?, target_sha) WHERE decision_id = ?")
        .run(answer, owner.id, answeredAt, targetSha ?? null, decisionId);
      this.enqueueDecisionEvent({ ...row, status: "answered", answer, answered_by: owner.id, answered_at: answeredAt }, "decision.answered", { answer, answeredBy: owner.id });
      return { decision: this.getDecision(decisionId) };
    });
  }

  private enqueueDecisionEvent(row: DecisionRow, eventType: "decision.answered" | "decision.expired" | "decision.withdrawn", extra: Record<string, unknown>): void {
    this.db.enqueueOutbox([
      this.db.buildEvent({
        eventId: this.generateId(),
        eventType,
        occurredAt: this.now(),
        projectId: row.project_id,
        taskId: row.task_id,
        actor: { type: "service", id: "forgefleet-messaging" },
        data: { decisionId: row.decision_id, escalationId: row.escalation_id, ...extra },
        correlationId: row.escalation_id ?? row.decision_id,
      }),
    ]);
  }

  withdrawDecision(decisionId: string, caller: AuthenticatedCaller): DecisionItem {
    if (caller.identity.role !== "coordinator" && caller.identity.role !== "owner") {
      throw new MessageError("FORBIDDEN", 403, "only the coordinator (or owner) withdraws decisions");
    }
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM decisions WHERE decision_id = ?").get(decisionId) as DecisionRow | undefined;
      if (!row) throw new MessageError("VALIDATION", 400, `unknown decision: ${decisionId}`);
      if (row.status === "answered" || row.status === "expired") {
        throw new MessageError("CONFLICT", 409, `decision already ${row.status}`);
      }
      this.db.prepare("UPDATE decisions SET status = 'withdrawn' WHERE decision_id = ?").run(decisionId);
      this.enqueueDecisionEvent(row, "decision.withdrawn", {});
      return this.getDecision(decisionId);
    });
  }

  /** Sweep for expiries; returns ids newly marked expired. */
  expireDue(): string[] {
    const nowMs = Date.parse(this.now());
    return this.db.transaction(() => {
      const rows = this.db
        .prepare("SELECT * FROM decisions WHERE status IN ('proposed', 'pending')")
        .all() as DecisionRow[];
      const expired: string[] = [];
      for (const row of rows) {
        if (nowMs >= Date.parse(row.expires_at)) {
          this.db.prepare("UPDATE decisions SET status = 'expired' WHERE decision_id = ?").run(row.decision_id);
          this.enqueueDecisionEvent(row, "decision.expired", {});
          expired.push(row.decision_id);
        }
      }
      const open = this.db.prepare("SELECT * FROM escalations WHERE status = 'open'").all() as EscalationRow[];
      for (const esc of open) {
        if (esc.deadline_at !== null && nowMs >= Date.parse(esc.deadline_at)) {
          this.db.prepare("UPDATE escalations SET status = 'expired' WHERE escalation_id = ?").run(esc.escalation_id);
        }
      }
      return expired;
    });
  }
}
