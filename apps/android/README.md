# Android packaging spike (FF-025)

**Status:** design/fixture spike — NOT a built app, NOT a signed AAB, NOT on-device evidence.

## Why a spike

FF-025 acceptance (signed AAB, auth/deep-links/notifications tested on a real
device) is blocked on prerequisites that do not exist in this repository yet:

- E12/E14: no `apps/web` responsive UI exists to package (`README.md` confirms
  this repo is specifications-only).
- E17: no Vultr API ingress, auth backend, or signing infrastructure exists.
- Owner input: per
  [ADR-0006](../../docs/08-decisions/ADR-0006-vercel-and-android.md) the Play
  package ID and domains remain OPEN — this spike must not guess them.
- No Android device, keystore, or Play Console access exists in this environment.

Per the E20 brief, a blocked engineer completes a read-only/design/fixture
spike. That is what `apps/android/**` currently holds.

## Contents

| File | Purpose |
| --- | --- |
| `capacitor.config.json` | Capacitor config template: placeholder ID, shared-source `webDir`, no remote URL |
| `android-manifest-spec.json` | Native manifest requirements: versioning, permissions, intent filters, icons |
| `deep-links.json` | Route table mapping links to screens from the mobile app map |
| `release-spec.json` | Machine-readable signing env names, build commands, track promotion order |
| `signing-and-release-checklist.md` | Human release checklist (internal track first, owner-gated promotion) |
| `on-device-test-plan.md` | On-device test matrix with evidence fields; all rows NOT EXECUTED |
| `check_packaging.py` | Validator enforcing the rules above (stdlib only) |
| `tests/test_android_packaging.py` | Fixture tests for the validator |

## Run it (CI-ready, stdlib only, no dependencies)

```sh
python3 apps/android/check_packaging.py
python3 -m unittest discover -s apps/android/tests -t . -v
```

Expected: validator `OK`, 7 fixture tests `OK`. Same discovery shape as the
sibling suites (`play-internal`, `pwa-prototype`) so CI can run them together.

## Related packages (same E20 ownership, different gates)

- `play-internal/` (FF-029): offline readiness gate for a real submission
  bundle. It **rejects** placeholder IDs by design; this package **requires**
  them. The two gates are complementary, not contradictory: this one guards
  fixture shape while blocked, that one guards a real bundle at submission time.
- `pwa-prototype/` (FF-019): responsive fixture UI proving the mobile
  acceptance walkthrough; the future Capacitor shell packages that web source.

## Rules enforced by `check_packaging.py`

1. `appId` is reverse-DNS shaped but carries a `placeholder`/`example` marker —
   it must never be mistaken for the owner-chosen release ID.
2. `webDir` is a relative local build output of the shared web source — never a
   remote Vercel URL (per the mobile app map: no WebView pointed at the website).
3. No secrets committed: only signing credential *names* are recorded, never values.
4. Every deep-link target names a screen from
   [mobile-app-map](../../docs/02-experience/mobile-app-map.md).
5. Release track order is internal → closed → production, with explicit
   owner approval before any promotion past internal testing.

## What unblocks the real FF-025

1. E12/E14 deliver a buildable `apps/web` bundle.
2. E17 delivers authenticated API ingress the app can reach.
3. Owner chooses the reverse-DNS application ID and domains (replacing placeholders).
4. Owner provides Play Console access + signing credentials via a secret manager.
5. A real device (including the owner's Samsung per the runbook) executes
   `on-device-test-plan.md` and the evidence fields are filled with observed results.

## References

- [ADR-0006](../../docs/08-decisions/ADR-0006-vercel-and-android.md)
- [Release runbook](../../docs/09-operations/vercel-and-play-release.md)
- [Android / narrow-web app map](../../docs/02-experience/mobile-app-map.md)
