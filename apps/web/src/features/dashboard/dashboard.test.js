'use strict';

/**
 * FF-015 (E12) tests — run with `node --test <this file>`.
 * Covers acceptance "responsive fixtures and loading/error states" plus the
 * screen-state contract in docs/02-experience/screens-states-and-copy.md.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const f = require('./fixtures');
const d = require('./dashboard');

test('fixtures are deterministic across calls', () => {
  assert.deepEqual(f.workers20(), f.workers20());
  assert.deepEqual(f.inbox30(), f.inbox30());
  assert.deepEqual(f.prWith12Checks(), f.prWith12Checks());
  assert.equal(f.workers20().length, 20);
  assert.equal(f.workers200().length, 200);
  assert.equal(f.inbox30().length, 30);
  assert.equal(f.prWith12Checks().checks.length, 12);
});

test('every export is labelled fixture, never live', () => {
  for (const w of f.workers20()) assert.equal(w.dataSource, 'fixture');
  for (const i of f.inbox30()) assert.equal(i.dataSource, 'fixture');
  assert.equal(f.commandCenterHealthy.dataSource, 'fixture');
  assert.equal(f.commandCenterEmpty.dataSource, 'fixture');
  assert.equal(f.projectOverviewAtlas.dataSource, 'fixture');
});

test('resolveScreenState covers all seven required states', () => {
  const seen = new Set([
    d.resolveScreenState({ loading: true }).state,
    d.resolveScreenState({ data: { projects: [{}] } }).state,
    d.resolveScreenState({ data: { projects: [] } }).state,
    d.resolveScreenState({ error: 'boom', data: { projects: [{}] } }).state,
    d.resolveScreenState({ permissionDenied: true }).state,
    d.resolveScreenState({ offline: true }).state,
    d.resolveScreenState({ data: { projects: [{}], checkedAt: 't' }, stale: true }).state,
  ]);
  assert.deepEqual([...seen].sort(), [...d.SCREEN_STATES].sort());
});

test('screen copy matches the UX contract', () => {
  assert.equal(d.resolveScreenState({ data: { projects: [] } }).copy, d.EMPTY_COPY);
  assert.equal(
    d.resolveScreenState({ data: { projects: [] } }).copy,
    'No active projects. Start with a goal and a repository.'
  );
  assert.match(d.resolveScreenState({ offline: true }).copy, /read-only/);
  assert.equal(
    d.resolveScreenState({ permissionDenied: true }).copy,
    'You do not have access to this project.'
  );
});

test('unknown worker state is never coerced to working', () => {
  assert.equal(d.workerDisplayState({ state: 'unknown' }), 'unknown');
  assert.equal(d.workerDisplayState({ state: 'mystery' }), 'unknown');
  assert.equal(d.workerDisplayState({}), 'unknown');
  const summary = d.getCommandCenterSummary(f.commandCenterHealthy);
  // 20 workers round-robin over 5 states: 4 unknown, 8 active (running+waiting).
  assert.equal(summary.unknownWorkers, 4);
  assert.equal(summary.activeWorkers, 8);
});

test('command center summary aggregates fixture projects', () => {
  const summary = d.getCommandCenterSummary(f.commandCenterHealthy);
  assert.equal(summary.dataSource, 'fixture');
  assert.equal(summary.projectCount, 2);
  assert.equal(summary.verifiedCompleted, 5);
  assert.equal(summary.readyTasks, 8);
  assert.equal(summary.failingChecks, 1);
  assert.equal(summary.sleepMode, false);
  assert.equal(
    d.getCommandCenterSummary(f.commandCenterThrottled).providerNotice,
    'Workers are waiting for provider capacity. Independent tasks will resume automatically within limits.'
  );
});

test('empty / offline / sleeping variants behave', () => {
  const empty = d.getCommandCenterSummary(f.commandCenterEmpty);
  assert.equal(empty.projectCount, 0);
  assert.equal(empty.verifiedCompleted, 0);
  assert.equal(
    d.resolveScreenState({ data: f.commandCenterEmpty }).state,
    'empty'
  );
  assert.equal(d.resolveScreenState({ offline: true }).state, 'offline');
  assert.equal(d.getCommandCenterSummary(f.commandCenterSleeping).sleepMode, true);
  assert.equal(d.getCommandCenterSummary(f.commandCenterOffline).offline, true);
});

test('project overview exposes counts, milestones and reconciliation time', () => {
  const overview = d.getProjectOverview(f.projectOverviewAtlas);
  assert.equal(overview.state, 'ready');
  assert.equal(overview.projectId, 'proj-atlas');
  assert.deepEqual(Object.keys(overview.counts).sort(), [
    'activeWorkers',
    'blockedDecisions',
    'failingChecks',
    'readyTasks',
    'verifiedCompleted',
  ]);
  assert.equal(overview.milestones.length, 3);
  assert.equal(overview.lastReconciledAt, f.CHECKED_AT);
  assert.equal(d.getProjectOverview({}).state, 'empty');
});

test('live data is refused loudly instead of misrendered', () => {
  assert.throws(() => d.getCommandCenterSummary({ dataSource: 'live' }), /not wired/);
  assert.throws(() => d.getProjectOverview({ dataSource: 'live' }), /not wired/);
});

test('responsive nav model covers all sign-off widths', () => {
  const models = new Map(d.SIGNOFF_WIDTHS.map((w) => [w, d.navModelForWidth(w)]));
  assert.deepEqual(models.get(360), { layout: 'compact', tabs: 'bottom', columns: 1 });
  assert.deepEqual(models.get(412), { layout: 'compact', tabs: 'bottom', columns: 1 });
  assert.deepEqual(models.get(768), { layout: 'standard', tabs: 'none', columns: 2 });
  assert.deepEqual(models.get(1280), { layout: 'wide', tabs: 'none', columns: 3 });
  assert.deepEqual(models.get(1440), { layout: 'wide', tabs: 'none', columns: 3 });
});
