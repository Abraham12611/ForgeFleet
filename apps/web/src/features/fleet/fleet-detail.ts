/**
 * E13 — Tasks/fleet UX (FF-016): fleet list + agent detail view-models.
 *
 * - `buildFleetList` filters the roster and renders one row per agent with
 *   liveness freshness kept separate from task verification. Rows link to
 *   both `/fleet/:agentId` and the agent's current task, so the trace runs
 *   in both directions (agent → task, task → attempt → agent).
 * - `buildAgentDetail` renders `/fleet/:agentId`: runtime identity,
 *   current task, attempt history (each attempt links back to its task),
 *   terminal reference, cost metadata with measured/estimated labels, and
 *   a telemetry-freshness banner.
 *
 * Security notes: terminal output is referenced by handle only — raw logs
 * must be server-redacted before they reach the UI (worker-detail copy
 * rule). Cost figures the runtime never measured stay `unavailable` and
 * render as "not measured", never as $0.00.
 */

import type {
  AgentRef,
  ScreenState,
  Task,
  TaskAttempt,
} from "../tasks/types.ts";
import { agentRoute, taskRoute } from "../tasks/trace.ts";
import { describeLiveness, formatAge } from "../tasks/liveness.ts";
import type { CostMetadata, FleetAgent, FleetFilter } from "./types.ts";

export interface FleetRow {
  agent: FleetAgent;
  agentRoute: string;
  /** `/projects/:id/tasks/:taskId` for the current task; null when idle. */
  currentTaskRoute: string | null;
  currentTaskTitle: string | null;
  /** Freshness of the last runtime reconciliation. */
  freshnessText: string;
  isStale: boolean;
  /** Active attempt count owned by this agent (0 when idle). */
  activeAttempts: number;
}

export interface FleetListViewModel {
  state: ScreenState;
  stateNote: string | null;
  total: number;
  rows: FleetRow[];
}

/** Terminal states render the agent as not-live regardless of freshness. */
function isTerminalWorkerState(agent: FleetAgent): boolean {
  return agent.workerState === "disconnected" || agent.workerState === "retiring";
}

export function applyFleetFilter(
  agents: FleetAgent[],
  filter: FleetFilter,
): FleetAgent[] {
  const query = filter.query?.trim().toLowerCase() ?? "";
  return agents.filter((agent) => {
    if (filter.provider && agent.provider !== filter.provider) return false;
    if (filter.workerState && agent.workerState !== filter.workerState) {
      return false;
    }
    if (filter.activeOnly && agent.currentTaskId === null) return false;
    if (query) {
      const haystack = `${agent.displayName} ${agent.agentId}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

export interface FleetListInput {
  agents: FleetAgent[];
  filter?: FleetFilter;
  tasksById: ReadonlyMap<string, Task>;
  attemptsById: ReadonlyMap<string, TaskAttempt>;
  now?: number;
  loading?: boolean;
  error?: string | null;
  denied?: string | null;
  offline?: boolean;
  staleAfterMs?: number;
}

export function buildFleetList(input: FleetListInput): FleetListViewModel {
  const now = input.now ?? Date.now();
  const staleAfter = input.staleAfterMs ?? 30_000;
  const filtered = applyFleetFilter(input.agents, input.filter ?? {});

  if (input.loading) {
    return { state: "loading", stateNote: null, total: filtered.length, rows: [] };
  }
  if (input.denied) {
    return {
      state: "permission-denied",
      stateNote: input.denied,
      total: filtered.length,
      rows: [],
    };
  }
  if (input.error) {
    return {
      state: "recoverable-error",
      stateNote: input.error,
      total: filtered.length,
      rows: [],
    };
  }
  if (input.offline) {
    return {
      state: "offline",
      stateNote: "Showing last confirmed state. Live updates paused.",
      total: filtered.length,
      rows: filtered.map((agent) => buildRow(agent, input, now)),
    };
  }
  if (filtered.length === 0) {
    return { state: "empty", stateNote: null, total: 0, rows: [] };
  }
  return {
    state: "ready",
    stateNote: null,
    total: filtered.length,
    rows: filtered.map((agent) => buildRow(agent, input, now)),
  };
}

function buildRow(
  agent: FleetAgent,
  input: FleetListInput,
  now: number,
): FleetRow {
  const staleAfter = input.staleAfterMs ?? 30_000;
  const task =
    agent.currentTaskId != null
      ? input.tasksById.get(agent.currentTaskId)
      : undefined;
  let activeAttempts = 0;
  for (const attemptId of agent.attemptIds) {
    const attempt = input.attemptsById.get(attemptId);
    if (!attempt) continue;
    const liveness = describeLiveness({
      attemptState: attempt.state,
      lastHeartbeatAt: attempt.lastHeartbeatAt,
      now,
    });
    if (liveness === "live") activeAttempts += 1;
  }
  const observedMs = agent.lastObservedAt ? Date.parse(agent.lastObservedAt) : NaN;
  const isStale =
    isTerminalWorkerState(agent) ||
    Number.isNaN(observedMs) ||
    now - observedMs > staleAfter;
  return {
    agent,
    agentRoute: agentRoute(agent.agentId),
    currentTaskRoute:
      agent.currentTaskId && agent.currentProjectId && task
        ? taskRoute(agent.currentProjectId, agent.currentTaskId)
        : null,
    currentTaskTitle: task ? task.title : null,
    freshnessText: agent.lastObservedAt
      ? `Last seen ${formatAge(agent.lastObservedAt, now)}`
      : "Never observed",
    isStale,
    activeAttempts,
  };
}

export interface AgentAttemptEntry {
  attempt: TaskAttempt;
  taskTitle: string | null;
  /** Back-link to the owning task detail screen. */
  taskRoute: string | null;
  liveness: ReturnType<typeof describeLiveness>;
}

export interface AgentDetailViewModel {
  state: ScreenState;
  stateNote: string | null;
  agent: FleetAgent;
  agentRoute: string;
  /** Live task card; null with a reason when the agent is idle. */
  currentTask: { title: string; route: string } | null;
  idleReason: string | null;
  attempts: AgentAttemptEntry[];
  /** Handle for the quarantined, server-redacted terminal log viewer. */
  terminalRef: string | null;
  costLabel: string;
  freshnessText: string;
  isStale: boolean;
}

export function costLabelFor(cost?: CostMetadata | null): string {
  if (!cost || cost.source === "unavailable") return "Cost not measured";
  if (cost.billedUsd == null) {
    return cost.source === "estimated"
      ? "Cost estimated — no metered figure"
      : "Cost pending — metered figure not yet reported";
  }
  const amount = `$${cost.billedUsd.toFixed(2)}`;
  return cost.source === "estimated" ? `${amount} (estimated)` : amount;
}

export interface AgentDetailInput {
  agent: FleetAgent;
  attempts: TaskAttempt[];
  tasksById: ReadonlyMap<string, Task>;
  agentsById?: ReadonlyMap<string, AgentRef>;
  now?: number;
  loading?: boolean;
  error?: string | null;
  denied?: string | null;
  offline?: boolean;
  staleAfterMs?: number;
}

export function buildAgentDetail(input: AgentDetailInput): AgentDetailViewModel {
  const now = input.now ?? Date.now();
  const staleAfter = input.staleAfterMs ?? 30_000;
  const ordered = [...input.attempts].sort((a, b) => b.generation - a.generation);

  const resolveState = (): { state: ScreenState; note: string | null } => {
    if (input.loading) return { state: "loading", note: null };
    if (input.denied) return { state: "permission-denied", note: input.denied };
    if (input.error) return { state: "recoverable-error", note: input.error };
    if (input.offline) {
      return {
        state: "offline",
        note: "Showing last confirmed state. Live updates paused.",
      };
    }
    return { state: "ready", note: null };
  };
  const resolved = resolveState();

  const task =
    input.agent.currentTaskId != null
      ? input.tasksById.get(input.agent.currentTaskId)
      : undefined;
  const observedMs = input.agent.lastObservedAt
    ? Date.parse(input.agent.lastObservedAt)
    : NaN;

  return {
    state: resolved.state,
    stateNote: resolved.note,
    agent: input.agent,
    agentRoute: agentRoute(input.agent.agentId),
    currentTask:
      task && input.agent.currentProjectId
        ? {
            title: task.title,
            route: taskRoute(input.agent.currentProjectId, task.id),
          }
        : null,
    idleReason:
      task || input.agent.currentTaskId ? null : "Idle — no task assigned",
    attempts: ordered.map((attempt) => {
      const owner = input.tasksById.get(attempt.taskId);
      return {
        attempt,
        taskTitle: owner ? owner.title : null,
        taskRoute: taskRoute(attempt.projectId, attempt.taskId),
        liveness: describeLiveness({
          attemptState: attempt.state,
          lastHeartbeatAt: attempt.lastHeartbeatAt,
          now,
        }),
      };
    }),
    terminalRef: input.agent.terminalId,
    costLabel: costLabelFor(input.agent.cost),
    freshnessText: input.agent.lastObservedAt
      ? `Last seen ${formatAge(input.agent.lastObservedAt, now)}`
      : "Never observed",
    isStale:
      isTerminalWorkerState(input.agent) ||
      Number.isNaN(observedMs) ||
      now - observedMs > staleAfter,
  };
}
