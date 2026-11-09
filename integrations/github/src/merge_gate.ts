/**
 * FF-018 merge gate (E16): GitHub evidence evaluation plus a thin binding to
 * the canonical E07 policy engine.
 *
 * WHAT THIS IS: a pure evidence gate. It evaluates check results, reviews,
 * and boundary-verified approvals presented to it and returns a verdict.
 *
 * WHAT THIS IS NOT: an enforceable GitHub App integration. It performs no
 * webhook signature verification, makes no GitHub API calls, and enforces no
 * branch protection. Real enforcement needs an installed GitHub App with
 * verified webhooks (delivery work, not this package), owner-configured
 * branch rulesets (issue #64), and real CI check runs (issue #59). Treating
 * this module's verdict as enforcement without that transport is a
 * category error; see README "Gate status".
 *
 * Revision 3 (coordinator re-review on PR #58, FF-004 `f00de20` rule):
 * a nonempty `authProof` string alone never grants privileges — the
 * canonical engine's presence check is fail-open by design against forgery,
 * and any consumer that treats the JSON field as proof without server-side
 * verification violates threat model T4b. Therefore raw approval records
 * accepted here deliberately carry NO proof field ({@link ClaimedApproval}).
 * Proof enters only through {@link BoundaryAttestation}: a server-side
 * record from a boundary component in the fail-closed
 * {@link ApprovalTrustPolicy} allowlist, which minted/checked the proof
 * against authenticated server storage. A smuggled proof value in raw data
 * is never read. Assembling the canonical `authorize()` input from claim +
 * attestation in {@link toAuthorizeInput} IS the boundary function.
 *
 * Verdicts, action names (`merge.develop` / `merge.main`), and reason codes
 * mirror the canonical engine (`packages/policy`, PR #33 branch tip,
 * `POLICY_VERSION 0.1.0`; confirmed dotted action strings; the `merge_main`
 * variant on the FF-023 branch is E07/coordinator unification work, not
 * adopted here). The canonical engine remains the single authority for
 * actor/role/approval-class decisions; this package is the GitHub-evidence
 * evaluator (E16's job) and implements no third engine.
 *
 * References: `docs/03-architecture/github-integration.md`,
 * `docs/04-flows/github-delivery.md` (F03),
 * `docs/05-contracts/policy-matrix.md`,
 * `docs/05-contracts/contract-test-cases.md` (GitHub cases),
 * `docs/03-architecture/security-policy.md` (T4b, authProof rule).
 */

/** Canonical engine version mirrored here (FF-004 `POLICY_VERSION`). */
export const CANONICAL_POLICY_VERSION = "0.1.0";
export const MERGE_GATE_POLICY_VERSION = "ff018-v3";

export const MERGE_TARGETS = ["develop", "main"] as const;
export type MergeTarget = (typeof MERGE_TARGETS)[number];

/** Canonical action names (FF-004 `ACTION_CATALOG` keys, dotted form). */
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
 * Authoritative required-check policy for repositories/targets. Repo
 * configuration (versioned), not a per-call caller argument: the gate fails
 * closed whenever it is absent, silent about the target, or empty, so a
 * caller can never smuggle in an empty required set.
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
 * Raw approval record from untrusted sources (PR data, agent messages).
 * Deliberately carries NO proof field: any `authProof`-shaped value in raw
 * data is untrusted by construction and is never read by this gate, even
 * if a JavaScript caller smuggles one in. Proof lives only in
 * {@link BoundaryAttestation}.
 */
export interface ClaimedApproval {
  grantedBy: string;
  action: string;
  resourceId: string;
  targetSha: string;
  expiresAt: number;
  origin?: string;
}

/**
 * Server-side attestation: the boundary component `verifiedBy` minted the
 * opaque `authProof` after real owner authentication and checked it against
 * authenticated server storage, bound to the exact approval. Only
 * attestations from components in {@link ApprovalTrustPolicy} count.
 */
export interface BoundaryAttestation {
  authProof: string;
  verifiedBy: string;
  checkedAt: number;
}

/**
 * Fail-closed allowlist of boundary components permitted to attest
 * approvals (server configuration, versioned). Null or empty denies every
 * approval: unverifiable claims grant nothing.
 */
export interface ApprovalTrustPolicy {
  version: string;
  trustedVerifiers: string[];
}

/**
 * Canonical FF-004 `OwnerApproval` shape, assembled server-side only (see
 * {@link toAuthorizeInput}). Never parsed from raw PR/agent data.
 */
export interface VerifiedOwnerApproval {
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
  /** Raw claimed approval, or null when none exists. Carries no proof. */
  approval: ClaimedApproval | null;
  /** Server-side attestation for the claim, or null when unverified. */
  attestation: BoundaryAttestation | null;
  /** Verifier allowlist, or null when unconfigured (fail closed). */
  approvalTrust: ApprovalTrustPolicy | null;
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
 * No roles, approvals, or attestations are consulted here.
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
 * Verify a claimed approval against its server-side attestation, fail-closed.
 * Returns the canonical `VerifiedOwnerApproval` (assembled server-side from
 * claim + attested proof — this assembly IS the boundary function), or a
 * reason code when the claim cannot be honored. Only a missing claim queues
 * an owner decision; every unverified, untrusted, unauthenticated, expired,
 * or mismatched claim denies.
 */
function verifyApproval(
  approval: ClaimedApproval | null,
  attestation: BoundaryAttestation | null,
  trust: ApprovalTrustPolicy | null,
  action: string,
  resourceId: string,
  headSha: string,
  now: number,
): { verified: VerifiedOwnerApproval } | { code: string; queued: boolean } {
  if (approval === null) return { code: "OWNER_APPROVAL_MISSING", queued: true };
  if (trust === null || trust.trustedVerifiers.length === 0) {
    return { code: "OWNER_APPROVAL_TRUST_POLICY_MISSING", queued: false };
  }
  // The raw record proves nothing on its own: without a server-side
  // attestation the claim is indistinguishable from forgery.
  if (attestation === null) {
    return { code: "OWNER_APPROVAL_UNVERIFIED", queued: false };
  }
  if (!trust.trustedVerifiers.includes(attestation.verifiedBy)) {
    return { code: "OWNER_APPROVAL_UNTRUSTED_VERIFIER", queued: false };
  }
  // NOTE: `approval` has no proof field by construction; only the attested
  // server-side proof is ever used. A smuggled value in raw data is ignored.
  if (typeof attestation.authProof !== "string" || attestation.authProof.length === 0) {
    return { code: "OWNER_APPROVAL_UNAUTHENTICATED", queued: false };
  }
  if (approval.grantedBy !== "owner") {
    return { code: "OWNER_APPROVAL_NOT_OWNER", queued: false };
  }
  if (approval.action !== action) {
    return { code: "OWNER_APPROVAL_ACTION_MISMATCH", queued: false };
  }
  if (approval.origin === "message" || approval.origin === "sleep-expiry") {
    return { code: "OWNER_APPROVAL_BAD_ORIGIN", queued: false };
  }
  if (typeof approval.expiresAt !== "number" || now >= approval.expiresAt) {
    return { code: "OWNER_APPROVAL_EXPIRED", queued: false };
  }
  if (typeof approval.resourceId !== "string" || approval.resourceId.length === 0) {
    return { code: "OWNER_APPROVAL_TARGET_MISSING", queued: false };
  }
  if (approval.resourceId !== resourceId) {
    return { code: "OWNER_APPROVAL_TARGET_MISMATCH", queued: false };
  }
  if (typeof approval.targetSha !== "string" || approval.targetSha.length === 0) {
    return { code: "OWNER_APPROVAL_SHA_MISSING", queued: false };
  }
  if (approval.targetSha !== headSha) {
    return { code: "OWNER_APPROVAL_SHA_MISMATCH", queued: false };
  }
  return {
    verified: {
      grantedBy: approval.grantedBy,
      authProof: attestation.authProof,
      action: approval.action,
      resourceId: approval.resourceId,
      targetSha: approval.targetSha,
      expiresAt: approval.expiresAt,
      ...(approval.origin !== undefined ? { origin: approval.origin } : {}),
    },
  };
}

/**
 * Build the canonical FF-004 `authorize()` input for this merge, for
 * mechanical delegation once `packages/policy` lands on `develop`. Returns
 * null when the merge cannot be expressed canonically (unknown target,
 * unmapped role) or the approval is unverified: the canonical object is
 * assembled server-side only, never from raw data.
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
  context: { approval: VerifiedOwnerApproval | null; now: number };
} | null {
  if (!isMergeTarget(input.pr.targetBranch)) return null;
  const role = canonicalRole(input.actor.role);
  if (role === null) return null;
  const now = input.now ?? Date.now();
  const action = MERGE_ACTION[input.pr.targetBranch];
  const evidence = evaluateGitHubEvidence(
    input.checkPolicy,
    input.pr,
    input.checks,
    input.reviews,
  );
  let approval: VerifiedOwnerApproval | null = null;
  if (input.pr.targetBranch === "main" && input.approval !== null) {
    const result = verifyApproval(
      input.approval,
      input.attestation,
      input.approvalTrust,
      action,
      prResourceId(input.pr),
      input.pr.headSha,
      now,
    );
    if (!("verified" in result)) return null;
    approval = result.verified;
  }
  return {
    actor: { type: actorType(input.actor.role), id: input.actor.id, role },
    action,
    resource: {
      id: prResourceId(input.pr),
      headSha: input.pr.headSha,
      authorId: input.pr.authorId,
      ...(evidence.reviewerId !== null ? { reviewerId: evidence.reviewerId } : {}),
      checksPass: evidence.checksPass,
    },
    context: { approval, now },
  };
}

const APPROVAL_FAILURE_REASONS: Record<string, string> = {
  OWNER_APPROVAL_TRUST_POLICY_MISSING:
    "No verifier allowlist is configured; unverifiable approval claims grant nothing.",
  OWNER_APPROVAL_UNVERIFIED:
    "Approval claim has no server-side attestation; raw PR/agent data proves nothing and is never accepted as proof.",
  OWNER_APPROVAL_UNTRUSTED_VERIFIER:
    "Approval was attested by a component outside the trusted verifier allowlist.",
  OWNER_APPROVAL_NOT_OWNER: "Approval was not granted by the owner.",
  OWNER_APPROVAL_UNAUTHENTICATED:
    "Attestation carries no server-minted authentication proof; the claim alone proves nothing.",
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
    const result = verifyApproval(
      input.approval,
      input.attestation,
      input.approvalTrust,
      action,
      prResourceId(pr),
      pr.headSha,
      now,
    );
    if ("verified" in result) {
      // Verified: no approval reason recorded.
    } else if (result.queued) {
      // Canonical mapping: a missing approval queues an owner decision
      // (`OWNER_REQUIRED`); sleep queues without approving (`SLEEP_QUEUED`).
      queueReasons.push({
        code: input.ownerSleeping === true ? "SLEEP_QUEUED" : "OWNER_REQUIRED",
        reason:
          input.ownerSleeping === true
            ? "Owner is sleeping: request is queued, never auto-approved."
            : `Owner approval required for '${action}'.`,
      });
    } else {
      denyReasons.push({
        code: result.code,
        reason: APPROVAL_FAILURE_REASONS[result.code] ?? "Approval invalid.",
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
