import { TERMINAL_TASK_STATUSES } from './types.js';
import { unsatisfiedGatingDeps } from './dag.js';

/**
 * Evaluate the readiness predicate for one task.
 *
 * Dispatchable iff (docs/03-architecture/orchestration.md): status is `ready`,
 * all gating predecessors are satisfied, no active lease, budget available,
 * matching runtime online, project not paused, worktree lease obtainable,
 * permission policy passes, and no blocking owner decision.
 *
 * @param {import('./types.js').TaskNode} task
 * @param {{ statusById?: Map<string,string>, activeLeasedTaskIds?: Set<string>, nowMs?: number }} ctx
 * @returns {{ ready: boolean, reasons: string[] }}
 */
export function evaluateReadiness(task, ctx = {}) {
  const reasons = [];
  const statusById = ctx.statusById ?? new Map();
  const leased = ctx.activeLeasedTaskIds ?? new Set();
  const nowMs = ctx.nowMs ?? Date.now();

  if (task.status !== 'ready') {
    if (task.status === 'retry_wait') {
      if ((task.retryNotBeforeMs ?? Infinity) > nowMs) {
        reasons.push('retry-backoff-pending');
      }
    } else if (task.status === 'blocked') {
      reasons.push('blocked-awaiting-input');
    } else if (task.status === 'unknown') {
      reasons.push('attempt-unknown');
    } else if (TERMINAL_TASK_STATUSES.has(task.status)) {
      reasons.push(`terminal-status:${task.status}`);
    } else {
      reasons.push(`not-ready:${task.status}`);
    }
  }

  const unsatisfied = unsatisfiedGatingDeps(task, statusById);
  if (unsatisfied.length > 0) reasons.push(`unsatisfied-deps:${unsatisfied.join(',')}`);

  if (leased.has(task.id)) reasons.push('active-lease-held');
  if (task.projectPaused) reasons.push('project-paused');
  if (task.ownerDecisionBlocked) reasons.push('owner-decision-blocked');
  if (task.policyAllowed === false) reasons.push('policy-denied');
  if (task.runtimeOnline === false) reasons.push('runtime-offline');
  if (task.worktreeAvailable === false) reasons.push('worktree-unavailable');
  if (task.budgetAvailable === false) reasons.push('budget-exhausted');

  return { ready: reasons.length === 0, reasons };
}
