#!/usr/bin/env python3
"""SPEC-MANIFEST drift gate (standard library only).

Verifies that every file listed in SPEC-MANIFEST.json still hashes to its
recorded sha256. Adding new files never breaks this check; silently editing
a baselined spec/contract without updating the manifest does.
"""
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
MANIFEST = ROOT / "SPEC-MANIFEST.json"


def main() -> int:
    if not MANIFEST.is_file():
        print("ERROR: SPEC-MANIFEST.json is missing")
        return 1
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    entries = manifest.get("files_sha256", {})
    failures: list[str] = []
    checked = 0
    for rel, expected in entries.items():
        path = ROOT / rel
        if not path.is_file():
            failures.append(f"{rel}: listed in manifest but missing from tree")
            continue
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        checked += 1
        if actual != expected:
            failures.append(f"{rel}: sha256 drift (manifest {expected[:12]}…)")
    if failures:
        print("Manifest drift FAILED:")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print(f"OK: {checked}/{len(entries)} manifest entries match")
    return 0


if __name__ == "__main__":
    sys.exit(main())
