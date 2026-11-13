#!/usr/bin/env bash
# Snapshot the private stack's durable state (FF-005).
# Default is dry-run. --apply writes to BACKUP_DIR with timestamped files.
# Contents mirror exactly the volumes compose defines plus the native bridge
# state dir: pg_dump (db service) + context-store volume + bridge host state.
# Never prints secrets; never touches orca-serve.service.
set -euo pipefail
# shellcheck disable=SC1091
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

if want_apply --apply "$@"; then APPLY=1; else APPLY=0; fi
BACKUP_DIR="${BACKUP_DIR:-/var/backups/forgefleet}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"

log "backup plan: pg_dump (db service) + context-store volume + bridge state dir -> $BACKUP_DIR/$stamp"
[ "$APPLY" = 1 ] || { log "dry-run complete: nothing written"; exit 0; }

mkdir -p "$BACKUP_DIR/$stamp"
chmod 700 "$BACKUP_DIR/$stamp"
docker compose -f "$COMPOSE_FILE" exec -T db \
  pg_dump -U "${POSTGRES_USER:?set POSTGRES_USER}" "${POSTGRES_DB:?set POSTGRES_DB}" \
  > "$BACKUP_DIR/$stamp/pg.dump"
chmod 600 "$BACKUP_DIR/$stamp/pg.dump"
docker run --rm -v forge-private_context-store:/src:ro -v "$BACKUP_DIR/$stamp:/dst" \
  busybox tar -czf "/dst/context.tgz" -C /src .
chmod 600 "$BACKUP_DIR/$stamp/context.tgz"
snapshot_bridge_state "$BACKUP_DIR/$stamp" >/dev/null
ls -l "$BACKUP_DIR/$stamp"
log "backup applied: $stamp (restore rehearsal: restore.sh --apply in staging first)"
