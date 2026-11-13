#!/usr/bin/env bash
# Disposable proof for the bridge state-dir startup guard (FF-005 systemd
# precedence fix). Uses only throwaway temp dirs; never touches operator
# state, services, or the live env file. Refuses to run as root: the
# unprivileged WAL proof is only meaningful unprivileged.
# Proves: exact STATE_DIRECTORY match passes with a writable SQLite WAL
# roundtrip; empty, mismatched, relative, /var/lib, missing, and
# unwritable values are all refused.
set -euo pipefail
# shellcheck disable=SC1091
. "$(cd "$(dirname "$0")/../" && pwd)/lib/common.sh"

GUARD="$(cd "$(dirname "$0")/../" && pwd)/guard-state-dir.sh"

if [ "$(id -u)" = "0" ]; then
  echo "SKIP: run unprivileged (this fixture proves unprivileged read/write)" >&2
  exit 2
fi
[ -x "$GUARD" ] || { warn "guard-state-dir.sh missing or not executable"; exit 1; }
log "proving as uid $(id -u) ($(id -un)) — disposable dirs only"

work="$(mktemp -d "${TMPDIR:-/tmp}/forge-statedir-proof.XXXXXX")"
trap 'rm -rf "$work"' EXIT

pass=0; failed=0
ok()   { pass=$((pass+1)); echo "proof-ok: $1"; }
bad()  { failed=$((failed+1)); echo "proof-FAIL: $1" >&2; }

# (a) Exact match on a writable dir passes (the systemd steady state:
# StateDirectory created the dir and exports it as $STATE_DIRECTORY).
mkdir -p -m 700 "$work/state"
if STATE_DIRECTORY="$work/state" FORGEFLEET_BRIDGE_DATA_DIR="$work/state" "$GUARD" >/dev/null 2>&1; then
  ok "exact STATE_DIRECTORY match accepted"
else
  bad "exact STATE_DIRECTORY match refused"
fi

# (b) Empty value refused (the reported bug: copied .env.example shipped
# FORGEFLEET_BRIDGE_DATA_DIR= and the EnvironmentFile shadowed the unit).
if STATE_DIRECTORY="$work/state" FORGEFLEET_BRIDGE_DATA_DIR="" "$GUARD" >/dev/null 2>&1; then
  bad "empty FORGEFLEET_BRIDGE_DATA_DIR accepted"
else
  ok "empty FORGEFLEET_BRIDGE_DATA_DIR refused"
fi

# (c) Unset value refused.
if STATE_DIRECTORY="$work/state" env -u FORGEFLEET_BRIDGE_DATA_DIR "$GUARD" >/dev/null 2>&1; then
  bad "unset FORGEFLEET_BRIDGE_DATA_DIR accepted"
else
  ok "unset FORGEFLEET_BRIDGE_DATA_DIR refused"
fi

# (d) Mismatched value refused (env-file override attempt).
mkdir -p -m 700 "$work/other"
if STATE_DIRECTORY="$work/state" FORGEFLEET_BRIDGE_DATA_DIR="$work/other" "$GUARD" >/dev/null 2>&1; then
  bad "mismatched data dir accepted"
else
  ok "mismatched data dir refused"
fi

# (e) Cwd-relative fallback refused even when both sides agree (the server's
# ./bridge-data default is wrong under a daemon; STATE_DIRECTORY is absolute).
if STATE_DIRECTORY="bridge-data" FORGEFLEET_BRIDGE_DATA_DIR="bridge-data" "$GUARD" >/dev/null 2>&1; then
  bad "relative data dir accepted"
else
  ok "relative data dir refused"
fi

# (f) /var/lib fallback refused (unwritable under ProtectSystem=strict).
if STATE_DIRECTORY="/var/lib/forgefleet/bridge" FORGEFLEET_BRIDGE_DATA_DIR="/var/lib/forgefleet/bridge" "$GUARD" >/dev/null 2>&1; then
  bad "/var/lib data dir accepted"
else
  ok "/var/lib data dir refused"
fi

# (g) Missing directory refused (StateDirectory should have created it).
if STATE_DIRECTORY="$work/no-such-dir" FORGEFLEET_BRIDGE_DATA_DIR="$work/no-such-dir" "$GUARD" >/dev/null 2>&1; then
  bad "missing data dir accepted"
else
  ok "missing data dir refused"
fi

# (h) Unwritable directory refused (mode 500: no WAL without write).
mkdir -p -m 500 "$work/readonly"
if STATE_DIRECTORY="$work/readonly" FORGEFLEET_BRIDGE_DATA_DIR="$work/readonly" "$GUARD" >/dev/null 2>&1; then
  bad "unwritable data dir accepted"
else
  ok "unwritable data dir refused"
fi
chmod 700 "$work/readonly"

# (i) SQLite WAL write/read roundtrip, unprivileged, in the exact state dir.
if command -v python3 >/dev/null 2>&1; then
  if STATE_DIRECTORY="$work/state" FORGEFLEET_BRIDGE_DATA_DIR="$work/state" \
      python3 - "$work/state/proof.db" <<'EOF' >/dev/null 2>&1; then
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.execute("PRAGMA journal_mode=WAL;")
db.execute("CREATE TABLE t(v TEXT);")
db.execute("INSERT INTO t VALUES('proof-row');")
db.commit()
assert db.execute("SELECT count(*) FROM t;").fetchone()[0] == 1
db.close()
EOF
    [ -f "$work/state/proof.db" ] && ok "sqlite WAL write/read OK (unprivileged)" || bad "sqlite WAL artifact missing"
  else
    bad "sqlite WAL roundtrip failed"
  fi
elif command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$work/state/proof.db" "PRAGMA journal_mode=WAL; CREATE TABLE t(v TEXT); INSERT INTO t VALUES('proof-row');" >/dev/null
  [ "$(sqlite3 "$work/state/proof.db" "SELECT count(*) FROM t;")" = "1" ] \
    && ok "sqlite WAL write/read OK (unprivileged)" || bad "sqlite WAL roundtrip failed"
else
  printf 'proof-row' > "$work/state/sentinel"
  [ "$(cat "$work/state/sentinel")" = "proof-row" ] \
    && ok "file roundtrip OK (no sqlite stack; VPS re-proves WAL)" || bad "file roundtrip failed"
fi

echo "---"
echo "state-dir proof: $pass passed, $failed failed (disposable dirs, cleaned up)"
[ "$failed" -eq 0 ]
