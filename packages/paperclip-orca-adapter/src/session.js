// Session params: the resumable cursor Paperclip hands back on every wake.
//
// Shape (versioned; v2 follows the pinned AdapterExecutionContext rework,
// PR #34 review):
//   {
//     version: 2,
//     sessionId: string,        // stable Paperclip-facing session id
//     attemptId: string,        // bridge attempt UUID
//     idempotencyKey: string,   // key that created the attempt
//     fencingEpoch: integer,    // monotonic lease generation (>= 1)
//     leaseToken: string,       // scheduler token or adapter-derived marker
//     leaseProvenance: 'scheduler' | 'adapter-initial',
//     runCount: integer,        // heartbeats observed for this session
//     projectId: string,
//     taskId: string,
//     paperclipRunId: string,   // authoritative ctx.runId binding
//     worktreeId: string|null,
//     lastEventId: string|null, // SSE resume cursor into bridge events
//     status: string|null,      // last Paperclip-facing status
//     done: boolean,
//     quarantined: boolean,     // ambiguous fate; needs explicit resolution
//     questionCount: integer
//   }

export const SESSION_VERSION = 2;

export function isValidSessionParams(raw) {
  if (!raw || typeof raw !== 'object') return false;
  return (
    raw.version === SESSION_VERSION &&
    typeof raw.sessionId === 'string' &&
    raw.sessionId.length > 0 &&
    typeof raw.attemptId === 'string' &&
    raw.attemptId.length > 0 &&
    typeof raw.idempotencyKey === 'string' &&
    raw.idempotencyKey.length >= 8 &&
    Number.isInteger(raw.fencingEpoch) &&
    raw.fencingEpoch >= 1 &&
    typeof raw.leaseToken === 'string' &&
    raw.leaseToken.length > 0 &&
    (raw.leaseProvenance === 'scheduler' || raw.leaseProvenance === 'adapter-initial') &&
    Number.isInteger(raw.runCount) &&
    raw.runCount >= 0 &&
    typeof raw.projectId === 'string' &&
    typeof raw.taskId === 'string' &&
    typeof raw.paperclipRunId === 'string' &&
    typeof raw.quarantined === 'boolean'
  );
}

// Plugin-loader convention: sessionCodec validates raw session data,
// serializes for storage, and supplies a display id. Returns null for
// anything unrecognized so the caller can answer clearSession:true.
export const sessionCodec = {
  deserialize(raw) {
    if (isValidSessionParams(raw)) return raw;
    return null;
  },
  serialize(params) {
    if (!isValidSessionParams(params)) {
      throw new Error('cannot serialize invalid session params');
    }
    return JSON.parse(JSON.stringify(params));
  },
  getDisplayId(params) {
    return `orca-session ${params.sessionId}`;
  },
};

// Deterministic idempotency key for (project, task, run, fencingEpoch).
// Same tuple always yields the same key so a retried first-wake replays to
// the same attempt instead of launching a second worker. The epoch is part
// of the key: a fence-and-relaunch is a NEW lease generation and must not
// collide with the fenced generation's key (same key + different payload
// would be a 409 conflict, never a relaunch). Inputs are pre-validated
// path-safe segments (see context.js); never embeds secrets or prompts.
export function idempotencyKeyFor({ projectId, taskId, runId, fencingEpoch = 1 }) {
  if (!Number.isInteger(fencingEpoch) || fencingEpoch < 1) {
    throw new Error('idempotency key requires fencingEpoch >= 1');
  }
  const key = `ff8-${projectId}-${taskId}-${runId}-e${fencingEpoch}`;
  if (key.length < 8 || key.length > 160) {
    throw new Error(`derived idempotency key out of range: ${key.length} chars`);
  }
  return key;
}

// Deterministic idempotency key for an explicitly identified message.
// The caller MUST supply a stable messageId; wall-clock values are rejected
// by the caller (see server/index.js sendMessage).
export function messageKeyFor({ projectId, attemptId, messageId }) {
  const key = `ff8-msg-${projectId}-${attemptId}-${messageId}`;
  if (key.length < 8 || key.length > 160) {
    throw new Error(`derived message key out of range: ${key.length} chars`);
  }
  return key;
}
