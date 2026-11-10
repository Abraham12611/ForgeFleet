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
// clearSession is RETIRED on this adapter: emitting it for a stale,
// corrupt, or mismatched cursor would let the next wake dispatch a second
// worker beside a possibly-live original. Ambiguous sessions quarantine
// (durable journal record + inventory reconcile) instead; binding mismatches
// echo the foreign cursor back verbatim. The result shape still carries the
// pinned clearSession field for compatibility, but execute() never sets it.
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
//                  original dispatch is unknown. NOTHING in the Paperclip
//                  task context can release it — no string, no object, no
//                  proof-shaped data. Release happens only through the
//                  out-of-band recoveryProvider (constructor-injected, off
//                  by default), still gated on bridge-verified old-worker
//                  fate, and a 404/UNKNOWN original NEVER relaunches on this
//                  adapter's own evidence: 404 is not proof of absence.
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
  // Out-of-band recovery authority. `recoveryProvider`, when present, is a
  // function the OPERATOR wires at construction (opaque handle, env/file,
  // or — once the bridge serves it — a client of the proposed authenticated
  // `GET /v1/attempts/:id/recovery-decision` route, which is NOT part of the
  // frozen v0.1 contract and must go through E05 contract review first).
  // It is NEVER read from Paperclip task/config/context input: anything
  // arriving there is untrusted data. Default null means quarantine is
  // terminal — the adapter will never self-release, and recovery becomes an
  // explicit out-of-band owner action (inspect journal/audit, confirm fate
  // on the host, start a new run or retire the key).
  const recoveryProvider =
    typeof options.recoveryProvider === 'function' ? options.recoveryProvider : null;
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
  const NIL_ATTEMPT = '00000000-0000-4000-8000-000000000000';

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
        `Release requires the out-of-band recovery provider (constructor-` +
        `injected, off by default) with bridge-verified old-worker fate; ` +
        `task input authorizes nothing.`,
    );
    return toResult(quarantined, { exitCode: null });
  }

  // Session-less quarantine notice: no cursor exists to resume, so there is
  // nothing to return except the hold itself. Only the out-of-band provider
  // path can proceed from here.
  async function holdWithoutSession(t, qrec) {
    await log(
      t,
      `quarantined (${qrec?.reason ?? 'unknown'}): ${qrec?.detail ?? 'ambiguous worker fate'}. ` +
        `No dispatch will occur without an out-of-band recovery provider resolving this key.`,
    );
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      sessionParams: null,
      quarantined: true,
      quarantineReason: qrec?.reason ?? 'unknown',
      provider: 'muse',
    };
  }

  // Session-loss reconcile (coordinator re-review: clearSession on an
  // ambiguous active session permits a duplicate launch, so it is never
  // emitted). When the incoming cursor exists but is unusable (Paperclip
  // marked it stale, or it fails validation), reconcile against the
  // read-only bridge inventory for THIS task and quarantine durably:
  // a possibly-live worker means holding with its IDs recorded; anything
  // else means holding with fate explicitly unproven. No dispatch, no
  // clearSession, no cursor minted — resumption belongs to the provider
  // adopt path (GET-verified) or a new owner-authorized run.
  async function handleSessionLoss(t, kind, key) {
    let sessions = null;
    let inventoryError = null;
    try {
      sessions = await bridge.listSessions(t.projectId);
    } catch (err) {
      inventoryError = err?.message ?? String(err);
    }
    const matches = (sessions ?? []).filter((s) => s && s.taskId === t.taskId);
    const live = matches.filter((s) => s.state === 'running' || s.state === 'waiting' || s.state === 'unknown');
    const discovered = matches.map((s) => s.externalId ?? s.worktreeId ?? '?');
    const base = {
      fencingEpoch: t.lease.fencingEpoch,
      attemptId: null,
      discovered,
      createdAt: new Date().toISOString(),
    };
    if (inventoryError !== null) {
      journal.writeQuarantine(key, {
        ...base,
        reason: 'session-lost-reconcile-failed',
        detail: `session ${kind}; inventory unreachable (${inventoryError}); fate unknown`,
      });
      await log(t, `session ${kind}: inventory unreachable; quarantined without dispatch or clear`);
      return holdWithoutSession(t, journal.readQuarantine(key));
    }
    if (live.length > 0) {
      journal.writeQuarantine(key, {
        ...base,
        reason: 'session-lost-live-worker',
        detail: `session ${kind}; ${live.length} possibly-live worker(s) for this task — duplicate launch forbidden`,
      });
      await log(
        t,
        `session ${kind}: worker may still run (${discovered.join(', ')}); ` +
          `quarantined without dispatch or clear; status observable via bridge inventory`,
      );
      return holdWithoutSession(t, journal.readQuarantine(key));
    }
    journal.writeQuarantine(key, {
      ...base,
      reason: 'session-lost-fate-unknown',
      detail: `session ${kind}; no live worker found but absence unproven — holding`,
    });
    await log(t, `session ${kind}: no live worker found; fate unproven so quarantined, not cleared`);
    return holdWithoutSession(t, journal.readQuarantine(key));
  }

  // Synthesize a session cursor from a quarantine record so the provider
  // path can resolve a session-less wake against durable state.
  function recordSessionFromQuarantine(t, qrec) {
    const fencingEpoch =
      Number.isInteger(qrec?.fencingEpoch) && qrec.fencingEpoch >= 1 ? qrec.fencingEpoch : 1;
    return {
      version: SESSION_VERSION,
      sessionId: `orca-${t.taskId}-${t.runId}`.slice(0, 128),
      attemptId: typeof qrec?.attemptId === 'string' && qrec.attemptId ? qrec.attemptId : NIL_ATTEMPT,
      idempotencyKey: idempotencyKeyFor({
        projectId: t.projectId,
        taskId: t.taskId,
        runId: t.runId,
        fencingEpoch,
      }),
      fencingEpoch,
      leaseToken: 'unknown',
      leaseProvenance: 'adapter-initial',
      runCount: 0,
      projectId: t.projectId,
      taskId: t.taskId,
      paperclipRunId: t.runId,
      worktreeId: null,
      lastEventId: null,
      status: 'unknown',
      done: false,
      quarantined: true,
      questionCount: 0,
    };
  }

  // Release a quarantined key. Authority NEVER comes from Paperclip task
  // input: the decision is obtained ONLY from the out-of-band
  // recoveryProvider injected at construction (default: none, quarantine
  // terminal). Even a provider decision is still gated on bridge-verified
  // old-worker fate — a live original blocks relaunch unconditionally, and
  // a 404/UNKNOWN original never relaunches on this adapter's own evidence.
  async function resolveRecovery(t, session, qrec, key) {
    const hold = async (why) => {
      await log(t, `recovery refused (${why}); quarantine holds, no worker launched`);
      return toResult({ ...session, runCount: session.runCount + 1 }, { exitCode: null });
    };
    if (!recoveryProvider) {
      return hold('no out-of-band recovery provider; quarantine terminal');
    }
    let d;
    try {
      d = await recoveryProvider({ key, record: qrec, session });
    } catch {
      return hold('recovery provider failed; holding');
    }
    if (!d || typeof d !== 'object') return hold('provider returned no decision; holding');
    if (d.action !== 'fence-and-relaunch' && d.action !== 'adopt-attempt') {
      return hold(`unknown action '${d?.action ?? ''}'`);
    }
    // decidedBy is an UNAUTHENTICATED audit label, never authority: the
    // authority is the provider channel itself plus bridge verification.
    const decidedBy = typeof d.decidedBy === 'string' && d.decidedBy ? d.decidedBy : 'unknown-provider';
    const auditBase = { action: d.action, decidedBy };

    if (d.action === 'adopt-attempt') {
      const target = d.attemptId;
      if (typeof target !== 'string' || !UUID_RE.test(target)) {
        return hold('adopt-attempt requires an attemptId UUID');
      }
      let receipt;
      try {
        receipt = await bridge.getAttempt(target);
      } catch {
        return hold('adopt fate check failed; holding');
      }
      // Re-attach only to a bridge-verified attempt: adoption spawns
      // nothing, so it cannot duplicate — but it must still be real.
      if (receipt === null) return hold(`adopt target ${target} unknown; holding`);
      journal.clearQuarantine(key);
      journal.writeAudit(key, { ...auditBase, attemptId: target, schedulerEpoch: session.fencingEpoch });
      await log(t, `adopted bridge-verified attempt ${target} via out-of-band decision`);
      const adopted = {
        ...session,
        quarantined: false,
        attemptId: target,
        recovery: { ...auditBase, resolvedAt: new Date().toISOString() },
      };
      return resumeWake(t, adopted);
    }

    // fence-and-relaunch: needs a FRESH granted epoch (strictly above the
    // fenced generation) plus its token. Anything stale authorizes nothing.
    const epoch = d.schedulerEpoch;
    if (!Number.isInteger(epoch) || epoch <= session.fencingEpoch) {
      return hold('fresh schedulerEpoch above the fenced generation required');
    }
    if (typeof d.schedulerToken !== 'string' || d.schedulerToken.length === 0) {
      return hold('schedulerToken for the new generation required');
    }
    // Fate check on the ORIGINAL attempt before any new dispatch. A 404 or
    // UNKNOWN original NEVER relaunches here: 404 is not proof of absence,
    // and only bridge-verified termination (a terminal receipt, or — once
    // it exists — the authenticated recovery-decision route) can lift that.
    // Today that means: relaunch requires a terminal original receipt.
    const originalId = session.attemptId;
    if (!originalId || originalId === NIL_ATTEMPT) {
      return hold('no verifiable original attempt; holding');
    }
    let receipt;
    try {
      receipt = await bridge.getAttempt(originalId);
    } catch {
      return hold('original fate check failed; holding');
    }
    if (receipt === null) {
      return hold(`original attempt ${originalId} unknown; 404 is not proof of absence`);
    }
    if (!isTerminalAttemptState(receipt.state)) {
      return hold(`original attempt ${originalId} is ${receipt.state}; refusing a second worker`);
    }
    const relaunched = await dispatchAttempt(
      { ...t, lease: { fencingEpoch: epoch, leaseToken: d.schedulerToken, provenance: 'scheduler' } },
      { fencingEpoch: epoch, journalKey: key },
    );
    // Only a confirmed receipt releases the quarantine.
    journal.clearQuarantine(key);
    const recovery = { ...auditBase, schedulerEpoch: epoch };
    journal.writeAudit(key, { ...recovery, attemptId: relaunched.sessionParams.attemptId });
    await log(
      t,
      `fenced generation ${session.fencingEpoch}; relaunched at epoch ${epoch} ` +
        `(attempt ${relaunched.sessionParams.attemptId})`,
    );
    return {
      ...relaunched,
      sessionParams: { ...relaunched.sessionParams, recovery: { ...recovery, resolvedAt: new Date().toISOString() } },
    };
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
      const key = journalKeyFor(t.projectId, t.taskId, t.runId);

      // Paperclip-marked stale session: the cursor is dead but the worker
      // may be alive. Reconcile + quarantine — never clearSession (the next
      // wake would dispatch a duplicate beside the original).
      if (incoming && incoming.stale === true) {
        return handleSessionLoss(t, 'stale', key);
      }
      if (incoming === null || incoming === undefined) {
        const qrec = journal.readQuarantine(key);
        if (qrec && String(qrec.reason).startsWith('session-lost')) {
          // Refresh the read-only reconcile on every wake: the worker's
          // fate may have changed since the record was written (including
          // across process restarts). Still never clears or dispatches.
          const refreshed = await handleSessionLoss(t, 'recheck', key);
          if (recoveryProvider) {
            try {
              return await resolveRecovery(
                t,
                recordSessionFromQuarantine(t, journal.readQuarantine(key)),
                journal.readQuarantine(key),
                key,
              );
            } catch (err) {
              return toOperationalError(t, err, null);
            }
          }
          return refreshed;
        }
        if (qrec && qrec.reason !== 'intent-changed') {
          // A live ambiguity (unknown attempt, corrupt journal) blocks ALL
          // fresh wakes. resolveRecovery consults ONLY the out-of-band
          // provider (default: none, holds); task input is never authority.
          if (recoveryProvider) {
            try {
              return await resolveRecovery(t, recordSessionFromQuarantine(t, qrec), qrec, key);
            } catch (err) {
              return toOperationalError(t, err, null);
            }
          }
          return holdWithoutSession(t, qrec);
        }
        // Crash-after-acceptance reconcile: a pending intent from a previous
        // wake re-issues the IDENTICAL payload; the bridge replays the
        // original receipt (no duplicate worker).
        const pending = journal.readPending(key);
        if (pending !== null) {
          if (!isValidJournalPending(pending) || stableStringify(pending.payload) !== pending.payloadHash) {
            return quarantineSession(t, null, {
              reason: 'journal-corrupt',
              detail: 'pending dispatch journal failed integrity check',
            });
          }
          // Refuse-if-changed: recompute from CURRENT input. Any drift
          // (instruction, lease, ...) quarantines instead of dispatching
          // either the stale or the edited version.
          if (t.lease.fencingEpoch !== pending.fencingEpoch) {
            return quarantineSession(t, null, {
              reason: 'intent-changed',
              detail: `input lease epoch ${t.lease.fencingEpoch} differs from journaled ${pending.fencingEpoch}`,
            });
          }
          const fresh = buildCreateAttemptRequest(t, pending.idempotencyKey, {
            fencingEpoch: pending.fencingEpoch,
            leaseToken: t.lease.leaseToken,
          });
          if (stableStringify(fresh) !== stableStringify(pending.payload)) {
            return quarantineSession(t, null, {
              reason: 'intent-changed',
              detail: 'task input changed after the journaled dispatch; refusing both versions',
            });
          }
          await log(t, `reconciling pending dispatch ${pending.idempotencyKey} (no new worker)`);
          try {
            const result = await dispatchAttempt(t, {
              fencingEpoch: pending.fencingEpoch,
              journalKey: key,
              reconciling: pending,
            });
            if (qrec && qrec.reason === 'intent-changed') {
              // The drift that caused the quarantine is gone: the retry
              // carries the original intent byte-for-byte, so the ambiguity
              // is resolved by adopting the original — never a new worker.
              journal.clearQuarantine(key);
              journal.writeAudit(key, {
                action: 'reconcile-identical-retry',
                decidedBy: 'adapter:intent-match',
                schedulerEpoch: pending.fencingEpoch,
                attemptId: result.sessionParams.attemptId,
                proof: { kind: 'lease-fenced', detail: 'retry matches journaled intent exactly' },
              });
              await log(t, 'identical retry resolved the intent drift; quarantine cleared');
            }
            return result;
          } catch (err) {
            return toOperationalError(t, err, null);
          }
        }
        if (journal.readQuarantine(key)) {
          // Intent-drift quarantine without pending intent (or any other
          // leftover): fail closed. Only the out-of-band provider path may
          // proceed; task input is never authority.
          if (recoveryProvider) {
            try {
              return await resolveRecovery(
                t,
                recordSessionFromQuarantine(t, journal.readQuarantine(key)),
                journal.readQuarantine(key),
                key,
              );
            } catch (err) {
              return toOperationalError(t, err, null);
            }
          }
          return holdWithoutSession(t, journal.readQuarantine(key));
        }
        try {
          return await dispatchAttempt(t, { fencingEpoch: t.lease.fencingEpoch, journalKey: key });
        } catch (err) {
          return toOperationalError(t, err, null);
        }
      }
      const session = sessionCodec.deserialize(incoming);
      if (!session) {
        // Undecodable cursor: same treatment as stale — reconcile the
        // presented task via inventory and quarantine. Never clear.
        return handleSessionLoss(t, 'undecodable', key);
      }
      // Task binding guard: a session cursor must not be replayed against a
      // different task or Paperclip run (cross-task mutation is forbidden).
      // The foreign cursor is echoed back VERBATIM — preserved for its
      // rightful owner, never cleared, never acted on. Nothing is written
      // to any journal: our own task state is not ambiguous, so there is
      // nothing to quarantine on our side.
      if (
        session.taskId !== t.taskId ||
        session.projectId !== t.projectId ||
        session.paperclipRunId !== t.runId
      ) {
        await log(
          t,
          `binding mismatch: cursor belongs to ${session.projectId}/${session.taskId}/` +
            `${session.paperclipRunId}; refusing without mutation or clear`,
        );
        return {
          exitCode: null,
          signal: null,
          timedOut: false,
          sessionParams: incoming,
          bindingMismatch: true,
          provider: 'muse',
        };
      }
      if (session.quarantined) {
        // Only the out-of-band provider path may proceed; task input — any
        // string, object, or proof-shaped data — is never authority.
        if (recoveryProvider) {
          try {
            return await resolveRecovery(t, session, journal.readQuarantine(key), key);
          } catch (err) {
            return toOperationalError(t, err, session);
          }
        }
        const record = journal.readQuarantine(key);
        await log(
          t,
          `session quarantined (${record?.reason ?? 'unknown'}); quarantine terminal without ` +
            `an out-of-band recovery provider — owner action required`,
        );
        return toResult({ ...session, runCount: session.runCount + 1 }, { exitCode: null });
      }
      try {
        const pending = journal.readPending(key);
        if (pending !== null) {
          await log(t, 'stale pending intent superseded by a live session; leaving it untouched');
        }
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
