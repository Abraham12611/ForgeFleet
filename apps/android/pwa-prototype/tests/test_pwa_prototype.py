"""FF-019 fixture-prototype checks (standard library only).

Run: python3 -m unittest discover -s apps/android/pwa-prototype/tests -t . -v
"""
import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
CSS = (ROOT / "styles.css").read_text(encoding="utf-8")
JS = (ROOT / "app.js").read_text(encoding="utf-8")
SW = (ROOT / "sw.js").read_text(encoding="utf-8")
FX = json.loads((ROOT / "fixtures.json").read_text(encoding="utf-8"))
MANIFEST = json.loads((ROOT / "manifest.webmanifest").read_text(encoding="utf-8"))


class ManifestTest(unittest.TestCase):
    def test_required_pwa_fields(self):
        for field in ("name", "start_url", "scope", "display", "icons"):
            self.assertIn(field, MANIFEST, field)
        self.assertEqual(MANIFEST["display"], "standalone")

    def test_icons_exist_and_are_png(self):
        self.assertTrue(MANIFEST["icons"], "manifest has no icons")
        for icon in MANIFEST["icons"]:
            p = ROOT / icon["src"]
            self.assertTrue(p.is_file(), f"missing icon {icon['src']}")
            self.assertEqual(p.read_bytes()[:8], b"\x89PNG\r\n\x1a\n", f"{p.name} is not a PNG")
        sizes = {i["sizes"] for i in MANIFEST["icons"]}
        self.assertIn("192x192", sizes)
        self.assertIn("512x512", sizes)


class HtmlShellTest(unittest.TestCase):
    def test_viewport_and_pwa_links(self):
        self.assertIn('name="viewport"', HTML)
        self.assertIn("width=device-width", HTML)
        self.assertIn('rel="manifest"', HTML)
        self.assertIn('name="theme-color"', HTML)

    def test_fixture_badge_and_five_tabs(self):
        self.assertIn("FIXTURE", HTML)
        tabs = re.findall(r'data-tab="(\w+)"', HTML)
        self.assertEqual(tabs, ["home", "projects", "inbox", "fleet", "more"])

    def test_cards_not_tables(self):
        body = HTML.split("<body", 1)[1]
        self.assertNotIn("<table", body.lower())

    def test_single_script_entry(self):
        self.assertIn('src="app.js"', HTML)
        self.assertIn("<noscript>", HTML)


class CssSafetyTest(unittest.TestCase):
    def test_no_fixed_widths_at_or_above_360(self):
        # Bare `width: Npx` with N >= 360 forces overflow; max-width does not.
        bad = re.findall(r"(?<![-\w])width\s*:\s*(\d+)\s*px", CSS)
        too_wide = [w for w in bad if int(w) >= 360]
        self.assertEqual(too_wide, [], f"fixed widths that force 360px overflow: {too_wide}")
        # `min-width` >= 360px is only safe as a media-query gate, never on an element.
        for i, line in enumerate(CSS.splitlines()):
            for m in re.finditer(r"min-width\s*:\s*(\d+)\s*px", line):
                if int(m.group(1)) >= 360:
                    self.assertIn("@media", line,
                                  f"line {i + 1}: element min-width forces 360px overflow")

    def test_horizontal_overflow_guard(self):
        self.assertRegex(CSS, r"overflow-x\s*:\s*clip")

    def test_touch_targets_and_reduced_motion(self):
        self.assertIn("--tap: 44px", CSS)
        self.assertIn("prefers-reduced-motion", CSS)


class FixtureWalkthroughTest(unittest.TestCase):
    def test_decision_has_all_required_fields(self):
        required = ("reason", "blocked_tasks", "choices", "risk",
                    "default_on_timeout", "last_updated_age_s", "source_agent")
        for field in required:
            self.assertIn(field, FX["decision"], field)
        self.assertIn("title", FX["decision"])
        self.assertTrue(len(FX["decision"]["choices"]) >= 2)

    def test_pr_summary_with_failing_check_and_merge_block(self):
        self.assertEqual(len(FX["pr"]["checks"]), 12)
        statuses = {c["status"] for c in FX["pr"]["checks"]}
        self.assertIn("fail", statuses)
        self.assertIn("pass", statuses)
        self.assertTrue(FX["pr"]["merge_blocked_reason"])

    def test_task_states_cover_walkthrough(self):
        states = {t["state"] for t in FX["tasks"]}
        for s in ("verified", "running", "blocked", "failed"):
            self.assertIn(s, states, f"no {s} task for the walkthrough")

    def test_fleet_shows_unknown_honestly(self):
        states = {a["state"] for a in FX["agents"]}
        self.assertIn("unknown", states)
        for a in FX["agents"]:
            self.assertIn("heartbeat_age_s", a)

    def test_states_cover_loading_error_offline_shapes(self):
        self.assertTrue(any(f["status"] == "failed" for f in FX["files"]))
        self.assertIn("sleep", FX)


class ServiceWorkerTest(unittest.TestCase):
    def test_shell_entries_exist(self):
        shell = re.search(r"SHELL = \[(.*?)\]", SW, re.S).group(1)
        entries = re.findall(r'"(\./[^"]*)"', shell)
        self.assertTrue(entries)
        for e in entries:
            target = "index.html" if e == "./" else e[2:]
            self.assertTrue((ROOT / target).is_file(), f"sw caches missing file {e}")

    def test_versioned_cache(self):
        self.assertRegex(SW, r'ff019-shell-v\d+')

    def test_never_caches_network_responses(self):
        # Privacy boundary (PR #47 review): only the install-time fixture
        # shell may be written to cache; no fetch response may be stored.
        self.assertNotIn("cache.put", SW)
        self.assertNotIn("cache.add(", SW)


class RouterCoverageTest(unittest.TestCase):
    EXPECTED = ["#/home", "#/projects", "#/project/demo", "#/project/demo/chat",
                "#/project/demo/tasks", "#/project/demo/prs", "#/project/demo/files",
                "#/inbox", "#/fleet", "#/more"]

    def test_routes_declared_and_rendered(self):
        routes = re.search(r"ROUTES = \[(.*?)\]", JS, re.S).group(1)
        for r in self.EXPECTED:
            self.assertIn('"%s"' % r, routes, f"route {r} not declared")
            self.assertGreaterEqual(JS.count(r), 2, f"route {r} declared but never rendered")

    def test_js_syntax_with_node(self):
        node = shutil.which("node")
        if node is None:
            self.skipTest("node unavailable")
        for f in ("app.js", "sw.js"):
            p = subprocess.run([node, "--check", str(ROOT / f)],
                               capture_output=True, text=True)
            self.assertEqual(p.returncode, 0, f"{f}: {p.stderr}")


if __name__ == "__main__":
    unittest.main()
