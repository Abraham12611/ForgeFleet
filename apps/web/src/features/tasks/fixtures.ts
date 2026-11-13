/**
 * E13 — Tasks/fleet UX (FF-016): deterministic fixtures for task/fleet
 * detail screens.
 *
 * The project DAG mirrors `examples/task-graph.example.json` (login flow:
 * auth-api, auth-ui, auth-e2e with a dependency on both). Attempts,
 * agents, PRs, messages, and timeline entries are invented fixture data
 * shaped like the contracts — they are explicitly NOT real Paperclip/Orca
 * output and must never be presented as integration evidence.
 *
 * `makeLargeFleet(200)` gives UI sign-off a deterministic 200-agent
 * roster for virtualization checks (design-direction sign-off fixtures).
 * A mulberry32 PRNG with a fixed seed keeps every run identical.
 */

import type {
  AgentRef,
  PullRequestRef,
  Task,
  TaskAttempt,
  TaskMessageRef,
  TimelineEntry,
} from "./types.ts";
import type { FleetAgent } from "../fleet/types.ts";

export const FIXTURE_NOW = Date.parse("2026-11-08T12:05:00Z");
export const PROJECT_ID = "project_login_flow";

export function fixtureTasks(): Task[] {
  return [
    {
      id: "task_auth_api",
      projectId: PROJECT_ID,
      title: "Implement backend auth",
      status: "verifying",
      acceptance: ["Unit tests pass", "API contract documented"],
      dependsOn: [],
      paperclipTaskId: "paperclip_task_auth_api",
    },
    {
      id: "task_auth_ui",
      projectId: PROJECT_ID,
      title: "Build login UI",
      status: "running",
      acceptance: ["Accessible mobile form", "Mock contract tests pass"],
      dependsOn: [],
      paperclipTaskId: "paperclip_task_auth_ui",
    },
    {
      id: "task_auth_e2e",
      projectId: PROJECT_ID,
      title: "Integrate login end-to-end",
      status: "ready",
      acceptance: ["E2E pass against disposable service"],
      dependsOn: ["task_auth_api", "task_auth_ui"],
      paperclipTaskId: "paperclip_task_auth_e2e",
    },
  ];
}

export function fixtureAgents(): FleetAgent[] {
  return [
    {
      agentId: "agent_muse_01",
      displayName: "Muse worker 01",
      provider: "muse",
      workerState: "busy",
      currentTaskId: "task_auth_ui",
      currentProjectId: PROJECT_ID,
      attemptIds: ["attempt_auth_ui_g1", "attempt_auth_api_g2"],
      worktreeId: "worktree_login_ui",
      terminalId: "orca_terminal_aaa",
      lastObservedAt: "2026-11-08T12:04:58Z",
      cost: {
        inputTokens: 12000,
        outputTokens: 3400,
        billedUsd: 0.42,
        source: "measured",
        sourceNote: "provider invoice",
      },
    },
    {
      agentId: "agent_muse_02",
      displayName: "Muse worker 02",
      provider: "muse",
      workerState: "reporting",
      currentTaskId: null,
      currentProjectId: null,
      attemptIds: ["attempt_auth_api_g1"],
      worktreeId: null,
      terminalId: "orca_terminal_bbb",
      lastObservedAt: "2026-11-08T12:03:10Z",
      cost: {
        inputTokens: 8000,
        outputTokens: 1200,
        billedUsd: null,
        source: "estimated",
        sourceNote: "token-price heuristic",
      },
    },
  ];
}

export function fixtureAgentRefs(): Map<string, AgentRef> {
  return new Map(
    fixtureAgents().map((a) => [
      a.agentId,
      {
        agentId: a.agentId,
        displayName: a.displayName,
        provider: a.provider,
        workerState: a.workerState,
      },
    ]),
  );
}

export function fixtureAttempts(): TaskAttempt[] {
  return [
    {
      // First generation for auth-api: runtime finished but the task is
      // still verifying — finished means runtime ended, NOT code accepted.
      attemptId: "attempt_auth_api_g1",
      taskId: "task_auth_api",
      projectId: PROJECT_ID,
      generation: 1,
      fencingEpoch: 1,
      state: "finished",
      provider: "muse",
      workerKind: "muse",
      agentId: "agent_muse_02",
      paperclipRunId: "run_auth_api_1",
      orcaRunId: "orca_run_111",
      orcaDispatchId: "orca_dispatch_111",
      orcaSessionId: "orca_session_111",
      worktreeId: "worktree_login_api",
      startedAt: "2026-11-08T11:55:00Z",
      lastHeartbeatAt: "2026-11-08T12:01:00Z",
      completedAt: "2026-11-08T12:01:30Z",
    },
    {
      // Fenced retry (generation 2) now verifying on another agent.
      attemptId: "attempt_auth_api_g2",
      taskId: "task_auth_api",
      projectId: PROJECT_ID,
      generation: 2,
      fencingEpoch: 2,
      state: "running",
      provider: "muse",
      workerKind: "muse",
      agentId: "agent_muse_01",
      paperclipRunId: "run_auth_api_2",
      orcaRunId: "orca_run_112",
      orcaDispatchId: "orca_dispatch_112",
      orcaSessionId: "orca_session_112",
      worktreeId: "worktree_login_api",
      startedAt: "2026-11-08T12:02:00Z",
      lastHeartbeatAt: "2026-11-08T12:04:58Z",
    },
    {
      attemptId: "attempt_auth_ui_g1",
      taskId: "task_auth_ui",
      projectId: PROJECT_ID,
      generation: 1,
      fencingEpoch: 1,
      state: "running",
      provider: "muse",
      workerKind: "muse",
      agentId: "agent_muse_01",
      paperclipRunId: "run_auth_ui_1",
      orcaRunId: "orca_run_121",
      orcaDispatchId: "orca_dispatch_121",
      orcaSessionId: "orca_session_121",
      worktreeId: "worktree_login_ui",
      startedAt: "2026-11-08T12:00:00Z",
      lastHeartbeatAt: "2026-11-08T12:04:58Z",
    },
  ];
}

export function fixtureTimeline(): TimelineEntry[] {
  return [
    {
      source: "orca-bridge",
      eventId: "evt-001",
      eventType: "attempt.started",
      occurredAt: "2026-11-08T12:00:00Z",
      attemptId: "attempt_auth_ui_g1",
      summary: "Muse worker 01 started login UI attempt",
    },
    {
      // Duplicate delivery of evt-001: dedupe must collapse it.
      source: "orca-bridge",
      eventId: "evt-001",
      eventType: "attempt.started",
      occurredAt: "2026-11-08T12:00:00Z",
      attemptId: "attempt_auth_ui_g1",
      summary: "Muse worker 01 started login UI attempt",
    },
    {
      source: "orca-bridge",
      eventId: "evt-002",
      eventType: "attempt.heartbeat",
      occurredAt: "2026-11-08T12:04:58Z",
      attemptId: "attempt_auth_ui_g1",
      summary: "Heartbeat from login UI attempt",
    },
  ];
}

export function fixturePullRequests(): PullRequestRef[] {
  return [
    {
      repo: "example/login-demo",
      prNumber: 42,
      headSha: "abc1234def5678",
      statusSummary: "checks failing",
    },
  ];
}

export function fixtureMessages(): TaskMessageRef[] {
  return [
    {
      messageId: "msg-001",
      threadId: "thread_auth_ui",
      authorKind: "worker",
      attemptId: "attempt_auth_ui_g1",
      bodyPreview: "Unexpected API discrepancy in auth response shape…",
      occurredAt: "2026-11-08T12:03:00Z",
    },
  ];
}

/** Deterministic PRNG so the large fleet is identical on every run. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LARGE_FLEET_STATES = [
  "available",
  "assigned",
  "starting",
  "busy",
  "reporting",
  "disconnected",
] as const;

/** 200-agent deterministic roster for virtualization sign-off. */
export function makeLargeFleet(count = 200): FleetAgent[] {
  const rand = mulberry32(0xF1E37);
  const agents: FleetAgent[] = [];
  for (let i = 0; i < count; i += 1) {
    const workerState = LARGE_FLEET_STATES[Math.floor(rand() * LARGE_FLEET_STATES.length)]!;
    const busy = workerState === "busy" || workerState === "reporting";
    const secondsAgo = Math.floor(rand() * 120);
    agents.push({
      agentId: `agent_fleet_${String(i).padStart(3, "0")}`,
      displayName: `Fleet worker ${i}`,
      provider: i % 5 === 4 ? "devin" : "muse",
      workerState,
      currentTaskId: busy ? `task_fleet_${i}` : null,
      currentProjectId: busy ? PROJECT_ID : null,
      attemptIds: busy ? [`attempt_fleet_${i}_g1`] : [],
      worktreeId: busy ? `worktree_fleet_${i}` : null,
      terminalId: `orca_terminal_fleet_${i}`,
      lastObservedAt: new Date(FIXTURE_NOW - secondsAgo * 1000).toISOString(),
      cost: null,
    });
  }
  return agents;
}
