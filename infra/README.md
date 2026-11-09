# Isolated VPS private deployment scaffold (FF-005)

Private-phase deployment for ForgeFleet on the Vultr VPS. This stack runs
**alongside** the operator's existing Orca user service and must never
disturb it: no restart, no config change, no shared scheduler.

- Topology and rollout: [infra-deployment](../docs/03-architecture/infra-deployment.md)
- Authority boundaries: [system-architecture](../docs/03-architecture/system-architecture.md)
- Pre/post checklists and rollback policy: [deployment-checklist](../docs/09-operations/deployment-checklist.md)
- Read-only Orca inspection: [runbook](../docs/09-operations/runbook.md)
- Release runbook: [vercel-and-play-release](../docs/09-operations/vercel-and-play-release.md)
- Isolation acceptance: `FF-005` — does not disturb the existing Orca service.

## What this scaffold provisions

| Piece | Manifest | Exposure |
|---|---|---|
| PostgreSQL (Paperclip data) | `docker-compose.private.yml` (`db`) | internal compose network only, no published port |
| Paperclip server + bundled UI (alpha) | `docker-compose.private.yml` (`paperclip`) | loopback `127.0.0.1` only, private/Tailscale reach |
| `orca-bridge` daemon | `docker-compose.private.yml` (`bridge`) + `systemd/forgefleet-bridge.service` | loopback or Unix socket only, authenticated |
| Future public ingress | `ingress/Caddyfile.disabled.example` | **disabled**: do not enable until auth/realtime gates pass |

`example-orca-bridge.service` is the original minimal example and is kept
unchanged for reference. `systemd/` holds the hardened private-phase units.

## Isolation guarantees (enforced, not just documented)

1. No manifest references `orca-serve.service` except in comments and the
   read-only preflight probe. Nothing here restarts, stops, or reconfigures it.
2. `scripts/deploy/*.sh` refuse any action matching `orca-serve` and fail
   closed on unknown subcommands. Deploy/rollback scripts require explicit
   `--apply`; the default is plan/dry-run output only.
3. Bridge binds loopback by default (`BRIDGE_BIND=127.0.0.1:8787`). The systemd
   unit's `ExecStartPre` guard refuses to start on a non-loopback bind.
4. No secrets are committed. `*.env.example` files carry names and safe
   defaults only; real values come from the host secret manager or a
   root-only `*.env` file that is git-ignored.
5. Bare `orca` is never invoked on Linux. Preflight resolves
   `ORCA_CLI_COMMAND` first, then a version-matched `orca-ide` binary.
6. Backups never capture secrets, and restores never resume leases as
   runnable: dispatch stays paused until Orca/GitHub state is reconciled.

## Prerequisites (all OPEN until evidenced on the host)

- Vultr CPU/RAM/disk inventoried read-only; Paperclip release pinned
  (see [version-pins](../docs/07-research/version-pins.md) — currently TBD).
- Tailscale admin access works; operator Orca service healthy.
- `ORCA_CLI_COMMAND` (or version-matched `orca-ide`) resolved read-only.
- GitHub test repo selected (delivery phases only).

E01 (Paperclip pin) and E07 (auth/policy) are unsatisfied, so image tags,
health-endpoint paths, and auth wiring below are explicit placeholders
marked `TBD`. Do not treat a successful `selftest.sh` run as integration
evidence: it validates scaffold shape and guards using fixtures only.

## Usage

```bash
# 1. Read-only preflight — touches nothing, changes nothing.
./scripts/deploy/provision-private.sh

# 2. Copy examples, inject real values out of tree (root-only perms).
cp infra/paperclip.env.example /etc/forgefleet/paperclip.env
cp infra/bridge.env.example /etc/forgefleet/bridge.env
cp infra/postgres.env.example /etc/forgefleet/postgres.env
chmod 600 /etc/forgefleet/*.env

# 3. Plan, then apply.
./scripts/deploy/deploy-private.sh            # dry-run plan
./scripts/deploy/deploy-private.sh --apply    # real deploy

# 4. Verify loopback health (distinct live/ready states).
./scripts/deploy/healthcheck.sh

# 5. Backups / restore rehearsal / rollback.
./scripts/deploy/backup.sh --apply
./scripts/deploy/restore.sh                   # dry-run plan
./scripts/deploy/rollback-private.sh          # dry-run plan
```

Run `./scripts/deploy/selftest.sh` in CI or locally to verify scaffold
shape and isolation guards without Docker, secrets, or the VPS.
