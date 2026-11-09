# FF-024 end-to-end private release signoff (E01)

Companion to the [milestone release evidence template](release-checklist.md).
That file defines the v1.0 gate; this file turns it into a deterministic,
tested check. Implementation:
[`scripts/ff024-release-signoff.py`](../../scripts/ff024-release-signoff.py).
Tests: [`tests/test_ff024_release_signoff.py`](../../tests/test_ff024_release_signoff.py).
Example evidence: [`examples/release-evidence.example.json`](../../examples/release-evidence.example.json).

## Scope

- Goal traceability: every release bundle names a `goal_id` and at least one
  done task with an `evidence_ref`, plus at least one merged PR.
- Merge policy: `develop` needs green checks plus an independent reviewer
  (never the author). `main` additionally needs a named owner approval pinned
  to the exact head SHA that has not expired.
- All 13 release-checklist gates must be `pass` with cited evidence. A gate
  marked `conditional` needs an issue link. Anything missing, unmet, unknown,
  or evidence-free fails closed.
- Fixture-only observations cap the decision at CONDITIONAL. Fixtures rehearse;
  they never prove a release.
- Secrets: `secrets_scan_clean` must be true, and the bundle itself is scanned
  for token/private-key patterns. Any hit fails.

## Usage

```sh
python3 scripts/ff024-release-signoff.py examples/release-evidence.example.json
python3 scripts/ff024-release-signoff.py evidence.json \
  --digest-out digest.md --json-out result.json
```

Exit codes: `0` PASS, `1` FAIL, `2` CONDITIONAL.

## Real vs fixture

This change ships no deployment and touches no live service. The gate logic
and its unit tests are real and executed here; any release digest produced
from `examples/release-evidence.example.json` is a format example until every
gate cites a live observation ref. Do not mark v1.0 shipped until the gate
reports PASS on real evidence with owner approval recorded.

## Coordinator review (PR #50): offline scope

Per coordinator review, this tool is an **offline, caller-supplied
evidence-bundle validator** with authority `offline-precheck`. It fetches
nothing from trusted systems, so it must not act as production release
authority: every digest and JSON result carries that disclaimer. The hard
integration gate G8 (`signoff.g8_live_verified`) is a required gate the tool
records but cannot verify; actual live signoff stays open until GitHub
checks, head SHA, deploy artifacts, security signoff and the owner decision
are independently verified. Integration is sequenced after #59 (real CI),
#60 (Paperclip-Orca integration) and the FF-018 merge gate fixes. A fixture
PASS is not owner acceptance: do not deploy and do not close issue #24 on
the strength of this tool.

## Residual risk

- Gate inputs (authN, head SHA freshness, check results) must come from
  trusted sources. Forged inputs defeat any policy; GitHub App/webhook
  verification is E16 scope.
- This gate does not replace the E17 rollback rehearsal or the E07 security
  regression gate; it only refuses to sign off without their evidence.
- Shared `tests/` and `examples/` directories overlap with other engineers'
  paths (E15 owns `tests/**`, E11 owns context examples). This PR only adds
  new `ff024`/`release-*` files; any collision should be coordinated through
  the integration lead rather than resolved by overwriting.
