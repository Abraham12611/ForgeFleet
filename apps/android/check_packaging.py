#!/usr/bin/env python3
"""FF-025 Android packaging validator (standard library only).

Enforces the spike rules documented in apps/android/README.md:
  1. Placeholder application ID (release ID is OPEN per ADR-0006, never guessed).
  2. Same-source webDir (relative local path, never a remote URL).
  3. No secrets committed (credential names only, never values).
  4. Deep-link targets resolve to known mobile-app-map screens.
  5. Internal -> closed -> production track order with owner gates.

Usage: python3 apps/android/check-packaging.py [--root apps/android]
Exit 0 when all checks pass, 1 with a failure list otherwise.
"""

import argparse
import json
import re
import sys
from pathlib import Path

PLACEHOLDER_MARKERS = ("placeholder", "example", "invalid")
SECRET_VALUE_PATTERN = re.compile(
    r"(?i)(password|passwd|secret)\s*=\s*\S|BEGIN [A-Z ]*PRIVATE KEY|[A-Za-z0-9+/]{64,}={0,2}"
)
ENV_NAME_PATTERN = re.compile(r"[A-Z][A-Z0-9_]+")


def committed_secret(blob):
    """True when text looks like an actual credential VALUE (not a *_REF name)."""
    return bool(SECRET_VALUE_PATTERN.search(blob))


def load_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8")), None
    except (OSError, json.JSONDecodeError) as exc:
        return None, f"{path.name}: unreadable or invalid JSON ({exc})"


def check_capacitor(cfg):
    failures = []
    app_id = cfg.get("appId", "")
    parts = app_id.split(".")
    if len(parts) < 3 or not all(parts):
        failures.append(f"capacitor.config.json: appId {app_id!r} is not reverse-DNS shaped")
    if not any(m in app_id for m in ("placeholder", "example")):
        failures.append(
            f"capacitor.config.json: appId {app_id!r} lacks a placeholder/example marker; "
            "the release ID is owner-chosen (ADR-0006) and must not be guessed here"
        )
    web_dir = cfg.get("webDir", "")
    if not isinstance(web_dir, str) or not web_dir or web_dir.startswith(("http://", "https://", "/")):
        failures.append(
            f"capacitor.config.json: webDir {web_dir!r} must be a relative local build output "
            "(same web source, not a remote URL)"
        )
    elif "web" not in web_dir:
        failures.append(
            f"capacitor.config.json: webDir {web_dir!r} does not reference the shared web source"
        )
    server = cfg.get("server", {})
    if isinstance(server, dict) and any(
        isinstance(v, str) and v.startswith("http") for v in server.values()
    ):
        failures.append("capacitor.config.json: server must not point at a remote URL")
    blob = json.dumps(cfg)
    if committed_secret(blob):
        failures.append("capacitor.config.json: looks like committed secret material")
    return failures


def check_manifest(spec, deep_links):
    failures = []
    if spec.get("applicationId", "") != "com.example.forgefleet.placeholder":
        failures.append("android-manifest-spec.json: applicationId must match the placeholder until the owner chooses the release ID")
    perms = spec.get("permissions", [])
    for required in ("android.permission.INTERNET", "android.permission.POST_NOTIFICATIONS"):
        if required not in perms:
            failures.append(f"android-manifest-spec.json: missing permission {required}")
    hosts = {f.get("host") for f in spec.get("intentFilters", []) if f.get("host")}
    universal = set(deep_links.get("universalHosts", []))
    if hosts != universal:
        failures.append(
            f"android-manifest-spec.json intent-filter hosts {sorted(hosts)} do not match "
            f"deep-links.json universalHosts {sorted(universal)}"
        )
    scheme_filters = [f.get("scheme") for f in spec.get("intentFilters", [])]
    if deep_links.get("customScheme") not in scheme_filters:
        failures.append("android-manifest-spec.json: no intent-filter for the deep-links customScheme")
    return failures


def check_deep_links(deep_links):
    failures = []
    known = set(deep_links.get("knownScreens", []))
    if not known:
        failures.append("deep-links.json: knownScreens is empty")
    for route in deep_links.get("routes", []):
        if route.get("screen") not in known:
            failures.append(
                f"deep-links.json: route {route.get('path')!r} targets unknown screen {route.get('screen')!r}"
            )
    if not deep_links.get("routes"):
        failures.append("deep-links.json: no routes defined")
    return failures


def check_release(release):
    failures = []
    signing = release.get("signing", {})
    names = signing.get("credentialEnvNames", [])
    if len(names) < 4:
        failures.append("release-spec.json: expected at least 4 signing credential env NAMES")
    bad = [n for n in names if not ENV_NAME_PATTERN.fullmatch(n)]
    if bad:
        failures.append(
            f"release-spec.json: credential entries {bad} are not plain env NAMES "
            "(values must never be committed)"
        )
    blob = json.dumps(release)
    if committed_secret(blob):
        failures.append("release-spec.json: credential values must never be committed (names only)")
    tracks = release.get("tracks", [])
    if tracks != ["internal", "closed", "production"]:
        failures.append(
            f"release-spec.json: tracks must be ['internal', 'closed', 'production'], got {tracks}"
        )
    gates = release.get("promotionGates", {})
    if not all(t in gates for t in ("internal", "closed", "production")):
        failures.append("release-spec.json: promotionGates must cover internal, closed, production")
    closed = str(gates.get("closed", "")).lower()
    prod = str(gates.get("production", "")).lower()
    if "owner" not in closed or "owner" not in prod:
        failures.append("release-spec.json: closed/production promotion requires explicit owner approval")
    return failures


def validate(root):
    failures = []
    cfg, err = load_json(root / "capacitor.config.json")
    manifest, err2 = load_json(root / "android-manifest-spec.json")
    deep_links, err3 = load_json(root / "deep-links.json")
    release, err4 = load_json(root / "release-spec.json")
    for err in (err, err2, err3, err4):
        if err:
            failures.append(err)
    if failures:
        return failures
    failures += check_capacitor(cfg)
    failures += check_manifest(manifest, deep_links)
    failures += check_deep_links(deep_links)
    failures += check_release(release)
    return failures


def main():
    parser = argparse.ArgumentParser(description="Validate FF-025 Android packaging spike.")
    parser.add_argument("--root", default=str(Path(__file__).resolve().parent))
    args = parser.parse_args()
    failures = validate(Path(args.root))
    if failures:
        print("FAIL:")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print("OK: Android packaging spike files pass all checks")
    return 0


if __name__ == "__main__":
    sys.exit(main())
