/**
 * Public surface of `@forgefleet/github-integration` (FF-018, E16).
 */
export {
  MERGE_GATE_POLICY_VERSION,
  MERGE_TARGETS,
  evaluateMergeGate,
  isApprovalValid,
  type CheckResult,
  type MergeActor,
  type MergeActorRole,
  type MergeApproval,
  type MergeGateDecision,
  type MergeGateInput,
  type MergeTarget,
  type PullRequestRef,
  type Review,
  type ReviewDecision,
  type ReviewerKind,
} from "./merge_gate.ts";
