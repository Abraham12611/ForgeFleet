"""Fake Orca runtime for FF-009 crash-after-launch reconciliation tests.

Fixture only: a deterministic, file-backed stand-in for the Orca user
service. It never shells out, never touches a real Orca daemon, and never
spawns worker processes. State lives in a caller-supplied directory so each
test gets an isolated runtime.

Persistence layout inside ``state_dir``::

    dispatches.json  list of {dispatch_id, idempotency_key, payload,
                     state, attempt_hint}

``dispatch_id`` values are deterministic counters (``fake-dispatch-0001``,
...) so test evidence is reproducible.
"""

import json
import os

DISPATCHES_FILE = "dispatches.json"


class FakeOrcaRuntime:
    """Minimal Orca stand-in: accepts launches, lists sessions, counts spawns."""

    def __init__(self, state_dir):
        self.state_dir = state_dir
        os.makedirs(self.state_dir, exist_ok=True)
        self._dispatches_path = os.path.join(self.state_dir, DISPATCHES_FILE)
        if not os.path.exists(self._dispatches_path):
            self._write_dispatches([])

    def _read_dispatches(self):
        with open(self._dispatches_path, "r", encoding="utf-8") as handle:
            return json.load(handle)

    def _write_dispatches(self, dispatches):
        tmp_path = self._dispatches_path + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as handle:
            json.dump(dispatches, handle, indent=2, sort_keys=True)
        os.replace(tmp_path, self._dispatches_path)

    @property
    def spawn_count(self):
        """Number of worker spawns accepted. Must stay 1 across a crash."""
        return len(self._read_dispatches())

    def dispatch(self, idempotency_key, payload):
        """Accept a launch. Same key + same payload replays the original.

        Same key + *different* payload is a conflict: returns ``(None,
        "conflict")`` with no side effect, mirroring contract case 2.
        """
        dispatches = self._read_dispatches()
        for record in dispatches:
            if record["idempotency_key"] == idempotency_key:
                if record["payload"] == payload:
                    return record, "replayed"
                return None, "conflict"
        record = {
            "dispatch_id": "fake-dispatch-%04d" % (len(dispatches) + 1),
            "idempotency_key": idempotency_key,
            "payload": payload,
            "state": "running",
            "attempt_hint": payload.get("attempt_hint"),
        }
        dispatches.append(record)
        self._write_dispatches(dispatches)
        return record, "accepted"

    def list_sessions(self):
        """Read-only session inventory used by reconciliation (F05 flow)."""
        return [
            {
                "externalId": record["dispatch_id"],
                "state": record["state"],
                "managed": True,
                "idempotency_key": record["idempotency_key"],
            }
            for record in self._read_dispatches()
        ]

    def mark_finished(self, dispatch_id, state="finished"):
        dispatches = self._read_dispatches()
        for record in dispatches:
            if record["dispatch_id"] == dispatch_id:
                record["state"] = state
        self._write_dispatches(dispatches)

    def drop_all_state(self):
        """Simulate total external-runtime loss (original provably gone)."""
        self._write_dispatches([])
