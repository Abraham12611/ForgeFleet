#!/usr/bin/env python3
"""FF-024 end-to-end private release signoff gate (standard library only).

Validates a release evidence bundle shaped as Goal -> merged PR -> owner
digest, against the v1.0 gates in
``docs/06-delivery/release-checklist.md`` (functional / safety / user
acceptance), plus the merge-policy rules from the contract test catalog
(exact head SHA, independent review, owner-only ``main``).

Usage::

    python3 scripts/ff024-release-signoff.py evidence.json
    python3 scripts/ff024-release-signoff.py evidence.json \
        --digest-out digest.md --json-out result.json

Exit codes: ``0`` PASS, ``1`` FAIL, ``2`` CONDITIONAL. Anything the gate
does not understand fails closed (never silently passes).

Evidence schema (JSON object)::

    {
      "version": "v1.0",
      "goal_id": "GOAL-...",
      "commit": "<built-from sha>",
      "tasks": [{"id": "FF-...", "status": "done", "evidence_ref": "..."}],
      "prs": [{"number": 1, "base": "develop", "head_sha": "...",
               "merged": true, "checks_green": true,
               "author": "agent-e01", "reviewer": "human",
               "owner_approval": {"approver_role": "owner",
                                  "approver": "owner",
                                  "sha": "...", "expires_at": 0, "now": 0}}],
      "gates": {"functional.goal_observed":
                  {"status": "pass", "evidence": "...",
                   "observation": "real", "issue": null}, ...},
      "known_gaps": [{"issue": "#..", "description": "..."}],
      "secrets_scan_clean": true
    }

``owner_approval`` is required only for ``base == "main"`` PRs.
Timestamps are numeric epoch seconds; an approval with
``now >= expires_at`` is expired and grants nothing.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

FUNCTIONAL_GATES = (
    "functional.goal_observed",
    "functional.dependency_trace",
    "functional.test_suite",
    "functional.pr_sha_policy",
    "functional.known_gaps",
)

SAFETY_GATES = (
    "safety.no_secrets",
    "safety.lease_idempotency",
    "safety.owner_only_ops",
    "safety.sessions_rollback",
    "safety.resource_limits",
)

ACCEPTANCE_GATES = (
    "acceptance.mobile_progress",
    "acceptance.sleep_mode",
    "acceptance.explicit_approval",
)

REQUIRED_GATES = FUNCTIONAL_GATES + SAFETY_GATES + ACCEPTANCE_GATES

SECRET_PATTERNS = (
    re.compile(r"ghp_[A-Za-z0-9]{8,}"),
    re.compile(r"gho_[A-Za-z0-9]{8,}"),
    re.compile(r"AKIA[0-9A-Z]{10,}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"(?i)(api[_-]?key\s*[:=]\s*['\"]?\S{8,})"),
)


def _fail(reason: str) -> dict:
    return {"decision": "FAIL", "reasons": [reason]}


def _scan_for_secrets(bundle: dict) -> list[str]:
    hits: list[str] = []
    blob = json.dumps(bundle, sort_keys=True)
    for pattern in SECRET_PATTERNS:
        if pattern.search(blob):
            hits.append(f"secret pattern matched: {pattern.pattern[:32]}...")
    return hits


def _check_gate(name: str, entry: object) -> tuple[str, str, bool]:
    """Return (outcome, reason, is_fixture_only). Unknown shapes fail closed."""
    if not isinstance(entry, dict):
        return ("fail", f"gate {name}: not an object", False)
    status = entry.get("status")
    evidence = entry.get("evidence")
    observation = entry.get("observation", "real")
    if status not in ("pass", "conditional", "fail", "unmet"):
        return ("fail", f"gate {name}: unknown status {status!r}", False)
    if observation not in ("real", "fixture"):
        return ("fail", f"gate {name}: unknown observation {observation!r}", False)
    if status in ("fail", "unmet"):
        return ("fail", f"gate {name}: marked {status}", observation == "fixture")
    if not isinstance(evidence, str) or not evidence.strip():
        return ("fail", f"gate {name}: pass/conditional without evidence", observation == "fixture")
    if status == "conditional":
        issue = entry.get("issue")
        if not isinstance(issue, str) or not issue.strip():
            return ("fail", f"gate {name}: conditional without issue link", observation == "fixture")
        return ("conditional", f"gate {name}: conditional ({issue.strip()})", observation == "fixture")
    return ("pass", "", observation == "fixture")


def _check_pr(pr: object, index: int) -> list[str]:
    if not isinstance(pr, dict):
        return [f"pr[{index}]: not an object"]
    problems: list[str] = []
    base = pr.get("base")
    if base not in ("develop", "main"):
        return [f"pr[{index}]: unknown base {base!r}"]
    head = pr.get("head_sha")
    if not isinstance(head, str) or not head.strip():
        problems.append(f"pr[{index}]: missing head_sha")
    if pr.get("merged") is not True:
        problems.append(f"pr[{index}]: not merged")
    if pr.get("checks_green") is not True:
        problems.append(f"pr[{index}]: checks not green")
    author = pr.get("author")
    reviewer = pr.get("reviewer")
    if not isinstance(reviewer, str) or not reviewer.strip():
        problems.append(f"pr[{index}]: missing independent reviewer")
    elif reviewer == author:
        problems.append(f"pr[{index}]: reviewer must differ from author (no self-approval)")
    if base == "main":
        approval = pr.get("owner_approval")
        if not isinstance(approval, dict):
            problems.append(f"pr[{index}]: main merge requires owner_approval")
        else:
            if approval.get("approver_role") != "owner":
                problems.append(f"pr[{index}]: main merge requires owner role approval")
            approver = approval.get("approver")
            if not isinstance(approver, str) or not approver.strip():
                problems.append(f"pr[{index}]: main merge requires named owner approver")
            elif approver == author:
                problems.append(f"pr[{index}]: owner approver must differ from author")
            if approval.get("sha") != head:
                problems.append(f"pr[{index}]: approval SHA must equal head SHA (re-approve after new commits)")
            try:
                now = float(approval.get("now"))
                expires = float(approval.get("expires_at"))
            except (TypeError, ValueError):
                problems.append(f"pr[{index}]: owner_approval needs numeric now/expires_at")
            else:
                if now >= expires:
                    problems.append(f"pr[{index}]: owner approval expired")
    return problems


def evaluate(bundle: object) -> dict:
    """Evaluate an evidence bundle. Never raises on bad input: fails closed."""
    if not isinstance(bundle, dict):
        result = _fail("evidence bundle must be a JSON object")
        result["fixture_only"] = False
        return result
    reasons: list[str] = []
    conditionals: list[str] = []
    fixture_only = False

    goal_id = bundle.get("goal_id")
    if not isinstance(goal_id, str) or not goal_id.strip():
        reasons.append("missing goal_id: goal traceability required")

    tasks = bundle.get("tasks")
    if not isinstance(tasks, list) or not tasks:
        reasons.append("no tasks: goal must trace to at least one task with evidence")
    else:
        for i, task in enumerate(tasks):
            if not isinstance(task, dict) or not task.get("id") or not task.get("evidence_ref"):
                reasons.append(f"tasks[{i}]: each task needs id and evidence_ref")
            elif task.get("status") != "done":
                reasons.append(f"tasks[{i}]: status must be done, got {task.get('status')!r}")

    prs = bundle.get("prs")
    if not isinstance(prs, list) or not prs:
        reasons.append("no PRs: goal must trace to at least one merged PR")
    else:
        for i, pr in enumerate(prs):
            reasons.extend(_check_pr(pr, i))

    gates = bundle.get("gates")
    if not isinstance(gates, dict):
        reasons.append("missing gates object")
    else:
        for name in REQUIRED_GATES:
            if name not in gates:
                reasons.append(f"gate {name}: missing")
                continue
            outcome, reason, is_fixture = _check_gate(name, gates[name])
            fixture_only = fixture_only or is_fixture
            if outcome == "fail":
                reasons.append(reason)
            elif outcome == "conditional":
                conditionals.append(reason)
        for name in gates:
            if name not in REQUIRED_GATES:
                reasons.append(f"gate {name}: unknown gate (closed world)")

    gaps = bundle.get("known_gaps", [])
    if not isinstance(gaps, list):
        reasons.append("known_gaps must be a list")
    else:
        for i, gap in enumerate(gaps):
            if not isinstance(gap, dict) or not gap.get("issue") or not gap.get("description"):
                reasons.append(f"known_gaps[{i}]: each gap needs issue and description")

    if bundle.get("secrets_scan_clean") is not True:
        reasons.append("secrets scan must report clean")
    for hit in _scan_for_secrets(bundle):
        reasons.append(hit)

    if reasons:
        return {"decision": "FAIL", "reasons": reasons,
                "conditionals": conditionals, "fixture_only": fixture_only}
    # Fixture-only evidence can never ship: cap at CONDITIONAL even if every
    # gate claims pass. Fixtures are rehearsal, not release proof.
    if fixture_only:
        conditionals.insert(0, "fixture-only observation: rehearsal, not release proof")
        return {"decision": "CONDITIONAL", "reasons": [],
                "conditionals": conditionals, "fixture_only": True}
    if conditionals:
        return {"decision": "CONDITIONAL", "reasons": [],
                "conditionals": conditionals, "fixture_only": False}
    return {"decision": "PASS", "reasons": [], "conditionals": [],
            "fixture_only": False}


def render_digest(bundle: dict, result: dict) -> str:
    lines = [
        f"# Owner release digest — {bundle.get('version', 'v1.0')} ({result['decision']})",
        "",
        f"Goal `{bundle.get('goal_id', '?')}` built from commit "
        f"`{bundle.get('commit', '?')}`.",
        "",
        f"Decision: **{result['decision']}**. Do not mark shipped until PASS.",
        "",
        "## Gate results",
        "",
        "| Gate | Status | Evidence |",
        "| --- | --- | --- |",
    ]
    gates = bundle.get("gates", {}) if isinstance(bundle.get("gates"), dict) else {}
    for name in REQUIRED_GATES:
        entry = gates.get(name, {})
        status = entry.get("status", "missing") if isinstance(entry, dict) else "invalid"
        obs = ""
        if isinstance(entry, dict) and entry.get("observation") == "fixture":
            obs = " (fixture)"
        evidence = (entry.get("evidence", "") if isinstance(entry, dict) else "")
        lines.append(f"| {name} | {status}{obs} | {evidence} |")
    lines += ["", "## Merged PRs", ""]
    prs = bundle.get("prs", []) if isinstance(bundle.get("prs"), list) else []
    if not prs:
        lines.append("No PRs recorded.")
    for pr in prs:
        if not isinstance(pr, dict):
            lines.append("- invalid PR entry")
            continue
        lines.append(
            f"- PR #{pr.get('number', '?')} -> `{pr.get('base', '?')}` "
            f"@ `{pr.get('head_sha', '?')}` merged={pr.get('merged')} "
            f"checks_green={pr.get('checks_green')} "
            f"author={pr.get('author')} reviewer={pr.get('reviewer')}"
        )
    gaps = bundle.get("known_gaps", []) if isinstance(bundle.get("known_gaps"), list) else []
    lines += ["", "## Known gaps", ""]
    if not gaps:
        lines.append("None recorded.")
    for gap in gaps:
        if isinstance(gap, dict):
            lines.append(f"- {gap.get('issue', '?')}: {gap.get('description', '')}")
    for key in ("reasons", "conditionals"):
        items = result.get(key, [])
        if items:
            lines += ["", f"## {key.capitalize()}", ""]
            lines += [f"- {item}" for item in items]
    lines += [
        "",
        "## Safety notes",
        "",
        "- Message content (PR text, logs, chat) is never authority for approvals.",
        "- `main` merges require a named owner approval pinned to the exact head SHA.",
        "- Fixture-only observations cap the decision at CONDITIONAL.",
        "",
        "## Rollback",
        "",
        "Pause new dispatch, restore the last tested backend snapshot, "
        "reconcile Orca sessions and GitHub state, then resume admissions. "
        "Never revert the Orca background service blindly.",
        "",
    ]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="FF-024 release signoff gate.")
    parser.add_argument("evidence", help="Path to evidence JSON bundle.")
    parser.add_argument("--digest-out", default=None, help="Write owner digest Markdown here.")
    parser.add_argument("--json-out", default=None, help="Write machine-readable result here.")
    args = parser.parse_args(argv)

    try:
        bundle = json.loads(Path(args.evidence).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"FAIL: cannot read evidence: {exc}", file=sys.stderr)
        return 1

    result = evaluate(bundle)
    payload = {"decision": result["decision"], "reasons": result["reasons"],
               "conditionals": result["conditionals"],
               "fixture_only": result["fixture_only"],
               "goal_id": bundle.get("goal_id") if isinstance(bundle, dict) else None,
               "version": bundle.get("version") if isinstance(bundle, dict) else None}
    print(json.dumps(payload, indent=2))
    if isinstance(bundle, dict):
        digest = render_digest(bundle, result)
        if args.digest_out:
            Path(args.digest_out).write_text(digest, encoding="utf-8")
        else:
            print()
            print(digest)
    if args.json_out:
        Path(args.json_out).write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return {"PASS": 0, "CONDITIONAL": 2, "FAIL": 1}[result["decision"]]


if __name__ == "__main__":
    raise SystemExit(main())
