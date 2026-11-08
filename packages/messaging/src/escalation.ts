/**
 * E10 / FF-014 — Escalation and durable owner decisions.
 *
 * From `docs/04-flows/agent-messaging.md` and
 * `docs/05-contracts/state-machines.md` (decision machine):
 * `proposed -> pending -> answered | withdrawn | expired`.
 * - An expired OWNER_REQUIRED approval never grants authority.
 * - An answer against a changed target SHA is invalid and reopens
 *   the decision (a fresh item linked to the old one).
 * - While the owner sleeps, decisions queue; independent work proceeds.
 */

import { randomUUID } from "node:crypto";
import { ThreadStore } from "./thread-store.ts";
import {
  MessageError,
  type Actor,
  type DecisionItem,
  type Escalation,
} from "./types.ts";

export interface EscalationStoreOptions {
  generateId?: () => string;
  now?: () => string;
  defaultDecisionTtlMs?: number;
}

export class EscalationStore {
  private escalations = new Map<string, Escalation>();
  private decisions = new Map<string, DecisionItem>();
  private generateId: () => string;
  private now: () => string;
  private defaultDecisionTtlMs: number;

  constructor(opts: EscalationStoreOptions = {}) {
    this.generateId = opts.generateId ?? randomUUID;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.defaultDecisionTtlMs = opts.defaultDecisionTtlMs ?? 4 * 60 * 60 * 1000;
  }

  /**
   * Raise an escalation from a thread. Requires options + evidence so the
   * resolver (coordinator or owner) has something concrete to decide on.
   * When `ownerOnly` is true (or the caller asks), a durable owner decision
   * item is created and queued; otherwise the escalation stays open for
   * coordinator resolution.
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
      createdAt: this.now(),
      status: "open",
    };
    this.escalations.set(escalation.escalationId, escalation);

    if (input.ownerOnly === true) {
      const decision = this.openDecision({
        projectId: thread.projectId,
        taskId: thread.taskId,
        escalationId: escalation.escalationId,
        question: `Escalation ${escalation.escalationId} needs an owner decision`,
        options: escalation.options,
        risk: input.risk ?? "Owner-only call; no safe default applied.",
        requestedBy: input.raisedBy.id,
        ttlMs: input.decisionTtlMs,
      });
      escalation.status = "owner_decision";
      escalation.decisionId = decision.decisionId;
      return { escalation: { ...escalation }, decision };
    }
    return { escalation: { ...escalation } };
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
    if (!input.question) throw new MessageError("VALIDATION", 400, "decision question required");
    if (!Array.isArray(input.options) || input.options.length === 0) {
      throw new MessageError("VALIDATION", 400, "decision requires options");
    }
    const createdAt = this.now();
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
      expiresAt: new Date(
        Date.parse(createdAt) + (input.ttlMs ?? this.defaultDecisionTtlMs),
      ).toISOString(),
      status: "pending",
      targetSha: input.targetSha,
    };
    this.decisions.set(decision.decisionId, decision);
    return { ...decision };
  }

  getDecision(decisionId: string): DecisionItem {
    const decision = this.decisions.get(decisionId);
    if (!decision) throw new MessageError("VALIDATION", 400, `unknown decision: ${decisionId}`);
    return { ...decision };
  }

  getEscalation(escalationId: string): Escalation {
    const escalation = this.escalations.get(escalationId);
    if (!escalation) {
      throw new MessageError("VALIDATION", 400, `unknown escalation: ${escalationId}`);
    }
    return { ...escalation };
  }

  /** Coordinator resolution: rationale recorded, never an owner approval. */
  resolveByCoordinator(escalationId: string, actor: Actor, resolution: string): Escalation {
    if (actor.role !== "coordinator" && actor.role !== "owner") {
      throw new MessageError("FORBIDDEN", 403, "only the coordinator (or owner) resolves escalations");
    }
    const escalation = this.escalations.get(escalationId);
    if (!escalation) throw new MessageError("VALIDATION", 400, `unknown escalation: ${escalationId}`);
    if (escalation.status !== "open") {
      throw new MessageError("CONFLICT", 409, `escalation already ${escalation.status}`);
    }
    if (!resolution) throw new MessageError("VALIDATION", 400, "resolution rationale required");
    escalation.status = "coordinator_resolved";
    escalation.resolution = resolution;
    return { ...escalation };
  }

  /**
   * Record an authenticated owner answer. Only `role: "owner"` counts —
   * a chat utterance or agent message is never authority. Expired items
   * cannot be answered (expiry grants nothing); a target-SHA change
   * reopens the decision as a fresh item.
   */
  answerDecision(
    decisionId: string,
    actor: Actor,
    answer: string,
    targetSha?: string,
  ): { decision: DecisionItem; reopened?: DecisionItem } {
    const decision = this.decisions.get(decisionId);
    if (!decision) throw new MessageError("VALIDATION", 400, `unknown decision: ${decisionId}`);
    if (actor.role !== "owner" || actor.type !== "human") {
      throw new MessageError(
        "FORBIDDEN",
        403,
        "only an authenticated owner action answers a decision; messages are never authority",
      );
    }
    if (decision.status === "answered" || decision.status === "withdrawn") {
      throw new MessageError("CONFLICT", 409, `decision already ${decision.status}`);
    }
    if (Date.parse(this.now()) >= Date.parse(decision.expiresAt)) {
      decision.status = "expired";
      throw new MessageError("CONFLICT", 409, "decision expired; expiry grants no authority");
    }
    if (!decision.options.includes(answer)) {
      throw new MessageError("VALIDATION", 400, "answer must be one of the presented options");
    }
    if (
      decision.targetSha !== undefined &&
      targetSha !== undefined &&
      decision.targetSha !== targetSha
    ) {
      const reopened = this.openDecision({
        projectId: decision.projectId,
        taskId: decision.taskId,
        escalationId: decision.escalationId,
        question: `${decision.question} (reopened: target changed)`,
        options: decision.options,
        risk: decision.risk,
        requestedBy: decision.requestedBy,
        targetSha,
      });
      decision.status = "withdrawn";
      return { decision: { ...decision }, reopened };
    }
    decision.status = "answered";
    decision.answer = answer;
    decision.answeredBy = actor.id;
    decision.answeredAt = this.now();
    if (targetSha !== undefined) decision.targetSha = targetSha;
    return { decision: { ...decision } };
  }

  withdrawDecision(decisionId: string, actor: Actor): DecisionItem {
    const decision = this.decisions.get(decisionId);
    if (!decision) throw new MessageError("VALIDATION", 400, `unknown decision: ${decisionId}`);
    if (actor.role !== "coordinator" && actor.role !== "owner") {
      throw new MessageError("FORBIDDEN", 403, "only the coordinator (or owner) withdraws decisions");
    }
    if (decision.status === "answered" || decision.status === "expired") {
      throw new MessageError("CONFLICT", 409, `decision already ${decision.status}`);
    }
    decision.status = "withdrawn";
    return { ...decision };
  }

  /** Sweep for expiries; returns ids newly marked expired. */
  expireDue(): string[] {
    const nowMs = Date.parse(this.now());
    const expired: string[] = [];
    for (const decision of this.decisions.values()) {
      if (
        (decision.status === "proposed" || decision.status === "pending") &&
        nowMs >= Date.parse(decision.expiresAt)
      ) {
        decision.status = "expired";
        expired.push(decision.decisionId);
      }
    }
    for (const escalation of this.escalations.values()) {
      if (
        escalation.status === "open" &&
        escalation.deadlineAt !== null &&
        nowMs >= Date.parse(escalation.deadlineAt)
      ) {
        escalation.status = "expired";
      }
    }
    return expired;
  }
}
