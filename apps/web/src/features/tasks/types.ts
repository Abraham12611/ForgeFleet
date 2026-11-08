/**
 * E13 — Tasks/fleet UX (FF-016): shared view-model types for task detail views.
 *
 * Pure types only, derived from the frozen-in-docs contracts:
 * - `docs/05-contracts/state-machines.md` (task + attempt machines)
 * - `docs/05-contracts/bridge.openapi.yaml` (AttemptReceipt, RuntimeSession)
 * - `docs/03-architecture/domain-and-data-model.md` (cross-system ID invariants)
 * - `docs/02-experience/web-app-map.md` (route shapes for trace links)
 *
 * These types describe data the future React screens render. They are
 * framework-free on purpose: E01 owns the Paperclip UI bootstrap and E12
 * owns the dashboard shell, so E13 ships consumable view-models plus
 * deterministic fixtures, not components.
 *
 * Fixture-backed only: no live Paperclip/Orca integration is claimed.
 * Never repurpose an external ID as a primary key, and never assume
 * one task = one attempt = one PR (domain model invariants).
 */

/** Task lifecycle states (subset relevant to detail views). */
export type TaskStatus =
  | "draft"
  | "ready"
  | "reserved"
  | "dispatched"
  | "running"
  | "submitted"
  | "verifying"
  | "verified"
  | "merged"
  | "closed"
  | "blocked"
  | "retry_wait"
  | "failed"
  | "unknown"
  | "cancelled";

/** Attempt lifecycle states (attempt machine + bridge `AttemptReceipt`). */
export type AttemptState =
  | "requested"
  | "accepted"
  | "dispatching"
  | "running"
  | "waiting"
  | "unknown"
  | "finished"
  | "failed"
  | "cancelled";

/** Worker lifecycle states (worker machine, orthogonal states included). */
export type WorkerState =
  | "available"
  | "assigned"
  | "starting"
  | "busy"
  | "reporting"
  | "disconnected"
  | "quarantined"
  | "retiring";

/** Attempt states that still own the task's active lease. */
export const ACTIVE_ATTEMPT_STATES: ReadonlySet<AttemptState> = new Set([
  "requested",
  "accepted",
  "dispatching",
  "running",
  "waiting",
]);

/** Attempt states that are terminal and can never become active again. */
export const TERMINAL_ATTEMPT_STATES: ReadonlySet<AttemptState> = new Set([
  "finished",
  "failed",
  "cancelled",
]);

/**
 * A durable unit of work. `id` is the ForgeFleet UUID/ULID; every external
 * ID stays nullable beside it, never as the primary key.
 */
export interface Task {
  id: string;
  projectId: string;
  title: string;
  status: TaskStatus;
  /** Human-readable acceptance criteria; `verified` requires each to hold. */
  acceptance: string[];
  dependsOn: string[];
  paperclipTaskId?: string | null;
}

/**
 * One execution of a task. `generation` is monotonic per task; a retry
 * always has a higher generation than the attempt it replaces, so history
 * order never depends on timestamps alone.
 */
export interface TaskAttempt {
  attemptId: string;
  taskId: string;
  projectId: string;
  generation: number;
  fencingEpoch: number;
  state: AttemptState;
  provider: string;
  workerKind: string;
  /** Owning runtime identity; null while the attempt is unassigned. */
  agentId: string | null;
  paperclipRunId?: string | null;
  orcaRunId?: string | null;
  orcaTaskId?: string | null;
  orcaDispatchId?: string | null;
  orcaSessionId?: string | null;
  worktreeId?: string | null;
  startedAt?: string | null;
  /** Last reconciled runtime heartbeat; null when never observed. */
  lastHeartbeatAt?: string | null;
  completedAt?: string | null;
  errorCode?: string | null;
}

/**
 * Minimal runtime identity needed to render trace links. Full worker
 * records belong to the fleet feature (`fleet/types.ts`).
 */
export interface AgentRef {
  agentId: string;
  displayName: string;
  provider: string;
  workerState: WorkerState;
}

/** A GitHub deliverable linked to a task or attempt. */
export interface PullRequestRef {
  repo: string;
  prNumber: number;
  headSha: string;
  /** e.g. "checks failing", "approved", "merged". */
  statusSummary: string;
}

/** A message linked to a task thread. */
export interface TaskMessageRef {
  messageId: string;
  threadId: string;
  authorKind: "owner" | "coordinator" | "team lead" | "worker" | "system";
  attemptId?: string | null;
  bodyPreview: string;
  occurredAt: string;
}

/** One normalized timeline entry (see `docs/05-contracts/events.md`). */
export interface TimelineEntry {
  source: string;
  eventId: string;
  eventType: string;
  occurredAt: string;
  attemptId?: string | null;
  summary: string;
}

/** Deep-link routes for the Task → attempt → agent trace (web-app-map). */
export interface TraceLinks {
  /** `/projects/:projectId/tasks/:taskId` */
  taskRoute: string;
  /** `/projects/:projectId/tasks/:taskId` anchored at one attempt. */
  attemptRoute: string | null;
  /** `/fleet/:agentId`; null when the attempt has no runtime owner yet. */
  agentRoute: string | null;
  /** `/projects/:projectId/agents` roster entry for the owner, if any. */
  projectFleetRoute: string;
}

/**
 * Every screen must represent these states where applicable
 * (`docs/02-experience/screens-states-and-copy.md`).
 */
export type ScreenState =
  | "loading"
  | "ready"
  | "empty"
  | "recoverable-error"
  | "permission-denied"
  | "offline"
  | "stale";
