"""FF-024: end-to-end private release signoff gate must decide PASS / FAIL /
CONDITIONAL deterministically, failing closed on every untrusted input.

Run: ``python3 -m unittest discover -s tests -v`` (standard library only).
"""

import importlib.util
import os
import unittest


def _load_gate():
    path = os.path.join(
        os.path.dirname(__file__), "..", "scripts", "ff024-release-signoff.py")
    spec = importlib.util.spec_from_file_location("ff024_release_signoff", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


evaluate = _load_gate().evaluate


def _gate(evidence="seen live", observation="real", status="pass", issue=None):
    entry = {"status": status, "evidence": evidence, "observation": observation}
    if issue is not None:
        entry["issue"] = issue
    return entry


def _passing_gates(**overrides):
    gates = {
        "functional.goal_observed": _gate("goal GOAL-1 observed live"),
        "functional.dependency_trace": _gate("tasks trace to evidence refs"),
        "functional.test_suite": _gate("unittest + spec links green"),
        "functional.pr_sha_policy": _gate("head SHA pinned, checks green"),
        "functional.known_gaps": _gate("no gaps"),
        "safety.no_secrets": _gate("scan clean"),
        "safety.lease_idempotency": _gate("no duplicate dispatch"),
        "safety.owner_only_ops": _gate("agents blocked from owner ops"),
        "safety.sessions_rollback": _gate("sessions intact, restore rehearsed"),
        "safety.resource_limits": _gate("within budget caps"),
        "acceptance.mobile_progress": _gate("phone walkthrough done"),
        "acceptance.sleep_mode": _gate("sleep queues, work continues"),
        "acceptance.explicit_approval": _gate("owner approved release"),
    }
    gates.update(overrides)
    return gates


def _bundle(**overrides):
    bundle = {
        "version": "v1.0",
        "goal_id": "GOAL-private-release",
        "commit": "abc123",
        "tasks": [{"id": "FF-024", "status": "done", "evidence_ref": "digest"}],
        "prs": [{
            "number": 100, "base": "develop", "head_sha": "deadbeef",
            "merged": True, "checks_green": True,
            "author": "agent-e01", "reviewer": "coordinator",
        }],
        "gates": _passing_gates(),
        "known_gaps": [],
        "secrets_scan_clean": True,
    }
    bundle.update(overrides)
    return bundle


class ReleaseSignoffTest(unittest.TestCase):
    def test_happy_path_passes(self):
        result = evaluate(_bundle())
        self.assertEqual(result["decision"], "PASS")
        self.assertEqual(result["reasons"], [])

    def test_fixture_only_caps_at_conditional(self):
        """Fixtures rehearse; they never prove a release. Even an all-pass
        fixture bundle must not ship."""
        gates = _passing_gates(**{
            "functional.goal_observed": _gate("fake run", observation="fixture"),
        })
        result = evaluate(_bundle(gates=gates))
        self.assertEqual(result["decision"], "CONDITIONAL")
        self.assertTrue(result["fixture_only"])

    def test_conditional_gate_with_issue_link_is_conditional(self):
        gates = _passing_gates(**{
            "functional.known_gaps": _gate(
                "deferred to FF-025", status="conditional", issue="#25"),
        })
        bundle = _bundle(
            gates=gates,
            known_gaps=[{"issue": "#25", "description": "deferred"}],
        )
        result = evaluate(bundle)
        self.assertEqual(result["decision"], "CONDITIONAL")
        self.assertEqual(result["reasons"], [])

    def test_conditional_without_issue_link_fails(self):
        gates = _passing_gates(**{
            "functional.known_gaps": _gate("deferred", status="conditional"),
        })
        result = evaluate(_bundle(gates=gates))
        self.assertEqual(result["decision"], "FAIL")

    def test_main_merge_without_owner_approval_fails(self):
        bundle = _bundle(prs=[{
            "number": 101, "base": "main", "head_sha": "deadbeef",
            "merged": True, "checks_green": True,
            "author": "agent-e01", "reviewer": "coordinator",
        }])
        result = evaluate(bundle)
        self.assertEqual(result["decision"], "FAIL")
        self.assertTrue(any("owner_approval" in r for r in result["reasons"]))

    def test_expired_owner_approval_grants_nothing(self):
        bundle = _bundle(prs=[{
            "number": 101, "base": "main", "head_sha": "deadbeef",
            "merged": True, "checks_green": True,
            "author": "agent-e01", "reviewer": "coordinator",
            "owner_approval": {"approver_role": "owner", "approver": "owner",
                               "sha": "deadbeef", "now": 200, "expires_at": 100},
        }])
        result = evaluate(bundle)
        self.assertEqual(result["decision"], "FAIL")
        self.assertTrue(any("expired" in r for r in result["reasons"]))

    def test_approval_sha_mismatch_fails(self):
        """Changed head SHA after approval reopens the decision (contract
        test-cases: GitHub section)."""
        bundle = _bundle(prs=[{
            "number": 101, "base": "main", "head_sha": "newsha",
            "merged": True, "checks_green": True,
            "author": "agent-e01", "reviewer": "coordinator",
            "owner_approval": {"approver_role": "owner", "approver": "owner",
                               "sha": "oldsha", "now": 50, "expires_at": 100},
        }])
        result = evaluate(bundle)
        self.assertEqual(result["decision"], "FAIL")
        self.assertTrue(any("head SHA" in r for r in result["reasons"]))

    def test_self_approved_develop_merge_fails(self):
        bundle = _bundle(prs=[{
            "number": 100, "base": "develop", "head_sha": "deadbeef",
            "merged": True, "checks_green": True,
            "author": "agent-e01", "reviewer": "agent-e01",
        }])
        result = evaluate(bundle)
        self.assertEqual(result["decision"], "FAIL")

    def test_secret_in_evidence_fails(self):
        bundle = _bundle()
        bundle["tasks"][0]["evidence_ref"] = "token ghp_abcdefgh12345678 leaked"
        result = evaluate(bundle)
        self.assertEqual(result["decision"], "FAIL")
        self.assertTrue(any("secret pattern" in r for r in result["reasons"]))

    def test_unknown_gate_fails_closed(self):
        gates = _passing_gates()
        gates["custom.anything"] = _gate("rogue")
        result = evaluate(_bundle(gates=gates))
        self.assertEqual(result["decision"], "FAIL")

    def test_missing_pr_linkage_fails(self):
        result = evaluate(_bundle(prs=[]))
        self.assertEqual(result["decision"], "FAIL")

    def test_non_object_bundle_fails_closed(self):
        for bad in (None, [], "PASS"):
            result = evaluate(bad)
            self.assertEqual(result["decision"], "FAIL")


if __name__ == "__main__":
    unittest.main()
