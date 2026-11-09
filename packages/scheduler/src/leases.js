/**
 * In-memory single-active lease store with monotonic fencing generations.
 *
 * Invariants (docs/05-contracts/state-machines.md):
 * - at most one ACTIVE lease per task
 * - generation is monotonic per task (starts at 1, increments on re-acquire)
 * - a heartbeat or mutation carrying a stale (fenced) generation is ignored
 * - `unknown` runtime state never implicitly releases a lease; only an
 *   explicit release/expire/fence after proof does
 *
 * Idempotency mirrors the bridge contract: the same idempotency key + same
 * request hash returns the existing lease; the same key + a different hash
 * is a 409-style conflict and performs no side effect.
 */
export class LeaseConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LeaseConflictError';
    this.code = 'IDEMPOTENCY_CONFLICT';
  }
}

export class LeaseStore {
  constructor() {
    /** @type {Map<string, import('./types.js').LeaseRecord[]>} taskId -> history */
    this.history = new Map();
    /** @type {Map<string, string>} idempotencyKey -> taskId */
    this.keys = new Map();
  }

  /** @returns {import('./types.js').LeaseRecord | undefined} */
  activeLease(taskId) {
    return (this.history.get(taskId) ?? []).find((l) => l.state === 'active');
  }

  /** Highest generation ever issued for a task (0 when never leased). */
  maxGeneration(taskId) {
    let max = 0;
    for (const lease of this.history.get(taskId) ?? []) {
      if (lease.generation > max) max = lease.generation;
    }
    return max;
  }

  /**
   * Acquire the single active lease for a task.
   * @returns {{ lease?: import('./types.js').LeaseRecord, denied?: string }}
   * @throws {LeaseConflictError} on idempotency-key reuse with a different payload
   */
  acquire({ taskId, holder, idempotencyKey, requestHash, ttlMs, nowMs = Date.now() }) {
    if (!taskId || !holder || !idempotencyKey || !requestHash) {
      return { denied: 'invalid-acquire-args' };
    }
    if (!(ttlMs > 0)) return { denied: 'invalid-ttl' };

    const knownTask = this.keys.get(idempotencyKey);
    if (knownTask !== undefined && knownTask !== taskId) {
      throw new LeaseConflictError(`idempotency key ${idempotencyKey} already used for ${knownTask}`);
    }
    for (const leases of this.history.values()) {
      const prior = leases.find((l) => l.idempotencyKey === idempotencyKey);
      if (prior) {
        if (prior.taskId !== taskId) {
          throw new LeaseConflictError(`idempotency key ${idempotencyKey} already used for ${prior.taskId}`);
        }
        if (prior.requestHash !== requestHash) {
          throw new LeaseConflictError(`idempotency key ${idempotencyKey} payload mismatch`);
        }
        return { lease: { ...prior } };
      }
    }

    const active = this.activeLease(taskId);
    if (active) return { denied: 'active-lease-held' };

    const lease = {
      taskId,
      generation: this.maxGeneration(taskId) + 1,
      holder,
      idempotencyKey,
      requestHash,
      acquiredAtMs: nowMs,
      expiresAtMs: nowMs + ttlMs,
      state: 'active',
    };
    if (!this.history.has(taskId)) this.history.set(taskId, []);
    this.history.get(taskId).push(lease);
    this.keys.set(idempotencyKey, taskId);
    return { lease: { ...lease } };
  }

  /**
   * Heartbeat an active lease. Stale generations are ignored (never extend).
   * @returns {{ lease?: import('./types.js').LeaseRecord, ignored?: string }}
   */
  heartbeat({ taskId, generation, ttlMs, nowMs = Date.now() }) {
    const active = this.activeLease(taskId);
    if (!active) return { ignored: 'no-active-lease' };
    if (generation !== active.generation) return { ignored: 'stale-generation' };
    if (active.expiresAtMs <= nowMs) {
      active.state = 'expired';
      return { ignored: 'lease-expired' };
    }
    active.expiresAtMs = nowMs + ttlMs;
    return { lease: { ...active } };
  }

  /** Release the active lease; only the owning generation may release. */
  release({ taskId, generation }) {
    const active = this.activeLease(taskId);
    if (!active) return false;
    if (generation !== active.generation) return false;
    active.state = 'released';
    return true;
  }

  /**
   * Fence the active lease after proof the old owner is gone
   * (docs/05-contracts/state-machines.md: no `unknown -> ready` without
   * proving the old attempt gone/fenced). The next acquire bumps generation.
   */
  fence({ taskId, generation }) {
    const active = this.activeLease(taskId);
    if (!active) return false;
    if (generation !== active.generation) return false;
    active.state = 'fenced';
    return true;
  }

  /** Sweep past-due active leases to `expired`. Returns the expired leases. */
  expireDue(nowMs = Date.now()) {
    const expired = [];
    for (const leases of this.history.values()) {
      for (const lease of leases) {
        if (lease.state === 'active' && lease.expiresAtMs <= nowMs) {
          lease.state = 'expired';
          expired.push({ ...lease });
        }
      }
    }
    return expired;
  }

  /**
   * Count currently active leases.
   * @param {(taskId: string) => string | undefined} [projectOf] maps taskId -> projectId
   * @param {string} [projectId] when given with projectOf, count only this project
   * @returns {number}
   */
  activeCount(projectOf, projectId) {
    let n = 0;
    for (const leases of this.history.values()) {
      const active = leases.find((l) => l.state === 'active');
      if (!active) continue;
      if (projectOf && projectId !== undefined && projectOf(active.taskId) !== projectId) continue;
      n += 1;
    }
    return n;
  }

  /** @returns {Set<string>} task ids holding an active lease. */
  activeTaskIds() {
    const ids = new Set();
    for (const [taskId, leases] of this.history) {
      if (leases.some((l) => l.state === 'active')) ids.add(taskId);
    }
    return ids;
  }
}
