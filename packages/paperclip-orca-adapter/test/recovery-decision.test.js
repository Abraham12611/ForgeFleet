// Recovery-decision authorization tests (coordinator follow-up on 4a2e24b).
//
// The Paperclip task context is UNTRUSTED for recovery: a bare
// `quarantineResolution` string must never launch a worker. Release requires
// a structured recoveryDecision (fresh scheduler epoch + token, decidedBy,
// proof) AND verification of the old worker's fate. Fixture evidence only.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerAdapter } from '../server/index.js';
import { createFakeBridge } from './fake-bridge.js';
import { makeCtx, nextRuntime } from './helpers.js';

const TASK = { taskId: 'T-7', runId: 'run-1', projectId: 'p7' };

function decision(overrides = {}) {
  return {
    action: 'fence-and-relaunch',
    decidedBy: 'owner:alice',
    decidedAt: '2026-11-09T12:00:00Z',
    schedulerEpoch: 2,
    schedulerToken: 'sched-tok-new',
    proof: { kind: 'operator-attested', detail: 'old worker confirmed dead on host console' },
    ...overrides,
  };
}

describe('recovery decision authorization', () => {
  let cwd;
  let stateRoot;
  let fake;
  let adapter;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'pc-rec-'));
    writeFileSync(join(cwd, 'SEED.md'), '# seed\n');
    stateRoot = mkdtempSync(join(tmpdir(), 'pc-state-'));
    fake = createFakeBridge();
    adapter = createServerAdapter({ stateRoot, fetchImpl: (...a) => fake.fetch(...a) });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  });

  async function wake(overrides = {}, session = null) {
    const { ctx, logs } = makeCtx({ cwd, ...TASK, ...overrides });
    if (session) ctx.runtime = { sessionId: session.sessionId, sessionParams: session.sessionParams };
    return { res: await adapter.execute(ctx), logs };
  }

  async function quarantinedSession() {
    const first = (await wake()).res;
    fake.attempts.delete(first.sessionParams.attemptId);
    const held = (await wake({}, nextRuntime(first))).res;
    assert.equal(held.sessionParams.quarantined, true);
    return held.sessionParams;
  }

  it('bare-string resolution is dead: no worker launches', async () => {
    const q = await quarantinedSession();
    const res = (
      await wake({ context: { quarantineResolution: 'fence-and-relaunch' } }, nextRuntime({ sessionParams: q }))
    ).res;
    assert.equal(res.sessionParams.quarantined, true, 'quarantine holds');
    assert.equal(fake.dispatchCount, 1, 'untrusted string launches nothing');
  });

  it('relaunch refused while the old worker is still running', async () => {
    const first = (await wake()).res;
    const liveId = first.sessionParams.attemptId;
    const receipt = fake.attempts.get(liveId);
    fake.advanceAttempt(liveId, 'running');
    // Bridge transiently loses the record -> quarantine ...
    fake.attempts.delete(liveId);
    const q = (await wake({}, nextRuntime(first))).res.sessionParams;
    assert.equal(q.quarantined, true);
    // ... but at decision time the ORIGINAL worker is provably alive:
    // a second worker beside it is forbidden.
    fake.attempts.set(liveId, { ...receipt, state: 'running' });
    const res = (
      await wake({ context: { recoveryDecision: decision() } }, nextRuntime({ sessionParams: q }))
    ).res;
    assert.equal(res.sessionParams.quarantined, true, 'holds while old worker lives');
    assert.equal(fake.dispatchCount, 1, 'no second worker beside the live one');
  });

  it('relaunch after proven-terminal original uses the fresh granted epoch', async () => {
    const first = (await wake()).res;
    const id = first.sessionParams.attemptId;
    fake.advanceAttempt(id, 'finished');
    // Bridge loses the record post-mortem; operator attests the observed
    // terminal state (the adapter cannot take 'attempt-terminal' on faith
    // together with a 404 — that combination holds).
    fake.attempts.delete(id);
    const q = (await wake({}, nextRuntime(first))).res.sessionParams;
    assert.equal(q.quarantined, true);
    const res = (
      await wake(
        {
          context: {
            recoveryDecision: decision({
              proof: { kind: 'operator-attested', detail: 'finished event observed pre-loss; host console clear' },
            }),
          },
        },
        nextRuntime({ sessionParams: q }),
      )
    ).res;
    assert.equal(res.sessionParams.quarantined, false);
    assert.equal(res.sessionParams.fencingEpoch, 2);
    assert.equal(res.sessionParams.leaseToken, 'sched-tok-new');
    assert.equal(res.sessionParams.leaseProvenance, 'scheduler');
    assert.equal(res.sessionParams.recovery.decidedBy, 'owner:alice');
    assert.equal(fake.dispatchCount, 2);
  });

  it('stale epoch, missing token/proof/decidedBy all hold the quarantine', async () => {
    const q = await quarantinedSession();
    for (const bad of [
      decision({ schedulerEpoch: 1 }),
      decision({ schedulerToken: '' }),
      decision({ decidedBy: '' }),
      { action: 'fence-and-relaunch' },
      decision({ proof: { kind: 'vibes', detail: 'trust me' } }),
      decision({ proof: { kind: 'attempt-terminal', detail: 'claims terminal but bridge 404s' } }),
    ]) {
      const res = (await wake({ context: { recoveryDecision: bad } }, nextRuntime({ sessionParams: q }))).res;
      assert.equal(res.sessionParams.quarantined, true, JSON.stringify(bad)?.slice(0, 80));
    }
    assert.equal(fake.dispatchCount, 1);
  });

  it('adopt-attempt via decision resumes a live worker without spawning', async () => {
    const first = (await wake()).res;
    const id = first.sessionParams.attemptId;
    const receipt = fake.attempts.get(id);
    fake.advanceAttempt(id, 'running');
    fake.attempts.delete(id);
    const q = (await wake({}, nextRuntime(first))).res.sessionParams;
    assert.equal(q.quarantined, true);
    fake.attempts.set(id, { ...receipt, state: 'running' });
    const res = (
      await wake(
        {
          context: {
            recoveryDecision: {
              action: 'adopt-attempt',
              attemptId: id,
              decidedBy: 'owner:alice',
              proof: { kind: 'lease-fenced', detail: 'scheduler confirms single active generation' },
            },
          },
        },
        nextRuntime({ sessionParams: q }),
      )
    ).res;
    assert.equal(res.sessionParams.quarantined, false);
    assert.equal(res.sessionParams.attemptId, id);
    assert.equal(res.sessionParams.status, 'running');
    assert.equal(fake.dispatchCount, 1, 'adopting never spawns');
  });

  it('changed input after a crash refuses re-post (intent-changed quarantine)', async () => {
    fake.crashNextCreateAfterAccept();
    const restarted = createServerAdapter({ stateRoot, fetchImpl: (...a) => fake.fetch(...a) });
    const errWake = async (overrides = {}, session = null) => {
      const { ctx } = makeCtx({ cwd, ...TASK, ...overrides });
      if (session) ctx.runtime = { sessionId: session.sessionId, sessionParams: session.sessionParams };
      return restarted.execute(ctx);
    };
    const ambiguous = await errWake();
    assert.equal(ambiguous.exitCode, 1);
    assert.equal(fake.dispatchCount, 1);

    // Operator edits the instruction, then retries: the journaled intent no
    // longer matches — refuse instead of dispatching either version.
    const { ctx } = makeCtx({ cwd, ...TASK, config: { instruction: 'CHANGED after crash' } });
    const refused = await restarted.execute(ctx);
    assert.equal(refused.sessionParams.quarantined, true);
    assert.equal(refused.sessionParams.status, 'unknown');
    assert.equal(fake.dispatchCount, 1, 'no dispatch of stale or edited intent');

    // Unchanged retry still reconciles the original.
    const { ctx: same } = makeCtx({ cwd, ...TASK });
    const recovered = await restarted.execute(same);
    assert.equal(recovered.sessionParams.quarantined ?? false, false);
    assert.equal(recovered.sessionParams.status, 'dispatched');
    assert.equal(fake.dispatchCount, 1);
  });

  it('tampered journal payload refuses outright', async () => {
    fake.crashNextCreateAfterAccept();
    const restarted = createServerAdapter({ stateRoot, fetchImpl: (...a) => fake.fetch(...a) });
    const { ctx } = makeCtx({ cwd, ...TASK });
    const ambiguous = await restarted.execute(ctx);
    assert.equal(ambiguous.exitCode, 1);
    const { readFileSync, writeFileSync: write } = await import('node:fs');
    const journalPath = join(stateRoot, 'journal', 'pending', 'p7_T-7_run-1.json');
    const entry = JSON.parse(readFileSync(journalPath, 'utf8'));
    entry.payload.instruction = 'attacker-edited';
    write(journalPath, JSON.stringify(entry));
    const { ctx: retry } = makeCtx({ cwd, ...TASK });
    const refused = await restarted.execute(retry);
    assert.equal(refused.sessionParams.quarantined, true);
    assert.equal(fake.dispatchCount, 1);
  });
});
