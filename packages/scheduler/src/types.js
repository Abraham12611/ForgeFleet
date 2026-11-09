/**
 * Shared typedefs for the scheduler core.
 *
 * Task lifecycle (authoritative: docs/05-contracts/state-machines.md):
 * draft -> ready -> reserved -> dispatched -> running -> submitted ->
 * verifying -> verified -> merged/closed, with blocked, retry_wait,
 * failed, cancelled, unknown as side states.
 *
 * @typedef {Object} DependencyEdge
 * @property {string} taskId predecessor task id
 * @property {'blocks'|'requires_contract'|'integration_after'|'informational'} type
 *
 * @typedef {Object} TaskNode
 * @property {string} id
 * @property {string} projectId
 * @property {string} status task lifecycle status
 * @property {DependencyEdge[]} [dependsOn]
 * @property {number} [priority] higher dispatches first; default 0
 * @property {number} [failedAttempts] confirmed terminal failures so far
 * @property {number} [retryNotBeforeMs] earliest re-dispatch time when status is retry_wait
 * @property {boolean} [projectPaused]
 * @property {boolean} [ownerDecisionBlocked]
 * @property {boolean} [policyAllowed] permission policy verdict; default true
 * @property {boolean} [runtimeOnline] matching runtime online; default true
 * @property {boolean} [worktreeAvailable] worktree lease obtainable; default true
 * @property {boolean} [budgetAvailable] budget available; default true
 *
 * @typedef {Object} LeaseRecord
 * @property {string} taskId
 * @property {number} generation monotonic fencing token, starts at 1
 * @property {string} holder attempt or worker id holding the lease
 * @property {string} idempotencyKey dispatch idempotency key
 * @property {string} requestHash hash of the acquire payload for conflict detection
 * @property {number} acquiredAtMs
 * @property {number} expiresAtMs
 * @property {'active'|'released'|'expired'|'fenced'} state
 *
 * @typedef {Object} AdmissionLimits
 * @property {number} projectLimit max active leases for the project
 * @property {number} globalLimit max active leases globally
 * @property {number} providerAvailable provider slots currently available
 * @property {number} hostFreeCapacity host slots currently free
 * @property {number} budgetCapacity budget-funded slots currently available
 *
 * @typedef {Object} AdmissionUsage
 * @property {number} projectActive active leases in the project
 * @property {number} globalActive active leases globally
 */

/** Task statuses that satisfy a gating predecessor. */
export const GATING_SATISFIED_STATUSES = new Set(['verified', 'merged', 'closed']);

/** Dependency edge types that gate dispatch. `informational` never gates. */
export const GATING_EDGE_TYPES = new Set(['blocks', 'requires_contract', 'integration_after']);

/** Terminal attempt/runtime outcomes. */
export const TERMINAL_RUNTIME_STATES = new Set(['finished', 'failed', 'cancelled']);

/** Task statuses that can never be dispatched from. */
export const TERMINAL_TASK_STATUSES = new Set(['failed', 'cancelled', 'merged', 'closed']);
