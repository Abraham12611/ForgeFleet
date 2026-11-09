/**
 * Retry policy: bounded exponential backoff with jitter.
 *
 * Rules (docs/03-architecture/orchestration.md, state-machines.md):
 * - retries use exponential backoff with jitter and a max-attempts cap
 * - `unknown` runtime state is NEVER immediately retried: the old attempt
 *   must first be reconciled (proven gone/fenced) via recovery
 *
 * @typedef {Object} RetryPolicy
 * @property {number} maxAttempts confirmed failures allowed before giving up
 * @property {number} baseDelayMs backoff base; delay = base * 2^attempt
 * @property {number} maxDelayMs hard cap per delay
 * @property {(attempt: number) => number} [jitterMs] deterministic jitter hook (default: none)
 */

/** Default proof-of-concept policy: 3 retries, 30s base, 10min cap. */
export const DEFAULT_RETRY_POLICY = {
  maxAttempts: 3,
  baseDelayMs: 30_000,
  maxDelayMs: 600_000,
};

/**
 * Decide what follows a confirmed terminal attempt failure.
 *
 * @param {{ failedAttempts: number, nowMs?: number }} attempt
 * @param {RetryPolicy} [policy]
 * @returns {{ action: 'retry_wait', notBeforeMs: number, delayMs: number } | { action: 'failed', reason: string }}
 */
export function afterFailure({ failedAttempts, nowMs = Date.now() }, policy = DEFAULT_RETRY_POLICY) {
  const nextAttempt = failedAttempts + 1;
  if (nextAttempt > policy.maxAttempts) {
    return { action: 'failed', reason: 'retry-budget-exhausted' };
  }
  const jitter = policy.jitterMs ? policy.jitterMs(nextAttempt) : 0;
  const delayMs = Math.min(policy.baseDelayMs * 2 ** (nextAttempt - 1), policy.maxDelayMs) + jitter;
  return { action: 'retry_wait', notBeforeMs: nowMs + delayMs, delayMs };
}

/**
 * Decide what follows an `unknown` (telemetry lost) observation.
 * Always holds: reconcile first, never blind-retry.
 *
 * @returns {{ action: 'hold-unknown', reason: string }}
 */
export function afterUnknown() {
  return { action: 'hold-unknown', reason: 'reconcile-before-retry' };
}

/** True when a `retry_wait` task's backoff has elapsed and it may re-enter `ready`. */
export function isRetryDue(retryNotBeforeMs, nowMs = Date.now()) {
  return nowMs >= retryNotBeforeMs;
}
