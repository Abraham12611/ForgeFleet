# Inbox + sleep mode spike (FF-017, E14)

Fixture-grade, dependency-free inbox/sleep policy for the consolidated
decision inbox. See [FF-017](https://github.com/Abraham12611/ForgeFleet/issues/17).

## Files (owned by E14)

- [`inbox-policy.mjs`](./inbox-policy.mjs) — pure rules: blocked-closure,
  execution plan, question routing, answer/expiry handling,
  sleep-neutral approval evaluation, morning digest.
- [`fixtures.mjs`](./fixtures.mjs) — diamond-DAG example (example only, not
  runtime data).
- [`inbox-policy.test.mjs`](./inbox-policy.test.mjs) — 23 stdlib tests.
  Run: `node --test apps/web/src/features/inbox/inbox-policy.test.mjs`

## What this proves

- **Acceptance:** `computeExecutionPlan` blocks only the gated task plus its
  transitive dependents; every other ready task stays runnable, asleep or
  awake.
- **Sleep safety:** owner-required questions are queued as durable
  decisions; coordinator-resolvable ones never enter the inbox; expiry
  keeps blocking and never approves; sleep does not change any approval
  verdict.

## What this does NOT claim

No integration with Paperclip tasks, the E09 scheduler, or the E10
message ledger (none implemented yet). Field names follow the
sleep/decisions flow (`docs/04-flows/sleep-and-decisions.md`), screen
contract (`docs/02-experience/screens-states-and-copy.md`), and decision
machine (`docs/05-contracts/state-machines.md`). UI rendering, chat
threading (`chat/**`), and push/digest delivery are follow-ups once E05/E10
contracts land.
