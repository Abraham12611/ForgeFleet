import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eligibleActive, admitOne } from '../src/admission.js';
import { afterFailure, afterUnknown, isRetryDue } from '../src/retry.js';
import { admitBatch, orderReadyQueue } from '../src/scheduler.js';
import { reconcile } from '../src/recovery.js';
import { LeaseStore } from '../src/leases.js';

const limits = {
  projectLimit: 3,
  globalLimit: 5,
  providerAvailable: 5,
  hostFreeCapacity: 5,
  budgetCapacity: 5,
};

describe('admission quotas (FF-013: quota respected)', () => {
  it('computes eligible_active as the min of every gate', () => {
    const { eligibleActive: n } = eligibleActive(
      limits,
      { projectActive: 1, globalActive: 4 },
      10,
    );
    assert.equal(n, 1); // globalLimit 5 - globalActive 4
  });

  it('denies per project, global, provider, host, and budget exhaustion', () => {
    assert.deepEqual(admitOne(limits, { projectActive: 3, globalActive: 0 }).reason, 'project-quota-exhausted');
    assert.deepEqual(admitOne(limits, { projectActive: 0, globalActive: 5 }).reason, 'global-quota-exhausted');
    assert.deepEqual(
      admitOne({ ...limits, providerAvailable: 0 }, { projectActive: 0, globalActive: 0 }).reason,
      'provider-unavailable',
    );
    assert.deepEqual(
      admitOne({ ...limits, hostFreeCapacity: 0 }, { projectActive: 0, globalActive: 0 }).reason,
      'host-capacity-exhausted',
    );
    assert.deepEqual(
      admitOne({ ...limits, budgetCapacity: 0 }, { projectActive: 0, globalActive: 0 }).reason,
      'budget-exhausted',
    );
    assert.deepEqual(admitOne(limits, { projectActive: 0, globalActive: 0 }), { admitted: true });
  });
});

describe('retry policy', () => {
  it('backs off exponentially then exhausts the budget', () => {
    const first = afterFailure({ failedAttempts: 0, nowMs: 1000 });
    assert.equal(first.action, 'retry_wait');
    assert.equal(first.delayMs, 30_000);
    const second = afterFailure({ failedAttempts: 1, nowMs: 1000 });
    assert.equal(second.delayMs, 60_000);
    const exhausted = afterFailure({ failedAttempts: 3, nowMs: 1000 });
    assert.deepEqual(exhausted, { action: 'failed', reason: 'retry-budget-exhausted' });
  });

  it('caps the delay at maxDelayMs', () => {
    const late = afterFailure(
      { failedAttempts: 9, nowMs: 0 },
      { maxAttempts: 99, baseDelayMs: 30_000, maxDelayMs: 600_000 },
    );
    assert.equal(late.action, 'retry_wait');
    assert.equal(late.delayMs, 600_000);
  });

  it('never immediately retries unknown', () => {
    assert.deepEqual(afterUnknown(), { action: 'hold-unknown', reason: 'reconcile-before-retry' });
  });

  it('detects due retries', () => {
    assert.equal(isRetryDue(1000, 1000), true);
    assert.equal(isRetryDue(1001, 1000), false);
  });
});

describe('admitBatch end-to-end (no double-active + quota)', () => {
  function harness(taskIds, projectLimit = 3) {
    const store = new LeaseStore();
    const tasks = taskIds.map((id, i) => ({ id, projectId: 'p1', status: 'ready', priority: taskIds.length - i }));
    const statusById = new Map(tasks.map((t) => [t.id, t.status]));
    let n = 0;
    return {
      store,
      run: (extra = {}) =>
        admitBatch({
          tasks,
          statusById,
          activeLeasedTaskIds: store.activeTaskIds(),
          projectOf: () => 'p1',
          projectLimits: new Map([['p1', projectLimit]]),
          defaultProjectLimit: projectLimit,
          sharedLimits: { ...limits, projectLimit, globalLimit: 5 },
          sharedActive: store.activeCount(),
          projectActive: new Map([['p1', store.activeCount(() => 'p1', 'p1')]]),
          acquire: (task) =>
            store.acquire({
              taskId: task.id,
              holder: `attempt-${task.id}`,
              idempotencyKey: `key-${task.id}-${n++}`,
              requestHash: 'h',
              ttlMs: 60_000,
            }),
          ...extra,
        }),
    };
  }

  it('admits each task once even when listed twice', () => {
    const h = harness(['t1', 't1', 't2']);
    const { admitted, denied } = h.run();
    assert.deepEqual(admitted.map((a) => a.taskId).sort(), ['t1', 't2']);
    assert.ok(denied.some((d) => d.taskId === 't1' && d.reason === 'active-lease-held'));
  });

  it('stops at the project quota and reports the reason', () => {
    const h = harness(['t1', 't2', 't3', 't4'], 2);
    const { admitted, denied } = h.run();
    assert.equal(admitted.length, 2);
    assert.equal(denied.length, 2);
    assert.ok(denied.every((d) => d.reason === 'project-quota-exhausted'));
  });

  it('respects priority order deterministically', () => {
    const ordered = orderReadyQueue([
      { id: 'low', projectId: 'p1', status: 'ready', priority: 1 },
      { id: 'high', projectId: 'p1', status: 'ready', priority: 9 },
    ]);
    assert.deepEqual(ordered.map((t) => t.id), ['high', 'low']);
  });
});

describe('recovery reconciliation', () => {
  it('keeps running, releases terminal, holds unknown, reports orphans', () => {
    const result = reconcile({
      leasedTasks: [
        { taskId: 'a', generation: 1 },
        { taskId: 'b', generation: 2 },
        { taskId: 'c', generation: 1 },
        { taskId: 'd', generation: 1 },
      ],
      runtimeByTaskId: new Map([
        ['a', { state: 'running' }],
        ['b', { state: 'finished' }],
        ['c', { state: 'mystery' }],
      ]),
      runtimeOrphans: [{ externalId: 'orca-orphan-1' }],
    });
    assert.deepEqual(result.keep, ['a']);
    assert.deepEqual(result.releaseTerminal, [{ taskId: 'b', state: 'finished' }]);
    assert.deepEqual(result.holdUnknown.map((h) => h.taskId).sort(), ['c', 'd']);
    assert.deepEqual(result.orphans, [{ externalId: 'orca-orphan-1' }]);
  });
});
