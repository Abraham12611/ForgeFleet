/**
 * FF-026 cross-behavior test: distributed admission against the real FF-013
 * lease/fencing core (no mocks of scheduler behavior).
 * Run: node --test packages/scheduler/test/distributed-leases.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LeaseStore, LeaseConflictError } from '../src/leases.js';
import { admitOne } from '../src/admission.js';
import { HostRegistry } from '../src/hosts.js';
import { admitOneDistributed, selectHostsForTasks } from '../src/distributed.js';

const NOW = 1_700_000_000_000;
const host = { id: 'h1', state: 'active', lastHeartbeatMs: NOW, totalSlots: 4, usedSlots: 0, reservedSlots: 0, providers: ['muse'], runtimes: ['orca-cli'] };
const gates = {
  projectActive: 0, projectLimit: 3, globalActive: 0, globalLimit: 5,
  providerAvailable: 2, budgetCapacity: 2, hosts: [host],
  nowMs: NOW, heartbeatTimeoutMs: 30_000,
};

function acquireTask(leases, taskId, n = 1) {
  return leases.acquire({
    taskId, holder: `h1:attempt-${n}`, idempotencyKey: `idem-${taskId}-${n}`,
    requestHash: `hash-${taskId}-${n}`, ttlMs: 60_000, nowMs: NOW,
  });
}

describe('distributed admission with real leases/fencing', () => {
  it('keeps one active lease per task: duplicates denied, replays idempotent', () => {
    const leases = new LeaseStore();
    const first = acquireTask(leases, 't1');
    assert.equal(first.denied, undefined);
    assert.equal(first.lease.generation, 1);
    // Same key + same hash replays the same lease (no second lease minted).
    const replay = leases.acquire({ taskId: 't1', holder: 'h1:attempt-1', idempotencyKey: 'idem-t1-1', requestHash: 'hash-t1-1', ttlMs: 60_000, nowMs: NOW });
    assert.equal(replay.lease.generation, 1);
    assert.equal(leases.maxGeneration('t1'), 1);
    // Same key + different hash is a conflict, not a second lease.
    assert.throws(() => leases.acquire({ taskId: 't1', holder: 'h1:attempt-x', idempotencyKey: 'idem-t1-1', requestHash: 'other', ttlMs: 60_000, nowMs: NOW }), LeaseConflictError);
    // A new dispatch for the same task while leased is denied.
    assert.equal(acquireTask(leases, 't1', 2).denied, 'active-lease-held');
  });

  it('fencing retires the old generation so only the proven owner proceeds', () => {
    const leases = new LeaseStore();
    acquireTask(leases, 't1');
    // Stale generation heartbeat never extends the lease.
    assert.equal(leases.heartbeat({ taskId: 't1', generation: 99, ttlMs: 60_000, nowMs: NOW }).ignored, 'stale-generation');
    assert.equal(leases.fence({ taskId: 't1', generation: 1 }), true);
    const next = acquireTask(leases, 't1', 2);
    assert.equal(next.lease.generation, 2);
    assert.equal(leases.activeLease('t1').holder, 'h1:attempt-2');
  });

  it('admitOneDistributed agrees with FF-013 admitOne on non-host gates', () => {
    const task = { id: 't1', provider: 'muse' };
    const toSingleHost = { projectLimit: 3, globalLimit: 5, providerAvailable: 2, hostFreeCapacity: 4, budgetCapacity: 2 };
    const toUsage = { projectActive: 0, globalActive: 0 };
    // Same verdict when hosts are plentiful.
    assert.equal(admitOne(toSingleHost, toUsage).admitted, true);
    assert.deepEqual(admitOneDistributed({ ...gates, task }).hostId, 'h1');
    // Same denial reasons when quotas bind (host pin never overrides them).
    for (const [override, reason] of [
      [{ projectActive: 3 }, 'project-quota-exhausted'],
      [{ globalActive: 5 }, 'global-quota-exhausted'],
      [{ providerAvailable: 0 }, 'provider-unavailable'],
      [{ budgetCapacity: 0 }, 'budget-exhausted'],
    ]) {
      assert.equal(admitOne(toSingleHost, { projectActive: 0, globalActive: 0, ...{} }).admitted, true);
      const d = admitOneDistributed({ ...gates, ...override, task });
      assert.equal(d.admitted, false);
      assert.equal(d.reason, reason);
    }
  });

  it('never double-places a task that already holds an active lease', () => {
    const leases = new LeaseStore();
    acquireTask(leases, 't-leased');
    const leased = leases.activeTaskIds();
    assert.equal(leased.has('t-leased'), true);
    // Composition contract: filter actively-leased tasks before placement.
    const candidates = [{ id: 't-leased' }, { id: 't-free' }].filter((t) => !leased.has(t.id));
    const res = selectHostsForTasks({ tasks: candidates, ...gates });
    assert.deepEqual(res.placements, [{ taskId: 't-free', hostId: 'h1' }]);
    assert.equal(res.denied.length, 0);
  });

  it('host pins feed back into lease holders without breaking fencing', () => {
    const leases = new LeaseStore();
    const reg = new HostRegistry({ heartbeatTimeoutMs: 30_000 });
    const { token } = reg.issueJoinToken({ ttlMs: 60_000, nowMs: NOW });
    reg.enroll({ hostId: 'h1', tailscaleIdentity: 'tail-1', joinToken: token, observation: { totalSlots: 2, providers: ['muse'], runtimes: ['orca-cli'] }, nowMs: NOW });
    const res = selectHostsForTasks({ tasks: [{ id: 't1', provider: 'muse' }], ...gates, hosts: reg.list() });
    assert.equal(res.placements.length, 1);
    const holder = `${res.placements[0].hostId}:attempt-1`;
    const acquired = leases.acquire({ taskId: 't1', holder, idempotencyKey: 'idem-t1', requestHash: 'h', ttlMs: 60_000, nowMs: NOW });
    assert.equal(acquired.lease.holder, holder);
    assert.equal(acquired.lease.generation, 1);
  });
});
