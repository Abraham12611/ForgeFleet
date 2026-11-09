"""Fixture tests for the FF-025 packaging validator (stdlib unittest only)."""

import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from check_packaging import validate  # noqa: E402


def fixture_root():
    return Path(__file__).resolve().parent.parent


class TestPackagingFixtures(unittest.TestCase):
    def test_valid_spike_passes(self):
        self.assertEqual(validate(fixture_root()), [])

    def _copy_to_tmp(self):
        tmp = Path(tempfile.mkdtemp())
        for name in (
            "capacitor.config.json",
            "android-manifest-spec.json",
            "deep-links.json",
            "release-spec.json",
        ):
            tmp.joinpath(name).write_text(
                (fixture_root() / name).read_text(encoding="utf-8"), encoding="utf-8"
            )
        return tmp

    def _rewrite(self, tmp, name, mutate):
        path = tmp / name
        data = json.loads(path.read_text(encoding="utf-8"))
        mutate(data)
        path.write_text(json.dumps(data), encoding="utf-8")

    def test_guessed_release_app_id_rejected(self):
        tmp = self._copy_to_tmp()
        self._rewrite(tmp, "capacitor.config.json", lambda d: d.update({"appId": "com.acme.forgefleet"}))
        failures = validate(tmp)
        self.assertTrue(any("appId" in f for f in failures), failures)

    def test_remote_webdir_rejected(self):
        tmp = self._copy_to_tmp()
        self._rewrite(
            tmp, "capacitor.config.json", lambda d: d.update({"webDir": "https://app.example.com"})
        )
        failures = validate(tmp)
        self.assertTrue(any("webDir" in f for f in failures), failures)

    def test_unknown_deep_link_screen_rejected(self):
        tmp = self._copy_to_tmp()
        def mutate(d):
            d["routes"].append({"path": "/nope", "screen": "not-a-screen", "params": []})
        self._rewrite(tmp, "deep-links.json", mutate)
        failures = validate(tmp)
        self.assertTrue(any("not-a-screen" in f for f in failures), failures)

    def test_missing_owner_gate_rejected(self):
        tmp = self._copy_to_tmp()
        def mutate(d):
            d["promotionGates"]["production"] = "auto-promote when green"
        self._rewrite(tmp, "release-spec.json", mutate)
        failures = validate(tmp)
        self.assertTrue(any("owner approval" in f for f in failures), failures)

    def test_committed_secret_rejected(self):
        tmp = self._copy_to_tmp()
        def mutate(d):
            d["signing"]["credentialEnvNames"].append("ANDROID_KEYSTORE_PASSWORD=hunter2-secret")
        self._rewrite(tmp, "release-spec.json", mutate)
        failures = validate(tmp)
        self.assertTrue(any("never be committed" in f for f in failures), failures)

    def test_host_mismatch_rejected(self):
        tmp = self._copy_to_tmp()
        def mutate(d):
            d["universalHosts"] = ["other.example.invalid"]
        self._rewrite(tmp, "deep-links.json", mutate)
        failures = validate(tmp)
        self.assertTrue(any("hosts" in f for f in failures), failures)


if __name__ == "__main__":
    unittest.main()
