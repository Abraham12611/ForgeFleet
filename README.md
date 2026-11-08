# ForgeFleet — autonomous engineering command center

**Status:** specifications / engineering bootstrap only. This repository does **not** yet contain a working application, backend, deployed service, Orca bridge, GitHub App, or Android build.

ForgeFleet gives one human operator a single space to instruct a coordinator AI, attach project context, delegate to teams of coding agents, supervise execution, review evidence, and keep independent work moving for long periods. Instead of manually visiting 20–200 Orca terminals, the operator manages decisions and outcomes.

## Architecture decision

- **Control plane:** self-hosted [Paperclip](https://github.com/paperclipai/paperclip), extended with ForgeFleet-specific product surfaces and policy integration.
- **Initial agent execution plane:** the operator's **existing** [Orca](https://github.com/stablyai/orca) background service and already-configured Muse Code / Devin CLI integrations.
- **Connector:** a separate `orca-bridge` daemon and eventually an external Paperclip adapter. Initially prototype against Paperclip's process/HTTP adapter; do not assume either is sufficient for long-lived jobs without an integration spike.
- **System of record:** Paperclip for projects/tasks/approvals, ForgeFleet integration DB for correlation and delivery receipts, Orca for its own runtime sessions/worktrees; GitHub for commits, PRs and CI results. No dual authoritative task schedulers.
- **Client:** responsive React web UI/PWA hosted on **Vercel** after upstream compatibility checks; **Capacitor Android app** published through the owner's Google Play developer account after mobile acceptance.
- **Deployment:** split topology: static/web frontend on Vercel, **long-running Paperclip API/coordinator/PostgreSQL/Orca bridge and workers on Vultr**; Tailscale for administrative host access and internal services. Frontend/backend auth, real-time transports and public HTTPS ingress require explicit integration testing. See [deployment architecture](docs/03-architecture/infra-deployment.md) and [ADR-0006](docs/08-decisions/ADR-0006-vercel-and-android.md).

## Target deployment

`app.<owned-domain>` → Vercel frontend; `api.<owned-domain>` → secured Vultr Paperclip backend; local/private Orca bridge → existing user service. Do **not** run agent execution or the Paperclip coordinator inside Vercel Serverless Functions. Initial alpha may keep the complete Paperclip UI/API together on Vultr until frontend decoupling and authentication pass their gate. No Vercel or Google Play app is created or deployed by this documentation commit.

## Read in this order

1. [Working agreement](AGENTS.md), [documentation index](docs/INDEX.md), and [product requirements](docs/01-product/product-requirements.md).
2. [System boundaries](docs/03-architecture/system-architecture.md), [Orca adapter](docs/03-architecture/orca-bridge.md), [task lifecycle](docs/03-architecture/orchestration.md).
3. [API contract](docs/05-contracts/bridge.openapi.yaml), [events](docs/05-contracts/events.md), [state machines](docs/05-contracts/state-machines.md).
4. [Release plan](docs/06-delivery/roadmap.md), [20-engineer allocation](docs/06-delivery/engineer-assignments.md), [dependencies](docs/06-delivery/dependencies.md).
5. [Integration facts and unknowns](docs/07-research/compatibility-and-spikes.md).
6. [Vercel/Vultr/Google Play deployment](docs/03-architecture/infra-deployment.md), [ADR-0006](docs/08-decisions/ADR-0006-vercel-and-android.md), and [release runbook](docs/09-operations/vercel-and-play-release.md).

## Milestones

- **v0.1 — Connect:** Paperclip can start and observe one Muse worker through existing Orca on Vultr.
- **v0.2 — Coordinate:** task graph, workers, inbox, and simple Android-friendly dashboard.
- **v0.3 — Deliver:** verified GitHub PR review, CI feedback, controlled merges and sleep mode.
- **v0.4 — Endure:** safe retries, crash recovery, context continuity and audit trails.
- **v1.0 — Operate:** secure self-hosting, continuous unattended runs with guardrails and production readiness.
- **v1.1+ — Scale:** additional runtime providers, distributed worker capacity, and Google Play Android distribution.

## First demonstration (non-negotiable)

A human creates one goal in Paperclip; the coordinator decomposes it into three tasks; bridge launches three Orca workers in isolated worktrees; workers send progress/questions; changes produce PRs; CI results are ingested; an independent review decision is recorded; eligible changes merge according to policy; the UI shows traceable completion. Repeat with an intentional daemon restart without duplicate execution.

## Safety and continuity

Initial mode: private, single-operator, no production secrets in agent contexts. PR merges to `main`, production deploys, destructive migrations, and significant spending require human approval unless explicitly changed. Sleeping never silently grants approval. Bounded retries, resource caps and idempotent dispatch are mandatory.

## Repository bootstrap

See [`scripts/publish-to-github.sh`](scripts/publish-to-github.sh). It uses GitHub CLI authentication **on the user's own environment** to create a **private** repo and push the scaffold. Do not paste tokens into a chat or commit them into this repository. If the empty repository is created via GitHub UI instead, push this folder with standard `git` commands.

## Attribution / upstream boundaries

This repository contains original planning documents, not a copy of the Paperclip, Orca, or Vespin source trees. Before vendoring/forking any upstream code, verify exact licenses and notices; preserve attribution and maintain an upstream update strategy. See [source inventory](docs/07-research/sources-and-licenses.md).

## Populate initial GitHub engineering backlog (optional)

After the repository exists and `gh` is authenticated, preview the 26 planned issues with `python3 scripts/seed-github-issues.py`. To create missing issues, run `python3 scripts/seed-github-issues.py --apply --repo Abraham12611/ForgeFleet`. The script skips issues whose stable `FF-###` IDs already occur in issue titles; it does not create labels, milestones, or assignments automatically.
