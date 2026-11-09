#!/usr/bin/env python3
"""FF-028 tests: authenticated preview, no exposed bridge, explicit hosts,
fail-closed behavior, reconnect + upload contracts.

Stdlib unittest only. Exercises scripts/deploy/preview_ingress_check.py against
the committed fixtures (pass case) plus one mutation per acceptance clause
(fail cases), so a regression in any clause is caught deterministically.

Run: python3 scripts/deploy/test_preview_ingress.py
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from preview_ingress_check import check  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent.parent
POLICY = (ROOT / "infra" / "preview-ingress" / "ingress-policy.yaml").read_text(encoding="utf-8")
CADDY = (ROOT / "infra" / "preview-ingress" / "Caddyfile.preview").read_text(encoding="utf-8")
ENV = (ROOT / "infra" / "preview-ingress" / "vercel-preview.env.example").read_text(encoding="utf-8")


def fails_with(failures, fragment):
    return any(fragment in failure for failure in failures)


class PreviewIngressTest(unittest.TestCase):
    def test_committed_fixtures_pass(self):
        self.assertEqual(check(POLICY, CADDY, ENV), [])

    def test_authenticated_preview_rejects_missing_forward_auth(self):
        mutated = CADDY.replace("forward_auth", "no_auth_gate")
        failures = check(POLICY, mutated, ENV)
        self.assertTrue(fails_with(failures, "forward_auth"),
                        f"expected a forward_auth failure, got: {failures}")

    def test_session_gate_must_be_verified_get_session(self):
        mutated = CADDY.replace("/api/auth/get-session", "/auth/verify")
        failures = check(POLICY, mutated, ENV)
        self.assertTrue(fails_with(failures, "get-session"),
                        f"expected a session-gate failure, got: {failures}")

    def test_no_exposed_bridge_rejects_bridge_route(self):
        mutated = CADDY + "\n\thandle /bridge/status {\n\t\treverse_proxy 127.0.0.1:4387\n\t}\n"
        failures = check(POLICY, mutated, ENV)
        self.assertTrue(fails_with(failures, "bridge"),
                        f"expected a bridge-exposure failure, got: {failures}")

    def test_no_wildcard_cors(self):
        mutated = CADDY.replace(
            "Access-Control-Allow-Origin {http.request.header.Origin}",
            'Access-Control-Allow-Origin "*"', 1)
        failures = check(POLICY, mutated, ENV)
        self.assertTrue(fails_with(failures, "wildcard"),
                        f"expected a wildcard-CORS failure, got: {failures}")

    def test_explicit_hosts_reject_broad_vercel_trust(self):
        mutated = CADDY.replace(
            r"^https://(app\.staging\.example\.invalid|ff-preview-057-forge-fleet\.vercel\.app)$",
            r"^https://(.*\.vercel\.app)$")
        failures = check(POLICY, mutated, ENV)
        self.assertTrue(fails_with(failures, "allowlist") or fails_with(failures, "wildcard"),
                        f"expected an allowlist failure, got: {failures}")

    def test_fail_closed_requires_403_and_404(self):
        mutated = CADDY.replace('respond "Forbidden" 403', 'respond "" 200')
        failures = check(POLICY, mutated, ENV)
        self.assertTrue(fails_with(failures, "403"),
                        f"expected a fail-closed failure, got: {failures}")

    def test_reconnect_requires_gated_api_surface(self):
        mutated = CADDY.replace("handle /api/* {", "handle /api/sockets/* {")
        failures = check(POLICY, mutated, ENV)
        self.assertTrue(fails_with(failures, "WS") or fails_with(failures, "/api/*"),
                        f"expected a WS-path failure, got: {failures}")

    def test_upload_requires_safety_ceiling(self):
        mutated = CADDY.replace("max_size 1GB", "max_size 64GB")
        failures = check(POLICY, mutated, ENV)
        self.assertTrue(fails_with(failures, "1GB"),
                        f"expected an upload-ceiling failure, got: {failures}")

    def test_preview_env_rejects_production_target_and_secrets(self):
        prod_env = ENV.replace("api.staging.example.invalid", "api.example.invalid")
        failures = check(POLICY, CADDY, prod_env)
        self.assertTrue(fails_with(failures, "staging"),
                        f"expected a production-target failure, got: {failures}")
        leaked = ENV + "\nBRIDGE_AUTH_SECRET=hunter2\n"
        failures = check(POLICY, CADDY, leaked)
        self.assertTrue(fails_with(failures, "BRIDGE_AUTH_SECRET"),
                        f"expected a secret-leak failure, got: {failures}")


if __name__ == "__main__":
    unittest.main()
