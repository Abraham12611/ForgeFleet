#!/usr/bin/env python3
"""FF-022 contract tests (stdlib only): reproducible restore, split web/API, no open bridge.

Run: python3 scripts/deploy/tests/test_deploy_contracts.py
Covers file-shape invariants plus fixture rehearsals via the shell scripts.
Prefers real tooling (caddy binary via CADDY_BIN/PATH, docker compose
fail-closed parsing) and always runs the canonical FF-005 selftest to prove
no regression. No secrets, no live host changes.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DEPLOY = ROOT / "scripts" / "deploy"
INFRA = ROOT / "infra"
CADDY = shutil.which(os.environ.get("CADDY_BIN", "caddy")) if os.environ.get("CADDY_BIN") else shutil.which("caddy")


def sh(*args: str, env_extra: dict | None = None) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env.update(env_extra or {})
    return subprocess.run(list(args), text=True, capture_output=True, env=env)


def service_block(compose: str, name: str) -> str:
    """Extract one top-level service block from the compose file."""
    m = re.search(rf"^  {re.escape(name)}:\n((?:  .*|\n)*?)(?=^  \w)", compose,
                  re.MULTILINE)
    assert m, f"service missing: {name}"
    return m.group(0)


class DeployContracts(unittest.TestCase):
    def test_owned_paths_only(self):
        # FF-022 owns infra/** and scripts/deploy/**; canonical FF-005 files
        # touched here must be merges, never deletions of canonical behavior.
        p = sh("git", "status", "--porcelain")
        touched = [l[3:].split(" -> ")[-1] for l in p.stdout.splitlines() if l.strip()]
        for t in touched:
            self.assertTrue(
                t.startswith("infra/") or t.startswith("scripts/deploy/"),
                f"out-of-scope touch: {t}",
            )

    def test_canonical_selftest_passes(self):
        # The FF-005 guard suite must stay green under our delta.
        p = sh("bash", str(DEPLOY / "selftest.sh"))
        self.assertEqual(p.returncode, 0, p.stderr + p.stdout)
        self.assertIn("0 failed", p.stdout)

    def test_compose_single_supervisor_loopback(self):
        compose = (INFRA / "docker-compose.private.yml").read_text()
        self.assertNotRegex(compose, r"(?m)^\s{2}bridge:",
                            "compose must not define a bridge service")
        for line in compose.splitlines():
            if re.match(r"\s+-\s+\"", line) and ":" in line and "ports" not in line:
                self.assertIn("127.0.0.1", line, f"non-loopback publish: {line}")
        edge = service_block(compose, "edge")
        self.assertIn("split", edge, "edge must be split-profile opt-in")
        db = service_block(compose, "db")
        self.assertNotRegex(db, r"(?m)^\s+ports\s*:", "db must publish no ports")

    def test_compose_fail_closed_with_real_compose(self):
        # Real docker compose parsing (no daemon needed): unset pins must fail.
        env = {k: "" for k in ("POSTGRES_IMAGE", "PAPERCLIP_IMAGE", "CADDY_IMAGE")}
        for k in env:
            os.environ.pop(k, None)
        p = sh("docker", "compose", "-f", str(INFRA / "docker-compose.private.yml"),
               "config", "--quiet")
        self.assertNotEqual(p.returncode, 0, "compose must fail closed on unset pins")
        self.assertRegex(p.stderr, "POSTGRES_IMAGE|PAPERCLIP_IMAGE",
                         "fail-closed error must name the missing pin")

    def test_edge_denies_bridge_requires_auth(self):
        caddy = (INFRA / "ingress" / "Caddyfile").read_text()
        self.assertIn("handle /v1/*", caddy)
        self.assertIn("handle /bridge/*", caddy)
        self.assertIn("forward_auth", caddy)
        routes = [l for l in caddy.splitlines() if "reverse_proxy" in l]
        self.assertTrue(routes)
        for r in routes:
            self.assertNotIn("8787", r)
            self.assertNotIn("4387", r)
            self.assertNotIn("bridge", r)

    @unittest.skipUnless(CADDY, "caddy binary absent (set CADDY_BIN)")
    def test_caddy_validate_real_toolchain(self):
        p = sh(CADDY, "validate", "--config", str(INFRA / "ingress" / "Caddyfile"),
               "--adapter", "caddyfile")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("Valid configuration", p.stderr + p.stdout)

    @unittest.skipUnless(CADDY, "caddy binary absent (set CADDY_BIN)")
    def test_caddy_adapt_no_bridge_upstream(self):
        p = sh(CADDY, "adapt", "--config", str(INFRA / "ingress" / "Caddyfile"),
               "--adapter", "caddyfile")
        self.assertEqual(p.returncode, 0, p.stderr)
        doc = json.loads(p.stdout)
        blob = json.dumps(doc)
        self.assertNotRegex(blob, r'"dial": ?"[^"]*(8787|4387|bridge)')
        self.assertRegex(blob, r'"dial": ?"paperclip:8080"')
        self.assertIn("/auth/verify", blob)
        self.assertIn("404", blob)

    def test_bridge_unit_canonical_untouched(self):
        unit = (INFRA / "systemd" / "forgefleet-bridge.service").read_text()
        self.assertIn("WantedBy=default.target", unit, "must stay a user unit")
        self.assertNotRegex(unit, r"(?m)^User=", "must run as invoking operator user")
        self.assertIn("guard-loopback", unit)

    def test_vercel_no_secrets(self):
        vercel = json.loads((INFRA / "vercel" / "vercel.json").read_text())
        env_keys = " ".join(vercel.get("env", {}).keys()).upper()
        for secret in ("DATABASE", "SECRET", "PRIVATE", "TOKEN", "KEY"):
            self.assertNotIn(secret, env_keys)
        self.assertIn("VITE_PUBLIC_API_URL", json.dumps(vercel))

    def test_no_committed_secret_values(self):
        hits = []
        for path in list(INFRA.rglob("*")) + list(DEPLOY.rglob("*")):
            if not path.is_file() or path.suffix in (".png", ".jpg"):
                continue
            try:
                data = path.read_text()
            except UnicodeDecodeError:
                continue
            if re.search(r"ghp_[A-Za-z0-9]{20,}|xox[bpas]-[A-Za-z0-9-]{10,}", data):
                hits.append(str(path))
        self.assertEqual(hits, [], f"secret values committed: {hits}")

    def test_verify_split_reports_toolchain(self):
        p = sh("bash", str(DEPLOY / "verify-split.sh"), "--static-only")
        self.assertEqual(p.returncode, 0, p.stderr + p.stdout)
        self.assertIn("verify-split PASS", p.stdout)
        if CADDY:
            self.assertIn("REAL caddy", p.stdout)
        else:
            self.assertIn("static shape checks only", p.stdout + p.stderr)

    def test_reproducible_restore_fixture(self):
        p = sh("bash", str(DEPLOY / "verify-restore.sh"))
        self.assertEqual(p.returncode, 0, p.stderr + p.stdout)
        self.assertIn("verify-restore PASS", p.stdout)

    def test_backup_manifest_fixture_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "snaps"
            p1 = sh("bash", str(DEPLOY / "backup.sh"), "--fixture", "--out", str(out))
            self.assertEqual(p1.returncode, 0, p1.stderr)
            manifests = list(out.glob("*/manifest.json"))
            self.assertEqual(len(manifests), 1)
            manifest = json.loads(manifests[0].read_text())
            self.assertTrue(manifest["fixture"])
            for label, art in manifest["artifacts"].items():
                self.assertIn("sha256", art, label)
            for target in ("r1", "r2"):
                p = sh("bash", str(DEPLOY / "restore.sh"), "--manifest",
                       str(manifests[0]), "--target-dir", str(Path(tmp) / target))
                self.assertEqual(p.returncode, 0, p.stderr)
            r1, r2 = Path(tmp) / "r1", Path(tmp) / "r2"
            self.assertEqual((r1 / "pg.dump").read_bytes(), (r2 / "pg.dump").read_bytes())
            self.assertEqual(
                sorted(p.relative_to(r1 / "context") for p in (r1 / "context").rglob("*")),
                sorted(p.relative_to(r2 / "context") for p in (r2 / "context").rglob("*")),
            )
            fenced = json.loads((r1 / "LEASES_FENCED.json").read_text())
            self.assertFalse(fenced["dispatch_allowed"])
            self.assertEqual(fenced["leases"], "unknown")

    def test_rollback_split_refuses_unsafe_frontend_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            manifest = Path(tmp) / "m.json"
            manifest.write_text(json.dumps({"api_contract_version": "9.9.9"}))
            p = sh("bash", str(DEPLOY / "rollback-split.sh"),
                   "--target", str(manifest), "--component", "frontend", "--check")
            self.assertNotEqual(p.returncode, 0)
            self.assertIn("refusing frontend-only rollback", p.stderr + p.stdout)

    def test_split_scripts_gate_mutation(self):
        for s in ("deploy-split", "rollback-split"):
            text = (DEPLOY / f"{s}.sh").read_text()
            self.assertIn("--apply", text, f"{s}.sh gates mutation behind --apply")
            self.assertIn("forbid_orca_target", text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
