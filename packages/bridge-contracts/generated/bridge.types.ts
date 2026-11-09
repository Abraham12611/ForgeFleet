// Generated from packages/bridge-contracts/schemas/*.schema.json — do not edit by hand.
// Regenerate with: python3 scripts/generate.py  (contract v0.1.0)

export interface Actor {
  type: "service" | "human" | "agent";
  id: string;
}

export type AttemptId = string;

export interface AttemptLease {
  fencingEpoch: number;
  leaseToken: string;
}

export interface AttemptReceipt {
  attemptId: AttemptId;
  projectId: string;
  state: AttemptState;
  observedAt: string;
  orcaRunId?: string | null;
  orcaTaskId?: string | null;
  orcaDispatchId?: string | null;
  worktreeId?: string | null;
  errorCode?: string | null;
}

export type AttemptState = "accepted" | "dispatching" | "running" | "waiting" | "unknown" | "finished" | "failed" | "cancelled";

export interface BridgeEvent {
  eventId: string;
  schemaVersion: "0.1";
  eventType: EventType;
  occurredAt: string;
  receivedAt?: string;
  source: string;
  projectId: string;
  taskId?: string;
  attemptId?: string;
  correlationId?: string;
  fencingEpoch?: number;
  actor?: Actor;
  data?: Record<string, unknown>;
}

export interface CancelAttemptRequest {
  reason: string;
  approvedBy: string;
}

export interface CreateAttemptRequest {
  projectId: string;
  paperclipTaskId: string;
  paperclipRunId: string;
  workerKind: string;
  taskTitle?: string;
  instruction?: string;
  contextManifestId: string;
  repositoryId?: string;
  lease: AttemptLease;
}

export interface Error {
  errorCode: string;
  message: string;
  details?: Record<string, unknown>;
}

export type EventType = "project.created" | "project.paused" | "project.resumed" | "task.ready" | "task.claimed" | "task.blocked" | "task.unblocked" | "task.submitted" | "task.verified" | "task.failed" | "attempt.accepted" | "attempt.started" | "attempt.heartbeat" | "attempt.question" | "attempt.finished" | "attempt.failed" | "attempt.unknown" | "attempt.cancelled" | "message.posted" | "message.delivered" | "message.acknowledged" | "message.failed" | "decision.requested" | "decision.answered" | "decision.expired" | "decision.withdrawn" | "github.pr.opened" | "github.checks.updated" | "github.review.submitted" | "github.merged" | "github.closed" | "runtime.connected" | "runtime.disconnected" | "runtime.capacity.changed" | "budget.threshold" | "budget.exhausted";

export type IdempotencyKey = string;

export type MessageKind = "question" | "answer" | "update" | "unblock" | "instruction";

export type ProviderStatus = "verified" | "unsupported" | "unknown" | "unavailable";

export interface RuntimeCapabilities {
  reachable: boolean;
  checkedAt: string;
  cliVersion?: string | null;
  commandPath?: string | null;
  providers: Array<{
      name: string;
      status: ProviderStatus;
      notes?: string;
    }>;
}

export interface RuntimeSession {
  externalId: string;
  provider?: string | null;
  state: SessionState;
  managed: boolean;
  taskId?: string | null;
  worktreeId?: string | null;
  lastObservedAt?: string | null;
}

export interface RuntimeSessionList {
  sessions: Array<RuntimeSession>;
}

export interface SendMessageRequest {
  projectId: string;
  threadId: string;
  actorId: string;
  body: string;
  kind?: MessageKind;
}

export type SessionState = "running" | "waiting" | "stopped" | "failed" | "unknown";
