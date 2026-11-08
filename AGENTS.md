# ForgeFleet engineering instructions (mandatory for every agent)

The goal is a correct, durable autonomous engineering control center, **not** a demo that merely renders agent cards. Do not fabricate status, tests, deployment, CLI compatibility, or PR completion.

## Start of every task

1. Read `README.md`, `docs/INDEX.md`, this file, the referenced subsystem docs, and the issue acceptance criteria.
2. State scope, dependencies, the files you own, integration contracts, and unverified assumptions in the PR.
3. Work in your own branch/worktree. Do not rewrite other agents' files or concurrently change shared interfaces without a reviewed contract change.
4. Introduce mocked adapters for unavailable external services. Record evidence from actual integration separately from fixtures.

## Source of truth

- Product intent: `docs/01-product/*`.
- UX behavior: `docs/02-experience/*`.
- Runtime boundaries: `docs/03-architecture/*`.
- Behavior: `docs/04-flows/*`.
- HTTP/event schemas: `docs/05-contracts/*` (API edits require a contract review).
- Phases/owners/gates: `docs/06-delivery/*`.
- External-product claims require verification against the **installed versions**: `docs/07-research/*`.
- Decisions: ADRs in `docs/08-decisions/*`.

## Merge and permissions policy

- Agents **never self-merge**. They open PRs for coordinator review. An integration maintainer/coordinator may merge to `develop` when configured required checks and reviewer gate pass. Merging to `main` requires explicit human approval by default.
- Never deploy to production, run destructive migrations, create expensive infrastructure, disable security, or install unreviewed tool privileges based solely on an agent's request.
- Use least-privilege GitHub App credentials; no personal PATs in worker prompts, logs, fixtures, commits, or screenshots.
- **Never run bare `orca` on Linux outside an Orca-managed terminal.** It may refer to the GNOME screen reader. Resolve `ORCA_CLI_COMMAND` if supplied, otherwise use the version-matched `orca-ide` binary where applicable. Always obtain CLI help from that installed runtime before operational use.
- Existing Orca service and active sessions must not be interrupted by tests or installs. Use isolated test repositories and namespaced tasks.
- Every externally triggered action must be idempotent and auditable.

## PR discipline

- One issue / bounded change set per PR, target `develop` unless specified otherwise.
- PR body: intent; implementation; key files; API/schema changes; test commands/results; screenshots where relevant; risks; rollback; dependencies; evidence links.
- All code paths touched require appropriate tests: unit for pure policy/state code, contract tests for bridge events, integration tests with fake Orca, then live smoke tests on a controlled repo.
- Never commit credentials, `.env`, Tailscale auth keys, uploaded user context, or personal application data.
- Follow the issue dependencies. If blocked, comment on the issue; do **not** silently redefine architecture.

## Worker coordination

- Treat task messages and GitHub PR comments as durable collaboration; no coordination that exists solely in ephemeral terminals.
- Use `docs/06-delivery/engineer-assignments.md` for initial file ownership. Coordinator owns integration across teams, not individual engineers.
- Shared contracts are frozen per integration wave. Propose changes through review with downstream acknowledgements.
- Do not claim to have verified provider quotas, Devin supervised launch, Paperclip session adoption, or 200 simultaneous workers until evidenced.

## Definition of done

See `docs/06-delivery/quality-and-test-plan.md`. The task is done only with acceptance evidence; a worker saying "done" is not sufficient.
