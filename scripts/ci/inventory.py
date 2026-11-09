#!/usr/bin/env python3
"""Workstream suite discovery and integration-report generator (stdlib only).

Anti-false-green rules enforced here:
- Every Node test FILE (*.test.js/.mjs/.cjs/.ts) under a present suite root
  is enumerated deterministically (sorted) and passed explicitly to
  `node --test`. Directory paths are never passed: on Node 24 a directory
  argument does not substitute for explicit test files and hides stderr.
- A present suite directory containing zero test files is PRESENT-EMPTY and
  fails the gate (fail closed once milestone code lands).
- Python suites assert exit 0, an `OK` verdict line, AND a minimum test count,
  so a silently-empty collection cannot pass.
- Suite roots that do not exist yet are UNCOVERED, never passing.
- The report's scope/gap text is generated from detected state; no hardcoded
  claims about which code exists.

Usage:
  inventory.py [--report PATH] [--prove-fail-closed]
"""
import json
import os
import re
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

# Suite roots whose test files are auto-discovered for node --test.
# packages/bridge-contracts is intentionally absent here: its contract is
# Python (generate.py --check + unittest suite, run explicitly below), so a
# Node entry would be a false PRESENT-EMPTY failure, not coverage.
NODE_ROOTS = [
    "packages/coordinator",
    "packages/scheduler",
    "packages/events",
    "services/orca-bridge",
    "apps/web",
]
NODE_TEST_GLOBS = ("*.test.js", "*.test.mjs", "*.test.cjs", "*.test.ts")

# Planned workstream dirs that do not exist yet: reported, never passing.
# packages/events graduated here when FF-006 landed tested envelope code;
# E18/coordinator ack requested on this entry (PR #37).
FUTURE_MODULES = [
    "packages/policy",
    "packages/messaging",
    "packages/context",
    "packages/telemetry",
]

# (label, argv, min_tests): argv runs with cwd=ROOT, must print unittest stats.
PYTHON_SUITES = [
    ("packages/bridge-contracts/tests",
     [sys.executable, "packages/bridge-contracts/tests/test_contract.py"], 32),
    ("apps/android/pwa-prototype/tests",
     [sys.executable, "-m", "unittest", "discover",
      "-s", "apps/android/pwa-prototype/tests", "-t", "."], 18),
    ("apps/android/play-internal/tests",
     [sys.executable, "-m", "unittest", "discover",
      "-s", "apps/android/play-internal/tests", "-t", "."], 8),
    ("apps/android/tests",
     [sys.executable, "apps/android/tests/test_android_packaging.py"], 7),
]

# Minimum tests per tests/test_*.py file; unlisted files floor at 1 so an
# empty-but-passing file cannot slip through when new test files land.
TESTS_DIR_FLOORS = {
    "test_ff009_crash_reconciliation.py": 5,
    "test_ci_suite_discovery.py": 15,
}
TESTS_DIR_DEFAULT_FLOOR = 1

STDERR_TAIL_LINES = 25


def run(cmd, **kwargs):
    return subprocess.run(cmd, capture_output=True, text=True, **kwargs)


def tail(text: str, n: int = STDERR_TAIL_LINES) -> str:
    lines = text.strip().splitlines()
    return "\n".join(lines[-n:])


def discover_node_files(root: str, base: Path = ROOT) -> list[str]:
    path = base / root
    found: list[str] = []
    for pattern in NODE_TEST_GLOBS:
        found.extend(str(p) for p in path.rglob(pattern) if p.is_file())
    return sorted(found)


def is_vitest_managed(root: str, base: Path = ROOT) -> bool:
    """True when this suite root owns its *.test.ts via Vitest.

    Vitest files look identical to node:test files by name, so the runner is
    decided by ownership evidence: a vitest config/workspace file, or a
    vitest entry in the root package.json devDependencies. Without such
    evidence (e.g. services/orca-bridge today) *.test.ts stays on node --test.
    """
    path = base / root
    if (not path.is_dir()
            or next(path.glob("vitest.config.*"), None) is not None
            or next(path.glob("vitest.workspace.*"), None) is not None):
        return path.is_dir()
    pkg = path / "package.json"
    if pkg.is_file():
        try:
            dev = json.loads(pkg.read_text(encoding="utf-8")).get(
                "devDependencies", {})
            if isinstance(dev, dict) and "vitest" in dev:
                return True
        except (json.JSONDecodeError, OSError):
            pass
    return False


def split_node_files(root: str, base: Path = ROOT) -> tuple[list, bool]:
    """Partition a suite's test files by runner.

    Returns (node_test_files, vitest_managed). When vitest_managed, *.test.ts
    files belong to `npm test` and must never be fed to bare `node --test`.
    """
    files = discover_node_files(root, base)
    if not is_vitest_managed(root, base):
        return files, False
    node_files = [f for f in files if not f.endswith(".test.ts")]
    return node_files, True


def node_verdict(returncode: int, output: str, nfiles: int = 0):
    """Verdict for one `node --test` invocation. Zero tests run is a FAIL."""
    if returncode != 0:
        return "FAIL", tail(output)
    match = re.search(r"[ℹ#] pass (\d+)", output)
    if match is None:
        return "FAIL", "unparseable node --test output (fail closed)\n" + tail(output)
    passed = int(match.group(1))
    if passed == 0:
        return "FAIL", f"zero tests executed across {nfiles} file(s) (fail closed)"
    return "PASS", f"{passed} tests pass across {nfiles} file(s)"


def run_vitest_suite(root: str, base: Path = ROOT):
    """Run a Vitest-managed suite via its own package runner.

    Installs dependencies (ci when a lockfile exists) then runs `npm test`.
    Exit 0 plus at least one passed test is required; anything else fails.
    """
    npm = shutil.which("npm")
    if npm is None:
        return "UNCOVERED", "npm not installed on runner"
    path = base / root
    lock = path / "package-lock.json"
    install = [npm, "ci", "--prefix", str(path)] if lock.is_file() else \
        [npm, "install", "--no-audit", "--no-fund", "--prefix", str(path)]
    proc = run(install, cwd=ROOT)
    if proc.returncode != 0:
        return "FAIL", "dependency install failed\n" + tail(proc.stdout + proc.stderr)
    proc = run([npm, "test", "--prefix", str(path)], cwd=ROOT)
    output = proc.stdout + proc.stderr
    if proc.returncode != 0:
        return "FAIL", tail(output)
    match = re.search(r"Tests\s+(\d+)\s+passed", output)
    if match is None:
        return "FAIL", "unrecognized vitest output (fail closed)\n" + tail(output)
    if int(match.group(1)) == 0:
        return "FAIL", "vitest ran zero tests (fail closed)"
    return "PASS", f"vitest: {match.group(1)} tests passed"


def node_suites(base: Path = ROOT) -> list[tuple[str, str, str]]:
    rows: list[tuple[str, str, str]] = []
    node = shutil.which("node")
    for root in NODE_ROOTS:
        path = base / root
        if not path.is_dir():
            rows.append((root, "ABSENT", "not on this branch; uncovered"))
            continue
        if node is None:
            rows.append((root, "UNCOVERED", "Node.js not installed on runner"))
            continue
        files, vitest = split_node_files(root, base)
        if vitest:
            status, detail = run_vitest_suite(root, base)
            rows.append((root, status, detail))
            continue
        if not files:
            rows.append((root, "PRESENT-EMPTY",
                         "dir exists but holds no *.test.{js,mjs,cjs,ts}; fail closed"))
            continue
        proc = run([node, "--test", *files], cwd=base)
        status, detail = node_verdict(proc.returncode,
                                      proc.stdout + proc.stderr, len(files))
        rows.append((root, status, detail))
    return rows


def parse_unittest_count(output: str) -> "int | None":
    match = re.search(r"^Ran (\d+) tests?", output, re.MULTILINE)
    return int(match.group(1)) if match else None


def unittest_verdict(output: str, returncode: int, minimum: int):
    """Verdict for one unittest run. Exit 0 + OK + count floor required."""
    count = parse_unittest_count(output)
    ok_line = re.search(r"^OK", output, re.MULTILINE) is not None
    if returncode == 0 and ok_line and count is not None and count >= minimum:
        return True, f"{count} tests OK (floor {minimum})"
    reason = (f"exit={returncode}, ok={ok_line}, "
              f"ran={count}, floor={minimum}")
    return False, reason + "\n" + tail(output)


def python_suites(base: Path = ROOT) -> list[tuple[str, str, str]]:
    rows: list[tuple[str, str, str]] = []
    for label, argv, minimum in PYTHON_SUITES:
        proc = run(argv, cwd=base)
        ok, detail = unittest_verdict(proc.stdout + proc.stderr,
                                      proc.returncode, minimum)
        rows.append((label, "PASS" if ok else "FAIL", detail))
    tests_dir = base / "tests"
    if tests_dir.is_dir():
        for case in sorted(tests_dir.glob("test_*.py")):
            minimum = TESTS_DIR_FLOORS.get(case.name, TESTS_DIR_DEFAULT_FLOOR)
            proc = run([sys.executable, str(case)], cwd=base)
            ok, detail = unittest_verdict(proc.stdout + proc.stderr,
                                          proc.returncode, minimum)
            rows.append((f"tests/{case.name}", "PASS" if ok else "FAIL", detail))
    else:
        rows.append(("tests/", "ABSENT", "directory not present; uncovered"))
    return rows


def module_row(root: str, base: Path = ROOT):
    """Status for a planned workstream dir: absent is UNCOVERED, but a
    present dir with no wired suite explicitly FAILS until tests are wired."""
    if not (base / root).is_dir():
        return "UNCOVERED", "planned workstream; no code on this branch"
    return ("FAIL", "UNWIRED: directory exists but no suite is wired; "
                    "wire its tests or remove the dir (fail closed)")


def future_modules(base: Path = ROOT) -> list[tuple[str, str, str]]:
    return [(root, *module_row(root, base)) for root in FUTURE_MODULES]


def check_specs() -> tuple[bool, str]:
    proc = run([sys.executable, str(ROOT / "scripts/check-specs.py")], cwd=ROOT)
    lines = (proc.stdout + proc.stderr).strip().splitlines()
    return proc.returncode == 0, lines[-1] if lines else ""


def prove_fail_closed() -> int:
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
        # Assembled at runtime so this script's own source never contains a
        # literal token-shaped string; the temp file still presents the full
        # token to the gate under test.
        fake = "ghp_" + "fAKet0ken0123456789abcdef"
        (tmp / "leak.txt").write_text(f"token = '{fake}'\n")

    def missing_contract(tmp: Path) -> None:
        (tmp / "examples").mkdir()

    gate("check_contracts.py", dup_openapi, "duplicated path/operationId")
    gate("check_hygiene.py", bad_token, "committed ghp_ token")
    gate("check_contracts.py", missing_contract, "missing contract + fixtures")

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

    # Node enumeration canary: a directory path must never stand in for files.
    with tempfile.TemporaryDirectory() as tmp:
        suite = Path(tmp) / "suite"
        (suite / "tests").mkdir(parents=True)
        (suite / "tests" / "a.test.js").write_text(
            "const t = require('node:test');\n"
            "t.test('x', () => {});\n"
        )
        node = shutil.which("node")
        if node is not None:
            by_dir = run([node, "--test", str(suite / "tests")], cwd=ROOT)
            by_file = run([node, "--test", str(suite / "tests" / "a.test.js")],
                          cwd=ROOT)
            if by_file.returncode != 0:
                failures.append("node --test cannot run an explicit test file")
            else:
                print("  canary ok: explicit file enumeration runs the test")
                print(f"  note: directory-path invocation exits {by_dir.returncode} "
                      f"(this is why CI enumerates files, never dirs)")
        else:
            print("  note: node unavailable; enumeration canary skipped")

    if failures:
        print("Fail-closed proof FAILED:")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print("OK: fail-closed proof holds (gates reject canaries)")
    return 0


def build_report() -> tuple[str, bool]:
    missing = [r for r in REQUIRED if not (ROOT / r).exists()]
    ok_specs, specs_detail = check_specs()
    rows = node_suites() + python_suites() + future_modules()

    failing = [r for r, s, _ in rows if s in ("FAIL", "PRESENT-EMPTY")]
    uncovered = [r for r, s, _ in rows if s in ("ABSENT", "UNCOVERED", "PRESENT-UNWIRED")]
    scope = ("FULL" if not missing and ok_specs and not failing and not uncovered
             else "PARTIAL (fail-closed: present suites must pass; "
                  "absent modules uncovered, not passing)")

    lines = [
        "# FF-030 CI integration report",
        "",
        "Generated by `scripts/ci/inventory.py` from detected tree state.",
        "",
        "## Scope",
        "",
        f"SCOPE: {scope} — "
        f"{len(failing)} failing/empty, {len(uncovered)} uncovered.",
        "",
        "## Required baseline",
        "",
        f"- spec link check (`scripts/check-specs.py`): "
        f"{'PASS' if ok_specs else 'FAIL'} — {specs_detail}",
        f"- required paths present: {'yes' if not missing else 'NO: ' + ', '.join(missing)}",
        "",
        "## Suites",
        "",
        "| Workstream / path | Status | Detail |",
        "|---|---|---|",
    ]
    for rel, status, detail in rows:
        one_line = " ".join(detail.splitlines()[:3])
        lines.append(f"| {rel} | {status} | {one_line} |")
    lines += [
        "",
        "## Gaps (detected, not asserted)",
        "",
    ]
    if uncovered:
        lines.append("- Uncovered (no code yet, not counted as passing): "
                     + ", ".join(f"`{r}`" for r in uncovered) + ".")
    if failing:
        lines.append("- Failing or present-but-empty (must be repaired): "
                     + ", ".join(f"`{r}`" for r in failing) + ".")
    if not uncovered and not failing:
        lines.append("- None: every known suite present and passing.")
    lines += [
        "- CI runs fake adapters/disposable environments only; no deployment, "
        "no Orca worker starts, no service restarts.",
    ]
    success = not missing and ok_specs and not failing
    return "\n".join(lines) + "\n", success


def main(argv: list[str]) -> int:
    if "--prove-fail-closed" in argv:
        return prove_fail_closed()
    report, success = build_report()
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
