// FF-015 (E12) — dashboard shared types.
//
// Every user-visible status carries a DataSource so mock status can never be
// mistaken for runtime truth: `fixture` (deterministic preview), `unknown`
// (unreachable or unproven — never rendered as healthy/stopped/failed), or
// `live` (a successful control-plane check this session).

export type DataSource = "fixture" | "unknown" | "live";

export type ScreenState =
  | "loading"
  | "ready"
  | "empty"
  | "recoverable-error"
  | "permission-denied"
  | "offline"
  | "stale";

export interface ProjectSummary {
  projectId: string;
  name: string;
  repository: string;
  status: string;
  verifiedCompleted: number;
  activeWorkers: number;
  readyTasks: number;
  blockedDecisions: number;
  failingChecks: number;
  budgetRemaining: number;
  lastReconciledAt: string;
  dataSource: DataSource;
}

export interface WorkerSummary {
  agentId: string;
  taskId: string;
  projectId: string;
  provider: string;
  /** Raw runtime state; `unknown` must be preserved, never coerced. */
  state: string;
  lastHeartbeat: string;
  dataSource: DataSource;
}

export interface DecisionSummary {
  decisionId: string;
  reason: string;
  blockedTasks: string[];
  risk: string;
  lastUpdated: string;
  sourceAgent: string;
  dataSource: DataSource;
}

export interface Milestone {
  id: string;
  title: string;
  state: string;
}

export interface Alert {
  severity: "blocking" | "info";
  text: string;
}
