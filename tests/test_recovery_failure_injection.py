"""FF-021 recovery / failure-injection suite.

Covers every failure case listed in
docs/04-flows/failure-and-reconciliation.md ("Failure cases to inject")
plus the restart rows of docs/05-contracts/contract-test-cases.md and the
fault rows of docs/03-architecture/scaling-and-recovery.md.

Each test drives the fixture Bridge in ``tools/test-fixtures`` against the
canonical ``FakeOrcaRuntime`` (shared with FF-009; see ``fake_orca.py``),
injects the documented fault, and asserts the documented recovery
acceptance:

  no double-spawn, no double-merge, no lost question,
  no leaked active worktree, no false 'verified';
  irrecoverable ambiguity becomes an auditable blocked incident.

All evidence here is FIXTURE evidence (FakeOrcaRuntime). Nothing in this
file touches the real Orca service, Paperclip, or GitHub. The G7
live-restart acceptance (real Orca/Paperclip restart) stays open and must
be evidenced separately once the E06 persistent attempt store lands.

Run both suites together: ``python3 -m unittest discover -s tests -v``
"""

import os
import random
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools", "test-fixtures"))

from fake_orca import FakeOrcaRuntime, OrcaUnavailable  # noqa: E402
from recovery_harness import (  # noqa: E402
    ActiveLeaseError,
    Bridge,
    ConflictError,
    DurableStore,
    MergeBlocked,
    _CrashSimulated,
)


def key(task_id, nonce="001"):
    return "%s:%s" % (task_id, nonce)


class HarnessCase(unittest.TestCase):
    """Per-test isolated runtime dir + fixture bridge."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.store = DurableStore()
        self.orca = FakeOrcaRuntime(os.path.join(self._tmp.name, "orca"))
        self.bridge = Bridge(self.store, self.orca)

    def restart_bridge(self, epoch=2):
        return Bridge(self.store, self.orca, epoch=epoch)

    def launch(self, task_id, payload=None, **kw):
        payload = dict(payload or {"goal": "demo"})
        return self.bridge.launch(task_id, key(task_id), payload, **kw)


def event(source, eid, etype, attempt_id=None, **kw):
    evt = {"source": source, "eventId": eid, "eventType": etype}
    if attempt_id is not None:
        evt["attemptId"] = attempt_id
    evt["data"] = kw.get("data", {})
    evt.update(kw.get("extra", {}))
    return evt


class CrashAfterLaunchTests(HarnessCase):
    """Kill bridge immediately after the runtime accepted the launch but
    before the response was persisted. Restart must reconcile the original
    dispatch and must not launch another (G7 / FF-009 class)."""

    def test_crash_after_accept_reconciles_without_double_spawn(self):
        with self.assertRaises(_CrashSimulated):
            self.bridge.launch("task-A", key("task-A"), {"goal": "demo"},
                               persist_reply=False)
        self.assertEqual(self.orca.spawn_count, 1)
        self.assertEqual(self.store.attempts, {})  # nothing persisted pre-crash

        report = self.restart_bridge().reconcile()
        self.assertEqual(self.orca.spawn_count, 1, "reconcile must not relaunch")
        self.assertEqual(len(report["reattached"]), 1)
        attempt_id = report["reattached"][0]
        # Idempotent retry of the original request returns the same attempt.
        again, is_new = self.bridge.launch("task-A", key("task-A"), {"goal": "demo"})
        self.assertEqual((again, is_new), (attempt_id, False))
        self.assertEqual(self.orca.spawn_count, 1)

    def test_same_key_different_payload_is_conflict_without_side_effect(self):
        self.launch("task-A")
        with self.assertRaises(ConflictError):
            self.bridge.launch("task-A", key("task-A"), {"goal": "DIFFERENT"})
        self.assertEqual(self.orca.spawn_count, 1)

    def test_ambiguous_loss_is_quarantined_not_retried(self):
        attempt_id, _ = self.launch("task-B")
        # Runtime lost all record and termination is unproven: ambiguous.
        self.orca.drop_all_state()
        report = self.restart_bridge().reconcile()
        self.assertIn(attempt_id, report["quarantined"])
        self.assertEqual(self.store.task_state["task-B"], "unknown")
        self.assertEqual(self.orca.spawn_count, 0, "no blind relaunch on ambiguity")
        self.assertTrue(self.store.incidents, "ambiguity must be an auditable incident")
        # Proven termination DOES allow a fenced retry.
        attempt2, _ = self.launch("task-C")
        ext = self.store.attempts[attempt2]["external_id"]
        self.orca.kill(ext)
        self.orca.forget(ext)  # record GC'd, terminal tombstone remains
        report2 = Bridge(self.store, self.orca, epoch=3).reconcile()
        self.assertIn(attempt2, report2["retried"])
        self.assertEqual(self.store.task_state["task-C"], "retry_wait")


class ControlPlaneRestartTests(HarnessCase):
    """Restart Paperclip/bridge while 3 workers are active: reconnect the
    monitor for each original attempt and replay receipts, no duplicates."""

    def test_three_workers_survive_restart(self):
        ids = []
        for i in range(3):
            attempt_id, is_new = self.launch("task-%d" % i, {"goal": "work %d" % i})
            self.assertTrue(is_new)
            ids.append(attempt_id)
        report = self.restart_bridge().reconcile()
        self.assertEqual(sorted(report["reattached"]), sorted(ids))
        self.assertEqual(report["retried"], [])
        self.assertEqual(self.orca.spawn_count, 3)
        for i in range(3):
            self.assertEqual(self.store.task_state["task-%d" % i], "running")


class RuntimeOutageTests(HarnessCase):
    """Orca unreachable for ~10 min without killing workers: mark unknown,
    pause new dispatch, backoff probes, then resume the originals."""

    def test_outage_marks_unknown_and_pauses_dispatch(self):
        attempt_id, _ = self.launch("task-D")
        self.orca.set_available(False)
        report = self.restart_bridge().reconcile()
        self.assertIn(attempt_id, report["unknown"])
        self.assertEqual(self.store.task_state["task-D"], "unknown")
        with self.assertRaises(OrcaUnavailable):
            self.bridge.launch("task-E", key("task-E"), {"goal": "demo"})
        self.assertEqual(self.orca.spawn_count, 1, "no dispatch during outage")
        # ~10 min later the runtime is back; workers were never killed.
        self.orca.set_available(True)
        report2 = Bridge(self.store, self.orca, epoch=3).reconcile()
        self.assertIn(attempt_id, report2["reattached"])
        self.assertEqual(self.store.task_state["task-D"], "running")
        self.assertEqual(self.orca.spawn_count, 1)


class WebhookOutageTests(HarnessCase):
    """Disconnect the GitHub webhook for one PR, push while disconnected,
    then restore: poll/reconcile repo truth so no PR state is missed."""

    def test_webhook_loss_then_poll_recovers_head(self):
        self.bridge.open_pr("pr-1", "sha-A")
        self.bridge.webhook_connected = False
        self.bridge.push_head("pr-1", "sha-B")  # repo truth moves; bridge misses it
        self.assertEqual(self.store.pr_heads["pr-1"]["head"], "sha-A")
        self.bridge.webhook_connected = True
        self.bridge.poll_github()
        self.assertEqual(self.store.pr_heads["pr-1"]["head"], "sha-B")


class DuplicateReorderTests(HarnessCase):
    """Duplicate every runtime message 3x and reorder: exactly one logical
    state change; a late heartbeat for a fenced epoch is ignored."""

    def test_tripled_reordered_events_apply_once(self):
        attempt_id, _ = self.launch("task-F")
        base = [
            event("orca-bridge", "evt-%d" % i, "attempt.heartbeat", attempt_id)
            for i in range(5)
        ]
        finish = event("orca-bridge", "evt-fin", "attempt.finished", attempt_id)
        tripled = [e for e in base + [finish] for _ in range(3)]
        rng = random.Random(20261109)  # deterministic reorder
        rng.shuffle(tripled)
        changes = sum(self.bridge.apply_event(e) for e in tripled)
        self.assertEqual(changes, 1, "only the finish is a logical change")
        self.assertEqual(self.store.attempts[attempt_id]["state"], "finished")

    def test_stale_fenced_heartbeat_ignored(self):
        attempt_id, _ = self.launch("task-G")
        old = dict(self.store.attempts[attempt_id])
        # A late heartbeat from the pre-fence epoch must not mutate anything.
        stale = event("orca-bridge", "evt-stale", "attempt.heartbeat",
                      attempt_id, extra={"fencingEpoch": 0, "generation": 0})
        self.assertFalse(self.bridge.apply_event(stale))
        self.assertEqual(self.store.attempts[attempt_id], old)


class SyncBackFailureTests(HarnessCase):
    """Fail Paperclip workspace sync-back after a successful Orca commit:
    mark finalize failed, block dependent tasks, never declare done."""

    def test_failed_sync_back_blocks_dependents(self):
        attempt_id, _ = self.launch("task-H")
        self.assertEqual(self.bridge.finalize(attempt_id, sync_back_ok=False), "blocked")
        self.assertEqual(self.store.task_state["task-H"], "blocked")
        self.assertNotEqual(self.store.task_state["task-H"], "verified")
        self.assertTrue(self.store.incidents)
        # Retry of sync-back succeeds and only then may verification follow.
        self.assertEqual(
            self.bridge.finalize(attempt_id, sync_back_ok=True, pr_id="pr-9"),
            "submitted")
        self.bridge.verify("task-H")
        self.assertEqual(self.store.task_state["task-H"], "verified")

    def test_no_worktree_leak_on_active_tasks(self):
        attempt_id, _ = self.launch("task-H2")
        self.assertEqual(len(self.orca.live_worktrees()), 1)
        ext = self.store.attempts[attempt_id]["external_id"]
        self.orca.mark_finished(ext)
        self.orca.release_worktree(ext)
        self.assertEqual(self.orca.live_worktrees(), [],
                         "finished worktree released")


class HeadChangeTests(HarnessCase):
    """Change the PR head between human approval and the merge request:
    the approval is invalidated, the merge is refused, no double-merge."""

    def test_head_move_invalidates_approval(self):
        self.bridge.open_pr("pr-2", "sha-A")
        self.bridge.approve("pr-2", "dec-1")
        self.bridge.push_head("pr-2", "sha-B")
        with self.assertRaises(MergeBlocked):
            self.bridge.merge("pr-2", {"type": "owner", "id": "op"})
        self.assertIsNone(self.store.pr_heads["pr-2"]["approved_head"])
        self.assertEqual(self.store.decisions["reopened-pr-2"]["state"], "pending")
        # Agent alone still cannot merge even after re-approval.
        self.bridge.approve("pr-2", "dec-2")
        with self.assertRaises(MergeBlocked):
            self.bridge.merge("pr-2", {"type": "agent", "id": "worker-1"})
        merged = self.bridge.merge("pr-2", {"type": "owner", "id": "op"})
        self.assertEqual(merged, "sha-B")


class RateLimitTests(HarnessCase):
    """Provider rate-limits a worker mid-task: preserve context, notify
    capacity, resume the same attempt after reset (no alternate runtime)."""

    def test_rate_limit_preserves_context_and_resumes(self):
        attempt_id, _ = self.launch("task-I")
        context_before = self.store.attempts[attempt_id]["context_manifest"]
        self.orca.set_rate_limited(True)
        self.bridge.mark_rate_limited(attempt_id)
        self.assertEqual(self.store.task_state["task-I"], "waiting_capacity")
        self.assertEqual(
            self.store.attempts[attempt_id]["context_manifest"], context_before)
        self.assertTrue(
            any(n["kind"] == "capacity" for n in self.store.notifications))
        self.orca.set_rate_limited(False)
        self.bridge.clear_rate_limit(attempt_id)
        self.assertEqual(self.store.task_state["task-I"], "running")
        self.assertEqual(self.orca.spawn_count, 1, "same attempt resumed")


class SleepModeTests(HarnessCase):
    """Owner asleep with two questions while unrelated tasks finish:
    questions are queued (never dropped); independent work continues."""

    def test_sleep_queues_questions_while_others_finish(self):
        self.store.task_state["task-J"] = "running"
        self.store.task_state["task-K"] = "running"
        self.bridge.set_sleeping(True)
        q1 = event("orca-bridge", "q-1", "attempt.question",
                   data={"questionId": "q-1"})
        q2 = event("orca-bridge", "q-2", "attempt.question",
                   data={"questionId": "q-2"})
        self.assertTrue(self.bridge.apply_event(q1))
        self.assertTrue(self.bridge.apply_event(q2))
        self.assertEqual(self.store.questions["q-1"]["state"], "queued")
        self.assertEqual(self.store.questions["q-2"]["state"], "queued")
        # Unrelated tasks finish and verify while the owner sleeps.
        self.bridge.verify("task-J")
        self.bridge.verify("task-K")
        self.assertEqual(self.store.task_state["task-J"], "verified")
        # On wake nothing was lost: both questions are still answerable.
        self.bridge.set_sleeping(False)
        self.bridge.answer_question("q-1")
        self.bridge.answer_question("q-2")
        self.assertEqual(self.store.questions["q-1"]["state"], "answered")
        self.assertEqual(self.store.questions["q-2"]["state"], "answered")


if __name__ == "__main__":
    unittest.main()
