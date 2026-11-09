# FF-010 — Devin capability spike and safe fallback (fixture-level report)

**Issue:** [#10](https://github.com/Abraham12611/ForgeFleet/issues/10) (`FF-010`)
**Target:** `v0.1` · **Engineer slot:** `E19` · **Date (UTC):** 2026-11-08
**Probe host:** macOS (`darwin`, arm64) — **not** the Linux service host.
Linux behavior below is inferred from `docs/03-architecture/orca-bridge.md`
and the FF-002 probe report, not observed on Linux.

> Sanitization note: no live Orca commands were executed for this spike,
> no session content was read, and no credentials or machine-identifying
> paths are recorded here. Verdicts are fixture-level by design.

## 1. Prerequisite status (E02, E03)

- **E02 (Orca discovery):** fixture-level implementation exists only on the
  local `FF-002` branch (`services/orca-bridge/src/runtime/discovery.ts`,
  unmerged). No `develop` implementation to integrate against.
- **E03 (Muse dispatch):** no implementation on any branch.
- Per the E19 brief step 1, this spike proceeds as a
  **read-only/design/fixture spike while blocked**: pure policy code under
  the E19-owned `services/orca-bridge/src/providers/**` paths, with no
  imports from E02/E03-owned modules and no process spawning.

## 2. What was built

| File | Purpose |
|---|---|
| `services/orca-bridge/src/providers/types.ts` | `ProviderStatus` (`verified`/`unsupported`/`unknown`/`unavailable`, matching `bridge.openapi.yaml`), `ProviderCapability`, `DispatchRoute` |
| `services/orca-bridge/src/providers/registry.ts` | `ProviderRegistry`: capability records + `routeDispatch()` policy; `createDefaultRegistry()` |
| `services/orca-bridge/src/providers/devin.ts` | `planDevinProbe()` (read-only argv), `assessDevinCapability()` (evidence fold), `fallbackForDevin()` (flag-free fallback descriptor) |
| `services/orca-bridge/src/providers/registry.test.ts` | 8 routing/registry tests |
| `services/orca-bridge/src/providers/devin.test.ts` | 8 probe/assessment/fallback tests |

## 3. Capability verdict: explicitly unsupported-capable, currently unknown

No live Devin evidence exists on this host, so the registry ships `devin`
as `unknown` (rejects all dispatch) until a probe runs. The assessment
function encodes the acceptance rule:

- `verified` requires **both** supervised schema verbs **and** a live
  S-06 supervised smoke. Docs alone stay `unknown`.
- `unsupported` requires **positive** negative evidence (version-matched
  guide denies supervised Devin, or schema read shows verbs absent) and
  opens only the controlled-terminal fallback — never supervised flags.
- Thin evidence stays `unknown`; unreachable binary is `unavailable`.
- There is deliberately **no function that builds supervised Devin argv**,
  so `unsupported` cannot degrade into guessed `--devin` flags
  (contract test #4 in `docs/05-contracts/contract-test-cases.md`).

## 4. Safe fallback

`fallbackForDevin()` returns `{mode: "controlled-terminal"}` with no
`argv`/`flags`/`command` fields for `unsupported` capabilities, and `null`
otherwise. E03-owned dispatch code owns the terminal-launch shape; this
module only authorizes the route. Tests assert the descriptor carries no
executable content and that `verified`/`unknown`/`unavailable`/non-Devin
inputs yield `null`.

## 5. Compatibility and integration points

- `toRuntimeProviders()` emits the `RuntimeCapabilities.providers[]`
  payload shape from `docs/05-contracts/bridge.openapi.yaml`.
- `routeDispatch()` HTTP mapping: `202` for `supervised`/`terminal-fallback`,
  `422` for every rejection (unknown provider, `unknown`/`unavailable`
  status, fallback-disabled).
- Integration with E02 discovery (executable resolution, raw output
  collection) and E03 dispatch (terminal-launch execution) is by documented
  contract, not by import — no shared files were touched.

## 6. Tests

`node --test services/orca-bridge/src/providers/registry.test.ts
services/orca-bridge/src/providers/devin.test.ts` — **16 pass, 0 fail**
(stdlib `node:test` only, no dependencies). No `tsc` gate exists in this
repo (no `package.json`); syntax is validated by Node 24 type-stripping
execution.

## 7. Limitations and next actions for coordinator

- Fixture-level only: no live `--version`/`account list`/`agent-context`
  Devin evidence, no S-06 smoke. Do **not** treat Devin as verified.
- Needs E02 merge (real probe plumbing) then a Linux S-06 run to move
  `devin` from `unknown` to `verified` or `unsupported`.
- Muse capability is registered as `unknown` but explicitly out of E19's
  lane; E03 must set it.
