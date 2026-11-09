# Migration / alias notes — FF-023 consolidation onto the FF-004 baseline

PR #53 (FF-023) originally proposed a second, competing policy engine at
`packages/policy/src/policy.js` with a different API. Per coordinator
review, there is exactly ONE canonical implementation: the FF-004 engine
from PR #33 (`authorize({ actor, action, resource, context })` returning
`allow | deny | require_owner` with stable `reasonCode`s). The competing
implementation was removed, never merged, and has no production consumers.

## API mapping (superseded FF-023 draft -> canonical)

| Superseded draft (removed, unmerged) | Canonical (PR #33, keep) |
|---|---|
| `action: 'read_task'` | `action: 'task.read'` |
| `action: 'message_peer'` | `action: 'message.post'` |
| `action: 'propose_subtask'` | `action: 'subtask.propose'` |
| `action: 'dispatch_agent'` | `action: 'dispatch.propose'` (agents) / `'dispatch.execute'` (service) |
| `action: 'open_pr'` | `action: 'pr.open'` |
| `action: 'approve_review'` | `action: 'review.approve'` |
| `action: 'merge_develop'` | `action: 'merge.develop'` |
| `action: 'merge_main'` | `action: 'merge.main'` |
| `action: 'production_deploy'` | `action: 'deploy.production'` |
| `action: 'manage_host_budget'` | `action: 'budget.increase'` / `'host.create'` |
| `action: 'rotate_secrets'` | `action: 'secrets.rotate'` |
| `action: 'destroy_resource'` | `action: 'resource.destroy'` |
| `decision.allowed: boolean` + `decision.authority: 'direct' \| 'proposal' \| 'owner'` | `decision.verdict: 'allow' \| 'deny' \| 'require_owner'` + `decision.reasonCode` |
| `decision.audit` object | `decision.audit: { policyVersion }` |
| `context.untrustedText` (ignored field) | `context.claimedViaMessage: boolean` + keep untrusted text out of the typed contract entirely |
| owner re-auth via `actor.reauthenticated` | owner re-auth via `context.ownerReauth` + server-minted `approval.authProof` |
| `resource.project` | `resource.projectId` (+ `actor.sessionProjectId`) |

## Semantic differences to be aware of

- The draft denied cross-project access even for the owner; the canonical
  engine lets the single-operator owner span projects and adds
  `sessionProjectId` mismatch denial plus `DENY`-class actions
  (`secrets.read-cross-project`, `protection.bypass`) that deny every role
  including the owner.
- The draft treated the approval record as carrying re-auth; the canonical
  engine requires server-minted `authProof` presence on every privileged
  approval and documents proof verification as a server-boundary
  obligation (see `boundary.test.js`).
- Verdict vocabulary is `allow | deny | require_owner` — there is no
  `allowed` boolean and no `authority: 'proposal'` outcome; request-only
  roles receive `require_owner` with `OWNER_REQUIRED` / `SLEEP_QUEUED`.

No aliases are shipped: the draft API never merged, so nothing needs a
compatibility shim. Any branch that copied the draft API must migrate to
the canonical names above.
