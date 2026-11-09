#!/usr/bin/env python3
"""FF-029 Play internal-track readiness gate (offline, stdlib only).

Validates a submission bundle directory containing a manifest.json plus
referenced artifacts. Never contacts Google Play and never accepts secrets.

Bundle layout:
    <bundle>/
      manifest.json        # described below
      app-release.aab      # path relative to bundle, as named in manifest
      smoke.json           # path relative to bundle, as named in manifest

Manifest schema (all strings unless noted):
    {
      "applicationId": "com.owner.chosen.id",
      "versionCode": 7,
      "versionName": "1.1.0",
      "aab": "app-release.aab",
      "privacyPolicyUrl": "https://...",
      "dataSafetyComplete": true,
      "appAccessInstructions": "test account provisioned via console...",
      "targetSdkVersion": 35,
      "internalTesters": ["tester@example.com"],
      "releaseNotes": "internal test build notes...",
      "smokeEvidence": "smoke.json"
    }

Exit codes: 0 ready, 1 blocked (expected until FF-025 + Console + device run),
2 usage error. Report is JSON on stdout.
"""

import argparse
import json
import re
import sys
from pathlib import Path

APP_ID_RE = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$")
PLACEHOLDER_IDS = {"__owner_to_decide__", "__todo__", "todo", "placeholder"}
SECRET_KEYS = (
    "keystorepassword",
    "keypassword",
    "privatekey",
    "serviceaccount",
    "service_account",
    "clientsecret",
    "client_secret",
)
REQUIRED_SMOKE_STEPS = {
    1: "sign-in",
    2: "expiring-session",
    3: "background/foreground",
    4: "deep-link",
    5: "alert-delivery",
    6: "context-upload",
    7: "sleep-toggle",
    8: "pr-approval",
    9: "offline/reconnect",
}


def _fail(checks, name, detail):
    checks.append({"check": name, "ok": False, "detail": detail})


def _pass(checks, name, detail="ok"):
    checks.append({"check": name, "ok": True, "detail": detail})


def _scan_for_secrets(obj, path="$"):
    """Return the first secret-like key path found, else None."""
    if isinstance(obj, dict):
        for key, value in obj.items():
            lowered = str(key).lower().replace(" ", "")
            if any(token in lowered for token in SECRET_KEYS):
                return f"{path}.{key}"
            hit = _scan_for_secrets(value, f"{path}.{key}")
            if hit:
                return hit
    elif isinstance(obj, list):
        for index, value in enumerate(obj):
            hit = _scan_for_secrets(value, f"{path}[{index}]")
            if hit:
                return hit
    return None


def evaluate(bundle: Path, manifest_name: str, allow_example_id: bool) -> dict:
    checks: list = []
    manifest_path = bundle / manifest_name
    if not manifest_path.is_file():
        _fail(checks, "manifestPresent", f"missing {manifest_name} in {bundle}")
        return {"ready": False, "checks": checks}

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        _fail(checks, "manifestParses", f"{manifest_name}: {exc}")
        return {"ready": False, "checks": checks}
    if not isinstance(manifest, dict):
        _fail(checks, "manifestParses", "manifest root must be an object")
        return {"ready": False, "checks": checks}
    _pass(checks, "manifestPresent", manifest_name)
    _pass(checks, "manifestParses")

    secret_hit = _scan_for_secrets(manifest)
    if secret_hit:
        _fail(checks, "noSecretsInManifest", f"secret-like key at {secret_hit}")
    else:
        _pass(checks, "noSecretsInManifest")

    app_id = manifest.get("applicationId", "")
    if not isinstance(app_id, str) or not APP_ID_RE.match(app_id):
        _fail(checks, "applicationIdChosen", f"invalid applicationId: {app_id!r}")
    elif app_id.lower() in PLACEHOLDER_IDS or app_id.startswith("__"):
        _fail(checks, "applicationIdChosen", "placeholder applicationId; owner must choose a real ID")
    elif app_id.startswith("com.example.") and not allow_example_id:
        _fail(checks, "applicationIdChosen", "example applicationId not allowed (use --allow-example-id for fixtures only)")
    else:
        _pass(checks, "applicationIdChosen", app_id)

    version_code = manifest.get("versionCode")
    if isinstance(version_code, int) and version_code > 0:
        _pass(checks, "versionCode", str(version_code))
    else:
        _fail(checks, "versionCode", f"must be a positive integer, got {version_code!r}")

    version_name = manifest.get("versionName", "")
    if isinstance(version_name, str) and version_name.strip():
        _pass(checks, "versionName", version_name)
    else:
        _fail(checks, "versionName", "missing versionName")

    aab_rel = manifest.get("aab", "")
    aab_path = bundle / aab_rel if isinstance(aab_rel, str) and aab_rel else None
    if aab_path is None or not aab_rel:
        _fail(checks, "aabPresent", "manifest 'aab' path missing")
    elif not aab_path.is_file():
        _fail(checks, "aabPresent", f"aab not found: {aab_rel}")
    elif aab_path.suffix != ".aab":
        _fail(checks, "aabPresent", f"not an .aab file: {aab_rel}")
    elif aab_path.stat().st_size == 0:
        _fail(checks, "aabPresent", f"aab is empty: {aab_rel}")
    else:
        _pass(checks, "aabPresent", f"{aab_rel} ({aab_path.stat().st_size} bytes)")

    policy_url = manifest.get("privacyPolicyUrl", "")
    if isinstance(policy_url, str) and policy_url.startswith("https://") and len(policy_url) > len("https://x"):
        _pass(checks, "privacyPolicy", policy_url)
    else:
        _fail(checks, "privacyPolicy", "privacyPolicyUrl must be a public https:// URL")

    if manifest.get("dataSafetyComplete") is True:
        _pass(checks, "dataSafety")
    else:
        _fail(checks, "dataSafety", "dataSafetyComplete must be true with Console evidence")

    access = manifest.get("appAccessInstructions", "")
    if isinstance(access, str) and len(access.strip()) >= 20:
        _pass(checks, "appAccessInstructions")
    else:
        _fail(checks, "appAccessInstructions", "describe reviewer access (>= 20 chars); credentials stay in Console")

    target_sdk = manifest.get("targetSdkVersion")
    if isinstance(target_sdk, int) and target_sdk > 0:
        _pass(checks, "targetSdk", str(target_sdk))
    else:
        _fail(checks, "targetSdk", f"targetSdkVersion must be a positive integer, got {target_sdk!r}")

    testers = manifest.get("internalTesters")
    if isinstance(testers, list) and testers and all(isinstance(t, str) and "@" in t for t in testers):
        _pass(checks, "internalTesters", f"{len(testers)} tester(s)")
    else:
        _fail(checks, "internalTesters", "at least one tester email required")

    notes = manifest.get("releaseNotes", "")
    if isinstance(notes, str) and len(notes.strip()) >= 10:
        _pass(checks, "releaseNotes")
    else:
        _fail(checks, "releaseNotes", "releaseNotes must be >= 10 chars")

    smoke_rel = manifest.get("smokeEvidence", "")
    smoke_path = bundle / smoke_rel if isinstance(smoke_rel, str) and smoke_rel else None
    if smoke_path is None or not smoke_rel:
        _fail(checks, "smokeEvidencePresent", "manifest 'smokeEvidence' path missing")
    elif not smoke_path.is_file():
        _fail(checks, "smokeEvidencePresent", f"smoke evidence not found: {smoke_rel}")
    else:
        _pass(checks, "smokeEvidencePresent", smoke_rel)
        try:
            smoke = json.loads(smoke_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            _fail(checks, "smokeEvidenceComplete", f"{smoke_rel}: {exc}")
            smoke = None
        if isinstance(smoke, dict):
            steps = smoke.get("steps")
            if not isinstance(steps, list):
                _fail(checks, "smokeEvidenceComplete", "'steps' must be a list of 9 results")
            else:
                by_id = {s.get("id"): s for s in steps if isinstance(s, dict)}
                missing = [i for i in REQUIRED_SMOKE_STEPS if i not in by_id]
                bad = [
                    i
                    for i, s in by_id.items()
                    if i in REQUIRED_SMOKE_STEPS and s.get("result") not in ("pass", "fail")
                ]
                failures = [i for i, s in by_id.items() if s.get("result") == "fail"]
                if missing or bad or len(steps) != 9:
                    _fail(
                        checks,
                        "smokeEvidenceComplete",
                        f"need steps 1-9 with pass/fail; missing={missing} bad={bad} count={len(steps)}",
                    )
                elif failures:
                    _fail(checks, "smokeEvidenceComplete", f"smoke failures at steps {sorted(failures)}")
                else:
                    _pass(checks, "smokeEvidenceComplete", "all 9 steps pass")
        elif smoke is not None:
            _fail(checks, "smokeEvidenceComplete", "smoke root must be an object")

    ready = all(c["ok"] for c in checks)
    return {"ready": ready, "checks": checks}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="FF-029 Play internal-track readiness gate (offline).")
    parser.add_argument("--bundle", required=True, help="directory holding manifest.json + artifacts")
    parser.add_argument("--manifest", default="manifest.json", help="manifest filename inside bundle")
    parser.add_argument(
        "--allow-example-id",
        action="store_true",
        help="allow com.example.* applicationId (fixtures/tests only)",
    )
    args = parser.parse_args(argv)
    bundle = Path(args.bundle)
    if not bundle.is_dir():
        print(json.dumps({"ready": False, "checks": [{"check": "bundlePresent", "ok": False, "detail": f"not a directory: {bundle}"}]}, indent=2))
        return 2
    report = evaluate(bundle, args.manifest, args.allow_example_id)
    print(json.dumps(report, indent=2))
    return 0 if report["ready"] else 1


if __name__ == "__main__":
    sys.exit(main())
