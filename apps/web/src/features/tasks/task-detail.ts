/**
 * E13 — Tasks/fleet UX (FF-016): task detail view-model builder.
 *
 * Builds everything the `/projects/:id/tasks/:taskId` screen renders:
 * acceptance checklist, attempts ordered by monotonic generation, the
 * Task → attempt → agent trace links, a deduped timeline, linked PRs and
 * messages, and the screen state (loading/ready/empty/error/denied/
 * offline/stale).
 *
 * Ordering rule: attempts sort by `generation` descending, never by
 * timestamps alone — a fenced retry always outranks the attempt it
 * replaced. Invariant surfaced, not hidden: more than one active attempt
 * sets `traceConflict` so the UI can banner the fencing violation
 * (state machines require at most one active fenced attempt per task).
 */

import {
  ACTIVE_ATTEMPT_STATES,
  type AgentRef,
  type PullRequestRef,
  type ScreenState,
  type Task,
  type TaskAttempt,
  type TaskMessageRef,
  type TimelineEntry,
  type TraceLinks,
} from "./types.ts";
import { attemptRoute, projectFleetRoute, taskRoute } from "./trace.ts";
import {
  describeLiveness,
  formatAge,
  LIVENESS_LABELS,
} from "./liveness.ts";

export interface AttemptViewModel {
  attempt: TaskAttempt;
  /** True when this attempt currently owns the task lease. */
  isActive: boolean;
  liveness: ReturnType<typeof describeLiveness>;
  livenessLabel: string;
  lastSeenText: string | null;
  links: TraceLinks;
  agentDisplayName: string | null;
}

export interface AcceptanceItem {
  criterion: string;
  /** True only when the task reached `verified`/`merged`/`closed`. */
  satisfied: boolean;
}

export interface TaskDetailViewModel {
  task: Task;
  state: ScreenState;
  /** Non-null only for `recoverable-error` / `permission-denied`. */
  stateNote: string | null;
  acceptance: AcceptanceItem[];
  /** Attempts newest-first by generation; `active` is at most one. */
  attempts: AttemptViewModel[];
  active: AttemptViewModel | null;
  /**
   * True when zero or 2+ attempts claim the active lease. Zero is normal
   * for a task that never dispatched; 2+ is a fencing violation banner.
   */
  traceConflict: boolean;
  timeline: TimelineEntry[];
  pullRequests: PullRequestRef[];
  messages: TaskMessageRef[];
  /** Every attempt resolves to a runtime owner (`agentRoute` non-null). */
  fullyTraceable: boolean;
}

export interface TaskDetailInput {
  task: Task;
  attempts: TaskAttempt[];
  agentsById: ReadonlyMap<string, AgentRef>;
  timeline: TimelineEntry[];
  pullRequests?: PullRequestRef[];
  messages?: TaskMessageRef[];
  now?: number;
  /** Loading flag from the fetcher. Takes precedence over data. */
  loading?: boolean;
  /** Retryable fetch failure message; null when no error. */
  error?: string | null;
  /** Authorization denial rationale; null when permitted. */
  denied?: string | null;
  /** True when the transport is down but cached data is shown. */
  offline?: boolean;
  /** Last confirmed sync; older than `staleAfterMs` renders `stale`. */
  lastSyncAt?: number | null;
  staleAfterMs?: number;
}

/** Verification states: acceptance counts as satisfied. */
function isVerifiedStatus(status: Task["status"]): boolean {
  return status === "verified" || status === "merged" || status === "closed";
}

export function resolveScreenState(input: {
  loading?: boolean;
  error?: string | null;
  denied?: string | null;
  offline?: boolean;
  isEmpty: boolean;
  lastSyncAt?: number | null;
  staleAfterMs?: number;
  now: number;
}): { state: ScreenState; note: string | null } {
  if (input.loading) return { state: "loading", note: null };
  if (input.denied) return { state: "permission-denied", note: input.denied };
  if (input.error) return { state: "recoverable-error", note: input.error };
  if (input.offline) {
    return {
      state: "offline",
      note: "Showing last confirmed state. Live updates paused.",
    };
  }
  if (
    input.lastSyncAt != null &&
    nowIsStale(input.lastSyncAt, input.staleAfterMs ?? 30_000, input.now)
  ) {
    return {
      state: "stale",
      note: "Data may be outdated. Refresh to reconcile.",
    };
  }
  if (input.isEmpty) return { state: "empty", note: null };
  return { state: "ready", note: null };
}

function nowIsStale(lastSyncAt: number, staleAfterMs: number, now: number): boolean {
  return now - lastSyncAt > staleAfterMs;
}

/** Dedupe timeline by `(source, eventId)`; keep earliest occurrence order. */
export function dedupeTimeline(entries: TimelineEntry[]): TimelineEntry[] {
  const seen = new Set<string>();
  const out: TimelineEntry[] = [];
  for (const entry of entries) {
    const key = `${entry.source}\u0000${entry.eventId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  out.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  return out;
}

export function buildTaskDetail(input: TaskDetailInput): TaskDetailViewModel {
  const now = input.now ?? Date.now();
  const ordered = [...input.attempts].sort((a, b) => b.generation - a.generation);
  const activeAttempts = ordered.filter((a) => ACTIVE_ATTEMPT_STATES.has(a.state));

  const attempts: AttemptViewModel[] = ordered.map((attempt) => {
    const agent = attempt.agentId ? input.agentsById.get(attempt.agentId) : undefined;
    const liveness = describeLiveness({
      attemptState: attempt.state,
      lastHeartbeatAt: attempt.lastHeartbeatAt,
      now,
    });
    return {
      attempt,
      isActive: ACTIVE_ATTEMPT_STATES.has(attempt.state),
      liveness,
      livenessLabel: LIVENESS_LABELS[liveness],
      lastSeenText: attempt.lastHeartbeatAt
        ? `Last seen ${formatAge(attempt.lastHeartbeatAt, now)}`
        : null,
      links: {
        taskRoute: taskRoute(input.task.projectId, input.task.id),
        attemptRoute: attemptRoute(input.task.projectId, input.task.id, attempt.attemptId),
        agentRoute: attempt.agentId
          ? `/fleet/${encodeURIComponent(attempt.agentId)}`
          : null,
        projectFleetRoute: projectFleetRoute(input.task.projectId),
      },
      agentDisplayName: agent ? agent.displayName : null,
    };
  });

  const active = attempts.find((a) => a.isActive) ?? null;
  const traceConflict = activeAttempts.length > 1;
  const timeline = dedupeTimeline(input.timeline);
  const satisfied = isVerifiedStatus(input.task.status);
  const resolved = resolveScreenState({
    loading: input.loading,
    error: input.error,
    denied: input.denied,
    offline: input.offline,
    isEmpty: ordered.length === 0 && !input.loading,
    lastSyncAt: input.lastSyncAt,
    staleAfterMs: input.staleAfterMs,
    now,
  });

  return {
    task: input.task,
    state: resolved.state,
    stateNote: resolved.note,
    acceptance: input.task.acceptance.map((criterion) => ({ criterion, satisfied })),
    attempts,
    active,
    traceConflict,
    timeline,
    pullRequests: input.pullRequests ?? [],
    messages: input.messages ?? [],
    fullyTraceable: attempts.every((a) => a.links.agentRoute !== null),
  };
}
