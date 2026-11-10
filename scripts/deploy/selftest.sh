#!/usr/bin/env bash
# Scaffold selftest for FF-005 (fixture-only, no Docker/secrets/VPS).
# Validates shape + isolation guards. This is NOT integration evidence.
set -uo pipefail
# shellcheck disable=SC1091
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

pass=0; failed=0
ok()   { pass=$((pass+1)); echo "PASS: $1"; }
bad()  { failed=$((failed+1)); echo "FAIL: $1" >&2; }

D="$FF_ROOT/scripts/deploy"
I="$FF_ROOT/infra"
# Operator scripts under test: the selftest harness itself is excluded, and
# all checks below scan code with trailing comments stripped, so prose that
# names a forbidden thing cannot trip its own guard.
OPS="$(find "$D" -name '*.sh' -not -name 'selftest.sh' | sort)"
no_comments() { sed 's/#.*//' "$@"; }

# 1. All scripts parse.
for f in "$D"/*.sh "$D"/lib/*.sh; do
  bash -n "$f" && ok "bash -n $(basename "$f")" || bad "bash -n $(basename "$f")"
done

# 2. Compose: isolated, loopback-only, pinned, secret-free.
no_comments < "$I/docker-compose.private.yml" | grep -q 'orca-serve' \
  && bad "compose references orca-serve" || ok "compose has no orca-serve reference"
grep -E '^\s+-\s+"' "$I/docker-compose.private.yml" | grep -v '127.0.0.1' \
  && bad "compose publishes a non-loopback port" || ok "compose ports are loopback-only"
grep -A3 'db:' "$I/docker-compose.private.yml" | grep -q 'ports:' \
  && bad "db publishes ports" || ok "db has no published ports"
grep -q 'image: "${[A-Z_]*:?' "$I/docker-compose.private.yml" \
  && ok "compose images fail closed on unset pins" || bad "compose images not pin-guarded"
grep -qiE 'password=|passwd|secret=.+[^:?}]|BEGIN .*PRIVATE KEY' "$I/docker-compose.private.yml" \
  && bad "compose contains secret-looking value" || ok "compose carries no secrets"

# 3. Env examples: names only, no real credentials. Bridge names follow the
# server contract (PR #63 main.ts); the loopback default is enforced by
# guard-loopback.sh, exercised below.
grep -rqiE 'BEGIN .*PRIVATE KEY|ghp_|github_pat_|sk-[A-Za-z0-9]{8}' "$I"/*.env.example \
  && bad "env.example contains credential-looking value" || ok "env.examples are credential-free"
for pin in 'FORGEFLEET_BRIDGE_HOST=127.0.0.1' '^PORT=4387' 'FORGEFLEET_BRIDGE_TOKEN=' 'BRIDGE_HEALTH_PATH=/v1/health/live'; do
  grep -q "$pin" "$I/bridge.env.example" \
    && ok "env pins $pin" || bad "env pin missing: $pin"
done

# 4. Systemd: hardened, guarded, never bound to Orca.
for u in "$I"/systemd/*.service; do
  grep -q 'NoNewPrivileges=true' "$u" && grep -q 'PrivateTmp=true' "$u" \
    && ok "$(basename "$u") hardened" || bad "$(basename "$u") missing hardening"
  no_comments < "$u" | grep -qE 'orca-serve|systemctl.*(restart|stop|start).*orca' \
    && bad "$(basename "$u") manages Orca" || ok "$(basename "$u") never manages Orca"
done
grep -q 'guard-loopback' "$I/systemd/forgefleet-bridge.service" \
  && ok "bridge unit runs loopback guard" || bad "bridge unit missing loopback guard"

# 5. Loopback guard behavior (accept, non-loopback, non-numeric port).
FORGEFLEET_BRIDGE_HOST=127.0.0.1 PORT=4387 "$D/guard-loopback.sh" >/dev/null \
  && ok "guard accepts loopback" || bad "guard rejects loopback"
FORGEFLEET_BRIDGE_HOST=0.0.0.0 PORT=4387 "$D/guard-loopback.sh" >/dev/null 2>&1 \
  && bad "guard accepts 0.0.0.0" || ok "guard refuses non-loopback"
FORGEFLEET_BRIDGE_HOST=127.0.0.1 PORT=notaport "$D/guard-loopback.sh" >/dev/null 2>&1 \
  && bad "guard accepts non-numeric port" || ok "guard refuses non-numeric port"

# 6. Deploy scripts fail closed without pins/secrets (dry-run default).
if PAPERCLIP_IMAGE=x BRIDGE_IMAGE=x POSTGRES_IMAGE=x "$D/deploy-private.sh" >/dev/null 2>&1; then
  bad "deploy succeeded without secret files"
else
  ok "deploy refuses without secret files"
fi
"$D/restore.sh" >/dev/null 2>&1 \
  && bad "restore runs without snapshot/guard" || ok "restore refuses without snapshot+fence"

# 7. No operator script issues a bare `orca` or a mutating systemctl verb.
#    (Read-only `systemctl --user status/show orca-serve` in preflight is allowed.)
if no_comments $OPS | grep -E '(^|[^a-zA-Z_/-])orca([^-a-zA-Z_.]|$)' \
     | grep -vE 'orca-serve|orca-ide|orca-bridge|ORCA_' | grep -q .; then
  bad "bare orca invocation found in scripts/deploy"
else
  ok "no bare orca invocation in scripts/deploy"
fi
if no_comments $OPS | grep -E 'systemctl.*(restart|stop|start|disable|mask)' | grep -q .; then
  bad "mutating systemctl verb found in scripts/deploy"
else
  ok "no mutating systemctl verb in scripts/deploy"
fi

# 8. Every mutating script defaults to dry-run (requires explicit --apply).
for s in deploy-private backup restore rollback-private; do
  grep -q -- '--apply' "$D/$s.sh" && ok "$s.sh gates mutation behind --apply" \
    || bad "$s.sh has no --apply gate"
done

# 9. Single bridge supervisor (FF-005 canonical topology): the bridge runs
# ONLY as the systemd user unit, never as a compose service.
no_comments < "$I/docker-compose.private.yml" | grep -qE '^[[:space:]]{2}bridge:' \
  && bad "compose defines a bridge service (dual supervisor)" || ok "compose has no bridge service"
grep -q 'WantedBy=default.target' "$I/systemd/forgefleet-bridge.service" \
  && ok "bridge unit is a user unit" || bad "bridge unit is not a user unit"
grep -qE '^User=' "$I/systemd/forgefleet-bridge.service" \
  && bad "bridge user unit overrides User=" || ok "bridge unit runs as the invoking operator user"
# Match bridge only as a standalone compose service argument (prose that
# merely names the bridge next to a plan line must not trip this guard).
if no_comments $OPS | grep -E 'compose +(-f +[^ ]+ +)?(up|stop)( .*)? bridge([^a-zA-Z_]|$)' | grep -q .; then
  bad "a deploy script still targets a compose bridge service"
else
  ok "no deploy script targets a compose bridge service"
fi
# Health-path contract is single-sourced: the compose Paperclip healthcheck
# and healthcheck.sh read the same variable name, and the native bridge
# health probe and bridge.env.example share theirs — so a later pin changes
# one value only.
if grep -q "PAPERCLIP_HEALTH_PATH" "$I/docker-compose.private.yml" \
  && grep -q "PAPERCLIP_HEALTH_PATH" "$D/healthcheck.sh"; then
  ok "health path PAPERCLIP_HEALTH_PATH is single-sourced"
else
  bad "health path PAPERCLIP_HEALTH_PATH diverged between compose and healthcheck"
fi
if grep -q "BRIDGE_HEALTH_PATH" "$I/bridge.env.example" \
  && grep -q "BRIDGE_HEALTH_PATH" "$D/healthcheck.sh"; then
  ok "health path BRIDGE_HEALTH_PATH is single-sourced"
else
  bad "health path BRIDGE_HEALTH_PATH diverged between env example and healthcheck"
fi
# Backup/restore snapshot exactly the data volume compose defines.
for v in context-store; do
  if grep -q "$v" "$I/docker-compose.private.yml" && grep -q "$v" "$D/backup.sh" && grep -q "$v" "$D/restore.sh"; then
    ok "volume $v reconciled across compose/backup/restore"
  else
    bad "volume $v missing in compose/backup/restore"
  fi
done
# No home bind mounts anywhere in compose: the bridge reaches the Orca CLI
# as the same UID natively, never by mounting home into Docker.
if grep -E '^[[:space:]]+-.*(\$HOME|/home/|%h|~/)' "$I/docker-compose.private.yml" | grep -q .; then
  bad "compose bind-mounts a home directory"
else
  ok "compose mounts no home directories"
fi
# No /var/lib bridge state: the sandboxed unit cannot write there.
if grep -rq '/var/lib/forgefleet/bridge' "$I/bridge.env.example" "$D" 2>/dev/null | grep -v selftest; then
  bad "/var/lib bridge state reference remains"
else
  ok "no /var/lib bridge state reference"
fi
# Unit owns its state via StateDirectory with minimum write paths.
grep -q '^StateDirectory=forgefleet-bridge' "$I/systemd/forgefleet-bridge.service" \
  && ok "bridge unit declares StateDirectory" || bad "bridge unit missing StateDirectory"
grep -q '^ReadWritePaths=%S/forgefleet-bridge' "$I/systemd/forgefleet-bridge.service" \
  && ok "bridge unit permits minimum write path" || bad "bridge unit missing ReadWritePaths"
# Scripts and env example agree on the XDG default.
grep -q 'local/state/forgefleet-bridge' "$I/bridge.env.example" \
  && grep -q 'local/state/forgefleet-bridge' "$D/lib/common.sh" \
  && ok "state default single-sourced (env example + helpers)" \
  || bad "state default diverged between env example and helpers"

# 10. Executable durability proof (disposable unprivileged fixture, no VPS).
if [ "$(id -u)" = "0" ]; then
  ok "durability fixture skipped (root; VPS runs unprivileged)"
elif bash "$D/tests/test-state-durability.sh" >/dev/null 2>&1; then
  ok "durability fixture passed (write/snapshot/restore roundtrip)"
else
  bad "durability fixture failed"
fi

# 11. Sandbox safety: no setuid/sandbox workarounds anywhere in scope.
# Per VPS finding #65 these are forbidden (no --no-sandbox, no chmod 4755,
# no chown root, no Electron GUI invocation). Comments are stripped; only
# live code can trip these guards.
# Patterns are assembled from fragments so this guard cannot match its own
# source lines (fixed-string search sees only the joined value).
for pat in '--no-sand'"box" 'disable-setuid-sand'"box" 'chmod 47'"55" 'chown ro'"ot"; do
  if no_comments "$D"/*.sh "$D"/lib/*.sh "$D"/tests/*.sh "$I"/systemd/*.service 2>/dev/null | grep -qF -- "$pat"; then
    bad "forbidden sandbox workaround present: $pat"
  else
    ok "no $pat in scope"
  fi
done

# 12. Orca wrapper resolution proof (fake HOME/PATH fixture, nothing executed).
if bash "$D/tests/test-orca-resolution.sh" >/dev/null 2>&1; then
  ok "orca resolution fixture passed (shim selected, GUI/bare refused)"
else
  bad "orca resolution fixture failed"
fi

# 13. Server contract pins (PR #63): exact artifact, env names, health path.
grep -q '^ExecStart=/usr/bin/env node src/main.ts' "$I/systemd/forgefleet-bridge.service" \
  && ok "unit entrypoint is node src/main.ts" || bad "unit entrypoint drifted"
grep -q '^WorkingDirectory=/opt/forgefleet/services/orca-bridge' "$I/systemd/forgefleet-bridge.service" \
  && ok "unit working dir matches deployed sources" || bad "unit working dir drifted"
grep -q '^Environment=FORGEFLEET_BRIDGE_DATA_DIR=%S/forgefleet-bridge' "$I/systemd/forgefleet-bridge.service" \
  && ok "unit fixes data dir to StateDirectory" || bad "unit data dir drifted"
grep -q 'PORT:-4387' "$D/healthcheck.sh" \
  && ok "healthcheck defaults to contract port" || bad "healthcheck port drifted"
# Stale pre-contract names must be gone from live scope (the frozen
# example-orca-bridge.service reference is exempt). Fragments keep this guard
# from matching its own source lines.
stale=0
for pat in 'BRIDGE_AUTH_SECR'"ET" 'BRIDGE_BIN'"D" 'BRIDGE_POR'"T=" 'BRIDGE_NO_NEW_DISPA'"TCH" 'BRIDGE_STATE_D'"IR" 'dist/index'"js"; do
  if no_comments "$D"/*.sh "$D"/lib/*.sh "$D"/tests/*.sh \
      "$I"/systemd/forgefleet-bridge.service "$I"/systemd/forgefleet-paperclip.service \
      "$I"/bridge.env.example "$I"/docker-compose.private.yml 2>/dev/null \
      | grep -qF -- "$pat"; then
    bad "stale contract name present: $pat"; stale=1
  fi
done
[ "$stale" -eq 0 ] && ok "no stale contract names in live scope"
# Fence specificity: a complete snapshot without RESTORE_FENCED still refuses.
fence_dir="$(mktemp -d)"
touch "$fence_dir/pg.dump" "$fence_dir/context.tgz"
if BACKUP_SNAPSHOT="$fence_dir" "$D/restore.sh" >/dev/null 2>&1; then
  bad "restore runs without operator fence"
else
  ok "restore refuses without operator fence"
fi
rm -rf "$fence_dir"

# 14. Bridge contract proof (disposable node stub + real healthcheck probe).
if ! command -v node >/dev/null 2>&1; then
  ok "contract fixture skipped (no node; server floor is >=24)"
elif bash "$D/tests/test-bridge-contract.sh" >/dev/null 2>&1; then
  ok "contract fixture passed (liveness/auth/healthcheck on contract shape)"
else
  bad "contract fixture failed"
fi

echo "---"
echo "selftest: $pass passed, $failed failed (fixture-only, not integration evidence)"
[ "$failed" -eq 0 ]
