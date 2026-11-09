/**
 * FF-017 focused tests — run with: `node --test apps/web/src/features/inbox/`
 * Stdlib only (`node:test`, `node:assert`), no framework to install.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DECISION_STATUS,
  TASK_STATUS,
  answerDecision,
  blockedClosure,
  buildDigest,
  computeExecutionPlan,
  evaluateApproval,
  expireDueDecisions,
  gatingDecisions,
  routeOwnerQuestion,
  transitiveDependents,
  validateDecisionItem,
} from './inbox-policy.mjs';
import { EDGES, TASK_IDS, baseTasks, docsBlockedDecision, webBlockedDecision } from './fixtures.mjs';

const NOW = Date.parse('2026-11-08T13:00:00Z');

describe('FF-017 acceptance: only blocked dependents wait', () => {
  it('blocks the gated task and its dependents, everything else continues', () => {
    const plan = computeExecutionPlan({ tasks: baseTasks(), edges: EDGES, decisions: [webBlockedDecision()] });
    assert.deepEqual(
      plan.blocked.map((b) => b.taskId).sort(),
      [TASK_IDS.RELEASE, TASK_IDS.WEB],
    );
    assert.deepEqual(plan.runnable.sort(), [TASK_IDS.DOCS, TASK_IDS.IOS]);
  });

  it('with no open decisions every ready task is runnable', () => {
    const plan = computeExecutionPlan({ tasks: baseTasks(), edges: EDGES, decisions: [] });
    assert.deepEqual(plan.blocked, []);
    assert.deepEqual(plan.runnable.sort(), [TASK_IDS.DOCS, TASK_IDS.IOS, TASK_IDS.RELEASE, TASK_IDS.WEB]);
  });

  it('answered and withdrawn decisions release their tasks', () => {
    const released = [
      { ...webBlockedDecision(), status: DECISION_STATUS.ANSWERED },
      { ...docsBlockedDecision(), status: DECISION_STATUS.WITHDRAWN },
    ];
    const plan = computeExecutionPlan({ tasks: baseTasks(), edges: EDGES, decisions: released });
    assert.deepEqual(plan.blocked, []);
    assert.equal(gatingDecisions(released).length, 0);
  });

  it('non-ready tasks are neither runnable nor counted as waiting', () => {
    const tasks = baseTasks().map((t) =>
      t.id === TASK_IDS.IOS ? { ...t, status: TASK_STATUS.RUNNING } : t,
    );
    const plan = computeExecutionPlan({ tasks, edges: EDGES, decisions: [webBlockedDecision()] });
    assert.ok(!plan.runnable.includes(TASK_IDS.IOS));
    assert.ok(!plan.blocked.some((b) => b.taskId === TASK_IDS.IOS));
  });
});

describe('dependency traversal', () => {
  it('collects transitive dependents of the gated task', () => {
    assert.deepEqual(transitiveDependents(TASK_IDS.WEB, EDGES), [TASK_IDS.RELEASE]);
    assert.deepEqual(
      new Set(transitiveDependents(TASK_IDS.API, EDGES)),
      new Set([TASK_IDS.WEB, TASK_IDS.IOS, TASK_IDS.RELEASE]),
    );
  });

  it('terminates on cyclic edges instead of hanging', () => {
    const cyclic = [...EDGES, [TASK_IDS.RELEASE, TASK_IDS.API]];
    const deps = transitiveDependents(TASK_IDS.API, cyclic);
    assert.ok(deps.includes(TASK_IDS.WEB));
    assert.ok(!deps.includes(TASK_IDS.API));
  });

  it('blockedClosure attributes each waiting task to its gating decisions', () => {
    const closure = blockedClosure([webBlockedDecision(), docsBlockedDecision()], EDGES);
    assert.deepEqual(closure.get(TASK_IDS.RELEASE), ['dec-web-api-shape']);
    assert.deepEqual(closure.get(TASK_IDS.DOCS), ['dec-docs-wording']);
    assert.ok(!closure.has(TASK_IDS.IOS));
  });
});

describe('sleep routing: queue owner questions, never drop or auto-answer', () => {
  const question = webBlockedDecision();

  for (const sleeping of [true, false]) {
    it(`queues owner-required questions while ${sleeping ? 'asleep' : 'awake'}`, () => {
      const routed = routeOwnerQuestion({ sleeping, requiresOwner: true, question });
      assert.equal(routed.action, 'queue');
      assert.equal(routed.decision.status, DECISION_STATUS.PROPOSED);
    });
  }

  it('keeps coordinator-resolvable questions out of the inbox even while asleep', () => {
    const routed = routeOwnerQuestion({ sleeping: true, requiresOwner: false, question });
    assert.equal(routed.action, 'resolve-direct');
    assert.equal(routed.decision, undefined);
  });
});

describe('decision answers: signed, fresh-SHA, never auto-approved', () => {
  const ownerAnswer = {
    approver: 'owner:1',
    isOwner: true,
    choice: 'adopt-openapi-shape',
    targetSha: 'abc1234',
    nowMs: NOW,
  };

  it('accepts a signed owner answer against the current target SHA', () => {
    const result = answerDecision(webBlockedDecision(), ownerAnswer);
    assert.equal(result.ok, true);
    assert.equal(result.decision.status, DECISION_STATUS.ANSWERED);
  });

  it('rejects answers that are not owner-signed', () => {
    const result = answerDecision(webBlockedDecision(), { ...ownerAnswer, isOwner: false });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'not-owner-signed');
  });

  it('rejects stale-SHA answers and reopens the decision instead of applying them', () => {
    const result = answerDecision(webBlockedDecision(), { ...ownerAnswer, targetSha: 'stale999' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'stale-target-sha');
    assert.equal(result.decision.status, DECISION_STATUS.PENDING);
  });

  it('rejects choices outside the offered options', () => {
    const result = answerDecision(webBlockedDecision(), { ...ownerAnswer, choice: 'rewrite-everything' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'unknown-choice');
  });

  it('expiry blocks but never approves: past-due decisions flip to expired and stay unanswerable', () => {
    const expired = expireDueDecisions([webBlockedDecision()], Date.parse('2026-11-10T00:00:00Z'));
    assert.equal(expired[0].status, DECISION_STATUS.EXPIRED);
    const attempt = answerDecision(expired[0], ownerAnswer);
    assert.equal(attempt.ok, false);
    assert.equal(attempt.error, 'expired-never-approves');
    const plan = computeExecutionPlan({ tasks: baseTasks(), edges: EDGES, decisions: expired });
    assert.ok(plan.blocked.some((b) => b.taskId === TASK_IDS.WEB));
  });

  it('does not expire decisions before their deadline', () => {
    const current = expireDueDecisions([webBlockedDecision()], NOW);
    assert.equal(current[0].status, DECISION_STATUS.PENDING);
  });
});

describe('sleep never changes approval outcomes', () => {
  const answer = { approver: 'owner:1', isOwner: true, targetSha: 'abc1234' };

  it('grants identically awake and asleep for a valid answer', () => {
    const awake = evaluateApproval(webBlockedDecision(), answer, { sleeping: false });
    const asleep = evaluateApproval(webBlockedDecision(), answer, { sleeping: true });
    assert.deepEqual([awake, asleep], [
      { granted: true, reason: 'owner-signed-fresh-sha' },
      { granted: true, reason: 'owner-signed-fresh-sha' },
    ]);
  });

  it('denies identically awake and asleep for expired or stale answers', () => {
    const expired = { ...webBlockedDecision(), status: DECISION_STATUS.EXPIRED };
    for (const sleeping of [true, false]) {
      assert.equal(evaluateApproval(expired, answer, { sleeping }).granted, false);
      assert.equal(
        evaluateApproval(webBlockedDecision(), { ...answer, targetSha: 'old' }, { sleeping }).granted,
        false,
      );
    }
  });
});

describe('morning digest: one consolidated view, pending ordered by blast radius', () => {
  it('orders the wider-blocking decision first and reports verified work', () => {
    const digest = buildDigest({
      decisions: [docsBlockedDecision(), webBlockedDecision()],
      tasks: baseTasks(),
      edges: EDGES,
      pullRequests: [{ ref: 'PR #12', state: 'checks-passing' }],
      workerCount: 3,
      nowMs: NOW,
    });
    assert.deepEqual(
      digest.pendingDecisions.map((d) => d.id),
      ['dec-web-api-shape', 'dec-docs-wording'],
    );
    assert.deepEqual(digest.pendingDecisions[0], {
      id: 'dec-web-api-shape',
      taskId: TASK_IDS.WEB,
      severity: 'high',
      blastRadius: 2,
    });
    assert.deepEqual(digest.verified, [TASK_IDS.API]);
    assert.equal(digest.workerCount, 3);
    assert.equal(digest.pullRequests.length, 1);
  });

  it('renders an empty inbox without errors', () => {
    const digest = buildDigest({
      decisions: [],
      tasks: baseTasks(),
      edges: EDGES,
      pullRequests: [],
      workerCount: 0,
      nowMs: NOW,
    });
    assert.deepEqual(digest.pendingDecisions, []);
    assert.deepEqual(digest.verified, [TASK_IDS.API]);
  });
});

describe('decision item validation', () => {
  it('accepts the fully-populated fixture item', () => {
    assert.deepEqual(validateDecisionItem(webBlockedDecision()), { ok: true, errors: [] });
  });

  it('flags missing required fields', () => {
    const { ok, errors } = validateDecisionItem({ id: 'x', status: 'pending' });
    assert.equal(ok, false);
    assert.ok(errors.includes('missing:projectId'));
    assert.ok(errors.includes('missing:blockedTasks'));
  });

  it('rejects auto-approve defaults and bad severity/status', () => {
    const { errors } = validateDecisionItem({
      ...webBlockedDecision(),
      defaultOnTimeout: 'approve',
      severity: 'whenever',
      status: 'napping',
    });
    assert.ok(errors.includes('invalid:defaultOnTimeout:must-never-auto-approve'));
    assert.ok(errors.some((e) => e.startsWith('invalid:severity')));
    assert.ok(errors.some((e) => e.startsWith('invalid:status')));
  });
});
