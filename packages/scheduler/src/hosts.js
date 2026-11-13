/**
 * Worker-host registry for distributed ForgeFleet capacity (FF-026).
 *
 * Scope (docs/03-architecture/scaling-and-recovery.md, roadmap 6.A, FR-14):
 * secure enrollment of additional worker hosts, heartbeats carrying resource
 * observation (CPU/RAM/disk/PTY/sockets), staleness tracking, per-host free
 * capacity, draining, and safe deregistration.
 *
 * Safety rules enforced here:
 * - a host is eligible for new work only while enrolled, fresh (heartbeat
 *   within timeout), not draining/retired, and reporting usable resources;
 * - a host with active leases (including unmanaged Orca sessions) cannot be
 *   deregistered without an explicit force+fence-proof deregistration, and
 *   its record is retained for audit after retirement;
 * - enrollment requires a single-use, expiring join token plus a recorded
 *   Tailscale identity, so enrollment attempts are auditable.
 *
 * This module is pure and deterministic (all time via injected `nowMs`) and
 * has no I/O: persistence, transport, and real Tailscale verification live
 * outside it. It composes with the FF-013 scheduler core (`admission.js`
 * `eligibleActive`/`admitOne`, `leases.js` fencing) by supplying the
 * `host_free_capacity` term as an aggregate over eligible hosts — see
 * `distributed.js`.
 */

/** Host lifecycle states. */
export const HOST_STATES = new Set(['active', 'stale', 'draining', 'retired']);

/**
 * @typedef {Object} ResourceObservation
 * @property {number} [totalSlots] advertised concurrent worker slots; default 0
 * @property {number} [usedSlots] slots currently occupied; default 0
 * @property {number} [reservedSlots] slots held back (e.g. for repairs); default 0
 * @property {boolean} [diskFull] disk pressure flag; when true, host offers no capacity
 * @property {boolean} [memCritical] memory pressure flag; when true, host offers no capacity
 * @property {string[]} [providers] provider names this host can run (e.g. ['muse']); default []
 * @property {string[]} [runtimes] runtime kinds this host can run (e.g. ['orca-cli']); default []
 * @property {number} [activeLeases] leases/sessions currently owned incl. unmanaged Orca ones; default 0
 */

/**
 * @typedef {Object} HostRecord
 * @property {string} id stable host id
 * @property {string} tailscaleIdentity recorded Tailscale identity at enrollment
 * @property {number} enrolledAtMs
 * @property {number} lastHeartbeatMs
 * @property {'active'|'stale'|'draining'|'retired'} state
 * @property {number} totalSlots
 * @property {number} usedSlots
 * @property {number} reservedSlots
 * @property {boolean} diskFull
 * @property {boolean} memCritical
 * @property {string[]} providers
 * @property {string[]} runtimes
 * @property {number} activeLeases
 */

export class HostRegistry {
  /**
   * @param {{ heartbeatTimeoutMs?: number }} [options]
   */
  constructor(options = {}) {
    const timeout = options.heartbeatTimeoutMs ?? 30_000;
    this.heartbeatTimeoutMs = timeout > 0 ? timeout : 30_000;
    /** @type {Map<string, HostRecord>} */
    this.hosts = new Map();
    /**
     * Issued join tokens: token -> { expiresAtMs, maxUses, uses }.
     * Real secret storage/transport lives outside this module; tokens here
     * are opaque handles so enrollment logic stays unit-testable.
     * @type {Map<string, { expiresAtMs: number, maxUses: number, uses: number }>}
     */
    this.joinTokens = new Map();
    this.enrollmentCounter = 0;
  }

  /**
   * Issue a single- (or few-)use enrollment token. Returns the opaque token.
   * @param {{ ttlMs: number, maxUses?: number, nowMs?: number }} args
   */
  issueJoinToken({ ttlMs, maxUses = 1, nowMs = Date.now() } = {}) {
    if (!(ttlMs > 0)) return { denied: 'invalid-ttl' };
    if (!(maxUses >= 1)) return { denied: 'invalid-max-uses' };
    this.enrollmentCounter += 1;
    const token = `join-${nowMs.toString(36)}-${this.enrollmentCounter.toString(36)}`;
    this.joinTokens.set(token, { expiresAtMs: nowMs + ttlMs, maxUses, uses: 0 });
    return { token };
  }

  static normalizeObservation(observation = {}) {
    return {
      totalSlots: Math.max(0, Math.floor(observation.totalSlots ?? 0)),
      usedSlots: Math.max(0, Math.floor(observation.usedSlots ?? 0)),
      reservedSlots: Math.max(0, Math.floor(observation.reservedSlots ?? 0)),
      diskFull: observation.diskFull === true,
      memCritical: observation.memCritical === true,
      providers: Array.isArray(observation.providers) ? [...observation.providers] : [],
      runtimes: Array.isArray(observation.runtimes) ? [...observation.runtimes] : [],
      activeLeases: Math.max(0, Math.floor(observation.activeLeases ?? 0)),
    };
  }

  /**
   * Enroll a new worker host. Denied (no side effect) on bad/expired/used-up
   * token, duplicate host id, or missing identity.
   */
  enroll({ hostId, tailscaleIdentity, joinToken, observation = {}, nowMs = Date.now() } = {}) {
    if (!hostId || !tailscaleIdentity || !joinToken) return { denied: 'invalid-enroll-args' };
    if (this.hosts.has(hostId)) return { denied: 'duplicate-host-id' };
    const grant = this.joinTokens.get(joinToken);
    if (!grant) return { denied: 'unknown-join-token' };
    if (nowMs > grant.expiresAtMs) return { denied: 'join-token-expired' };
    if (grant.uses >= grant.maxUses) return { denied: 'join-token-exhausted' };
    grant.uses += 1;
    const obs = HostRegistry.normalizeObservation(observation);
    const record = {
      id: hostId,
      tailscaleIdentity,
      enrolledAtMs: nowMs,
      lastHeartbeatMs: nowMs,
      state: 'active',
      ...obs,
    };
    this.hosts.set(hostId, record);
    return { host: { ...record } };
  }

  /** Record a heartbeat + latest resource observation for a known host. */
  heartbeat(hostId, observation = {}, nowMs = Date.now()) {
    const record = this.hosts.get(hostId);
    if (!record) return { denied: 'unknown-host' };
    if (record.state === 'retired') return { denied: 'host-retired' };
    const obs = HostRegistry.normalizeObservation(observation);
    Object.assign(record, obs, { lastHeartbeatMs: nowMs });
    if (record.state === 'stale') record.state = 'active';
    return { host: { ...record } };
  }

  /** Mark a host draining: it finishes current work but takes no new tasks. */
  setDraining(hostId) {
    const record = this.hosts.get(hostId);
    if (!record) return { denied: 'unknown-host' };
    if (record.state === 'retired') return { denied: 'host-retired' };
    record.state = 'draining';
    return { host: { ...record } };
  }

  /**
   * Refresh freshness states against `nowMs`: active hosts past the heartbeat
   * timeout become stale. Returns ids that transitioned.
   */
  refreshStates(nowMs = Date.now()) {
    const transitioned = [];
    for (const record of this.hosts.values()) {
      if (record.state === 'active' && nowMs - record.lastHeartbeatMs > this.heartbeatTimeoutMs) {
        record.state = 'stale';
        transitioned.push(record.id);
      }
    }
    return { transitioned };
  }

  /**
   * Deregister a host. Safe default: denied while the host reports active
   * leases (never scale down a host with live sessions). Forced removal
   * requires an explicit fence proof string and is auditable via the
   * retained record. Retired records are kept (not deleted) for audit.
   */
  deregister(hostId, { force = false, fenceProof = '', nowMs = Date.now() } = {}) {
    const record = this.hosts.get(hostId);
    if (!record) return { denied: 'unknown-host' };
    if (record.state === 'retired') return { denied: 'host-retired' };
    this.refreshStates(nowMs);
    const live = this.hosts.get(hostId);
    if (live.activeLeases > 0 && !(force === true && typeof fenceProof === 'string' && fenceProof.length > 0)) {
      return { denied: 'host-has-active-leases' };
    }
    live.state = 'retired';
    return { host: { ...live } };
  }

  /** Freshness check for one record at `nowMs`. */
  isFresh(record, nowMs = Date.now()) {
    return nowMs - record.lastHeartbeatMs <= this.heartbeatTimeoutMs;
  }

  /** Snapshot of one host (copy; undefined when unknown). */
  get(hostId) {
    const record = this.hosts.get(hostId);
    return record ? { ...record, providers: [...record.providers], runtimes: [...record.runtimes] } : undefined;
  }

  /** Snapshots of all hosts, deterministic order (lexical by id). */
  list() {
    return [...this.hosts.values()]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((r) => ({ ...r, providers: [...r.providers], runtimes: [...r.runtimes] }));
  }
}

/**
 * Free worker slots a host can actually offer right now.
 * @returns {{ free: number, reason: string }} reason is 'ok' or a machine-readable cause
 */
export function hostFreeCapacity(record, nowMs, heartbeatTimeoutMs = 30_000) {
  if (!record) return { free: 0, reason: 'unknown-host' };
  if (record.state === 'retired') return { free: 0, reason: 'host-retired' };
  if (record.state === 'draining') return { free: 0, reason: 'host-draining' };
  if (record.state !== 'active') return { free: 0, reason: 'host-not-active' };
  if (nowMs - record.lastHeartbeatMs > heartbeatTimeoutMs) return { free: 0, reason: 'host-stale' };
  if (record.diskFull) return { free: 0, reason: 'host-disk-full' };
  if (record.memCritical) return { free: 0, reason: 'host-memory-critical' };
  const free = record.totalSlots - record.usedSlots - record.reservedSlots;
  if (free <= 0) return { free: 0, reason: 'host-capacity-exhausted' };
  return { free, reason: 'ok' };
}

/**
 * Whether a host may receive a task needing `estimatedSlots` of `provider`/
 * `runtime` right now. Pure; used by distributed admission and unit-tested.
 */
export function hostFits(record, { estimatedSlots = 1, provider, runtime, nowMs = Date.now(), heartbeatTimeoutMs = 30_000 } = {}) {
  const need = Math.max(1, Math.floor(estimatedSlots));
  const { free, reason } = hostFreeCapacity(record, nowMs, heartbeatTimeoutMs);
  if (reason !== 'ok') return { fits: false, reason };
  if (free < need) return { fits: false, reason: 'host-capacity-exhausted' };
  if (provider !== undefined && !record.providers.includes(provider)) {
    return { fits: false, reason: 'no-host-supports-provider' };
  }
  if (runtime !== undefined && !record.runtimes.includes(runtime)) {
    return { fits: false, reason: 'no-host-supports-runtime' };
  }
  return { fits: true, reason: 'ok' };
}
