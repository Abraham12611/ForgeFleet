#!/usr/bin/env bash
# Roll back the private stack to the previous pinned revisions (FF-005).
# Default is dry-run. --apply requires PREV_PAPERCLIP_IMAGE and reverts the
# compose services (db, paperclip) only. The native bridge user unit is
# handled out of band by the operator (reload the unit file, restart the user
# service) — this script never issues service-manager verbs and never touches
# orca-serve.service, which is never reverted or restarted.
# Sequence: fence dispatch -> snapshot -> revert images -> restart stack ->
# healthcheck.
set -euo pipefail
# shellcheck disable=SC1091
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

if want_apply --apply "$@"; then APPLY=1; else APPLY=0; fi

log "rollback plan: fence dispatch, snapshot state, revert to previous pins"
[ -n "${PREV_PAPERCLIP_IMAGE:-}" ] || { warn "PREV_PAPERCLIP_IMAGE unset"; exit 2; }

steps=(
  "operator holds dispatch (no new attempts) until reconciliation passes"
  "backup.sh --apply snapshot of correlated state"
  "PAPERCLIP_IMAGE=$PREV_PAPERCLIP_IMAGE up -d db paperclip"
  "operator reloads the bridge user unit out of band (never from this script)"
  "bridge restarts and reconciles leases (server reconcileAfterRestart)"
  "healthcheck.sh must pass before re-enabling dispatch"
  "reconcile Orca/GitHub, verify /v1/attempts, then resume dispatch"
)
for s in "${steps[@]}"; do log "step: $s"; done

[ "$APPLY" = 1 ] || { log "dry-run complete: nothing reverted"; exit 0; }

"$FF_ROOT/scripts/deploy/backup.sh" --apply
PAPERCLIP_IMAGE="$PREV_PAPERCLIP_IMAGE" \
  docker compose -f "$COMPOSE_FILE" up -d db paperclip
"$FF_ROOT/scripts/deploy/healthcheck.sh"
log "rollback applied: dispatch stays fenced until reconciliation passes"
