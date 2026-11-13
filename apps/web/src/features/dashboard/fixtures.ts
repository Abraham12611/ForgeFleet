// FF-015 (E12) — deterministic dashboard fixtures for the React composition.
//
// Same fixture policy as the spike: no clock, no randomness, every payload
// labelled `fixture`. Used for design review, responsive checks, and the
// owner-run screenshot states (empty / offline / sleeping).
import type {
  DecisionSummary,
  ProjectSummary,
  WorkerSummary,
} from "./types";

export const CHECKED_AT = "2026-11-08T12:00:00.000Z";

const STATES = ["running", "waiting", "stopped", "failed", "unknown"];

export function makeWorker(i: number): WorkerSummary {
  return {
    agentId: `fixture-agent-${String(i).padStart(3, "0")}`,
    taskId: `fixture-task-${String((i % 8) + 1).padStart(3, "0")}`,
    projectId: i % 2 === 0 ? "proj-atlas" : "proj-beacon",
    provider: i % 5 === 3 ? "devin" : "muse",
    // Round-robin keeps every state present in the 20-worker set.
    state: STATES[i % STATES.length],
    lastHeartbeat: CHECKED_AT,
    dataSource: "fixture",
  };
}

export function makeInboxItem(i: number): DecisionSummary {
  return {
    decisionId: `fixture-decision-${String(i).padStart(3, "0")}`,
    reason: `Fixture question ${i}: worker needs an owner-only answer`,
    blockedTasks: [`fixture-task-${String((i % 8) + 1).padStart(3, "0")}`],
    risk: i % 4 === 0 ? "safety-critical" : "routine",
    lastUpdated: CHECKED_AT,
    sourceAgent: `fixture-agent-${String((i % 20) + 1).padStart(3, "0")}`,
    dataSource: "fixture",
  };
}

export const projectsFixture: ProjectSummary[] = [
  {
    projectId: "proj-atlas",
    name: "Atlas sample repo",
    repository: "example/atlas",
    status: "running",
    verifiedCompleted: 4,
    activeWorkers: 6,
    readyTasks: 3,
    blockedDecisions: 2,
    failingChecks: 1,
    budgetRemaining: 62.5,
    lastReconciledAt: CHECKED_AT,
    dataSource: "fixture",
  },
  {
    projectId: "proj-beacon",
    name: "Beacon sample repo",
    repository: "example/beacon",
    status: "running",
    verifiedCompleted: 1,
    activeWorkers: 2,
    readyTasks: 5,
    blockedDecisions: 0,
    failingChecks: 0,
    budgetRemaining: 90.0,
    lastReconciledAt: CHECKED_AT,
    dataSource: "fixture",
  },
];

export function workers20(): WorkerSummary[] {
  return Array.from({ length: 20 }, (_, i) => makeWorker(i + 1));
}

export function inbox4(): DecisionSummary[] {
  return Array.from({ length: 4 }, (_, i) => makeInboxItem(i + 1));
}

export type FixtureVariant =
  | "healthy"
  | "empty"
  | "offline"
  | "throttled"
  | "sleeping"
  | "denied";

export const FIXTURE_VARIANTS: readonly FixtureVariant[] = [
  "healthy",
  "empty",
  "offline",
  "throttled",
  "sleeping",
  "denied",
];

export interface FixtureCommandCenter {
  projects: ProjectSummary[];
  workers: WorkerSummary[];
  inbox: DecisionSummary[];
  sleepMode: boolean;
  providerNotice: string | null;
  offline: boolean;
  permissionDenied: boolean;
}

export function fixtureCommandCenter(
  variant: FixtureVariant,
): FixtureCommandCenter {
  const base: FixtureCommandCenter = {
    projects: projectsFixture,
    workers: workers20(),
    inbox: inbox4(),
    sleepMode: false,
    providerNotice: null,
    offline: false,
    permissionDenied: false,
  };
  switch (variant) {
    case "empty":
      return { ...base, projects: [], workers: [], inbox: [] };
    case "offline":
      return { ...base, offline: true };
    case "throttled":
      return {
        ...base,
        providerNotice:
          "Workers are waiting for provider capacity. Independent tasks will resume automatically within limits.",
      };
    case "sleeping":
      return { ...base, sleepMode: true };
    case "denied":
      return { ...base, permissionDenied: true };
    default:
      return base;
  }
}

export function findFixtureProject(projectId: string): ProjectSummary | null {
  return projectsFixture.find((p) => p.projectId === projectId) ?? null;
}
