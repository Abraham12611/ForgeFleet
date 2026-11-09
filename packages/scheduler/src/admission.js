/**
 * Admission control: quota and capacity gates for new dispatches.
 *
 * Capacity model (docs/03-architecture/scaling-and-recovery.md):
 * eligible_active = min(ready_tasks, project_limit, global_limit,
 *                       provider_available, host_free_capacity, budget_capacity)
 */

/**
 * Compute how many more tasks may start across a candidate set.
 *
 * @param {import('./types.js').AdmissionLimits} limits
 * @param {import('./types.js').AdmissionUsage} usage
 * @param {number} readyCount
 * @returns {{ eligibleActive: number, remaining: { project: number, global: number, provider: number, host: number, budget: number } }}
 */
export function eligibleActive(limits, usage, readyCount) {
  const remaining = {
    project: Math.max(0, limits.projectLimit - usage.projectActive),
    global: Math.max(0, limits.globalLimit - usage.globalActive),
    provider: Math.max(0, limits.providerAvailable),
    host: Math.max(0, limits.hostFreeCapacity),
    budget: Math.max(0, limits.budgetCapacity),
  };
  const eligibleActive = Math.min(
    Math.max(0, readyCount),
    remaining.project,
    remaining.global,
    remaining.provider,
    remaining.host,
    remaining.budget,
  );
  return { eligibleActive, remaining };
}

/**
 * Decide admission for one more dispatch. Returns the first blocking reason,
 * or `{ admitted: true }` when every gate passes.
 *
 * @param {import('./types.js').AdmissionLimits} limits
 * @param {import('./types.js').AdmissionUsage} usage
 * @returns {{ admitted: boolean, reason?: string }}
 */
export function admitOne(limits, usage) {
  if (usage.projectActive >= limits.projectLimit) return { admitted: false, reason: 'project-quota-exhausted' };
  if (usage.globalActive >= limits.globalLimit) return { admitted: false, reason: 'global-quota-exhausted' };
  if (limits.providerAvailable <= 0) return { admitted: false, reason: 'provider-unavailable' };
  if (limits.hostFreeCapacity <= 0) return { admitted: false, reason: 'host-capacity-exhausted' };
  if (limits.budgetCapacity <= 0) return { admitted: false, reason: 'budget-exhausted' };
  return { admitted: true };
}
