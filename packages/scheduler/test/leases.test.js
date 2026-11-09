import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LeaseStore, LeaseConflictError } from '../src/leases.js';

const NOW = 1_700_000_000_000;

function acquire(store, overrides = {}) {
  return store.acquire({
    taskId: 'task-a',
    holder: 'attempt-1',
    idempotencyKey: 'key-1',
    requestHash: 'hash-1',
    ttlMs: 60_000,
    nowMs: NOW,
    ...overrides,
  });
}

describe('LeaseStore single-active enforcement (FF-013: no double-active task)', () => {
  it('denies a second acquire while a lease is active', () => {
    const store = new LeaseStore();
    const first = acquire(store);
    assert.ok(first.lease);
    assert.equal(first.lease.generation, 1);
    const second = acquire(store, { holder: 'attempt-2', idempotencyKey: 'key-2', requestHash: 'hash-2' });
    assert.equal(second.denied, 'active-lease-held');
    assert.equal(second.lease, undefined);
  });

  it('bumps generation monotonically after release', () => {
    const store = new LeaseStore();
    acquire(store);
    assert.ok(store.release({ taskId: 'task-a', generation: 1 }));
    const next = acquire(store, { holder: 'attempt-2', idempotencyKey: 'key-2', requestHash: 'hash-2' });
    assert.equal(next.lease.generation, 2);
  });

  it('bumps generation monotonically after fencing', () => {
    const store = new LeaseStore();
    acquire(store);
    assert.ok(store.fence({ taskId: 'task-a', generation: 1 }));
    const next = acquire(store, { holder: 'attempt-2', idempotencyKey: 'key-2', requestHash: 'hash-2' });
    assert.equal(next.lease.generation, 2);
  });

  it('ignores heartbeats from a stale (fenced) generation', () => {
    const store = new LeaseStore();
    acquire(store);
    assert.ok(store.fence({ taskId: 'task-a', generation: 1 }));
    const stale = store.heartbeat({ taskId: 'task-a', generation: 1, ttlMs: 60_000, nowMs: NOW + 1000 });
    assert.equal(stale.ignored, 'no-active-lease');
    const next = acquire(store, { holder: 'attempt-2', idempotencyKey: 'key-2', requestHash: 'hash-2', nowMs: NOW + 1000 });
    const wrongGen = store.heartbeat({ taskId: 'task-a', generation: 1, ttlMs: 60_000, nowMs: NOW + 2000 });
    assert.equal(wrongGen.ignored, 'stale-generation');
    assert.equal(next.lease.generation, 2);
  });

  it('refuses release from a non-owning generation', () => {
    const store = new LeaseStore();
    acquire(store);
    assert.equal(store.release({ taskId: 'task-a', generation: 99 }), false);
    assert.ok(store.activeLease('task-a'));
  });

  it('expires past-due leases via sweep', () => {
    const store = new LeaseStore();
    acquire(store);
    const expired = store.expireDue(NOW + 60_001);
    assert.equal(expired.length, 1);
    assert.equal(expired[0].state, 'expired');
    assert.equal(store.activeLease('task-a'), undefined);
  });

  it('returns the same lease for same key + same hash (idempotent)', () => {
    const store = new LeaseStore();
    const first = acquire(store);
    const replay = acquire(store);
    assert.equal(replay.lease.idempotencyKey, first.lease.idempotencyKey);
    assert.equal(replay.lease.generation, first.lease.generation);
    assert.equal(store.maxGeneration('task-a'), 1);
  });

  it('throws a conflict for same key + different hash (no side effect)', () => {
    const store = new LeaseStore();
    acquire(store);
    assert.throws(
      () => acquire(store, { requestHash: 'hash-other' }),
      (err) => err instanceof LeaseConflictError && err.code === 'IDEMPOTENCY_CONFLICT',
    );
    assert.equal(store.maxGeneration('task-a'), 1);
  });
});
