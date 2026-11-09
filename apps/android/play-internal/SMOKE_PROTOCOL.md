# Real-device smoke protocol for Play internal testing (FF-029)

Maps to runbook §Android-3: "Test on real Android devices (including the owner's Samsung)".
No smoke run has been performed in this PR — the table below is the template a device run must fill in.

## Preconditions

- Internal-track build installed via the Play opt-in link on a physical device (record model + Android version).
- Test account available; backend API reachable over the same ingress the release uses (no `localhost`, no Tailscale-only URL — see ADR-0006 §2).
- Device clock correct; notifications allowed; app started from a killed state.

## Steps (all required)

| # | Step | Action | Expected | Record |
|---|---|---|---|---|
| 1 | Sign-in | Launch from killed state, sign in | Home dashboard loads, no web-only error | time, result |
| 2 | Expiring session | Invalidate/expire session, relaunch | Clear re-auth prompt, no silent failure | time, result |
| 3 | Background/foreground | Background 60s, foreground | State restored, freshness banner if stale | time, result |
| 4 | Deep link | Open project/task/inbox deep link | Correct screen, no full-restart loop | link, result |
| 5 | Alert delivery | Trigger a coordinator question | Notification/tray entry, inbox badge | time, result |
| 6 | Context upload | Attach a file via system picker | Upload listed on the task | filename, result |
| 7 | Sleep toggle | Toggle sleep, trigger noncritical question | Queued note shown, work continues | time, result |
| 8 | PR approval | Review a PR summary, approve | Approval recorded, auditable | PR ref, result |
| 9 | Offline/reconnect | Airplane mode 30s, reconnect | Offline indicator then reconciled state | time, result |

## Evidence file format

The gate accepts a JSON file shaped like:

```json
{
  "deviceModel": "Samsung Galaxy S24",
  "androidVersion": "14",
  "appVersion": "1.1.0 (versionCode 7)",
  "completedAt": "2026-11-09T10:00:00Z",
  "steps": [
    {"id": 1, "name": "sign-in", "result": "pass", "note": "home loaded in 2s"},
    {"id": 2, "name": "expiring-session", "result": "pass", "note": "re-auth prompt shown"}
  ]
}
```

Rules: every step 1–9 present exactly once, `result` is `pass` or `fail`, any `fail` blocks the gate with `smokeFailures`. An empty or missing file blocks with `smokeEvidenceMissing`. Do not paste credentials or tokens into notes.
