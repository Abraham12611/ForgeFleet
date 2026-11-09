// Round-trip tests: Task -> worker -> status, against the fake bridge.
// Fixture evidence only (see README): no live Paperclip or Orca involved.
// All wakes use the pinned AdapterExecutionContext; results assert the
// AdapterExecutionResult shape.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerAdapter } from '../server/index.js';
import { createFakeBridge } from './fake-bridge.js';
import { makeCtx, nextRuntime } from './helpers.js';

function stagingFor(stateRoot, task = 'T-1', run = 'run-1') {
  return join(stateRoot, 'work', `${task}-${run}`);
}

describe('paperclip external adapter round trip (fake bridge)', () => {
  let cwd;
  let stateRoot;
  let fake;
  let adapter;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'pc-cwd-'));
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
    const { ctx, logs } = makeCtx({ cwd, ...overrides });
    if (session) {
      ctx.runtime = { sessionId: session.sessionId, sessionParams: session.sessionParams };
    }
    const res = await adapter.execute(ctx);
    return { res, logs };
  }

  it('first wake dispatches exactly one worker and returns resumable session', async () => {
    const { res } = await wake();
    assert.equal(res.exitCode, null);
    assert.equal(res.sessionParams.status, 'dispatched');
    assert.ok(res.sessionParams.attemptId);
    assert.equal(res.sessionParams.runCount, 1);
    assert.equal(res.sessionParams.paperclipRunId, 'run-1');
    assert.equal(fake.dispatchCount, 1);
    assert.ok(existsSync(join(stagingFor(stateRoot), 'SEED.md')));
  });

  it('Task -> worker -> status: progress and completion reach the caller', async () => {
    const first = (await wake()).res;
    const again = (await wake({}, nextRuntime(first))).res;
    assert.equal(again.sessionParams.status, 'dispatched');
    assert.equal(again.sessionParams.runCount, 2);
    assert.equal(fake.dispatchCount, 1);

    fake.advanceAttempt(first.sessionParams.attemptId, 'running');
    const running = (await wake({}, nextRuntime(again))).res;
    assert.equal(running.sessionParams.status, 'running');
    assert.equal(fake.dispatchCount, 1);

    writeFileSync(join(stagingFor(stateRoot), 'RESULT.md'), '# result\n');
    fake.advanceAttempt(first.sessionParams.attemptId, 'finished');
    const done = (await wake({}, nextRuntime(running))).res;
    assert.equal(done.exitCode, 0);
    assert.equal(done.sessionParams.status, 'submitted');
    assert.equal(done.sessionParams.done, true);
    assert.equal(readFileSync(join(cwd, 'RESULT.md'), 'utf8'), '# result\n');
    assert.equal(fake.dispatchCount, 1);
  });

  it('retried first wake replays to the same attempt (no duplicate worker)', async () => {
    const a = (await wake()).res;
    const b = (await wake()).res;
    assert.equal(a.sessionParams.attemptId, b.sessionParams.attemptId);
    assert.equal(fake.dispatchCount, 1);
  });

  it('SSE resume cursor advances so events are not replayed twice', async () => {
    const first = (await wake()).res;
    fake.advanceAttempt(first.sessionParams.attemptId, 'running');
    const second = (await wake({}, nextRuntime(first))).res;
    assert.ok(second.sessionParams.lastEventId);
    const third = (await wake({}, nextRuntime(second))).res;
    assert.equal(third.sessionParams.status, 'running');
    assert.equal(third.sessionParams.lastEventId, second.sessionParams.lastEventId);
  });

  it('surfaces worker questions for owner routing via logs + count', async () => {
    const first = (await wake()).res;
    fake.emit({
      eventType: 'attempt.question',
      projectId: 'p1',
      taskId: 'T-1',
      attemptId: first.sessionParams.attemptId,
      data: { body: 'which branch?', threadId: 'th-1' },
    });
    const { res, logs } = await wake({}, nextRuntime(first));
    assert.equal(res.sessionParams.questionCount, 1);
    assert.ok(logs.join('\n').includes('question(s) awaiting owner'));
  });

  it('renders unknown runtime state as unknown, never failed', async () => {
    const first = (await wake()).res;
    fake.advanceAttempt(first.sessionParams.attemptId, 'unknown');
    const next = (await wake({}, nextRuntime(first))).res;
    assert.equal(next.sessionParams.status, 'unknown');
    assert.equal(next.exitCode, null);
    assert.equal(next.sessionParams.done, false);
  });
});
