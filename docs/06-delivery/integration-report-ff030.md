# FF-030 initial integration report (E18)

Branch: `ImisiDahunsi4/p0-v0.0-ff-030-establish-real-github-actions-ci` → `develop`.
Workflow: `.github/workflows/ci.yml` (`ci-baseline`). No deployment, no Orca
starts, no secrets in jobs. Evidence below is from a local run of the exact
CI commands; the per-PR workflow run is the objective record going forward.

## Commands and results (local, 2026-11-09)

| Command | Result |
|---|---|
| `python3 scripts/check-specs.py` | PASS — 84 Markdown files, links OK |
| `python3 scripts/ci/check_manifest.py` | PASS — 94/94 manifest entries match |
| `python3 scripts/ci/check_contracts.py` | PASS — fixtures valid, no dup paths/operationIds/schemas, all `$ref`s resolve |
| `python3 scripts/ci/check_hygiene.py` | PASS — 95 tracked files, no credentials |
| `python3 scripts/ci/inventory.py --prove-fail-closed` | PASS — 3 canaries rejected, 2 clean-tree controls pass |
| `python3 scripts/ci/inventory.py --report ci-report.md` | PASS, SCOPE: PARTIAL (8 suites uncovered) |
| `node --version` / `python3 --version` | v24.22.0 / 3.9.6 locally; CI pins Node 24.x + Python 3.12 |

Local Python is 3.9.6 while CI uses 3.12; all gate scripts are stdlib-only
and version-agnostic, and the workflow itself is the 3.12 record.

## Pass / fail per workstream

| Workstream | Status | Evidence |
|---|---|---|
| Specs / docs integrity | PASS | check-specs + manifest gates |
| v0.1 contracts (E05) | PARTIAL | YAML structural gate passes; generator `--check` uncovered (generator does not exist yet) |
| Policy / coordinator / scheduler / messaging `node:test` (E07–E10) | UNCOVERED | no `packages/*` code exists |
| Runtime dispatch/discovery (E02–E04) | UNCOVERED | no `services/*` code exists |
| Python fixtures (E15) | UNCOVERED | no `tests/` dir exists |
| Web Vite (E12) | UNCOVERED | no `apps/web` exists |
| Secret hygiene | PASS | hygiene gate, 95 tracked files |

## Uncovered modules

`packages/bridge-contracts`, `packages/policy`, `packages/coordinator`,
`packages/scheduler`, `packages/messaging`, `services/orca-bridge/src/runtime`,
`tests/`, `apps/web`. Absence is recorded in `ci-report.md`, not counted as
passing — see `docs/06-delivery/ci-baseline.md` for the anti-false-green rule.

## Known failures

None: all executable gates pass. The deliberately-failing canaries
(duplicated operationId, committed `ghp_` token, missing contract tree) each
fail their gate in `--prove-fail-closed`, confirming a real failure would go red.

## Status checks to require (owner action)

`specs / contracts / hygiene` and `workstream suites + inventory report` on
`develop` and `main`, plus one approving review, no self-merge. Command in
`docs/06-delivery/ci-baseline.md`.
