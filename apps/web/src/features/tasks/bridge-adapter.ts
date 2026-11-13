/**
 * E13 — Tasks/fleet UX (FF-016): typed adapter from frozen bridge and
 * Paperclip task data into the task/fleet view-model inputs.
 *
 * Source shapes mirror the frozen-in-docs contracts (they are structural
 * mirrors, not imports — generated types belong to E05):
 * - `AttemptReceipt` / `RuntimeSession` (`docs/05-contracts/bridge.openapi.yaml`)
 * - normalized event envelope (`docs/05-contracts/events.md`)
 * - Paperclip task authority (`docs/03-architecture/system-architecture.md`:
 *   goal/project/task/dependency/approval owned by the control plane)
 *
 * Boundary rules:
 * - Missing identity fields (attempt/task/agent IDs) throw `AdapterError`
 *   so screens render `recoverable-error`, never a half-linked trace.
 * - Unknown lifecycle strings map to `"unknown"` and render as unknown
 *   (state-machine invariant), never as stopped/failed/healthy.
 * - Unknown event types pass through untouched (forward-compat rule:
 *   older clients safely ignore newer event types).
 * - Generation/fencing assignment is provisional: the bridge receipt has
 *   no generation counter yet, so ordering falls back to `observedAt`
 *   sequence until E06/E09 persist monotonic generations.
 */

import type {
  AttemptState,
  Task,
  TaskAttempt,
  TaskMessageRef,
  TaskStatus,
  TimelineEntry,
  WorkerState,
} from "./types.ts";
import type { FleetAgent } from "../fleet/types.ts";
import type { TaskDetailInput } from "./task-detail.ts";
import type { AgentDetailInput, FleetListInput } from "../fleet/fleet-detail.ts";

/** Structural mirror of `AttemptReceipt` (bridge.openapi.yaml). */
export interface BridgeAttemptPayload {
  attemptId: string;
  projectId: string;
  state: string;
  observedAt: string;
  orcaRunId?: string | null;
  orcaTaskId?: string | null;
  orcaDispatchId?: string | null;
  worktreeId?: string | null;
  errorCode?: string | null;
}

/** Structural mirror of `RuntimeSession` (bridge.openapi.yaml). */
export interface BridgeSessionPayload {
  externalId: string;
  provider?: string | null;
  state: string;
  managed: boolean;
  taskId?: string | null;
  worktreeId?: string | null;
  lastObservedAt?: string | null;
}

/** Structural mirror of the Paperclip-owned task record. */
export interface PaperclipTaskPayload {
  id: string;
  projectId: string;
  title: string;
  status: string;
  acceptance?: string[];
  dependsOn?: string[];
  paperclipTaskId?: string | null;
}

/** Structural mirror of the normalized event envelope (events.md). */
export interface BridgeEventPayload {
  source: string;
  eventId: string;
  eventType: string;
  occurredAt: string;
  attemptId?: string | null;
  summary?: string;
}

export class AdapterError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`bridge adapter: ${message} (field: ${field})`);
    this.name = "AdapterError";
    this.field = field;
  }
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AdapterError(field, "missing or empty identity");
  }
  return value;
}

const ATTEMPT_STATES = new Set<string>([
  "requested",
  "accepted",
  "dispatching",
  "running",
  "waiting",
  "unknown",
  "finished",
  "failed",
  "cancelled",
]);

const TASK_STATUSES = new Set<string>([
  "draft",
  "ready",
  "reserved",
  "dispatched",
  "running",
  "submitted",
  "verifying",
  "verified",
  "merged",
  "closed",
  "blocked",
  "retry_wait",
  "failed",
  "unknown",
  "cancelled",
]);

/** Unknown attempt strings render as unknown, never guessed. */
export function adaptAttemptState(raw: string): AttemptState {
  return (ATTEMPT_STATES.has(raw) ? raw : "unknown") as AttemptState;
}

/** Unknown task strings render as unknown, never guessed. */
export function adaptTaskStatus(raw: string): TaskStatus {
  return (TASK_STATUSES.has(raw) ? raw : "unknown") as TaskStatus;
}

/**
 * Runtime session state → worker machine state. Lossy by nature: a bridge
 * session reports process truth while the worker machine tracks assignment.
 * Mapping is explicit so reviewers can challenge it:
 * running→busy, waiting→assigned, stopped→available, failed→quarantined,
 * unknown (or anything unrecognized)→disconnected. Freshness banners carry
 * the residual uncertainty; screens never claim more than this.
 */
export function adaptWorkerState(raw: string): WorkerState {
  switch (raw) {
    case "running":
      return "busy";
    case "waiting":
      return "assigned";
    case "stopped":
      return "available";
    case "failed":
      return "quarantined";
    default:
      return "disconnected";
  }
}

export function adaptPaperclipTask(payload: PaperclipTaskPayload): Task {
  return {
    id: requireId(payload.id, "task.id"),
    projectId: requireId(payload.projectId, "task.projectId"),
    title: typeof payload.title === "string" ? payload.title : "(untitled task)",
    status: adaptTaskStatus(payload.status),
    acceptance: Array.isArray(payload.acceptance) ? payload.acceptance : [],
    dependsOn: Array.isArray(payload.dependsOn) ? payload.dependsOn : [],
    paperclipTaskId: payload.paperclipTaskId ?? null,
  };
}

/**
 * Provisional generation assignment: sort receipts by `observedAt` and
 * number them 1..N per task (monotonic, so retries outrank originals).
 * Replaced once E06/E09 persist real fencing generations.
 */
export function assignGenerations(
  receipts: BridgeAttemptPayload[],
): Map<string, { generation: number; fencingEpoch: number }> {
  const ordered = [...receipts].sort(
    (a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt),
  );
  const counters = new Map<string, number>();
  const out = new Map<string, { generation: number; fencingEpoch: number }>();
  for (const receipt of ordered) {
    const key = `${receipt.projectId}\u0000${receiptStateTaskKey(receipt)}`;
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    out.set(receipt.attemptId, { generation: next, fencingEpoch: next });
  }
  return out;
}

/** Grouping key for generation counters (per task; falls back to project). */
function receiptStateTaskKey(receipt: BridgeAttemptPayload): string {
  const maybe = (receipt as { taskId?: unknown }).taskId;
  return typeof maybe === "string" && maybe !== "" ? maybe : receipt.projectId;
}

export interface AdaptAttemptOptions {
  taskId: string;
  generation: number;
  fencingEpoch: number;
  provider: string;
  workerKind: string;
  agentId?: string | null;
  paperclipRunId?: string | null;
  orcaSessionId?: string | null;
  startedAt?: string | null;
  lastHeartbeatAt?: string | null;
  completedAt?: string | null;
}

export function adaptAttempt(
  receipt: BridgeAttemptPayload,
  options: AdaptAttemptOptions,
): TaskAttempt {
  return {
    attemptId: requireId(receipt.attemptId, "attempt.attemptId"),
    taskId: requireId(options.taskId, "attempt.taskId"),
    projectId: requireId(receipt.projectId, "attempt.projectId"),
    generation: options.generation,
    fencingEpoch: options.fencingEpoch,
    state: adaptAttemptState(receipt.state),
    provider: options.provider,
    workerKind: options.workerKind,
    agentId: options.agentId ?? null,
    paperclipRunId: options.paperclipRunId ?? null,
    orcaRunId: receipt.orcaRunId ?? null,
    orcaTaskId: receipt.orcaTaskId ?? null,
    orcaDispatchId: receipt.orcaDispatchId ?? null,
    orcaSessionId: options.orcaSessionId ?? null,
    worktreeId: receipt.worktreeId ?? null,
    startedAt: options.startedAt ?? null,
    lastHeartbeatAt: options.lastHeartbeatAt ?? receipt.observedAt ?? null,
    completedAt: options.completedAt ?? null,
    errorCode: receipt.errorCode ?? null,
  };
}

export interface AdaptAgentOptions {
  displayName?: string | null;
  currentProjectId?: string | null;
  attemptIds?: string[];
  terminalId?: string | null;
}

/** Runtime sessions identify by `externalId`; agent IDs derive from it. */
export function adaptAgent(
  session: BridgeSessionPayload,
  options: AdaptAgentOptions = {},
): FleetAgent {
  const agentId = requireId(session.externalId, "session.externalId");
  return {
    agentId,
    displayName: options.displayName ?? agentId,
    provider: session.provider ?? "unknown",
    workerState: adaptWorkerState(session.state),
    currentTaskId: session.taskId ?? null,
    currentProjectId: options.currentProjectId ?? null,
    attemptIds: options.attemptIds ?? [],
    worktreeId: session.worktreeId ?? null,
    terminalId: options.terminalId ?? null,
    lastObservedAt: session.lastObservedAt ?? null,
    cost: null,
  };
}

/** Unknown event types pass through; only identity is enforced. */
export function adaptTimelineEvent(event: BridgeEventPayload): TimelineEntry {
  return {
    source: requireId(event.source, "event.source"),
    eventId: requireId(event.eventId, "event.eventId"),
    eventType:
      typeof event.eventType === "string" && event.eventType !== ""
        ? event.eventType
        : "unknown",
    occurredAt: event.occurredAt,
    attemptId: event.attemptId ?? null,
    summary: event.summary ?? event.eventType,
  };
}

export interface TaskDetailSource {
  task: PaperclipTaskPayload;
  receipts: BridgeAttemptPayload[];
  /** Attempt owners by attempt ID (from session reconciliation). */
  agentByAttemptId?: ReadonlyMap<string, string>;
  heartbeatByAttemptId?: ReadonlyMap<string, string>;
  startedByAttemptId?: ReadonlyMap<string, string>;
  completedByAttemptId?: ReadonlyMap<string, string>;
  providerByAttemptId?: ReadonlyMap<string, string>;
  taskIdByAttemptId: ReadonlyMap<string, string>;
  agentsById: ReadonlyMap<string, { displayName: string }>;
  events?: BridgeEventPayload[];
  messages?: TaskMessageRef[];
  pullRequests?: TaskDetailInput["pullRequests"];
  now?: number;
}

/** Full boundary: frozen payloads → `TaskDetailInput`, fail-closed on IDs. */
export function adaptTaskDetailInput(source: TaskDetailSource): TaskDetailInput {
  const task = adaptPaperclipTask(source.task);
  const generations = assignGenerations(source.receipts);
  const attempts = source.receipts.map((receipt) => {
    const gen = generations.get(receipt.attemptId) ?? {
      generation: 1,
      fencingEpoch: 1,
    };
    const taskId = source.taskIdByAttemptId.get(receipt.attemptId) ?? task.id;
    return adaptAttempt(receipt, {
      taskId,
      generation: gen.generation,
      fencingEpoch: gen.fencingEpoch,
      provider:
        source.providerByAttemptId?.get(receipt.attemptId) ?? "unknown",
      workerKind:
        source.providerByAttemptId?.get(receipt.attemptId) ?? "unknown",
      agentId: source.agentByAttemptId?.get(receipt.attemptId) ?? null,
      lastHeartbeatAt:
        source.heartbeatByAttemptId?.get(receipt.attemptId) ?? receipt.observedAt,
      startedAt: source.startedByAttemptId?.get(receipt.attemptId) ?? null,
      completedAt: source.completedByAttemptId?.get(receipt.attemptId) ?? null,
    });
  });
  const agentsById = new Map(
    [...source.agentsById].map(([agentId, ref]) => [
      agentId,
      {
        agentId,
        displayName: ref.displayName,
        provider: "unknown",
        workerState: "disconnected" as WorkerState,
      },
    ]),
  );
  return {
    task,
    attempts,
    agentsById,
    timeline: (source.events ?? []).map(adaptTimelineEvent),
    pullRequests: source.pullRequests,
    messages: source.messages,
    now: source.now,
  };
}

export interface FleetSource {
  sessions: BridgeSessionPayload[];
  displayNameBySession?: ReadonlyMap<string, string>;
  projectByTaskId?: ReadonlyMap<string, string>;
  tasks: Task[];
  attempts: TaskAttempt[];
  now?: number;
}

/** Full boundary: sessions + known tasks/attempts → `FleetListInput`. */
export function adaptFleetInput(source: FleetSource): FleetListInput {
  const tasksById = new Map(source.tasks.map((t) => [t.id, t]));
  const attemptsById = new Map(source.attempts.map((a) => [a.attemptId, a]));
  const attemptIdsByAgent = new Map<string, string[]>();
  for (const attempt of source.attempts) {
    if (!attempt.agentId) continue;
    const list = attemptIdsByAgent.get(attempt.agentId) ?? [];
    list.push(attempt.attemptId);
    attemptIdsByAgent.set(attempt.agentId, list);
  }
  const agents = source.sessions.map((session) =>
    adaptAgent(session, {
      displayName: source.displayNameBySession?.get(session.externalId),
      currentProjectId: session.taskId
        ? (source.projectByTaskId?.get(session.taskId) ?? null)
        : null,
      attemptIds: attemptIdsByAgent.get(session.externalId) ?? [],
      terminalId: session.externalId,
    }),
  );
  return { agents, tasksById, attemptsById, now: source.now };
}

export interface AgentDetailSource {
  agent: FleetAgent;
  attempts: TaskAttempt[];
  tasks: Task[];
  now?: number;
}

export function adaptAgentDetailInput(source: AgentDetailSource): AgentDetailInput {
  return {
    agent: source.agent,
    attempts: source.attempts,
    tasksById: new Map(source.tasks.map((t) => [t.id, t])),
    now: source.now,
  };
}
