#!/usr/bin/env bash
# Restore a backup snapshot into the private stack (FF-005).
# Default is dry-run. --apply requires BACKUP_SNAPSHOT=<dir> and refuses
# unless BRIDGE_NO_NEW_DISPATCH=1 (leases must never resume as runnable).
# Reconcile Orca/GitHub state before re-enabling dispatch. Never touches orca-serve.
set -euo pipefail
# shellcheck disable=SC1091
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

if want_apply --apply "$@"; then APPLY=1; else APPLY=0; fi
snap="${BACKUP_SNAPSHOT:-}"

log "restore plan: snapshot ${snap:-<unset>} -> db + context-store"
[ -n "$snap" ] || { warn "set BACKUP_SNAPSHOT=<timestamped dir>"; exit 2; }
[ -f "$snap/pg.dump" ] && [ -f "$snap/context.tgz" ] \
  || { warn "snapshot incomplete (need pg.dump + context.tgz)"; exit 2; }

if [ "${BRIDGE_NO_NEW_DISPATCH:-0}" != "1" ]; then
  warn "refusing restore: set BRIDGE_NO_NEW_DISPATCH=1 first (fence leases)"
  exit 2
fi

[ "$APPLY" = 1 ] || { log "dry-run complete: nothing restored"; exit 0; }

docker compose -f "$COMPOSE_FILE" exec -T db \
  psql -U "${POSTGRES_USER:?}" -d "${POSTGRES_DB:?}" < "$snap/pg.dump"
docker run --rm -v forge-private_context-store:/dst -v "$snap:/src:ro" \
  busybox tar -xzf /src/context.tgz -C /dst
log "restore applied: reconcile Orca/GitHub state, then re-enable dispatch manually"
