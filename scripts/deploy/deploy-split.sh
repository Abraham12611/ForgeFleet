#!/usr/bin/env bash
# Split-phase ingress deploy (FF-022): start the `edge` profile of the
# canonical compose stack AFTER the private stack is healthy and the
# split-compatibility matrix records PASS for S-01..S-07.
# Default is dry-run. --apply requires FORGEFLEET_LIVE_OK=1 and starts ONLY
# the edge service (db/paperclip stay managed by deploy-private.sh).
# Never manages orca-serve.service. No live public ingress without explicit
# owner signoff (see matrix S-08/live row).
set -euo pipefail
# shellcheck disable=SC1091
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

if want_apply --apply "$@"; then APPLY=1; else APPLY=0; fi
forbid_orca_target "$@"

MATRIX="$FF_ROOT/infra/split-compatibility-matrix.md"
CADDY="$FF_ROOT/infra/ingress/Caddyfile"

log "plan: docker compose --profile split up -d edge (private stack untouched)"
[ "$APPLY" = 1 ] && log "mode: APPLY" || log "mode: dry-run -- pass --apply to execute"

# Gate 1: loopback shape of the canonical bridge bind (PR #63 names).
FORGEFLEET_BRIDGE_HOST="${FORGEFLEET_BRIDGE_HOST:-127.0.0.1}" PORT="${PORT:-4387}" \
  "$FF_ROOT/scripts/deploy/guard-loopback.sh" >/dev/null \
  && log "bridge bind is loopback" || die "bridge bind guard failed"

# Gate 2: split-matrix gates S-01..S-07 must be PASS (no OPEN rows).
open_gates="$(grep -E '^\| S-0[1-7] ' "$MATRIX" | grep -c 'OPEN' || true)"
[ "$open_gates" -eq 0 ] \
  || die "refusing split deploy: $open_gates of S-01..S-07 still OPEN (see $MATRIX)"

# Gate 3: Caddyfile must validate with the real Caddy toolchain when present.
if command -v caddy >/dev/null 2>&1; then
  caddy validate --config "$CADDY" --adapter caddyfile >/dev/null 2>&1 \
    && log "Caddyfile validates (real caddy $(caddy version 2>/dev/null))" \
    || die "Caddyfile FAILED real validation"
else
  warn "caddy binary absent: static shape checks only (install caddy for full validation)"
  grep -q 'handle /v1/' "$CADDY" || die "edge must 404 bridge paths"
fi

# Gate 4: Caddy image pinned.
[ -n "${CADDY_IMAGE:-}" ] || die "refusing split deploy: CADDY_IMAGE unset (E01 pin OPEN)"

[ "$APPLY" = 1 ] || { log "dry-run complete: edge not started"; exit 0; }
confirm_live
docker compose -f "$COMPOSE_FILE" --profile split up -d edge
log "split edge applied: verify with verify-split.sh --live --api <url> --web <url>"
