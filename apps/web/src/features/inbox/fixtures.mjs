/**
 * FF-017 spike fixtures. Example only — not captured runtime data.
 *
 * Diamond DAG plus one independent task:
 *
 *   t-api ---> t-web ---+
 *     \                  +--> t-release
 *      `--> t-ios ----+
 *   t-docs (independent, ready)
 *
 * A decision gating `t-web` must block `t-web` + `t-release` only;
 * `t-ios`, `t-docs`, and already-running work continue.
 */
import { DECISION_STATUS, TASK_STATUS } from './inbox-policy.mjs';

export const TASK_IDS = Object.freeze({
  API: 't-api',
  WEB: 't-web',
  IOS: 't-ios',
  RELEASE: 't-release',
  DOCS: 't-docs',
});

/** `[from, to]` = `to` depends on `from`. */
export const EDGES = Object.freeze([
  [TASK_IDS.API, TASK_IDS.WEB],
  [TASK_IDS.API, TASK_IDS.IOS],
  [TASK_IDS.WEB, TASK_IDS.RELEASE],
  [TASK_IDS.IOS, TASK_IDS.RELEASE],
]);

export function baseTasks() {
  return [
    { id: TASK_IDS.API, status: TASK_STATUS.VERIFIED },
    { id: TASK_IDS.WEB, status: TASK_STATUS.READY },
    { id: TASK_IDS.IOS, status: TASK_STATUS.READY },
    { id: TASK_IDS.RELEASE, status: TASK_STATUS.READY },
    { id: TASK_IDS.DOCS, status: TASK_STATUS.READY },
  ];
}

export function webBlockedDecision() {
  return {
    id: 'dec-web-api-shape',
    projectId: 'project_123',
    taskId: TASK_IDS.WEB,
    requester: 'worker:web',
    category: 'api-contract',
    severity: 'high',
    reason: 'API response shape differs from task spec; web and dependents cannot proceed safely.',
    options: ['adopt-openapi-shape', 'keep-mock-shape'],
    recommendedOption: 'adopt-openapi-shape',
    blockedTasks: [TASK_IDS.WEB],
    risk: 'Shipping against the mock shape breaks the release contract.',
    defaultOnTimeout: 'keep-blocked',
    lastUpdated: '2026-11-08T12:00:00Z',
    expiresAt: '2026-11-09T12:00:00Z',
    approvalTargetSha: 'abc1234',
    requiresOwner: true,
    status: DECISION_STATUS.PENDING,
  };
}

export function docsBlockedDecision() {
  return {
    id: 'dec-docs-wording',
    projectId: 'project_123',
    taskId: TASK_IDS.DOCS,
    requester: 'worker:docs',
    category: 'copy',
    severity: 'low',
    reason: 'Choose onboarding headline wording.',
    options: ['a', 'b'],
    recommendedOption: 'a',
    blockedTasks: [TASK_IDS.DOCS],
    risk: 'Cosmetic only.',
    defaultOnTimeout: 'keep-blocked',
    lastUpdated: '2026-11-08T12:00:00Z',
    approvalTargetSha: 'def5678',
    requiresOwner: true,
    status: DECISION_STATUS.PENDING,
  };
}
