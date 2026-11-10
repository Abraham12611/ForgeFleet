/**
 * FF-023 security regression: non-finite timestamps, empty reviewer binding,
 * unauthorized actors, and approval provenance.
 *
 * P0 hole (PR #53 review): the canonical FF-004 engine used a typeof-only
 * check on time inputs, so NaN/Infinity slipped through fail-closed expiry:
 *  - `ownerApprovalError()` treated `expiresAt: NaN` as unexpired because
 *    `now >= NaN` is always false (expiry bypass -> allow);
 *  - `expiresAt: Infinity` never expires (immortal approval -> allow);
 *  - `authorize()` accepted `context.now = NaN` via the typeof-only
 *    default, so even an EXPIRED approval passed the `now >= expiresAt`
 *    check (trusted-clock bypass -> allow).
 * Fail-closed rule pinned here: only finite epoch-ms values are time.
 * Non-finite `expiresAt` denies as OWNER_APPROVAL_EXPIRED; non-finite
 * `context.now` falls back to the trusted clock (`Date.now()`), never to
 * attacker-controlled time.
 *
 * Also pinned: an empty-string merge reviewer is NOT an independent
 * reviewer, roles outside the catalog entry cannot execute, and a truthy
 * but non-string `authProof` carried in request JSON verifies nothing
 * (only a server-minted non-empty string passes shape; minting itself is
 * the boundary's job, proven in boundary.test.js).
 *
 * Run: `npm test` inside packages/policy (node --test, stdlib only).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { authorize } from '../src/policy.js';

const NOW = 1760000000000;

const FRESH_APPROVAL = (overrides = {}) => ({
  grantedBy: 'owner',
  authProof: 'srv-auth-1',
  action: 'merge.main',
  resourceId: 'pr-1',
  targetSha: 'abc123',
  expiresAt: NOW + 60_000,
  ...overrides,
});

const ownerActor = { type: 'human', id: 'owner-1', role: 'owner' };

const agentActor = (role, extra = {}) => ({
  type: 'agent',
  id: `${role}-1`,
  role,
  projects: ['proj-a'],
  ...extra,
});

const prResource = (extra = {}) => ({
  kind: 'pr',
  id: 'pr-1',
  projectId: 'proj-a',
  headSha: 'abc123',
  ...extra,
});

describe('FF-023: non-finite expiresAt never grants authority', () => {
  for (const expiresAt of [NaN, Infinity, -Infinity]) {
    it(`expiresAt=${String(expiresAt)} denies as expired on merge.main`, () => {
      const d = authorize({
        actor: ownerActor,
        action: 'merge.main',
        resource: prResource(),
        context: { now: NOW, approval: FRESH_APPROVAL({ expiresAt }) },
      });
      assert.equal(d.verdict, 'deny', `expiresAt=${String(expiresAt)}`);
      assert.equal(d.reasonCode, 'OWNER_APPROVAL_EXPIRED');
    });
  }

  it('expiresAt=NaN denies on deploy.production (shared helper, not per-action)', () => {
    const d = authorize({
      actor: ownerActor,
      action: 'deploy.production',
      resource: prResource(),
      context: {
        now: NOW,
        approval: FRESH_APPROVAL({ action: 'deploy.production', expiresAt: NaN }),
      },
    });
    assert.equal(d.verdict, 'deny');
    assert.equal(d.reasonCode, 'OWNER_APPROVAL_EXPIRED');
  });
});

describe('FF-023: non-finite context.now falls back to the trusted clock', () => {
  it('context.now=NaN cannot resurrect an expired approval', () => {
    const d = authorize({
      actor: ownerActor,
      action: 'merge.main',
      resource: prResource(),
      // Expired under BOTH the requested clock and the real clock
      // (fixed NOW is in the past), so only an expiry bypass could allow.
      context: { now: NaN, approval: FRESH_APPROVAL({ expiresAt: NOW - 1 }) },
    });
    assert.equal(d.verdict, 'deny');
    assert.equal(d.reasonCode, 'OWNER_APPROVAL_EXPIRED');
  });

  it('context.now=Infinity cannot shift expiry either', () => {
    const d = authorize({
      actor: ownerActor,
      action: 'merge.main',
      resource: prResource(),
      context: { now: Infinity, approval: FRESH_APPROVAL({ expiresAt: NOW - 1 }) },
    });
    assert.equal(d.verdict, 'deny');
    assert.equal(d.reasonCode, 'OWNER_APPROVAL_EXPIRED');
  });
});

describe('FF-023: empty merge reviewer is not independent review', () => {
  const developResource = (reviewerId) => ({
    ...prResource(),
    authorId: 'worker-1',
    reviewerId,
    checksPass: true,
  });

  it("reviewerId='' denies on merge.develop", () => {
    const d = authorize({
      actor: agentActor('coordinator'),
      action: 'merge.develop',
      resource: developResource(''),
      context: { now: NOW },
    });
    assert.equal(d.verdict, 'deny');
    assert.equal(d.reasonCode, 'REVIEW_NOT_INDEPENDENT');
  });

  it('independent non-empty reviewer still allows (gate is not deny-all)', () => {
    const d = authorize({
      actor: agentActor('coordinator'),
      action: 'merge.develop',
      resource: developResource('lead-9'),
      context: { now: NOW },
    });
    assert.equal(d.verdict, 'allow');
  });
});

describe('FF-023: unauthorized actors cannot execute privileged actions', () => {
  it("role outside the catalog entry cannot execute merge.main", () => {
    const d = authorize({
      actor: agentActor('worker'),
      action: 'merge.main',
      resource: prResource(),
      context: { now: NOW, approval: FRESH_APPROVAL() },
    });
    assert.equal(d.verdict, 'deny');
    assert.equal(d.reasonCode, 'ROLE_NOT_PERMITTED');
  });

  it('unknown role denies closed-world', () => {
    const d = authorize({
      actor: { type: 'agent', id: 'x-1', role: 'superadmin', projects: ['proj-a'] },
      action: 'merge.main',
      resource: prResource(),
      context: { now: NOW, approval: FRESH_APPROVAL() },
    });
    assert.equal(d.verdict, 'deny');
    assert.equal(d.reasonCode, 'UNKNOWN_ROLE');
  });
});

describe('FF-023: truthy request-JSON authProof verifies nothing by itself', () => {
  for (const authProof of [1, true, {}, ['srv-auth-1']]) {
    it(`authProof=${JSON.stringify(authProof)} denies as unauthenticated`, () => {
      const d = authorize({
        actor: ownerActor,
        action: 'merge.main',
        resource: prResource(),
        context: { now: NOW, approval: FRESH_APPROVAL({ authProof }) },
      });
      assert.equal(d.verdict, 'deny', `authProof=${JSON.stringify(authProof)}`);
      assert.equal(d.reasonCode, 'OWNER_APPROVAL_UNAUTHENTICATED');
    });
  }
});
