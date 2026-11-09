/**
 * FF-018 merge gate (E16): GitHub evidence evaluation plus a thin binding to
 * the canonical E07 policy engine.
 *
 * Revision 2 (coordinator review on PR #58):
 * - Required checks come from a versioned authoritative {@link RequiredCheckPolicy},
 *   never a caller-supplied list. Missing, unknown-target, or empty policy
 *   fails closed: no check results can satisfy the gate.
 * - Approvals use the canonical FF-004 `OwnerApproval` shape. An approval
 *   object alone proves nothing: without a server-minted `authProof` the
 *   record is rejected (`OWNER_APPROVAL_UNAUTHENTICATED`), and approvals
 *   originating from message content or sleep expiry are rejected. Minting
 *   and verifying `authProof` is the integration boundary's job (E07 policy
 *   service / bridge handler), never the caller's; the gate treats it as an
 *   opaque presence requirement.
 * - Verdicts, action names (`merge.develop` / `merge.main`), and reason codes
 *   mirror the canonical engine (`packages/policy` on the FF-004 branch,
 *   `POLICY_VERSION 0.1.0`), which remains the single authority for
 *   actor/role/approval-class decisions. This package is the GitHub-evidence
 *   evaluator (E16's job: checks/review at exact SHAs) and produces
 *   canonical-shaped `authorize()` inputs via {@link toAuthorizeInput}, so
 *   delegation is mechanical once `packages/policy` lands on `develop`.
 *   Known divergence: the FF-023 branch carries a variant policy surface
 *   (`merge_main`, `{allowed, approvals[]}`); unifying the two engines is
 *   E07/coordinator work, tracked in the README. This package implements no
 *   third engine and imports neither variant.
 *
 * References: `docs/03-architecture/github-integration.md` (merge policy),
 * `docs/04-flows/github-delivery.md` (F03), `docs/05-contracts/policy-matrix.md`,
 * `docs/05-contracts/contract-test-cases.md` (GitHub cases).
 */

/** Canonical engine version mirrored here (FF-004 `POLICY_VERSION`). */
export const CANONICAL_POLICY_VERSION = "0.1.0";
export const MERGE_GATE_POLICY_VERSION = "ff018-v2";

export const MERGE_TARGETS = ["develop", "main"] as const;
export type MergeTarget = (typeof MERGE_TARGETS)[number];

/** Canonical action names (FF-004 `ACTION_CATALOG` keys). */
export const MERGE_ACTION: Record<MergeTarget, string> = {
  develop: "merge.develop",
  main: "merge.main",
};

/** Roles presented to this gate. Canonical mapping applies at evaluation. */
export type MergeActorRole =
  | "worker"
  | "coordinator"
  | "integration-worker"
  | "human-owner";

/** Canonical FF-004 roles. `integration-worker` has no canonical role. */
type CanonicalRole = "owner" | "coordinator" | "worker";

function canonicalRole(role: MergeActorRole): CanonicalRole | null {
  switch (role) {
    case "human-owner":
      return "owner";
    case "coordinator":
      return "coordinator";
    case "worker":
      return "worker";
    case "integration-worker":
      return null;
  }
}

function actorType(role: MergeActorRole): string {
  switch (role) {
    case "human-owner":
      return "human";
    case "integration-worker":
      return "service";
    default:
      return "agent";
  }
}

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
 * Authoritative required-check policy for repositories/targets. This object
 * is repo configuration (versioned), not a per-call caller argument: the
 * gate fails closed whenever it is absent, silent about the target, or
 * empty, so a caller can never smuggle in an empty required set.
 */
export interface RequiredCheckPolicy {
  version: string;
  targets: Record<string, string[]>;
}

export interface PullRequestRef {
  repoId: string;
  prNumber: number;
  headSha: string;
  targetBranch: string;
  authorId: string;
}

/**
 * Canonical FF-004 `OwnerApproval`: a durable, authenticated owner action,
 * never a chat utterance. `authProof` is an opaque server-minted reference
 * proving the owner authenticated at the integration boundary.
 */
export interface OwnerApproval {
  grantedBy: string;
  authProof: string;
  action: string;
  resourceId: string;
  targetSha: string;
  expiresAt: number;
  origin?: string;
}

export interface MergeActor {
  id: string;
  role: MergeActorRole;
}

export interface MergeGateInput {
  policyVersion: string;
  pr: PullRequestRef;
  actor: MergeActor;
  /** Observed CI results (any SHA; superseded entries are ignored). */
  checks: CheckResult[];
  /** Authoritative check policy, or null when unconfigured (fail closed). */
  checkPolicy: RequiredCheckPolicy | null;
  /** Observed reviews (any SHA; superseded entries are ignored). */
  reviews: Review[];
  /** Recorded owner approval, or null when none exists. */
  approval: OwnerApproval | null;
  /** Epoch ms clock; defaults to `Date.now()`. */
  now?: number;
  /** Owner sleep mode: missing approval queues instead of approving. */
  ownerSleeping?: boolean;
}

export type MergeVerdict = "allow" | "deny" | "require_owner";

export interface MergeGateDecision {
  allowed: boolean;
  /** Canonical verdict vocabulary. */
  verdict: MergeVerdict;
  /** Primary machine-readable code (`OK` when allowed). */
  reasonCode: string;
  /** All applicable human-readable reasons. */
  reasons: string[];
}

export interface GitHubMergeEvidence {
  required: string[];
  checksPass: boolean;
  checksReason: string | null;
  reviewerId: string | null;
  reviewReason: string | null;
}

/**
 * E16 resource-ID convention binding an approval to one PR on one target
 * branch. Pending E05 contract-custodian review; the gate requires exact
 * equality on both sides, whatever the final format.
 */
export function prResourceId(pr: PullRequestRef): string {
  return `github-pr:${pr.repoId}:${pr.prNumber}:${pr.targetBranch}`;
}

function isMergeTarget(branch: string): branch is MergeTarget {
  return (MERGE_TARGETS as readonly string[]).includes(branch);
}

/**
 * Pure GitHub-evidence evaluation (E16's adapter job): required checks green
 * at the exact current head SHA, and an independent reviewer at that SHA.
 * No roles or approvals are consulted here.
 */
export function evaluateGitHubEvidence(
  checkPolicy: RequiredCheckPolicy | null,
  pr: PullRequestRef,
  checks: CheckResult[],
  reviews: Review[],
): GitHubMergeEvidence {
  const base: GitHubMergeEvidence = {
    required: [],
    checksPass: false,
    checksReason: null,
    reviewerId: null,
    reviewReason: null,
  };
  if (checkPolicy === null) {
    return { ...base, checksReason: "CHECK_POLICY_MISSING: no authoritative required-check policy is configured; failing closed" };
  }
  const required = checkPolicy.targets[pr.targetBranch];
  if (required === undefined) {
    return { ...base, checksReason: `CHECK_POLICY_UNKNOWN_TARGET: policy '${checkPolicy.version}' names no required checks for '${pr.targetBranch}'; failing closed` };
  }
  if (required.length === 0) {
    return { ...base, checksReason: `CHECK_POLICY_EMPTY: policy '${checkPolicy.version}' requires zero checks for '${pr.targetBranch}'; failing closed` };
  }
  for (const name of required) {
    const current = checks.filter(
      (c) => c.name === name && c.headSha === pr.headSha,
    );
    if (current.length === 0) {
      return { ...base, required, checksReason: `CHECKS_NOT_PASSING: required check '${name}' has no result for head ${pr.headSha}` };
    }
    if (current.some((c) => c.status === "fail")) {
      return { ...base, required, checksReason: `CHECKS_NOT_PASSING: required check '${name}' is failing at head ${pr.headSha}` };
    }
    if (current.some((c) => c.status === "pending")) {
      return { ...base, required, checksReason: `CHECKS_NOT_PASSING: required check '${name}' is still pending at head ${pr.headSha}` };
    }
  }
  const headReviews = reviews.filter((r) => r.headSha === pr.headSha);
  const blocking = headReviews.some(
    (r) => r.decision === "request-changes" && r.reviewerId !== pr.authorId,
  );
  if (blocking) {
    return { ...base, required, checksPass: true, reviewReason: `REVIEW_BLOCKED: unresolved request-changes review at head ${pr.headSha}` };
  }
  const independent = headReviews.find(
    (r) => r.decision === "approve" && r.reviewerId !== pr.authorId,
  );
  if (independent === undefined) {
    return { ...base, required, checksPass: true, reviewReason: `REVIEW_NOT_INDEPENDENT: no independent review approval for head ${pr.headSha} (self-approval does not count)` };
  }
  return { required, checksPass: true, checksReason: null, reviewerId: independent.reviewerId, reviewReason: null };
}

/**
 * Canonical FF-004 approval validation, fail-closed. Returns null when valid,
 * otherwise the canonical reason code. Only a missing approval queues an
 * owner decision; every malformed, unauthenticated, expired, or mismatched
 * approval denies.
 */
function ownerApprovalError(
  approval: OwnerApproval | null,
  action: string,
  resourceId: string,
  headSha: string,
  now: number,
): string | null {
  if (approval === null) return "OWNER_APPROVAL_MISSING";
  if (approval.grantedBy !== "owner") return "OWNER_APPROVAL_NOT_OWNER";
  if (typeof approval.authProof !== "string" || approval.authProof.length === 0) {
    return "OWNER_APPROVAL_UNAUTHENTICATED";
  }
  if (approval.action !== action) return "OWNER_APPROVAL_ACTION_MISMATCH";
  if (approval.origin === "message" || approval.origin === "sleep-expiry") {
    return "OWNER_APPROVAL_BAD_ORIGIN";
  }
  if (typeof approval.expiresAt !== "number" || now >= approval.expiresAt) {
    return "OWNER_APPROVAL_EXPIRED";
  }
  if (typeof approval.resourceId !== "string" || approval.resourceId.length === 0) {
    return "OWNER_APPROVAL_TARGET_MISSING";
  }
  if (approval.resourceId !== resourceId) {
    return "OWNER_APPROVAL_TARGET_MISMATCH";
  }
  if (typeof approval.targetSha !== "string" || approval.targetSha.length === 0) {
    return "OWNER_APPROVAL_SHA_MISSING";
  }
  if (approval.targetSha !== headSha) {
    return "OWNER_APPROVAL_SHA_MISMATCH";
  }
  return null;
}

/**
 * Build the canonical FF-004 `authorize()` input for this merge, so the
 * bridge can delegate to the single policy engine once `packages/policy`
 * lands on `develop`. Returns null when the merge cannot even be expressed
 * canonically (unknown target or unmapped role); both cases deny.
 */
export function toAuthorizeInput(input: MergeGateInput): {
  actor: { type: string; id: string; role: string };
  action: string;
  resource: {
    id: string;
    headSha: string;
    authorId: string;
    reviewerId?: string;
    checksPass: boolean;
  };
  context: { approval: OwnerApproval | null; now: number };
} | null {
  if (!isMergeTarget(input.pr.targetBranch)) return null;
  const role = canonicalRole(input.actor.role);
  if (role === null) return null;
  const evidence = evaluateGitHubEvidence(
    input.checkPolicy,
    input.pr,
    input.checks,
    input.reviews,
  );
  return {
    actor: { type: actorType(input.actor.role), id: input.actor.id, role },
    action: MERGE_ACTION[input.pr.targetBranch],
    resource: {
      id: prResourceId(input.pr),
      headSha: input.pr.headSha,
      authorId: input.pr.authorId,
      ...(evidence.reviewerId !== null ? { reviewerId: evidence.reviewerId } : {}),
      checksPass: evidence.checksPass,
    },
    context: {
      approval: input.approval,
      now: input.now ?? Date.now(),
    },
  };
}

const APPROVAL_FAILURE_REASONS: Record<string, string> = {
  OWNER_APPROVAL_NOT_OWNER: "Approval was not granted by the owner.",
  OWNER_APPROVAL_UNAUTHENTICATED:
    "Approval carries no server-minted authentication proof; the object alone proves nothing.",
  OWNER_APPROVAL_ACTION_MISMATCH: "Approval covers a different action and does not transfer.",
  OWNER_APPROVAL_BAD_ORIGIN: "Approval originates from message content or sleep expiry and is invalid.",
  OWNER_APPROVAL_EXPIRED: "The owner approval has expired; expiry never grants authority.",
  OWNER_APPROVAL_TARGET_MISSING: "Approval lacks the required immutable resource ID binding.",
  OWNER_APPROVAL_TARGET_MISMATCH: "The target changed after approval; the decision must be reopened against the new state.",
  OWNER_APPROVAL_SHA_MISSING: "Approval lacks the required exact state-hash binding.",
  OWNER_APPROVAL_SHA_MISMATCH: "The target changed after approval; the decision must be reopened against the new state.",
};

export function evaluateMergeGate(input: MergeGateInput): MergeGateDecision {
  const denyReasons: Array<{ code: string; reason: string }> = [];
  const queueReasons: Array<{ code: string; reason: string }> = [];
  const { pr, actor } = input;
  const now = input.now ?? Date.now();

  if (!isMergeTarget(pr.targetBranch)) {
    denyReasons.push({
      code: "UNKNOWN_TARGET",
      reason: `refusing unknown merge target branch '${pr.targetBranch}'`,
    });
    return decided(denyReasons, queueReasons);
  }

  // Closed world: roles outside the canonical set deny (mirrors FF-004
  // UNKNOWN_ROLE). The singleton integration worker has no canonical role:
  // it must authenticate under the coordinator role until E07 extends the
  // catalog; E16 does not mint privilege unilaterally.
  const role = canonicalRole(actor.role);
  if (role === null) {
    denyReasons.push({
      code: "UNKNOWN_ROLE",
      reason: `Unknown role '${actor.role}'; closed-world deny. The integration worker must authenticate as coordinator until the canonical catalog covers it.`,
    });
    return decided(denyReasons, queueReasons);
  }

  const action = MERGE_ACTION[pr.targetBranch];

  // E16 binding, stricter than canonical: nobody but the owner merges
  // their own PR (E16 brief: "Never merge an engineer's own PR").
  if (actor.id === pr.authorId && role !== "owner") {
    denyReasons.push({
      code: "SELF_MERGE",
      reason: "merge actor authored the PR (self-merge is forbidden)",
    });
  }

  if (pr.targetBranch === "develop") {
    // Canonical merge.develop roles: owner, coordinator. Workers deny.
    if (role !== "owner" && role !== "coordinator") {
      denyReasons.push({
        code: "ROLE_NOT_PERMITTED",
        reason: `Role '${role}' may not perform '${action}'. Workers never merge PRs.`,
      });
    }
  } else {
    // Canonical merge.main: owner executes, coordinator requests only,
    // workers are outside the role set entirely.
    if (role === "worker") {
      denyReasons.push({
        code: "ROLE_NOT_PERMITTED",
        reason: `Role 'worker' may not perform '${action}'.`,
      });
    } else if (role === "coordinator") {
      queueReasons.push({
        code: "OWNER_REQUIRED",
        reason: `Role 'coordinator' may only request owner approval for '${action}', never execute.`,
      });
    }
  }

  const evidence = evaluateGitHubEvidence(
    input.checkPolicy,
    pr,
    input.checks,
    input.reviews,
  );
  if (evidence.checksReason !== null) {
    denyReasons.push({
      code: evidence.checksReason.split(":")[0],
      reason: evidence.checksReason,
    });
  } else if (evidence.reviewReason !== null) {
    denyReasons.push({
      code: evidence.reviewReason.split(":")[0],
      reason: evidence.reviewReason,
    });
  }

  if (pr.targetBranch === "main" && (role === "owner" || role === "coordinator")) {
    const err = ownerApprovalError(
      input.approval,
      action,
      prResourceId(pr),
      pr.headSha,
      now,
    );
    if (err === "OWNER_APPROVAL_MISSING") {
      queueReasons.push({
        code: input.ownerSleeping === true ? "SLEEP_QUEUED" : "OWNER_REQUIRED",
        reason:
          input.ownerSleeping === true
            ? "Owner is sleeping: request is queued, never auto-approved."
            : `Owner approval required for '${action}'.`,
      });
    } else if (err !== null) {
      denyReasons.push({
        code: err,
        reason: APPROVAL_FAILURE_REASONS[err] ?? "Approval invalid.",
      });
    }
  }

  return decided(denyReasons, queueReasons);
}

function decided(
  denyReasons: Array<{ code: string; reason: string }>,
  queueReasons: Array<{ code: string; reason: string }>,
): MergeGateDecision {
  if (denyReasons.length > 0) {
    return {
      allowed: false,
      verdict: "deny",
      reasonCode: denyReasons[0].code,
      reasons: denyReasons.map((r) => r.reason),
    };
  }
  if (queueReasons.length > 0) {
    return {
      allowed: false,
      verdict: "require_owner",
      reasonCode: queueReasons[0].code,
      reasons: queueReasons.map((r) => r.reason),
    };
  }
  return { allowed: true, verdict: "allow", reasonCode: "OK", reasons: [] };
}
