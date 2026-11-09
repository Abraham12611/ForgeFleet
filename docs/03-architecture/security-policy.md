# Least-privilege auth/policy threat model (FF-004)

Companion to [security-and-trust](security-and-trust.md). That file states
the trust boundaries and approval classes; this file turns them into an
enforceable, tested contract. Implementation:
[`packages/policy/src/policy.js`](../../packages/policy/src/policy.js).
Deny tests: [`packages/policy/tests/policy.test.js`](../../packages/policy/tests/policy.test.js).

## Actors and trust

| Actor | Role | Trusted to |
|---|---|---|
| Human operator | `owner` | Approve anything, via authenticated owner action only |
| Coordinator LLM (+ scheduler/service) | `coordinator` / `service` | Propose plans and merges, execute only what policy allows |
| Lead / worker agents | `lead` / `worker` | Work inside one project; propose, never self-approve or merge |
| Independent reviewer | `reviewer` | Approve others' work at a stable head SHA |
| Message text (prompts, PR bodies, logs, webhooks pre-verify) | — | Nothing. Never authority. |

The policy engine is a pure function of `(actor, action, resource,
context)`. It never reads message text, connection state, or LLM output.
Any authority asserted through those channels is denied with
`MESSAGE_NOT_AUTHORITY` (`context.claimedViaMessage`).

## Threat -> rule -> test

| # | Threat (from contract-test-cases security section) | Policy rule | Test |
|---|---|---|---|
| T1 | Malicious PR text instructs agent to reveal secrets / approve itself | Message content never authority; self-approval denied | `message content is never authority`; `review.approve denies self-approval` |
| T2 | Stolen session scope used against another project | `actor.sessionProjectId` must equal `resource.projectId` | `denies stolen session scope` |
| T3 | Cross-project message / read leaks context | Non-owner actors scoped to `actor.projects`; owner spans projects as single operator | `denies reads outside scope`; `denies cross-project messages` |
| T4 | Agent merges to `main` without owner, or approval omits target/SHA binding | `merge.main`: worker/lead deny; coordinator request-only; owner allow only with approval carrying server-minted `authProof`, nonempty `resourceId` matching `resource.id`, and exact `targetSha` matching current `headSha`. Absent bindings deny (`TARGET_MISSING` / `SHA_MISSING`), never pass | `main merge is owner-only at the exact SHA` (incl. missing/empty binding tests) |
| T4b | Bare `grantedBy: 'owner'` object presented as approval | `authProof` required on every privileged approval; object without it denies (`OWNER_APPROVAL_UNAUTHENTICATED`) | `approval without server-minted auth proof is not an approval` |
| T8b | `merge.develop` fed unbound or untrusted check results | `headSha` required (`CHECKS_SHA_MISSING`); `checksPass` must come from trusted GitHub check/webhook state at that SHA — boundary obligation below | `checks unbound to any head SHA are rejected` |
| T5 | Approval replay after new commits | `targetSha` must equal current `headSha`, else decision reopens | `changed head SHA after approval reopens the decision` |
| T6 | Expired approval treated as consent | `now >= expiresAt` denies; expiry never grants | `expired owner approval grants nothing` |
| T7 | Sleep mode silently approves queued work | `OWNER_REQUIRED` under `sleeping` stays `require_owner` (`SLEEP_QUEUED`); `sleep-expiry` origin invalid | `sleep mode queues instead of approving`; `sleep-expiry origin never counts` |
| T8 | Coordinator merges to `develop` without review/checks | Requires green checks plus independent (non-author) reviewer | `develop merge keeps independent review and green checks` |
| T9 | Privilege escalation via secrets/permissions tools | `secrets.rotate` / `permissions.grant`: owner only, with session re-auth plus approval; coordinator request-only | `secrets rotation needs owner re-auth plus approval` |
| T10 | Accidental or malicious destruction | `resource.destroy`: owner only, explicit confirmation plus approval | `destruction requires explicit confirmation` |
| T11 | Cross-tenant secret access, protection bypass | `DENY`-class: denied for every role including owner | `cross-project secrets read is DENY-class`; `protection bypass denied for every role` |
| T12 | Unknown action/role slips through | Closed world: unknown action or role denies | `unknown actions and roles deny` |

## Status: design prototype, not a deployed security gate

This package is a deterministic decision aid for design and tests. It MUST
NOT be treated as an enforced security gate until the server integration
boundary (E16/services) implements the obligations below and wires the
engine behind authenticated APIs. No bridge or service code consumes it
yet.

## Decision shape (E07-local; reconciled with E05 v0.1)

```json
{
  "verdict": "allow | deny | require_owner",
  "approvalClass": "AUTO_SAFE | AUTO_CHECKED | OWNER_REQUIRED | DENY",
  "action": "merge.main",
  "actor": { "type": "human", "id": "owner-1", "role": "owner" },
  "reasonCode": "OWNER_APPROVAL_SHA_MISMATCH",
  "reason": "The target changed after approval; ...",
  "audit": { "policyVersion": "0.1.0" }
}
```

`require_owner` means: open a durable owner decision (per
[state-machines](../05-contracts/state-machines.md)), then re-invoke with
`context.approval`. It is never satisfied by chat, sleep expiry, or a
different action/resource/SHA.

## Server integration boundary obligations (E16/services)

The engine validates shape, never identity or provenance. The boundary
that calls it MUST:

1. **Mint `authProof` only after real owner authentication.** Never accept
   a client- or agent-supplied proof value; bind it to the authenticated
   session server-side. Policy treats the field as opaque presence, so a
   forged-but-wellformed value passes the engine — true verification is
   the boundary's job.
2. **Source `merge.develop` inputs from trusted GitHub state.** `headSha`
   must be the exact PR head from verified webhook/check APIs, and
   `checksPass` must reflect required check runs at that SHA — never
   agent-reported status. Policy rejects SHA-unbound inputs; it cannot
   verify where bound inputs came from.
3. **Construct `actor` from the authenticated session**, including
   `sessionProjectId`, so stolen-scope denial works. Never derive the
   actor from message content.

## Dependency and residual risk (reconciled with E05 v0.1, PR #46)

- **E05 v0.1 is merged** (`packages/bridge-contracts`, CONTRACT-VERSION
  0.1.0, rebased in). It defines no approval/decision shape — bridge v0.1
  carries only `approvedBy` (validated actor ID string) on cancel. The
  decision shape above therefore stays E07-local. If approvals ever cross
  the bridge, that needs a contract version bump plus regenerated outputs
  and downstream acknowledgement per the E05 freeze policy.
- A forged input source defeats any policy; input provenance stays an
  explicit integration gate (see obligations above).
- No production wiring in this change: pure logic plus tests, no service,
  no secrets, no runtime disruption.
