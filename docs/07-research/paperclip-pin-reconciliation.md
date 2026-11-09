# Paperclip pin reconciliation (FF-031, E01 integration)

**Status:** `DECIDED` — FF-001 pin stands as the single integration target for v0.1.
FF-027's floating master is a UI-build observation, not an integration baseline.

## The two claims

| Claim | Source | Value |
|---|---|---|
| v0.1 adapter/bridge integration pin | FF-001 (`docs/07-research/paperclip-integration-strategy.md`, [ADR-0007](../08-decisions/ADR-0007-paperclip-integration-strategy.md)) | tag `v2026.1106.0`, commit `d69631b01b9c658f80bf8bed389863dce82643e1` (2026-10-23) |
| Vercel UI split observation | FF-027 (`docs/07-research/paperclip-standalone-vite-ui-vercel.md`) | `master` @ `088bdf7cfa78eda23bdfb4c25dbae90e1861c0dc` (2026-11-09) |

## Why they do not conflict

- FF-001 pins the **adapter plugin interface**: `createServerAdapter` from
  `./server/index.js`, `execute()` receiving `runtime: { sessionId, sessionParams }`,
  resumable `sessionParams`, `sessionCodec` + `clearSession` unknown-session
  handling, capability flags via `GET /api/adapters`, and the no-remote-git
  cwd invariant. The FF-031 bridge server and the E04 adapter in this branch
  are written against exactly that interface, verified by
  `scripts/paperclip-pin-smoke.sh` (re-runnable; requires network).
- FF-027 pins nothing: it observes the **Vite UI tree** on floating master to
  prove the UI builds standalone (`ui@0.3.1` / `server@0.3.1`). Its commit is
  17 days newer than the integration pin and was never adopted as an adapter
  target. UI packaging and adapter behavior are independent upgrade axes.

## Decision

1. v0.1 integration (bridge + adapter + contracts) tracks **only**
   `v2026.1106.0`. No adapter/bridge code may import behavior observed
   solely on floating master.
2. The FF-027 `apps/web` scaffold stays a **packaging spike**: it may follow
   master for build-shape observations, but any file promoted into the v0.1
   path must be re-verified against the pinned tag first.
3. Upgrades follow the rule in `docs/07-research/version-pins.md`: a branch,
   `scripts/paperclip-pin-smoke.sh` green, plus the FF-031 round-trip suite
   (`services/orca-bridge`) green, before any pin moves. A
   `createServerAdapter` signature or capability-flag change is a
   contract-review event with E04/E05.

## Live re-verification (owner environment, not this branch)

`scripts/paperclip-pin-smoke.sh` performs `git ls-remote` on the upstream
tag and re-fetches the pinned adapter docs. It was not re-run here (this
integration is network-independent by design); re-run it on the Vultr host
as part of the owner-authorized live smoke
(`docs/06-delivery/ff031-live-smoke-plan.md`) before trusting the pin there.
