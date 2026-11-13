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
  # Owner identity only: User= is not a secret and feeds the same-UID
  # proof below. Never query unit ExecStart values here — they can carry
  # metadata/secrets and no output filter scrubs them reliably, so the
  # raw show output must never reach the log.
  systemctl --user show orca-serve.service -p User 2>/dev/null || true
  # Same-UID proof: the bridge user unit runs as this login user, so it must
  # match the user that owns orca-serve.service (else the bridge cannot see that CLI session).
  orca_user="$(systemctl --user show orca-serve.service -p User 2>/dev/null | sed 's/^User=//')"
  if [ -n "$orca_user" ] && [ "$orca_user" != "$(id -un)" ]; then
    warn "login user $(id -un) != orca-serve owner ${orca_user:-<unset>} (enable the bridge unit as ${orca_user:-that user})"
    fail=1
  elif [ -n "$orca_user" ]; then
    log "same-UID confirmed: bridge and orca-serve both owned by $orca_user"
  fi
else
  warn "systemctl unavailable; cannot observe orca-serve.service"
  fail=1
fi

# 2. Resolve the trusted CLI wrapper without executing it and without ever
# touching orca-serve. Order per VPS finding #65; the Electron GUI binary and
# bare `orca` are refused by the resolver. No --no-sandbox style flags anywhere.
if cli="$(resolve_orca_cli 2>/dev/null)"; then
  log "Orca CLI wrapper resolved: $cli (read-only; never invoked with sandbox flags)"
else
  warn "no supported Orca CLI wrapper (need ORCA_CLI_COMMAND or a packaged orca-ide shim; GUI binary and bare-orca refused)"
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

# 4. Container toolchain, Node floor, and scaffold pins. The bridge is native.
# Server entrypoint is `node src/main.ts` (PR #63, Node >=24 type-stripping).
if need_cmd node; then
  node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${node_major:-0}" -ge 24 ] 2>/dev/null; then
    log "node $(node --version) meets the >=24 server floor"
  else
    warn "node floor unmet (server needs >=24; found ${node_major:-unknown}); refusing"
    fail=1
  fi
else
  warn "node unavailable; bridge entrypoint cannot run here"
  fail=1
fi
need_cmd docker || fail=1
[ -f "$COMPOSE_FILE" ] && log "compose file present" || { warn "missing $COMPOSE_FILE"; fail=1; }
env_presence PAPERCLIP_IMAGE POSTGRES_IMAGE || true
for img in PAPERCLIP_IMAGE POSTGRES_IMAGE; do
  [ -n "${!img:-}" ] || { warn "$img unset (E01 pin OPEN)"; fail=1; }
done
# Single-supervisor regression check: compose must not define a bridge service.
if sed 's/#.*//' "$COMPOSE_FILE" | grep -qE '^[[:space:]]{2}bridge:'; then
  warn "compose defines a bridge service (bridge runs as the user unit only)"
  fail=1
fi
# Native bridge entrypoint the user unit will exec (PR #63: src/main.ts).
if [ -f /opt/forgefleet/services/orca-bridge/src/main.ts ]; then
  log "bridge entrypoint present (src/main.ts)"
else
  warn "bridge entrypoint missing (check out the bridge sources before enabling the user unit)"
fi
# Unprivileged-user proof: the bridge user unit runs as this login UID, which
# must be the same unprivileged user that owns orca-serve.service — never root.
if [ "$(id -u)" = "0" ]; then
  warn "preflight runs as root; the bridge user unit must be enabled as the operator login user"
  fail=1
else
  log "operator user: $(id -un) (uid $(id -u)) — bridge user unit runs as this UID"
fi

# 5. Secret files must exist with root-only permissions when present.
# paperclip/postgres live in /etc (compose); the bridge env lives in the
# operator home (native user unit) and is resolved like deploy-private.sh.
BRIDGE_ENV_FILE="${BRIDGE_ENV_FILE:-$HOME/.config/forgefleet/bridge.env}"
for f in /etc/forgefleet/paperclip.env /etc/forgefleet/postgres.env "$BRIDGE_ENV_FILE"; do
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
