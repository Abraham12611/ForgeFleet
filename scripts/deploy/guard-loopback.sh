#!/usr/bin/env bash
# Refuse a non-loopback bridge bind. Used as systemd ExecStartPre and by
# deploy-private.sh --apply. Reads BRIDGE_BIND (default 127.0.0.1:8787).
set -euo pipefail

bind="${BRIDGE_BIND:-127.0.0.1:8787}"
host="${bind%:*}"

case "$host" in
  127.0.0.1|::1|localhost|"")
    echo "bridge bind OK (loopback): ${bind%%:*}:****"
    ;;
  *)
    echo "refusing: BRIDGE_BIND host '$host' is not loopback" >&2
    exit 2
    ;;
esac
