# Test fixtures for failure injection (E15)

Fixture-grade fakes for the FF-021 recovery suite. They model the
documented contracts; they are **not** production code and **not**
evidence of integration with real Orca / Paperclip / GitHub.

- `fake_orca.py` — canonical FakeOrcaRuntime shared with FF-009
  (file-backed dispatch accounting, read-only inventory) **extended
  additively** for FF-021: availability outages, rate limits, worktree
  leases, kill/forget with terminal tombstones. The FF-009 API is intact.
- `recovery_harness.py` — bridge-side ledger under test (idempotency,
  lease fencing, dedupe, reconcile, merge/head-SHA gating, sleep queue).
- `run_scenarios.py` — CLI runner: `python3 tools/test-fixtures/run_scenarios.py [--list]`.

The authoritative suite is `tests/test_recovery_failure_injection.py`:

  python3 -m unittest discover -s tests -v

Prerequisites E05/E06 have no implementation in this tree yet (specs
only), so this harness is a read-only/design/fixture spike per the E15
brief: it pins the expected recovery semantics so E05/E06 implementers
can test against it later.
