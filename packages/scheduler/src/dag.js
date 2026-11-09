import { GATING_EDGE_TYPES, GATING_SATISFIED_STATUSES } from './types.js';

/**
 * Validate a task DAG.
 *
 * Rules (docs/03-architecture/orchestration.md):
 * - every edge target must exist
 * - no task may (transitively) depend on itself — cycles rejected
 * - `informational` edges never gate; all other edge types gate
 *
 * @param {Array<{id: string, dependsOn?: Array<{taskId: string, type: string}>}>} tasks
 * @returns {{ ok: true, gating: Map<string, string[]> } | { ok: false, error: string, cycle?: string[] }}
 */
export function validateDag(tasks) {
  const ids = new Set(tasks.map((t) => t.id));
  for (const task of tasks) {
    for (const edge of task.dependsOn ?? []) {
      if (!ids.has(edge.taskId)) {
        return { ok: false, error: `unknown-dependency: ${task.id} -> ${edge.taskId}` };
      }
      if (edge.taskId === task.id) {
        return { ok: false, error: `self-dependency: ${task.id}`, cycle: [task.id, task.id] };
      }
    }
  }

  // Gating adjacency only: informational edges cannot create cycles that block.
  const gating = new Map(tasks.map((t) => [t.id, []]));
  for (const task of tasks) {
    for (const edge of task.dependsOn ?? []) {
      if (GATING_EDGE_TYPES.has(edge.type)) gating.get(task.id).push(edge.taskId);
    }
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map(tasks.map((t) => [t.id, WHITE]));
  const stack = [];

  function visit(node) {
    color.set(node, GRAY);
    stack.push(node);
    for (const dep of gating.get(node)) {
      if (color.get(dep) === GRAY) {
        return stack.slice(stack.indexOf(dep)).concat(dep);
      }
      if (color.get(dep) === WHITE) {
        const cycle = visit(dep);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    color.set(node, BLACK);
    return null;
  }

  for (const task of tasks) {
    if (color.get(task.id) === WHITE) {
      const cycle = visit(task.id);
      if (cycle) return { ok: false, error: `cycle: ${cycle.join(' -> ')}`, cycle };
    }
  }
  return { ok: true, gating };
}

/**
 * Return the gating predecessors of a task that are not yet satisfied.
 * A gating edge is satisfied when the predecessor status is verified/merged/closed.
 *
 * @param {{dependsOn?: Array<{taskId: string, type: string}>}} task
 * @param {Map<string, string>} statusById predecessor id -> status
 * @returns {string[]} unsatisfied predecessor ids
 */
export function unsatisfiedGatingDeps(task, statusById) {
  const missing = [];
  for (const edge of task.dependsOn ?? []) {
    if (!GATING_EDGE_TYPES.has(edge.type)) continue;
    const status = statusById.get(edge.taskId);
    if (!GATING_SATISFIED_STATUSES.has(status)) missing.push(edge.taskId);
  }
  return missing;
}
