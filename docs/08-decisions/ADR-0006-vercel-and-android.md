# ADR-0006 — Vercel-hosted web client, Vultr-hosted control/runtime, Google Play Android

- **Status:** ACCEPTED TARGET, FEASIBILITY GATED (2026-11-08)
- **Owner intent:** Host the web application on Vercel and distribute the mobile app through the owner's Google Play developer account.

## Decision

Adopt a **split deployment**: Vercel runs the React/Vite web UI and frontend delivery; Vultr remains responsible for the always-on Paperclip coordinator/API, durable database, worker fleet, Orca bridge, GitHub webhooks and background reconciliation. Capacitor packages the same responsive UI as a native Android app for Play Console distribution. Keep Tailscale for administration and the worker private network.

## Why

Vercel is a good fit for static frontend assets, PR previews, SSL and Git deployment workflows. The long-lived coordinator, local Orca daemon, worktree filesystem and persistent workers require a real server or container host; serverless functions do not replace them. Android requires native packaging, device testing and Play policy compliance, not a distinct product implementation.

## Caveats and validation gates

1. Paperclip's Vite UI must be proved deployable independently of its Node API; the official bundled deployment is fallback.
2. Vercel-hosted browser clients cannot call `127.0.0.1` on the Vultr VPS or addresses accessible only on the operator's Tailscale network. Provide a secured HTTPS API ingress and properly authenticate it.
3. Verify Better Auth/cookie domains, OAuth callbacks, CSRF, CORS, previews, live event streaming and uploads across split origins. Prefer sibling subdomains on one owned domain.
4. No Orca bridge, SSH, database, agent CLI, service secret or private worker endpoint is ever public.
5. Google Play release requires signing, AAB generation, platform/version policy checks, privacy policy/data-safety declarations, staged testing and explicit owner action in Play Console.
6. Do not link Vercel production to `develop`; PR previews are test environments. `main` release/promotion remains owner-approved per policy.

## Consequences / owners

E01 controls Paperclip UI compatibility, E12 frontend/preview builds, E17 Vercel/Vultr/ingress and secrets, E07 authentication/security, E20 Capacitor/Play distribution. Feature work may proceed on private Vultr alpha while the split-deployment spike runs in parallel. Exact domains and Play package ID remain OPEN; do not guess them.

## Rejected alternatives

- Running the Paperclip coordinator/Orca bridge inside Vercel Functions: incompatible with persistent user-service processes and filesystem worktrees.
- Publishing the admin bridge directly to the Internet: severe access-control exposure.
- Starting with two separate React implementations for web and Android: unnecessary maintenance cost.
