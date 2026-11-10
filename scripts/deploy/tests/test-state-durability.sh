#!/usr/bin/env bash
# Disposable unprivileged proof: the native bridge state dir is writable,
# snapshottable, and restorable — without Docker, secrets, or any VPS.
# Uses only throwaway temp dirs under $TMPDIR; never touches operator state.
# Refuses to run as root: the proof is only meaningful unprivileged.
# Fixture-only; this does not demonstrate VPS/systemd behavior.
set -euo pipefail
# shellcheck disable=SC1091
. "$(cd "$(dirname "$0")/../" && pwd)/lib/common.sh"

if [ "$(id -u)" = "0" ]; then
  echo "SKIP: run unprivileged (this fixture proves unprivileged read/write)" >&2
  exit 2
fi
log "proving as uid $(id -u) ($(id -un)) — disposable dirs only"

work="$(mktemp -d "${TMPDIR:-/tmp}/forge-state-proof.XXXXXX")"
trap 'rm -rf "$work"' EXIT
export HOME="$work/home"
mkdir -p "$HOME"
unset FORGEFLEET_BRIDGE_DATA_DIR

# 1. Resolve the canonical default and prove it is creatable + writable.
state_dir="$(default_bridge_state_dir)"
[ "$state_dir" = "$HOME/.local/state/forgefleet-bridge" ] \
  || { warn "default drifted: $state_dir"; exit 1; }
mkdir -p -m 700 "$state_dir"
[ -w "$state_dir" ] || { warn "state dir not writable"; exit 1; }
[ "$(stat -c %a "$state_dir" 2>/dev/null || stat -f %Lp "$state_dir")" = "700" ] \
  || { warn "state dir not mode 700"; exit 1; }
log "state dir writable at $state_dir (mode 700, uid $(id -u))"

# 2. Write durable data: SQLite WAL roundtrip when sqlite3 exists, else files.
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$state_dir/bridge.db" "PRAGMA journal_mode=WAL; CREATE TABLE t(v TEXT); INSERT INTO t VALUES('proof-row');" >/dev/null
  [ "$(sqlite3 "$state_dir/bridge.db" "SELECT count(*) FROM t;")" = "1" ] \
    || { warn "sqlite write/read failed"; exit 1; }
  log "sqlite WAL write/read OK"
  want_wal=1
else
  printf 'proof-row' > "$state_dir/sentinel"
  want_wal=0
  log "sqlite3 absent — file roundtrip instead (VPS re-proves WAL)"
fi
before_sum="$(find "$state_dir" -type f -exec sh -c 'sha256sum "$@" 2>/dev/null || shasum -a 256 "$@"' _ {} + | sort | sha256sum 2>/dev/null || find "$state_dir" -type f -exec sh -c 'shasum -a 256 "$@"' _ {} + | sort | md5)"

# 3. Snapshot via the same helper backup.sh uses; artifact must be mode 600.
mkdir -p -m 700 "$work/snap"
[ -n "$(snapshot_bridge_state "$work/snap")" ] || { warn "snapshot produced nothing"; exit 1; }
[ "$(stat -c %a "$work/snap/bridge-state.tgz" 2>/dev/null || stat -f %Lp "$work/snap/bridge-state.tgz")" = "600" ] \
  || { warn "snapshot not mode 600"; exit 1; }
log "snapshot OK (mode 600)"

# 4. Destroy, restore via the same helper restore.sh uses, verify identical.
rm -rf "$state_dir"
restore_bridge_state "$work/snap"
if [ "$want_wal" = "1" ]; then
  [ "$(sqlite3 "$state_dir/bridge.db" "SELECT count(*) FROM t;")" = "1" ] \
    || { warn "restored sqlite unreadable"; exit 1; }
  log "restored sqlite WAL read OK"
else
  [ "$(cat "$state_dir/sentinel")" = "proof-row" ] \
    || { warn "restored sentinel mismatch"; exit 1; }
fi
after_sum="$(find "$state_dir" -type f -exec sh -c 'sha256sum "$@" 2>/dev/null || shasum -a 256 "$@"' _ {} + | sort | sha256sum 2>/dev/null || find "$state_dir" -type f -exec sh -c 'shasum -a 256 "$@"' _ {} + | sort | md5)"
[ "$before_sum" = "$after_sum" ] || { warn "restored content differs"; exit 1; }

log "STATE-DURABILITY-PROOF OK (uid $(id -u), disposable dirs, cleaned up)"
