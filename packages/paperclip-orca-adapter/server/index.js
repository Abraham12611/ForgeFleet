// External Paperclip adapter: Orca execution backend (FF-008, E04).
//
// Plugin-loader convention: this module (./server/index.js) exports
// `createServerAdapter`. execute() receives ONE pinned
// AdapterExecutionContext ({runId, agent, runtime:{sessionId, sessionParams},
// config, context, onLog, ...}) and returns an AdapterExecutionResult
// ({exitCode, signal, timedOut, errorMessage?, sessionParams?,
// sessionDisplayId?, provider?, clearSession?}).
// Authority: pinned upstream tag v2026.1106.0,
// docs/adapters/creating-an-adapter.md (no upstream code vendored).
//
// Status reaches Paperclip through sessionParams (persisted across
// heartbeats) plus onLog progress lines: the pinned result carries no
// free-form status field. exitCode null = still running (wake again);
// 0 = worker output submitted for review; 1 = terminal failure.
//
// Round-trip per wake (execute never blocks on worker completion):
//   first wake  -> capability gate -> journal intent -> stage cwd ->
//                  POST /v1/attempts (identical re-POST reconciles a crash)
//   later wakes -> GET attempt (reconcile, never re-POST) -> apply events
//                  since lastEventId (dedupe + fencing) -> result out
//   terminal    -> restore workspace into local cwd -> result out
//                  (sync-back failure returns workspace_finalize=failed and
//                  reports NO completion, gating dependent work)
//   ambiguous   -> QUARANTINE (never silent clearSession): the fate of the
//                  original dispatch is unknown, so only an explicit
//                  quarantineResolution may fence-and-relaunch or adopt.
//
// Crash-after-acceptance: dispatch intent (idempotency key + exact payload)
// is journaled atomically BEFORE POSTing. On POST failure the staging dir
// and journal are LEFT INTACT — a confirmed-live worker may still own them.
// The next wake with the same (project, task, run) re-issues the identical
// payload and the bridge replays the original receipt: exactly one worker.
//
// No git remote is used anywhere in this package (static check:
// check-no-push.mjs). Bridge token comes from options/env, never from task
// input, and is never logged or echoed into outputs.

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCreateAttemptRequest,
  createBridgeClient,
  DEFAULT_BRIDGE_URL,
} from '../src/bridge-client.js';
import { readExecutionContext } from '../src/context.js';
import {
  BridgeRejectedError,
  CapabilityError,
  IdempotencyConflictError,
  WorkspaceFinalizeError,
} from '../src/errors.js';
import { createJournal, isValidJournalPending, journalKeyFor, stableStringify } from '../src/journal.js';
import {
  idempotencyKeyFor,
  messageKeyFor,
  sessionCodec,
  SESSION_VERSION,
} from '../src/session.js';
import {
  applyBridgeEvent,
  createEventTracker,
  isTerminalAttemptState,
  mapAttemptState,
} from '../src/status-map.js';
import {
  cleanupRemoteDir,
  defaultStateRoot,
  prepareWorkspaceForExecution,
  resolveRemoteDir,
  restoreWorkspaceFromExecution,
} from '../src/workspace.js';

export { sessionCodec };

export const ADAPTER_TYPE = 'forgefleet-orca';
export const ADAPTER_VERSION = '0.1.0';

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function errorResult(errorMessage, sessionParams = null, sessionId = null) {
  const result = {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorMessage,
    provider: 'muse',
  };
  if (sessionParams !== null) {
    result.sessionParams = sessionParams;
    result.sessionDisplayId = sessionCodec.getDisplayId(sessionParams);
  }
  if (sessionId !== null) result.sessionId = sessionId;
  return result;
}

export function createServerAdapter(options = {}) {
  const stateRoot = options.stateRoot ?? defaultStateRoot();
  const journal = createJournal(stateRoot);
  const bridge =
    options.bridgeClient ??
    createBridgeClient({
      baseUrl: options.bridgeBaseUrl ?? process.env.FORGEFLEET_BRIDGE_URL ?? DEFAULT_BRIDGE_URL,
      token: options.bridgeToken ?? process.env.FORGEFLEET_BRIDGE_TOKEN ?? '',
      fetchImpl: options.fetchImpl,
    });
  const workerKindDefault = options.workerKind ?? 'muse';

  async function log(t, chunk) {
    if (t.onLog) {
      try {
        await t.onLog('stdout', chunk);
      } catch {
        // logging must never fail the wake
      }
    }
  }

  function sessionBase(t, { sessionId, attemptId, idempotencyKey, fencingEpoch, worktreeId }) {
    return {
      version: SESSION_VERSION,
      sessionId,
      attemptId,
      idempotencyKey,
      fencingEpoch,
      leaseToken: t.lease.leaseToken ?? `adapter:${idempotencyKey}`,
      leaseProvenance: t.lease.provenance,
      runCount: 1,
      projectId: t.projectId,
      taskId: t.taskId,
      paperclipRunId: t.runId,
      worktreeId: worktreeId ?? null,
      lastEventId: null,
      status: null,
      done: false,
      quarantined: false,
      questionCount: 0,
    };
  }

  function toResult(sessionParams, { exitCode, errorMessage = undefined }) {
    const result = {
      exitCode,
      signal: null,
      timedOut: false,
      sessionParams,
      sessionDisplayId: sessionCodec.getDisplayId(sessionParams),
      provider: 'muse',
    };
    if (errorMessage !== undefined) result.errorMessage = errorMessage;
    return result;
  }

  // ---- first wake / fence-and-relaunch ---------------------------------
  async function dispatchAttempt(t, { fencingEpoch, journalKey, reconciling = null }) {
    // Fail closed on capability BEFORE any side effect: never guess flags.
    await bridge.checkCapabilities(t.workerKind);
    const idempotencyKey = reconciling?.idempotencyKey ?? idempotencyKeyFor({
      projectId: t.projectId,
      taskId: t.taskId,
      runId: t.runId,
      fencingEpoch,
    });
    const payload =
      reconciling?.payload ??
      buildCreateAttemptRequest(t, idempotencyKey, {
        fencingEpoch,
        leaseToken: t.lease.leaseToken,
      });
    const payloadHash = stableStringify(payload);
    const remoteDir = resolveRemoteDir(stateRoot, t.taskId, t.runId);

    if (!reconciling) {
      journal.writePending(journalKey, {
        idempotencyKey,
        payload,
        payloadHash,
        remoteDir,
        fencingEpoch,
        createdAt: new Date().toISOString(),
      });
      prepareWorkspaceForExecution(t.cwd, remoteDir);
    } else if (stableStringify(reconciling.payload) !== reconciling.payloadHash) {
      throw new Error('journal payload integrity failure; refusing dispatch');
    }

    let receipt;
    try {
      receipt = await bridge.createAttempt(payload, idempotencyKey);
    } catch (err) {
      // AMBIGUOUS FATE (timeout, crash window): leave the journal AND the
      // staging dir intact. A confirmed-live worker may still own them;
      // the next wake reconciles via the identical payload. Never delete,
      // never relaunch here.
      throw err;
    }
    journal.clearPending(journalKey);
    const sessionId = `orca-${t.taskId}-${t.runId}`.slice(0, 128);
    const sessionParams = {
      ...sessionBase(t, {
        sessionId,
        attemptId: receipt.attemptId,
        idempotencyKey,
        fencingEpoch,
        worktreeId: receipt.worktreeId,
      }),
      status: mapAttemptState(receipt.state),
    };
    await log(t, `dispatched ${t.workerKind} worker (attempt ${receipt.attemptId})`);
    return toResult(sessionParams, { exitCode: null });
  }

  // ---- resume ------------------------------------------------------------
  async function resumeWake(t, session) {
    // Reconcile the ORIGINAL attempt first: never POST a second dispatch
    // for a session that already owns one (restart/no-duplicate rule).
    const receipt = await bridge.getAttempt(session.attemptId);
    if (receipt === null) {
      return quarantineSession(t, session, {
        reason: 'attempt-unknown-to-bridge',
        detail: `bridge has no record of attempt ${session.attemptId}`,
      });
    }
    const tracker = createEventTracker();
    const frames = await bridge.streamEvents(session.lastEventId);
    for (const frame of frames) applyBridgeEvent(tracker, frame, session);

    const status = tracker.status ?? mapAttemptState(receipt.state);
    if (tracker.pendingQuestions.length > 0) {
      await log(
        t,
        `${tracker.pendingQuestions.length} question(s) awaiting owner (attempt ${session.attemptId})`,
      );
    }
    const sessionParams = {
      ...session,
      runCount: session.runCount + 1,
      worktreeId: receipt.worktreeId ?? session.worktreeId,
      lastEventId: tracker.lastEventId ?? session.lastEventId,
      status,
      questionCount: session.questionCount + tracker.pendingQuestions.length,
    };

    if (!isTerminalAttemptState(receipt.state)) {
      await log(t, `worker ${session.attemptId}: ${status}`);
      return toResult(sessionParams, { exitCode: null });
    }

    // Sync-back BEFORE reporting completion: a failed restore returns
    // workspace_finalize=failed and reports no completion, so dependent
    // tasks stay gated per the state-machine invariant.
    const remoteDir = resolveRemoteDir(stateRoot, t.taskId, t.runId);
    try {
      restoreWorkspaceFromExecution(remoteDir, t.cwd, { expectMarker: t.artifactMarker });
    } catch (err) {
      const failed = new WorkspaceFinalizeError(t.taskId, err.message);
      await log(t, failed.message);
      return toResult({ ...sessionParams, status }, { exitCode: 1, errorMessage: failed.message });
    }
    // Confirmed terminal restore: only now is cleanup safe.
    cleanupRemoteDir(remoteDir);
    const doneParams = { ...sessionParams, status, done: true };
    if (status === 'submitted') {
      await log(t, `artifact ready for review (attempt ${session.attemptId}; runtime completion != verified)`);
      return toResult(doneParams, { exitCode: 0 });
    }
    await log(t, `worker ${status} (attempt ${session.attemptId})`);
    return toResult(doneParams, {
      exitCode: 1,
      errorMessage: `worker ${status}: attempt ${session.attemptId}`,
    });
  }

  // ---- quarantine ----------------------------------------------------------
  async function quarantineSession(t, session, { reason, detail }) {
    const key = journalKeyFor(t.projectId, t.taskId, t.runId);
    journal.writeQuarantine(key, {
      reason,
      detail,
      attemptId: session?.attemptId ?? null,
      fencingEpoch: session?.fencingEpoch ?? t.lease.fencingEpoch,
      createdAt: new Date().toISOString(),
    });
    const quarantined = {
      ...(session ??
        sessionBase(t, {
          sessionId: `orca-${t.taskId}-${t.runId}`.slice(0, 128),
          attemptId: '00000000-0000-4000-8000-000000000000',
          idempotencyKey: idempotencyKeyFor({
            projectId: t.projectId,
            taskId: t.taskId,
            runId: t.runId,
            fencingEpoch: t.lease.fencingEpoch,
          }),
          fencingEpoch: t.lease.fencingEpoch,
          worktreeId: null,
        })),
      runCount: (session?.runCount ?? 0) + 1,
      status: 'unknown',
      quarantined: true,
    };
    await log(
      t,
      `quarantined: ${detail}. Ambiguous worker fate; no duplicate launched. ` +
        `Resolve with context.quarantineResolution 'fence-and-relaunch' or 'adopt-attempt:<uuid>'.`,
    );
    return toResult(quarantined, { exitCode: null });
  }

  async function resolveQuarantine(t, session) {
    const key = journalKeyFor(t.projectId, t.taskId, t.runId);
    const record = journal.readQuarantine(key);
    if (!record) {
      await log(t, 'quarantineResolution supplied but no quarantine record exists; ignoring');
      return resumeWake(t, { ...session, quarantined: false });
    }
    const resolution = t.quarantineResolution;
    if (resolution === 'fence-and-relaunch') {
      // Fence the prior generation: the new attempt runs at epoch+1 and
      // stale events from the old generation stay ignored.
      const fencingEpoch = session.fencingEpoch + 1;
      journal.clearQuarantine(key);
      await log(t, `fencing prior generation ${session.fencingEpoch}; relaunching at epoch ${fencingEpoch}`);
      return dispatchAttempt({ ...t, lease: { ...t.lease, fencingEpoch } }, { fencingEpoch, journalKey: key });
    }
    const adopt = resolution?.startsWith('adopt-attempt:') ? resolution.slice('adopt-attempt:'.length) : null;
    if (adopt && UUID_RE.test(adopt)) {
      const receipt = await bridge.getAttempt(adopt);
      if (receipt === null) {
        await log(t, `adopt-attempt target ${adopt} still unknown; quarantine holds`);
        return toResult({ ...session, runCount: session.runCount + 1 }, { exitCode: null });
      }
      journal.clearQuarantine(key);
      await log(t, `adopted attempt ${adopt} after explicit resolution`);
      return resumeWake(t, { ...session, quarantined: false, attemptId: adopt });
    }
    await log(t, `unknown quarantineResolution '${resolution ?? ''}'; quarantine holds`);
    return toResult({ ...session, runCount: session.runCount + 1 }, { exitCode: null });
  }

  // ---- module ---------------------------------------------------------------
  return {
    type: ADAPTER_TYPE,
    version: ADAPTER_VERSION,
    // Capability flags per the pinned doc: explicit false (external adapters
    // that omit flags default to false; declare so GET /api/adapters is
    // truthful). No skills sync: derived supportsSkills stays false.
    supportsLocalAgentJwt: false,
    supportsInstructionsBundle: false,
    requiresMaterializedRuntimeSkills: false,
    sessionCodec,

    async execute(ctx) {
      const t = readExecutionContext(ctx);
      if (!t.workerKind) t.workerKind = workerKindDefault;
      const incoming = ctx.runtime?.sessionParams ?? null;

      // Unknown/stale session: force a fresh session on next wake.
      if (incoming && incoming.stale === true) {
        return { exitCode: null, signal: null, timedOut: false, sessionParams: null, clearSession: true };
      }
      if (incoming === null || incoming === undefined) {
        const key = journalKeyFor(t.projectId, t.taskId, t.runId);
        // Crash-after-acceptance reconcile: a pending intent from a previous
        // wake re-issues the IDENTICAL payload; the bridge replays the
        // original receipt (no duplicate worker).
        const pending = journal.readPending(key);
        if (pending !== null) {
          if (!isValidJournalPending(pending)) {
            return quarantineSession(t, null, {
              reason: 'journal-corrupt',
              detail: 'pending dispatch journal failed integrity check',
            });
          }
          await log(t, `reconciling pending dispatch ${pending.idempotencyKey} (no new worker)`);
          try {
            return await dispatchAttempt(t, {
              fencingEpoch: pending.fencingEpoch,
              journalKey: key,
              reconciling: pending,
            });
          } catch (err) {
            return toOperationalError(t, err, null);
          }
        }
        try {
          return await dispatchAttempt(t, { fencingEpoch: t.lease.fencingEpoch, journalKey: key });
        } catch (err) {
          return toOperationalError(t, err, null);
        }
      }
      const session = sessionCodec.deserialize(incoming);
      if (!session) {
        return { exitCode: null, signal: null, timedOut: false, sessionParams: null, clearSession: true };
      }
      // Task binding guard: a session cursor must not be replayed against a
      // different task or Paperclip run (cross-task mutation is forbidden).
      if (
        session.taskId !== t.taskId ||
        session.projectId !== t.projectId ||
        session.paperclipRunId !== t.runId
      ) {
        return { exitCode: null, signal: null, timedOut: false, sessionParams: null, clearSession: true };
      }
      if (session.quarantined) {
        if (t.quarantineResolution) return resolveQuarantine(t, session);
        const key = journalKeyFor(t.projectId, t.taskId, t.runId);
        const record = journal.readQuarantine(key);
        await log(
          t,
          `session quarantined (${record?.reason ?? 'unknown'}); awaiting explicit quarantineResolution`,
        );
        return toResult({ ...session, runCount: session.runCount + 1 }, { exitCode: null });
      }
      try {
        return await resumeWake(t, session);
      } catch (err) {
        return toOperationalError(t, err, session);
      }
    },

    // Read-only pre-run validation (pinned "Step 3: Environment Test").
    // Never dispatches; reports structured diagnostics.
    async testEnvironment(config = {}) {
      const checks = [];
      try {
        const caps = await bridge.checkCapabilities(config.workerKind ?? workerKindDefault);
        checks.push({ name: 'bridge-reachable', level: 'pass', detail: `cli ${caps.cliVersion ?? 'unknown'}` });
        checks.push({ name: 'provider-verified', level: 'pass', detail: config.workerKind ?? workerKindDefault });
        return { ok: true, checks };
      } catch (err) {
        checks.push({ name: 'environment', level: 'fail', detail: err.message });
        return { ok: false, checks };
      }
    },

    // Explicit cancel path (requires an authorized actor id; 202 means
    // requested, runtime confirmation arrives via events, never assumed).
    async cancel(ctx) {
      const t = readExecutionContext(ctx);
      const session = sessionCodec.deserialize(ctx.runtime?.sessionParams ?? null);
      if (!session || session.quarantined) {
        throw new Error('cancel requires a live (non-quarantined) session');
      }
      const reason = t.cancel?.reason;
      const approvedBy = t.cancel?.approvedBy;
      if (!reason || !approvedBy) throw new Error('cancel requires context.cancel.{reason, approvedBy}');
      const key = messageKeyFor({
        projectId: t.projectId,
        attemptId: session.attemptId,
        messageId: `cancel-${session.fencingEpoch}`,
      });
      await bridge.cancelAttempt(session.attemptId, { reason, approvedBy, idempotencyKey: key });
      await log(t, `cancel requested for attempt ${session.attemptId} (confirmation via events)`);
      return { sessionId: session.sessionId, status: 'cancelling' };
    },

    // Explicit message path (worker/question routing goes through the
    // bridge; never delivered straight to a runtime). messageId is a
    // stable caller-supplied id — never a wall-clock value.
    async sendMessage(ctx) {
      const t = readExecutionContext(ctx);
      const session = sessionCodec.deserialize(ctx.runtime?.sessionParams ?? null);
      if (!session || session.quarantined) {
        throw new Error('sendMessage requires a live (non-quarantined) session');
      }
      const m = t.message;
      const messageId = m?.messageId;
      if (typeof messageId !== 'string' || messageId.length === 0) {
        throw new Error('sendMessage requires context.message.messageId (stable caller-supplied id)');
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(messageId)) {
        throw new Error('sendMessage messageId must match [A-Za-z0-9_-]');
      }
      const key = messageKeyFor({ projectId: t.projectId, attemptId: session.attemptId, messageId });
      await bridge.sendAttemptMessage(
        session.attemptId,
        {
          projectId: t.projectId,
          threadId: m.threadId,
          actorId: m.actorId,
          body: m.body,
          kind: m.kind ?? 'update',
        },
        key,
      );
      await log(t, `message ${messageId} queued for attempt ${session.attemptId}`);
      return { sessionId: session.sessionId, delivered: 'queued' };
    },
  };

  // Operational failures (bridge rejection, conflict, capability, transport)
  // are returned as error results — the pinned AdapterExecutionResult
  // channel — never thrown, so Paperclip records them against the run.
  function toOperationalError(t, err, session) {
    if (err instanceof CapabilityError) {
      return errorResult(err.message, session, session?.sessionId ?? null);
    }
    if (err instanceof IdempotencyConflictError) {
      return errorResult(
        `${err.message} (key held by another request; resolve manually, no auto-retry)`,
        session,
        session?.sessionId ?? null,
      );
    }
    if (err instanceof BridgeRejectedError) {
      return errorResult(err.message, session, session?.sessionId ?? null);
    }
    if (err?.code === 'invalid_context') throw err;
    return errorResult(`bridge transport failure (fate unknown; intent journaled): ${err?.message ?? err}`, session, session?.sessionId ?? null);
  }
}

// Default export for the plugin loader: reads env config.
export default createServerAdapter();
