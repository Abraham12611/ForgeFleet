// Pinned-context extraction for the Paperclip Orca adapter (FF-008).
//
// Authority: AdapterExecutionContext / AdapterExecutionResult as documented
// in the pinned upstream tag v2026.1106.0
// (docs/adapters/creating-an-adapter.md: runId, agent,
// runtime:{sessionId, sessionParams}, config, context, onLog/onMeta/onSpawn).
// No upstream code is vendored here; field names below mirror that document.
//
// Identity rules (coordinator review on PR #34):
// - runId, context.taskId, context.projectId, context.cwd are REQUIRED.
//   The adapter never fabricates them (no 'r1' / 'default-project').
// - fencingEpoch / leaseToken come from context.lease when the scheduler
//   provides one (provenance 'scheduler'); otherwise the adapter opens
//   generation 1 explicitly marked 'adapter-initial'. Production dispatch
//   must pass the scheduler lease (E08/E09); the marker makes the fallback
//   auditable instead of silent.
// - Path-derived values (journal keys, staging dirs) accept only
//   [A-Za-z0-9_-] segments (see workspace.js); anything else is a loud
//   invalid_context error, never silent mangling.

import { InvalidContextError } from './errors.js';

export const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function asString(value) {
  return typeof value === 'string' ? value : null;
}

function requiredString(value, field) {
  const s = asString(value);
  if (s === null || s.length === 0) {
    throw new InvalidContextError(`execution context requires ${field}`);
  }
  return s;
}

function optionalString(value, fallback = '') {
  const s = asString(value);
  return s === null ? fallback : s;
}

function segment(value, field) {
  const s = requiredString(value, field);
  if (!SEGMENT_RE.test(s)) {
    throw new InvalidContextError(
      `${field} must match [A-Za-z0-9_-] (got ${s.length} chars, rejected for path safety)`,
    );
  }
  return s;
}

function readLease(context) {
  const lease = context?.lease;
  if (lease === null || lease === undefined) {
    return { fencingEpoch: 1, leaseToken: null, provenance: 'adapter-initial' };
  }
  if (typeof lease !== 'object') {
    throw new InvalidContextError('context.lease must be an object');
  }
  const fencingEpoch = lease.fencingEpoch;
  if (!Number.isInteger(fencingEpoch) || fencingEpoch < 1) {
    throw new InvalidContextError('context.lease.fencingEpoch must be an integer >= 1');
  }
  const leaseToken = requiredString(lease.leaseToken, 'context.lease.leaseToken');
  return { fencingEpoch, leaseToken, provenance: 'scheduler' };
}

// Normalize one pinned AdapterExecutionContext into the task record the
// adapter core operates on. Throws invalid_context on shape violations.
export function readExecutionContext(ctx) {
  if (!ctx || typeof ctx !== 'object') {
    throw new InvalidContextError('execute requires an AdapterExecutionContext object');
  }
  const runtime = ctx.runtime;
  if (!runtime || typeof runtime !== 'object') {
    throw new InvalidContextError('execution context requires runtime.{sessionId, sessionParams}');
  }
  const config = ctx.config && typeof ctx.config === 'object' ? ctx.config : {};
  const context = ctx.context && typeof ctx.context === 'object' ? ctx.context : {};

  const runId = segment(ctx.runId, 'runId');
  const taskId = segment(context.taskId, 'context.taskId');
  const projectId = segment(context.projectId, 'context.projectId');
  const cwd = requiredString(context.cwd, 'context.cwd');

  const lease = readLease(context);
  // Recovery input: the task context carries NO recovery authority at all.
  // Any `recoveryDecision`/`quarantineResolution` field arriving here is
  // untrusted data and is deliberately dropped, never read. Release of a
  // quarantined key happens only through the out-of-band recoveryProvider
  // injected at adapter construction (see server/index.js), or not at all.
  const onLog = typeof ctx.onLog === 'function' ? ctx.onLog : null;

  return {
    runId,
    taskId,
    projectId,
    cwd,
    title: optionalString(config.taskTitle ?? context.title, taskId),
    instruction: optionalString(config.instruction ?? context.instruction, ''),
    workerKind: optionalString(config.workerKind ?? context.workerKind, 'muse'),
    contextManifestId: optionalString(config.contextManifestId ?? context.contextManifestId, 'none'),
    repositoryId: asString(config.repositoryId ?? context.repositoryId),
    artifactMarker: asString(context.artifactMarker),
    lease,
    cancel: context.cancel && typeof context.cancel === 'object' ? context.cancel : null,
    message: context.message && typeof context.message === 'object' ? context.message : null,
    agent: ctx.agent && typeof ctx.agent === 'object' ? ctx.agent : null,
    onLog,
  };
}
