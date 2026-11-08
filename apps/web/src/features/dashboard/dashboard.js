'use strict';

/**
 * FF-015 (E12) — pure Command Center / project-overview state logic.
 *
 * No DOM, no network, no Paperclip/Orca imports: every function is a pure
 * function over fixture-shaped input so it is unit-testable without a
 * browser. Callers must pass `dataSource: 'fixture'` through and render the
 * fixture badge; this module refuses to label fixture data as live.
 */

const SCREEN_STATES = Object.freeze([
  'loading',
  'ready',
  'empty',
  'recoverable-error',
  'permission-denied',
  'offline',
  'stale',
]);

const EMPTY_COPY = 'No active projects. Start with a goal and a repository.';
const OFFLINE_COPY = 'Offline. Showing last reconciled data; actions are read-only.';
const STALE_COPY = 'Data may be stale. Last reconciled at ';
const PERMISSION_COPY = 'You do not have access to this project.';
const UNKNOWN_LABEL = 'unknown';

// Order matters: permission > offline > error > loading > empty > stale > ready.
function resolveScreenState(input = {}) {
  const {
    loading = false,
    error = null,
    permissionDenied = false,
    offline = false,
    retryable = true,
    data = null,
    stale = false,
  } = input;

  if (permissionDenied) {
    return { state: 'permission-denied', copy: PERMISSION_COPY, retryable: false };
  }
  if (offline) {
    return { state: 'offline', copy: OFFLINE_COPY, retryable: true };
  }
  if (error) {
    if (!retryable) {
      return { state: 'recoverable-error', copy: String(error), retryable: false, escalation: true };
    }
    return { state: 'recoverable-error', copy: String(error), retryable: true };
  }
  if (loading) {
    return { state: 'loading', copy: 'Loading command center…', retryable: false };
  }
  const isEmpty =
    data === null ||
    data === undefined ||
    (Array.isArray(data) && data.length === 0) ||
    (Array.isArray(data?.projects) && data.projects.length === 0);
  if (isEmpty) {
    return { state: 'empty', copy: EMPTY_COPY, retryable: false };
  }
  if (stale) {
    const at = typeof data?.checkedAt === 'string' ? data.checkedAt : 'unknown time';
    return { state: 'stale', copy: `${STALE_COPY}${at}.`, retryable: true };
  }
  return { state: 'ready', copy: '', retryable: false };
}

function isLiveInput(input) {
  return input?.dataSource === 'live';
}

// Never infer liveness from dispatch: only an explicit reconciled `running`
// observation counts as active. `unknown` stays `unknown`.
function workerDisplayState(worker) {
  const state = worker?.state;
  if (state === 'running') return 'running';
  if (state === 'waiting') return 'waiting';
  if (state === 'stopped') return 'stopped';
  if (state === 'failed') return 'failed';
  return UNKNOWN_LABEL;
}

function getCommandCenterSummary(input = {}) {
  if (isLiveInput(input)) {
    throw new Error('dashboard: live dataSource is not wired in this fixture spike');
  }
  const projects = Array.isArray(input.projects) ? input.projects : [];
  const workers = Array.isArray(input.workers) ? input.workers : [];
  const inbox = Array.isArray(input.inbox) ? input.inbox : [];

  let verifiedCompleted = 0;
  let readyTasks = 0;
  let blockedDecisions = 0;
  let failingChecks = 0;
  for (const p of projects) {
    verifiedCompleted += Number(p.verifiedCompleted) || 0;
    readyTasks += Number(p.readyTasks) || 0;
    blockedDecisions += Number(p.blockedDecisions) || 0;
    failingChecks += Number(p.failingChecks) || 0;
  }
  // Inbox length is authoritative for blocked decisions when present.
  if (inbox.length > 0) blockedDecisions = inbox.length;

  let activeWorkers = 0;
  let unknownWorkers = 0;
  for (const w of workers) {
    const s = workerDisplayState(w);
    if (s === 'running' || s === 'waiting') activeWorkers += 1;
    if (s === UNKNOWN_LABEL) unknownWorkers += 1;
  }

  return {
    dataSource: 'fixture',
    projectCount: projects.length,
    verifiedCompleted,
    activeWorkers,
    unknownWorkers,
    readyTasks,
    blockedDecisions,
    failingChecks,
    budgetRemaining: projects.map((p) => ({
      projectId: p.projectId,
      remaining: p.budgetRemaining,
    })),
    sleepMode: Boolean(input.sleepMode),
    providerNotice: input.providerNotice || null,
    offline: Boolean(input.offline),
  };
}

function getProjectOverview(input = {}) {
  if (isLiveInput(input)) {
    throw new Error('dashboard: live dataSource is not wired in this fixture spike');
  }
  const { project = null, milestones = [], alerts = [], coordinatorCard = null } = input;
  if (!project) {
    return { dataSource: 'fixture', state: 'empty', copy: EMPTY_COPY };
  }
  return {
    dataSource: 'fixture',
    state: 'ready',
    projectId: project.projectId,
    name: project.name,
    repository: project.repository,
    counts: {
      verifiedCompleted: project.verifiedCompleted,
      activeWorkers: project.activeWorkers,
      readyTasks: project.readyTasks,
      blockedDecisions: project.blockedDecisions,
      failingChecks: project.failingChecks,
    },
    milestones,
    alerts,
    coordinatorCard,
    lastReconciledAt: project.lastReconciledAt || null,
  };
}

// Responsive nav model per docs/02-experience/*: desktop header + 3-column
// command center; narrow screens use compact title + bottom tabs.
function navModelForWidth(widthPx) {
  const w = Number(widthPx);
  if (!Number.isFinite(w) || w < 0) return { layout: 'compact', tabs: 'bottom', columns: 1 };
  if (w < 768) return { layout: 'compact', tabs: 'bottom', columns: 1 };
  if (w < 1280) return { layout: 'standard', tabs: 'none', columns: 2 };
  return { layout: 'wide', tabs: 'none', columns: 3 };
}

const SIGNOFF_WIDTHS = Object.freeze([360, 412, 768, 1280, 1440]);

module.exports = {
  SCREEN_STATES,
  EMPTY_COPY,
  OFFLINE_COPY,
  STALE_COPY,
  PERMISSION_COPY,
  UNKNOWN_LABEL,
  SIGNOFF_WIDTHS,
  resolveScreenState,
  workerDisplayState,
  getCommandCenterSummary,
  getProjectOverview,
  navModelForWidth,
};
