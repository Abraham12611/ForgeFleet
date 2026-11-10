#!/usr/bin/env bash
# Restore a backup snapshot into the private stack (FF-005).
# Default is dry-run. --apply requires BACKUP_SNAPSHOT=<dir> and
# RESTORE_FENCED=1: the operator confirms dispatch is held (no new attempts
# will be submitted) until post-restore reconciliation passes. The server
# ignores dispatch-pause env vars and reconciles leases on restart instead
# (PR #63 reconcileAfterRestart), so after any restore the bridge MUST be
# restarted and /v1/attempts verified before dispatch resumes.
# Restores pg.dump + context.tgz (required) and bridge-state.tgz when the
# snapshot carries it, into exactly the volumes/dirs backup.sh snapshots.
# Reconcile Orca/GitHub state before re-enabling dispatch. Never touches orca-serve.
set -euo pipefail
# shellcheck disable=SC1091
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

if want_apply --apply "$@"; then APPLY=1; else APPLY=0; fi
snap="${BACKUP_SNAPSHOT:-}"

log "restore plan: snapshot ${snap:-<unset>} -> db + context-store (+ bridge state when present)"
[ -n "$snap" ] || { warn "set BACKUP_SNAPSHOT=<timestamped dir>"; exit 2; }
[ -f "$snap/pg.dump" ] && [ -f "$snap/context.tgz" ] \
  || { warn "snapshot incomplete (need pg.dump + context.tgz)"; exit 2; }

if [ "${RESTORE_FENCED:-0}" != "1" ]; then
  warn "refusing restore: set RESTORE_FENCED=1 (operator-held dispatch) first"
  exit 2
fi

[ "$APPLY" = 1 ] || { log "dry-run complete: nothing restored"; exit 0; }

docker compose -f "$COMPOSE_FILE" exec -T db \
  psql -U "${POSTGRES_USER:?}" -d "${POSTGRES_DB:?}" < "$snap/pg.dump"
docker run --rm -v forge-private_context-store:/dst -v "$snap:/src:ro" \
  busybox tar -xzf /src/context.tgz -C /dst
restore_bridge_state "$snap" || true
log "restore applied: reconcile Orca/GitHub state, then re-enable dispatch manually"
