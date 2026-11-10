/**
 * Public surface of `@forgefleet/github-integration` (FF-018, E16).
 *
 * The canonical E07 policy engine (`packages/policy`, FF-004, PR #33) remains
 * the single authority for actor/role/approval-class decisions. This package
 * evaluates GitHub evidence and binds boundary-verified approvals to
 * canonical-shaped inputs. It is an evidence gate, NOT an enforceable
 * GitHub App integration (no webhooks, no API calls, no branch protection).
 */
export {
  CANONICAL_POLICY_VERSION,
  MERGE_ACTION,
  MERGE_GATE_POLICY_VERSION,
  MERGE_TARGETS,
  evaluateGitHubEvidence,
  evaluateMergeGate,
  prResourceId,
  toAuthorizeInput,
  type ApprovalTrustPolicy,
  type BoundaryAttestation,
  type CheckResult,
  type ClaimedApproval,
  type GitHubMergeEvidence,
  type MergeActor,
  type MergeActorRole,
  type MergeGateDecision,
  type MergeGateInput,
  type MergeTarget,
  type MergeVerdict,
  type PullRequestRef,
  type RequiredCheckPolicy,
  type Review,
  type ReviewDecision,
  type ReviewerKind,
  type VerifiedOwnerApproval,
} from "./merge_gate.ts";
