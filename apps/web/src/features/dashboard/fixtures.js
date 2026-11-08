'use strict';

/**
 * FF-015 (E12) — deterministic dashboard fixtures.
 *
 * Fixture-only spike: E01 (Paperclip upstream) and E05 (frozen contracts) are
 * not satisfied, so every export here is labelled `dataSource: 'fixture'`.
 * Nothing in this file represents live Orca/Paperclip/GitHub state.
 *
 * Rules:
 * - No Date.now(), no Math.random(): identical output on every run.
 * - `unknown` worker/session state is preserved, never coerced to
 *   working/stopped/failed (see docs/02-experience/screens-states-and-copy.md
 *   and docs/05-contracts/state-machines.md invariants).
 * - Copy strings match docs/02-experience/screens-states-and-copy.md.
 */

const FIXTURE_SOURCE = 'fixture';
const CHECKED_AT = '2026-11-08T12:00:00.000Z';

function worker(i, overrides = {}) {
  const states = ['running', 'waiting', 'stopped', 'failed', 'unknown'];
  return {
    agentId: `fixture-agent-${String(i).padStart(3, '0')}`,
    taskId: `fixture-task-${String((i % 8) + 1).padStart(3, '0')}`,
    projectId: i % 2 === 0 ? 'proj-atlas' : 'proj-beacon',
    provider: i % 5 === 3 ? 'devin' : 'muse',
    // Round-robin keeps every state present in the 20-worker set.
    state: states[i % states.length],
    lastHeartbeat: CHECKED_AT,
    dataSource: FIXTURE_SOURCE,
    ...overrides,
  };
}

function inboxItem(i, overrides = {}) {
  return {
    decisionId: `fixture-decision-${String(i).padStart(3, '0')}`,
    reason: `Fixture question ${i}: worker needs an owner-only answer`,
    blockedTasks: [`fixture-task-${String((i % 8) + 1).padStart(3, '0')}`],
    choices: ['approve', 'reject', 'delegate'],
    risk: i % 4 === 0 ? 'safety-critical' : 'routine',
    defaultOnTimeout: 'no-action',
    lastUpdated: CHECKED_AT,
    sourceAgent: `fixture-agent-${String((i % 20) + 1).padStart(3, '0')}`,
    urgency: i % 3 === 0 ? 'needs-me' : 'fyi',
    dataSource: FIXTURE_SOURCE,
    ...overrides,
  };
}

function check(i, overrides = {}) {
  const conclusions = ['success', 'failure', 'pending'];
  return {
    name: `check-${String(i).padStart(2, '0')}`,
    conclusion: conclusions[i % conclusions.length],
    headSha: 'fixture-head-sha-0001',
    dataSource: FIXTURE_SOURCE,
    ...overrides,
  };
}

const projectsFixture = [
  {
    projectId: 'proj-atlas',
    name: 'Atlas sample repo',
    repository: 'example/atlas',
    status: 'running',
    verifiedCompleted: 4,
    activeWorkers: 6,
    readyTasks: 3,
    blockedDecisions: 2,
    failingChecks: 1,
    budgetRemaining: 62.5,
    lastReconciledAt: CHECKED_AT,
    dataSource: FIXTURE_SOURCE,
  },
  {
    projectId: 'proj-beacon',
    name: 'Beacon sample repo',
    repository: 'example/beacon',
    status: 'running',
    verifiedCompleted: 1,
    activeWorkers: 2,
    readyTasks: 5,
    blockedDecisions: 0,
    failingChecks: 0,
    budgetRemaining: 90.0,
    lastReconciledAt: CHECKED_AT,
    dataSource: FIXTURE_SOURCE,
  },
];

function workers20() {
  return Array.from({ length: 20 }, (_, i) => worker(i + 1));
}

function workers200() {
  return Array.from({ length: 200 }, (_, i) => worker(i + 1));
}

function inbox30() {
  return Array.from({ length: 30 }, (_, i) => inboxItem(i + 1));
}

function prWith12Checks() {
  return {
    prId: 'fixture-pr-001',
    projectId: 'proj-atlas',
    headSha: 'fixture-head-sha-0001',
    checks: Array.from({ length: 12 }, (_, i) => check(i + 1)),
    reviewVerdict: 'changes-requested',
    policyOutcome: 'blocked: 1 failing check, owner approval required for main',
    dataSource: FIXTURE_SOURCE,
  };
}

const commandCenterHealthy = {
  dataSource: FIXTURE_SOURCE,
  checkedAt: CHECKED_AT,
  projects: projectsFixture,
  workers: workers20(),
  inbox: inbox30().slice(0, 4),
  throughput: { verifiedLast24h: 5, dispatchedLast24h: 9 },
  cost: { currency: 'USD', spentPeriod: 12.4, budgetCeiling: 100, estimated: true },
  sleepMode: false,
  runtime: { reachable: true, lastSuccessfulCheck: CHECKED_AT },
};

const commandCenterEmpty = {
  dataSource: FIXTURE_SOURCE,
  checkedAt: CHECKED_AT,
  projects: [],
  workers: [],
  inbox: [],
  throughput: { verifiedLast24h: 0, dispatchedLast24h: 0 },
  cost: { currency: 'USD', spentPeriod: 0, budgetCeiling: 100, estimated: true },
  sleepMode: false,
  runtime: { reachable: true, lastSuccessfulCheck: CHECKED_AT },
};

const commandCenterOffline = {
  ...commandCenterHealthy,
  dataSource: FIXTURE_SOURCE,
  offline: true,
  runtime: { reachable: false, lastSuccessfulCheck: '2026-11-08T11:42:00.000Z' },
};

const commandCenterThrottled = {
  ...commandCenterHealthy,
  dataSource: FIXTURE_SOURCE,
  providerNotice:
    'Workers are waiting for provider capacity. Independent tasks will resume automatically within limits.',
};

const commandCenterSleeping = {
  ...commandCenterHealthy,
  dataSource: FIXTURE_SOURCE,
  sleepMode: true,
};

const projectOverviewAtlas = {
  dataSource: FIXTURE_SOURCE,
  project: projectsFixture[0],
  milestones: [
    { id: 'ms-1', title: 'Login API (fixture)', state: 'verified' },
    { id: 'ms-2', title: 'Login UI (fixture)', state: 'running' },
    { id: 'ms-3', title: 'Login E2E (fixture)', state: 'ready' },
  ],
  alerts: [
    { severity: 'blocking', text: '1 failing check on fixture-pr-001 (fixture)' },
    { severity: 'info', text: '2 decisions need the owner (fixture)' },
  ],
  coordinatorCard: {
    runId: 'fixture-run-001',
    planRevision: 1,
    readiness: '2 of 5 ready tasks dispatchable within fixture limits',
    dataSource: FIXTURE_SOURCE,
  },
};

module.exports = {
  FIXTURE_SOURCE,
  CHECKED_AT,
  worker,
  inboxItem,
  check,
  projectsFixture,
  workers20,
  workers200,
  inbox30,
  prWith12Checks,
  commandCenterHealthy,
  commandCenterEmpty,
  commandCenterOffline,
  commandCenterThrottled,
  commandCenterSleeping,
  projectOverviewAtlas,
};
