/**
 * Threat-model deny tests for FF-004.
 *
 * Each test maps to a row in docs/03-architecture/security-policy.md
 * ("threat -> policy rule") and to the security section of
 * docs/05-contracts/contract-test-cases.md:
 * malicious PR text, stolen session scope, cross-project message,
 * forged/escalating approval, unauthorized main merge.
 *
 * Run: `npm test` inside packages/policy (node --test, stdlib only).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { authorize, allowedActionsFor } from '../src/policy.js';

const NOW = 1760000000000;
const FRESH = (overrides = {}) => ({
  grantedBy: 'owner',
  authProof: 'srv-auth-1',
  action: 'merge.main',
  resourceId: 'pr-1',
  targetSha: 'abc123',
  expiresAt: NOW + 60_000,
  ...overrides,
});

const actor = (role, extra = {}) => ({
  type: role === 'owner' ? 'human' : 'agent',
  id: `${role}-1`,
  role,
  projects: ['proj-a'],
  ...extra,
});

const resource = (extra = {}) => ({ kind: 'pr', id: 'pr-1', projectId: 'proj-a', ...extra });

describe('message content is never authority', () => {
  it('denies when authority is claimed via message even for an owner-shaped request', () => {
    const d = authorize({
      actor: actor('owner', { projects: undefined }),
      action: 'merge.main',
      resource: { ...resource(), headSha: 'abc123' },
      context: { claimedViaMessage: true, now: NOW, approval: FRESH() },
    });
    assert.equal(d.verdict, 'deny');
    assert.equal(d.reasonCode, 'MESSAGE_NOT_AUTHORITY');
  });

  it('denies approval objects with message origin', () => {
    const d = authorize({
      actor: actor('owner', { projects: undefined }),
      action: 'deploy.production',
      resource: { ...resource(), headSha: 'abc123' },
      context: { now: NOW, approval: { ...FRESH(), action: 'deploy.production', origin: 'message' } },
    });
    assert.notEqual(d.verdict, 'allow');
  });
});

describe('main merge is owner-only at the exact SHA', () => {
  const main = { ...resource(), headSha: 'abc123' };

  it('worker is denied outright (matrix: No), never queued', () => {
    const d = authorize({ actor: actor('worker'), action: 'merge.main', resource: main, context: { now: NOW } });
    assert.equal(d.verdict, 'deny');
    assert.equal(d.reasonCode, 'ROLE_NOT_PERMITTED');
  });

  it('coordinator can only request, never execute', () => {
    const d = authorize({ actor: actor('coordinator'), action: 'merge.main', resource: main, context: { now: NOW } });
    assert.equal(d.verdict, 'require_owner');
  });

  it('owner with fresh SHA-pinned approval is allowed', () => {
    const d = authorize({
      actor: actor('owner', { projects: undefined }),
      action: 'merge.main',
      resource: main,
      context: { now: NOW, approval: FRESH() },
    });
    assert.equal(d.verdict, 'allow');
  });

  it('expired owner approval grants nothing', () => {
    const d = authorize({
      actor: actor('owner', { projects: undefined }),
      action: 'merge.main',
      resource: main,
      context: { now: NOW, approval: FRESH({ expiresAt: NOW - 1 }) },
    });
    assert.equal(d.verdict, 'deny');
    assert.equal(d.reasonCode, 'OWNER_APPROVAL_EXPIRED');
  });

  it('changed head SHA after approval reopens the decision', () => {
    const d = authorize({
      actor: actor('owner', { projects: undefined }),
      action: 'merge.main',
      resource: { ...main, headSha: 'def456' },
      context: { now: NOW, approval: FRESH() },
    });
    assert.equal(d.verdict, 'deny');
    assert.equal(d.reasonCode, 'OWNER_APPROVAL_SHA_MISMATCH');
  });

  it('missing targetSha on the approval rejects fail-closed', () => {
    const { targetSha, ...noSha } = FRESH();
    const d = authorize({
      actor: actor('owner', { projects: undefined }),
      action: 'merge.main',
      resource: main,
      context: { now: NOW, approval: noSha },
    });
    assert.equal(d.verdict, 'deny');
    assert.equal(d.reasonCode, 'OWNER_APPROVAL_SHA_MISSING');
  });

  it('missing resourceId on the approval rejects fail-closed', () => {
    const { resourceId, ...noTarget } = FRESH();
    const d = authorize({
      actor: actor('owner', { projects: undefined }),
      action: 'merge.main',
      resource: main,
      context: { now: NOW, approval: noTarget },
    });
    assert.equal(d.verdict, 'deny');
    assert.equal(d.reasonCode, 'OWNER_APPROVAL_TARGET_MISSING');
  });

  it('missing current SHA on the resource rejects fail-closed', () => {
    const { headSha, ...noCurrentSha } = main;
    const d = authorize({
      actor: actor('owner', { projects: undefined }),
      action: 'merge.main',
      resource: noCurrentSha,
      context: { now: NOW, approval: FRESH() },
    });
    assert.equal(d.verdict, 'deny');
    assert.equal(d.reasonCode, 'OWNER_APPROVAL_SHA_MISSING');
  });

  it('approval without server-minted auth proof is not an approval', () => {
    const { authProof, ...noProof } = FRESH();
    const d = authorize({
      actor: actor('owner', { projects: undefined }),
      action: 'merge.main',
      resource: main,
      context: { now: NOW, approval: noProof },
    });
    assert.equal(d.verdict, 'deny');
    assert.equal(d.reasonCode, 'OWNER_APPROVAL_UNAUTHENTICATED');
  });

  it('empty-string bindings reject like missing ones', () => {
    for (const approval of [
      FRESH({ targetSha: '' }),
      FRESH({ resourceId: '' }),
      FRESH({ authProof: '' }),
    ]) {
      const d = authorize({
        actor: actor('owner', { projects: undefined }),
        action: 'merge.main',
        resource: main,
        context: { now: NOW, approval },
      });
      assert.equal(d.verdict, 'deny', JSON.stringify(approval));
    }
  });

  it('approval for a different action does not transfer', () => {
    const d = authorize({
      actor: actor('owner', { projects: undefined }),
      action: 'merge.main',
      resource: main,
      context: { now: NOW, approval: FRESH({ action: 'deploy.production' }) },
    });
    assert.notEqual(d.verdict, 'allow');
  });
});

describe('develop merge keeps independent review and green checks', () => {
  const good = { ...resource(), headSha: 'abc123', checksPass: true, authorId: 'worker-1', reviewerId: 'lead-9' };

  it('worker and lead can never merge develop', () => {
    for (const role of ['worker', 'lead']) {
      const d = authorize({ actor: actor(role), action: 'merge.develop', resource: good, context: { now: NOW } });
      assert.equal(d.verdict, 'deny', role);
      assert.equal(d.reasonCode, 'ROLE_NOT_PERMITTED');
    }
  });

  it('coordinator merges only with green checks plus independent reviewer', () => {
    const d = authorize({ actor: actor('coordinator'), action: 'merge.develop', resource: good, context: { now: NOW } });
    assert.equal(d.verdict, 'allow');
  });

  it('checks unbound to any head SHA are rejected', () => {
    const { headSha, ...noSha } = good;
    const d = authorize({
      actor: actor('coordinator'),
      action: 'merge.develop',
      resource: noSha,
      context: { now: NOW },
    });
    assert.equal(d.verdict, 'deny');
    assert.equal(d.reasonCode, 'CHECKS_SHA_MISSING');
  });

  it('coordinator is denied when checks fail', () => {
    const d = authorize({
      actor: actor('coordinator'),
      action: 'merge.develop',
      resource: { ...good, checksPass: false },
      context: { now: NOW },
    });
    assert.equal(d.verdict, 'deny');
    assert.equal(d.reasonCode, 'CHECKS_NOT_PASSING');
  });

  it('self-review never satisfies the reviewer gate', () => {
    const d = authorize({
      actor: { type: 'agent', id: 'worker-1', role: 'coordinator', projects: ['proj-a'] },
      action: 'merge.develop',
      resource: { ...good, reviewerId: 'worker-1' },
      context: { now: NOW },
    });
    assert.equal(d.verdict, 'deny');
    assert.equal(d.reasonCode, 'REVIEW_NOT_INDEPENDENT');
  });

  it('review.approve denies self-approval', () => {
    const d = authorize({
      actor: actor('worker'),
      action: 'review.approve',
      resource: { ...resource(), authorId: 'worker-1' },
      context: { now: NOW },
    });
    assert.equal(d.verdict, 'deny');
    assert.equal(d.reasonCode, 'SELF_APPROVAL');
  });
});

describe('cross-project isolation', () => {
  it('denies reads outside the actor project scope', () => {
    const d = authorize({
      actor: actor('worker'),
      action: 'task.read',
      resource: resource({ projectId: 'proj-b' }),
      context: { now: NOW },
    });
    assert.equal(d.verdict, 'deny');
    assert.equal(d.reasonCode, 'CROSS_PROJECT_DENIED');
  });

  it('denies cross-project messages', () => {
    const d = authorize({
      actor: actor('worker'),
      action: 'message.post',
      resource: resource({ projectId: 'proj-b' }),
      context: { now: NOW },
    });
    assert.equal(d.verdict, 'deny');
    assert.equal(d.reasonCode, 'CROSS_PROJECT_DENIED');
  });

  it('denies stolen session scope even when project list matches', () => {
    const d = authorize({
      actor: actor('worker', { projects: ['proj-a', 'proj-b'], sessionProjectId: 'proj-a' }),
      action: 'task.read',
      resource: resource({ projectId: 'proj-b' }),
      context: { now: NOW },
    });
    assert.equal(d.verdict, 'deny');
    assert.equal(d.reasonCode, 'SESSION_SCOPE_MISMATCH');
  });

  it('cross-project secrets read is DENY-class even for the owner', () => {
    const d = authorize({
      actor: actor('owner', { projects: undefined }),
      action: 'secrets.read-cross-project',
      resource: resource({ projectId: 'proj-b' }),
      context: { now: NOW },
    });
    assert.equal(d.verdict, 'deny');
    assert.equal(d.reasonCode, 'ALWAYS_DENY');
  });

  it('protection bypass is denied for every role', () => {
    for (const role of ['owner', 'coordinator', 'lead', 'worker', 'reviewer', 'service']) {
      const d = authorize({
        actor: actor(role, { projects: undefined }),
        action: 'protection.bypass',
        resource: resource(),
        context: { now: NOW },
      });
      assert.equal(d.verdict, 'deny', role);
    }
  });
});

describe('privileged operations queue instead of executing', () => {
  it('production deploy: worker denied, coordinator/lead request-only', () => {
    const res = { ...resource(), headSha: 'abc123' };
    assert.equal(
      authorize({ actor: actor('worker'), action: 'deploy.production', resource: res, context: { now: NOW } }).verdict,
      'deny',
    );
    for (const role of ['coordinator', 'lead']) {
      const d = authorize({ actor: actor(role), action: 'deploy.production', resource: res, context: { now: NOW } });
      assert.equal(d.verdict, 'require_owner', role);
    }
  });

  it('sleep mode queues owner-required work instead of approving it', () => {
    const d = authorize({
      actor: actor('coordinator'),
      action: 'deploy.production',
      resource: { ...resource(), headSha: 'abc123' },
      context: { now: NOW, sleeping: true },
    });
    assert.equal(d.verdict, 'require_owner');
    assert.equal(d.reasonCode, 'SLEEP_QUEUED');
  });

  it('sleep-expiry origin never counts as approval', () => {
    const d = authorize({
      actor: actor('owner', { projects: undefined }),
      action: 'deploy.production',
      resource: { ...resource(), id: 'dep-1', headSha: 'abc123' },
      context: {
        now: NOW,
        approval: { grantedBy: 'owner', authProof: 'srv-auth-1', action: 'deploy.production', resourceId: 'dep-1', targetSha: 'abc123', expiresAt: NOW + 1000, origin: 'sleep-expiry' },
      },
    });
    assert.notEqual(d.verdict, 'allow');
  });

  it('secrets rotation needs owner re-auth plus approval', () => {
    const res = resource({ kind: 'secret' });
    const noReauth = authorize({
      actor: actor('owner', { projects: undefined }),
      action: 'secrets.rotate',
      resource: res,
      context: { now: NOW, approval: { grantedBy: 'owner', action: 'secrets.rotate', expiresAt: NOW + 1000 } },
    });
    assert.equal(noReauth.verdict, 'require_owner');
    assert.equal(noReauth.reasonCode, 'OWNER_REAUTH_REQUIRED');
  });

  it('destruction requires explicit confirmation even from the owner', () => {
    const d = authorize({
      actor: actor('owner', { projects: undefined }),
      action: 'resource.destroy',
      resource: resource({ kind: 'database' }),
      context: { now: NOW, approval: { grantedBy: 'owner', action: 'resource.destroy', resourceId: 'pr-1', expiresAt: NOW + 1000 } },
    });
    assert.equal(d.verdict, 'deny');
    assert.equal(d.reasonCode, 'CONFIRMATION_REQUIRED');
  });
});

describe('closed world and introspection', () => {
  it('unknown actions and roles deny', () => {
    assert.equal(
      authorize({ actor: actor('worker'), action: 'db.wipe', resource: resource(), context: { now: NOW } }).reasonCode,
      'UNKNOWN_ACTION',
    );
    assert.equal(
      authorize({ actor: { type: 'agent', id: 'x', role: 'superadmin', projects: ['proj-a'] }, action: 'task.read', resource: resource(), context: { now: NOW } }).reasonCode,
      'UNKNOWN_ROLE',
    );
  });

  it('allowedActionsFor never lists main merge for workers', () => {
    assert.ok(!allowedActionsFor('worker').includes('merge.main'));
    assert.ok(!allowedActionsFor('worker').includes('merge.develop'));
    assert.ok(allowedActionsFor('coordinator').includes('merge.develop'));
  });
});
