/**
 * FF-017 spike — consolidated inbox + sleep mode policy (fixture-grade).
 *
 * Pure, dependency-free inbox/sleep rules for the ForgeFleet web UI slice
 * owned by E14 (`apps/web/src/features/inbox/**`). No network, no store, no
 * framework imports: every function is deterministic and unit-testable with
 * the Node standard library only.
 *
 * Status: DESIGN/FIXTURE SPIKE. Prerequisites E05 (contracts) and E10
 * (messaging) have no implementation yet, so this module does NOT claim
 * integration with Paperclip tasks, the scheduler (E09), or the message
 * ledger. Field names follow `docs/04-flows/sleep-and-decisions.md`,
 * `docs/02-experience/screens-states-and-copy.md`, and the decision machine
 * in `docs/05-contracts/state-machines.md`.
 *
 * Core guarantee (FF-017 acceptance): only blocked dependents wait — every
 * other ready task continues, whether the owner is awake or asleep.
 */

/** Decision lifecycle states (`docs/05-contracts/state-machines.md`). */
export const DECISION_STATUS = Object.freeze({
  PROPOSED: 'proposed',
  PENDING: 'pending',
  ANSWERED: 'answered',
  WITHDRAWN: 'withdrawn',
  EXPIRED: 'expired',
});

/** Task states relevant to dispatch gating (`docs/04-flows/flow-catalog.md`). */
export const TASK_STATUS = Object.freeze({
  READY: 'ready',
  BLOCKED: 'blocked',
  RUNNING: 'running',
  VERIFIED: 'verified',
});

/** Decisions in these states keep gating their dependents. Expired
 *  decisions still block — expiry never approves (`FR-07`, F04). */
const GATING_STATES = new Set([
  DECISION_STATUS.PROPOSED,
  DECISION_STATUS.PENDING,
  DECISION_STATUS.EXPIRED,
]);

const SEVERITY_ORDER = Object.freeze({ low: 0, normal: 1, high: 2, critical: 3 });

/**
 * @typedef {object} DecisionItem
 * @property {string} id
 * @property {string} projectId
 * @property {string} taskId            Task that raised the question.
 * @property {string} requester         Agent/worker that asked.
 * @property {string} category
 * @property {string} severity          low | normal | high | critical
 * @property {string} reason
 * @property {string[]} options
 * @property {string} [recommendedOption]
 * @property {string[]} blockedTasks    Directly gated tasks (deep-link targets).
 * @property {string} risk
 * @property {string} defaultOnTimeout  Safe default; never an auto-approval.
 * @property {string} lastUpdated       ISO timestamp.
 * @property {string} [expiresAt]       ISO timestamp; absent = no deadline.
 * @property {string} approvalTargetSha Exact head SHA an answer must match.
 * @property {boolean} requiresOwner
 * @property {string} status            One of DECISION_STATUS.
 */

/**
 * Validate the inbox fields every decision item must carry.
 * @param {object} item
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateDecisionItem(item) {
  const errors = [];
  if (!item || typeof item !== 'object') return { ok: false, errors: ['not-an-object'] };
  for (const field of [
    'id', 'projectId', 'taskId', 'requester', 'category', 'severity',
    'reason', 'options', 'blockedTasks', 'risk', 'defaultOnTimeout',
    'lastUpdated', 'approvalTargetSha', 'status',
  ]) {
    if (item[field] === undefined || item[field] === null || item[field] === '') {
      errors.push(`missing:${field}`);
    }
  }
  if (item.severity !== undefined && !(item.severity in SEVERITY_ORDER)) {
    errors.push(`invalid:severity:${item.severity}`);
  }
  if (item.options !== undefined && (!Array.isArray(item.options) || item.options.length === 0)) {
    errors.push('invalid:options:empty');
  }
  if (item.blockedTasks !== undefined && !Array.isArray(item.blockedTasks)) {
    errors.push('invalid:blockedTasks:not-array');
  }
  if (!Object.values(DECISION_STATUS).includes(item.status)) {
    errors.push(`invalid:status:${item.status}`);
  }
  if (item.defaultOnTimeout === 'approve' || item.defaultOnTimeout === 'auto-approve') {
    errors.push('invalid:defaultOnTimeout:must-never-auto-approve');
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Downstream tasks of `taskId` along `edges` (`[from, to]` = `to` depends on `from`).
 * Cycle-safe: each node visited at most once.
 * @param {string} taskId
 * @param {Array<[string, string]>} edges
 * @returns {string[]}
 */
export function transitiveDependents(taskId, edges) {
  const children = new Map();
  for (const [from, to] of edges) {
    if (!children.has(from)) children.set(from, []);
    children.get(from).push(to);
  }
  const seen = new Set([taskId]);
  const out = [];
  const queue = [...(children.get(taskId) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift();
    if (seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    queue.push(...(children.get(next) ?? []));
  }
  return out;
}

/**
 * Decisions that still gate execution. Answered/withdrawn release their
 * tasks; proposed/pending/expired keep blocking.
 * @param {DecisionItem[]} decisions
 * @returns {DecisionItem[]}
 */
export function gatingDecisions(decisions) {
  return (decisions ?? []).filter((d) => GATING_STATES.has(d.status));
}

/**
 * Every task that must wait: each gating decision's `blockedTasks` plus all
 * transitive dependents. Maps taskId -> decision ids that gate it.
 * @param {DecisionItem[]} decisions
 * @param {Array<[string, string]>} edges
 * @returns {Map<string, string[]>}
 */
export function blockedClosure(decisions, edges) {
  const closure = new Map();
  const add = (taskId, decisionId) => {
    if (!closure.has(taskId)) closure.set(taskId, []);
    if (!closure.get(taskId).includes(decisionId)) closure.get(taskId).push(decisionId);
  };
  for (const d of gatingDecisions(decisions)) {
    for (const t of d.blockedTasks ?? []) {
      add(t, d.id);
      for (const dep of transitiveDependents(t, edges)) add(dep, d.id);
    }
  }
  return closure;
}

/**
 * Split ready work into "waits" vs "continues". Only tasks inside the
 * blocked closure wait; every other ready task keeps going — asleep or awake.
 * @param {{ tasks: Array<{id: string, status: string}>, edges: Array<[string,string]>, decisions: DecisionItem[] }} input
 * @returns {{ blocked: Array<{taskId: string, blockedBy: string[]}>, runnable: string[] }}
 */
export function computeExecutionPlan({ tasks, edges, decisions }) {
  const closure = blockedClosure(decisions ?? [], edges ?? []);
  const blocked = [];
  const runnable = [];
  for (const task of tasks ?? []) {
    if (task.status !== TASK_STATUS.READY) continue;
    if (closure.has(task.id)) blocked.push({ taskId: task.id, blockedBy: closure.get(task.id) });
    else runnable.push(task.id);
  }
  return { blocked, runnable };
}

/**
 * Route a worker question. Owner-required questions become durable queued
 * decisions (never dropped, never auto-answered); anything the coordinator
 * may resolve stays out of the inbox.
 * @param {{ sleeping: boolean, requiresOwner: boolean, question: Omit<DecisionItem,'status'> }} input
 * @returns {{ action: 'queue' | 'resolve-direct', decision?: DecisionItem }}
 */
export function routeOwnerQuestion({ sleeping, requiresOwner, question }) {
  void sleeping; // Sleep changes interruption, never routing authority.
  if (!requiresOwner) return { action: 'resolve-direct' };
  return { action: 'queue', decision: { ...question, status: DECISION_STATUS.PROPOSED } };
}

/**
 * Mark past-due proposed/pending decisions expired. Expiry keeps blocking;
 * callers must not treat it as approval.
 * @param {DecisionItem[]} decisions
 * @param {number} nowMs
 * @returns {DecisionItem[]}
 */
export function expireDueDecisions(decisions, nowMs) {
  return (decisions ?? []).map((d) => {
    if (
      (d.status === DECISION_STATUS.PROPOSED || d.status === DECISION_STATUS.PENDING) &&
      d.expiresAt !== undefined &&
      Date.parse(d.expiresAt) <= nowMs
    ) {
      return { ...d, status: DECISION_STATUS.EXPIRED };
    }
    return d;
  });
}

/**
 * Record an owner answer. Must be a signed owner action against the exact
 * target SHA; stale-SHA answers are invalid and reopen the decision
 * (proposed -> pending). Answering an expired decision never grants.
 * @param {DecisionItem} decision
 * @param {{ approver: string, isOwner: boolean, choice: string, targetSha: string, nowMs: number }} answer
 * @returns {{ ok: boolean, error?: string, decision: DecisionItem }}
 */
export function answerDecision(decision, { approver, isOwner, choice, targetSha, nowMs }) {
  if (!approver || !isOwner) {
    return { ok: false, error: 'not-owner-signed', decision };
  }
  if (decision.status === DECISION_STATUS.EXPIRED) {
    return { ok: false, error: 'expired-never-approves', decision };
  }
  if (decision.status !== DECISION_STATUS.PROPOSED && decision.status !== DECISION_STATUS.PENDING) {
    return { ok: false, error: `not-answerable:${decision.status}`, decision };
  }
  if (!choice || !(decision.options ?? []).includes(choice)) {
    return { ok: false, error: 'unknown-choice', decision };
  }
  if (targetSha !== decision.approvalTargetSha) {
    return {
      ok: false,
      error: 'stale-target-sha',
      decision: {
        ...decision,
        status: DECISION_STATUS.PENDING,
        lastUpdated: new Date(nowMs).toISOString(),
      },
    };
  }
  return {
    ok: true,
    decision: {
      ...decision,
      status: DECISION_STATUS.ANSWERED,
      lastUpdated: new Date(nowMs).toISOString(),
    },
  };
}

/**
 * Approval evaluation. The `sleeping` flag is accepted so callers can pass
 * ambient UI state, but it MUST NOT change the verdict: sleep never grants,
 * skips, or softens approval (F04 invariant).
 * @param {DecisionItem} decision
 * @param {{ approver: string, isOwner: boolean, targetSha: string }} answer
 * @param {{ sleeping: boolean }} ambient
 * @returns {{ granted: boolean, reason: string }}
 */
export function evaluateApproval(decision, answer, ambient) {
  void ambient;
  if (!answer.isOwner || !answer.approver) return { granted: false, reason: 'not-owner-signed' };
  if (decision.status === DECISION_STATUS.EXPIRED) return { granted: false, reason: 'expired' };
  if (answer.targetSha !== decision.approvalTargetSha) return { granted: false, reason: 'stale-target-sha' };
  if (!GATING_STATES.has(decision.status)) return { granted: false, reason: `not-open:${decision.status}` };
  return { granted: true, reason: 'owner-signed-fresh-sha' };
}

/**
 * Morning digest after sleep: verified outcomes, failures, PRs, worker
 * counts, and pending decisions ordered by blast radius (blocked-closure
 * size), then severity. One consolidated item per decision — never one
 * notification per worker update.
 * @param {{ decisions: DecisionItem[], tasks: Array<{id: string, status: string}>, edges: Array<[string,string]>, pullRequests: Array<{ref: string, state: string}>, workerCount: number, nowMs: number }} input
 */
export function buildDigest({ decisions, tasks, edges, pullRequests, workerCount, nowMs }) {
  const current = expireDueDecisions(decisions ?? [], nowMs);
  const closure = blockedClosure(current, edges ?? []);
  const blastRadius = (d) =>
    new Set((d.blockedTasks ?? []).flatMap((t) => [t, ...transitiveDependents(t, edges ?? [])])).size;
  const pendingDecisions = gatingDecisions(current)
    .map((d) => ({ id: d.id, taskId: d.taskId, severity: d.severity, blastRadius: blastRadius(d) }))
    .sort(
      (a, b) =>
        b.blastRadius - a.blastRadius ||
        SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] ||
        (a.id < b.id ? -1 : 1),
    );
  const verified = (tasks ?? []).filter((t) => t.status === TASK_STATUS.VERIFIED).map((t) => t.id);
  const failed = (tasks ?? [])
    .filter((t) => t.status !== TASK_STATUS.VERIFIED && t.status !== TASK_STATUS.READY && t.status !== TASK_STATUS.RUNNING)
    .map((t) => t.id);
  return {
    verified,
    failed,
    pullRequests: pullRequests ?? [],
    workerCount,
    pendingDecisions,
  };
}
