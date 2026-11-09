"""Unit tests for the FF-029 Play internal-track readiness gate (stdlib only)."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

GATE = Path(__file__).resolve().parents[1] / "check_play_internal_readiness.py"


def write_bundle(tmp: Path, manifest: dict, smoke=None, aab_bytes: bytes = b"fake-aab-bytes") -> Path:
    bundle = tmp / "bundle"
    bundle.mkdir()
    (bundle / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    if aab_bytes is not None:
        (bundle / manifest.get("aab", "app-release.aab")).write_bytes(aab_bytes)
    if smoke is not None:
        (bundle / manifest.get("smokeEvidence", "smoke.json")).write_text(
            json.dumps(smoke), encoding="utf-8"
        )
    return bundle


def valid_manifest(**overrides):
    base = {
        "applicationId": "com.example.forgefleet.internal",
        "versionCode": 7,
        "versionName": "1.1.0",
        "aab": "app-release.aab",
        "privacyPolicyUrl": "https://example.com/privacy",
        "dataSafetyComplete": True,
        "appAccessInstructions": "Test account provisioned via Play Console notes.",
        "targetSdkVersion": 35,
        "internalTesters": ["tester@example.com"],
        "releaseNotes": "Internal test build notes.",
        "smokeEvidence": "smoke.json",
    }
    base.update(overrides)
    return base


def valid_smoke(**overrides):
    steps = [
        {"id": i, "name": name, "result": "pass", "note": "ok"}
        for i, name in {
            1: "sign-in",
            2: "expiring-session",
            3: "background/foreground",
            4: "deep-link",
            5: "alert-delivery",
            6: "context-upload",
            7: "sleep-toggle",
            8: "pr-approval",
            9: "offline/reconnect",
        }.items()
    ]
    return {"deviceModel": "Fixture Phone", "steps": steps, **overrides}


def run_gate(bundle: Path, *extra):
    proc = subprocess.run(
        [sys.executable, str(GATE), "--bundle", str(bundle), *extra],
        capture_output=True,
        text=True,
    )
    return proc.returncode, json.loads(proc.stdout)


class TestReadinessGate(unittest.TestCase):
    def test_valid_fixture_bundle_passes_with_example_flag(self):
        with tempfile.TemporaryDirectory() as tmp:
            bundle = write_bundle(Path(tmp), valid_manifest(), valid_smoke())
            code, report = run_gate(bundle, "--allow-example-id")
            self.assertEqual(code, 0)
            self.assertTrue(report["ready"])
            self.assertTrue(all(c["ok"] for c in report["checks"]))

    def test_example_id_rejected_without_flag(self):
        with tempfile.TemporaryDirectory() as tmp:
            bundle = write_bundle(Path(tmp), valid_manifest(), valid_smoke())
            code, report = run_gate(bundle)
            self.assertEqual(code, 1)
            self.assertFalse(report["ready"])
            failed = {c["check"] for c in report["checks"] if not c["ok"]}
            self.assertIn("applicationIdChosen", failed)

    def test_placeholder_manifest_is_blocked(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = json.loads(
                (GATE.parent / "fixtures" / "placeholder-manifest.json").read_text()
            )
            bundle = Path(tmp) / "bundle"
            bundle.mkdir()
            (bundle / "manifest.json").write_text(json.dumps(fixture))
            code, report = run_gate(bundle)
            self.assertEqual(code, 1)
            self.assertFalse(report["ready"])
            failed = {c["check"] for c in report["checks"] if not c["ok"]}
            self.assertTrue(
                {"applicationIdChosen", "aabPresent", "smokeEvidencePresent"} <= failed
            )

    def test_missing_aab_blocks(self):
        with tempfile.TemporaryDirectory() as tmp:
            bundle = write_bundle(
                Path(tmp), valid_manifest(), valid_smoke(), aab_bytes=None
            )
            code, report = run_gate(bundle, "--allow-example-id")
            self.assertEqual(code, 1)
            failed = {c["check"] for c in report["checks"] if not c["ok"]}
            self.assertIn("aabPresent", failed)

    def test_secrets_in_manifest_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            manifest = valid_manifest(keystorePassword="supersecret")
            bundle = write_bundle(Path(tmp), manifest, valid_smoke())
            code, report = run_gate(bundle, "--allow-example-id")
            self.assertEqual(code, 1)
            failed = {c["check"] for c in report["checks"] if not c["ok"]}
            self.assertIn("noSecretsInManifest", failed)

    def test_incomplete_smoke_blocks(self):
        with tempfile.TemporaryDirectory() as tmp:
            smoke = valid_smoke()
            smoke["steps"] = smoke["steps"][:8]  # drop step 9
            bundle = write_bundle(Path(tmp), valid_manifest(), smoke)
            code, report = run_gate(bundle, "--allow-example-id")
            self.assertEqual(code, 1)
            failed = {c["check"] for c in report["checks"] if not c["ok"]}
            self.assertIn("smokeEvidenceComplete", failed)

    def test_smoke_failure_blocks(self):
        with tempfile.TemporaryDirectory() as tmp:
            smoke = valid_smoke()
            smoke["steps"][0]["result"] = "fail"
            bundle = write_bundle(Path(tmp), valid_manifest(), smoke)
            code, report = run_gate(bundle, "--allow-example-id")
            self.assertEqual(code, 1)
            failed = {c["check"] for c in report["checks"] if not c["ok"]}
            self.assertIn("smokeEvidenceComplete", failed)

    def test_missing_bundle_is_usage_error(self):
        proc = subprocess.run(
            [sys.executable, str(GATE), "--bundle", "/nonexistent-ff029"],
            capture_output=True,
            text=True,
        )
        self.assertEqual(proc.returncode, 2)


if __name__ == "__main__":
    unittest.main()
