/**
 * Tests for `@forgefleet/coordinator` (FF-012).
 *
 * Acceptance under test: cycles rejected, goals trace to tasks
 * (`docs/04-flows/goal-to-worker.md` subflow A, FR-04).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  proposePlan,
  approvePlan,
  revisePlan,
  getReadyTasks,
  topoOrder,
  findCycle,
} from '../src/index.js';

const goal = {
  id: 'goal-1',
  acceptance: [
    { id: 'c1', text: 'Three workers run in isolated worktrees.' },
    { id: 'c2', text: 'Peer question is routed and answered.' },
  ],
};

const task = (id, extra = {}) => ({
  id,
  title: `Task ${id}`,
  acceptance: [`Done when ${id} is verifiably complete.`],
  goalId: goal.id,
  covers: [],
  ...extra,
});

const baseTasks = () => [
  task('t1', { covers: ['c1'] }),
  task('t2', { covers: ['c1'], owns: 'branch/feature-a' }),
  task('t3', { covers: ['c2'] }),
];

const codes = (result) => result.errors.map((error) => error.code);

describe('proposePlan: valid DAG', () => {
  it('accepts a three-task DAG with a nontrivial dependency and traces the goal', () => {
    const result = proposePlan({
      projectId: 'proj-1',
      goal,
      tasks: baseTasks(),
      edges: [
        { from: 't1', to: 't3', kind: 'blocks' },
        { from: 't2', to: 't3', kind: 'requires_contract' },
      ],
    });
    assert.equal(result.ok, true);
    const { revision } = result;
    assert.equal(revision.status, 'proposed');
    assert.equal(revision.goalId, goal.id);
    assert.deepEqual(revision.trace, { c1: ['t1', 't2'], c2: ['t3'] });
    assert.deepEqual(revision.order, ['t1', 't2', 't3']);
    assert.match(revision.hash, /^[0-9a-f]{64}$/);
    assert.ok(Object.isFrozen(revision));
  });

  it('is order-independent: same content in any order yields the same hash', () => {
    const first = proposePlan({ projectId: 'p', goal, tasks: baseTasks(), edges: [] });
    const reversed = proposePlan({
      projectId: 'p',
      goal,
      tasks: [...baseTasks()].reverse(),
      edges: [],
    });
    assert.ok(first.ok && reversed.ok);
    assert.equal(first.revision.hash, reversed.revision.hash);
  });
});

describe('proposePlan: cycle rejection', () => {
  it('rejects a direct two-node cycle with the cycle path', () => {
    const result = proposePlan({
      projectId: 'p',
      goal,
      tasks: baseTasks(),
      edges: [
        { from: 't1', to: 't2', kind: 'blocks' },
        { from: 't2', to: 't1', kind: 'blocks' },
      ],
    });
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes('CYCLE'));
    const cycle = result.errors.find((error) => error.code === 'CYCLE');
    assert.deepEqual(cycle.details.cycle, ['t1', 't2', 't1']);
  });

  it('rejects an indirect three-node cycle across mixed gating kinds', () => {
    const result = proposePlan({
      projectId: 'p',
      goal,
      tasks: baseTasks(),
      edges: [
        { from: 't1', to: 't2', kind: 'blocks' },
        { from: 't2', to: 't3', kind: 'integration_after' },
        { from: 't3', to: 't1', kind: 'requires_contract' },
      ],
    });
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes('CYCLE'));
  });

  it('rejects a self-loop without reporting it as a cycle', () => {
    const result = proposePlan({
      projectId: 'p',
      goal,
      tasks: baseTasks(),
      edges: [{ from: 't1', to: 't1', kind: 'blocks' }],
    });
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes('SELF_LOOP'));
    assert.ok(!codes(result).includes('CYCLE'));
  });

  it('ignores informational edges for cycles and readiness', () => {
    const result = proposePlan({
      projectId: 'p',
      goal,
      tasks: baseTasks(),
      edges: [
        { from: 't1', to: 't2', kind: 'blocks' },
        { from: 't2', to: 't1', kind: 'informational' },
      ],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(getReadyTasks(result.revision, []), ['t1', 't3']);
  });

  it('exposes findCycle/topoOrder primitives for the scheduler', () => {
    assert.deepEqual(findCycle(new Set(['a']), []), null);
    assert.deepEqual(topoOrder(new Set(['b', 'a']), []), ['a', 'b']);
    assert.equal(topoOrder(new Set(['a', 'b']), [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }]), null);
  });
});

describe('proposePlan: structural validation', () => {
  it('rejects an empty plan', () => {
    const result = proposePlan({ projectId: 'p', goal, tasks: [], edges: [] });
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes('EMPTY_PLAN'));
  });

  it('rejects duplicate task ids', () => {
    const result = proposePlan({ projectId: 'p', goal, tasks: [task('t1'), task('t1')], edges: [] });
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes('DUPLICATE_TASK'));
  });

  it('rejects duplicate ownership of the same work item', () => {
    const result = proposePlan({
      projectId: 'p',
      goal,
      tasks: [task('t1', { owns: 'branch/x' }), task('t2', { owns: 'branch/x' })],
      edges: [],
    });
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes('DUPLICATE_OWNERSHIP'));
  });

  it('rejects edges to unknown tasks and unknown edge kinds', () => {
    const missing = proposePlan({
      projectId: 'p',
      goal,
      tasks: baseTasks(),
      edges: [{ from: 't1', to: 'ghost', kind: 'blocks' }],
    });
    assert.equal(missing.ok, false);
    assert.ok(codes(missing).includes('UNKNOWN_TASK'));

    const kind = proposePlan({
      projectId: 'p',
      goal,
      tasks: baseTasks(),
      edges: [{ from: 't1', to: 't2', kind: 'after_lunch' }],
    });
    assert.equal(kind.ok, false);
    assert.ok(codes(kind).includes('INVALID_EDGE_KIND'));
  });

  it('rejects tasks without acceptance evidence and oversized plans', () => {
    const bare = proposePlan({ projectId: 'p', goal, tasks: [task('t1', { acceptance: [] })], edges: [] });
    assert.equal(bare.ok, false);
    assert.ok(codes(bare).includes('MISSING_ACCEPTANCE'));

    const many = Array.from({ length: 51 }, (_, index) => task(`t${index}`, { covers: ['c1'] }));
    const big = proposePlan({ projectId: 'p', goal, tasks: many, edges: [] });
    assert.equal(big.ok, false);
    assert.ok(codes(big).includes('BOUND_EXCEEDED'));
  });
});

describe('proposePlan: goal traceability', () => {
  it('rejects tasks that do not trace to the goal', () => {
    const result = proposePlan({
      projectId: 'p',
      goal,
      tasks: [...baseTasks(), task('rogue', { goalId: 'other-goal', covers: ['c1'] })],
      edges: [],
    });
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes('UNTRACEABLE_TASK'));
  });

  it('rejects coverage of unknown criteria', () => {
    const result = proposePlan({
      projectId: 'p',
      goal,
      tasks: [task('t1', { covers: ['nope'] })],
      edges: [],
    });
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes('UNKNOWN_CRITERION'));
  });

  it('rejects a plan that leaves a goal criterion uncovered', () => {
    const result = proposePlan({
      projectId: 'p',
      goal,
      tasks: [task('t1', { covers: ['c1'] })],
      edges: [],
    });
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes('UNCOVERED_CRITERION'));
  });
});

describe('approvePlan / revisePlan', () => {
  const proposed = () =>
    proposePlan({
      projectId: 'p',
      goal,
      tasks: baseTasks(),
      edges: [{ from: 't1', to: 't3', kind: 'blocks' }],
    }).revision;

  it('approves a proposed revision and freezes the stamp', () => {
    const result = approvePlan(proposed(), { by: 'owner:alice', projectId: 'p' });
    assert.equal(result.ok, true);
    assert.equal(result.revision.status, 'approved');
    assert.equal(result.revision.approvedBy, 'owner:alice');
    assert.ok(Object.isFrozen(result.revision));
  });

  it('refuses approval for the wrong project, unnamed approver, or tampered content', () => {
    assert.ok(codes(approvePlan(proposed(), { by: 'owner:alice', projectId: 'other' })).includes('PROJECT_MISMATCH'));
    assert.ok(!approvePlan(proposed(), { projectId: 'p' }).ok);
    const tampered = { ...proposed(), hash: '0'.repeat(64) };
    const result = approvePlan(tampered, { by: 'owner:alice', projectId: 'p' });
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes('STALE_REVISION'));
  });

  it('revises into the next frozen revision and blocks goal swaps', () => {
    const base = proposed();
    const next = revisePlan(base, {
      goal,
      tasks: [...baseTasks(), task('t4', { covers: ['c2'] })],
      edges: [{ from: 't1', to: 't3', kind: 'blocks' }],
    });
    assert.equal(next.ok, true);
    assert.equal(next.revision.revision, 2);
    assert.equal(next.revision.supersedes, base.hash);
    assert.notEqual(next.revision.hash, base.hash);

    const otherGoal = { id: 'other', acceptance: goal.acceptance };
    const swap = revisePlan(base, {
      goal: otherGoal,
      tasks: baseTasks().map((entry) => ({ ...entry, goalId: otherGoal.id })),
      edges: [],
    });
    assert.equal(swap.ok, false);
    assert.ok(codes(swap).includes('STALE_REVISION'));
  });
});

describe('getReadyTasks (scheduler advice)', () => {
  it('gates dependents until predecessors complete, in dispatch order', () => {
    const { revision } = proposePlan({
      projectId: 'p',
      goal,
      tasks: baseTasks(),
      edges: [
        { from: 't1', to: 't3', kind: 'blocks' },
        { from: 't2', to: 't3', kind: 'integration_after' },
      ],
    });
    assert.deepEqual(getReadyTasks(revision, []), ['t1', 't2']);
    assert.deepEqual(getReadyTasks(revision, ['t1']), ['t2']);
    assert.deepEqual(getReadyTasks(revision, ['t1', 't2']), ['t3']);
    assert.deepEqual(getReadyTasks(revision, ['t1', 't2', 't3']), []);
  });
});
