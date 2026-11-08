/**
 * E13 — Tasks/fleet UX (FF-016): route builders for the traceable
 * Task → attempt → agent chain.
 *
 * Route shapes come from `docs/02-experience/web-app-map.md`:
 * - task detail:   `/projects/:projectId/tasks/:taskId`
 * - project fleet: `/projects/:projectId/agents`
 * - agent detail:  `/fleet/:agentId`
 *
 * IDs are `encodeURIComponent`-escaped so agent/session IDs containing
 * slashes or spaces still produce one navigable route segment.
 */

export function taskRoute(projectId: string, taskId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`;
}

export function attemptRoute(
  projectId: string,
  taskId: string,
  attemptId: string,
): string {
  return `${taskRoute(projectId, taskId)}#attempt-${encodeURIComponent(attemptId)}`;
}

export function agentRoute(agentId: string): string {
  return `/fleet/${encodeURIComponent(agentId)}`;
}

export function projectFleetRoute(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/agents`;
}
