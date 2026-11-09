#!/usr/bin/env python3
"""FF-028 tests: authenticated preview, no exposed bridge, reconnect + upload.

Stdlib unittest only. Exercises scripts/deploy/preview-ingress-check.py against
the committed fixtures (pass case) plus one mutation per acceptance clause
(fail cases), so a regression in any clause is caught deterministically.

Run: python3 -m unittest scripts.deploy.test_preview_ingress -v
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from preview_ingress_check import check  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent.parent
POLICY = (ROOT / "infra" / "preview-ingress" / "ingress-policy.yaml").read_text(encoding="utf-8")
NGINX = (ROOT / "infra" / "preview-ingress" / "nginx.preview-ingress.conf").read_text(encoding="utf-8")
ENV = (ROOT / "infra" / "preview-ingress" / "vercel-preview.env.example").read_text(encoding="utf-8")


def fails_with(failures, fragment):
    return any(fragment in failure for failure in failures)


class PreviewIngressTest(unittest.TestCase):
    def test_committed_fixtures_pass(self):
        self.assertEqual(check(POLICY, NGINX, ENV), [])

    def test_authenticated_preview_rejects_anonymous_events(self):
        mutated = NGINX.replace("auth_request /internal/auth/session;", "", 1)
        failures = check(POLICY, mutated, ENV)
        self.assertTrue(fails_with(failures, "auth"),
                        f"expected an auth failure, got: {failures}")

    def test_no_exposed_bridge_rejects_bridge_upstream(self):
        mutated = NGINX + "\n    location /bridge { proxy_pass http://bridge_local; }\n"
        failures = check(POLICY, mutated, ENV)
        self.assertTrue(fails_with(failures, "bridge"),
                        f"expected a bridge-exposure failure, got: {failures}")

    def test_no_exposed_bridge_rejects_wildcard_cors(self):
        mutated = NGINX.replace(
            'add_header Access-Control-Allow-Origin $cors_origin always;',
            'add_header Access-Control-Allow-Origin "*" always;', 1)
        failures = check(POLICY, mutated, ENV)
        self.assertTrue(fails_with(failures, "wildcard"),
                        f"expected a wildcard-CORS failure, got: {failures}")

    def test_reconnect_requires_unbuffered_sse_with_resume(self):
        mutated = NGINX.replace("proxy_buffering off;", "proxy_buffering on;")
        failures = check(POLICY, mutated, ENV)
        self.assertTrue(fails_with(failures, "buffering"),
                        f"expected an SSE-buffering failure, got: {failures}")
        mutated_resume = NGINX.replace("Last-Event-ID", "X-Dropped-Header")
        failures = check(POLICY, mutated_resume, ENV)
        self.assertTrue(fails_with(failures, "Last-Event-ID"),
                        f"expected a resume-header failure, got: {failures}")

    def test_upload_requires_bound_and_auth(self):
        mutated = NGINX.replace("client_max_body_size 10m;", "")
        failures = check(POLICY, mutated, ENV)
        self.assertTrue(fails_with(failures, "client_max_body_size"),
                        f"expected an upload-limit failure, got: {failures}")

    def test_preview_env_rejects_production_target_and_secrets(self):
        prod_env = ENV.replace("api.staging.example.invalid", "api.example.invalid")
        failures = check(POLICY, NGINX, prod_env)
        self.assertTrue(fails_with(failures, "staging"),
                        f"expected a production-target failure, got: {failures}")
        leaked = ENV + "\nBRIDGE_AUTH_SECRET=hunter2\n"
        failures = check(POLICY, NGINX, leaked)
        self.assertTrue(fails_with(failures, "BRIDGE_AUTH_SECRET"),
                        f"expected a secret-leak failure, got: {failures}")


if __name__ == "__main__":
    unittest.main()
