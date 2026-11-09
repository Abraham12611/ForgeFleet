#!/usr/bin/env python3
"""Failure-injection scenario runner (fixture CLI).

Runs each documented crash scenario from
docs/04-flows/failure-and-reconciliation.md against the canonical
FakeOrcaRuntime (shared with FF-009) and prints a PASS/FAIL line plus
recovery evidence (spawn counts, reconcile reports, task states).
Stdlib only.

Usage:
  python3 tools/test-fixtures/run_scenarios.py [--scenario S1..S9 | --list]
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fake_orca import FakeOrcaRuntime
from recovery_harness import Bridge, DurableStore, MergeBlocked, _CrashSimulated


def ctx():
    tmp = tempfile.TemporaryDirectory()
    store = DurableStore()
    orca = FakeOrcaRuntime(os.path.join(tmp.name, "orca"))
    return tmp, store, orca, Bridge(store, orca)


def s1_crash_after_launch():
    tmp, store, orca, bridge = ctx()
    with tmp:
        try:
            bridge.launch("task-A", "task-A:001", {"goal": "demo"}, persist_reply=False)
        except _CrashSimulated:
            pass
        report = Bridge(store, orca, epoch=2).reconcile()
        ok = (orca.spawn_count == 1 and len(report["reattached"]) == 1
              and not report["retried"])
        return ok, "spawns=%d reattached=%s" % (orca.spawn_count, report["reattached"])


def s2_restart_three_workers():
    tmp, store, orca, bridge = ctx()
    with tmp:
        for i in range(3):
            bridge.launch("task-%d" % i, "task-%d:00%d" % (i, i), {"goal": "w%d" % i})
        report = Bridge(store, orca, epoch=2).reconcile()
        ok = orca.spawn_count == 3 and len(report["reattached"]) == 3
        return ok, "spawns=%d reattached=%d" % (orca.spawn_count, len(report["reattached"]))


def s3_orca_outage():
    tmp, store, orca, bridge = ctx()
    with tmp:
        attempt, _ = bridge.launch("task-D", "task-D:001", {"goal": "demo"})
        orca.set_available(False)
        rep1 = Bridge(store, orca, epoch=2).reconcile()
        orca.set_available(True)
        rep2 = Bridge(store, orca, epoch=3).reconcile()
        ok = (attempt in rep1["unknown"] and attempt in rep2["reattached"]
              and orca.spawn_count == 1)
        return ok, "spawns=%d unknown=%s reattached=%s" % (
            orca.spawn_count, rep1["unknown"], rep2["reattached"])


def s4_webhook_loss():
    tmp, store, orca, bridge = ctx()
    with tmp:
        bridge.open_pr("pr-1", "sha-A")
        bridge.webhook_connected = False
        bridge.push_head("pr-1", "sha-B")
        missed = store.pr_heads["pr-1"]["head"] == "sha-A"
        bridge.webhook_connected = True
        bridge.poll_github()
        ok = missed and store.pr_heads["pr-1"]["head"] == "sha-B"
        return ok, "head_after_poll=%s" % store.pr_heads["pr-1"]["head"]


def s5_duplicate_reorder():
    import random
    tmp, store, orca, bridge = ctx()
    with tmp:
        attempt, _ = bridge.launch("task-F", "task-F:001", {"goal": "demo"})
        stream = [{"source": "orca-bridge", "eventId": "e%d" % i,
                   "eventType": "attempt.heartbeat", "attemptId": attempt,
                   "data": {}} for i in range(5)]
        stream.append({"source": "orca-bridge", "eventId": "e-fin",
                       "eventType": "attempt.finished", "attemptId": attempt,
                       "data": {}})
        tripled = [e for e in stream for _ in range(3)]
        rng = random.Random(20261109)
        rng.shuffle(tripled)
        changes = sum(bridge.apply_event(e) for e in tripled)
        ok = changes == 1 and store.attempts[attempt]["state"] == "finished"
        return ok, "logical_changes=%d state=%s" % (changes, store.attempts[attempt]["state"])


def s6_syncback_failure():
    tmp, store, orca, bridge = ctx()
    with tmp:
        attempt, _ = bridge.launch("task-H", "task-H:001", {"goal": "demo"})
        first = bridge.finalize(attempt, sync_back_ok=False)
        blocked_ok = first == "blocked" and store.task_state["task-H"] == "blocked"
        second = bridge.finalize(attempt, sync_back_ok=True, pr_id="pr-9")
        bridge.verify("task-H")
        ok = blocked_ok and second == "submitted" and store.task_state["task-H"] == "verified"
        return ok, "first=%s final=%s" % (first, store.task_state["task-H"])


def s7_head_change():
    tmp, store, orca, bridge = ctx()
    with tmp:
        bridge.open_pr("pr-2", "sha-A")
        bridge.approve("pr-2", "dec-1")
        bridge.push_head("pr-2", "sha-B")
        try:
            bridge.merge("pr-2", {"type": "owner", "id": "op"})
            return False, "merge should have been refused after head move"
        except MergeBlocked:
            pass
        bridge.approve("pr-2", "dec-2")
        merged = bridge.merge("pr-2", {"type": "owner", "id": "op"})
        ok = merged == "sha-B" and store.decisions["reopened-pr-2"]["state"] == "pending"
        return ok, "merged=%s" % merged


def s8_rate_limit():
    tmp, store, orca, bridge = ctx()
    with tmp:
        attempt, _ = bridge.launch("task-I", "task-I:001", {"goal": "demo"})
        ctm = store.attempts[attempt]["context_manifest"]
        bridge.mark_rate_limited(attempt)
        waiting = store.task_state["task-I"] == "waiting_capacity"
        bridge.clear_rate_limit(attempt)
        ok = waiting and store.task_state["task-I"] == "running" \
            and store.attempts[attempt]["context_manifest"] == ctm \
            and orca.spawn_count == 1
        return ok, "state=%s spawns=%d" % (store.task_state["task-I"], orca.spawn_count)


def s9_sleep_questions():
    tmp, store, orca, bridge = ctx()
    with tmp:
        bridge.set_sleeping(True)
        for q in ("q-1", "q-2"):
            bridge.apply_event({"source": "orca-bridge", "eventId": q,
                                "eventType": "attempt.question",
                                "data": {"questionId": q}})
        queued = all(store.questions[q]["state"] == "queued" for q in ("q-1", "q-2"))
        bridge.verify("task-J")
        bridge.set_sleeping(False)
        for q in ("q-1", "q-2"):
            bridge.answer_question(q)
        ok = queued and all(store.questions[q]["state"] == "answered"
                            for q in ("q-1", "q-2"))
        return ok, "queued_then_answered=%s" % ok


SCENARIOS = [
    ("S1", "kill-after-launch", s1_crash_after_launch),
    ("S2", "paperclip-restart-3-workers", s2_restart_three_workers),
    ("S3", "orca-unavailable-10min", s3_orca_outage),
    ("S4", "github-webhook-loss", s4_webhook_loss),
    ("S5", "duplicate-reorder-3x", s5_duplicate_reorder),
    ("S6", "syncback-failure", s6_syncback_failure),
    ("S7", "pr-head-change", s7_head_change),
    ("S8", "provider-rate-limit", s8_rate_limit),
    ("S9", "owner-asleep-2-questions", s9_sleep_questions),
]


def main(argv):
    if "--list" in argv:
        for sid, name, _ in SCENARIOS:
            print("%s %s" % (sid, name))
        return 0
    wanted = [a for a in argv if not a.startswith("-")]
    selected = [s for s in SCENARIOS if not wanted or s[0] in wanted or s[1] in wanted]
    if not selected:
        print("unknown scenario; use --list")
        return 2
    failed = 0
    for sid, name, fn in selected:
        try:
            ok, detail = fn()
        except Exception as exc:  # noqa: BLE001 - runner must report, not crash
            ok, detail = False, "%s: %s" % (type(exc).__name__, exc)
        print("%s %s: %s (%s)" % (sid, name, "PASS" if ok else "FAIL", detail))
        failed += not ok
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
