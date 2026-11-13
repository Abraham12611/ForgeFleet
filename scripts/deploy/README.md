# `scripts/deploy` — private-phase operator scripts (FF-005)

Owned by E17. All scripts are safe to read and to run without `--apply` on
any machine: the default is a dry-run plan or a read-only probe. Run deploy
scripts as the operator login user (docker group); never under sudo-root, so
`$HOME` resolves to the operator home holding `bridge.env`.

| Script | Default (no flags) | `--apply` |
|---|---|---|
| `provision-private.sh` | read-only preflight inventory | n/a (never mutates) |
| `deploy-private.sh` | prints plan, runs guards | starts `db paperclip` only (never the bridge) |
| `healthcheck.sh` | loopback probes (read-only) | n/a |
| `backup.sh` | prints plan | writes timestamped snapshot (db + context + bridge state dir) |
| `restore.sh` | prints plan | restores snapshot; requires fenced dispatch |
| `rollback-private.sh` | prints plan | reverts compose pins (bridge unit handled out of band) |
| `wait-for-paperclip.sh` | n/a (unit ExecStartPre) | n/a (fails closed on unhealthy Paperclip) |
| `selftest.sh` | fixture-only scaffold checks | n/a |
| `guard-loopback.sh` | refuses non-loopback `FORGEFLEET_BRIDGE_HOST` / non-numeric `PORT` | n/a (used as systemd `ExecStartPre`) |
| `lib/common.sh` | shared guards/helpers | n/a |

Hard rules (also enforced by `selftest.sh`): scripts never reference
`orca-serve.service` as a management target, never start a compose `bridge`
service (the bridge runs only as the systemd user unit), never emit a
mutating `systemctl` verb, never invoke a bare `orca` binary on Linux, and
never print secret values (presence is reported as `[set]`/`[missing]`).

## Split-phase delta (FF-022, layered on the table above)

Same conventions (`--apply` gate, dry-run default, no secret values). The
private scripts above are untouched in behavior; FF-022 only adds:

| Script | Default (no flags) | `--apply` |
|---|---|---|
| `deploy-split.sh` | plan + split-matrix gate check (fails closed on OPEN S-01…S-07) | starts `edge` profile only |
| `rollback-split.sh` | compatibility plan (refuses cross-contract frontend-only) | backend delegates to `rollback-private.sh`; frontend steps are owner actions |
| `verify-split.sh` | shape checks + real `caddy validate`/`adapt` when available | n/a |
| `verify-restore.sh` | fixture backup→restore→diff rehearsal | n/a |
| `tests/test_deploy_contracts.py` | stdlib contract suite (incl. canonical `selftest.sh`) | n/a |
