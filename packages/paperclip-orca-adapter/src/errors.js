// Typed errors for the Paperclip Orca adapter (FF-008).
//
// Every error carries a stable `code` so Paperclip-side handling and tests
// can branch without parsing messages. No error message includes secrets:
// bridge tokens and worker prompts are never interpolated here.

export class AdapterError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
    this.details = details;
  }
}

// Bridge capability for the requested workerKind is not verified
// (unsupported / unknown / unavailable). Fail closed: no dispatch attempted.
export class CapabilityError extends AdapterError {
  constructor(workerKind, status, notes = '') {
    super(
      'capability_unavailable',
      `workerKind '${workerKind}' not verified (status=${status}); refusing dispatch`,
      { workerKind, status, notes },
    );
    this.name = 'CapabilityError';
  }
}

// Same Idempotency-Key reused with a different payload (bridge HTTP 409).
// Must NOT be retried blindly: the active attempt belongs to another request.
export class IdempotencyConflictError extends AdapterError {
  constructor(idempotencyKey) {
    super(
      'idempotency_conflict',
      'idempotency key already bound to a different request; not retrying',
      { idempotencyKey },
    );
    this.name = 'IdempotencyConflictError';
  }
}

// Bridge rejected the request for auth/scope/policy reasons (401/403/422/429).
export class BridgeRejectedError extends AdapterError {
  constructor(status, reason = '') {
    super(
      'bridge_rejected',
      `bridge rejected request (http=${status})${reason ? `: ${reason}` : ''}`,
      { httpStatus: status },
    );
    this.name = 'BridgeRejectedError';
  }
}

// The attempt ended but workspace sync-back failed. Per the no-remote-git
// contract and the task state machine, no task completion may be reported:
// dependent work stays gated until finalize succeeds.
export class WorkspaceFinalizeError extends AdapterError {
  constructor(taskId, cause = '') {
    super(
      'workspace_finalize_failed',
      `workspace_finalize=failed for task '${taskId}'${cause ? `: ${cause}` : ''}`,
      { taskId },
    );
    this.name = 'WorkspaceFinalizeError';
  }
}

// Stored session references an attempt the bridge no longer knows (HTTP 404).
// The session is QUARANTINED, not cleared: a fresh session could launch a
// duplicate worker while the original is still alive. Only an explicit
// out-of-band recovery decision (fate-verified) releases it.
export class UnknownSessionError extends AdapterError {
  constructor(sessionId) {
    super(
      'unknown_session',
      `bridge has no record of session '${sessionId}'; quarantined pending explicit resolution`,
      { sessionId },
    );
    this.name = 'UnknownSessionError';
  }
}

// Execution context is malformed (missing runId/taskId/projectId/cwd, bad
// lease shape, unsafe path segment). Caller bug: fail fast, fabricate nothing.
export class InvalidContextError extends AdapterError {
  constructor(message) {
    super('invalid_context', message);
    this.name = 'InvalidContextError';
  }
}
