# CI baseline (FF-030)

Real GitHub Actions enforcement for the specs-only bootstrap stage. Replaces
self-reported fixture/unit results with independently executed checks.

## Workflow

`.github/workflows/ci.yml` (`ci-baseline`), triggers `pull_request` and
`push: develop`. Node `24.x`, Python `3.12`. All jobs declare
`permissions: contents: read`, reference no secrets, and perform no
deployment, no Orca worker starts, and no service restarts.

| Job | What runs | Fails the check when |
|---|---|---|
| specs / contracts / hygiene | `scripts/check-specs.py` (doc link integrity) | any broken local link |
| | `scripts/ci/check_manifest.py` | baselined file edited without manifest update, or listed file missing |
| | `scripts/ci/check_contracts.py` | fixture unparseable / missing keys, duplicated path / operationId / schema, unresolvable `$ref` |
| | `scripts/ci/check_hygiene.py` | likely credential or private key in tracked files; `.env` / `secrets/` / `private-context/` committed |
| | `inventory.py --prove-fail-closed` | any gate fails to reject its canary |
| workstream suites + inventory report | `inventory.py --report ci-report.md` (Node `node:test` for present suite dirs, Python `tests/test_*.py` if present) | required baseline path missing; any *present* suite fails |
| | Web Vite suite if `apps/web/package.json` exists | install / build / test failure |
| | uploads `ci-report.md` artifact | — |

## Anti-false-green rule

Absent suite directories are recorded as `ABSENT / uncovered` in
`ci-report.md` and the step summary, never as passes. A green run on the
current tree reports `SCOPE: PARTIAL (bootstrap: specs-only tree)`. Claiming
full integration from this workflow is a defect; `inventory.py` exits nonzero
if any required baseline path (`docs/`, `SPEC-MANIFEST.json`,
`scripts/check-specs.py`, bridge OpenAPI, `examples/`) disappears.

## Standing in for not-yet-existing suites

- v0.1 contract generator `--check` (E05, Wave 0): YAML structural gate
  (`check_contracts.py`) until the generator lands; then wire its real
  `--check` into the specs job.
- `runtime` / `policy` / `planner` / `scheduler` / `messaging` `node:test`
  suites: `inventory.py` runs them the moment their directories contain
  tests; until then they are listed uncovered.
- Web Vite: conditional step activates on `apps/web/package.json`.

## Required status checks (repository owner action)

Agents cannot change branch protection. The owner should require, on
`develop` and `main`, the checks `specs / contracts / hygiene` and
`workstream suites + inventory report`, plus human/coordinator review, with no
self-merge. Recommended `gh` (owner runs):

```sh
gh api repos/Abraham12611/ForgeFleet/branches/develop/protection \
  -X PUT -F required_status_checks[strict]=true \
  -F required_status_checks[checks][][context]='specs / contracts / hygiene' \
  -F required_status_checks[checks][][context]='workstream suites + inventory report' \
  -F enforce_admins=true \
  -F required_pull_request_reviews[required_approving_review_count]=1
```

## Coordinator use

A red check blocks merge per the quality plan. A green `PARTIAL` run means
"baseline intact, workstream X still uncovered" — merge decisions for the
pending engineering PRs must consult `ci-report.md` per package, not the
green tick alone.
