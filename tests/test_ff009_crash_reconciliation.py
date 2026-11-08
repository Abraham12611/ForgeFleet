"""FF-009: crash-after-launch reconciliation must never duplicate dispatch.

Fixture-level spike (E05/E06 have no implementation yet): these tests run a
fake Orca runtime plus a minimal durable-attempt model through the F05 crash
flow and assert the acceptance criterion -- no duplicate dispatch -- along
with the adjacent E15 requirements: duplicated/reordered events collapse to
one logical change, and ambiguous recovery never reports premature success.

Run: ``python3 -m unittest discover -s tests -v`` (standard library only).
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(
    0,
    os.path.join(os.path.dirname(__file__), "..", "tools", "test-fixtures"),
)

from fake_orca import FakeOrcaRuntime  # noqa: E402
from reconciliation_fixture import AttemptStore, reconcile_after_crash  # noqa: E402

IDEMPOTENCY_KEY = "ff009-test-key-0001"
PAYLOAD = {"task": "disposable-probe", "attempt_hint": "attempt-1"}


class CrashAfterLaunchTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)

    def test_crash_after_launch_reconciles_without_duplicate_dispatch(self):
        """Acceptance: launch accepted, bridge crashes pre-persist, restart
        reattaches the original. Exactly one spawn, no second dispatch."""
        runtime = FakeOrcaRuntime(os.path.join(self._tmp.name, "orca"))
        store = AttemptStore(os.path.join(self._tmp.name, "bridge"))

        record, status = runtime.dispatch(IDEMPOTENCY_KEY, PAYLOAD)
        self.assertEqual(status, "accepted")
        self.assertEqual(runtime.spawn_count, 1)

        persisted = store.save_receipt(
            IDEMPOTENCY_KEY,
            {"external_dispatch_id": record["dispatch_id"]},
            crash_before_persist=True,
        )
        self.assertFalse(persisted, "crash must discard the un-persisted reply")

        # Restart: fresh store handle over the same durable directory.
        restarted_store = AttemptStore(os.path.join(self._tmp.name, "bridge"))
        outcome = reconcile_after_crash(
            restarted_store, runtime, IDEMPOTENCY_KEY, PAYLOAD
        )

        self.assertEqual(outcome["action"], "reattached")
        self.assertFalse(outcome["spawned"])
        self.assertEqual(runtime.spawn_count, 1, "no double-spawn allowed")
        receipt = restarted_store.get_receipt(IDEMPOTENCY_KEY)
        self.assertIsNotNone(receipt)
        self.assertEqual(
            receipt["external_dispatch_id"], record["dispatch_id"]
        )
        self.assertNotEqual(receipt.get("state"), "verified",
                            "reconciliation must never claim verified")

    def test_duplicate_and_reordered_events_collapse_to_one_change(self):
        """Each runtime message delivered 3x and out of order still yields a
        single logical state change (contract test-cases: messages/events)."""
        store = AttemptStore(os.path.join(self._tmp.name, "bridge"))
        deliveries = [
            "evt-started-1", "evt-heartbeat-2", "evt-started-1",
            "evt-heartbeat-2", "evt-started-1", "evt-heartbeat-2",
        ]
        applied = sum(1 for event_id in deliveries
                      if store.record_event(event_id))
        self.assertEqual(applied, 2, "only first sighting of each event applies")

    def test_same_key_different_payload_conflicts_without_side_effect(self):
        """Contract case 2 at fixture level: key reuse with a changed payload
        is a 409-style conflict and must not spawn."""
        runtime = FakeOrcaRuntime(os.path.join(self._tmp.name, "orca"))
        _, status = runtime.dispatch(IDEMPOTENCY_KEY, PAYLOAD)
        self.assertEqual(status, "accepted")
        record, status = runtime.dispatch(
            IDEMPOTENCY_KEY, {"task": "something-else"})
        self.assertIsNone(record)
        self.assertEqual(status, "conflict")
        self.assertEqual(runtime.spawn_count, 1)

    def test_ambiguous_recovery_quarantines_instead_of_succeeding(self):
        """Original unrecoverable AND termination unproven: no silent retry,
        no ready, no verified -- an auditable blocked incident (F05)."""
        runtime = FakeOrcaRuntime(os.path.join(self._tmp.name, "orca"))
        store = AttemptStore(os.path.join(self._tmp.name, "bridge"))
        # Nothing was ever dispatched; fate is ambiguous, no budget claimed.
        outcome = reconcile_after_crash(
            store, runtime, "ff009-unknown-key", PAYLOAD,
            retry_budget_remaining=0, termination_proven=False,
        )
        self.assertEqual(outcome["action"], "quarantined")
        self.assertFalse(outcome["spawned"])
        self.assertEqual(runtime.spawn_count, 0)
        self.assertIsNone(store.get_receipt("ff009-unknown-key"))

    def test_proven_loss_with_budget_fences_before_any_retry(self):
        """Original provably gone + budget: retry allowed only under a new
        key with fencing -- the old key is never re-dispatched (no
        ``unknown -> ready`` without proof + fence)."""
        runtime = FakeOrcaRuntime(os.path.join(self._tmp.name, "orca"))
        store = AttemptStore(os.path.join(self._tmp.name, "bridge"))
        record, _ = runtime.dispatch(IDEMPOTENCY_KEY, PAYLOAD)
        runtime.mark_finished(record["dispatch_id"], state="finished")
        runtime.drop_all_state()  # external loss proven for this fixture
        outcome = reconcile_after_crash(
            store, runtime, IDEMPOTENCY_KEY, PAYLOAD,
            retry_budget_remaining=1, termination_proven=True,
        )
        self.assertEqual(outcome["action"], "fenced_retry")
        self.assertTrue(outcome["requires_new_key"])
        self.assertTrue(outcome["requires_fence"])
        self.assertEqual(runtime.spawn_count, 0,
                         "fixture itself must not relaunch; caller dispatches "
                         "once under the new key")


if __name__ == "__main__":
    unittest.main()
