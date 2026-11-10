// Unit tests: session params codec + idempotency keys (stdlib only).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  idempotencyKeyFor,
  isValidSessionParams,
  messageKeyFor,
  sessionCodec,
} from '../src/session.js';

const good = {
  version: 2,
  sessionId: 'orca-T-run-1',
  attemptId: '00000000-0000-4000-8000-000000000001',
  idempotencyKey: 'ff8-p1-T-1-run-1',
  fencingEpoch: 1,
  leaseToken: 'adapter:ff8-p1-T-1-run-1',
  leaseProvenance: 'adapter-initial',
  runCount: 1,
  projectId: 'p1',
  taskId: 'T-1',
  paperclipRunId: 'run-1',
  worktreeId: null,
  lastEventId: null,
  status: null,
  done: false,
  quarantined: false,
  questionCount: 0,
};

describe('session params', () => {
  it('accepts a complete v2 cursor and round-trips serialize', () => {
    assert.equal(isValidSessionParams(good), true);
    assert.deepEqual(sessionCodec.deserialize({ ...good }), good);
    assert.deepEqual(sessionCodec.serialize({ ...good }), good);
  });

  it('rejects v1 cursors, null, garbage, bad epoch, missing run binding', () => {
    for (const raw of [
      null,
      undefined,
      'sess',
      { ...good, version: 1 },
      { ...good, sessionId: '' },
      { ...good, attemptId: '' },
      { ...good, idempotencyKey: 'short' },
      { ...good, fencingEpoch: 0 },
      { ...good, leaseToken: '' },
      { ...good, leaseProvenance: 'fabricated' },
      { ...good, runCount: -1 },
      { ...good, paperclipRunId: undefined },
      { ...good, quarantined: undefined },
    ]) {
      assert.equal(isValidSessionParams(raw), false, JSON.stringify(raw)?.slice(0, 80));
      assert.equal(sessionCodec.deserialize(raw), null);
    }
  });

  it('refuses to serialize invalid params', () => {
    assert.throws(() => sessionCodec.serialize({ nope: true }), /invalid session params/);
  });

  it('supplies a display id without touching the bridge', () => {
    assert.equal(sessionCodec.getDisplayId(good), 'orca-session orca-T-run-1');
  });

  it('derives deterministic keys in the 8..160 header range', () => {
    const a = idempotencyKeyFor({ projectId: 'p1', taskId: 'T-1', runId: 'run-1' });
    assert.equal(a, idempotencyKeyFor({ projectId: 'p1', taskId: 'T-1', runId: 'run-1' }));
    assert.ok(a.length >= 8 && a.length <= 160);
    assert.notEqual(a, idempotencyKeyFor({ projectId: 'p1', taskId: 'T-1', runId: 'run-2' }));
    assert.notEqual(a, idempotencyKeyFor({ projectId: 'p1', taskId: 'T-1', runId: 'run-1', fencingEpoch: 2 }));
  });

  it('derives message keys only from stable caller-supplied ids', () => {
    const k = messageKeyFor({ projectId: 'p1', attemptId: good.attemptId, messageId: 'msg-42' });
    assert.ok(k.includes('msg-42'));
    assert.equal(k, messageKeyFor({ projectId: 'p1', attemptId: good.attemptId, messageId: 'msg-42' }));
  });
});
