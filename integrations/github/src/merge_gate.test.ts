import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CANONICAL_POLICY_VERSION,
  MERGE_GATE_POLICY_VERSION,
  evaluateGitHubEvidence,
  evaluateMergeGate,
  prResourceId,
  toAuthorizeInput,
  type MergeActor,
  type MergeGateInput,
  type OwnerApproval,
  type PullRequestRef,
  type RequiredCheckPolicy,
} from "./merge_gate.ts";

const NOW = 1_700_000_000_000;

const POLICY: RequiredCheckPolicy = {
  version: "repo-policy-v1",
  targets: { develop: ["ci"], main: ["ci", "security"] },
};

function pr(overrides: Partial<PullRequestRef> = {}): PullRequestRef {
  return {
    repoId: "repo_1",
    prNumber: 7,
    headSha: "abc123",
    targetBranch: "develop",
    authorId: "worker-1",
    ...overrides,
  };
}

function input(overrides: Partial<MergeGateInput> = {}): MergeGateInput {
  return {
    policyVersion: MERGE_GATE_POLICY_VERSION,
    pr: pr(),
    actor: { id: "coordinator-1", role: "coordinator" },
    checks: [{ name: "ci", headSha: "abc123", status: "pass" }],
    checkPolicy: POLICY,
    reviews: [
      { reviewerId: "reviewer-1", kind: "agent", headSha: "abc123", decision: "approve" },
    ],
    approval: null,
    now: NOW,
    ...overrides,
  };
}

function ownerApproval(overrides: Partial<OwnerApproval> = {}): OwnerApproval {
  return {
    grantedBy: "owner",
    authProof: "server-minted-proof-1",
    action: "merge.main",
    resourceId: "github-pr:repo_1:7:main",
    targetSha: "abc123",
    expiresAt: NOW + 3600_000,
    ...overrides,
  };
}

const owner: MergeActor = { id: "owner-1", role: "human-owner" };

describe("fail-closed required-check policy (PR #58 review)", () => {
  it("denies when no check policy is configured, even with a review", () => {
    const d = evaluateMergeGate(input({ checkPolicy: null, checks: [] }));
    assert.equal(d.allowed, false);
    assert.equal(d.verdict, "deny");
    assert.equal(d.reasonCode, "CHECK_POLICY_MISSING");
  });

  it("denies when the policy is silent about the target", () => {
    const d = evaluateMergeGate(
      input({
        checkPolicy: { version: "v", targets: { develop: ["ci"] } },
        pr: pr({ targetBranch: "main" }),
        actor: owner,
        checks: [
          { name: "ci", headSha: "abc123", status: "pass" },
          { name: "security", headSha: "abc123", status: "pass" },
        ],
        approval: ownerApproval(),
      }),
    );
    assert.equal(d.allowed, false);
    assert.equal(d.reasonCode, "CHECK_POLICY_UNKNOWN_TARGET");
  });

  it("denies an empty required set: callers cannot smuggle in zero checks", () => {
    const d = evaluateMergeGate(
      input({
        checkPolicy: { version: "v", targets: { develop: [] } },
        checks: [],
      }),
    );
    assert.equal(d.allowed, false);
    assert.equal(d.verdict, "deny");
    assert.equal(d.reasonCode, "CHECK_POLICY_EMPTY");
  });

  it("requires every policy check green at the current head (main needs both)", () => {
    const ref = pr({ targetBranch: "main" });
    const base = input({
      pr: ref,
      actor: owner,
      checks: [{ name: "ci", headSha: "abc123", status: "pass" }],
      approval: ownerApproval(),
    });
    const d = evaluateMergeGate(base);
    assert.equal(d.allowed, false);
    assert.equal(d.reasonCode, "CHECKS_NOT_PASSING");
    const full = evaluateMergeGate({
      ...base,
      checks: [
        ...base.checks,
        { name: "security", headSha: "abc123", status: "pass" },
      ],
    });
    assert.equal(full.allowed, true);
    assert.equal(full.reasonCode, "OK");
  });
});

describe("develop merge gate", () => {
  it("allows coordinator merge when checks pass and independent review exists", () => {
    const d = evaluateMergeGate(input());
    assert.equal(d.allowed, true);
    assert.equal(d.verdict, "allow");
    assert.deepEqual(d.reasons, []);
  });

  it("forbids worker merges even with green checks and review", () => {
    const d = evaluateMergeGate(
      input({ actor: { id: "worker-2", role: "worker" } }),
    );
    assert.equal(d.allowed, false);
    assert.equal(d.reasonCode, "ROLE_NOT_PERMITTED");
  });

  it("denies the integration-worker role: closed world, no unilateral privilege", () => {
    const d = evaluateMergeGate(
      input({ actor: { id: "merge-worker-1", role: "integration-worker" } }),
    );
    assert.equal(d.allowed, false);
    assert.equal(d.reasonCode, "UNKNOWN_ROLE");
  });

  it("forbids self-merge by the PR author", () => {
    const d = evaluateMergeGate(
      input({ actor: { id: "worker-1", role: "coordinator" } }),
    );
    assert.equal(d.allowed, false);
    assert.equal(d.reasonCode, "SELF_MERGE");
  });

  it("blocks on failing, pending, or superseded check results", () => {
    for (const checks of [
      [{ name: "ci", headSha: "abc123", status: "fail" as const }],
      [{ name: "ci", headSha: "abc123", status: "pending" as const }],
      [{ name: "ci", headSha: "old999", status: "pass" as const }],
    ]) {
      const d = evaluateMergeGate(input({ checks }));
      assert.equal(d.allowed, false);
      assert.equal(d.reasonCode, "CHECKS_NOT_PASSING");
    }
  });

  it("blocks without an independent review; self-approval never counts", () => {
    assert.equal(evaluateMergeGate(input({ reviews: [] })).reasonCode, "REVIEW_NOT_INDEPENDENT");
    const selfOnly = evaluateMergeGate(
      input({
        reviews: [
          { reviewerId: "worker-1", kind: "agent", headSha: "abc123", decision: "approve" },
        ],
      }),
    );
    assert.equal(selfOnly.allowed, false);
    assert.equal(selfOnly.reasonCode, "REVIEW_NOT_INDEPENDENT");
  });

  it("blocks on unresolved request-changes at the current head", () => {
    const d = evaluateMergeGate(
      input({
        reviews: [
          { reviewerId: "reviewer-1", kind: "agent", headSha: "abc123", decision: "approve" },
          { reviewerId: "reviewer-2", kind: "human-owner", headSha: "abc123", decision: "request-changes" },
        ],
      }),
    );
    assert.equal(d.allowed, false);
    assert.equal(d.reasonCode, "REVIEW_BLOCKED");
  });
});

describe("main merge gate (owner approval)", () => {
  function mainInput(overrides: Partial<MergeGateInput> = {}): MergeGateInput {
    return input({
      pr: pr({ targetBranch: "main" }),
      actor: owner,
      checks: [
        { name: "ci", headSha: "abc123", status: "pass" },
        { name: "security", headSha: "abc123", status: "pass" },
      ],
      approval: ownerApproval(),
      ...overrides,
    });
  }

  it("allows an owner merge with exact-SHA verified owner approval", () => {
    const d = evaluateMergeGate(mainInput());
    assert.equal(d.allowed, true);
    assert.equal(d.verdict, "allow");
  });

  it("queues an owner decision when no approval is recorded", () => {
    const d = evaluateMergeGate(mainInput({ approval: null }));
    assert.equal(d.allowed, false);
    assert.equal(d.verdict, "require_owner");
    assert.equal(d.reasonCode, "OWNER_REQUIRED");
  });

  it("queues (sleeping) instead of approving when the owner sleeps", () => {
    const d = evaluateMergeGate(
      mainInput({ approval: null, ownerSleeping: true }),
    );
    assert.equal(d.allowed, false);
    assert.equal(d.verdict, "require_owner");
    assert.equal(d.reasonCode, "SLEEP_QUEUED");
  });

  it("rejects unsigned approvals: role string alone proves nothing", () => {
    const d = evaluateMergeGate(
      mainInput({ approval: ownerApproval({ authProof: "" }) }),
    );
    assert.equal(d.allowed, false);
    assert.equal(d.verdict, "deny");
    assert.equal(d.reasonCode, "OWNER_APPROVAL_UNAUTHENTICATED");
  });

  it("rejects approvals granted by non-owners and from message origin", () => {
    assert.equal(
      evaluateMergeGate(mainInput({ approval: ownerApproval({ grantedBy: "coordinator" }) })).reasonCode,
      "OWNER_APPROVAL_NOT_OWNER",
    );
    assert.equal(
      evaluateMergeGate(mainInput({ approval: ownerApproval({ origin: "message" }) })).reasonCode,
      "OWNER_APPROVAL_BAD_ORIGIN",
    );
  });

  it("new commits and expiry invalidate the owner approval", () => {
    const stale = evaluateMergeGate(
      mainInput({
        pr: pr({ targetBranch: "main", headSha: "def456" }),
        checks: [
          { name: "ci", headSha: "def456", status: "pass" },
          { name: "security", headSha: "def456", status: "pass" },
        ],
        reviews: [
          { reviewerId: "reviewer-1", kind: "agent", headSha: "def456", decision: "approve" },
        ],
      }),
    );
    assert.equal(stale.allowed, false);
    assert.equal(stale.reasonCode, "OWNER_APPROVAL_SHA_MISMATCH");
    const expired = evaluateMergeGate(
      mainInput({ approval: ownerApproval({ expiresAt: NOW - 1 }) }),
    );
    assert.equal(expired.allowed, false);
    assert.equal(expired.reasonCode, "OWNER_APPROVAL_EXPIRED");
  });

  it("coordinator may only request, never execute, a main merge", () => {
    const d = evaluateMergeGate(
      mainInput({ actor: { id: "coordinator-1", role: "coordinator" } }),
    );
    assert.equal(d.allowed, false);
    assert.equal(d.verdict, "require_owner");
  });

  it("hard failures dominate: bad approval denies even without execution rights", () => {
    const d = evaluateMergeGate(
      mainInput({
        actor: { id: "coordinator-1", role: "coordinator" },
        approval: ownerApproval({ authProof: "" }),
      }),
    );
    assert.equal(d.verdict, "deny");
  });
});

describe("canonical-engine binding", () => {
  it("mirrors the canonical FF-004 policy version", () => {
    assert.equal(CANONICAL_POLICY_VERSION, "0.1.0");
  });

  it("prResourceId binds repo, PR, and target branch", () => {
    assert.equal(prResourceId(pr()), "github-pr:repo_1:7:develop");
    assert.equal(
      prResourceId(pr({ targetBranch: "main" })),
      "github-pr:repo_1:7:main",
    );
  });

  it("toAuthorizeInput produces canonical merge.develop inputs", () => {
    const mapped = toAuthorizeInput(input());
    assert.ok(mapped !== null);
    assert.equal(mapped.action, "merge.develop");
    assert.deepEqual(mapped.actor, {
      type: "agent",
      id: "coordinator-1",
      role: "coordinator",
    });
    assert.equal(mapped.resource.id, "github-pr:repo_1:7:develop");
    assert.equal(mapped.resource.checksPass, true);
    assert.equal(mapped.resource.reviewerId, "reviewer-1");
  });

  it("toAuthorizeInput is null for unknown targets and unmapped roles", () => {
    assert.equal(
      toAuthorizeInput(input({ pr: pr({ targetBranch: "feature-x" }) })),
      null,
    );
    assert.equal(
      toAuthorizeInput(input({ actor: { id: "w", role: "integration-worker" } })),
      null,
    );
  });

  it("evaluateGitHubEvidence reports evidence without deciding authority", () => {
    const e = evaluateGitHubEvidence(POLICY, pr(), input().checks, input().reviews);
    assert.equal(e.checksPass, true);
    assert.equal(e.reviewerId, "reviewer-1");
    const missing = evaluateGitHubEvidence(null, pr(), [], []);
    assert.equal(missing.checksPass, false);
    assert.ok(missing.checksReason?.startsWith("CHECK_POLICY_MISSING"));
  });

  it("refuses unknown target branches", () => {
    const d = evaluateMergeGate(input({ pr: pr({ targetBranch: "feature-x" }) }));
    assert.equal(d.allowed, false);
    assert.equal(d.reasonCode, "UNKNOWN_TARGET");
  });
});
