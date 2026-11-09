# FF-031 live smoke plan (owner-authorized Vultr/Linux Muse smoke)

**Status:** PLAN — explicitly not executed by FF-031. This is the gated
next step the issue requires: a real end-to-end demonstration on
owner-authorized infrastructure, after the fake-backend round trip is green
in CI. Do not run any of this without the owner's explicit, per-run
authorization, and never against the operator's existing Orca service.

## Gate to enter

- FF-031 merged to `develop` with CI green (fake-backend round trip,
  restart/no-duplicate, contract freeze check).
- Owner designates in the issue: (a) the Vultr host, (b) a disposable Linux
  user/service scope, (c) a disposable test repository, (d) confirmation
  that the existing `orca-serve.service` and active sessions stay untouched.
- Secrets provisioned by the owner out-of-band: `FORGEFLEET_BRIDGE_TOKEN`
  (fresh, single-purpose), Paperclip service identity, Tailscale scoping if
  remote observation is needed. No secrets in prompts, logs, or PRs.

## Procedure (disposable repo only)

1. **Pin check on the host.** Run `scripts/paperclip-pin-smoke.sh`
   (needs network): tag `v2026.1106.0` must resolve to
   `d69631b01b9c658f80bf8bed389863dce82643e1`. Abort on mismatch.
2. **Read-only discovery.** `systemctl --user status orca-serve.service`
   (status only, no restart), resolve the executable per E02
   (`ORCA_CLI_COMMAND` else version-matched `orca-ide`; never bare `orca`
   on Linux), capture `--version` and `orchestration --help` output
   (redacted) into the smoke log.
3. **Start the bridge.** `node services/orca-bridge/src/server.js` with
   `FORGEFLEET_BRIDGE_TOKEN`, `FORGEFLEET_BRIDGE_DATA_DIR` on an isolated
   volume, host `127.0.0.1`, test-ingest **disabled**
   (`FORGEFLEET_ALLOW_TEST_INGEST` unset). Record capabilities output.
4. **One disposable Muse attempt.** Through the pinned Paperclip adapter
   against the bridge: create attempt with a fresh idempotency key in the
   disposable repo, observe `accepted -> dispatching -> running`, then a
   worker-produced artifact synced back to the Paperclip cwd on finalize.
5. **Crash-after-launch proof.** Kill the bridge between launch and first
   event receipt, restart with the same data dir, and show: the original
   attempt reconciles (adopted or honestly `unknown`), and the retried key
   replays with **no second Orca dispatch** (compare dispatch IDs).
6. **Cancel proof.** Cancel with `reason` + `approvedBy`, show `cancelled`
   only after runtime confirmation; an unproven stop must read `unknown`
   with `confirmation: pending`.

## Abort / rollback (any step)

- Stop: `systemctl --user stop forge-fleet-bridge` (or kill the bridge
  process), cancel only the created disposable attempt, remove the
  disposable worktree/repo. Never touch other sessions.
- Ambiguous state: freeze dispatch (no new attempts), capture the state
  file and redacted logs, post them to this issue, and wait for the owner.
- Rollback is deletion of disposable artifacts only; no migration, no
  shared state, no production service to restore.

## Evidence to post back

Exact Orca/CLI versions, redacted discovery output, bridge commit + state
file hashes, attempt/dispatch/worktree IDs, ordered event transcript,
restart/reconcile report, cancel transcript, and any deviation from the
fake-backend behavior. Success advances G2/G3; any `unknown`-without-proof
or duplicate dispatch fails the smoke and reopens FF-031.
