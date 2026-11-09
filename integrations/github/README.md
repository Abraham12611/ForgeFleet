# GitHub integration — checks/review/merge gate (FF-018, E16)

Pure, zero-dependency merge policy implementing the merge policy in
[github-integration.md](../../docs/03-architecture/github-integration.md),
flow F03 in [github-delivery.md](../../docs/04-flows/github-delivery.md),
the action matrix in [policy-matrix.md](../../docs/05-contracts/policy-matrix.md),
and the GitHub cases in
[contract-test-cases.md](../../docs/05-contracts/contract-test-cases.md).

## Rule summary

- Required checks come from a versioned authoritative `RequiredCheckPolicy`
  (repo configuration), never a caller-supplied list. A missing policy,
  a policy silent about the target, or an empty required set **fails closed**.
  Every required check must pass at the exact current PR head SHA; results
  for superseded commits are ignored.
- An independent review approval (not the PR author) at the current head SHA
  is required. Unresolved `request-changes` at the head blocks.
- Closed world: unknown target branches and unknown roles deny. Workers
  never merge. Nobody except the human owner merges their own PR.
- `develop`: merged by the coordinator or owner after checks plus
  independent review. No owner approval record required.
- `main`: merged only by the human owner with an explicit owner approval in
  the canonical FF-004 `OwnerApproval` shape, bound to the exact resource,
  head SHA, action, and expiry, **plus a server-minted `authProof`**.
  An approval object without `authProof` is rejected
  (`OWNER_APPROVAL_UNAUTHENTICATED`): a role string alone proves nothing.
  Message-origin or sleep-expiry approvals are rejected. New commits and
  expiry invalidate approval. A missing approval queues an owner decision
  (`require_owner`, never auto-approval, including when the owner sleeps);
  a malformed one denies. Coordinator may only request, never execute.
- Decisions use canonical verdicts (`allow` / `deny` / `require_owner`) and
  FF-004 reason codes.

## Usage

```ts
import { evaluateMergeGate } from "./src/index.ts";

const decision = evaluateMergeGate({
  policyVersion: "ff018-v2",
  pr: { repoId, prNumber, headSha, targetBranch: "develop", authorId },
  actor: { id, role: "coordinator" },
  checks: [{ name: "ci", headSha, status: "pass" }],
  checkPolicy: { version: "repo-policy-v1", targets: { develop: ["ci"] } },
  reviews: [{ reviewerId, kind: "agent", headSha, decision: "approve" }],
  approval: null,
  now: Date.now(),
});
// decision.verdict === "allow", decision.allowed === true
```

## Canonical-engine reconciliation (FF-004 / FF-023)

The canonical E07 policy engine (`packages/policy`, FF-004 branch,
`POLICY_VERSION 0.1.0`) is the single authority for
actor/role/approval-class decisions. This package mirrors its action names
(`merge.develop` / `merge.main`), verdicts, and approval reason codes, and
`toAuthorizeInput()` builds canonical-shaped `authorize()` inputs so the
bridge can delegate mechanically once `packages/policy` lands on `develop`.
This package's own job stays GitHub evidence (checks/review at exact SHAs).

Open items for E07 / coordinator:

- The FF-023 branch carries a variant policy surface (`merge_main`,
  `{allowed, approvals[]}`) that disagrees with FF-004 (`merge.main`,
  verdicts). Unifying the two engines is E07/coordinator work; this package
  implements no third engine and imports neither variant.
- The singleton integration worker (spec: serializes merges) has no
  canonical role, so it denies closed-world here. It must authenticate under
  the coordinator role until E07 extends the catalog. E16 does not mint
  privilege unilaterally.
- `authProof` minting/verification and the `prResourceId` format
  (`github-pr:<repoId>:<prNumber>:<targetBranch>`) need E07/E05 custodian
  sign-off.
- Approval *recording* (signed control-plane action) and webhook HMAC
  verification remain with E07 and the bridge handler.

## Gate status

**G5 (`main` remains owner-protected) is NOT claimed by this change.**
G5 needs real CI enforcement (tracked in #59), an installed GitHub App with
webhook verification, and owner-configured branch rules — none of which exist
yet (the repo currently has zero CI workflows). Verification here is
unit-level against the contract cases. No live GitHub interaction is claimed.

## Tests

```sh
npm test      # node --test src/*.test.ts (25 tests)
npm run typecheck
```
