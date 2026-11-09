/**
 * E13 — Tasks/fleet UX (FF-016): fleet route containers (fixture-backed).
 *
 * Same fixture-notice rule as `tasks/TaskDetailRoute.tsx`: deterministic
 * payloads through the shared adapter boundary, explicitly not live
 * runtime state. The full 200-agent roster demonstrates virtualized
 * windowing only.
 */
import { useMemo } from "react";
import { useParams } from "react-router-dom";
import {
  adaptAgentDetailInput,
  adaptFleetInput,
  type BridgeSessionPayload,
} from "../tasks/bridge-adapter.ts";
import {
  buildAgentDetail,
  buildFleetList,
  type FleetListInput,
} from "./fleet-detail.ts";
import { AgentDetailScreen, FleetScreen } from "./FleetScreens.tsx";
import type { FleetAgent } from "./types.ts";
import {
  FIXTURE_NOW,
  fixtureAgents,
  fixtureAttempts,
  fixtureTasks,
  makeLargeFleet,
  PROJECT_ID,
} from "../tasks/fixtures.ts";
import type { Task, TaskAttempt } from "../tasks/types.ts";

function sessionFor(agent: FleetAgent): BridgeSessionPayload {
  return {
    externalId: agent.agentId,
    provider: agent.provider,
    state:
      agent.workerState === "busy"
        ? "running"
        : agent.workerState === "reporting" || agent.workerState === "assigned"
          ? "waiting"
          : agent.workerState === "available"
            ? "stopped"
            : agent.workerState === "quarantined"
              ? "failed"
              : "unknown",
    managed: true,
    taskId: agent.currentTaskId,
    worktreeId: agent.worktreeId,
    lastObservedAt: agent.lastObservedAt,
  };
}

function fleetInputFor(
  agents: FleetAgent[],
  tasks: Task[],
  attempts: TaskAttempt[],
  projectId?: string,
): FleetListInput {
  const filtered = projectId
    ? agents.filter((a) => a.currentProjectId === projectId)
    : agents;
  return adaptFleetInput({
    sessions: filtered.map(sessionFor),
    displayNameBySession: new Map(
      filtered.map((a) => [a.agentId, a.displayName]),
    ),
    projectByTaskId: new Map(tasks.map((t) => [t.id, PROJECT_ID])),
    tasks,
    attempts: attempts.filter((a) =>
      filtered.some((agent) => agent.agentId === a.agentId),
    ),
    now: FIXTURE_NOW,
  });
}

export function FleetRoute() {
  const vm = useMemo(() => {
    const roster = makeLargeFleet(200);
    // Synthetic task records so every busy roster agent keeps a working
    // task link (fixture task-graph tasks cover only the login flow).
    const rosterTasks: Task[] = roster
      .filter((a) => a.currentTaskId)
      .map((a) => ({
        id: a.currentTaskId as string,
        projectId: PROJECT_ID,
        title: `Fleet task for ${a.displayName}`,
        status: "running" as const,
        acceptance: [],
        dependsOn: [],
      }));
    return buildFleetList(
      fleetInputFor(roster, [...fixtureTasks(), ...rosterTasks], [], undefined),
    );
  }, []);
  return (
    <>
      <p role="note" className="ff-banner">
        Fixture data — UI integration only, not live runtime state. This
        200-agent roster demonstrates list virtualization, not 200
        concurrent workers.
      </p>
      <FleetScreen
        vm={vm}
        window={{ total: vm.rows.length, scrollOffset: 0, viewportSize: 20 }}
      />
    </>
  );
}

export function ProjectFleetRoute() {
  const { projectId } = useParams();
  const vm = useMemo(
    () =>
      buildFleetList(
        fleetInputFor(
          fixtureAgents(),
          fixtureTasks(),
          fixtureAttempts(),
          projectId,
        ),
      ),
    [projectId],
  );
  return (
    <>
      <p role="note" className="ff-banner">
        Fixture data — UI integration only, not live runtime state.
      </p>
      <FleetScreen vm={vm} />
    </>
  );
}

export function AgentDetailRoute() {
  const { agentId } = useParams();
  const vm = useMemo(() => {
    const agents = fixtureAgents();
    const agent =
      agents.find((a) => a.agentId === agentId) ??
      ({
        agentId: agentId ?? "unknown",
        displayName: "(agent record unavailable)",
        provider: "unknown",
        workerState: "disconnected",
        currentTaskId: null,
        currentProjectId: null,
        attemptIds: [],
        worktreeId: null,
        terminalId: null,
        lastObservedAt: null,
        cost: null,
      } satisfies FleetAgent);
    return buildAgentDetail(
      adaptAgentDetailInput({
        agent,
        attempts: fixtureAttempts().filter((a) => a.agentId === agent.agentId),
        tasks: fixtureTasks(),
        now: FIXTURE_NOW,
      }),
    );
  }, [agentId]);
  return (
    <>
      <p role="note" className="ff-banner">
        Fixture data — UI integration only, not live runtime state.
      </p>
      <AgentDetailScreen vm={vm} />
    </>
  );
}
