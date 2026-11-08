# Project charter

**Codename:** ForgeFleet. **Initial operator environment:** one Linux Vultr VPS with an existing `systemctl --user` Orca service, Orca Mobile over Tailscale, and previously configured Muse Code and Devin CLI. This is supplied context, not a live environment inspection.

## Mission

Enable one human to supervise outcomes across one or more software projects by communicating with a coordinator, while an elastic fleet of coding agents autonomously plans, implements, tests, opens PRs and asks for help only when required.

## Primary outcome

One unified place to understand: (a) what was requested, (b) who owns each task, (c) what's running/blocked, (d) what shipped, (e) what requires the human's decision, (f) what it costs.

## Operating principles

1. Preserve the existing working Orca setup; integrate instead of reinstalling.
2. Reuse upstream Paperclip features before reimplementing; keep upstream fork changes minimal.
3. Coordinator judges engineering goals; deterministic policy services enforce dispatch, budget, GitHub merge, and security.
4. Unattended operation means work proceeds while safe work exists; it does **not** mean unattended unlimited authority.
5. Communication is durable, threaded and correlated to tasks; use concise escalation.
6. Dependencies control parallelism; more agents do not imply more throughput.
7. Session recovery must be verifiable and avoid duplicate side effects.
8. Web-first responsive UX; Android packaging after stable core workflows.

## Stakeholders

- Human operator: initiates goals, uploads context, changes settings, decides gated operations.
- AI coordinator: decomposes and manages work, resolves routine clarifications, proposes gated actions.
- Leads/workers: implement scoped tasks and report evidence.
- System scheduler: enforces readiness, limits, leases, retry and reconciliation.
- Security/audit service: records and enforces privileged decisions.

## Constraints

No assumptions about available Vultr RAM/CPU, installed Orca binary/version, supported Devin worker launch mode, Paperclip fork compatibility, AI subscriptions, or Google Play release account status until verified by a safe read-only spike.
