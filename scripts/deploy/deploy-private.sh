#!/usr/bin/env bash
# Deploy (or plan) the isolated private stack (FF-005).
# Default is a dry-run. Real changes require --apply and pass:
#   1. loopback bind guard, 2. image pins set, 3. secret files root-only,
#   4. compose defines no bridge service (single-supervisor rule),
#   5. the native bridge entrypoint exists for the user unit.
# This script starts ONLY the compose services (db, paperclip). The bridge is
# supervised separately by the systemd user unit forgefleet-bridge.service
# and is NEVER started here. This script never manages orca-serve.service.
# Run as the operator login user (docker group); never under sudo-root, so
# that $HOME resolves to the operator home holding bridge.env.
set -euo pipefail
# shellcheck disable=SC1091
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

if want_apply --apply "$@"; then APPLY=1; else APPLY=0; fi

BRIDGE_ENV_FILE="${BRIDGE_ENV_FILE:-$HOME/.config/forgefleet/bridge.env}"

log "plan: docker compose -f $COMPOSE_FILE up -d db paperclip (bridge: user unit, out of band)"
if [ "$APPLY" = 1 ]; then
  log "mode: APPLY"
else
  log "mode: dry-run -- pass --apply to execute"
fi

# Guard 1: loopback bind.
BRIDGE_BIND="${BRIDGE_BIND:-127.0.0.1:8787}" "$FF_ROOT/scripts/deploy/guard-loopback.sh"

# Guard 2: pinned images, no latest/guessing. The bridge is native (no image).
fail=0
for img in PAPERCLIP_IMAGE POSTGRES_IMAGE; do
  if [ -z "${!img:-}" ]; then warn "$img unset"; fail=1; fi
done
[ "$fail" -eq 0 ] || { warn "refusing deploy: image pins missing"; exit 2; }

# Guard 3: secret files exist and are not group/world-readable.
for f in /etc/forgefleet/paperclip.env /etc/forgefleet/postgres.env "$BRIDGE_ENV_FILE"; do
  [ -f "$f" ] || { warn "missing $f"; exit 2; }
  if [ "$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f" 2>/dev/null)" != "600" ]; then
    warn "refusing deploy: $f must be mode 600"; exit 2
  fi
done

# Guard 4: single-supervisor rule — refuse a regressed compose bridge service.
if sed 's/#.*//' "$COMPOSE_FILE" | grep -qE '^[[:space:]]{2}bridge:'; then
  warn "refusing deploy: compose defines a bridge service (bridge runs as the user unit only)"
  exit 2
fi

# Guard 5: the native bridge entrypoint the user unit will exec must exist.
[ -f /opt/forgefleet/services/orca-bridge/dist/index.js ] \
  || { warn "refusing deploy: bridge entrypoint missing (build the bridge before --apply)"; exit 2; }

if [ "$APPLY" = 0 ]; then
  log "dry-run complete: no containers started, no Orca state touched"
  exit 0
fi

# Real deploy: compose stack only. `--no-deps` is unnecessary; compose lists
# only forge-private services and orca-serve is not a compose member.
docker compose -f "$COMPOSE_FILE" up -d db paperclip
log "deploy applied: verifying loopback health next (healthcheck.sh)"
log "bridge is NOT started here: operator enables the user unit out of band"
"$FF_ROOT/scripts/deploy/healthcheck.sh"
