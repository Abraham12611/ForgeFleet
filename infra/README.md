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
| `orca-bridge` daemon (native user service) | `systemd/forgefleet-bridge.service` only — never compose | loopback `127.0.0.1:8787`, authenticated |
| Future public ingress | `ingress/Caddyfile.disabled.example` | **disabled**: do not enable until auth/realtime gates pass |

`example-orca-bridge.service` is the original minimal example and is kept
unchanged for reference. `systemd/` holds the hardened private-phase units.

## Single bridge process model (canonical FF-005 decision)

The bridge runs **only** as the systemd **user** unit
`systemd/forgefleet-bridge.service`, under the operator login UID (the same
unprivileged user that owns `orca-serve.service`). Compose owns `db` and
`paperclip` only — a `bridge` service in compose is a dual-supervisor bug:
deploy scripts refuse it and `selftest.sh` fails on it.

Why native instead of a container:

- The bridge execs the Orca user-session CLI (`ORCA_CLI_COMMAND`/`orca-ide`).
  Same-UID native execution inherits the login session context with zero
  credential mounts. Containerizing it would force mounting the CLI, the
  session bus, and home credentials into Docker — the exact exposure the
  private phase forbids. Compose therefore mounts no home directories
  (guarded by selftest).
- Ordering across the user/system manager boundary cannot use `After=`, so
  the unit gates startup at runtime: `wait-for-paperclip.sh` polls Paperclip
  health on loopback and fails closed on timeout.
- Writable state is the systemd `StateDirectory=forgefleet-bridge`
  (`~/.local/state/forgefleet-bridge`, operator-owned) plus explicit
  `ReadWritePaths` for that path only; `/var/lib` is unusable under
  `ProtectSystem=strict`. The copyable `bridge.env.example` ships NO
  `FORGEFLEET_BRIDGE_DATA_DIR` assignment (even an empty one would shadow
  the unit via `EnvironmentFile`), and the `guard-state-dir.sh`
  `ExecStartPre` refuses startup unless the value is nonempty and exactly
  `$STATE_DIRECTORY`. Proven by `tests/test-state-durability.sh`
  (disposable SQLite WAL write/snapshot/restore roundtrip, unprivileged)
  and `tests/test-state-dir.sh` (exact-match accept; empty, unset,
  mismatch, relative, `/var/lib`, missing, and unwritable values refused;
  unprivileged SQLite WAL roundtrip).
- The unit execs the Orca CLI resolved by `resolve_orca_cli` (per VPS
  finding #65: validated `ORCA_CLI_COMMAND`, then `~/.local/bin/orca-ide`,
  then the extracted `resources/bin/orca-ide` shim). The Electron GUI
  binary, bare `orca`, and any `--no-sandbox` workaround are refused.
- Backup/restore mirror exactly what exists: `pg_dump` + `context-store`
  volume (compose) + the native bridge state dir
  (`FORGEFLEET_BRIDGE_DATA_DIR`, default `~/.local/state/forgefleet-bridge`).

Server contract (reconciled with PR #63, FF-031): entrypoint
`node src/main.ts` (package.json start script, Node >=24, no dist build);
env `FORGEFLEET_BRIDGE_TOKEN` (required), `FORGEFLEET_BRIDGE_HOST`
(default `127.0.0.1`), `PORT` (default `4387`),
`FORGEFLEET_BRIDGE_DATA_DIR` (fixed by the unit to the StateDirectory —
the server's `./bridge-data` default is cwd-relative and wrong under a
daemon). Liveness `GET /v1/health/live` answers 200 `{ok, contractVersion}`
**without** a token; every other route requires the Bearer token (401
otherwise). Proven by `tests/test-bridge-contract.sh`: disposable node stub
with the exact surface, real `healthcheck.sh` probe, and auth
positive/negative cases — not regex.

Dispatch fencing is an operator hold, not an env var: the server ignores
dispatch-pause env vars and reconciles leases on restart
(`reconcileAfterRestart`, leases held unknown until proven). `restore.sh`
requires `RESTORE_FENCED=1`; after any restore the bridge must be restarted
and `/v1/attempts` verified before dispatch resumes; rollback prints the
same sequence and never issues service-manager verbs itself.

Health paths are single-sourced by variable name (`PAPERCLIP_HEALTH_PATH`
shared by compose and `healthcheck.sh`; `BRIDGE_HEALTH_PATH` shared by
`bridge.env.example` and `healthcheck.sh`, defaulting to the contract
`/v1/health/live`), so pinning the real Paperclip image (E01) changes one
value.

Coordination note: PR #51 (FF-022) sketches a different topology (bridge in
compose, port `4387`). This scaffold is the canonical private-phase path per
coordinator review; #51 rebases onto it after merge rather than landing a
parallel stack.

## Isolation guarantees (enforced, not just documented)

1. No manifest references `orca-serve.service` except in comments and the
   read-only preflight probe. Nothing here restarts, stops, or reconfigures it.
2. `scripts/deploy/*.sh` refuse any action matching `orca-serve` and fail
   closed on unknown subcommands. Deploy/rollback scripts require explicit
   `--apply`; the default is plan/dry-run output only.
3. Bridge binds loopback by default (`FORGEFLEET_BRIDGE_HOST=127.0.0.1`,
   `PORT=4387`). The systemd
   unit's `ExecStartPre` guard refuses to start on a non-loopback bind.
4. No secrets are committed. `*.env.example` files carry names and safe
   defaults only; real values come from the host secret manager or a
   mode-600 `*.env` file that is git-ignored (`/etc/forgefleet` for
   compose, `~/.config/forgefleet` for the user-unit bridge env).
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
#    paperclip/postgres env lives in /etc (compose); bridge env lives in the
#    operator home (native user unit). Run deploy as the operator user.
cp infra/paperclip.env.example /etc/forgefleet/paperclip.env
cp infra/postgres.env.example /etc/forgefleet/postgres.env
cp infra/bridge.env.example ~/.config/forgefleet/bridge.env
chmod 600 /etc/forgefleet/*.env ~/.config/forgefleet/bridge.env

# 3. Plan, then apply (compose stack only: db + paperclip).
./scripts/deploy/deploy-private.sh            # dry-run plan
./scripts/deploy/deploy-private.sh --apply    # real deploy

# 4. Enable the bridge user unit (operator login user, never root).
systemctl --user enable --now forgefleet-bridge.service

# 4. Verify loopback health (distinct live/ready states).
./scripts/deploy/healthcheck.sh

# 5. Backups / restore rehearsal / rollback.
./scripts/deploy/backup.sh --apply
./scripts/deploy/restore.sh                   # dry-run plan
./scripts/deploy/rollback-private.sh          # dry-run plan
```

Run `./scripts/deploy/selftest.sh` in CI or locally to verify scaffold
shape and isolation guards without Docker, secrets, or the VPS.

## Split-phase delta (FF-022, this PR, layered on the scaffold above)

The private stack stays exactly as documented above. FF-022 adds the
**opt-in** split topology for the Vercel/Vultr release, inactive by default:

- `docker-compose.private.yml` gains an `edge` service under
  `profiles: ["split"]` (Caddy reverse proxy, loopback-only ports).
  Default `up -d db paperclip` never starts it.
- `ingress/Caddyfile` is the staged active ingress: public allowlist only
  (`/healthz` unauthenticated; `/api`, `/auth`, `/socket.io` via
  `forward_auth`); explicit `404` for `/v1/*` and `/bridge/*`; no route
  ever dials the bridge. `ingress/Caddyfile.disabled.example` stays as the
  historical gated reference. Activation requires
  `deploy-split.sh --apply`, which fails closed while any S-01…S-07 row of
  `split-compatibility-matrix.md` is OPEN.
- `vercel/vercel.json` is preview-safe static frontend config (public API
  URL only, no secrets). No Vercel project is created by this repo.
- `backup.sh`/`restore.sh` additionally write/verify `manifest.json`
  (sha256 per artifact) and support `--fixture` rehearsals with no Docker.
- `deploy-split.sh` / `rollback-split.sh` extend the canonical
  `--apply`-gated scripts: split ingress start, contract-compatibility
  rollback gate (backend delegates to `rollback-private.sh`; Vercel
  promotion stays an explicit owner action, never automated).
- `verify-split.sh` prefers the **real** Caddy toolchain
  (`caddy validate` + adapted-JSON assertions) when a caddy binary is
  available, and says so; otherwise it labels its static fallback as such.
- `FF-022-vs-FF-005-reconciliation.md` records the one-path decisions and
  the comparison the coordinator review requested.
