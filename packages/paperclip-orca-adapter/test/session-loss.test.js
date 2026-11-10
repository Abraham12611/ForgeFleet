// Session-loss tests (coordinator re-review at c2420c5).
//
// clearSession is retired: a stale, corrupt, or mismatched cursor must
// never cause the next wake to dispatch a duplicate worker. Stale/corrupt
// cursors reconcile via the read-only sessions inventory and quarantine
// durably; mismatched cursors are echoed back verbatim with zero state
// changes. Fixture evidence only.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerAdapter } from '../server/index.js';
import { createFakeBridge } from './fake-bridge.js';
import { makeCtx, nextRuntime } from './helpers.js';

const TASK = { taskId: 'T-5', runId: 'run-1', projectId: 'p5' };
const KEY = 'p5_T-5_run-1';

function quarantineRecord(stateRoot, key = KEY) {
  const path = join(stateRoot, 'journal', 'quarantine', `${key}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function journalFiles(stateRoot) {
  const pending = join(stateRoot, 'journal', 'pending');
  const quarantine = join(stateRoot, 'journal', 'quarantine');
  return {
    pending: existsSync(pending) ? readdirSync(pending) : [],
    quarantine: existsSync(quarantine) ? readdirSync(quarantine) : [],
  };
}

describe('session loss never duplicates (no clearSession)', () => {
  let cwd;
  let stateRoot;
  let fake;
  let adapter;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'pc-loss-'));
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

  async function liveAttempt() {
    const first = (await wake()).res;
    fake.advanceAttempt(first.sessionParams.attemptId, 'running');
    return first.sessionParams;
  }

  it('stale cursor + running worker: no second POST, no clearSession, durable record', async () => {
    await liveAttempt();
    const { ctx } = makeCtx({ cwd, ...TASK, sessionId: 'dead', sessionParams: { version: 2, stale: true } });
    const res = await adapter.execute(ctx);
    assert.ok(!('clearSession' in res), 'must never emit clearSession');
    assert.equal(res.sessionParams, null);
    assert.equal(res.quarantined, true);
    assert.equal(fake.dispatchCount, 1, 'no second POST /v1/attempts');
    const record = quarantineRecord(stateRoot);
    assert.equal(record.reason, 'session-lost-live-worker');
    assert.ok(record.discovered.length >= 1, 'discovered worker IDs recorded');

    // Durable across restarts: a fresh process re-reconciles and holds.
    const restarted = createServerAdapter({ stateRoot, fetchImpl: (...a) => fake.fetch(...a) });
    const { ctx: retry } = makeCtx({ cwd, ...TASK, sessionId: 'dead', sessionParams: { version: 2, stale: true } });
    const again = await restarted.execute(retry);
    assert.ok(!('clearSession' in again));
    assert.equal(again.quarantined, true);
    assert.equal(fake.dispatchCount, 1);
    assert.equal(quarantineRecord(stateRoot).reason, 'session-lost-live-worker');
  });

  it('corrupt cursor + running worker: same treatment as stale', async () => {
    await liveAttempt();
    const { ctx } = makeCtx({ cwd, ...TASK, sessionId: 'x', sessionParams: { garbage: [1, 2] } });
    const res = await adapter.execute(ctx);
    assert.ok(!('clearSession' in res));
    assert.equal(res.quarantined, true);
    assert.equal(fake.dispatchCount, 1);
    assert.equal(quarantineRecord(stateRoot).reason, 'session-lost-live-worker');
  });

  it('mismatched cursor is echoed verbatim with zero state change', async () => {
    // Foreign task B owns a live worker.
    const bFirst = (await wake({ taskId: 'T-B', projectId: 'p5', runId: 'run-1' })).res;
    const foreignCursor = bFirst.sessionParams;
    const before = fake.attempts.get(foreignCursor.attemptId).state;
    const filesBefore = journalFiles(stateRoot);

    // Replay B's cursor against task A.
    const { ctx } = makeCtx({ cwd, ...TASK, sessionId: foreignCursor.sessionId, sessionParams: foreignCursor });
    const res = await adapter.execute(ctx);
    assert.ok(!('clearSession' in res), 'foreign cursor must not be cleared');
    assert.equal(res.bindingMismatch, true);
    assert.deepEqual(res.sessionParams, foreignCursor, 'original cursor preserved verbatim');
    assert.deepEqual(journalFiles(stateRoot), filesBefore, 'no journal writes for either task');
    assert.equal(fake.attempts.get(foreignCursor.attemptId).state, before, 'foreign attempt untouched');
    assert.equal(fake.dispatchCount, 1, 'no dispatch for the presented task');
  });

  it('stale cursor + no worker trace: fate-unknown quarantine, still no dispatch', async () => {
    const { ctx } = makeCtx({ cwd, ...TASK, sessionId: 'dead', sessionParams: { version: 2, stale: true } });
    const res = await adapter.execute(ctx);
    assert.ok(!('clearSession' in res));
    assert.equal(res.quarantined, true);
    assert.equal(fake.dispatchCount, 0);
    assert.equal(quarantineRecord(stateRoot).reason, 'session-lost-fate-unknown');
  });

  it('stale cursor + terminal worker: holds (terminal listing is not sync-back)', async () => {
    const sp = await liveAttempt();
    fake.advanceAttempt(sp.attemptId, 'finished');
    const { ctx } = makeCtx({ cwd, ...TASK, sessionId: 'dead', sessionParams: { version: 2, stale: true } });
    const res = await adapter.execute(ctx);
    assert.ok(!('clearSession' in res));
    assert.equal(res.quarantined, true, 'completion cannot be reported without the cursor + sync-back');
    assert.equal(fake.dispatchCount, 1);
  });

  it('recheck follows worker fate across wakes without ever dispatching', async () => {
    const sp = await liveAttempt();
    const stale = () => makeCtx({ cwd, ...TASK, sessionId: 'dead', sessionParams: { version: 2, stale: true } }).ctx;
    const first = await adapter.execute(stale());
    assert.equal(quarantineRecord(stateRoot).reason, 'session-lost-live-worker');
    assert.ok(first.quarantined);
    fake.advanceAttempt(sp.attemptId, 'failed');
    const second = await adapter.execute(stale());
    assert.equal(second.quarantined, true);
    assert.equal(quarantineRecord(stateRoot).reason, 'session-lost-fate-unknown');
    assert.equal(fake.dispatchCount, 1);
  });

  it('unreachable inventory quarantines instead of guessing', async () => {
    await liveAttempt();
    const down = createServerAdapter({
      stateRoot,
      fetchImpl: async (url, init) => {
        if (String(url).includes('/v1/runtime/sessions')) throw new Error('bridge down');
        return fake.fetch(url, init);
      },
    });
    const { ctx } = makeCtx({ cwd, ...TASK, sessionId: 'dead', sessionParams: { version: 2, stale: true } });
    const res = await down.execute(ctx);
    assert.ok(!('clearSession' in res));
    assert.equal(res.quarantined, true);
    assert.equal(quarantineRecord(stateRoot).reason, 'session-lost-reconcile-failed');
    assert.equal(fake.dispatchCount, 1);
  });

  it('default build ignores provider-shaped task input (fail closed)', async () => {
    const { held } = await (async () => {
      const first = (await wake()).res;
      fake.attempts.delete(first.sessionParams.attemptId);
      const h = (await wake({}, nextRuntime(first))).res;
      return { held: h.sessionParams };
    })();
    const res = (
      await wake(
        {
          context: {
            recoveryProvider: 'data:,approved',
            recoveryDecision: { action: 'adopt-attempt', attemptId: held.attemptId },
          },
        },
        nextRuntime({ sessionParams: held }),
      )
    ).res;
    assert.equal(res.sessionParams.quarantined, true);
    assert.equal(fake.dispatchCount, 1);
    // Non-function provider options are ignored the same way.
    const lax = createServerAdapter({
      stateRoot,
      fetchImpl: (...a) => fake.fetch(...a),
      recoveryProvider: { action: 'fence-and-relaunch' },
    });
    const { ctx } = makeCtx({ cwd, ...TASK });
    ctx.runtime = { sessionId: held.sessionId, sessionParams: held };
    const res2 = await lax.execute(ctx);
    assert.equal(res2.sessionParams.quarantined, true);
    assert.equal(fake.dispatchCount, 1);
  });
});
