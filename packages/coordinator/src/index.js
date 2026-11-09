/**
 * Public surface of `@forgefleet/coordinator` (FF-012).
 */
export {
  COORDINATOR_VERSION,
  PLAN_KIND,
  MAX_TASKS_PER_PLAN,
  MAX_EDGES_PER_PLAN,
  MAX_ACCEPTANCE_PER_TASK,
  MAX_TITLE_CHARS,
  GATING_EDGE_KINDS,
  INFORMATIONAL_EDGE_KIND,
  EDGE_KINDS,
  hashPlanBody,
  findCycle,
  topoOrder,
  proposePlan,
  approvePlan,
  revisePlan,
  getReadyTasks,
} from './plan.js';
