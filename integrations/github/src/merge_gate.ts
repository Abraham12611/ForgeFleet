/**
 * FF-018 merge gate (E16): pure policy for GitHub checks/review/merge decisions.
 *
 * Implements the merge policy from `docs/03-architecture/github-integration.md`,
 * the delivery flow `docs/04-flows/github-delivery.md` (F03), the action matrix in
 * `docs/05-contracts/policy-matrix.md`, and the GitHub cases in
 * `docs/05-contracts/contract-test-cases.md`:
 *
 * - Required CI checks must pass at the exact current PR head SHA. Results for
 *   superseded commits are ignored and never satisfy the gate.
 * - An independent review approval (not the PR author) at the current head SHA
 *   is required. A `request-changes` review at the current head blocks.
 * - Workers never merge, and nobody except the human owner merges their own PR.
 * - `main` merges additionally require an explicit, non-expired human-owner
 *   approval bound to the exact (repo, PR, head SHA, target branch, policy
 *   version). New commits invalidate it. Agent or coordinator approval alone
 *   never authorizes a `main` merge.
 * - Only `develop` and `main` are merge targets (default deny).
 *
 * This module is intentionally self-contained: it takes plain values in and
 * returns a decision, so the future E07 policy service and the webhook handler
 * can call it without importing missing packages. Approval *recording*
 * (signed, auditable control-plane action) and webhook HMAC verification are
 * explicitly out of scope here.
 */

export const MERGE_GATE_POLICY_VERSION = "ff018-v1";

export const MERGE_TARGETS = ["develop", "main"] as const;
export type MergeTarget = (typeof MERGE_TARGETS)[number];

export type MergeActorRole =
  | "worker"
  | "coordinator"
  | "integration-worker"
  | "human-owner";

export type CheckStatus = "pass" | "fail" | "pending";

export interface CheckResult {
  name: string;
  headSha: string;
  status: CheckStatus;
}

export type ReviewDecision = "approve" | "request-changes" | "comment";
export type ReviewerKind = "agent" | "coordinator" | "human-owner";

export interface Review {
  reviewerId: string;
  kind: ReviewerKind;
  headSha: string;
  decision: ReviewDecision;
}

/**
 * An auditable approval record. Approval is not a chat utterance: the caller is
 * responsible for ensuring this record was created by a signed control-plane
 * action. The gate only checks that the record binds the exact merge target.
 */
export interface MergeApproval {
  approverId: string;
  approverRole: MergeActorRole;
  repoId: string;
  prNumber: number;
  headSha: string;
  targetBranch: string;
  policyVersion: string;
  expired: boolean;
}

export interface PullRequestRef {
  repoId: string;
  prNumber: number;
  headSha: string;
  targetBranch: string;
  authorId: string;
}

export interface MergeActor {
  id: string;
  role: MergeActorRole;
}

export interface MergeGateInput {
  policyVersion: string;
  pr: PullRequestRef;
  actor: MergeActor;
  /** Results observed for CI checks (any SHA; stale entries are ignored). */
  checks: CheckResult[];
  /** Names of checks the repo policy requires for this target. */
  requiredChecks: string[];
  /** Reviews observed on the PR (any SHA; stale entries are ignored). */
  reviews: Review[];
  /** Owner approval record, or null when none was recorded. */
  approval: MergeApproval | null;
}

export interface MergeGateDecision {
  allowed: boolean;
  /** Machine-readable deny reasons; empty when allowed. */
  reasons: string[];
}

/**
 * True when `approval` authorizes merging `pr` under `policyVersion`: same
 * repo, PR number, exact head SHA, target branch and policy version, and not
 * expired. Any mismatch (including new commits) invalidates it.
 */
export function isApprovalValid(
  approval: MergeApproval,
  pr: PullRequestRef,
  policyVersion: string,
): boolean {
  return (
    approval.expired === false &&
    approval.repoId === pr.repoId &&
    approval.prNumber === pr.prNumber &&
    approval.headSha === pr.headSha &&
    approval.targetBranch === pr.targetBranch &&
    approval.policyVersion === policyVersion
  );
}

function isMergeTarget(branch: string): branch is MergeTarget {
  return (MERGE_TARGETS as readonly string[]).includes(branch);
}

export function evaluateMergeGate(input: MergeGateInput): MergeGateDecision {
  const reasons: string[] = [];
  const { pr, actor } = input;

  if (!isMergeTarget(pr.targetBranch)) {
    reasons.push(`refusing unknown merge target branch '${pr.targetBranch}'`);
    return { allowed: false, reasons };
  }

  // Required checks evaluated at the exact current head SHA only.
  for (const name of input.requiredChecks) {
    const current = input.checks.filter(
      (c) => c.name === name && c.headSha === pr.headSha,
    );
    if (current.length === 0) {
      reasons.push(
        `required check '${name}' has no result for head ${pr.headSha}`,
      );
    } else if (current.some((c) => c.status === "fail")) {
      reasons.push(
        `required check '${name}' is failing at head ${pr.headSha}`,
      );
    } else if (current.some((c) => c.status === "pending")) {
      reasons.push(
        `required check '${name}' is still pending at head ${pr.headSha}`,
      );
    }
  }

  // Independent review at the current head SHA; self-approval never counts.
  const headReviews = input.reviews.filter((r) => r.headSha === pr.headSha);
  const independentApproval = headReviews.some(
    (r) => r.decision === "approve" && r.reviewerId !== pr.authorId,
  );
  if (!independentApproval) {
    reasons.push(
      `no independent review approval for head ${pr.headSha} (self-approval does not count)`,
    );
  }
  const blockingReview = headReviews.some(
    (r) => r.decision === "request-changes" && r.reviewerId !== pr.authorId,
  );
  if (blockingReview) {
    reasons.push(
      `unresolved request-changes review at head ${pr.headSha}`,
    );
  }

  // Workers never merge; nobody but the owner merges their own PR.
  if (actor.role === "worker") {
    reasons.push("workers are never permitted to merge PRs");
  }
  if (actor.id === pr.authorId && actor.role !== "human-owner") {
    reasons.push("merge actor authored the PR (self-merge is forbidden)");
  }

  if (pr.targetBranch === "main") {
    // G5 core: main merges only on explicit, valid human-owner approval,
    // executed by the owner. Coordinator/agent may only request.
    if (actor.role !== "human-owner") {
      reasons.push("merges into main must be executed by the human owner");
    }
    if (input.approval === null) {
      reasons.push("merges into main require a recorded owner approval");
    } else if (input.approval.approverRole !== "human-owner") {
      reasons.push("merges into main require a human-owner approval");
    } else if (!isApprovalValid(input.approval, pr, input.policyVersion)) {
      reasons.push(
        "owner approval does not bind the exact current head SHA, target, repo, and policy version, or it expired",
      );
    }
  } else {
    // develop: coordinator/integration worker (or owner) merges after
    // checks + independent review. No owner approval record required.
    if (actor.role !== "coordinator" && actor.role !== "integration-worker" && actor.role !== "human-owner") {
      reasons.push(
        "merges into develop must be executed by the coordinator, integration worker, or owner",
      );
    }
  }

  return { allowed: reasons.length === 0, reasons };
}
