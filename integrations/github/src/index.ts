/**
 * Public surface of `@forgefleet/github-integration` (FF-018, E16).
 *
 * The canonical E07 policy engine (`packages/policy`, FF-004) remains the
 * single authority for actor/role/approval-class decisions. This package
 * evaluates GitHub evidence and binds it to canonical-shaped inputs.
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
  type CheckResult,
  type GitHubMergeEvidence,
  type MergeActor,
  type MergeActorRole,
  type MergeGateDecision,
  type MergeGateInput,
  type MergeTarget,
  type MergeVerdict,
  type OwnerApproval,
  type PullRequestRef,
  type RequiredCheckPolicy,
  type Review,
  type ReviewDecision,
  type ReviewerKind,
} from "./merge_gate.ts";
