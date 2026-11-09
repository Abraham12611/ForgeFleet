# On-device test plan (FF-025)

**Status: NOT EXECUTED.** No device run has happened in this environment.
Fill each evidence field with observed results when a real device run occurs.
Do not mark FF-025 accepted from fixtures or from this plan alone.

Device matrix (minimum): owner's Samsung + one second physical Android device
(runbook requirement includes the owner's Samsung). Record exact model + OS
version per run.

| # | Scenario (runbook §Android) | Steps | Expected | Result | Evidence |
| --- | --- | --- | --- | --- | --- |
| D1 | Sign-in on device | Fresh install → launch → sign in via owner auth | Authenticated home dashboard, no cached cross-user data | NOT EXECUTED | — |
| D2 | Expiring session | Shorten/idle out the session, then foreground the app | Secure session-expiry UI; no privileged content served from cache | NOT EXECUTED | — |
| D3 | Background / foreground lifecycle | Background 5+ min, foreground; repeat during live agent stream | State restores, stream reconnects, no duplicate actions fired | NOT EXECUTED | — |
| D4 | Deep links | Open `forgefleet:///inbox/<id>` and universal link to a task while signed in and signed out | Correct screen signed in; auth-first then resume when signed out | NOT EXECUTED | — |
| D5 | Push notifications | Trigger decision-needed alert server-side | Notification arrives; tap lands on the decision detail | NOT EXECUTED | — |
| D6 | Context upload (file picker) | Attach a file to coordinator chat from device storage | Upload succeeds, scoped reference appears in thread | NOT EXECUTED | — |
| D7 | Sleep / awake toggle | Toggle sleep, verify queued decisions; wake and answer one | Independent tasks continue; blocked items queue visibly; answer posts | NOT EXECUTED | — |
| D8 | PR approval review | Open PR summary for a CI-green change, approve per policy | Approval recorded with policy trace; `main` still owner-gated | NOT EXECUTED | — |
| D9 | Offline / reconnect | Airplane mode 2 min, then reconnect on task board | Offline indicator shown; fresh state on reconnect, no phantom writes | NOT EXECUTED | — |
| D10 | 360×800 + 412×915 walkthrough | Full mobile acceptance walkthrough per mobile-app-map | No horizontal scroll; all D1–D9 reachable at both widths | NOT EXECUTED | screenshots required |

## Evidence rules

- Each row needs: device model + Android version, app versionCode, tester,
  timestamp, and observed output (log excerpt or screenshot path).
- Failures file a bounded follow-up issue; they do not silently become
  "known limitations".
