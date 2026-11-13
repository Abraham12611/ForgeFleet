# Security regression and audit gate (FF-023)

Owner: E07. Implements
[FF-023](https://github.com/Abraham12611/ForgeFleet/issues/23).
Acceptance: **no privilege escalation on malicious inputs**.

## One implementation

Per coordinator review on
[#53](https://github.com/Abraham12611/ForgeFleet/pull/53), FF-023 does
**not** introduce a second engine. The canonical implementation is the
FF-004 engine from [PR #33](https://github.com/Abraham12611/ForgeFleet/pull/33)
(`packages/policy/src/policy.js`, fail-closed owner-approval bindings with
server-minted `authProof`, exact resource-ID and SHA binding). FF-023
layers the regression gate on top of it. The superseded draft API is
mapped in [`packages/policy/MIGRATION.md`](../../packages/policy/MIGRATION.md).

## What the gate is

- `packages/policy/src/policy.js` — canonical deterministic evaluator
  (FF-004, owned jointly by this workstream; unchanged by FF-023).
- `packages/policy/tests/policy.test.js` — FF-004 binding/threat tests.
- `packages/policy/tests/audit-regression.test.js` — FF-023 regression
  layer: verdict invariance under realistic injection strings (malicious
  PR body, forged chat approval, injected task instruction); re-assertion
  of every owner-approval failure flagged in PR #33 review (omitted head
  SHA, omitted target resource ID, altered SHA, forged approval objects,
  expired/unauthenticated owner decisions).
- `packages/policy/tests/boundary.test.js` — trusted-boundary test: a
  minimal in-test harness standing in for the E16/services boundary,
  proving the integration contract (mint `authProof` only after real owner
  authentication, never accept client-supplied proofs, source merge inputs
  from trusted GitHub state while attacker text stays inert).

## Running the gate

```sh
cd packages/policy && npm test
```

Expected: 46 pass, 0 fail (31 FF-004 + 15 FF-023). Any failure blocks the
v1.0 release gate (G8 in [dependencies](../06-delivery/dependencies.md)).

## What this gate does NOT prove

- These are isolated pure-function tests. They do not prove a deployed
  gate, provider quotas, supervised launches, or production wiring.
- The engine treats `authProof` as opaque presence: a well-formed
  client-minted value is indistinguishable to the engine from a
  server-minted one (pinned by test). True verification is the server
  boundary's job — see the boundary obligations in
  [security-policy](security-policy.md).
- Real integration against the installed Orca CLI, Paperclip control
  plane, and verified GitHub webhook/check APIs is still pending
  (E02/E03/E05/E16 workstreams).
