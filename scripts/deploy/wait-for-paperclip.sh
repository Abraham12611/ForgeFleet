#!/usr/bin/env bash
# Fail-closed startup gate for the native bridge user unit (FF-005).
# Waits until Paperclip answers its health endpoint on loopback, because
# cross-manager ordering (user unit -> system compose stack) cannot use
# systemd After=. Used as ExecStartPre by forgefleet-bridge.service.
# Read-only: HTTP GETs to 127.0.0.1 only. Never touches orca-serve.service.
set -euo pipefail
# shellcheck disable=SC1091
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"
forbid_orca_target "$@"

port="${PAPERCLIP_PORT:-8080}"
path="${PAPERCLIP_HEALTH_PATH:-/healthz}"
url="http://127.0.0.1:${port}${path}"
timeout_s="${WAIT_FOR_PAPERCLIP_TIMEOUT:-90}"
elapsed=0

while [ "$elapsed" -lt "$timeout_s" ]; do
  if need_cmd curl; then
    out="$(curl -fsS -m 5 "$url" 2>/dev/null || true)"
  else
    out="$(wget -qO- -T 5 "$url" 2>/dev/null || true)"
  fi
  if printf '%s' "$out" | grep -q ok; then
    log "paperclip ready at $url"
    exit 0
  fi
  sleep 2
  elapsed=$((elapsed + 2))
done
warn "refusing bridge start: paperclip not healthy at $url after ${timeout_s}s"
exit 2
