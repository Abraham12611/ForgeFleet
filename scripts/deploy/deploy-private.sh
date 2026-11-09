#!/usr/bin/env bash
# Deploy (or plan) the isolated private stack (FF-005).
# Default is a dry-run plan. Real changes require --apply and pass:
#   1. loopback bind guard, 2. image pins set, 3. secret files root-only.
# This script never manages orca-serve.service.
set -euo pipefail
# shellcheck disable=SC1091
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

if want_apply --apply "$@"; then APPLY=1; else APPLY=0; fi

log "plan: docker compose -f $COMPOSE_FILE up -d db paperclip bridge"
if [ "$APPLY" = 1 ]; then
  log "mode: APPLY"
else
  log "mode: dry-run -- pass --apply to execute"
fi

# Guard 1: loopback bind.
BRIDGE_BIND="${BRIDGE_BIND:-127.0.0.1:8787}" "$FF_ROOT/scripts/deploy/guard-loopback.sh"

# Guard 2: pinned images, no latest/guessing.
fail=0
for img in PAPERCLIP_IMAGE BRIDGE_IMAGE POSTGRES_IMAGE; do
  if [ -z "${!img:-}" ]; then warn "$img unset"; fail=1; fi
done
[ "$fail" -eq 0 ] || { warn "refusing deploy: image pins missing"; exit 2; }

# Guard 3: secret files exist and are not group/world-readable.
for f in /etc/forgefleet/paperclip.env /etc/forgefleet/bridge.env /etc/forgefleet/postgres.env; do
  [ -f "$f" ] || { warn "missing $f"; exit 2; }
  if [ "$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f" 2>/dev/null)" != "600" ]; then
    warn "refusing deploy: $f must be mode 600"; exit 2
  fi
done

if [ "$APPLY" = 0 ]; then
  log "dry-run complete: no containers started, no Orca state touched"
  exit 0
fi

# Real deploy: private stack only. `--no-deps` is unnecessary; compose lists
# only forge-private services and orca-serve is not a compose member.
docker compose -f "$COMPOSE_FILE" up -d db paperclip bridge
log "deploy applied: verifying loopback health next (healthcheck.sh)"
"$FF_ROOT/scripts/deploy/healthcheck.sh"
