/**
 * E10 / FF-014 — Routing: who gets woken, fallback when peers are gone.
 *
 * From `docs/04-flows/agent-messaging.md`:
 * - peer resolves: deliver answer, coordinator gets a summary event;
 * - peer unavailable / message expires: route to lead/coordinator;
 * - cross-team ambiguity: escalation with options/evidence;
 * - owner-only: human decision item, queued while the owner sleeps;
 * - a blocked task may move back to ready after a reply (the scheduler
 *   owns that transition; this router only reports `unblocksTask`).
 *
 * Question wakeups must not repeatedly wake idle agents for duplicate
 * events: replayed posts never re-wake.
 */

import { ThreadStore } from "./thread-store.ts";
import {
  type Actor,
  type DeliveryReceipt,
  type Message,
  type Outcome,
  type Thread,
} from "./types.ts";

/** Who can currently receive a wakeup (adapter over runtime presence). */
export interface PresencePort {
  isAvailable(recipientId: string): boolean;
  leadFor(projectId: string, taskId: string | null): string | null;
  coordinatorId(projectId: string): string | null;
  ownerId(projectId: string): string;
  isOwnerSleeping(projectId: string): boolean;
}

export interface RoutePlan {
  outcome: Outcome;
  wake: string[];
  reroutedTo: string[];
  queuedForOwner: boolean;
  unblocksTask: boolean;
}

export function planDelivery(
  message: Message,
  thread: Thread,
  presence: PresencePort,
  replayed: boolean,
): RoutePlan {
  if (replayed) {
    return { outcome: "duplicate_replay", wake: [], reroutedTo: [], queuedForOwner: false, unblocksTask: false };
  }
  const explicit = message.recipientIds.length > 0 ? message.recipientIds : [...thread.acl];
  const targets = explicit.filter((id) => id !== message.sender.id);
  const available = targets.filter((id) => presence.isAvailable(id));
  const unavailable = targets.filter((id) => !presence.isAvailable(id));

  // Owner-directed questions while the owner sleeps are queued, not dropped.
  const ownerId = presence.ownerId(message.projectId);
  if (
    targets.includes(ownerId) &&
    presence.isOwnerSleeping(message.projectId) &&
    (message.kind === "question" || message.kind === "blocker")
  ) {
    return {
      outcome: "queued_while_sleeping",
      wake: [],
      reroutedTo: [],
      queuedForOwner: true,
      unblocksTask: false,
    };
  }

  if (available.length > 0 && unavailable.length === 0) {
    return {
      outcome: "stored",
      wake: available,
      reroutedTo: [],
      queuedForOwner: false,
      unblocksTask: message.kind === "answer",
    };
  }

  // Peer unavailable or expired: fall back to lead, then coordinator.
  const reroutedTo: string[] = [];
  const lead = presence.leadFor(message.projectId, message.taskId);
  const coordinator = presence.coordinatorId(message.projectId);
  for (const fallback of [lead, coordinator]) {
    if (fallback && !targets.includes(fallback) && presence.isAvailable(fallback)) {
      reroutedTo.push(fallback);
      break;
    }
  }
  if (reroutedTo.length === 0 && coordinator && !targets.includes(coordinator)) {
    reroutedTo.push(coordinator);
  }
  const outcome: Outcome =
    reroutedTo.length > 0 && reroutedTo[0] === lead
      ? "rerouted_to_lead"
      : "rerouted_to_coordinator";
  return {
    outcome,
    wake: [...available, ...reroutedTo],
    reroutedTo,
    queuedForOwner: false,
    unblocksTask: false,
  };
}

/** Apply a route plan to the store receipts (persisted before any ack). */
export function applyRoutePlan(
  store: ThreadStore,
  message: Message,
  plan: RoutePlan,
  reason?: string,
): DeliveryReceipt[] {
  const out: DeliveryReceipt[] = [];
  for (const recipientId of plan.wake) {
    try {
      out.push(store.setReceipt(message.messageId, recipientId, "delivered", reason));
    } catch {
      // Wake target outside the persisted receipt set (e.g. fallback lead):
      // recorded by the caller as a new delivery event, never silently.
      out.push({ messageId: message.messageId, recipientId, state: "failed", updatedAt: message.createdAt, reason: "no receipt slot; redeliver via thread read" });
    }
  }
  return out;
}

/**
 * Normalize a raw Orca runtime payload into a task-thread post.
 * Unknown fields are ignored; the sender is always the owning worker
 * identity, never whoever the text claims to be (no impersonation).
 */
export function normalizeOrcaMessage(input: {
  externalId: string;
  projectId: string;
  taskId: string;
  workerId: string;
  kind: "question" | "answer" | "status" | "text";
  text: string;
  threadId?: string;
  idempotencyKey: string;
  severity?: string;
  deadlineAt?: string | null;
}): {
  threadId: string;
  sender: Actor;
  kind: "question" | "answer" | "status" | "text";
  body: string;
  taskId: string;
  idempotencyKey: string;
  externalId: string;
  severity?: string;
  deadlineAt?: string | null;
} {
  return {
    threadId: input.threadId ?? `task/${input.taskId}`,
    sender: {
      type: "agent",
      id: input.workerId,
      role: "worker",
      projects: [input.projectId],
    },
    kind: input.kind,
    body: input.text,
    taskId: input.taskId,
    idempotencyKey: input.idempotencyKey,
    externalId: `orca:${input.externalId}`,
    severity: input.severity,
    deadlineAt: input.deadlineAt,
  };
}
