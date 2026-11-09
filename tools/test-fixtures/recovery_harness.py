"""Bridge-side recovery ledger under test (fixture-grade model).

Composes the canonical ``FakeOrcaRuntime`` (``fake_orca.py``, owned jointly
with FF-009) instead of defining its own runtime. Implements the documented
recovery semantics at fixture level: idempotent dispatch ledger, monotonic
lease fencing, at-least-once receipts with (source, eventId) dedupe,
head-SHA-gated merges, sync-back gating, sleep-mode question queueing and
boot reconciliation. See docs/04-flows/failure-and-reconciliation.md,
docs/03-architecture/scaling-and-recovery.md,
docs/05-contracts/state-machines.md and docs/05-contracts/events.md.

DurableStore is the only object that survives a simulated crash: tests drop
the Bridge and rebuild it from the same store, mirroring a bridge restart
that must replay receipts/outbox and reconcile before retrying.

Key convention: idempotency keys are ``"<task_id>:<nonce>"`` so a restart
can attribute an adopted dispatch (one the crashed bridge never persisted)
to its task. The runtime inventory carries no payload, so a post-crash
adoption records the relaunching caller's payload hash; same-key/different-
payload conflicts are still detected whenever the ledger holds the original
(the persisted path, i.e. contract case 2).
"""

import json

from fake_orca import OrcaUnavailable


class ConflictError(Exception):
    """Same idempotency key reused with a different payload (409 analog)."""


class ActiveLeaseError(Exception):
    """Task already has an active attempt (second dispatch refused)."""


class MergeBlocked(Exception):
    """Merge refused: head moved, checks failing or policy denial."""


def _payload_hash(payload):
    return json.dumps(payload, sort_keys=True)


class DurableStore:
    """Crash-surviving state. Plain data; serializable for evidence."""

    def __init__(self):
        self.attempts = {}  # attempt_id -> attempt record
        self.by_key = {}  # idempotency key -> attempt_id
        self.task_generation = {}  # task_id -> fencing generation
        self.task_state = {}  # task_id -> task status string
        self.task_attempt = {}  # task_id -> active attempt_id or None
        self.seen_events = []  # [[source, event_id], ...] (list for JSON)
        self.outbox = []  # pending receipts not yet acked
        self.decisions = {}  # decision_id -> decision record
        self.pr_heads = {}  # pr_id -> {"head": sha, "approved_head": sha|None}
        self.questions = {}  # question_id -> {"state": queued|answered}
        self.incidents = []  # auditable blocked incidents
        self.notifications = []  # capacity / sleep-wake notices

    def to_json(self):
        return json.dumps(self.__dict__, sort_keys=True, indent=2)

    @classmethod
    def from_json(cls, text):
        store = cls()
        store.__dict__.update(json.loads(text))
        return store


def task_of_key(idempotency_key):
    return idempotency_key.split(":", 1)[0]


class Bridge:
    """Fixture bridge bound to a DurableStore and a FakeOrcaRuntime."""

    def __init__(self, store, orca, epoch=1):
        self.store = store
        self.orca = orca
        self.epoch = epoch
        self.sleeping = False
        self.webhook_connected = True
        self.github_truth = {}  # pr_id -> head sha (polled repo truth)
        self._attempt_seq = 0
        # Resume per-process counters from persisted attempts so attempt
        # ids stay unique across a simulated restart in one scenario.
        for attempt_id in store.attempts:
            try:
                n = int(attempt_id.split("-")[1])
                self._attempt_seq = max(self._attempt_seq, n)
            except (IndexError, ValueError):
                pass

    # -- dispatch ------------------------------------------------------
    def launch(self, task_id, idempotency_key, payload, persist_reply=True):
        """Idempotent launch. persist_reply=False simulates a crash after
        the runtime accepted the launch but before the bridge saved it."""
        payload_hash = _payload_hash(payload)
        if idempotency_key in self.store.by_key:
            existing_id = self.store.by_key[idempotency_key]
            existing = self.store.attempts[existing_id]
            if existing["payload_hash"] in (None, payload_hash):
                # Adopted (unpersisted pre-crash) records confirm their hash
                # on first post-crash relaunch; persisted ones must match.
                existing["payload_hash"] = payload_hash
                return existing_id, False  # deduped: no new dispatch
            raise ConflictError("key %r with different payload" % idempotency_key)
        active = self.store.task_attempt.get(task_id)
        if active is not None:
            raise ActiveLeaseError("task %s already has %s" % (task_id, active))
        stored_payload = dict(payload)
        stored_payload["task_id"] = task_id
        record, status = self.orca.dispatch(idempotency_key, stored_payload)
        external_id = record["dispatch_id"]
        if status == "replayed":
            # Crash window: runtime accepted under this key but the ledger
            # has no attempt. Adopt the original, no new spawn.
            return self._record_accept(
                task_of_key(idempotency_key), idempotency_key,
                payload_hash, external_id), True
        if not persist_reply:
            # Crash window: runtime accepted, bridge died before persisting.
            # Nothing in the durable store may reference this attempt yet.
            raise _CrashSimulated(external_id)
        return self._record_accept(
            task_id, idempotency_key, payload_hash, external_id), True

    def _record_accept(self, task_id, idempotency_key, payload_hash, external_id):
        self._attempt_seq += 1
        attempt_id = "attempt-%04d" % self._attempt_seq
        generation = self.store.task_generation.get(task_id, 0) + 1
        self.store.task_generation[task_id] = generation
        self.store.attempts[attempt_id] = {
            "attempt_id": attempt_id,
            "task_id": task_id,
            "idempotency_key": idempotency_key,
            "payload_hash": payload_hash,
            "external_id": external_id,
            "generation": generation,
            "epoch": self.epoch,
            "state": "running",
            "context_manifest": "ctx-%s" % task_id,
        }
        self.store.by_key[idempotency_key] = attempt_id
        self.store.task_attempt[task_id] = attempt_id
        self.store.task_state[task_id] = "running"
        return attempt_id

    # -- events ---------------------------------------------------------
    def apply_event(self, event):
        """Apply one runtime event. Returns True if it caused a state change.

        Dedupes on (source, eventId); ignores heartbeats/events from a
        fenced (older) generation or epoch.
        """
        key = [event["source"], event["eventId"]]
        if key in self.store.seen_events:
            return False
        attempt = self._attempt_for_event(event)
        if attempt is not None:
            if event.get("fencingEpoch", self.epoch) < attempt["epoch"]:
                self.store.seen_events.append(key)
                return False
            if event.get("generation", attempt["generation"]) < attempt["generation"]:
                self.store.seen_events.append(key)
                return False
        self.store.seen_events.append(key)
        etype = event["eventType"]
        if etype == "attempt.heartbeat":
            return False  # liveness only; never a logical transition
        if etype == "attempt.question":
            qid = event["data"]["questionId"]
            if self.sleeping:
                self.store.questions[qid] = {"state": "queued"}
            else:
                self.store.questions[qid] = {"state": "delivered"}
            return True
        if etype in ("attempt.finished", "attempt.failed"):
            if attempt is not None:
                attempt["state"] = "finished" if etype == "attempt.finished" else "failed"
            return True
        return False

    def _attempt_for_event(self, event):
        attempt_id = event.get("attemptId")
        if attempt_id and attempt_id in self.store.attempts:
            return self.store.attempts[attempt_id]
        return None

    def ack(self, receipt):
        """Acknowledge an outbox receipt (persist-then-ack only)."""
        if receipt in self.store.outbox:
            self.store.outbox.remove(receipt)

    # -- boot reconciliation --------------------------------------------
    def reconcile(self):
        """Boot protocol: read-only inventory, match external IDs, fence
        stale owners, reconnect or safely retry. Returns a report dict."""
        report = {"reattached": [], "retried": [], "quarantined": [], "unknown": []}
        try:
            live = self.orca.list_sessions()
        except OrcaUnavailable:
            for attempt_id, attempt in self.store.attempts.items():
                if attempt["state"] == "running":
                    attempt["state"] = "unknown"
                    self.store.task_state[attempt["task_id"]] = "unknown"
                    report["unknown"].append(attempt_id)
            return report
        live_keys = {s["idempotency_key"]: s for s in live}
        for attempt_id, attempt in self.store.attempts.items():
            if attempt["state"] not in ("running", "unknown"):
                continue
            session = live_keys.get(attempt["idempotency_key"])
            if session is not None:
                attempt["external_id"] = session["externalId"]
                if session["state"] == "running":
                    attempt["state"] = "running"
                    self.store.task_state[attempt["task_id"]] = "running"
                    report["reattached"].append(attempt_id)
                else:
                    attempt["state"] = session["state"]
                    report["reattached"].append(attempt_id)
            elif self.orca.prove_terminated(attempt.get("external_id")):
                self._fence_and_retry(attempt, report)
            else:
                # No runtime record and termination unproven: quarantine.
                attempt["state"] = "unknown"
                self.store.task_state[attempt["task_id"]] = "unknown"
                self.store.incidents.append(
                    {"attempt": attempt_id, "reason": "ambiguous-no-runtime-record",
                     "action": "operator must confirm termination before retry"})
                report["quarantined"].append(attempt_id)
        # Adopt dispatches the crashed bridge never persisted: the runtime
        # accepted them under a known key but the ledger has no attempt.
        for key, session in live_keys.items():
            if key not in self.store.by_key:
                attempt_id = self._record_accept(
                    task_of_key(key), key, None, session["externalId"])
                self.store.outbox.append({"adopted": attempt_id})
                report["reattached"].append(attempt_id)
        return report

    def _fence_and_retry(self, attempt, report):
        task_id = attempt["task_id"]
        self.store.task_generation[task_id] = attempt["generation"] + 1
        attempt["state"] = "retry_wait"
        self.store.task_state[task_id] = "retry_wait"
        self.store.task_attempt[task_id] = None
        report["retried"].append(attempt["attempt_id"])

    # -- finalize / sync-back gating ------------------------------------
    def finalize(self, attempt_id, sync_back_ok, pr_id=None):
        """Finalize an attempt. A failed workspace sync-back must block
        dependents: never report verified/done, release nothing."""
        attempt = self.store.attempts[attempt_id]
        task_id = attempt["task_id"]
        if not sync_back_ok:
            attempt["state"] = "finalize_failed"
            self.store.task_state[task_id] = "blocked"
            self.store.incidents.append(
                {"attempt": attempt_id, "reason": "sync-back-failed",
                 "action": "dependent tasks stay blocked until sync succeeds"})
            return "blocked"
        attempt["state"] = "submitted"
        self.store.task_state[task_id] = "submitted"
        if pr_id is not None:
            self.store.pr_heads.setdefault(pr_id, {"head": None, "approved_head": None})
        return "submitted"

    def verify(self, task_id):
        self.store.task_state[task_id] = "verified"

    # -- PR head / merge gating ------------------------------------------
    def open_pr(self, pr_id, head):
        self.store.pr_heads[pr_id] = {"head": head, "approved_head": None}
        self.github_truth[pr_id] = head

    def push_head(self, pr_id, head):
        """A new commit on the PR branch (seen via webhook or poll)."""
        if self.webhook_connected:
            self.store.pr_heads[pr_id]["head"] = head
        self.github_truth[pr_id] = head  # repo truth always moves

    def approve(self, pr_id, decision_id):
        head = self.store.pr_heads[pr_id]["head"]
        self.store.pr_heads[pr_id]["approved_head"] = head
        self.store.decisions[decision_id] = {
            "pr": pr_id, "head": head, "state": "answered"}

    def poll_github(self):
        """Restore path after a webhook outage: reconcile from repo truth."""
        for pr_id, head in self.github_truth.items():
            if pr_id in self.store.pr_heads:
                self.store.pr_heads[pr_id]["head"] = head

    def merge(self, pr_id, actor):
        pr = self.store.pr_heads[pr_id]
        if pr["approved_head"] is None:
            raise MergeBlocked("no owner approval recorded")
        if pr["approved_head"] != pr["head"]:
            old = pr["approved_head"]
            pr["approved_head"] = None
            self.store.decisions["reopened-%s" % pr_id] = {
                "pr": pr_id, "head": pr["head"], "state": "pending"}
            raise MergeBlocked(
                "head moved %s -> %s; approval invalidated" % (old, pr["head"]))
        if actor.get("type") != "owner":
            raise MergeBlocked("agent alone cannot merge to a protected branch")
        return pr["head"]

    # -- capacity / sleep -------------------------------------------------
    def mark_rate_limited(self, attempt_id):
        attempt = self.store.attempts[attempt_id]
        self.store.task_state[attempt["task_id"]] = "waiting_capacity"
        self.store.notifications.append(
            {"kind": "capacity", "attempt": attempt_id,
             "detail": "provider rate limit; context %s preserved"
                       % attempt["context_manifest"]})

    def clear_rate_limit(self, attempt_id):
        attempt = self.store.attempts[attempt_id]
        if self.store.task_state.get(attempt["task_id"]) == "waiting_capacity":
            self.store.task_state[attempt["task_id"]] = "running"

    def set_sleeping(self, value):
        self.sleeping = bool(value)
        if not value:
            self.store.notifications.append({"kind": "wake", "detail": "owner awake"})

    def answer_question(self, question_id):
        self.store.questions[question_id] = {"state": "answered"}


class _CrashSimulated(Exception):
    """Control-flow marker: bridge died between accept and persist."""

    def __init__(self, external_id):
        super(_CrashSimulated, self).__init__(
            "simulated crash after accept %s" % external_id)
        self.external_id = external_id
