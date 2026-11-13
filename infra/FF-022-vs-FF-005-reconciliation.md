# FF-022 vs FF-005 reconciliation — ONE authoritative path (E17)

Coordinator review on PR #51 asked E17 to consolidate the overlapping
implementations in PR #45 (FF-005, canonical private scaffold) and PR #51
(FF-022, split release rehearsal) into a single deployment/rollback path.
This file is that written comparison plus the decision record. PR #51 is
stacked on PR #45: behavior files it overlaps are merged, not duplicated.

## Rebase note (2026-11-13, onto `develop` @ `a662274`)

PR #45 squash-merged as `a662274` with its review repair included: the
canonical bind is now `FORGEFLEET_BRIDGE_HOST`/`PORT` (default
`127.0.0.1:4387`, PR #63), fencing is the `RESTORE_FENCED=1` operator hold,
and bridge-state snapshot/restore live in `lib/common.sh` helpers
(`snapshot_bridge_state` / `restore_bridge_state`, operator-owned user state
dir — never `/var/lib`). This branch was rebased onto `a662274` and its
scripts adapted to consume those canonical names/helpers; the live-path
behavior of the canonical scripts is unchanged (FF-022 still only adds
manifest verification, fixture rehearsal modes, and the opt-in `edge`
profile). The dimension table below describes the pre-merge #45 base and is
kept as the decision history.

## Verdict

**PR #45 is the canonical scaffold.** PR #51 keeps zero parallel
implementations: its `compose.vultr.yml`, `env.vultr.example`, both systemd
units, `vultr-deploy.sh`/`vultr-rollback.sh`, and its private `common.sh` /
`backup.sh` / `restore.sh` variants are deleted. What remains is a strictly
additive split-phase delta (see `infra/README.md`). Live-path behavior of
the canonical scripts is unchanged; FF-022 only adds manifest verification,
fixture rehearsal modes, and the opt-in `edge` profile.

## Dimension-by-dimension comparison and decision

| Dimension | PR #45 (FF-005, canonical) | PR #51 v1 (superseded) | Decision (this PR) |
|---|---|---|---|
| Compose file | `docker-compose.private.yml`: `db` + `paperclip` only, `forge-internal` internal net, loopback ports, fail-closed pins | separate `compose.vultr.yml` with `postgres`/`paperclip-api`/`orca-bridge`/`edge` | **One file**: canonical kept; `edge` (Caddy) added under `profiles: ["split"]`, loopback ports, default `up` unaffected |
| Bridge supervisor | systemd **user** unit, operator UID (must exec the Orca user-session CLI natively; containerizing would force credential mounts) | compose `orca-bridge` service + separate systemd units | **Canonical user unit wins**; compose must never define `bridge` (enforced by selftest + deploy guard) |
| Bridge bind | `BRIDGE_BIND=127.0.0.1:8787` + `guard-loopback.sh` ExecStartPre | `127.0.0.1:4387`, no guard | **8787 + guard**; single-supervisor rule documented in compose header |
| Bridge process user | invoking operator user (no `User=` — required for CLI access) | `forgefleet` system user / user-service mix | **Operator user** (changing it would break Orca CLI access; recorded here, not silently altered) |
| Credential boundary | per-service env files (`paperclip`/`bridge`/`postgres`), root-only 600, no defaults for secrets | single `env.vultr.example` | **Per-service files**; single file deleted |
| Kill switch | `BRIDGE_NO_NEW_DISPATCH=1` | `DISPATCH_PAUSED=1` | **Canonical name**; split scripts use it |
| Live/deploy gating | `want_apply --apply`, dry-run default, `forbid_orca_target`, secret-file 600 checks | `--check`/`--apply` + `FORGEFLEET_LIVE_OK` | **Canonical convention**; split scripts adopt `want_apply` (plus `FORGEFLEET_LIVE_OK` for the ingress-activation step) |
| Backup | `pg.dump` + `context.tgz` + `bridge-state.tgz`, `--apply` gated | manifest + fixture only, different flags | **Merged**: canonical live path kept, plus `manifest.json` (sha256/artifact) on every snapshot and `--fixture --out` rehearsal mode |
| Restore | snapshot + fence (`BRIDGE_NO_NEW_DISPATCH=1`) + reconcile | manifest verify + target-dir stage | **Merged**: manifest sha256 verified when present; `--manifest/--target-dir` fixture staging added; fence rule unchanged |
| Rollback | `rollback-private.sh`: fence → snapshot → revert pins → healthcheck | `vultr-rollback.sh` with contract gate | **Layered**: private script kept; `rollback-split.sh` adds the cross-contract frontend gate and delegates backend to it |
| Ingress | `Caddyfile.disabled.example` (gated, reference) | active `edge/Caddyfile` | **Both, staged**: disabled example untouched; active `ingress/Caddyfile` starts only via `deploy-split.sh --apply` after S-01…S-07 PASS |
| Frontend | none (private phase) | `vercel/vercel.json` | **Kept** (new, no conflict): preview-safe static config, no secrets |
| Validation | `selftest.sh` (31 fixture checks) | grep-only `verify-split.sh` | `selftest.sh` untouched and **run inside** the FF-022 suite; `verify-split.sh` now prefers **real `caddy validate` + adapted-JSON assertions** |

## Integration-blocker follow-up (coordinator comment 2026-11-09 12:25 UTC)

The coordinator added a blocker: the FF-005 bridge unit needs a writable
unprivileged SQLite state path and the actual CLI wrapper, and this branch
must stay stacked until #45 is repaired/merged. Reconciliation against the
verifiable sources (read-only; no contract edits — E05/E06 own contracts,
#60 owns integration):

- **Actual #63 server env API** (`services/orca-bridge/src/main.ts` on the
  FF-031 branch): `FORGEFLEET_BRIDGE_TOKEN` (required),
  `FORGEFLEET_BRIDGE_HOST` (default `127.0.0.1`), `PORT` (default `4387`),
  `FORGEFLEET_BRIDGE_DATA_DIR` (default `./bridge-data`), unauthenticated
  `GET /v1/health/live`. These names do **not** match #45's
  `bridge.env.example` (`BRIDGE_BIND`/`BRIDGE_AUTH_SECRET`/`BRIDGE_PORT`) —
  confirming the coordinator's contract-mismatch finding. The rename belongs
  to the #45 repair (its author), not to this stacked PR: no #45-owned file
  is edited here for it. This PR's scripts consume only the canonical
  `BRIDGE_BIND`/`BRIDGE_STATE_DIR`/`BRIDGE_NO_NEW_DISPATCH` names and will be
  adapted on rebase after #45's repair lands.
- **State path**: `backup.sh`/`restore.sh` already tolerate a missing state
  dir and manifest only present artifacts, so a #45 move to an operator-owned
  user state dir (systemd `StateDirectory`/XDG) will not break them; the move
  itself is #45's repair. `backup.service` runs as root and reads whichever
  path the canonical env names.
- **Linux wrapper**: verified
  `/opt/orca/squashfs-root/resources/bin/orca-ide` (v1.4.251, issue #65).
  No FF-022 file hardcodes an Orca path; `provision-private.sh` wrapper
  resolution is #45's repair.
- **This PR's own fix from the same review**: `infra/ingress/Caddyfile`
  upstreams corrected from the stale `paperclip-api:3000` to the canonical
  `paperclip:8080` (tracks `PAPERCLIP_PORT` default; E01 owns the pin), and
  the dubious `{$EDGE_BIND::80}` site address replaced with hardcoded `:80`
  (loopback-only; public TLS at the host boundary post-approval). Revalidated
  with real `caddy validate` + `caddy adapt` (`"dial":"paperclip:8080"`,
  zero bridge upstreams). The `/auth/verify` forward-auth target remains an
  explicit E07-to-implement assumption — split stays shut until S-01…S-07.

## What the reviewer asked, and where it is answered

1. *One authoritative path + reconciled supervisor/credential/port/volume/
   migration/recovery* — decided in the table above; implemented by merging
   (not duplicating) the five overlapping files and deleting the parallel stack.
2. *Written comparison* — this file.
3. *Apply cleanly after the canonical scaffold* — PR #51 is rebased onto the
   FF-005 branch (stacked); its diff is additive except for the five merged
   files, whose live behavior is preserved.
4. *Caddy/ingress validation with real tooling* — `verify-split.sh` runs
   `caddy validate` and asserts on `caddy adapt` JSON (404 handlers, `/auth/verify`
   forward-auth, zero bridge upstreams) whenever a caddy binary is present,
   and labels fallback mode explicitly. Evidence in the PR body.
5. *No live deploy/restart or public ingress* — nothing here starts anything
   by default; `--apply` paths require explicit flags plus
   `FORGEFLEET_LIVE_OK=1`, and `deploy-split.sh` additionally fails closed
   while split gates are OPEN. The bridge user unit and `orca-serve.service`
   are never managed by any script in this PR.
6. *Issue #60 owns the integrated bridge API* — untouched: no bridge API,
   adapter, or contract file is modified here. The canonical bridge bind is
   now `FORGEFLEET_BRIDGE_HOST:PORT` (default `127.0.0.1:4387`, PR #63,
   landed via the #45 merge); any residual openapi/compose port-mapping
   question is recorded as a follow-up for E05/E06, not resolved
   unilaterally.
