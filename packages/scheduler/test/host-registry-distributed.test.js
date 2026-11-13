/**
 * FF-026 unit tests: host registry + distributed admission.
 * Pure policy/state coverage per docs/06-delivery/quality-and-test-plan.md.
 * Run: node --test packages/scheduler/test/
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HostRegistry, hostFreeCapacity, hostFits } from '../src/hosts.js';
import {
  aggregateHostCapacity,
  eligibleActiveDistributed,
  selectHost,
  admitOneDistributed,
  selectHostsForTasks,
} from '../src/distributed.js';

const NOW = 1_700_000_000_000;
const OBS = (over = {}) => ({
  totalSlots: 4, usedSlots: 1, reservedSlots: 0,
  providers: ['muse'], runtimes: ['orca-cli'], activeLeases: 0, ...over,
});

function registryWithHosts(hostDefs, nowMs = NOW) {
  const reg = new HostRegistry({ heartbeatTimeoutMs: 30_000 });
  for (const [id, obs] of hostDefs) {
    const { token } = reg.issueJoinToken({ ttlMs: 60_000, nowMs });
    const res = reg.enroll({ hostId: id, tailscaleIdentity: `tail-${id}`, joinToken: token, observation: obs, nowMs });
    assert.equal(res.denied, undefined, `enroll ${id}: ${res.denied}`);
  }
  return reg;
}

describe('enrollment', () => {
  it('enrolls with a valid single-use token and records identity', () => {
    const reg = new HostRegistry();
    const { token } = reg.issueJoinToken({ ttlMs: 60_000, nowMs: NOW });
    const res = reg.enroll({ hostId: 'h1', tailscaleIdentity: 'tail-1', joinToken: token, observation: OBS(), nowMs: NOW });
    assert.equal(res.denied, undefined);
    assert.equal(res.host.tailscaleIdentity, 'tail-1');
    assert.equal(res.host.state, 'active');
  });

  it('rejects unknown, expired, and exhausted tokens without side effects', () => {
    const reg = new HostRegistry();
    assert.equal(reg.enroll({ hostId: 'a', tailscaleIdentity: 't', joinToken: 'nope', nowMs: NOW }).denied, 'unknown-join-token');
    const { token } = reg.issueJoinToken({ ttlMs: 1_000, nowMs: NOW });
    assert.equal(reg.enroll({ hostId: 'a', tailscaleIdentity: 't', joinToken: token, nowMs: NOW + 2_000 }).denied, 'join-token-expired');
    const { token: t2 } = reg.issueJoinToken({ ttlMs: 60_000, maxUses: 1, nowMs: NOW });
    assert.equal(reg.enroll({ hostId: 'a', tailscaleIdentity: 't', joinToken: t2, observation: OBS(), nowMs: NOW }).denied, undefined);
    assert.equal(reg.enroll({ hostId: 'b', tailscaleIdentity: 't', joinToken: t2, observation: OBS(), nowMs: NOW }).denied, 'join-token-exhausted');
    assert.equal(reg.get('b'), undefined);
  });

  it('rejects duplicate host ids and missing args', () => {
    const reg = registryWithHosts([['h1', OBS()]]);
    const { token } = reg.issueJoinToken({ ttlMs: 60_000, nowMs: NOW });
    assert.equal(reg.enroll({ hostId: 'h1', tailscaleIdentity: 't', joinToken: token, nowMs: NOW }).denied, 'duplicate-host-id');
    assert.equal(reg.enroll({ joinToken: token, nowMs: NOW }).denied, 'invalid-enroll-args');
  });
});

describe('heartbeat and freshness', () => {
  it('updates capacity on heartbeat and revives stale hosts', () => {
    const reg = registryWithHosts([['h1', OBS()]]);
    reg.refreshStates(NOW + 60_000);
    assert.equal(reg.get('h1').state, 'stale');
    const res = reg.heartbeat('h1', OBS({ usedSlots: 3 }), NOW + 61_000);
    assert.equal(res.denied, undefined);
    assert.equal(res.host.state, 'active');
    assert.equal(res.host.usedSlots, 3);
  });

  it('rejects heartbeats for unknown and retired hosts', () => {
    const reg = registryWithHosts([['h1', OBS()]]);
    assert.equal(reg.heartbeat('ghost', OBS(), NOW).denied, 'unknown-host');
    assert.equal(reg.deregister('h1', { nowMs: NOW }).denied, undefined);
    assert.equal(reg.heartbeat('h1', OBS(), NOW).denied, 'host-retired');
  });

  it('marks hosts stale only after the timeout', () => {
    const reg = registryWithHosts([['h1', OBS()]]);
    assert.deepEqual(reg.refreshStates(NOW + 29_999).transitioned, []);
    assert.deepEqual(reg.refreshStates(NOW + 30_001).transitioned, ['h1']);
  });
});

describe('free capacity', () => {
  it('subtracts used and reserved slots', () => {
    assert.deepEqual(
      hostFreeCapacity({ state: 'active', lastHeartbeatMs: NOW, totalSlots: 8, usedSlots: 3, reservedSlots: 2 }, NOW, 30_000),
      { free: 3, reason: 'ok' });
  });

  it('reports zero with reasons for drained, retired, stale, pressured, and full hosts', () => {
    const base = { state: 'active', lastHeartbeatMs: NOW, totalSlots: 4, usedSlots: 0, reservedSlots: 0 };
    assert.equal(hostFreeCapacity({ ...base, state: 'draining' }, NOW, 30_000).reason, 'host-draining');
    assert.equal(hostFreeCapacity({ ...base, state: 'retired' }, NOW, 30_000).reason, 'host-retired');
    assert.equal(hostFreeCapacity({ ...base, lastHeartbeatMs: NOW - 60_000 }, NOW, 30_000).reason, 'host-stale');
    assert.equal(hostFreeCapacity({ ...base, diskFull: true }, NOW, 30_000).reason, 'host-disk-full');
    assert.equal(hostFreeCapacity({ ...base, memCritical: true }, NOW, 30_000).reason, 'host-memory-critical');
    assert.equal(hostFreeCapacity({ ...base, usedSlots: 4 }, NOW, 30_000).reason, 'host-capacity-exhausted');
  });

  it('hostFits enforces provider/runtime support and slot estimates', () => {
    const host = { id: 'h', state: 'active', lastHeartbeatMs: NOW, totalSlots: 2, usedSlots: 0, reservedSlots: 0, providers: ['muse'], runtimes: ['orca-cli'] };
    assert.equal(hostFits(host, { estimatedSlots: 1, provider: 'muse', runtime: 'orca-cli', nowMs: NOW }).fits, true);
    assert.equal(hostFits(host, { estimatedSlots: 3, nowMs: NOW }).reason, 'host-capacity-exhausted');
    assert.equal(hostFits(host, { provider: 'devin', nowMs: NOW }).reason, 'no-host-supports-provider');
    assert.equal(hostFits(host, { runtime: 'other', nowMs: NOW }).reason, 'no-host-supports-runtime');
  });
});

describe('safe deregistration', () => {
  it('refuses to remove a host with active leases unless forced with proof', () => {
    const reg = registryWithHosts([['h1', OBS({ activeLeases: 2 })]]);
    assert.equal(reg.deregister('h1', { nowMs: NOW }).denied, 'host-has-active-leases');
    assert.equal(reg.deregister('h1', { force: true, nowMs: NOW }).denied, 'host-has-active-leases');
    const res = reg.deregister('h1', { force: true, fenceProof: 'fenced-gen-9', nowMs: NOW });
    assert.equal(res.denied, undefined);
    assert.equal(res.host.state, 'retired');
  });

  it('retains retired records for audit and rejects double retirement', () => {
    const reg = registryWithHosts([['h1', OBS()]]);
    reg.deregister('h1', { nowMs: NOW });
    assert.equal(reg.get('h1').state, 'retired');
    assert.equal(reg.deregister('h1', { nowMs: NOW }).denied, 'host-retired');
    assert.equal(reg.list().length, 1);
  });
});

describe('distributed admission', () => {
  it('sums free capacity across eligible hosts only', () => {
    const reg = registryWithHosts([
      ['h1', OBS({ totalSlots: 4, usedSlots: 1 })], // free 3
      ['h2', OBS({ totalSlots: 2, usedSlots: 2 })], // full -> 0
    ]);
    reg.setDraining('h2');
    const { token } = reg.issueJoinToken({ ttlMs: 60_000, nowMs: NOW });
    reg.enroll({ hostId: 'h3', tailscaleIdentity: 't3', joinToken: token, observation: OBS({ totalSlots: 5, usedSlots: 0 }), nowMs: NOW - 120_000 });
    const { totalFree, perHost } = aggregateHostCapacity(reg.list(), NOW, 30_000);
    assert.equal(totalFree, 3);
    assert.deepEqual(Object.fromEntries(perHost.map((h) => [h.hostId, h.reason])),
      { h1: 'ok', h2: 'host-draining', h3: 'host-stale' });
  });

  it('eligibleActiveDistributed takes the min over every gate including hosts', () => {
    const hosts = [
      { id: 'h1', state: 'active', lastHeartbeatMs: NOW, totalSlots: 10, usedSlots: 0, reservedSlots: 0, providers: [], runtimes: [] },
    ];
    const base = { readyCount: 9, projectRemaining: 8, globalRemaining: 7, providerAvailable: 6, budgetRemaining: 5, hosts, nowMs: NOW, heartbeatTimeoutMs: 30_000 };
    assert.equal(eligibleActiveDistributed(base).eligibleActive, 5);
    assert.equal(eligibleActiveDistributed({ ...base, readyCount: 2 }).eligibleActive, 2);
    assert.equal(eligibleActiveDistributed({ ...base, hosts: [] }).eligibleActive, 0);
  });

  it('selectHost prefers most free capacity with lexical tie-break', () => {
    const mk = (id, used) => ({ id, state: 'active', lastHeartbeatMs: NOW, totalSlots: 4, usedSlots: used, reservedSlots: 0, providers: ['muse'], runtimes: ['orca-cli'] });
    assert.equal(selectHost([mk('hb', 1), mk('ha', 1)], {}, { nowMs: NOW }).hostId, 'ha');
    assert.equal(selectHost([mk('h1', 3), mk('h2', 0)], { provider: 'muse' }, { nowMs: NOW }).hostId, 'h2');
    assert.equal(selectHost([mk('h1', 0)], { provider: 'devin' }, { nowMs: NOW }).reason, 'no-host-supports-provider');
    assert.equal(selectHost([], {}, { nowMs: NOW }).reason, 'no-registered-hosts');
  });

  it('admitOneDistributed checks quotas first, then pins a host', () => {
    const hosts = [{ id: 'h1', state: 'active', lastHeartbeatMs: NOW, totalSlots: 4, usedSlots: 0, reservedSlots: 0, providers: ['muse'], runtimes: ['orca-cli'] }];
    const base = { projectActive: 0, projectLimit: 3, globalActive: 0, globalLimit: 5, providerAvailable: 2, budgetCapacity: 2, hosts, nowMs: NOW, heartbeatTimeoutMs: 30_000, task: { id: 't', provider: 'muse' } };
    const ok = admitOneDistributed(base);
    assert.deepEqual(ok, { admitted: true, reason: 'ok', hostId: 'h1' });
    assert.equal(admitOneDistributed({ ...base, projectActive: 3 }).reason, 'project-quota-exhausted');
    assert.equal(admitOneDistributed({ ...base, globalActive: 5 }).reason, 'global-quota-exhausted');
    assert.equal(admitOneDistributed({ ...base, providerAvailable: 0 }).reason, 'provider-unavailable');
    assert.equal(admitOneDistributed({ ...base, budgetCapacity: 0 }).reason, 'budget-exhausted');
    assert.equal(admitOneDistributed({ ...base, hosts: [] }).reason, 'no-registered-hosts');
  });

  it('selectHostsForTasks spreads work deterministically and respects quotas', () => {
    const mk = (id, total) => ({ id, state: 'active', lastHeartbeatMs: NOW, totalSlots: total, usedSlots: 0, reservedSlots: 0, providers: ['muse'], runtimes: ['orca-cli'] });
    const tasks = [
      { id: 't-low', priority: 0 }, { id: 't-high', priority: 10 }, { id: 't-mid', priority: 5 },
    ];
    const gates = { projectActive: 0, projectLimit: 10, globalActive: 0, globalLimit: 10, providerAvailable: 10, budgetCapacity: 10, nowMs: NOW, heartbeatTimeoutMs: 30_000 };
    const first = selectHostsForTasks({ tasks, hosts: [mk('ha', 2), mk('hb', 2)], ...gates });
    assert.equal(first.denied.length, 0);
    assert.deepEqual(first.placements.map((p) => p.taskId), ['t-high', 't-mid', 't-low']);
    // Deterministic: same input -> same placement.
    const second = selectHostsForTasks({ tasks, hosts: [mk('ha', 2), mk('hb', 2)], ...gates });
    assert.deepEqual(second, first);
    // Quotas bind: only one more dispatch allowed globally.
    const capped = selectHostsForTasks({ tasks, hosts: [mk('ha', 4)], ...gates, globalActive: 9, globalLimit: 10 });
    assert.equal(capped.placements.length, 1);
    assert.equal(capped.denied.length, 2);
    assert.equal(capped.denied[0].reason, 'global-quota-exhausted');
  });

  it('never places work on stale, draining, or retired hosts', () => {
    const reg = registryWithHosts([
      ['h-ok', OBS({ totalSlots: 2, usedSlots: 0 })],
      ['h-drain', OBS({ totalSlots: 8, usedSlots: 0 })],
    ]);
    reg.setDraining('h-drain');
    const { token } = reg.issueJoinToken({ ttlMs: 120_000, nowMs: NOW });
    reg.enroll({ hostId: 'h-old', tailscaleIdentity: 't', joinToken: token, observation: OBS({ totalSlots: 8, usedSlots: 0 }), nowMs: NOW - 300_000 });
    const tasks = [{ id: 't1' }, { id: 't2' }, { id: 't3' }];
    const res = selectHostsForTasks({
      tasks, hosts: reg.list(), projectActive: 0, projectLimit: 8,
      globalActive: 0, globalLimit: 8, providerAvailable: 8, budgetCapacity: 8,
      nowMs: NOW, heartbeatTimeoutMs: 30_000,
    });
    assert.equal(res.placements.length, 2);
    for (const p of res.placements) assert.equal(p.hostId, 'h-ok');
    assert.equal(res.denied.length, 1);
  });
});
