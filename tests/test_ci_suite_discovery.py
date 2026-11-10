"""Maintained tests for FF-030 CI suite discovery (stdlib unittest only).

Exercises scripts/ci/inventory.py classification and verdict logic against
synthetic trees: deterministic file enumeration, Vitest-managed suites never
fed to bare node --test, zero-test runs fail, present-but-unwired dirs fail.

Run:  python3 tests/test_ci_suite_discovery.py   (from repo root)
"""
import importlib.util
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

CI_DIR = Path(__file__).resolve().parent.parent / "scripts" / "ci"

spec = importlib.util.spec_from_file_location(
    "ci_inventory", CI_DIR / "inventory.py"
)
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)


def make_tree(files: dict) -> Path:
    tmp = Path(tempfile.mkdtemp())
    for rel, content in files.items():
        path = tmp / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    return tmp


NODE_TEST = (
    "const t = require('node:test');\n"
    "t.test('x', () => {});\n"
)

NODE_TEST_MJS_PASS = (
    "import test from 'node:test';\n"
    "test('ok', () => {});\n"
)

NODE_TEST_MJS_FAIL = (
    "import test from 'node:test';\n"
    "test('canary boom', () => { "
    "throw new Error('mixed-runner canary failure'); });\n"
)

MIXED_TREE_PASS = {
    "mixed/vitest.config.js": "export default {};\n",
    "mixed/src/a.test.ts": "import { test } from 'vitest';\n",
    "mixed/src/b.test.mjs": NODE_TEST_MJS_PASS,
}

MIXED_TREE_FAIL = {
    "mixed/vitest.config.js": "export default {};\n",
    "mixed/src/a.test.ts": "import { test } from 'vitest';\n",
    "mixed/src/b.test.mjs": NODE_TEST_MJS_FAIL,
}


def run_mixed_suites(base, vitest_result):
    """Run node_suites() against a single synthetic 'mixed' root with a
    stubbed Vitest side; the node side always executes for real."""
    with mock.patch.object(inventory, "NODE_ROOTS", ["mixed"]), \
         mock.patch.object(inventory, "run_vitest_suite",
                           return_value=vitest_result):
        return inventory.node_suites(base)


class TestDeterministicEnumeration(unittest.TestCase):
    def test_files_sorted_and_complete(self):
        base = make_tree({
            "suite/tests/b.test.js": NODE_TEST,
            "suite/test/a.test.mjs": NODE_TEST,
            "suite/src/z.test.ts": NODE_TEST,
            "suite/src/index.js": "module.exports = {};\n",
            "suite/README.md": "docs\n",
        })
        found = inventory.discover_node_files("suite", base)
        self.assertEqual(
            found,
            sorted([
                str(base / "suite/src/z.test.ts"),
                str(base / "suite/test/a.test.mjs"),
                str(base / "suite/tests/b.test.js"),
            ]),
        )

    def test_non_test_files_excluded(self):
        base = make_tree({"suite/src/index.js": "x\n"})
        self.assertEqual(inventory.discover_node_files("suite", base), [])


class TestVitestRouting(unittest.TestCase):
    def test_vitest_config_marks_managed(self):
        base = make_tree({
            "web/vitest.config.ts": "export default {};\n",
            "web/src/a.test.ts": "import { test } from 'vitest';\n",
        })
        self.assertTrue(inventory.is_vitest_managed("web", base))

    def test_vitest_dependency_marks_managed(self):
        base = make_tree({
            "web/package.json": '{"devDependencies": {"vitest": "^3.0.0"}}',
            "web/src/a.test.ts": "import { test } from 'vitest';\n",
        })
        self.assertTrue(inventory.is_vitest_managed("web", base))

    def test_node_test_style_ts_not_vitest(self):
        base = make_tree({
            "rt/src/d.test.ts": "import { test } from 'node:test';\n",
        })
        self.assertFalse(inventory.is_vitest_managed("rt", base))

    def test_vitest_files_excluded_from_node_list(self):
        base = make_tree({
            "web/vitest.config.ts": "export default {};\n",
            "web/src/a.test.ts": "import { test } from 'vitest';\n",
            "web/src/b.test.mjs": NODE_TEST,
        })
        node_files, vitest = inventory.split_node_files("web", base)
        self.assertTrue(vitest)
        self.assertEqual(node_files, [str(base / "web/src/b.test.mjs")])


class TestVerdicts(unittest.TestCase):
    def test_zero_node_tests_fail(self):
        status, _ = inventory.node_verdict(
            0, "ℹ tests 0\nℹ pass 0\nℹ fail 0\n"
        )
        self.assertEqual(status, "FAIL")

    def test_unparseable_node_output_fails(self):
        status, _ = inventory.node_verdict(0, "some unexpected output\n")
        self.assertEqual(status, "FAIL")

    def test_passing_node_output_passes(self):
        status, detail = inventory.node_verdict(
            0, "ℹ tests 3\nℹ pass 3\nℹ fail 0\n", nfiles=2
        )
        self.assertEqual(status, "PASS")
        self.assertIn("3", detail)

    def test_failing_node_output_fails_with_tail(self):
        status, detail = inventory.node_verdict(
            1, "line1\nline2\nnot ok 1 boom\n"
        )
        self.assertEqual(status, "FAIL")
        self.assertIn("boom", detail)

    def test_unittest_floor_rejects_empty(self):
        ok, _ = inventory.unittest_verdict("Ran 0 tests in 0.0s\n\nOK\n", 0, 1)
        self.assertFalse(ok)

    def test_unittest_floor_rejects_short(self):
        ok, _ = inventory.unittest_verdict("Ran 17 tests\n\nOK\n", 0, 18)
        self.assertFalse(ok)

    def test_unittest_floor_accepts(self):
        ok, detail = inventory.unittest_verdict("Ran 18 tests\n\nOK\n", 0, 18)
        self.assertTrue(ok)
        self.assertIn("18", detail)

    def test_unwired_present_dir_fails(self):
        base = make_tree({"packages/policy/README.md": "plan\n"})
        status, detail = inventory.module_row("packages/policy", base)
        self.assertEqual(status, "FAIL")
        self.assertIn("UNWIRED", detail)

    def test_absent_dir_uncovered_not_failing(self):
        base = make_tree({"other/f.txt": "x\n"})
        status, _ = inventory.module_row("packages/policy", base)
        self.assertEqual(status, "UNCOVERED")


@unittest.skipUnless(shutil.which("node"), "node --test required")
class TestMixedRunnerRoots(unittest.TestCase):
    """A Vitest-managed root must run BOTH runners: `npm test` for the
    Vitest-owned *.test.ts files AND `node --test` for the remaining
    *.test.js/.mjs/.cjs files. Either side failing fails the row."""

    def test_failing_node_test_fails_despite_vitest_pass(self):
        base = make_tree(MIXED_TREE_FAIL)
        rows = run_mixed_suites(base, ("PASS", "stubbed vitest pass"))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][0], "mixed")
        self.assertEqual(rows[0][1], "FAIL")
        self.assertIn("vitest:", rows[0][2])
        self.assertIn("node:", rows[0][2])
        self.assertIn("canary", rows[0][2])

    def test_failing_vitest_fails_despite_node_pass(self):
        base = make_tree(MIXED_TREE_PASS)
        rows = run_mixed_suites(base, ("FAIL", "stubbed vitest failure"))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][1], "FAIL")

    def test_both_passing_passes(self):
        base = make_tree(MIXED_TREE_PASS)
        rows = run_mixed_suites(base, ("PASS", "stubbed vitest pass"))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][1], "PASS")
        self.assertIn("vitest:", rows[0][2])
        self.assertIn("node:", rows[0][2])

    def test_vitest_only_root_mirrors_vitest_verdict(self):
        base = make_tree({
            "mixed/vitest.config.js": "export default {};\n",
            "mixed/src/a.test.ts": "import { test } from 'vitest';\n",
        })
        rows = run_mixed_suites(base, ("PASS", "stubbed vitest pass"))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][1], "PASS")


class TestContextWired(unittest.TestCase):
    """FF-011 must stay wired: packages/context ships tested code, so it
    belongs in NODE_ROOTS (executed) and not in FUTURE_MODULES (unwired).
    Either side drifting reintroduces present-but-unwired green CI."""

    def test_context_in_node_roots(self):
        self.assertIn("packages/context", inventory.NODE_ROOTS)

    def test_context_not_in_future_modules(self):
        self.assertNotIn("packages/context", inventory.FUTURE_MODULES)


class TestVitestFailClosed(unittest.TestCase):
    def test_npm_missing_fails_not_uncovered(self):
        base = make_tree({
            "web/vitest.config.js": "export default {};\n",
            "web/src/a.test.ts": "import { test } from 'vitest';\n",
        })
        real_which = shutil.which
        with mock.patch.object(
                inventory.shutil, "which",
                side_effect=lambda name: None if name == "npm"
                else real_which(name)):
            status, detail = inventory.run_vitest_suite("web", base)
        self.assertEqual(status, "FAIL")
        self.assertIn("npm", detail)

    def test_missing_lockfile_refuses_install(self):
        base = make_tree({
            "web/vitest.config.js": "export default {};\n",
            "web/package.json": '{"devDependencies": {"vitest": "^3.0.0"}}',
            "web/src/a.test.ts": "import { test } from 'vitest';\n",
        })
        real_which = shutil.which
        calls: list = []

        def fake_run(cmd, **kwargs):
            calls.append(cmd)
            raise AssertionError("must not shell out without a lockfile")

        with mock.patch.object(
                inventory.shutil, "which",
                side_effect=lambda name: "/fake/npm" if name == "npm"
                else real_which(name)), \
             mock.patch.object(inventory, "run", side_effect=fake_run):
            status, detail = inventory.run_vitest_suite("web", base)
        self.assertEqual(status, "FAIL")
        self.assertEqual(calls, [])
        self.assertIn("package-lock", detail)


if __name__ == "__main__":
    unittest.main()
