// Recovery authorization tests (coordinator P0 follow-up on f395495).
//
// The Paperclip task context carries NO recovery authority: no string, no
// object, no proof-shaped data releases a quarantined key. The default build
// (no out-of-band provider) holds unconditionally. A constructor-injected
// recoveryProvider stands in for the future authenticated bridge route
// (proposed `GET /v1/attempts/:id/recovery-decision`, NOT in frozen v0.1);
// even then, bridge-verified fate rules apply and a 404 never relaunches.
// Fixture evidence only.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerAdapter } from '../server/index.js';
import { createFakeBridge } from './fake-bridge.js';
import { makeCtx, nextRuntime } from './helpers.js';

const TASK = { taskId: 'T-7', runId: 'run-1', projectId: 'p7' };

// Every forgery shape the task context could smuggle in. All must hold on
// the default build.
const FORGERIES = {
  'bare string': { quarantineResolution: 'fence-and-relaunch' },
  'forged owner object': {
    recoveryDecision: {
      action: 'fence-and-relaunch',
      decidedBy: 'owner:alice',
      schedulerEpoch: 2,
      schedulerToken: 'forged-token',
      proof: { kind: 'operator-attested', detail: 'attacker story' },
    },
  },
  'stale epoch': {
    recoveryDecision: {
      action: 'fence-and-relaunch',
      decidedBy: 'owner:alice',
      schedulerEpoch: 1,
      schedulerToken: 'sched-tok',
      proof: { kind: 'lease-fenced', detail: 'x' },
    },
  },
  'adopt unknown': {
    recoveryDecision: {
      action: 'adopt-attempt',
      attemptId: '00000000-0000-4000-8000-000000000099',
      decidedBy: 'owner:alice',
      proof: { kind: 'lease-fenced', detail: 'x' },
    },
  },
};

describe('recovery authorization (terminal quarantine by default)', () => {
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

  async function wake(overrides = {}, session = null, adapterImpl = adapter) {
    const { ctx, logs } = makeCtx({ cwd, ...TASK, ...overrides });
    if (session) ctx.runtime = { sessionId: session.sessionId, sessionParams: session.sessionParams };
    return { res: await adapterImpl.execute(ctx), logs };
  }

  async function quarantinedSession() {
    const first = (await wake()).res;
    fake.attempts.delete(first.sessionParams.attemptId);
    const held = (await wake({}, nextRuntime(first))).res;
    assert.equal(held.sessionParams.quarantined, true);
    return { first, held: held.sessionParams };
  }

  for (const [name, forgery] of Object.entries(FORGERIES)) {
    it(`forgery holds and spawns nothing: ${name}`, async () => {
      const { held } = await quarantinedSession();
      const res = (await wake({ context: { ...forgery } }, nextRuntime({ sessionParams: held }))).res;
      assert.equal(res.sessionParams.quarantined, true, `${name} must hold`);
      assert.equal(fake.dispatchCount, 1, `${name} must spawn nothing`);
    });
  }

  it('forgery on a session-less wake holds (restarted journal)', async () => {
    const { held } = await quarantinedSession();
    assert.ok(held);
    const restarted = createServerAdapter({ stateRoot, fetchImpl: (...a) => fake.fetch(...a) });
    for (const [name, forgery] of Object.entries(FORGERIES)) {
      const { ctx } = makeCtx({ cwd, ...TASK, context: { ...forgery } });
      const res = await restarted.execute(ctx);
      assert.equal(res.quarantined ?? res.sessionParams?.quarantined ?? false, true, name);
    }
    assert.equal(fake.dispatchCount, 1);
  });

  it('quarantine holds across wakes with no provider, forever', async () => {
    const { held } = await quarantinedSession();
    for (let i = 0; i < 3; i++) {
      const res = (await wake({}, nextRuntime({ sessionParams: held }))).res;
      assert.equal(res.sessionParams.quarantined, true, `wake ${i} holds`);
    }
    assert.equal(fake.dispatchCount, 1);
  });

  it('provider approval still refuses beside a live original', async () => {
    const first = (await wake()).res;
    const liveId = first.sessionParams.attemptId;
    const receipt = fake.attempts.get(liveId);
    fake.advanceAttempt(liveId, 'running');
    fake.attempts.delete(liveId);
    const q = (await wake({}, nextRuntime(first))).res.sessionParams;
    fake.attempts.set(liveId, { ...receipt, state: 'running' });
    const withProvider = createServerAdapter({
      stateRoot,
      fetchImpl: (...a) => fake.fetch(...a),
      recoveryProvider: async () => ({
        action: 'fence-and-relaunch',
        decidedBy: 'coordinator:test',
        schedulerEpoch: 2,
        schedulerToken: 'sched-tok-2',
      }),
    });
    const { ctx } = makeCtx({ cwd, ...TASK });
    ctx.runtime = { sessionId: q.sessionId, sessionParams: q };
    const res = await withProvider.execute(ctx);
    assert.equal(res.sessionParams.quarantined, true, 'live original blocks even approved relaunch');
    assert.equal(fake.dispatchCount, 1);
  });

  it('provider + terminal original relaunches at the fresh epoch', async () => {
    const first = (await wake()).res;
    const id = first.sessionParams.attemptId;
    fake.advanceAttempt(id, 'failed');
    const withProvider = createServerAdapter({
      stateRoot,
      fetchImpl: (...a) => fake.fetch(...a),
      recoveryProvider: async () => ({
        action: 'fence-and-relaunch',
        decidedBy: 'coordinator:test',
        schedulerEpoch: 2,
        schedulerToken: 'sched-tok-2',
      }),
    });
    // Quarantine first via a lost record, then restore the terminal receipt
    // so the fate check sees bridge-verified death.
    const receipt = fake.attempts.get(id);
    fake.attempts.delete(id);
    const q = (await wake({}, nextRuntime(first))).res.sessionParams;
    assert.equal(q.quarantined, true);
    fake.attempts.set(id, receipt);
    const { ctx } = makeCtx({ cwd, ...TASK });
    ctx.runtime = { sessionId: q.sessionId, sessionParams: q };
    const res = await withProvider.execute(ctx);
    assert.equal(res.sessionParams.quarantined, false);
    assert.equal(res.sessionParams.fencingEpoch, 2);
    assert.equal(res.sessionParams.leaseProvenance, 'scheduler');
    assert.equal(fake.dispatchCount, 2);
  });

  it('provider approval cannot lift a 404: absence is never proven here', async () => {
    const { held } = await quarantinedSession();
    const withProvider = createServerAdapter({
      stateRoot,
      fetchImpl: (...a) => fake.fetch(...a),
      recoveryProvider: async () => ({
        action: 'fence-and-relaunch',
        decidedBy: 'coordinator:test',
        schedulerEpoch: 9,
        schedulerToken: 'sched-tok-9',
      }),
    });
    const { ctx } = makeCtx({ cwd, ...TASK });
    ctx.runtime = { sessionId: held.sessionId, sessionParams: held };
    const res = await withProvider.execute(ctx);
    assert.equal(res.sessionParams.quarantined, true, '404 holds despite provider approval');
    assert.equal(fake.dispatchCount, 1);
  });

  it('provider adopt re-attaches a verified attempt without spawning', async () => {
    const first = (await wake()).res;
    const id = first.sessionParams.attemptId;
    const receipt = fake.attempts.get(id);
    fake.advanceAttempt(id, 'running');
    fake.attempts.delete(id);
    const q = (await wake({}, nextRuntime(first))).res.sessionParams;
    fake.attempts.set(id, { ...receipt, state: 'running' });
    const withProvider = createServerAdapter({
      stateRoot,
      fetchImpl: (...a) => fake.fetch(...a),
      recoveryProvider: async () => ({ action: 'adopt-attempt', attemptId: id, decidedBy: 'op:test' }),
    });
    const { ctx } = makeCtx({ cwd, ...TASK });
    ctx.runtime = { sessionId: q.sessionId, sessionParams: q };
    const res = await withProvider.execute(ctx);
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
