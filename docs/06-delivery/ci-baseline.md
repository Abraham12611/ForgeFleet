# CI baseline runbook (FF-030, repaired after develop run 42601950447)

Real, non-deploying GitHub Actions enforcement. Replaces self-reported
fixture/unit results with independently executed checks. Repair history:
PR #62 established the bootstrap; the first develop run failed on manifest
drift plus a directory-path `node --test` invocation bug; this revision
(Ff-030 repair) fixes both and wires the landed v0.1 suites.

## Workflow

`.github/workflows/ci.yml` (`ci-baseline`), triggers `pull_request` and
`push: develop`. Node `24.x`, Python `3.12`. All jobs declare
`permissions: contents: read`, reference no secrets, and perform no
deployment, no Orca worker starts, and no service restarts.

| Job | Step | Fails the check when |
|---|---|---|
| specs / contracts / hygiene | `scripts/check-specs.py` | any broken local doc link |
| | `scripts/ci/check_manifest.py` | baselined file edited without a manifest update, or listed file missing |
| | `scripts/ci/check_contracts.py` | fixture unparseable / missing keys, duplicated path / operationId / schema, unresolvable `$ref` |
| | `generate.py --check` (E05) | generated bridge consumers stale vs frozen schemas |
| | `check_hygiene.py` | likely credential/key in tracked files; `.env` / `secrets/` / `private-context/` committed |
| | `inventory.py --prove-fail-closed` | any gate fails to reject its canary |
| | CODEOWNERS coverage | `.github/CODEOWNERS` missing or not requiring `@Abraham12611` on `*` |
| workstream suites + inventory report | `inventory.py --report ci-report.md` | any present suite fails; any required baseline path missing; any present-but-empty suite dir (fail closed) |
| | Web Vite (conditional) | `apps/web/package.json` present and install/build/test fails |
| | Play negative gate | placeholder bundle does not exit blocked (`1`) |
| | uploads `ci-report.md` artifact | — |

## Suite discovery (the directory-path lesson)

`inventory.py` enumerates `*.test.{js,mjs,cjs,ts}` files deterministically
(sorted) under each present suite root and passes explicit file lists to
`node --test`. Directory paths are never passed: on Node 24 a directory
argument does not substitute for explicit test files and hides the real
stderr (this caused the false `FAIL 'test failed'` rows on the first develop
run while the suites themselves pass: coordinator 19, scheduler 30,
orca-bridge 27, web 23). Failures print a bounded stderr tail (25 lines).

## Runner separation (node:test vs Vitest)

`*.test.ts` files look identical under both runners, so the runner is decided
per suite root by ownership evidence: a `vitest.config.*` /
`vitest.workspace.*` file, or a `vitest` entry in that root's
`package.json` devDependencies, routes the suite's `.test.ts` files to
`npm install` (or `npm ci` with a lockfile) plus `npm test`. Those files are
never fed to bare `node --test`. Without such evidence (e.g.
`services/orca-bridge` today, whose `.test.ts` files import `node:test`),
`.test.ts` stays on `node --test`. The routing is covered by maintained
tests in `tests/test_ci_suite_discovery.py`.

## Zero-test and unwired guards

- Any executed suite reporting zero tests fails: node side requires
  `pass >= 1` in the `node --test` summary; Python suites require exit 0, an
  `OK` verdict, and a per-suite minimum count (bridge-contracts 32,
  PWA 18, Play gate 8, Android packaging 7, `tests/test_*.py` files each
  floored, default 1).
- A present suite dir with no wired suite explicitly FAILs (`UNWIRED`)
  until its tests are wired — existing code is never green-uncovered.
  Absent future modules stay `UNCOVERED`, never passing.

## Watch items (wire when they land)

- Dedicated E05 generator tests beyond the freeze-sync coverage in
  `test_contract.py`; integration-server test suites under
  `services/orca-bridge`. Both become required checks on arrival, not
  silent additions.

## Anti-false-green rule

Absent suite roots are `UNCOVERED`, never passing. A present suite dir with
zero test files is `PRESENT-EMPTY` and fails. A green run with uncovered
modules reports `SCOPE: PARTIAL`, never full integration. `inventory.py`
exits nonzero if any required baseline path (`docs/`, `SPEC-MANIFEST.json`,
`scripts/check-specs.py`, bridge OpenAPI, `examples/`) disappears.

## Standing in for not-yet-existing suites

- `packages/{policy,messaging,context,telemetry,events}`: no code yet,
  listed UNCOVERED by detection, not by hardcoded text.
- Web Vite build: active only when `apps/web/package.json` lands; the
  existing `inbox-policy.test.mjs` already runs via inventory.
- PWA count note: E20 documented 19 tests but the committed prototype suite
  defines 18; CI gates on exit-0 plus floor 18 and reports the count. E20 can
  raise the floor when the 19th test lands.

## Manifest policy

`SPEC-MANIFEST.json` pins reviewed scaffold bytes. Update an entry only when
its owning PR intentionally changed that file, and name the PR (repair
precedent: `bridge.openapi.yaml` via FF-003/#46, `version-pins.md` via
FF-001/#31). Never mass-regenerate to silence drift; never disable the gate.

## CODEOWNERS and branch protection (repository owner action)

`.github/CODEOWNERS` sets `* @Abraham12611`; CI verifies the file requires
owner review on every path, but the file alone enforces nothing. Targeted
enforcement the owner must configure: required PR review with
code-owner approval, the two `ci-baseline` status checks pinned to the fresh
head SHA (strict checks — a stale green never merges), no bypass list
entries for any engineer identity including `ImisiDahunsi4`, no direct pushes
to `develop`/`main`, and coordinator-only merge with `main` additionally
requiring owner authorization per #64. Branch rulesets cannot be set by the
connector — the owner must apply them; until then CI is advisory, not an
enforcement boundary. Do not claim protection is enabled until the settings
show it.

Recommended owner commands (replace checks if job names change):

```sh
gh api repos/Abraham12611/ForgeFleet/rulesets -X POST \
  -F name='develop-main-protection' -F target='branch' \
  -F enforcement='active' \
  -F 'conditions[ref_name][include][]=refs/heads/develop' \
  -F 'conditions[ref_name][include][]=refs/heads/main' \
  -F 'rules[][type]=pull_request' \
  -F 'rules[][parameters][required_approving_review_count]=1' \
  -F 'rules[][parameters][require_code_owner_review]=true' \
  -F 'rules[][type]=required_status_checks' \
  -F 'rules[][parameters][strict_required_status_checks_policy]=true' \
  -F 'rules[][parameters][required_status_checks][][context]=specs / contracts / hygiene' \
  -F 'rules[][parameters][required_status_checks][][context]=workstream suites + inventory report'
```

No direct pushes to `develop`/`main`, no auto-merge, no bypass for
`ImisiDahunsi4`; `main` additionally requires owner authorization per #64.

## Coordinator use

A red check blocks merge per the quality plan. A green `PARTIAL` run means
"baseline intact, listed modules uncovered" — merge decisions must consult
`ci-report.md` per package, not the green tick alone.
