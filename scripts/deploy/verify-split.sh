#!/usr/bin/env bash
# verify-split (FF-022): prove "authenticated split web/API, no open bridge"
# against the SINGLE canonical stack (FF-005 files + FF-022 edge delta).
# --static-only (default): shape checks + real `caddy validate`/`adapt` when a
#   caddy binary is available (CADDY_BIN or PATH); otherwise clearly labeled
#   static-grep fallback.
# --live --api URL --web URL: additionally probe a deployed stack (owner-approved only).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/common.sh"
forbid_orca_target "$@"

STATIC_ONLY=1; API=""; WEB=""
for a in "$@"; do case "$a" in --static-only) STATIC_ONLY=1;; --live) STATIC_ONLY=0;; esac; done
args=("$@")
for ((i=0; i<${#args[@]}; i++)); do case "${args[$i]}" in
  --api) API="${args[$((i+1))]:-}";;
  --web) WEB="${args[$((i+1))]:-}";;
esac; done

fail=0
check() { if eval "$2"; then log "PASS: $1"; else warn "FAIL: $1"; fail=1; fi; }

COMPOSE="$FF_ROOT/infra/docker-compose.private.yml"
CADDY="$FF_ROOT/infra/ingress/Caddyfile"
VERCEL="$FF_ROOT/infra/vercel/vercel.json"
BRIDGE_ENV="$FF_ROOT/infra/bridge.env.example"
GUARD="$FF_ROOT/scripts/deploy/guard-loopback.sh"

check "compose exists"                      "[[ -f '$COMPOSE' ]]"
check "compose has NO bridge service"       "! sed 's/#.*//' '$COMPOSE' | grep -qE '^[[:space:]]{2}bridge:'"
check "compose ports are loopback-only"     "! grep -E '^[[:space:]]+- +\"' '$COMPOSE' | grep -v '127.0.0.1'"
check "db publishes NO ports"               "! sed 's/#.*//' '$COMPOSE' | awk '/^  db:/,/^  [a-z]/' | grep -qE '^[[:space:]]+ports:'"
check "edge is split-profile opt-in"        "grep -A3 'edge:' '$COMPOSE' | grep -q 'profiles:'"
check "bridge default bind is loopback"     "grep -q 'FORGEFLEET_BRIDGE_HOST=127.0.0.1' '$BRIDGE_ENV'"
check "guard accepts loopback"              "FORGEFLEET_BRIDGE_HOST=127.0.0.1 PORT=4387 '$GUARD' >/dev/null"
check "guard refuses non-loopback"          "! FORGEFLEET_BRIDGE_HOST=0.0.0.0 PORT=4387 '$GUARD' >/dev/null 2>&1"
check "edge 404s bridge paths"              "grep -q 'handle /v1/' '$CADDY' && grep -q 'handle /bridge/' '$CADDY'"
check "edge never proxies bridge"           "! grep -E 'reverse_proxy.*(8787|4387|orca-bridge|bridge:)' '$CADDY'"
check "edge requires auth on /api"          "grep -A4 'handle /api/' '$CADDY' | grep -q forward_auth"
check "vercel env has only public URL"      "python3 '$FF_ROOT/scripts/deploy/lib/check_vercel_env.py' '$VERCEL'"
check "vercel exposes only public URL"      "grep -q 'VITE_PUBLIC_API_URL' '$VERCEL'"
check "no committed token values"           "! grep -rE 'ghp_[A-Za-z0-9]{20,}|xox[bpas]-[A-Za-z0-9-]{10,}' '$FF_ROOT/infra' '$FF_ROOT/scripts/deploy'"

# Real-tooling validation (answers the review: offline grep alone is insufficient).
CADDY_BIN="${CADDY_BIN:-$(command -v caddy || true)}"
if [ -n "$CADDY_BIN" ]; then
  check "caddy validate passes (real toolchain)" \
    "'$CADDY_BIN' validate --config '$CADDY' --adapter caddyfile >/dev/null 2>&1"
  check "adapted config dials no bridge upstream" \
    "! '$CADDY_BIN' adapt --config '$CADDY' --adapter caddyfile 2>/dev/null | grep -E '\"dial\": ?\"[^\"]*(8787|4387|bridge)'"
  check "adapted config dials canonical paperclip" \
    "'$CADDY_BIN' adapt --config '$CADDY' --adapter caddyfile 2>/dev/null | grep -qE '\"dial\": ?\"paperclip:8080\"'"
  check "adapted config keeps 404s + auth verify" \
    "'$CADDY_BIN' adapt --config '$CADDY' --adapter caddyfile 2>/dev/null | grep -qE 'status_code.: ?404' && '$CADDY_BIN' adapt --config '$CADDY' --adapter caddyfile 2>/dev/null | grep -q '/auth/verify'"
  log "ingress validation: REAL caddy ($($CADDY_BIN version 2>/dev/null || echo unknown))"
else
  warn "caddy binary absent (set CADDY_BIN): static shape checks only — NOT full validation"
fi

if [ "$STATIC_ONLY" = 0 ]; then
  [ -n "$API" ] && [ -n "$WEB" ] || die "--live needs --api URL and --web URL"
  check "bridge port not reachable publicly" "! curl -fsS -m 5 '$API:8787/v1/health/live' >/dev/null 2>&1"
  check "edge denies /v1/* with 404"         "curl -s -o /dev/null -w '%{http_code}' '$API/v1/health/live' | grep -q 404"
  check "api health behind auth"             "curl -fsS -m 10 '$API/healthz' >/dev/null"
fi

[ "$fail" -eq 0 ] || die "verify-split FAILED"
log "verify-split PASS ($([ "$STATIC_ONLY" = 1 ] && echo static-only || echo live))"
