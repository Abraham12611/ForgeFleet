#!/usr/bin/env bash
# Shared helpers for ForgeFleet private-phase deploy scripts (FF-005).
# Safety invariants: read-only toward Orca, --apply required to mutate,
# no secrets on stdout, redacted logging.
set -euo pipefail

FF_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
INFRA_DIR="$FF_ROOT/infra"
COMPOSE_FILE="$INFRA_DIR/docker-compose.private.yml"

# Fail closed if any argument tries to drag the Orca service into scope.
forbid_orca_target() {
  for arg in "$@"; do
    case "$arg" in
      *orca-serve*|*orca_serve*)
        echo "refusing: scripts/deploy never manages orca-serve.service" >&2
        exit 2
        ;;
    esac
  done
}

# "$1" = exact flag expected (e.g. --apply). Prints mode, exits 0 dry-run / 1 apply.
want_apply() {
  local flag="${1:-}"; shift || true
  forbid_orca_target "$@"
  for arg in "$@"; do
    if [ "$arg" = "$flag" ]; then return 0; fi
  done
  return 1
}

log()  { printf '[forge-deploy] %s\n' "$*"; }
warn() { printf '[forge-deploy][warn] %s\n' "$*" >&2; }

# Print KEY=[set|missing] lines for env names without ever printing values.
env_presence() {
  for name in "$@"; do
    if [ -n "${!name:-}" ]; then echo "$name=[set]"; else echo "$name=[missing]"; fi
  done
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || { warn "missing command: $1"; return 1; }
}
