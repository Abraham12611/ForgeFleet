// FF-015 (E12) — pure Command Center / project-overview state logic.
//
// No DOM, no network, no backend imports: every function is pure over its
// inputs so it is unit-testable without a browser. Accepted screen/state
// model ported from the FF-015 fixture spike; copy matches
// docs/02-experience/screens-states-and-copy.md.
import type {
  Alert,
  DataSource,
  DecisionSummary,
  Milestone,
  ProjectSummary,
  ScreenState,
  WorkerSummary,
} from "./types";

export const SCREEN_STATES: readonly ScreenState[] = [
  "loading",
  "ready",
  "empty",
  "recoverable-error",
  "permission-denied",
  "offline",
  "stale",
];

export const EMPTY_COPY =
  "No active projects. Start with a goal and a repository.";
export const OFFLINE_COPY =
  "Offline. Showing last reconciled data; actions are read-only.";
export const STALE_COPY = "Data may be stale. Last reconciled at ";
export const PERMISSION_COPY = "You do not have access to this project.";
export const UNKNOWN_LABEL = "unknown";

/** Sign-off viewport widths from docs/02-experience/design-direction.md. */
export const SIGNOFF_WIDTHS: readonly number[] = [360, 412, 768, 1280, 1440];

export interface ScreenInput {
  loading?: boolean;
  error?: string | null;
  permissionDenied?: boolean;
  offline?: boolean;
  retryable?: boolean;
  stale?: boolean;
  empty?: boolean;
  checkedAt?: string;
}

export interface ScreenResolution {
  state: ScreenState;
  copy: string;
  retryable: boolean;
  escalation?: boolean;
}

// Precedence: permission > offline > error > loading > empty > stale > ready.
export function resolveScreenState(input: ScreenInput = {}): ScreenResolution {
  const {
    loading = false,
    error = null,
    permissionDenied = false,
    offline = false,
    retryable = true,
    stale = false,
    empty = false,
    checkedAt = "unknown time",
  } = input;

  if (permissionDenied) {
    return { state: "permission-denied", copy: PERMISSION_COPY, retryable: false };
  }
  if (offline) {
    return { state: "offline", copy: OFFLINE_COPY, retryable: true };
  }
  if (error) {
    if (!retryable) {
      return {
        state: "recoverable-error",
        copy: error,
        retryable: false,
        escalation: true,
      };
    }
    return { state: "recoverable-error", copy: error, retryable: true };
  }
  if (loading) {
    return { state: "loading", copy: "Loading command center…", retryable: false };
  }
  if (empty) {
    return { state: "empty", copy: EMPTY_COPY, retryable: false };
  }
  if (stale) {
    return {
      state: "stale",
      copy: `${STALE_COPY}${checkedAt}.`,
      retryable: true,
    };
  }
  return { state: "ready", copy: "", retryable: false };
}

// Never infer liveness from dispatch: only an explicit reconciled `running`
// observation counts as active. `unknown` stays `unknown`.
export function workerDisplayState(state: string | undefined): string {
  if (
    state === "running" ||
    state === "waiting" ||
    state === "stopped" ||
    state === "failed"
  ) {
    return state;
  }
  return UNKNOWN_LABEL;
}

export interface CommandCenterInput {
  dataSource: DataSource;
  projects: ProjectSummary[];
  workers: WorkerSummary[];
  inbox: DecisionSummary[];
  sleepMode?: boolean;
  providerNotice?: string | null;
  offline?: boolean;
  checkedAt?: string;
}

export interface CommandCenterSummary {
  dataSource: DataSource;
  projectCount: number;
  verifiedCompleted: number;
  activeWorkers: number;
  unknownWorkers: number;
  readyTasks: number;
  blockedDecisions: number;
  failingChecks: number;
  budgetRemaining: { projectId: string; remaining: number }[];
  sleepMode: boolean;
  providerNotice: string | null;
  offline: boolean;
}

export function getCommandCenterSummary(
  input: CommandCenterInput,
): CommandCenterSummary {
  if (input.dataSource === "live") {
    // Live project-level endpoints are not bound yet (E05/E08); the hook
    // layer only upgrades connection-level state to `live`. Refuse rather
    // than render an unbound shape as live.
    throw new Error(
      "dashboard: live project summary is not bound to a control-plane endpoint yet",
    );
  }
  let verifiedCompleted = 0;
  let readyTasks = 0;
  let blockedDecisions = 0;
  let failingChecks = 0;
  for (const p of input.projects) {
    verifiedCompleted += p.verifiedCompleted || 0;
    readyTasks += p.readyTasks || 0;
    blockedDecisions += p.blockedDecisions || 0;
    failingChecks += p.failingChecks || 0;
  }
  if (input.inbox.length > 0) blockedDecisions = input.inbox.length;

  let activeWorkers = 0;
  let unknownWorkers = 0;
  for (const w of input.workers) {
    const s = workerDisplayState(w.state);
    if (s === "running" || s === "waiting") activeWorkers += 1;
    if (s === UNKNOWN_LABEL) unknownWorkers += 1;
  }

  return {
    dataSource: input.dataSource,
    projectCount: input.projects.length,
    verifiedCompleted,
    activeWorkers,
    unknownWorkers,
    readyTasks,
    blockedDecisions,
    failingChecks,
    budgetRemaining: input.projects.map((p) => ({
      projectId: p.projectId,
      remaining: p.budgetRemaining,
    })),
    sleepMode: Boolean(input.sleepMode),
    providerNotice: input.providerNotice ?? null,
    offline: Boolean(input.offline),
  };
}

export interface ProjectOverviewInput {
  dataSource: DataSource;
  project: ProjectSummary | null;
  milestones?: Milestone[];
  alerts?: Alert[];
  coordinatorCard?: {
    runId: string;
    planRevision: number;
    readiness: string;
  } | null;
}

export function getProjectOverview(input: ProjectOverviewInput): {
  dataSource: DataSource;
  state: ScreenState;
  copy?: string;
  projectId?: string;
  name?: string;
  repository?: string;
  counts?: {
    verifiedCompleted: number;
    activeWorkers: number;
    readyTasks: number;
    blockedDecisions: number;
    failingChecks: number;
  };
  milestones?: Milestone[];
  alerts?: Alert[];
  lastReconciledAt?: string | null;
} {
  if (input.dataSource === "live") {
    throw new Error(
      "dashboard: live project overview is not bound to a control-plane endpoint yet",
    );
  }
  if (!input.project) {
    return { dataSource: input.dataSource, state: "empty", copy: EMPTY_COPY };
  }
  const p = input.project;
  return {
    dataSource: input.dataSource,
    state: "ready",
    projectId: p.projectId,
    name: p.name,
    repository: p.repository,
    counts: {
      verifiedCompleted: p.verifiedCompleted,
      activeWorkers: p.activeWorkers,
      readyTasks: p.readyTasks,
      blockedDecisions: p.blockedDecisions,
      failingChecks: p.failingChecks,
    },
    milestones: input.milestones ?? [],
    alerts: input.alerts ?? [],
    lastReconciledAt: p.lastReconciledAt ?? null,
  };
}

// Responsive nav model per docs/02-experience/*: desktop header + multi-column
// command center; narrow screens use compact title + bottom tabs.
export function navModelForWidth(widthPx: number): {
  layout: "compact" | "standard" | "wide";
  tabs: "bottom" | "none";
  columns: number;
} {
  if (!Number.isFinite(widthPx) || widthPx < 0) {
    return { layout: "compact", tabs: "bottom", columns: 1 };
  }
  if (widthPx < 768) return { layout: "compact", tabs: "bottom", columns: 1 };
  if (widthPx < 1280) return { layout: "standard", tabs: "none", columns: 2 };
  return { layout: "wide", tabs: "none", columns: 3 };
}

// Honest-source binding for the control-plane hook. Pure so the policy is
// testable: `live` requires a successful check this session; anything else
// resolves to fixture (explicit preview) or unknown/offline/stale.
export interface SourceProbe {
  fixtureMode: boolean;
  online: boolean;
  healthOk: boolean;
  fetchFailed: boolean;
  hadPriorData: boolean;
}

export function resolveSource(probe: SourceProbe): {
  source: DataSource;
  screen: ScreenResolution;
  checkedAt: string | null;
} {
  if (probe.fixtureMode) {
    return {
      source: "fixture",
      screen: { state: "ready", copy: "", retryable: false },
      checkedAt: null,
    };
  }
  if (!probe.online) {
    return {
      source: "unknown",
      screen: resolveScreenState({ offline: true }),
      checkedAt: null,
    };
  }
  if (probe.healthOk) {
    return {
      source: "live",
      screen: { state: "ready", copy: "", retryable: false },
      checkedAt: new Date().toISOString(),
    };
  }
  if (probe.fetchFailed && probe.hadPriorData) {
    return {
      source: "unknown",
      screen: resolveScreenState({ stale: true }),
      checkedAt: null,
    };
  }
  if (probe.fetchFailed) {
    return {
      source: "unknown",
      screen: resolveScreenState({
        error: "Control plane unreachable. Retry is safe; no side effects.",
      }),
      checkedAt: null,
    };
  }
  return {
    source: "unknown",
    screen: resolveScreenState({ loading: true }),
    checkedAt: null,
  };
}
