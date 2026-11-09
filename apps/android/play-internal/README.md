# FF-029 — Google Play internal testing publication readiness gate

**Status: READINESS SCAFFOLD — BLOCKED on real publication prerequisites. No AAB has been built, no Play Console submission has been made, and no real-device smoke run has been performed in this PR.**

This package implements the E20 side of [FF-029](https://github.com/Abraham12611/ForgeFleet/issues/29): a deterministic, offline gate that tells the owner exactly what is missing before an internal-track release can be attempted, plus the policy checklist and smoke protocol the release runbook requires. It does **not** claim the issue acceptance criteria ("AAB accepted in internal track, Play policy checklist complete and real-device smoke evidence") are met.

## Why a readiness gate while blocked

Per the [E20 dispatch brief](../../../docs/06-delivery/dispatch/E20.md), E20 proceeds with a read-only/design/fixture spike while blocked. Current blockers:

- E12/E14 have no merged implementation (`apps/web` does not exist on `develop`); FF-015/FF-017 live on unmerged branches.
- FF-025 (signed Capacitor AAB + on-device tests) has no implementation on its branch — there is no AAB to submit.
- [ADR-0006](../../../docs/08-decisions/ADR-0006-vercel-and-android.md) leaves the exact application ID and Play package OPEN: "do not guess them". The [release runbook](../../../docs/09-operations/vercel-and-play-release.md) requires the owner to choose the ID and signing scheme before release identifiers are committed.
- No Google Play Console access, signing keys, or tester list exist in this repository (and must never be committed).

## What this package contains

All files live under `apps/android/play-internal/` (E20 ownership) and touch nothing else:

| File | Purpose |
|---|---|
| [INTERNAL_TRACK_CHECKLIST.md](INTERNAL_TRACK_CHECKLIST.md) | Play policy checklist mapped to runbook sections, with owner-gated items |
| [SMOKE_PROTOCOL.md](SMOKE_PROTOCOL.md) | Real-device smoke steps + evidence template (empty until a device run happens) |
| [check_play_internal_readiness.py](check_play_internal_readiness.py) | Offline gate: validates a submission bundle manifest, exits non-zero while blocked |
| [fixtures/placeholder-manifest.json](fixtures/placeholder-manifest.json) | Shape example with placeholder ID; gate **rejects** it by design |
| [tests/test_check_play_internal_readiness.py](tests/test_check_play_internal_readiness.py) | Stdlib unit tests for the gate |

Related but out of scope: PWA fixture prototype (`../pwa-prototype`, FF-019), Capacitor AAB build (FF-025), Vercel/Vultr ingress (E17), web UI (E12/E14).

## How to use

```sh
# 1. Copy the placeholder and fill it in OUTSIDE the repo (never commit keys).
cp apps/android/play-internal/fixtures/placeholder-manifest.json /tmp/play-bundle/manifest.json
# 2. Place the signed AAB + smoke evidence where the manifest points, then run:
python3 apps/android/play-internal/check_play_internal_readiness.py --bundle /tmp/play-bundle
```

Exit codes: `0` ready (all gates pass), `1` blocked (missing/invalid inputs — expected today), `2` usage error. Output is a JSON report on stdout; nothing is uploaded anywhere.

## Security rules enforced by the gate

- Manifest must not contain private key material, keystore passwords, or Play service-account JSON. Secrets travel via environment/Play Console, never in files.
- Placeholder application IDs (`__OWNER_TO_DECIDE__`, `com.example.*`) are rejected unless `--allow-example-id` is passed (tests/fixtures only).
- The gate never contacts Google Play; a passing gate means "bundle is complete", not "Play accepted it". Console confirmation remains the only acceptance proof.
