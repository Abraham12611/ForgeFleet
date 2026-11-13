/**
 * E13 — Tasks/fleet UX (FF-016): route containers (fixture-backed).
 *
 * These containers feed the mounted screens with deterministic fixture
 * payloads shaped like the frozen bridge/Paperclip contracts, run through
 * the same `bridge-adapter.ts` boundary live data will use. Every screen
 * carries an explicit fixture notice: this is UI-integration wiring, NOT
 * live runtime state, and the 200-agent roster is not evidence of 200
 * concurrent workers.
 */
import { useMemo } from "react";
import { useParams } from "react-router-dom";
import {
  adaptAgentDetailInput,
  adaptFleetInput,
  adaptTaskDetailInput,
  type BridgeAttemptPayload,
  type BridgeSessionPayload,
  type PaperclipTaskPayload,
} from "./bridge-adapter.ts";
import { buildTaskDetail, type TaskDetailInput } from "./task-detail.ts";
import { TaskDetailScreen } from "./TaskDetailScreen.tsx";
import {
  FIXTURE_NOW,
  fixtureAttempts,
  fixtureMessages,
  fixturePullRequests,
  fixtureTasks,
  fixtureTimeline,
  makeLargeFleet,
} from "./fixtures.ts";
import type { TaskMessageRef } from "./types.ts";

function fixtureTaskSource(taskId: string) {
  const tasks = fixtureTasks();
  const task = tasks.find((t) => t.id === taskId);
  const attempts = fixtureAttempts().filter((a) => a.taskId === taskId);
  const paperclipTask: PaperclipTaskPayload = task
    ? {
        id: task.id,
        projectId: task.projectId,
        title: task.title,
        status: task.status,
        acceptance: task.acceptance,
        dependsOn: task.dependsOn,
        paperclipTaskId: task.paperclipTaskId,
      }
    : {
        id: taskId,
        projectId: "unknown",
        title: "(task record unavailable)",
        status: "unknown",
      };
  const receipts: BridgeAttemptPayload[] = attempts.map((a) => ({
    attemptId: a.attemptId,
    projectId: a.projectId,
    state: a.state,
    observedAt: a.lastHeartbeatAt ?? a.startedAt ?? new Date(FIXTURE_NOW).toISOString(),
    orcaRunId: a.orcaRunId,
    orcaTaskId: a.orcaTaskId,
    orcaDispatchId: a.orcaDispatchId,
    worktreeId: a.worktreeId,
    errorCode: a.errorCode,
  }));
  const agentsById = new Map(
    ["agent_muse_01", "agent_muse_02"].map((id) => [
      id,
      { displayName: id === "agent_muse_01" ? "Muse worker 01" : "Muse worker 02" },
    ]),
  );
  const input: TaskDetailInput = adaptTaskDetailInput({
    task: paperclipTask,
    receipts,
    taskIdByAttemptId: new Map(attempts.map((a) => [a.attemptId, a.taskId])),
    agentByAttemptId: new Map(
      attempts
        .filter((a) => a.agentId)
        .map((a) => [a.attemptId, a.agentId as string]),
    ),
    heartbeatByAttemptId: new Map(
      attempts
        .filter((a) => a.lastHeartbeatAt)
        .map((a) => [a.attemptId, a.lastHeartbeatAt as string]),
    ),
    providerByAttemptId: new Map(attempts.map((a) => [a.attemptId, a.provider])),
    agentsById,
    events: fixtureTimeline()
      .filter((e) => attempts.some((a) => a.attemptId === e.attemptId))
      .map((e) => ({
        source: e.source,
        eventId: e.eventId,
        eventType: e.eventType,
        occurredAt: e.occurredAt,
        attemptId: e.attemptId,
        summary: e.summary,
      })),
    messages: fixtureMessages().filter((m: TaskMessageRef) =>
      attempts.some((a) => a.attemptId === m.attemptId),
    ),
    pullRequests: taskId === "task_auth_api" ? fixturePullRequests() : [],
    now: FIXTURE_NOW,
  });
  return input;
}

export function TaskDetailRoute() {
  const { taskId } = useParams();
  const vm = useMemo(
    () => buildTaskDetail(fixtureTaskSource(taskId ?? "unknown")),
    [taskId],
  );
  return (
    <>
      <p role="note" className="ff-banner">
        Fixture data — UI integration only, not live runtime state.
      </p>
      <TaskDetailScreen vm={vm} />
    </>
  );
}
