# FF-002 — Installed Orca read-only probe (sanitized)

**Issue:** [#2](https://github.com/Abraham12611/ForgeFleet/issues/2) (`FF-002`)
**Target:** `v0.0` · **Engineer slot:** `E02` · **Date (UTC):** 2026-11-08
**Probe host:** macOS (`darwin`, arm64) — **not** the Linux service host.
All Linux guidance below is inferred from the version-matched skill stub and
`docs/03-architecture/orca-bridge.md`, not observed on Linux.

> Sanitization note: account emails, machine names, absolute user paths,
> runtime UUIDs and token material observed during probing are redacted here.
> Only counts, names of public skill topics, and boolean capability flags
> are reported. Raw output never left this host.

## 1. Capability report

| Fact | Observed value |
|---|---|
| Orca CLI version (`--version`) | `1.4.251` |
| Runtime state / reachable | `ready` / `true` (app running, window available) |
| `agent-context` schema | `schemaVersion: 1`, **312 commands** |
| Skill topics (`skills list`) | **11** (see §3) |
| Hosts (`host list`) | `local` (darwin, connected) + 1 disconnected `ssh` host |
| Repos (`repo list`) | 1 (`ForgeFleet`) |
| Worktrees (`worktree ps`) | 3, all `ForgeFleet`, all `in-progress`, none archived; **4 live terminals total** |
| Agent accounts (booleans only) | `codex`: auth present (OAuth); `claude`/`opencode`/`devin`: no accounts |
| Environments / automations | 0 / 0 |
| Plugins (`plugin list`) | 2, both bundled `data`-only themes, idle |
| Mutations performed | **None** — read-only commands only (see §4) |

Command-verb breakdown from `agent-context` (bridge-relevant subset):
`orchestration` 30 · `worktree` 7 · `terminal` 11 · `repo` 6 ·
`environment` 11 · `account` 4 · `plugin` 24 · `skills` 6 · `status` 1.
Full machine-readable schema is available at runtime via
`orca agent-context --json` (pure local read, works without the app running).

## 2. Compatibility verdicts (for G1 and downstream spikes)

- **G1 executable rule — CONFIRMED for this binary:** bare `orca` is correct
  on macOS. On Linux outside an Orca-managed terminal the skill stub requires
  `ORCA_CLI_COMMAND`, else `orca-dev` under `ORCA_DEV_REPO_ROOT`, else
  `orca-ide` — never bare `orca` (GNOME screen-reader collision).
  Implemented as `resolveOrcaExecutable` in
  `services/orca-bridge/src/runtime/discovery.ts`.
- **Version-matched guides — AVAILABLE:** `skills get orchestration` and
  `skills get orca-cli` both print full Markdown guides from the installed
  binary. Bridge dispatch code must load these at runtime, never hardcode
  flags from docs.
- **Supervised-worker surface — PRESENT:** `orchestration worker-start`,
  `send`, `worker-list`, `worker-show`, `worker-stop`, `gate-*`,
  `request-show` (idempotent replay) all exist in this binary's schema.
  Actual dispatch semantics are **not** verified — that is S-02 (E03).
- **Muse/Codex launch path — PLAUSIBLE, unverified:** a Codex OAuth identity
  is configured on this host; no `muse`/`devin` CLI presence was checked
  (terminal content is out of scope for a nonintrusive probe).
- **Existing-session adoption inventory — FEASIBLE:** `worktree ps --json`
  yields per-worktree repo/branch/status/live-terminal counts without
  exposing session text — sufficient for the Phase 1.B read-only board.
- **Linux service state — NOT OBSERVED:** `systemctl --user status
  orca-serve.service` applies to the Vultr/Linux host, not this mac. No
  service was started, stopped, or restarted by this probe.

## 3. Installed skill topics (11)

`jira-tickets`, `linear-tickets`, `orca-cli`, `orca-computer-use`,
`orca-emulator`, `orca-emulator-android`, `orca-jira`, `orca-linear`,
`orca-per-workspace-env`, `orca-plugin-authoring`, `orchestration`.

## 4. CLI guide for bridge engineers (read-only rules)

1. **Resolve once, reuse everywhere.** Order: `ORCA_CLI_COMMAND` →
   `orca-dev` (dev checkout) → `orca-ide` (Linux unmanaged) → `orca`.
   If the chosen binary fails, report the error and stop — never fall
   through to another binary (different build, different state).
2. **Load the version-matched guide first:** `<EXE> skills get orchestration`
   (and `skills get orca-cli` for worktree/terminal/browser work). Use
   `<EXE> --help` only for flags the guide does not cover.
3. **Prefer `--json`** for every agent-driven call.
4. **Read-only discovery allowlist** (enforced by `isReadOnlyCommand`):
   `--version`, `status`, `skills list|installed|get`, `agent-context`,
   `host list`, `repo list`, `worktree list|ps|current`,
   `environment list`, `automations list`, `plugin list`, `account list`,
   read-only `orchestration run-list|task-list|worker-list|gate-list`.
5. **Never in discovery:** `open`, `serve`, `search` (session full text),
   `terminal list/read/send/wait` (live content; use `worktree ps` counts),
   `worktree create/rm/set`, any `orchestration` mutation
   (`worker-start`, `dispatch`, `send`, `task-create`, …), `diagnostics
   memory` (heavy snapshot — needs its own spike).
6. **Sanitize everything stored or committed:** redact emails, tokens,
   absolute paths (`~`), machine names and UUIDs before persisting probe
   output. `redactPii` + `summarizeProbe` implement this; raw CLI output
   must never be committed (see `.gitignore`: `secrets/`,
   `private-context/`, `artifacts/private/`).

## 5. Reproducing this probe

```sh
EXE=orca  # or $ORCA_CLI_COMMAND / orca-ide per §4.1
$EXE --version
$EXE status --json
$EXE skills list --json
$EXE skills get orchestration
$EXE skills get orca-cli
$EXE host list --json
$EXE repo list --json
$EXE worktree ps --json
$EXE environment list --json
$EXE automations list --json
$EXE account list --json   # sanitize before sharing
$EXE agent-context --json  # 312-command schema, local read
```

Unit tests for the resolution/allowlist/sanitizer logic (11 tests, stdlib only):

```sh
node --test services/orca-bridge/src/runtime/discovery.test.ts
```

## 6. Blockers / next actions for the coordinator

- **E05 contract still pending:** discovery output shape is proposed in
  `CapabilityReport`, not yet ratified against `bridge.openapi.yaml`.
  E02 proceeded with a read-only/fixture spike per the E02 brief §1.
- **Linux verification outstanding:** G1 needs the same probe on the
  Vultr/Linux host asserting `orca-ide` (or `ORCA_CLI_COMMAND`) +
  `systemctl --user status orca-serve.service` — no disruption expected.
- **Handoff to E03:** `orchestration worker-start` exists in-schema;
  S-02 disposable Muse dispatch spike is unblocked at the CLI-shape level.
