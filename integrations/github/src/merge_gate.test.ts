import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MERGE_GATE_POLICY_VERSION,
  evaluateMergeGate,
  isApprovalValid,
  type MergeActor,
  type MergeApproval,
  type MergeGateInput,
  type PullRequestRef,
} from "./merge_gate.ts";

const POLICY = MERGE_GATE_POLICY_VERSION;

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
    policyVersion: POLICY,
    pr: pr(),
    actor: { id: "coordinator-1", role: "coordinator" },
    checks: [{ name: "ci", headSha: "abc123", status: "pass" }],
    requiredChecks: ["ci"],
    reviews: [
      { reviewerId: "reviewer-1", kind: "agent", headSha: "abc123", decision: "approve" },
    ],
    approval: null,
    ...overrides,
  };
}

function ownerApproval(overrides: Partial<MergeApproval> = {}): MergeApproval {
  return {
    approverId: "owner-1",
    approverRole: "human-owner",
    repoId: "repo_1",
    prNumber: 7,
    headSha: "abc123",
    targetBranch: "main",
    policyVersion: POLICY,
    expired: false,
    ...overrides,
  };
}

const owner: MergeActor = { id: "owner-1", role: "human-owner" };

describe("develop merge gate", () => {
  it("allows coordinator merge when checks pass and independent review exists", () => {
    const d = evaluateMergeGate(input());
    assert.equal(d.allowed, true);
    assert.deepEqual(d.reasons, []);
  });

  it("forbids worker merges even with green checks and review", () => {
    const d = evaluateMergeGate(
      input({ actor: { id: "worker-2", role: "worker" } }),
    );
    assert.equal(d.allowed, false);
    assert.ok(d.reasons.some((r) => r.includes("never permitted to merge")));
  });

  it("forbids self-merge by the PR author", () => {
    const d = evaluateMergeGate(
      input({ actor: { id: "worker-1", role: "coordinator" } }),
    );
    assert.equal(d.allowed, false);
    assert.ok(d.reasons.some((r) => r.includes("self-merge")));
  });

  it("blocks on a failing required check at the current head", () => {
    const d = evaluateMergeGate(
      input({ checks: [{ name: "ci", headSha: "abc123", status: "fail" }] }),
    );
    assert.equal(d.allowed, false);
    assert.ok(d.reasons.some((r) => r.includes("failing")));
  });

  it("blocks while a required check is pending", () => {
    const d = evaluateMergeGate(
      input({ checks: [{ name: "ci", headSha: "abc123", status: "pending" }] }),
    );
    assert.equal(d.allowed, false);
    assert.ok(d.reasons.some((r) => r.includes("pending")));
  });

  it("ignores check results for superseded commits", () => {
    const d = evaluateMergeGate(
      input({ checks: [{ name: "ci", headSha: "old999", status: "pass" }] }),
    );
    assert.equal(d.allowed, false);
    assert.ok(d.reasons.some((r) => r.includes("no result")));
  });

  it("blocks without an independent review at the current head", () => {
    const noReview = evaluateMergeGate(input({ reviews: [] }));
    assert.equal(noReview.allowed, false);
    const selfOnly = evaluateMergeGate(
      input({
        reviews: [
          { reviewerId: "worker-1", kind: "agent", headSha: "abc123", decision: "approve" },
        ],
      }),
    );
    assert.equal(selfOnly.allowed, false);
    assert.ok(
      selfOnly.reasons.some((r) => r.includes("independent review")),
    );
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
    assert.ok(d.reasons.some((r) => r.includes("request-changes")));
  });

  it("stale reviews for superseded commits do not satisfy the gate", () => {
    const d = evaluateMergeGate(
      input({
        reviews: [
          { reviewerId: "reviewer-1", kind: "agent", headSha: "old999", decision: "approve" },
        ],
      }),
    );
    assert.equal(d.allowed, false);
  });
});

describe("main merge gate (owner approval)", () => {
  function mainInput(overrides: Partial<MergeGateInput> = {}): MergeGateInput {
    return input({
      pr: pr({ targetBranch: "main" }),
      actor: owner,
      approval: ownerApproval(),
      ...overrides,
    });
  }

  it("allows an owner merge with exact-SHA owner approval", () => {
    const d = evaluateMergeGate(mainInput());
    assert.equal(d.allowed, true);
  });

  it("blocks agent/coordinator merges with no approval recorded", () => {
    const d = evaluateMergeGate(
      mainInput({
        actor: { id: "coordinator-1", role: "coordinator" },
        approval: null,
      }),
    );
    assert.equal(d.allowed, false);
    assert.ok(d.reasons.some((r) => r.includes("owner approval")));
  });

  it("blocks coordinator execution even with a valid owner approval", () => {
    const d = evaluateMergeGate(
      mainInput({ actor: { id: "coordinator-1", role: "coordinator" } }),
    );
    assert.equal(d.allowed, false);
    assert.ok(d.reasons.some((r) => r.includes("executed by the human owner")));
  });

  it("new commits invalidate the owner approval", () => {
    const d = evaluateMergeGate(
      mainInput({ pr: pr({ targetBranch: "main", headSha: "def456" }) }),
    );
    assert.equal(d.allowed, false);
    assert.ok(d.reasons.some((r) => r.includes("exact current head SHA")));
  });

  it("expired owner approval does not authorize a merge", () => {
    const d = evaluateMergeGate(
      mainInput({ approval: ownerApproval({ expired: true }) }),
    );
    assert.equal(d.allowed, false);
  });

  it("agent approval alone never authorizes a main merge", () => {
    const d = evaluateMergeGate(
      mainInput({
        approval: ownerApproval({ approverId: "agent-9", approverRole: "coordinator" }),
      }),
    );
    assert.equal(d.allowed, false);
    assert.ok(d.reasons.some((r) => r.includes("human-owner approval")));
  });
});

describe("target and approval binding", () => {
  it("refuses unknown target branches", () => {
    const d = evaluateMergeGate(
      input({ pr: pr({ targetBranch: "feature-x" }) }),
    );
    assert.equal(d.allowed, false);
    assert.ok(d.reasons.some((r) => r.includes("unknown merge target")));
  });

  it("isApprovalValid rejects repo, PR, branch, and policy mismatches", () => {
    const base = ownerApproval();
    const ref = pr({ targetBranch: "main" });
    assert.equal(isApprovalValid(base, ref, POLICY), true);
    assert.equal(isApprovalValid({ ...base, repoId: "other" }, ref, POLICY), false);
    assert.equal(isApprovalValid({ ...base, prNumber: 8 }, ref, POLICY), false);
    assert.equal(
      isApprovalValid({ ...base, targetBranch: "develop" }, ref, POLICY),
      false,
    );
    assert.equal(isApprovalValid(base, ref, "other-version"), false);
    assert.equal(isApprovalValid({ ...base, expired: true }, ref, POLICY), false);
  });
});
