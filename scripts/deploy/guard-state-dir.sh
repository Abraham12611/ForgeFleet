#!/usr/bin/env bash
# Refuse startup unless FORGEFLEET_BRIDGE_DATA_DIR is nonempty and exactly
# $STATE_DIRECTORY. Used as a systemd ExecStartPre (after the loopback and
# paperclip gates) and by deploy-private.sh --apply preflight.
#
# Why this exists: a copied bridge.env carries whatever assignments the
# example shipped, and an EnvironmentFile entry (even an empty
# FORGEFLEET_BRIDGE_DATA_DIR=) can shadow the unit's authoritative
# Environment=FORGEFLEET_BRIDGE_DATA_DIR=%S/forgefleet-bridge. The example
# no longer ships the field at all, and this guard fails closed on any live
# file that still sets it to anything but the exact StateDirectory.
set -euo pipefail

actual="${FORGEFLEET_BRIDGE_DATA_DIR:-}"
expected="${STATE_DIRECTORY:-}"

[ -n "$actual" ] \
  || { echo "refusing: FORGEFLEET_BRIDGE_DATA_DIR is empty or unset (unit must fix it to \$STATE_DIRECTORY)" >&2; exit 2; }
[ -n "$expected" ] \
  || { echo "refusing: STATE_DIRECTORY is empty or unset (unit must declare StateDirectory=forgefleet-bridge)" >&2; exit 2; }
[ "$actual" = "$expected" ] \
  || { echo "refusing: FORGEFLEET_BRIDGE_DATA_DIR does not equal STATE_DIRECTORY (env-file override)" >&2; exit 2; }
case "$actual" in
  /*) ;;
  *) echo "refusing: data dir '$actual' is not absolute (cwd-relative state is wrong under a daemon)" >&2; exit 2 ;;
esac
case "$actual" in
  /var/lib|/var/lib/*)
    echo "refusing: data dir under /var/lib is unwritable with ProtectSystem=strict" >&2; exit 2 ;;
esac
[ -d "$actual" ] \
  || { echo "refusing: data dir '$actual' does not exist (StateDirectory should have created it)" >&2; exit 2; }
[ -w "$actual" ] \
  || { echo "refusing: data dir '$actual' is not writable (SQLite WAL needs write)" >&2; exit 2; }
probe="$actual/.forge-write-probe.$$"
: > "$probe" 2>/dev/null \
  || { echo "refusing: data dir '$actual' failed a write probe" >&2; exit 2; }
rm -f "$probe"
echo "bridge state dir OK: \$STATE_DIRECTORY-backed and writable"
