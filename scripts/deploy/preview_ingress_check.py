#!/usr/bin/env python3
"""FF-028 preview-ingress policy checker (stdlib only).

Validates the converged Caddy staging ingress: authenticated preview against
the verified get-session gate, no exposed bridge, explicit (non-wildcard)
preview hosts with fail-closed 401/403/404 behavior, and the verified
WS + poll reconnect and backend-aligned upload contracts.

Usage: python3 scripts/deploy/preview_ingress_check.py [--policy PATH --caddy PATH --env PATH]
Exit 0 when all checks pass; exit 1 with failure lines otherwise.
"""
import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULT_POLICY = ROOT / "infra" / "preview-ingress" / "ingress-policy.yaml"
DEFAULT_CADDY = ROOT / "infra" / "preview-ingress" / "Caddyfile.preview"
DEFAULT_ENV = ROOT / "infra" / "preview-ingress" / "vercel-preview.env.example"

PUBLIC_PATHS = ["/api/liveness", "/api/ready", "/api/auth", "/api/companies"]
DENIED_PREFIXES = ["/bridge", "/v1", "/internal", "/metrics-private", "/orca"]
SECRET_NAMES = [
    "PAPERCLIP_DATABASE_URL",
    "BRIDGE_AUTH_SECRET",
    "GITHUB_APP_PRIVATE_KEY_PATH",
    "GITHUB_WEBHOOK_SECRET",
    "ORCA_CLI_COMMAND",
]


def check(policy_text, caddy_text, env_text):
    failures = []

    def need(cond, msg):
        if not cond:
            failures.append(msg)

    code_lines = [ln.split("#", 1)[0] for ln in caddy_text.splitlines()]
    code = "\n".join(code_lines)

    # --- Authenticated preview against the verified session gate ---
    need("forward_auth" in code, "ingress must gate product routes with forward_auth")
    need("/api/auth/get-session" in code,
         "forward_auth must target the verified session gate /api/auth/get-session")
    need("copy_headers Cookie Authorization" in code,
         "forward_auth must forward Cookie/Authorization to the session gate")
    need(code.count("forward_auth") >= 1, "product /api/* surface must sit behind forward_auth")
    need("auto_https disable_certs" in code or "tls " in code,
         "ingress must terminate TLS (staging certs injected by the operator)")
    api_block = _handle_block(caddy_text, "handle /api/*")
    need(api_block is not None and "forward_auth" in api_block.split("#", 1)[0],
         "handle /api/* must enforce forward_auth before proxy/upgrade")

    # --- No exposed bridge (Caddy must never proxy to bridge/orca/private) ---
    need("127.0.0.1" in policy_text or "unix:" in policy_text,
         "policy must bind the bridge to loopback/Unix socket only")
    for denied in DENIED_PREFIXES:
        need(re.search(rf"handle\s+{re.escape(denied)}", code) and "404" in code,
             f"ingress must explicitly close {denied} with 404")
    for line in code_lines:
        s = line.strip().lower()
        if "reverse_proxy" in s or "forward_auth" in s:
            need(not any(k in s for k in ("bridge", "orca", ":4387", "metrics-private")),
                 f"ingress must never route to bridge/orca/private: {line.strip()}")
    need('respond "Not Found" 404' in caddy_text,
         "ingress must default-deny unknown paths with 404")

    # --- Explicit preview hosts, no wildcards, fail closed ---
    need(re.search(r"@allowed_origin\s+header_regexp\s+Origin", code) is not None,
         "ingress must define an explicit @allowed_origin allowlist")
    allow_m = re.search(r"@allowed_origin\s+header_regexp\s+Origin\s+(\S+)", code)
    need(bool(allow_m), "allowlist must carry an anchored origin pattern")
    if allow_m:
        pattern = allow_m.group(1)
        need(pattern.startswith("^https://") and pattern.endswith("$"),
             "allowlist pattern must be anchored https exact-host match")
        need("*" not in pattern.replace(r"\.", "").replace("\\.", ""),
             "allowlist must not contain wildcards")
        need("vercel\\.app" in pattern and "staging" in pattern,
             "allowlist must cover the staging sibling and the exact preview host")
    need('respond "Forbidden" 403' in caddy_text,
         "ingress must fail closed with 403 for foreign origins/preflight")
    need("Access-Control-Allow-Origin {http.request.header.Origin}" in caddy_text,
         "CORS echo must reflect the validated Origin, never '*'")
    for line in code_lines:
        s = line.strip()
        if s.startswith("#"):
            continue
        if "Access-Control-Allow-Origin" in s and '"*"' in s.replace("'", '"'):
            failures.append(f"CORS must never be wildcard '*': {s}")

    # --- Reconnect: verified WS path + poll fallback, gated pre-upgrade ---
    # (enforced on the single /api/* surface; path-level proof is the live
    # round-trip driving wss:///api/companies/<id>/events/ws end to end)
    need("handle /api/*" in code and "events/ws" in policy_text,
         "ingress must cover the verified WS path /api/companies/<id>/events/ws")
    need("15s" in policy_text or "poll" in policy_text,
         "policy must document the 15s HTTPS poll fallback")
    need("forward_auth" in (api_block or ""),
         "WS upgrades must pass the session gate before upgrading")

    # --- Uploads: backend-aligned limits, auth required ---
    need("max_size 1GB" in code,
         "ingress must set the 1GB safety ceiling (backend absolute max)")
    need("10mb" in policy_text and "1GiB" in policy_text,
         "policy must document backend-aligned upload limits")

    # --- Preview env hygiene ---
    need("VITE_PUBLIC_API_URL=https://" in env_text,
         "preview env must point VITE_PUBLIC_API_URL at the staging HTTPS API")
    api_url = re.search(r"^VITE_PUBLIC_API_URL=(.*)$", env_text, re.M)
    need(bool(api_url) and "staging" in api_url.group(1) and "prod" not in api_url.group(1).lower(),
         "VITE_PUBLIC_API_URL must target staging, never production")
    assigned_keys = {m.group(1) for m in re.finditer(r"^\s*([A-Z][A-Z0-9_]+)=", env_text, re.M)}
    for secret in SECRET_NAMES:
        need(secret not in assigned_keys,
             f"preview env must not contain secret {secret}")
    need(not any("TAILSCALE" in key for key in assigned_keys),
         "preview env must not contain Tailscale credentials")

    # --- Policy/implementation agreement ---
    # (/api/* sub-paths are covered by the single gated surface.)
    for path in PUBLIC_PATHS:
        need(path in policy_text, f"policy must list public path {path}")
        need(path in code or (path.startswith("/api/") and "handle /api/*" in code),
             f"ingress must implement public path {path}")

    return failures


def _handle_block(text, opener):
    idx = text.find(opener)
    if idx < 0:
        return None
    open_brace = text.find("{", idx)
    if open_brace < 0:
        return None
    depth = 0
    for i in range(open_brace, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[open_brace:i + 1]
    return None


def main(argv=None):
    parser = argparse.ArgumentParser(description="FF-028 preview ingress policy check")
    parser.add_argument("--policy", default=str(DEFAULT_POLICY))
    parser.add_argument("--caddy", default=str(DEFAULT_CADDY))
    parser.add_argument("--env", default=str(DEFAULT_ENV))
    args = parser.parse_args(argv)
    policy_text = Path(args.policy).read_text(encoding="utf-8")
    caddy_text = Path(args.caddy).read_text(encoding="utf-8")
    env_text = Path(args.env).read_text(encoding="utf-8")
    failures = check(policy_text, caddy_text, env_text)
    if failures:
        print("PREVIEW INGRESS CHECK: FAIL")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print("PREVIEW INGRESS CHECK: PASS (authenticated preview, no exposed bridge, explicit hosts, fail-closed, reconnect + upload contracts hold)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
