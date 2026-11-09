# ADR-0007 — Paperclip integration strategy: external plugin, pinned upstream

**Status:** Accepted (FF-001).  
**Context:** [FF-001](https://github.com/Abraham12611/ForgeFleet/issues/1),
[spike report](../07-research/paperclip-integration-strategy.md),
[ADR-0001](ADR-0001-control-plane.md), [ADR-0002](ADR-0002-execution-adapter.md).

## Context

ForgeFleet uses self-hosted Paperclip as the control plane and must execute
long-lived workers through the operator's existing Orca service. Two
integration shapes were possible: fork Paperclip's source (built-in adapter
plus UI edits in-tree) or compose with it (external adapter plugin, thin UI
composition). Paperclip's own adapter guide at the pinned tag recommends the
plugin path, and the risk register rates upstream churn as high/medium.

## Decision

1. **Orca execution integrates as an external Paperclip adapter plugin**
   (`packages/paperclip-orca-adapter/`, owner E04), exporting
   `createServerAdapter` under the plugin-loader convention, with
   `sessionParams` continuity, `clearSession` recovery, and capability flags
   per the pinned `docs/adapters/creating-an-adapter.md`.
2. **Pin upstream to tag `v2026.1106.0`** (commit
   `d69631b01b9c658f80bf8bed389863dce82643e1`, MIT). Track releases, never
   floating `HEAD`. Upgrades follow the rule in
   [version-pins.md](../07-research/version-pins.md): dedicated branch plus
   start/status/event/resume/finalize smoke.
3. **Stock `process`/`http` adapters are proof-of-concept only** (no session
   persistence, no real-time stdout) — spike S-03, then graduate to the
   external adapter (spike S-04).
4. **Cross-run persistence obeys the upstream no-remote-git contract:**
   the local cwd is the only persistence boundary; the adapter performs the
   `prepare → execute → restore` round-trip against Orca worktrees; a failed
   sync-back is a run-level `workspace_finalize=failed` error that gates
   dependents. No `git push` from adapter code.
5. **UI integration composes first.** `apps/web` stays a thin composition
   target pending the Phase-0.E Vercel split spike; any forked upstream UI
   file is recorded as a patch set against the pinned commit and rebased
   through the upgrade rule.

## Alternatives considered

- **Built-in adapter in a fork:** requires touching three upstream registries
  per adapter and rebasing onto a fast-moving upstream. Rejected as the
  default; reserved for a proven need (e.g., a capability the plugin loader
  cannot express).
- **HTTP-adapter-only integration:** rejected for production use — no session
  continuity or stdout streaming, per upstream docs.
- **Second task scheduler (e.g., Gas City as root):** rejected — one
  authoritative task owner (Paperclip); Gas City remains a reference only.

## Consequences

- E04 builds against a frozen, smoke-pinned contract; E05/E06/E07 can rely on
  exact `sessionParams`/`clearSession`/capability semantics.
- Adds a plugin-compatibility watch: upstream `createServerAdapter` or
  capability changes trigger contract review before any pin bump.
- Live compatibility (Orca service, Vultr, Vercel split) remains to be proven
  by spikes S-01–S-05; nothing in this ADR claims a running deployment.
