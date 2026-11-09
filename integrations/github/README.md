# GitHub integration — checks/review/merge gate (FF-018, E16)

Pure, zero-dependency merge policy implementing the merge policy in
[github-integration.md](../../docs/03-architecture/github-integration.md),
flow F03 in [github-delivery.md](../../docs/04-flows/github-delivery.md),
the action matrix in [policy-matrix.md](../../docs/05-contracts/policy-matrix.md),
and the GitHub cases in
[contract-test-cases.md](../../docs/05-contracts/contract-test-cases.md).

## Rule summary

- Required CI checks must pass at the exact current PR head SHA. Results for
  superseded commits are ignored.
- An independent review approval (not the PR author) at the current head SHA
  is required. Unresolved `request-changes` at the head blocks.
- Workers never merge. Nobody except the human owner merges their own PR.
- `develop`: merged by the coordinator, integration worker, or owner after
  checks plus independent review. No owner approval record required.
- `main`: merged only by the human owner with an explicit, non-expired
  owner approval bound to the exact repo, PR number, head SHA, target branch,
  and policy version. New commits invalidate it. Agent or coordinator approval
  alone never authorizes a `main` merge.
- Only `develop` and `main` are merge targets; anything else is denied.

## Usage

```ts
import { evaluateMergeGate } from "./src/index.ts";

const decision = evaluateMergeGate({
  policyVersion: "ff018-v1",
  pr: { repoId, prNumber, headSha, targetBranch, authorId },
  actor: { id, role: "coordinator" },
  checks: [{ name: "ci", headSha, status: "pass" }],
  requiredChecks: ["ci"],
  reviews: [{ reviewerId, kind: "agent", headSha, decision: "approve" }],
  approval: null,
});
// decision.allowed === true, decision.reasons === []
```

## E07 dependency note

E07 (`packages/policy`) has no implementation on any branch yet, so this gate
is deliberately self-contained and imports nothing outside
`integrations/github/`. The intended future wiring: the E07 policy service
calls `evaluateMergeGate` as the GitHub-merge rule, and the webhook handler
supplies checks/reviews/approvals keyed by exact head SHA. Approval
*recording* (signed control-plane action) and webhook HMAC verification remain
with E07 and the bridge handler respectively — this package only *evaluates*.

## Tests

```sh
npm test      # node --test src/*.test.ts (17 tests)
npm run typecheck
```

No live GitHub interaction is claimed; verification is unit-level against the
contract cases. Real-App and branch-protection wiring is future work.
