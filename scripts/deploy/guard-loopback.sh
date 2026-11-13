#!/usr/bin/env bash
# Refuse a non-loopback bridge host. Used as systemd ExecStartPre and by
# deploy-private.sh --apply. Reads FORGEFLEET_BRIDGE_HOST + PORT
# (server contract, PR #63 main.ts). Defaults: 127.0.0.1:4387.
set -euo pipefail

host="${FORGEFLEET_BRIDGE_HOST:-127.0.0.1}"
port="${PORT:-4387}"

case "$host" in
  127.0.0.1|::1|localhost|"")
    echo "bridge bind OK (loopback): ${host}:****"
    ;;
  *)
    echo "refusing: FORGEFLEET_BRIDGE_HOST '$host' is not loopback" >&2
    exit 2
    ;;
esac
# Port is validated as numeric so a garbled PORT cannot silently rebind.
case "$port" in
  ''|*[!0-9]*) echo "refusing: PORT '$port' is not numeric" >&2; exit 2 ;;
esac
