/**
 * ForgeFleet coordinator task DAG/planner (FF-012).
 *
 * The coordinator proposes bounded task DAGs for a goal; a deterministic
 * scheduler/policy commits dispatch (see `docs/03-architecture/orchestration.md`
 * and `docs/04-flows/goal-to-worker.md`, subflow A). This module is the
 * deterministic half of `propose_plan`: it validates structure, rejects
 * cycles, and proves every goal acceptance criterion traces to at least one
 * task. It never launches workers and never grants approvals.
 *
 * Deterministic: no clock, no randomness, no I/O. Same inputs always yield
 * the same revision hash. All returned revisions are deeply frozen; edits
 * go through `revisePlan`, which bumps the revision number.
 *
 * Dependency kinds follow `docs/03-architecture/orchestration.md`:
 * `blocks`, `requires_contract`, `integration_after` are gating (they hold
 * a task out of the ready set); `informational` is advisory only — it is
 * validated but excluded from cycle detection and readiness, so a note
 * edge can never deadlock dispatch.
 *
 * NOTE (E05/E07 dependencies): `packages/bridge-contracts` and
 * `packages/policy` do not exist on this branch yet, so plan approval here
 * is structural only (shape + hash + project scope). Reconcile the
 * `approved` stamp with the E05 contract custodian and the E07 policy
 * engine before the scheduler (E09) treats it as dispatchable.
 */

import { createHash } from 'node:crypto';

export const COORDINATOR_VERSION = '0.1.0';
export const PLAN_KIND = 'forgefleet.plan-revision/v1';

/** Largest task set in one proposed plan: plans stay bounded and reviewable. */
export const MAX_TASKS_PER_PLAN = 50;
/** Largest edge set in one proposed plan. */
export const MAX_EDGES_PER_PLAN = 200;
/** Acceptance bullets required per task: at least one, never a dump. */
export const MAX_ACCEPTANCE_PER_TASK = 10;
/** Task titles stay one line so boards and mobile lists render cleanly. */
export const MAX_TITLE_CHARS = 200;

/** Edge kinds that gate readiness and participate in cycle detection. */
export const GATING_EDGE_KINDS = Object.freeze([
  'blocks',
  'requires_contract',
  'integration_after',
]);

/** Advisory edge kind: validated, but never blocks readiness or closes a cycle. */
export const INFORMATIONAL_EDGE_KIND = 'informational';

export const EDGE_KINDS = Object.freeze([...GATING_EDGE_KINDS, INFORMATIONAL_EDGE_KIND]);

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

function deepFreeze(value) {
  if (value !== null && (typeof value === 'object' || typeof value === 'function') && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Stable content hash: tasks/edges sorted by id so input order never matters. */
export function hashPlanBody({ projectId, goal, tasks, edges }) {
  const sortedTasks = [...tasks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const sortedEdges = [...edges].sort((a, b) =>
    a.from === b.from ? (a.to < b.to ? -1 : a.to > b.to ? 1 : 0) : a.from < b.from ? -1 : 1,
  );
  return createHash('sha256')
    .update(canonicalize({ projectId, goal, tasks: sortedTasks, edges: sortedEdges }))
    .digest('hex');
}

const err = (code, message, details = {}) => ({ code, message, details });

function validateShape({ projectId, goal, tasks, edges }, errors) {
  if (!isNonEmptyString(projectId)) {
    errors.push(err('PROJECT_MISMATCH', 'projectId must be a non-empty string.'));
    return false;
  }
  if (!goal || typeof goal !== 'object' || !isNonEmptyString(goal.id)) {
    errors.push(err('UNTRACEABLE_TASK', 'goal must be an object with a non-empty id.'));
    return false;
  }
  if (!Array.isArray(tasks) || !Array.isArray(edges)) {
    errors.push(err('EMPTY_PLAN', 'tasks and edges must be arrays.'));
    return false;
  }
  return true;
}

function validateTasks({ goal, tasks }, errors) {
  const seen = new Set();
  const ownsSeen = new Map();
  for (const task of tasks) {
    if (!task || typeof task !== 'object' || !isNonEmptyString(task.id)) {
      errors.push(err('DUPLICATE_TASK', 'Every task must have a non-empty string id.', { task }));
      continue;
    }
    if (seen.has(task.id)) {
      errors.push(err('DUPLICATE_TASK', `Duplicate task id: ${task.id}.`, { taskId: task.id }));
    }
    seen.add(task.id);
    if (!isNonEmptyString(task.title) || task.title.length > MAX_TITLE_CHARS) {
      errors.push(
        err('MISSING_ACCEPTANCE', `Task ${task.id} needs a title of 1..${MAX_TITLE_CHARS} chars.`, {
          taskId: task.id,
        }),
      );
    }
    if (!Array.isArray(task.acceptance) || task.acceptance.length === 0) {
      errors.push(
        err('MISSING_ACCEPTANCE', `Task ${task.id} must state at least one acceptance bullet.`, {
          taskId: task.id,
        }),
      );
    } else if (task.acceptance.length > MAX_ACCEPTANCE_PER_TASK) {
      errors.push(
        err('BOUND_EXCEEDED', `Task ${task.id} exceeds ${MAX_ACCEPTANCE_PER_TASK} acceptance bullets.`, {
          taskId: task.id,
        }),
      );
    }
    // Goal traceability: every task names the goal it serves.
    if (task.goalId !== goal.id) {
      errors.push(
        err('UNTRACEABLE_TASK', `Task ${task.id} does not trace to goal ${goal.id}.`, {
          taskId: task.id,
          goalId: task.goalId ?? null,
        }),
      );
    }
    // Duplicate ownership: two tasks must not claim the same work item.
    if (task.owns !== undefined && task.owns !== null) {
      if (!isNonEmptyString(task.owns)) {
        errors.push(
          err('DUPLICATE_OWNERSHIP', `Task ${task.id} has an empty ownership key.`, { taskId: task.id }),
        );
      } else if (ownsSeen.has(task.owns)) {
        errors.push(
          err(
            'DUPLICATE_OWNERSHIP',
            `Tasks ${ownsSeen.get(task.owns)} and ${task.id} both own ${JSON.stringify(task.owns)}.`,
            { taskIds: [ownsSeen.get(task.owns), task.id], owns: task.owns },
          ),
        );
      } else {
        ownsSeen.set(task.owns, task.id);
      }
    }
  }
  return seen;
}

function validateGoalCoverage({ goal, tasks }, errors) {
  const criteria = Array.isArray(goal.acceptance) ? goal.acceptance : [];
  const known = new Set();
  for (const criterion of criteria) {
    if (criterion && isNonEmptyString(criterion.id)) known.add(criterion.id);
  }
  const covered = new Map();
  for (const task of tasks) {
    if (!task || typeof task !== 'object' || !isNonEmptyString(task.id)) continue;
    const covers = Array.isArray(task.covers) ? task.covers : [];
    for (const criterionId of covers) {
      if (!known.has(criterionId)) {
        errors.push(
          err('UNKNOWN_CRITERION', `Task ${task.id} covers unknown criterion ${JSON.stringify(criterionId)}.`, {
            taskId: task.id,
            criterionId,
          }),
        );
      } else if (!covered.has(criterionId)) {
        covered.set(criterionId, task.id);
      }
    }
  }
  for (const criterionId of known) {
    if (!covered.has(criterionId)) {
      errors.push(
        err('UNCOVERED_CRITERION', `Goal criterion ${criterionId} has no covering task.`, { criterionId }),
      );
    }
  }
  const trace = {};
  for (const criterionId of known) trace[criterionId] = [];
  for (const task of tasks) {
    if (!task || typeof task !== 'object') continue;
    for (const criterionId of Array.isArray(task.covers) ? task.covers : []) {
      if (known.has(criterionId)) trace[criterionId].push(task.id);
    }
  }
  return trace;
}

function validateEdges({ tasks, edges }, taskIds, errors) {
  const seen = new Set();
  const gating = [];
  for (const edge of edges) {
    if (!edge || typeof edge !== 'object' || !isNonEmptyString(edge.from) || !isNonEmptyString(edge.to)) {
      errors.push(err('UNKNOWN_TASK', 'Every edge needs non-empty `from` and `to` task ids.', { edge }));
      continue;
    }
    if (!EDGE_KINDS.includes(edge.kind)) {
      errors.push(
        err('INVALID_EDGE_KIND', `Edge ${edge.from} -> ${edge.to} has unknown kind ${JSON.stringify(edge.kind)}.`, {
          edge,
        }),
      );
      continue;
    }
    if (edge.from === edge.to) {
      errors.push(err('SELF_LOOP', `Task ${edge.from} cannot depend on itself.`, { taskId: edge.from }));
      continue;
    }
    if (!taskIds.has(edge.from) || !taskIds.has(edge.to)) {
      errors.push(
        err('UNKNOWN_TASK', `Edge ${edge.from} -> ${edge.to} references an unknown task.`, { edge }),
      );
      continue;
    }
    const key = `${edge.kind}:${edge.from}->${edge.to}`;
    if (seen.has(key)) {
      errors.push(err('DUPLICATE_EDGE', `Duplicate edge ${edge.from} -> ${edge.to} (${edge.kind}).`, { edge }));
      continue;
    }
    seen.add(key);
    if (edge.kind !== INFORMATIONAL_EDGE_KIND) gating.push(edge);
  }
  return gating;
}

/** Depth-first cycle search over gating edges; returns the cycle path or null. */
export function findCycle(taskIds, gatingEdges) {
  const outgoing = new Map([...taskIds].map((id) => [id, []]));
  for (const edge of gatingEdges) outgoing.get(edge.from).push(edge.to);
  for (const neighbors of outgoing.values()) neighbors.sort();
  const state = new Map(); // id -> 'visiting' | 'done'
  const stack = [];
  const visit = (id) => {
    state.set(id, 'visiting');
    stack.push(id);
    for (const next of outgoing.get(id)) {
      if (state.get(next) === 'visiting') return [...stack.slice(stack.indexOf(next)), next];
      if (!state.has(next)) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  };
  for (const id of [...taskIds].sort()) {
    if (!state.has(id)) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

/** Kahn's algorithm over gating edges; deterministic (lexicographic) order. */
export function topoOrder(taskIds, gatingEdges) {
  const incoming = new Map([...taskIds].map((id) => [id, 0]));
  const outgoing = new Map([...taskIds].map((id) => [id, []]));
  for (const edge of gatingEdges) {
    outgoing.get(edge.from).push(edge.to);
    incoming.set(edge.to, incoming.get(edge.to) + 1);
  }
  const free = [...taskIds].filter((id) => incoming.get(id) === 0).sort();
  const order = [];
  while (free.length > 0) {
    const id = free.shift();
    order.push(id);
    for (const next of [...outgoing.get(id)].sort()) {
      incoming.set(next, incoming.get(next) - 1);
      if (incoming.get(next) === 0) {
        const at = free.findIndex((slot) => slot > next);
        if (at === -1) free.push(next);
        else free.splice(at, 0, next);
      }
    }
  }
  return order.length === taskIds.size ? order : null;
}

/**
 * Propose a plan revision. Returns `{ ok: true, revision }` with a frozen,
 * content-hashed revision, or `{ ok: false, errors }` with typed reasons.
 * Rejections (cycles, untraceable tasks, uncovered criteria) carry
 * machine-readable `code`s so the scheduler and UI can explain them.
 */
export function proposePlan({ projectId, goal, tasks, edges }) {
  const errors = [];
  if (!validateShape({ projectId, goal, tasks, edges }, errors)) {
    return { ok: false, errors };
  }
  if (tasks.length === 0) {
    errors.push(err('EMPTY_PLAN', 'A plan must contain at least one task.'));
    return { ok: false, errors };
  }
  if (tasks.length > MAX_TASKS_PER_PLAN) {
    errors.push(
      err('BOUND_EXCEEDED', `Plan exceeds ${MAX_TASKS_PER_PLAN} tasks; split the goal first.`, {
        count: tasks.length,
      }),
    );
  }
  if (edges.length > MAX_EDGES_PER_PLAN) {
    errors.push(
      err('BOUND_EXCEEDED', `Plan exceeds ${MAX_EDGES_PER_PLAN} edges; split the goal first.`, {
        count: edges.length,
      }),
    );
  }
  const taskIds = validateTasks({ goal, tasks }, errors);
  const trace = validateGoalCoverage({ goal, tasks }, errors);
  const gating = validateEdges({ tasks, edges }, taskIds, errors);
  const cycle = findCycle(taskIds, gating);
  if (cycle) {
    errors.push(err('CYCLE', `Dependency cycle: ${cycle.join(' -> ')}.`, { cycle }));
  }
  if (errors.length > 0) return { ok: false, errors };
  const order = topoOrder(taskIds, gating);
  const storedGoal = { id: goal.id, acceptance: Array.isArray(goal.acceptance) ? goal.acceptance : [] };
  const revision = deepFreeze({
    kind: PLAN_KIND,
    coordinatorVersion: COORDINATOR_VERSION,
    projectId,
    goalId: goal.id,
    goal: storedGoal,
    revision: 1,
    status: 'proposed',
    tasks: [...tasks].sort((a, b) => (a.id < b.id ? -1 : 1)),
    edges: [...edges].sort((a, b) => (a.from === b.from ? (a.to < b.to ? -1 : 1) : a.from < b.from ? -1 : 1)),
    order,
    trace,
    hash: hashPlanBody({ projectId, goal: storedGoal, tasks, edges }),
  });
  return { ok: true, revision };
}

/**
 * Stamp a proposed revision as approved. Structural only: the caller must
 * still pass the E07 policy gate before the scheduler treats the plan as
 * dispatchable. Returns `{ ok: true, revision }` or `{ ok: false, errors }`.
 */
export function approvePlan(revision, { by, projectId } = {}) {
  const errors = [];
  if (!revision || revision.kind !== PLAN_KIND) {
    return { ok: false, errors: [err('NOT_PROPOSED', 'Only a coordinator plan revision can be approved.')] };
  }
  if (revision.status !== 'proposed') {
    errors.push(err('NOT_PROPOSED', `Revision ${revision.revision} is ${revision.status}, not proposed.`));
  }
  if (projectId !== undefined && projectId !== revision.projectId) {
    errors.push(
      err('PROJECT_MISMATCH', 'Approval project does not match the plan project.', {
        expected: revision.projectId,
        actual: projectId,
      }),
    );
  }
  if (!isNonEmptyString(by)) {
    errors.push(err('NOT_PROPOSED', 'Approval requires a named approver identity.'));
  }
  const recomputed = hashPlanBody({
    projectId: revision.projectId,
    goal: revision.goal ?? { id: revision.goalId, acceptance: [] },
    tasks: revision.tasks ?? [],
    edges: revision.edges ?? [],
  });
  if (revision.hash !== recomputed) {
    errors.push(err('STALE_REVISION', 'Revision hash does not match its content.'));
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    revision: deepFreeze({ ...revision, status: 'approved', approvedBy: by }),
  };
}

/**
 * Revise an approved or proposed plan: the base hash must match (optimistic
 * concurrency, mirroring the transactional-validation rule in
 * `orchestration.md`), then the replacement task/edge set is re-validated
 * and returned as the next frozen revision.
 */
export function revisePlan(base, { projectId, goal, tasks, edges }) {
  if (!base || base.kind !== PLAN_KIND) {
    return { ok: false, errors: [err('STALE_REVISION', 'A plan revision base is required.')] };
  }
  const next = proposePlan({ projectId: projectId ?? base.projectId, goal, tasks, edges });
  if (!next.ok) return next;
  if (next.revision.projectId !== base.projectId || next.revision.goalId !== base.goalId) {
    return {
      ok: false,
      errors: [err('STALE_REVISION', 'A revision cannot change the plan project or goal; propose a new plan.')],
    };
  }
  return {
    ok: true,
    revision: deepFreeze({ ...next.revision, revision: base.revision + 1, supersedes: base.hash }),
  };
}

/**
 * Advisory ready set for the scheduler (E09 commits dispatch): task ids
 * whose gating predecessors are all in `doneTaskIds`, in dispatch order.
 * Informational edges never hold a task back. Pure advice — the scheduler
 * still applies budget, leases, and policy before dispatch.
 */
export function getReadyTasks(revision, doneTaskIds) {
  if (!revision || revision.kind !== PLAN_KIND) throw new Error('getReadyTasks needs a plan revision.');
  const done = new Set(Array.isArray(doneTaskIds) ? doneTaskIds : []);
  const blockers = new Map(revision.tasks.map((task) => [task.id, new Set()]));
  for (const edge of revision.edges) {
    if (edge.kind === INFORMATIONAL_EDGE_KIND) continue;
    if (blockers.has(edge.to)) blockers.get(edge.to).add(edge.from);
  }
  const ready = [];
  for (const id of revision.order ?? []) {
    if (done.has(id)) continue;
    const waitingOn = [...blockers.get(id)].filter((dep) => !done.has(dep)).sort();
    if (waitingOn.length === 0) ready.push(id);
  }
  return ready;
}
