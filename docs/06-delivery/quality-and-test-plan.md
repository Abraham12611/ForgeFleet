# Definition of done, test plan and review workflow

## Task Definition of Done

- Acceptance criteria met using deterministic evidence.
- Typed API and event schema compatible; DB migrations reversible as appropriate.
- Tests run and evidence reported; coverage concentrated on failure-prone behavior.
- Security/policy check passes; no secrets/log leakage; project isolation enforced.
- User-visible loading/error/stale states addressed if applicable.
- Changes confined to assigned files or explicitly coordinated.
- PR references task and provides reproduction steps, known limitations and rollback.
- Required checks green and independent review completed. No self-merge.

## Test pyramid

1. Unit: DAG cycle detection, retry/admission policy, permissions, state machine transitions, event dedupe.
2. Contract: OpenAPI schema, typed events, adapter compatibility, policy decision shape.
3. Integration with fake Orca: accepted launch, duplicate receipts, delayed messages, out-of-order event replay.
4. Real integration on disposable repo: authenticated Paperclip → installed Orca → Muse/Devin where supported.
5. E2E browser/mobile responsive: create goal, monitor tasks, answer decision, see CI, see verified completion.
6. Chaos: kill bridge, restart control plane, provider outage, webhook loss, DB interruption and workspace sync failure.
7. Security: malicious PR text, stolen session scope, cross-project message, forged webhook, unauthorized main merge.
8. Load: event fan-out, 20 and 200 **displayed** agents; active worker ramp under measured host/provider capacity.

## PR review process

Engineer opens PR to `develop`; CI runs; independent reviewer checks diff/contract boundaries; coordinator adjudicates; integration maintainer merges if policy allows. `main` merge only on authenticated owner approval unless owner changes policy. Failed checks produce bounded repair task, not endless self-repair.

## Release gate

Every milestone links to a reproducible demonstration, test results, known gaps, risk acceptance and rollback path. Do not mark a version shipped because docs exist or because fake event fixtures looked convincing.
