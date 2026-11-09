# `scripts/deploy` — private-phase operator scripts (FF-005)

Owned by E17. All scripts are safe to read and to run without `--apply` on
any machine: the default is a dry-run plan or a read-only probe.

| Script | Default (no flags) | `--apply` |
|---|---|---|
| `provision-private.sh` | read-only preflight inventory | n/a (never mutates) |
| `deploy-private.sh` | prints plan, runs guards | starts `db paperclip bridge` only |
| `healthcheck.sh` | loopback probes (read-only) | n/a |
| `backup.sh` | prints plan | writes timestamped snapshot |
| `restore.sh` | prints plan | restores snapshot; requires fenced dispatch |
| `rollback-private.sh` | prints plan | reverts to previous image pins |
| `selftest.sh` | fixture-only scaffold checks | n/a |
| `guard-loopback.sh` | refuses non-loopback `BRIDGE_BIND` | n/a (used as systemd `ExecStartPre`) |
| `lib/common.sh` | shared guards/helpers | n/a |

Hard rules (also enforced by `selftest.sh`): scripts never reference
`orca-serve.service` as a management target, never emit a mutating
`systemctl` verb, never invoke a bare `orca` binary on Linux, and never
print secret values (presence is reported as `[set]`/`[missing]`).
