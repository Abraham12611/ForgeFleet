#!/usr/bin/env python3
"""Secret/credential hygiene gate (standard library only).

Fails CI when tracked files contain likely credentials, tokens, or private
key material, or when private local paths are tracked in git.

Reads the tracked file list via `git ls-files` so untracked local secrets
(e.g. a developer's own `.env`) do not fail the build, while anything
actually committed does.
"""
import re
import subprocess
import sys
from pathlib import Path

import os

ROOT = Path(os.environ.get("FF_CI_ROOT", Path(__file__).resolve().parent.parent.parent))

# Literal credential patterns. Kept deliberately narrow to avoid false
# positives on documentation that merely names a variable (e.g. `API_KEY=`).
PATTERNS = {
    "github_token": re.compile(r"gh[pousr]_[A-Za-z0-9]{8,}"),
    "github_pat": re.compile(r"github_pat_[A-Za-z0-9_]{8,}"),
    "aws_access_key": re.compile(r"AKIA[0-9A-Z]{16}"),
    "aws_secret_assignment": re.compile(r"""aws_secret_access_key["'\s:=]+[A-Za-z0-9/+=]{16,}"""),
    "private_key_block": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY"),
    "slack_token": re.compile(r"xox[baprs]-[A-Za-z0-9-]{8,}"),
    "google_api_key": re.compile(r"AIza[0-9A-Za-z_-]{20,}"),
    "password_assignment": re.compile(
        r"""(?i)(password|passwd|client_secret|db_password)\s*[:=]\s*["'][^"']{4,}["']"""
    ),
}

# Tracked paths that must never be committed.
FORBIDDEN_TRACKED = (".env", "secrets/", "private-context/", "artifacts/private/")

# Files where scanner-looking strings legitimately appear (this scanner's own
# pattern definitions and docs that discuss token formats in the abstract).
ALLOWLIST_FILES = {"scripts/ci/check_hygiene.py"}


def tracked_files():
    """Tracked files in git; falls back to a working-tree walk outside repos.

    The fallback exists so `--prove-fail-closed` can exercise this gate
    against synthetic trees that are not git checkouts.
    """
    try:
        out = subprocess.run(
            ["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True
        )
        return [p for p in out.stdout.splitlines() if p]
    except (subprocess.CalledProcessError, FileNotFoundError):
        return [
            str(p.relative_to(ROOT))
            for p in ROOT.rglob("*")
            if p.is_file() and ".git/" not in str(p)
        ]


def main() -> int:
    failures: list[str] = []
    try:
        files = tracked_files()
    except subprocess.CalledProcessError as exc:
        print(f"ERROR: cannot list tracked files: {exc}")
        return 1

    for path in files:
        for forbidden in FORBIDDEN_TRACKED:
            if path == forbidden or path.startswith(forbidden):
                failures.append(f"{path}: forbidden tracked path ({forbidden})")

    for path in files:
        if path in ALLOWLIST_FILES:
            continue
        full = ROOT / path
        if not full.is_file():
            continue
        try:
            data = full.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue  # binary/unreadable: out of scope for literal scan
        for name, pattern in PATTERNS.items():
            for match in pattern.finditer(data):
                lineno = data.count("\n", 0, match.start()) + 1
                failures.append(f"{path}:{lineno}: possible {name}")

    if failures:
        print("Credential hygiene FAILED:")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print(f"OK: scanned {len(files)} tracked files, no credentials found")
    return 0


if __name__ == "__main__":
    sys.exit(main())
