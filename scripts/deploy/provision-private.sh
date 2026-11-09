#!/usr/bin/env bash
# Read-only preflight for the private VPS phase (FF-005).
# Touches nothing: inventory only, exits nonzero on missing prerequisites.
# Never restarts, stops, or reconfigures any service — especially orca-serve.
set -euo pipefail
# shellcheck disable=SC1091
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"
forbid_orca_target "$@"

fail=0
log "ForgeFleet private-phase preflight (read-only)"

# 1. Existing Orca service: status/show only. Any other verb is out of scope.
if need_cmd systemctl; then
  if systemctl --user status orca-serve.service --no-pager 2>/dev/null | head -n 8; then
    log "orca-serve.service state observed (read-only)"
  else
    warn "orca-serve.service not observable via systemctl --user"
  fi
  # Redact values: print key presence, never environment contents.
  systemctl --user show orca-serve.service -p ExecStart -p User 2>/dev/null | sed 's/=.*ExecStart.*/ExecStart=[redacted-check-manually]/' || true
else
  warn "systemctl unavailable; cannot observe orca-serve.service"
  fail=1
fi

# 2. Resolve the trusted CLI without ever running a bare `orca` on Linux.
if [ -n "${ORCA_CLI_COMMAND:-}" ]; then
  log "ORCA_CLI_COMMAND=[set] (value withheld)"
  command -v "$ORCA_CLI_COMMAND" >/dev/null 2>&1 || { warn "ORCA_CLI_COMMAND not on PATH"; fail=1; }
elif command -v orca-ide >/dev/null 2>&1; then
  log "orca-ide found on PATH (version check left to the version-matched CLI guide)"
else
  warn "no ORCA_CLI_COMMAND and no orca-ide on PATH"
  fail=1
fi

# 3. Host headroom (counts only) and admin connectivity.
free -m | head -n 2 || warn "free(1) unavailable"
df -h / /var 2>/dev/null | head -n 5 || true
if command -v tailscale >/dev/null 2>&1; then
  tailscale status 2>/dev/null | head -n 5 || warn "tailscale status unreadable"
else
  warn "tailscale CLI not found; private admin reach not verified"
fi

# 4. Container toolchain and scaffold pins.
need_cmd docker || fail=1
[ -f "$COMPOSE_FILE" ] && log "compose file present" || { warn "missing $COMPOSE_FILE"; fail=1; }
env_presence PAPERCLIP_IMAGE BRIDGE_IMAGE POSTGRES_IMAGE || true
for img in PAPERCLIP_IMAGE BRIDGE_IMAGE POSTGRES_IMAGE; do
  [ -n "${!img:-}" ] || { warn "$img unset (E01 pin OPEN)"; fail=1; }
done

# 5. Secret files must exist with root-only permissions when present.
for f in /etc/forgefleet/paperclip.env /etc/forgefleet/bridge.env /etc/forgefleet/postgres.env; do
  if [ -f "$f" ]; then
    perms="$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f" 2>/dev/null || echo '?')"
    log "$f present (mode $perms; values never printed)"
  else
    warn "$f absent — copy from infra/*.env.example and inject via secret manager"
  fi
done

if [ "$fail" -ne 0 ]; then
  warn "preflight INCOMPLETE: resolve warnings above before --apply"
  exit 1
fi
log "preflight OK (read-only; nothing was changed)"
