// Pinned-contract conformance: the plugin surface matches
// AdapterExecutionContext / AdapterExecutionResult at upstream tag
// v2026.1106.0 (docs/adapters/creating-an-adapter.md, fetched 2026-11-09;
// no upstream code vendored). A hand-shaped (input, runtime) signature
// would pass a self-authored fake but fail Paperclip; this file pins the
// real one.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerAdapter } from '../server/index.js';
import { createFakeBridge } from './fake-bridge.js';
import { makeCtx } from './helpers.js';

describe('pinned Paperclip plugin surface', () => {
  let cwd;
  let stateRoot;
  let fake;
  let adapter;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'pc-pin-'));
    writeFileSync(join(cwd, 'SEED.md'), '# seed\n');
    stateRoot = mkdtempSync(join(tmpdir(), 'pc-state-'));
    fake = createFakeBridge();
    adapter = createServerAdapter({ stateRoot, fetchImpl: (...a) => fake.fetch(...a) });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  });

  it('module exposes type, execute, sessionCodec, and documented flags', () => {
    assert.equal(adapter.type, 'forgefleet-orca');
    assert.equal(typeof adapter.execute, 'function');
    assert.equal(typeof adapter.testEnvironment, 'function');
    assert.equal(adapter.supportsLocalAgentJwt, false);
    assert.equal(adapter.supportsInstructionsBundle, false);
    assert.equal(adapter.requiresMaterializedRuntimeSkills, false);
    assert.equal(typeof adapter.sessionCodec.deserialize, 'function');
    assert.equal(typeof adapter.sessionCodec.serialize, 'function');
    assert.equal(typeof adapter.sessionCodec.getDisplayId, 'function');
  });

  it('execute takes ONE context and returns an AdapterExecutionResult', async () => {
    const { ctx } = makeCtx({ cwd });
    assert.equal(adapter.execute.length, 1, 'single AdapterExecutionContext arg');
    const res = await adapter.execute(ctx);
    for (const key of ['exitCode', 'signal', 'timedOut', 'sessionParams', 'sessionDisplayId', 'provider']) {
      assert.ok(key in res, `result carries ${key}`);
    }
    assert.equal(res.exitCode, null);
    assert.equal(res.timedOut, false);
    assert.equal(res.provider, 'muse');
    assert.ok(res.sessionDisplayId.includes('orca-session'));
  });

  it('stale and undecodable sessions answer clearSession:true', async () => {
    const { ctx: staleCtx } = makeCtx({
      cwd,
      sessionId: 'x',
      sessionParams: { version: 2, stale: true },
    });
    // stale marker bypasses the codec version gate by design
    const stale = await adapter.execute(staleCtx);
    assert.equal(stale.clearSession, true);

    const { ctx: garbageCtx } = makeCtx({ cwd, sessionId: 'x', sessionParams: { nope: 1 } });
    const garbage = await adapter.execute(garbageCtx);
    assert.equal(garbage.clearSession, true);
  });

  it('cross-task and cross-run replay answers clearSession:true', async () => {
    const { ctx } = makeCtx({ cwd });
    const first = await adapter.execute(ctx);
    const sp = first.sessionParams;
    const { ctx: other } = makeCtx({ cwd, taskId: 'OTHER', sessionId: sp.sessionId, sessionParams: sp });
    assert.equal((await adapter.execute(other)).clearSession, true);
    const { ctx: otherRun } = makeCtx({ cwd, runId: 'run-2', sessionId: sp.sessionId, sessionParams: sp });
    assert.equal((await adapter.execute(otherRun)).clearSession, true);
  });

  it('testEnvironment is read-only and reports structured diagnostics', async () => {
    const env = await adapter.testEnvironment({ workerKind: 'muse' });
    assert.equal(env.ok, true);
    assert.ok(env.checks.length >= 2);
    assert.equal(fake.dispatchCount, 0, 'no side effects from environment test');
  });

  it('fabricated identity is rejected: runId/taskId/projectId/cwd required', async () => {
    for (const patch of [
      { runId: '' },
      { runId: 'has space' },
      { taskId: '../../etc' },
      { projectId: 'a/b' },
    ]) {
      const built = makeCtx({ cwd, taskId: 'T-1', runId: 'run-1', projectId: 'p1' });
      if (patch.runId !== undefined) built.ctx.runId = patch.runId;
      if (patch.taskId !== undefined) built.ctx.context.taskId = patch.taskId;
      if (patch.projectId !== undefined) built.ctx.context.projectId = patch.projectId;
      await assert.rejects(adapter.execute(built.ctx), (err) => err.code === 'invalid_context');
    }
    const noCwd = makeCtx({ cwd });
    delete noCwd.ctx.context.cwd;
    await assert.rejects(adapter.execute(noCwd.ctx), (err) => err.code === 'invalid_context');
    assert.equal(fake.dispatchCount, 0);
  });

  it('scheduler lease values flow into the bridge request with provenance', async () => {
    const { ctx } = makeCtx({
      cwd,
      context: { lease: { fencingEpoch: 3, leaseToken: 'sched-tok-9' } },
    });
    const res = await adapter.execute(ctx);
    assert.equal(res.sessionParams.fencingEpoch, 3);
    assert.equal(res.sessionParams.leaseToken, 'sched-tok-9');
    assert.equal(res.sessionParams.leaseProvenance, 'scheduler');
    const { ctx: bare } = makeCtx({ cwd, taskId: 'T-2', runId: 'run-9' });
    const res2 = await adapter.execute(bare);
    assert.equal(res2.sessionParams.leaseProvenance, 'adapter-initial');
    assert.ok(res2.sessionParams.leaseToken.startsWith('adapter:'));
  });
});
