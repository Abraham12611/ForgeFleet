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

FF-021 extension (additive only; every FF-009 API and signature is
unchanged): availability outages (``set_available`` / ``OrcaUnavailable``),
provider rate limits (``set_rate_limited`` / ``RateLimited``), worktree
leases (``live_worktrees`` / ``release_worktree``), and termination proof
(``kill`` / ``forget`` / ``prove_terminated`` with a tombstone file that
survives session-record GC). New fault flags default to off, so existing
FF-009 behavior is identical when they are never touched.
"""

import json
import os

DISPATCHES_FILE = "dispatches.json"
TOMBSTONES_FILE = "tombstones.json"
WORKTREES_FILE = "worktrees.json"


class OrcaUnavailable(Exception):
    """Raised when the fake runtime is unreachable (outage probe)."""


class RateLimited(Exception):
    """Raised when the fake provider reports rate limiting."""


class FakeOrcaRuntime:
    """Minimal Orca stand-in: accepts launches, lists sessions, counts spawns."""

    def __init__(self, state_dir):
        self.state_dir = state_dir
        os.makedirs(self.state_dir, exist_ok=True)
        self._dispatches_path = os.path.join(self.state_dir, DISPATCHES_FILE)
        self._tombstones_path = os.path.join(self.state_dir, TOMBSTONES_FILE)
        self._worktrees_path = os.path.join(self.state_dir, WORKTREES_FILE)
        if not os.path.exists(self._dispatches_path):
            self._write_dispatches([])
        if not os.path.exists(self._tombstones_path):
            self._write_json(self._tombstones_path, [])
        if not os.path.exists(self._worktrees_path):
            self._write_json(self._worktrees_path, {})
        # In-process fault flags (not persisted: they model live conditions,
        # and every test constructs a fresh runtime per scenario).
        self._available = True
        self._rate_limited = False

    def _read_dispatches(self):
        with open(self._dispatches_path, "r", encoding="utf-8") as handle:
            return json.load(handle)

    def _write_dispatches(self, dispatches):
        tmp_path = self._dispatches_path + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as handle:
            json.dump(dispatches, handle, indent=2, sort_keys=True)
        os.replace(tmp_path, self._dispatches_path)

    @staticmethod
    def _read_json(path):
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)

    @staticmethod
    def _write_json(path, data):
        tmp_path = path + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2, sort_keys=True)
        os.replace(tmp_path, path)

    @property
    def spawn_count(self):
        """Number of worker spawns accepted. Must stay 1 across a crash."""
        return len(self._read_dispatches())

    def dispatch(self, idempotency_key, payload):
        """Accept a launch. Same key + same payload replays the original.

        Same key + *different* payload is a conflict: returns ``(None,
        "conflict")`` with no side effect, mirroring contract case 2.

        Raises ``OrcaUnavailable`` while the runtime is down and
        ``RateLimited`` while the provider is throttling (FF-021).
        """
        if not self._available:
            raise OrcaUnavailable("fake orca unreachable")
        if self._rate_limited:
            raise RateLimited("fake provider rate limit")
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
        if not self._available:
            raise OrcaUnavailable("fake orca unreachable during inventory")
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
        self._write_json(self._tombstones_path, [])
        self._write_json(self._worktrees_path, {})

    # -- FF-021 failure-injection capabilities (additive) ------------------

    def set_available(self, value):
        """Toggle runtime reachability (S3 outage simulation)."""
        self._available = bool(value)

    def set_rate_limited(self, value):
        """Toggle provider throttling (S8 simulation)."""
        self._rate_limited = bool(value)

    def kill(self, dispatch_id, state="killed"):
        """Mark a dispatch terminal AND record a termination tombstone.

        Unlike ``mark_finished``, the tombstone survives ``forget`` so a
        later reconcile can prove the original is gone (fenced retry) even
        after its session record is GC'd. Absent records with no tombstone
        stay ambiguous and must quarantine.
        """
        self.mark_finished(dispatch_id, state=state)
        tombstones = self._read_json(self._tombstones_path)
        if dispatch_id not in tombstones:
            tombstones.append(dispatch_id)
            self._write_json(self._tombstones_path, tombstones)

    def forget(self, dispatch_id):
        """Drop a session record (runtime GC); the tombstone remains."""
        dispatches = [r for r in self._read_dispatches()
                      if r["dispatch_id"] != dispatch_id]
        self._write_dispatches(dispatches)

    def prove_terminated(self, dispatch_id):
        """True only with a terminal tombstone or terminal record state."""
        if dispatch_id in self._read_json(self._tombstones_path):
            return True
        for record in self._read_dispatches():
            if record["dispatch_id"] == dispatch_id:
                return record["state"] in ("finished", "failed", "killed")
        return False

    def worktree_id(self, dispatch_id):
        return "wt-%s" % dispatch_id

    def release_worktree(self, dispatch_id):
        """Release a finished attempt's worktree lease."""
        worktrees = self._read_json(self._worktrees_path)
        worktrees[dispatch_id] = {"released": True}
        self._write_json(self._worktrees_path, worktrees)

    def live_worktrees(self):
        """Worktrees backing still-running, unreleased dispatches."""
        worktrees = self._read_json(self._worktrees_path)
        return sorted(
            self.worktree_id(record["dispatch_id"])
            for record in self._read_dispatches()
            if record["state"] == "running"
            and not worktrees.get(record["dispatch_id"], {}).get("released", False)
        )
