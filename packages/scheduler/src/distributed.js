/**
 * Distributed admission control across the worker-host registry (FF-026).
 *
 * Extends the single-host capacity model
 * (docs/03-architecture/scaling-and-recovery.md):
 *
 *   eligible_active = min(ready_tasks, project_limit, global_limit,
 *                         provider_available, host_free_capacity, budget_capacity)
 *
 * where `host_free_capacity` is the SUM of free slots over currently eligible
 * hosts (fresh, enrolled, not draining/retired, resources usable). Per-task
 * admission then pins each admitted task to one concrete host
 * (best-fit: most free slots, lexical id tie-break for determinism) so the
 * single authoritative scheduler still makes exactly one placement decision
 * per dispatch — never two hosts racing for the same task.
 *
 * Denials always carry a human-readable `reason` so a task stays
 * ready/blocked with an explanation instead of disappearing
 * (docs/04-flows/goal-to-worker.md, Subflow B).
 *
 * Pure + deterministic (injected `nowMs`); no I/O. Composes with FF-013
 * `admitOne`/`eligibleActive` reason strings for the non-host gates.
 */

import { hostFits, hostFreeCapacity } from './hosts.js';

/**
 * @typedef {Object} DistributedTaskSpec
 * @property {string} id
 * @property {number} [estimatedSlots] slots the task is expected to need; default 1
 * @property {string} [provider] required provider (e.g. 'muse')
 * @property {string} [runtime] required runtime (e.g. 'orca-cli')
 * @property {number} [priority] higher dispatches first; default 0
 */

/**
 * Aggregate free capacity over a host snapshot list.
 * @param {import('./hosts.js').HostRecord[]} hosts
 * @returns {{ totalFree: number, perHost: Array<{ hostId: string, free: number, reason: string }> }}
 */
export function aggregateHostCapacity(hosts, nowMs, heartbeatTimeoutMs = 30_000) {
  const perHost = hosts.map((h) => {
    const { free, reason } = hostFreeCapacity(h, nowMs, heartbeatTimeoutMs);
    return { hostId: h.id, free, reason };
  });
  return { totalFree: perHost.reduce((sum, h) => sum + h.free, 0), perHost };
}

/**
 * Distributed form of `eligibleActive`: how many more tasks may start given
 * every gate including summed host capacity.
 */
export function eligibleActiveDistributed({
  readyCount,
  projectRemaining,
  globalRemaining,
  providerAvailable,
  budgetRemaining,
  hosts,
  nowMs = Date.now(),
  heartbeatTimeoutMs = 30_000,
}) {
  const { totalFree, perHost } = aggregateHostCapacity(hosts, nowMs, heartbeatTimeoutMs);
  const remaining = {
    project: Math.max(0, projectRemaining),
    global: Math.max(0, globalRemaining),
    provider: Math.max(0, providerAvailable),
    host: totalFree,
    budget: Math.max(0, budgetRemaining),
  };
  const eligible = Math.min(Math.max(0, readyCount), remaining.project, remaining.global,
    remaining.provider, remaining.host, remaining.budget);
  return { eligibleActive: eligible, remaining, perHost };
}

/**
 * Pick the single best host for one task: most free slots wins, lexical id
 * breaks ties so placement is deterministic across scheduler replicas.
 * @returns {{ hostId?: string, reason: string }} reason 'ok' on success
 */
export function selectHost(hosts, task = {}, { nowMs = Date.now(), heartbeatTimeoutMs = 30_000 } = {}) {
  let best = null;
  let bestFree = -1;
  let fallbackReason = 'no-registered-hosts';
  for (const host of hosts) {
    const verdict = hostFits(host, {
      estimatedSlots: task.estimatedSlots ?? 1,
      provider: task.provider,
      runtime: task.runtime,
      nowMs,
      heartbeatTimeoutMs,
    });
    if (!verdict.fits) {
      // Prefer the most informative reason: capability mismatches outrank
      // generic exhaustion so operators see *why* nothing fits.
      if (fallbackReason === 'no-registered-hosts' || verdict.reason.startsWith('no-host-supports')) {
        fallbackReason = verdict.reason;
      } else if (fallbackReason === 'host-capacity-exhausted' && verdict.reason !== 'host-capacity-exhausted') {
        fallbackReason = verdict.reason;
      }
      continue;
    }
    fallbackReason = 'ok';
    const { free } = hostFreeCapacity(host, nowMs, heartbeatTimeoutMs);
    if (free > bestFree || (free === bestFree && (best === null || host.id < best.id))) {
      best = host;
      bestFree = free;
    }
  }
  if (best === null) return { reason: fallbackReason };
  return { hostId: best.id, reason: 'ok' };
}

/**
 * Admit exactly one task, pinning it to a concrete host.
 * Gate order mirrors FF-013 `admitOne` so reasons stay consistent, with host
 * placement as the final gate.
 */
export function admitOneDistributed({
  projectActive,
  projectLimit,
  globalActive,
  globalLimit,
  providerAvailable,
  budgetCapacity,
  hosts,
  task = {},
  nowMs = Date.now(),
  heartbeatTimeoutMs = 30_000,
}) {
  if (projectActive >= projectLimit) return { admitted: false, reason: 'project-quota-exhausted' };
  if (globalActive >= globalLimit) return { admitted: false, reason: 'global-quota-exhausted' };
  if (providerAvailable <= 0) return { admitted: false, reason: 'provider-unavailable' };
  if (budgetCapacity <= 0) return { admitted: false, reason: 'budget-exhausted' };
  const pick = selectHost(hosts, task, { nowMs, heartbeatTimeoutMs });
  if (!pick.hostId) return { admitted: false, reason: pick.reason };
  return { admitted: true, reason: 'ok', hostId: pick.hostId };
}

/**
 * Greedily place an ordered task list across hosts under quota gates.
 * Deterministic: tasks sorted by (priority desc, id asc); placement updates
 * running usage so later tasks see earlier placements. Synchronous bounded
 * loop — no fan-out; actual dispatch concurrency stays bounded by the
 * returned placement count and the caller's executor limits.
 *
 * @returns {{ placements: Array<{ taskId: string, hostId: string }>, denied: Array<{ taskId: string, reason: string }> }}
 */
export function selectHostsForTasks({
  tasks,
  hosts,
  projectActive,
  projectLimit,
  globalActive,
  globalLimit,
  providerAvailable,
  budgetCapacity,
  nowMs = Date.now(),
  heartbeatTimeoutMs = 30_000,
}) {
  const ordered = [...tasks].sort((a, b) =>
    (b.priority ?? 0) - (a.priority ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // Mutable working copies of host slot usage for the greedy pass.
  const working = new Map(hosts.map((h) => [h.id, { ...h }]));
  const placements = [];
  const denied = [];
  let project = projectActive;
  let global = globalActive;
  for (const task of ordered) {
    const verdict = admitOneDistributed({
      projectActive: project,
      projectLimit,
      globalActive: global,
      globalLimit,
      providerAvailable,
      budgetCapacity,
      hosts: [...working.values()],
      task,
      nowMs,
      heartbeatTimeoutMs,
    });
    if (!verdict.admitted) {
      denied.push({ taskId: task.id, reason: verdict.reason });
      continue;
    }
    const slot = working.get(verdict.hostId);
    slot.usedSlots += Math.max(1, Math.floor(task.estimatedSlots ?? 1));
    project += 1;
    global += 1;
    placements.push({ taskId: task.id, hostId: verdict.hostId });
  }
  return { placements, denied };
}
