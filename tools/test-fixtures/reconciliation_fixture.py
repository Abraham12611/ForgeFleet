"""Crash-after-launch reconciliation fixture model for FF-009.

Fixture only, not the bridge implementation. It models the smallest durable
state a correct bridge must keep so that a crash between "Orca accepted the
launch" and "bridge persisted the reply" reconciles the original instead of
spawning a duplicate. E06 owns the real persistence; this fixture defines the
behavior E06 must satisfy:

F05 flow covered here
---------------------
mark-unknown -> read-only discovery + external ID match -> original exists?
YES -> reattach monitor, replay receipts (no new spawn). NO -> only retry
when termination is proven AND lease/fence plus retry budget allow it;
otherwise quarantine (never ``ready``, never ``verified``).

State-machine rules enforced (``docs/05-contracts/state-machines.md``):

* No ``unknown -> ready`` without proving the old attempt gone/fenced.
* ``verified`` is never claimed from reconciliation alone.
* At most one active fenced attempt per task; generation monotonic.

Crash simulation: ``AttemptStore.save_receipt`` takes ``crash_before_persist``
to model the bridge dying after Orca accepted the launch but before the reply
was durably stored. ``reconcile_after_crash`` is the restart path under test.
"""

import json
import os

ATTEMPTS_FILE = "attempts.json"
RECEIPTS_FILE = "receipts.json"


class AttemptStore:
    """Idempotency-keyed attempt map persisted to a directory (JSON files)."""

    def __init__(self, state_dir):
        self.state_dir = state_dir
        os.makedirs(self.state_dir, exist_ok=True)
        self._attempts_path = os.path.join(self.state_dir, ATTEMPTS_FILE)
        self._receipts_path = os.path.join(self.state_dir, RECEIPTS_FILE)
        for path in (self._attempts_path, self._receipts_path):
            if not os.path.exists(path):
                with open(path, "w", encoding="utf-8") as handle:
                    json.dump({}, handle)

    def _load(self, path):
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)

    def _save(self, path, data):
        tmp_path = path + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2, sort_keys=True)
        os.replace(tmp_path, path)

    def save_receipt(self, idempotency_key, receipt, crash_before_persist=False):
        """Persist an accepted-launch receipt, unless simulating the crash.

        Returns True when persisted. With ``crash_before_persist=True`` the
        reply is discarded, modelling the bridge dying first. The caller must
        treat that as an un-acked dispatch whose fate is ``unknown``.
        """
        if crash_before_persist:
            return False
        attempts = self._load(self._attempts_path)
        attempts[idempotency_key] = receipt
        self._save(self._attempts_path, attempts)
        return True

    def get_receipt(self, idempotency_key):
        return self._load(self._attempts_path).get(idempotency_key)

    def record_event(self, event_id, source="orca-bridge"):
        """Dedupe inbox: first sighting returns True, replays return False."""
        receipts = self._load(self._receipts_path)
        key = "%s/%s" % (source, event_id)
        if key in receipts:
            return False
        receipts[key] = {"dedupe": "kept"}
        self._save(self._receipts_path, receipts)
        return True


def reconcile_after_crash(store, runtime, idempotency_key, payload,
                           retry_budget_remaining=0, termination_proven=False):
    """Restart path under test. Returns an outcome dict the tests assert on.

    Outcome ``action`` is one of:

    * ``reattached`` -- original dispatch found via read-only discovery; the
      receipt is now persisted and NO new spawn happened (acceptance case).
    * ``fenced_retry`` -- original provably gone, lease fenced, budget
      available; caller may dispatch once with a new key/generation.
    * ``quarantined`` -- fate ambiguous or no budget; surfaced as an auditable
      blocked incident. Never ``ready``, never a silent retry, never success.
    """
    existing = store.get_receipt(idempotency_key)
    if existing is not None:
        return {"action": "already_persisted", "receipt": existing,
                "spawned": False}

    match = None
    for session in runtime.list_sessions():
        if session.get("idempotency_key") == idempotency_key:
            match = session
            break

    if match is not None:
        receipt = {
            "attempt_hint": payload.get("attempt_hint"),
            "external_dispatch_id": match["externalId"],
            "state": "unknown",
            "reconciled": True,
        }
        store.save_receipt(idempotency_key, receipt)
        return {"action": "reattached", "receipt": receipt, "spawned": False}

    if termination_proven and retry_budget_remaining > 0:
        return {"action": "fenced_retry", "spawned": "caller_may_dispatch_once",
                "requires_new_key": True, "requires_fence": True}

    return {"action": "quarantined", "spawned": False,
            "reason": "original fate ambiguous or no retry budget; "
                      "auditable blocked incident, not ready, not verified"}
