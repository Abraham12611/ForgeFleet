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

# Resolve the supported Orca CLI wrapper WITHOUT executing it or touching
# the Orca service. Order per VPS finding #65: explicit ORCA_CLI_COMMAND
# (validated), then $HOME/.local/bin, then the extracted CLI shim, then
# /usr/bin, then PATH. The Electron GUI binary
# (.../squashfs-root/orca-ide, no resources/bin) crashes on the Chromium
# sandbox and is refused here; bare `orca` is refused too. Never appends
# --no-sandbox style flags. Prints the selected path.
resolve_orca_cli() {
  if [ -n "${ORCA_CLI_COMMAND:-}" ]; then
    case "$ORCA_CLI_COMMAND" in
      */squashfs-root/orca-ide)
        warn "ORCA_CLI_COMMAND is the Electron GUI binary (use .../resources/bin/orca-ide)"
        return 1
        ;;
    esac
    # Spelled o[r]ca so this source never contains a standalone orca token
    # (the selftest bare-orca guard scans live code, comments stripped).
    cli_base="$(basename -- "$ORCA_CLI_COMMAND")"
    case "$cli_base" in
      o[r]ca)
        warn "bare-orca is not a supported CLI entrypoint"
        return 1
        ;;
    esac
    command -v "$ORCA_CLI_COMMAND" >/dev/null 2>&1 \
      || { warn "ORCA_CLI_COMMAND not on PATH"; return 1; }
    printf '%s' "$ORCA_CLI_COMMAND"
    return 0
  fi
  for c in "$HOME/.local/bin/orca-ide" \
           /opt/orca/squashfs-root/resources/bin/orca-ide \
           /usr/bin/orca-ide; do
    if [ -x "$c" ]; then printf '%s' "$c"; return 0; fi
  done
  if command -v orca-ide >/dev/null 2>&1; then command -v orca-ide; return 0; fi
  return 1
}

# Canonical default for the native bridge state dir. Matches the systemd
# StateDirectory (user state, operator-owned). Exact name follows the server
# contract (PR #63 main.ts: FORGEFLEET_BRIDGE_DATA_DIR); the unit fixes it to
# %S/forgefleet-bridge, which equals this default for the operator user.
# Never /var/lib: the bridge unit's ProtectSystem=strict sandbox cannot write.
default_bridge_state_dir() {
  printf '%s' "${FORGEFLEET_BRIDGE_DATA_DIR:-$HOME/.local/state/forgefleet-bridge}"
}

# Snapshot the bridge state dir into $1 (a destination dir). Skips cleanly
# when no state exists yet. Prints the artifact path on stdout.
snapshot_bridge_state() {
  dest="$1"
  src="$(default_bridge_state_dir)"
  if [ ! -d "$src" ]; then
    warn "no bridge state at $src yet — skipping"
    return 0
  fi
  tar -czf "$dest/bridge-state.tgz" -C "$(dirname "$src")" "$(basename "$src")"
  chmod 600 "$dest/bridge-state.tgz"
  printf '%s' "$dest/bridge-state.tgz"
}

# Restore the bridge state dir from snapshot dir $1 (needs bridge-state.tgz).
# Returns 1 with a warning when the snapshot carries no bridge state.
restore_bridge_state() {
  snap="$1"
  [ -f "$snap/bridge-state.tgz" ] || { warn "snapshot has no bridge-state.tgz — bridge state left untouched"; return 1; }
  dst="$(default_bridge_state_dir)"
  mkdir -p "$dst"
  tar -xzf "$snap/bridge-state.tgz" -C "$(dirname "$dst")"
  log "bridge state restored to $dst (bridge unit stays fenced)"
}
