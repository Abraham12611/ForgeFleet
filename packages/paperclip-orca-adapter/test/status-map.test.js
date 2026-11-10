// Unit tests: attempt-state mapping + event application (stdlib only).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyBridgeEvent,
  createEventTracker,
  isTerminalAttemptState,
  mapAttemptState,
} from '../src/status-map.js';

const session = { sessionId: 's', fencingEpoch: 1 };

function frame(id, event) {
  return { eventId: id, event: { source: 'orca-bridge', fencingEpoch: 1, ...event } };
}

describe('status mapping', () => {
  it('maps bridge states to Paperclip-facing status', () => {
    assert.equal(mapAttemptState('accepted'), 'dispatched');
    assert.equal(mapAttemptState('dispatching'), 'dispatched');
    assert.equal(mapAttemptState('running'), 'running');
    assert.equal(mapAttemptState('waiting'), 'waiting_capacity');
    assert.equal(mapAttemptState('unknown'), 'unknown');
    assert.equal(mapAttemptState('cancelled'), 'cancelled');
    assert.equal(mapAttemptState('failed'), 'failed');
    // Runtime completion is review input, not verification.
    assert.equal(mapAttemptState('finished'), 'submitted');
    assert.equal(mapAttemptState('bogus'), 'unknown');
  });

  it('treats only finished/failed/cancelled as terminal', () => {
    assert.equal(isTerminalAttemptState('finished'), true);
    assert.equal(isTerminalAttemptState('failed'), true);
    assert.equal(isTerminalAttemptState('cancelled'), true);
    assert.equal(isTerminalAttemptState('running'), false);
    assert.equal(isTerminalAttemptState('unknown'), false);
  });

  it('dedupes duplicate and reordered events to one logical change', () => {
    const t = createEventTracker();
    const f = frame('evt-1', { eventType: 'attempt.started' });
    assert.equal(applyBridgeEvent(t, f, session).applied, true);
    assert.equal(applyBridgeEvent(t, f, session).applied, false);
    assert.equal(applyBridgeEvent(t, f, session).reason, 'duplicate');
    assert.equal(t.status, 'running');
  });

  it('ignores late events from a fenced (older) epoch', () => {
    const t = createEventTracker();
    const r = applyBridgeEvent(
      t,
      frame('evt-9', { eventType: 'attempt.heartbeat', fencingEpoch: 0 }),
      { ...session, fencingEpoch: 2 },
    );
    assert.equal(r.applied, false);
    assert.equal(r.reason, 'stale-fencing-epoch');
    assert.equal(t.lastEventId, null);
  });

  it('renders unknown as unknown, never as failed', () => {
    const t = createEventTracker();
    applyBridgeEvent(t, frame('evt-2', { eventType: 'attempt.unknown' }), session);
    assert.equal(t.status, 'unknown');
  });

  it('collects questions for owner routing', () => {
    const t = createEventTracker();
    applyBridgeEvent(
      t,
      frame('evt-3', { eventType: 'attempt.question', data: { body: 'which branch?' } }),
      session,
    );
    assert.equal(t.pendingQuestions.length, 1);
    assert.equal(t.pendingQuestions[0].body, 'which branch?');
  });

  it('safely ignores unknown future event types', () => {
    const t = createEventTracker();
    const r = applyBridgeEvent(t, frame('evt-4', { eventType: 'attempt.something-new' }), session);
    assert.equal(r.applied, true);
    assert.equal(r.reason, 'ignored-unknown-type');
  });
});
