#!/usr/bin/env python3
"""Workstream inventory and integration-report generator (stdlib only).

Prevents false-green CI: every workstream suite the FF-030 issue names is
either PRESENT (and executed) or explicitly recorded as ABSENT/UNCOVERED.
A passing run at bootstrap stage therefore reports `SCOPE: PARTIAL`, never
full integration.

Required paths (missing => exit 1):
  docs/, SPEC-MANIFEST.json, scripts/check-specs.py,
  docs/05-contracts/bridge.openapi.yaml, examples/

Optional suites (missing => recorded as uncovered, exit still 0):
  packages/bridge-contracts contract generator --check (E05)
  Node node:test suites: packages/{policy,scheduler,messaging,coordinator},
    services/orca-bridge/src/runtime (E07-E10, E02-E04)
  Python fixtures: tests/test_*.py (E15)
  Web Vite install/build/test: apps/web (E12)

Usage:
  inventory.py [--report PATH] [--prove-fail-closed]
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
CI_DIR = ROOT / "scripts" / "ci"

REQUIRED = [
    "docs",
    "SPEC-MANIFEST.json",
    "scripts/check-specs.py",
    "docs/05-contracts/bridge.openapi.yaml",
    "examples",
]

# (workstream, relative path, suite description)
OPTIONAL_SUITES = [
    ("E05 contracts", "packages/bridge-contracts", "contract generator --check + tests"),
    ("E07 policy", "packages/policy", "node:test suite"),
    ("E08 coordinator", "packages/coordinator", "node:test suite"),
    ("E09 scheduler", "packages/scheduler", "node:test suite"),
    ("E10 messaging", "packages/messaging", "node:test suite"),
    ("E02/E03 runtime", "services/orca-bridge/src/runtime", "node:test suite"),
    ("E15 fixtures", "tests", "Python fixture suite"),
    ("E12 web", "apps/web", "Vite install/build/test"),
]

NODE_SUITE_DIRS = [
    "packages/policy",
    "packages/coordinator",
    "packages/scheduler",
    "packages/messaging",
    "services/orca-bridge/src/runtime",
]


def run(cmd, **kwargs):
    return subprocess.run(cmd, capture_output=True, text=True, **kwargs)


def check_specs():
    proc = run([sys.executable, str(ROOT / "scripts/check-specs.py")], cwd=ROOT)
    return proc.returncode == 0, (proc.stdout + proc.stderr).strip().splitlines()[-1]


def node_suites():
    """Run node:test for each present Node suite dir; return row list."""
    rows = []
    node = shutil.which("node")
    for rel in NODE_SUITE_DIRS:
        path = ROOT / rel
        if not path.is_dir():
            rows.append((rel, "ABSENT", "directory not present; uncovered"))
            continue
        if node is None:
            rows.append((rel, "UNCOVERED", "Node.js not installed on runner"))
            continue
        test_dirs = [d for d in ("test", "tests", "__tests__") if (path / d).is_dir()]
        test_files = list(path.glob("*.test.js")) + list(path.glob("*.test.mjs"))
        if not test_dirs and not test_files:
            rows.append((rel, "PRESENT-NO-TESTS", "dir exists but holds no tests"))
            continue
        targets = [str(path / d) for d in test_dirs] + [str(f) for f in test_files]
        proc = run(["node", "--test", *targets], cwd=ROOT)
        status = "PASS" if proc.returncode == 0 else "FAIL"
        tail = (proc.stdout + proc.stderr).strip().splitlines()[-1:]
        rows.append((rel, status, "; ".join(tail)))
    return rows


def python_fixtures():
    tests_dir = ROOT / "tests"
    if not tests_dir.is_dir():
        return [("tests/", "ABSENT", "directory not present; uncovered")]
    cases = sorted(tests_dir.glob("test_*.py"))
    if not cases:
        return [("tests/", "PRESENT-NO-TESTS", "dir exists but holds no test_*.py")]
    rows = []
    for case in cases:
        proc = run([sys.executable, str(case)], cwd=ROOT)
        tail = (proc.stdout + proc.stderr).strip().splitlines()[-1:]
        rows.append((
            f"tests/{case.name}",
            "PASS" if proc.returncode == 0 else "FAIL",
            "; ".join(tail),
        ))
    return rows


def prove_fail_closed() -> int:
    """Prove each gate can actually fail (canary trees, never the real tree)."""
    failures: list[str] = []

    def gate(script: str, build, expect: str) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            build(Path(tmp))
            env = dict(os.environ, FF_CI_ROOT=tmp)
            proc = run([sys.executable, str(CI_DIR / script)], cwd=ROOT, env=env)
            if proc.returncode == 0:
                failures.append(f"{script}: canary {expect} did NOT fail (exit 0)")
            else:
                print(f"  canary ok: {script} rejects {expect}")

    def dup_openapi(tmp: Path) -> None:
        (tmp / "examples").mkdir()
        (tmp / "examples" / "bridge-event.example.json").write_text("{}")
        (tmp / "examples" / "task-graph.example.json").write_text("{}")
        (tmp / "examples" / "context-manifest.example.json").write_text("{}")
        (tmp / "docs" / "05-contracts").mkdir(parents=True)
        (tmp / "docs" / "05-contracts" / "bridge.openapi.yaml").write_text(
            "openapi: 3.1.0\npaths:\n  /v1/a:\n    get:\n"
            "      operationId: sameId\n      responses: {}\n"
            "  /v1/a:\n    get:\n"
            "      operationId: sameId\n      responses: {}\n"
            "components:\n  schemas:\n    Thing:\n      type: object\n"
        )

    def bad_token(tmp: Path) -> None:
        (tmp / "leak.txt").write_text("token = 'ghp_fAKet0ken0123456789abcdef'\n")

    def missing_contract(tmp: Path) -> None:
        (tmp / "examples").mkdir()

    gate("check_contracts.py", dup_openapi, "duplicated path/operationId")
    gate("check_hygiene.py", bad_token, "committed ghp_ token")
    gate("check_contracts.py", missing_contract, "missing contract + fixtures")

    # And the positive control: a fully valid tree passes both gates.
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "examples").mkdir()
        fixtures = {
            "bridge-event.example.json": {
                "eventId": "e1",
                "schemaVersion": "0.1",
                "eventType": "attempt.completed",
                "occurredAt": "2026-11-09T00:00:00Z",
                "projectId": "p1",
                "taskId": "t1",
                "attemptId": "a1",
                "correlationId": "c1",
                "fencingEpoch": 1,
            },
            "task-graph.example.json": {
                "goal": "g",
                "planRevision": 1,
                "tasks": [],
            },
            "context-manifest.example.json": {
                "projectId": "p1",
                "revision": 1,
                "sources": [],
                "taskBindings": [],
            },
        }
        for name, data in fixtures.items():
            (root / "examples" / name).write_text(json.dumps(data))
        (root / "docs" / "05-contracts").mkdir(parents=True)
        (root / "docs" / "05-contracts" / "bridge.openapi.yaml").write_text(
            "openapi: 3.1.0\npaths:\n  /v1/a:\n    get:\n"
            "      operationId: oneId\n      responses: {}\n"
            "components:\n  schemas:\n    Thing:\n      type: object\n"
        )
        (root / "clean.txt").write_text("no secrets here\n")
        env = dict(os.environ, FF_CI_ROOT=tmp)
        for script in ("check_contracts.py", "check_hygiene.py"):
            proc = run([sys.executable, str(CI_DIR / script)], cwd=ROOT, env=env)
            if proc.returncode != 0:
                failures.append(f"{script}: valid tree unexpectedly failed")
            else:
                print(f"  control ok: {script} passes on valid tree")

    if failures:
        print("Fail-closed proof FAILED:")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print("OK: fail-closed proof holds (gates reject canaries)")
    return 0


def build_report(extra_rows: list[tuple[str, str, str]]) -> tuple[str, bool]:
    missing = [r for r in REQUIRED if not (ROOT / r).exists()]
    ok_specs, specs_detail = check_specs()
    node_rows = node_suites()
    py_rows = python_fixtures()

    web_dir = ROOT / "apps/web"
    if not web_dir.is_dir():
        web_rows = [("apps/web", "ABSENT", "no web app yet; Vite suite uncovered")]
    else:
        web_rows = [("apps/web", "PRESENT", "see CI web job for install/build/test")]

    gen = ROOT / "packages/bridge-contracts"
    if not gen.is_dir():
        gen_rows = [
            ("packages/bridge-contracts", "ABSENT",
             "v0.1 generator --check unavailable; contract YAML gate only")
        ]
    else:
        gen_rows = [("packages/bridge-contracts", "PRESENT", "see CI specs job")]

    lines = [
        "# FF-030 CI integration report",
        "",
        "Generated by `scripts/ci/inventory.py`. Absent suites are UNCOVERED, "
        "not passing: this report is the anti-false-green record.",
        "",
        "## Scope",
        "",
    ]
    absent = (
        sum(1 for _, s, _ in node_rows if s in ("ABSENT", "UNCOVERED", "PRESENT-NO-TESTS"))
        + sum(1 for _, s, _ in py_rows if s != "PASS")
        + (1 if web_dir.is_dir() is False else 0)
        + (1 if gen.is_dir() is False else 0)
    )
    scope = "PARTIAL (bootstrap: specs-only tree)" if absent else "FULL"
    lines.append(f"SCOPE: {scope} — {absent} suite(s) uncovered or absent.")
    lines += [
        "",
        "## Required baseline",
        "",
        f"- spec link check (`scripts/check-specs.py`): {'PASS' if ok_specs else 'FAIL'} — {specs_detail}",
        f"- required paths present: {'yes' if not missing else 'NO: ' + ', '.join(missing)}",
        "",
        "## Suites",
        "",
        "| Workstream / path | Status | Detail |",
        "|---|---|---|",
    ]
    for rel, status, detail in gen_rows + node_rows + py_rows + web_rows + extra_rows:
        lines.append(f"| {rel} | {status} | {detail} |")
    lines += [
        "",
        "## Known gaps (not failures)",
        "",
        "- No `packages/*`, `services/*`, `apps/*`, or `tests/` code exists yet; "
        "all runtime/policy/planner/scheduler/messaging suites are uncovered by construction.",
        "- v0.1 contract generator `--check` does not exist yet (E05 Wave 0); "
        "YAML structural gate stands in.",
        "- Web Vite suite has no app to build yet (E12 fixtures-only stage).",
        "- CI runs fake adapters/disposable environments only; no deployment, "
        "no Orca worker starts, no service restarts.",
    ]
    success = not missing and ok_specs and all(
        s == "PASS" for _, s, _ in py_rows if s not in ("ABSENT", "PRESENT-NO-TESTS")
    ) and all(s == "PASS" for _, s, _ in node_rows if s not in ("ABSENT", "UNCOVERED", "PRESENT-NO-TESTS"))
    return "\n".join(lines) + "\n", success


def main(argv: list[str]) -> int:
    if "--prove-fail-closed" in argv:
        return prove_fail_closed()
    report, success = build_report([])
    print(report)
    if "--report" in argv:
        out = argv[argv.index("--report") + 1]
        Path(out).write_text(report, encoding="utf-8")
        print(f"Wrote {out}")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as fh:
            fh.write(report)
    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
