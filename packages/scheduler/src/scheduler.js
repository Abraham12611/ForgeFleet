import { eligibleActive, admitOne } from './admission.js';
import { evaluateReadiness } from './readiness.js';

/**
 * Order ready candidates deterministically: priority desc, then id asc.
 * @param {Array<import('./types.js').TaskNode>} tasks
 */
export function orderReadyQueue(tasks) {
  return [...tasks].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Run one admission pass over candidate tasks.
 *
 * Guarantees:
 * - a task already holding an active lease is never re-admitted in this batch
 *   (no double-active task), even if the caller passes it twice
 * - per-project and global quotas are respected as each admission consumes
 *   one slot of usage for subsequent candidates in the same batch
 *
 * @param {Object} args
 * @param {Array<import('./types.js').TaskNode>} args.tasks candidate tasks (any status)
 * @param {Map<string,string>} args.statusById task id -> lifecycle status (for dep checks)
 * @param {Set<string>} args.activeLeasedTaskIds tasks holding an active lease now
 * @param {(taskId: string) => string} args.projectOf maps task id -> project id
 * @param {Map<string, number>} args.projectLimits per-project active-lease caps
 * @param {number} args.defaultProjectLimit cap for projects without an explicit entry
 * @param {import('./types.js').AdmissionLimits} args.sharedLimits global cap + shared capacities
 * @param {number} args.sharedActive currently active leases globally
 * @param {Map<string, number>} args.projectActive currently active leases per project
 * @param {(task: import('./types.js').TaskNode) => { lease?: unknown, denied?: string }} args.acquire
 *   lease acquisition callback (wraps LeaseStore.acquire per task)
 * @param {number} [args.nowMs]
 * @returns {{ admitted: Array<{taskId: string, lease: unknown}>, denied: Array<{taskId: string, reason: string}>, eligibleActive: number }}
 */
export function admitBatch({
  tasks,
  statusById,
  activeLeasedTaskIds,
  projectOf,
  projectLimits,
  defaultProjectLimit,
  sharedLimits,
  sharedActive,
  projectActive,
  acquire,
  nowMs = Date.now(),
}) {
  const admitted = [];
  const denied = [];
  const leasedInBatch = new Set(activeLeasedTaskIds);

  // Incremental usage snapshots: each admission consumes one slot.
  const projectUsed = new Map(projectActive);
  let globalUsed = sharedActive;
  let providerUsed = 0;
  let hostUsed = 0;
  let budgetUsed = 0;

  for (const task of orderReadyQueue(tasks)) {
    if (leasedInBatch.has(task.id)) {
      denied.push({ taskId: task.id, reason: 'active-lease-held' });
      continue;
    }

    const readiness = evaluateReadiness(task, {
      statusById,
      activeLeasedTaskIds: leasedInBatch,
      nowMs,
    });
    if (!readiness.ready) {
      denied.push({ taskId: task.id, reason: readiness.reasons[0] });
      continue;
    }

    const projectId = projectOf(task.id);
    const verdict = admitOne(
      {
        projectLimit: projectLimits.get(projectId) ?? defaultProjectLimit,
        globalLimit: sharedLimits.globalLimit,
        providerAvailable: sharedLimits.providerAvailable - providerUsed,
        hostFreeCapacity: sharedLimits.hostFreeCapacity - hostUsed,
        budgetCapacity: sharedLimits.budgetCapacity - budgetUsed,
      },
      {
        projectActive: projectUsed.get(projectId) ?? 0,
        globalActive: globalUsed,
      },
    );
    if (!verdict.admitted) {
      denied.push({ taskId: task.id, reason: verdict.reason });
      continue;
    }

    const result = acquire(task);
    if (result.denied || !result.lease) {
      denied.push({ taskId: task.id, reason: result.denied ?? 'lease-denied' });
      continue;
    }
    leasedInBatch.add(task.id);
    projectUsed.set(projectId, (projectUsed.get(projectId) ?? 0) + 1);
    globalUsed += 1;
    providerUsed += 1;
    hostUsed += 1;
    budgetUsed += 1;
    admitted.push({ taskId: task.id, lease: result.lease });
  }

  const { eligibleActive: eligible } = eligibleActive(sharedLimits, { projectActive: 0, globalActive: sharedActive }, tasks.length);
  return { admitted, denied, eligibleActive: eligible };
}
