// Crash-after-acceptance, quarantine, and safe-finalization tests
// (coordinator review on PR #34; mirrors E15's FF-009 fixture semantics).
// Fixture evidence only: the fake bridge simulates the crash window.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServerAdapter } from '../server/index.js';
import { createFakeBridge } from './fake-bridge.js';
import { makeCtx, nextRuntime } from './helpers.js';

function stagingFor(stateRoot) {
  return join(stateRoot, 'work', 'T-9-run-1');
}

describe('crash recovery, quarantine, safe finalization', () => {
  let cwd;
  let stateRoot;
  let fake;
  let adapter;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'pc-crash-'));
    writeFileSync(join(cwd, 'SEED.md'), '# seed\n');
    writeFileSync(join(cwd, 'KEEP.md'), '# must survive\n');
    stateRoot = mkdtempSync(join(tmpdir(), 'pc-state-'));
    fake = createFakeBridge();
    adapter = createServerAdapter({ stateRoot, fetchImpl: (...a) => fake.fetch(...a) });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  });

  async function wake(overrides = {}, session = null, adapterImpl = adapter) {
    const { ctx, logs } = makeCtx({ cwd, taskId: 'T-9', runId: 'run-1', projectId: 'p9', ...overrides });
    if (session) ctx.runtime = { sessionId: session.sessionId, sessionParams: session.sessionParams };
    return { res: await adapterImpl.execute(ctx), logs };
  }

  it('crash after accept reconciles the original: one worker, staging intact', async () => {
    fake.crashNextCreateAfterAccept();
    // Fresh adapter instance, same input: the "restarted" process.
    const restarted = createServerAdapter({ stateRoot, fetchImpl: (...a) => fake.fetch(...a) });
    const { res: ambiguous } = await wake({}, null, restarted);
    assert.equal(ambiguous.exitCode, 1, 'ambiguous fate surfaces as an error result');
    assert.ok(ambiguous.errorMessage.includes('fate unknown'));
    assert.equal(fake.dispatchCount, 1, 'Orca accepted exactly one dispatch');

    // The journal and staging dir were NOT deleted on the ambiguous path.
    assert.ok(existsSync(join(stateRoot, 'journal', 'pending', 'p9_T-9_run-1.json')));
    assert.ok(existsSync(join(stagingFor(stateRoot), 'SEED.md')));

    // Next wake reconciles: identical re-POST replays the original receipt.
    const { res: recovered } = await wake({}, null, restarted);
    assert.equal(recovered.exitCode, null);
    assert.equal(recovered.sessionParams.status, 'dispatched');
    assert.equal(fake.dispatchCount, 1, 'no second worker spawned');
    assert.ok(existsSync(join(stateRoot, 'journal', 'pending', 'p9_T-9_run-1.json')) === false);
  });

  it('same key + different payload -> conflict result, no side effect', async () => {
    const first = (await wake()).res;
    assert.equal(fake.dispatchCount, 1);
    const { res } = await wake({ config: { instruction: 'CHANGED' } });
    assert.equal(res.exitCode, 1);
    assert.ok(res.errorMessage.includes('idempotency'));
    assert.equal(fake.dispatchCount, 1);
    assert.equal(first.sessionParams.status, 'dispatched');
  });

  it('vanished attempt quarantines; fence-and-relaunch fences the epoch', async () => {
    const first = (await wake()).res;
    fake.attempts.delete(first.sessionParams.attemptId);
    const { res: held, logs } = await wake({}, nextRuntime(first));
    assert.equal(held.exitCode, null, 'quarantine is pending, not failed');
    assert.equal(held.sessionParams.quarantined, true);
    assert.equal(held.sessionParams.status, 'unknown');
    assert.ok(logs.join('\n').includes('quarantined'));
    assert.equal(fake.dispatchCount, 1, 'no duplicate launched while ambiguous');

    // Still quarantined on the next wake without a resolution.
    const again = (await wake({}, nextRuntime(held))).res;
    assert.equal(again.sessionParams.quarantined, true);
    assert.equal(fake.dispatchCount, 1);

    // Explicit owner/coordinator decision: fence and relaunch at epoch+1.
    const relaunched = (
      await wake({ context: { quarantineResolution: 'fence-and-relaunch' } }, nextRuntime(held))
    ).res;
    assert.equal(relaunched.sessionParams.quarantined, false);
    assert.equal(relaunched.sessionParams.fencingEpoch, 2);
    assert.equal(fake.dispatchCount, 2);
  });

  it('adopt-attempt resumes a found attempt, holds on a missing one', async () => {
    const first = (await wake()).res;
    const original = first.sessionParams.attemptId;
    fake.attempts.delete(original);
    const held = (await wake({}, nextRuntime(first))).res;
    assert.equal(held.sessionParams.quarantined, true);

    const missing = (
      await wake(
        { context: { quarantineResolution: 'adopt-attempt:00000000-0000-4000-8000-000000000099' } },
        nextRuntime(held),
      )
    ).res;
    assert.equal(missing.sessionParams.quarantined, true, 'quarantine holds when target is gone');

    // The "original" reappears (external discovery); adopt it explicitly.
    fake.attempts.set(original, {
      attemptId: original,
      projectId: 'p9',
      paperclipTaskId: 'T-9',
      state: 'running',
      observedAt: new Date().toISOString(),
      orcaRunId: 'fake-run-1',
      orcaTaskId: 'fake-task-1',
      orcaDispatchId: 'fake-dispatch-1',
      worktreeId: 'fake-worktree-1',
      errorCode: null,
    });
    const adopted = (
      await wake({ context: { quarantineResolution: `adopt-attempt:${original}` } }, nextRuntime(held))
    ).res;
    assert.equal(adopted.sessionParams.quarantined, false);
    assert.equal(adopted.sessionParams.attemptId, original);
    assert.equal(adopted.sessionParams.status, 'running');
    assert.equal(fake.dispatchCount, 1, 'adopting never spawns');
  });

  it('terminal receipt + failed sync-back: no completion, local cwd intact', async () => {
    const first = (await wake()).res;
    fake.advanceAttempt(first.sessionParams.attemptId, 'finished');
    rmSync(stagingFor(stateRoot), { recursive: true, force: true });
    const { res } = await wake({}, nextRuntime(first));
    assert.equal(res.exitCode, 1);
    assert.ok(res.errorMessage.includes('workspace_finalize=failed'));
    assert.equal(res.sessionParams.done, false, 'no completion reported');
    // Safe finalization: pre-existing local files untouched, no RESULT written.
    assert.equal(readFileSync(join(cwd, 'KEEP.md'), 'utf8'), '# must survive\n');
    assert.ok(!existsSync(join(cwd, 'RESULT.md')));
    assert.deepEqual(readdirSync(cwd).sort(), ['KEEP.md', 'SEED.md']);
  });

  it('unverified capability fails closed with zero dispatches', async () => {
    fake.setProviderStatus('muse', 'unsupported', 'no supervised launch in this build');
    const { res } = await wake();
    assert.equal(res.exitCode, 1);
    assert.ok(res.errorMessage.includes('refusing dispatch'));
    assert.equal(fake.dispatchCount, 0);
  });

  it('cancel requires an authorized actor; authorized cancel is requested-not-confirmed', async () => {
    const first = (await wake()).res;
    const noActor = makeCtx({ cwd, taskId: 'T-9', runId: 'run-1', projectId: 'p9' });
    noActor.ctx.runtime = nextRuntime(first);
    await assert.rejects(adapter.cancel(noActor.ctx), /requires context.cancel/);
    const ok = makeCtx({
      cwd,
      taskId: 'T-9',
      runId: 'run-1',
      projectId: 'p9',
      context: { cancel: { reason: 'no longer needed', approvedBy: 'owner:alice' } },
    });
    ok.ctx.runtime = nextRuntime(first);
    const res = await adapter.cancel(ok.ctx);
    assert.equal(res.status, 'cancelling');
    assert.equal(fake.cancels.length, 1);
    assert.equal(fake.cancels[0].approvedBy, 'owner:alice');
  });

  it('sendMessage requires a stable caller-supplied messageId', async () => {
    const first = (await wake()).res;
    const noId = makeCtx({
      cwd,
      taskId: 'T-9',
      runId: 'run-1',
      projectId: 'p9',
      context: { message: { threadId: 'th-1', actorId: 'owner:alice', body: 'proceed' } },
    });
    noId.ctx.runtime = nextRuntime(first);
    await assert.rejects(adapter.sendMessage(noId.ctx), /requires context.message.messageId/);

    const ok = makeCtx({
      cwd,
      taskId: 'T-9',
      runId: 'run-1',
      projectId: 'p9',
      context: {
        message: { messageId: 'msg-42', threadId: 'th-1', actorId: 'owner:alice', body: 'proceed', kind: 'instruction' },
      },
    });
    ok.ctx.runtime = nextRuntime(first);
    const res = await adapter.sendMessage(ok.ctx);
    assert.equal(res.delivered, 'queued');
    assert.equal(fake.messages.length, 1);
    // Same stable id replays to the same bridge key (no wall-clock keys).
    const again = makeCtx({
      cwd,
      taskId: 'T-9',
      runId: 'run-1',
      projectId: 'p9',
      context: {
        message: { messageId: 'msg-42', threadId: 'th-1', actorId: 'owner:alice', body: 'proceed', kind: 'instruction' },
      },
    });
    again.ctx.runtime = nextRuntime(first);
    await adapter.sendMessage(again.ctx);
    assert.equal(fake.messages.length, 2);
  });

  it('adapter source contains no remote-push invocation', () => {
    const out = execFileSync('node', ['check-no-push.mjs'], {
      cwd: new URL('..', import.meta.url),
    }).toString();
    assert.match(out, /OK: no remote-push/);
  });
});
