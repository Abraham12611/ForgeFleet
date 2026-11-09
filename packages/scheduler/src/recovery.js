import { TERMINAL_RUNTIME_STATES } from './types.js';

/**
 * Restart reconciliation (docs/03-architecture/scaling-and-recovery.md).
 *
 * On boot: compare persisted leased attempts against a read-only runtime
 * query, then categorize each leased task:
 * - `keep` — runtime still reports the owner running; hold the lease
 * - `release-terminal` — runtime reports a terminal outcome; caller releases
 *   the lease and routes to retry/fail via the retry policy
 * - `hold-unknown` — runtime state ambiguous or unreachable; lease is HELD,
 *   never blind-retried (fence only after proof the old owner is gone)
 * - `orphan` — runtime owns a session with no scheduler lease; reported for
 *   human/operator handling, never auto-adopted
 *
 * Only genuinely unowned ready tasks may be dispatched after this pass.
 *
 * @param {Object} args
 * @param {Array<{ taskId: string, generation: number }>} args.leasedTasks active leases from persistence
 * @param {Map<string, { state: string, externalDispatchId?: string }>} args.runtimeByTaskId read-only runtime observations
 * @param {Array<{ externalId: string }>} [args.runtimeOrphans] runtime sessions matching no leased task
 * @returns {{ keep: string[], releaseTerminal: Array<{taskId: string, state: string}>, holdUnknown: Array<{taskId: string, reason: string}>, orphans: Array<{ externalId: string }> }}
 */
export function reconcile({ leasedTasks, runtimeByTaskId, runtimeOrphans = [] }) {
  const keep = [];
  const releaseTerminal = [];
  const holdUnknown = [];

  for (const leased of leasedTasks) {
    const observed = runtimeByTaskId.get(leased.taskId);
    if (!observed) {
      holdUnknown.push({ taskId: leased.taskId, reason: 'runtime-unreachable' });
      continue;
    }
    if (TERMINAL_RUNTIME_STATES.has(observed.state)) {
      releaseTerminal.push({ taskId: leased.taskId, state: observed.state });
      continue;
    }
    if (observed.state === 'running' || observed.state === 'dispatching') {
      keep.push(leased.taskId);
      continue;
    }
    holdUnknown.push({ taskId: leased.taskId, reason: `ambiguous-runtime-state:${observed.state}` });
  }

  return {
    keep,
    releaseTerminal,
    holdUnknown,
    orphans: runtimeOrphans.map((o) => ({ externalId: o.externalId })),
  };
}
