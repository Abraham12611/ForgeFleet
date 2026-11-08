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
| T4 | Agent merges to `main` without owner | `merge.main`: worker/lead deny; coordinator request-only; owner allow only with fresh SHA-pinned approval | `main merge is owner-only at the exact SHA` |
| T5 | Approval replay after new commits | `targetSha` must equal current `headSha`, else decision reopens | `changed head SHA after approval reopens the decision` |
| T6 | Expired approval treated as consent | `now >= expiresAt` denies; expiry never grants | `expired owner approval grants nothing` |
| T7 | Sleep mode silently approves queued work | `OWNER_REQUIRED` under `sleeping` stays `require_owner` (`SLEEP_QUEUED`); `sleep-expiry` origin invalid | `sleep mode queues instead of approving`; `sleep-expiry origin never counts` |
| T8 | Coordinator merges to `develop` without review/checks | Requires green checks plus independent (non-author) reviewer | `develop merge keeps independent review and green checks` |
| T9 | Privilege escalation via secrets/permissions tools | `secrets.rotate` / `permissions.grant`: owner only, with session re-auth plus approval; coordinator request-only | `secrets rotation needs owner re-auth plus approval` |
| T10 | Accidental or malicious destruction | `resource.destroy`: owner only, explicit confirmation plus approval | `destruction requires explicit confirmation` |
| T11 | Cross-tenant secret access, protection bypass | `DENY`-class: denied for every role including owner | `cross-project secrets read is DENY-class`; `protection bypass denied for every role` |
| T12 | Unknown action/role slips through | Closed world: unknown action or role denies | `unknown actions and roles deny` |

## Decision shape (proposed, pending E05)

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

## Dependency and residual risk

- **E05 (bridge contracts) not yet delivered**: no
  `packages/bridge-contracts` exists, so the decision shape above is local.
  Reconcile field names with the E05 custodian before v0.1 integration;
  no bridge code consumes this package yet.
- Policy evaluation is only as good as its inputs: actor authentication,
  `headSha` freshness, and check results must come from trusted sources
  (GitHub App/webhook verification is E16). A forged input source defeats
  any policy; input provenance stays an explicit integration gate.
- No production wiring in this change: pure logic plus tests, no service,
  no secrets, no runtime disruption.
