#!/usr/bin/env python3
"""Seed ForgeFleet's issue-ready work breakdown into GitHub (dry-run by default).

Requires locally authenticated `gh` only for --apply. Does not create a repo.
Idempotency checks match the stable FF-### identifier in existing issue titles.
"""
from __future__ import annotations
import argparse
import re
import subprocess
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OWNER = "Abraham12611"

def parse_issues():
    text = (ROOT / "docs/06-delivery/work-breakdown.md").read_text()
    for line in text.splitlines():
        if re.match(r"^\| FF-\d{3} \|", line):
            parts = [p.strip() for p in line.strip().strip("|").split("|")]
            if len(parts) < 5:
                continue
            issue_id, version, owner, title, criteria = parts[:5]
            yield issue_id, version, owner, title, criteria

def gh(*args):
    p = subprocess.run(["gh", *args], text=True, capture_output=True)
    if p.returncode:
        raise RuntimeError(f"gh failed: {' '.join(args)}\n{p.stderr.strip()}")
    return p.stdout

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Actually create missing issues")
    parser.add_argument("--repo", default=f"{OWNER}/ForgeFleet")
    args = parser.parse_args()
    items = list(parse_issues())
    if len(items) != 29:
        raise SystemExit(f"Expected 29 backlog entries, found {len(items)}")
    existing_titles = []
    if args.apply:
        gh("auth", "status")
        gh("repo", "view", args.repo)
        existing = json.loads(gh("issue", "list", "--repo", args.repo, "--state", "all", "--limit", "500", "--json", "title"))
        existing_titles = [i["title"] for i in existing]
    created = 0
    for issue_id, version, owner, title, criteria in items:
        subject = f"[{version}] {issue_id} — {title}"
        if any(re.search(r"\b" + re.escape(issue_id) + r"\b", x) for x in existing_titles):
            print("SKIP", subject)
            continue
        body = (f"**Planning ID:** `{issue_id}`\n**Milestone target:** `{version}`\n"
                f"**Proposed engineer:** `{owner}`\n\n"
                f"## Outcome\n{title}\n\n"
                f"## Acceptance criteria\n{criteria}\n\n"
                f"## Required context\n"
                f"Read `AGENTS.md`, `docs/INDEX.md`, `docs/06-delivery/roadmap.md`, "
                f"`docs/06-delivery/dependencies.md`, and "
                f"`docs/06-delivery/dispatch/{owner}.md`.\n\n"
                f"## PR and evidence policy\n"
                f"Own a bounded branch/worktree, cite actual tests and runtime evidence, "
                f"open PR to `develop`, and **never self-merge**. "
                f"Ask the coordinator before touching another engineer's paths.\n")
        if args.apply:
            url = gh("issue", "create", "--repo", args.repo, "--title", subject, "--body", body).strip()
            print("CREATED", subject, url)
        else:
            print("DRY RUN", subject)
        created += 1
    print(f"{'Created' if args.apply else 'Would create'} {created} issue(s) in {args.repo}.")

if __name__ == '__main__':
    main()
