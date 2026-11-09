/**
 * E10 / FF-014 — Routing: who gets woken, fallback when peers are gone.
 *
 * Pure planning (no I/O): `planDelivery` decides wake targets and the
 * outcome; the service layer applies it via `ThreadStore.updateReceipts`
 * in the same transaction as the `message.delivered` outbox event.
 *
 * From `docs/04-flows/agent-messaging.md`:
 * - peer resolves: deliver answer, coordinator gets a summary event;
 * - peer unavailable / message expired: route to lead/coordinator;
 * - cross-team ambiguity: escalation with options/evidence;
 * - owner-only: human decision item, queued while the owner sleeps;
 * - a blocked task may move back to ready after a reply (the scheduler
 *   owns that transition; this router only reports `unblocksTask`).
 *
 * Question wakeups must not repeatedly wake idle agents for duplicate
 * events: replayed posts never re-wake.
 */

import {
  type Message,
  type MessageKind,
  type MessageLabel,
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

  // Owner-directed questions while the owner sleeps are queued, not dropped.
  const ownerId = presence.ownerId(message.projectId);
  if (
    targets.includes(ownerId) &&
    presence.isOwnerSleeping(message.projectId) &&
    message.kind === "question"
  ) {
    return {
      outcome: "queued_while_sleeping",
      wake: [],
      reroutedTo: [],
      queuedForOwner: true,
      unblocksTask: false,
    };
  }

  if (available.length > 0 && available.length === targets.length) {
    return {
      outcome: "stored",
      wake: available,
      reroutedTo: [],
      queuedForOwner: false,
      unblocksTask: message.kind === "answer" || message.kind === "unblock",
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

/**
 * Normalize a raw Orca runtime payload into task-thread post fields.
 * Unknown fields are ignored. The sender is NOT derived here: only the
 * bridge service identity may file runtime messages (see
 * `MessagingService.file_runtime_message`), which forces the sender to
 * the owning worker role — text claiming other authority stays text.
 */
export function normalizeOrcaMessage(input: {
  externalId: string;
  projectId: string;
  taskId: string;
  workerId: string;
  kind: "question" | "answer" | "update";
  text: string;
  threadId?: string;
  idempotencyKey: string;
  severity?: string;
  deadlineAt?: string | null;
  labels?: MessageLabel[];
}): {
  threadId: string;
  kind: MessageKind;
  labels: MessageLabel[];
  body: string;
  projectId: string;
  taskId: string;
  workerId: string;
  idempotencyKey: string;
  externalId: string;
  severity?: string;
  deadlineAt?: string | null;
} {
  return {
    threadId: input.threadId ?? `task/${input.taskId}`,
    kind: input.kind,
    labels: input.labels ?? [],
    body: input.text,
    projectId: input.projectId,
    taskId: input.taskId,
    workerId: input.workerId,
    idempotencyKey: input.idempotencyKey,
    externalId: `orca:${input.externalId}`,
    severity: input.severity,
    deadlineAt: input.deadlineAt,
  };
}
