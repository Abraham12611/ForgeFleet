import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateDag, unsatisfiedGatingDeps } from '../src/dag.js';
import { evaluateReadiness } from '../src/readiness.js';

describe('validateDag', () => {
  it('accepts an acyclic graph', () => {
    const result = validateDag([
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: [{ taskId: 'a', type: 'blocks' }] },
    ]);
    assert.equal(result.ok, true);
  });

  it('rejects gating cycles', () => {
    const result = validateDag([
      { id: 'a', dependsOn: [{ taskId: 'b', type: 'blocks' }] },
      { id: 'b', dependsOn: [{ taskId: 'a', type: 'requires_contract' }] },
    ]);
    assert.equal(result.ok, false);
    assert.match(result.error, /cycle/);
    assert.ok(result.cycle);
  });

  it('rejects self-dependencies', () => {
    const result = validateDag([{ id: 'a', dependsOn: [{ taskId: 'a', type: 'blocks' }] }]);
    assert.equal(result.ok, false);
  });

  it('rejects unknown dependency targets', () => {
    const result = validateDag([{ id: 'a', dependsOn: [{ taskId: 'ghost', type: 'blocks' }] }]);
    assert.equal(result.ok, false);
    assert.match(result.error, /unknown-dependency/);
  });

  it('ignores informational edges for cycle detection', () => {
    const result = validateDag([
      { id: 'a', dependsOn: [{ taskId: 'b', type: 'informational' }] },
      { id: 'b', dependsOn: [{ taskId: 'a', type: 'informational' }] },
    ]);
    assert.equal(result.ok, true);
  });
});

describe('readiness predicate', () => {
  const base = { id: 't1', projectId: 'p1', status: 'ready' };

  it('is ready when every gate passes', () => {
    const { ready, reasons } = evaluateReadiness(
      { ...base, dependsOn: [{ taskId: 'dep', type: 'blocks' }] },
      { statusById: new Map([['dep', 'verified']]) },
    );
    assert.equal(ready, true);
    assert.deepEqual(reasons, []);
  });

  it('treats informational deps as non-gating', () => {
    const { ready } = evaluateReadiness(
      { ...base, dependsOn: [{ taskId: 'dep', type: 'informational' }] },
      { statusById: new Map([['dep', 'running']]) },
    );
    assert.equal(ready, true);
  });

  it('blocks on unsatisfied gating deps', () => {
    const { ready, reasons } = evaluateReadiness(
      { ...base, dependsOn: [{ taskId: 'dep', type: 'integration_after' }] },
      { statusById: new Map([['dep', 'running']]) },
    );
    assert.equal(ready, false);
    assert.ok(reasons.some((r) => r.startsWith('unsatisfied-deps:dep')));
  });

  it('blocks when an active lease is held (no double-active)', () => {
    const { ready, reasons } = evaluateReadiness(base, { activeLeasedTaskIds: new Set(['t1']) });
    assert.equal(ready, false);
    assert.ok(reasons.includes('active-lease-held'));
  });

  it('names every denial reason from the orchestration predicate', () => {
    const { ready, reasons } = evaluateReadiness({
      ...base,
      projectPaused: true,
      ownerDecisionBlocked: true,
      policyAllowed: false,
      runtimeOnline: false,
      worktreeAvailable: false,
      budgetAvailable: false,
    });
    assert.equal(ready, false);
    for (const expected of [
      'project-paused',
      'owner-decision-blocked',
      'policy-denied',
      'runtime-offline',
      'worktree-unavailable',
      'budget-exhausted',
    ]) {
      assert.ok(reasons.includes(expected), `missing ${expected}`);
    }
  });

  it('holds unknown and terminal statuses without dispatching', () => {
    assert.deepEqual(evaluateReadiness({ ...base, status: 'unknown' }).reasons, ['attempt-unknown']);
    assert.deepEqual(evaluateReadiness({ ...base, status: 'failed' }).reasons, ['terminal-status:failed']);
    const pending = evaluateReadiness({ ...base, status: 'retry_wait', retryNotBeforeMs: Date.now() + 60_000 });
    assert.ok(pending.reasons.includes('retry-backoff-pending'));
  });

  it('reports unsatisfied deps via helper', () => {
    assert.deepEqual(
      unsatisfiedGatingDeps(
        { dependsOn: [{ taskId: 'x', type: 'blocks' }] },
        new Map([['x', 'submitted']]),
      ),
      ['x'],
    );
  });
});
