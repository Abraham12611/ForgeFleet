#!/usr/bin/env bash
# Loopback health probe for the private stack (FF-005). Read-only.
# Checks distinct live/ready states; never touches orca-serve.service.
set -euo pipefail
# shellcheck disable=SC1091
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"
forbid_orca_target "$@"

paperclip_port="${PAPERCLIP_PORT:-8080}"
bridge_port="${BRIDGE_PORT:-8787}"
paperclip_path="${PAPERCLIP_HEALTH_PATH:-/healthz}"
bridge_path="${BRIDGE_HEALTH_PATH:-/healthz}"
fail=0

probe() {  # $1 label, $2 url
  if need_cmd curl; then
    out="$(curl -fsS -m 5 "$2" 2>/dev/null || true)"
  else
    out="$(wget -qO- -T 5 "$2" 2>/dev/null || true)"
  fi
  if printf '%s' "$out" | grep -q ok; then
    log "$1: healthy"
  else
    warn "$1: UNHEALTHY (no 'ok' at $2)"
    fail=1
  fi
}

probe paperclip "http://127.0.0.1:${paperclip_port}${paperclip_path}"
probe bridge "http://127.0.0.1:${bridge_port}${bridge_path}"

if docker ps --format '{{.Names}}' 2>/dev/null | grep -q .; then
  log "compose containers: $(docker ps --format '{{.Names}}:{{.Status}}' 2>/dev/null | tr '\n' ' ')"
fi

[ "$fail" -eq 0 ] && log "healthcheck OK" || { warn "healthcheck FAILED"; exit 1; }
