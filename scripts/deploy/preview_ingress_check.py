#!/usr/bin/env python3
"""FF-028 preview-ingress policy checker (stdlib only).

Validates that the staging ingress keeps Vercel previews authenticated,
keeps the bridge private, and preserves reconnect + upload behavior.

Usage: python3 scripts/deploy/preview-ingress-check.py [--policy PATH --nginx PATH --env PATH]
Exit 0 when all checks pass; exit 1 with failure lines otherwise.
"""
import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULT_POLICY = ROOT / "infra" / "preview-ingress" / "ingress-policy.yaml"
DEFAULT_NGINX = ROOT / "infra" / "preview-ingress" / "nginx.preview-ingress.conf"
DEFAULT_ENV = ROOT / "infra" / "preview-ingress" / "vercel-preview.env.example"

PUBLIC_PATHS = ["/api/health", "/api/events", "/api/uploads", "/api/tasks"]
DENIED_PREFIXES = ["/bridge", "/internal", "/metrics-private", "/orca"]
SECRET_NAMES = [
    "PAPERCLIP_DATABASE_URL",
    "BRIDGE_AUTH_SECRET",
    "GITHUB_APP_PRIVATE_KEY_PATH",
    "GITHUB_WEBHOOK_SECRET",
    "TAILSCALE",
    "ORCA_CLI_COMMAND",
]


def check(policy_text, nginx_text, env_text):
    failures = []

    def need(cond, msg):
        if not cond:
            failures.append(msg)

    # --- Authenticated preview ---
    need("auth_request /internal/auth/session" in nginx_text,
         "nginx must enforce auth_request on public locations")
    need(nginx_text.count("auth_request /internal/auth/session") >= 4,
         "every public location (/api/health, /api/events, /api/uploads, /api/tasks) must require auth")
    need("anonymous" not in nginx_text.lower() or "den" in nginx_text.lower(),
         "nginx must not grant anonymous access")
    need("staging" in env_text and "VITE_PUBLIC_API_URL=https://" in env_text,
         "preview env must point VITE_PUBLIC_API_URL at the staging HTTPS API")
    api_url = re.search(r"^VITE_PUBLIC_API_URL=(.*)$", env_text, re.M)
    need(bool(api_url) and "staging" in api_url.group(1) and "prod" not in api_url.group(1).lower(),
         "VITE_PUBLIC_API_URL must target staging, never production")
    # Only real KEY=value assignments count; "Do NOT set" documentation lines are fine.
    assigned_keys = {
        m.group(1)
        for m in re.finditer(r"^\s*([A-Z][A-Z0-9_]+)=", env_text, re.M)
    }
    for secret in SECRET_NAMES:
        need(secret not in assigned_keys,
             f"preview env must not contain secret {secret}")
    need(not any("TAILSCALE" in key for key in assigned_keys),
         "preview env must not contain Tailscale credentials")

    # --- No exposed bridge ---
    low = nginx_text.lower()
    need("unix:" in policy_text or "127.0.0.1" in policy_text,
         "policy must bind the bridge to loopback/Unix socket only")
    for denied in DENIED_PREFIXES:
        bare = denied.strip("/")
        need(bare in low and "deny all" in low,
             f"nginx must explicitly deny {denied}")
    need("proxy_pass http://paperclip_staging" in nginx_text or
         "proxy_pass http://paperclip" in nginx_text,
         "public locations must proxy only to the Paperclip staging backend")
    # No proxied route may reference a bridge/orca/private upstream, even inline
    # inside a location line (comments stripped before matching).
    for line in nginx_text.splitlines():
        code = line.split("#", 1)[0].lower()
        if "proxy_pass" in code and any(k in code for k in ("bridge", "orca", "metrics-private")):
            failures.append(f"nginx must never proxy to bridge/orca/private: {line.strip()}")
    # No wildcard CORS anywhere.
    for line in nginx_text.splitlines():
        s = line.strip()
        if s.startswith("#"):
            continue
        if "Access-Control-Allow-Origin" in s and '"*"' in s.replace("'", '"'):
            failures.append("CORS must never be wildcard '*': " + s)
    need("vercel" in low and "staging" in low,
         "CORS origin rules must cover Vercel previews and the staging sibling domain")

    # --- Reconnect (SSE) ---
    events_block = _location_block(nginx_text, "/api/events")
    need(events_block is not None, "nginx must define an /api/events location")
    if events_block is not None:
        need("proxy_buffering off" in events_block, "SSE must disable proxy buffering")
        need("proxy_cache off" in events_block, "SSE must disable proxy caching")
        need("proxy_read_timeout" in events_block, "SSE must hold a long read timeout")
        need("proxy_set_header Last-Event-ID" in events_block,
             "SSE must forward Last-Event-ID for resume")
        need("no-store" in events_block, "SSE must send Cache-Control: no-store")
    need("Last-Event-ID" in policy_text, "policy must document the Last-Event-ID resume contract")

    # --- Uploads ---
    uploads_block = _location_block(nginx_text, "/api/uploads")
    need(uploads_block is not None, "nginx must define an /api/uploads location")
    if uploads_block is not None:
        need("client_max_body_size" in uploads_block, "uploads must bound client_max_body_size")
        m = re.search(r"client_max_body_size\s+(\S+?);", uploads_block)
        need(bool(m), "uploads must set an explicit client_max_body_size value")
        need("limit_except" in uploads_block or "deny all" in uploads_block,
             "uploads must restrict HTTP methods (POST/PUT only)")
        need("auth_request" in uploads_block, "uploads must require auth")
    need("10m" in policy_text or "max_body_size" in policy_text,
         "policy must document the upload size ceiling")

    # --- Policy/implementation agreement ---
    for path in PUBLIC_PATHS:
        need(path in policy_text, f"policy must list public path {path}")
        need(path in nginx_text, f"nginx must implement public path {path}")

    return failures


def _location_block(nginx_text, location):
    """Extract the {...} body of the location matching the given path."""
    idx = nginx_text.find(location)
    if idx < 0:
        return None
    open_brace = nginx_text.find("{", idx)
    if open_brace < 0:
        return None
    depth = 0
    for i in range(open_brace, len(nginx_text)):
        if nginx_text[i] == "{":
            depth += 1
        elif nginx_text[i] == "}":
            depth -= 1
            if depth == 0:
                return nginx_text[open_brace:i + 1]
    return None


def main(argv=None):
    parser = argparse.ArgumentParser(description="FF-028 preview ingress policy check")
    parser.add_argument("--policy", default=str(DEFAULT_POLICY))
    parser.add_argument("--nginx", default=str(DEFAULT_NGINX))
    parser.add_argument("--env", default=str(DEFAULT_ENV))
    args = parser.parse_args(argv)
    policy_text = Path(args.policy).read_text(encoding="utf-8")
    nginx_text = Path(args.nginx).read_text(encoding="utf-8")
    env_text = Path(args.env).read_text(encoding="utf-8")
    failures = check(policy_text, nginx_text, env_text)
    if failures:
        print("PREVIEW INGRESS CHECK: FAIL")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print("PREVIEW INGRESS CHECK: PASS (authenticated preview, no exposed bridge, reconnect + upload contracts hold)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
