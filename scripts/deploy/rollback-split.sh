#!/usr/bin/env bash
# Split-phase rollback (FF-022): compatible frontend and/or backend rollback.
# Default is dry-run plan. --apply executes the backend via rollback-private.sh
# and prints the owner-gated frontend steps (Vercel promotion is NEVER
# automated here — it needs explicit owner action in Vercel).
# Refuses a frontend-only rollback across an API contract break unless the
# backend rolls back together. Never touches orca-serve.service.
set -euo pipefail
# shellcheck disable=SC1091
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

COMPONENT="all"; TARGET=""; APPLY=0; CHECK=0
for a in "$@"; do case "$a" in --apply) APPLY=1;; --check) CHECK=1;; esac; done
args=("$@")
for ((i=0; i<${#args[@]}; i++)); do case "${args[$i]}" in
  --target) TARGET="${args[$((i+1))]:-}";;
  --component) COMPONENT="${args[$((i+1))]:-}";;
esac; done
forbid_orca_target "$@"
[ -n "$TARGET" ] || { warn "--target <git-sha|manifest.json> is required"; exit 2; }
case "$COMPONENT" in frontend|backend|all) ;; *) warn "--component must be frontend|backend|all"; exit 2;; esac

ACTIVE_CONTRACT="${API_CONTRACT_VERSION:-0.1.0-draft}"
TARGET_CONTRACT="$ACTIVE_CONTRACT"
if [ -f "$TARGET" ]; then
  TARGET_CONTRACT="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('api_contract_version','$ACTIVE_CONTRACT'))" "$TARGET")"
fi
log "active contract: $ACTIVE_CONTRACT; target contract: $TARGET_CONTRACT; component: $COMPONENT"

if [ "$COMPONENT" = "frontend" ] && [ "$TARGET_CONTRACT" != "$ACTIVE_CONTRACT" ]; then
  warn "refusing frontend-only rollback across contract $ACTIVE_CONTRACT -> $TARGET_CONTRACT; use --component all"
  exit 2
fi
if [ "$COMPONENT" != "frontend" ] && [ -f "$TARGET" ]; then
  log "backend rollback restores from tested manifest: $TARGET (verify with verify-restore.sh first)"
fi
[ "$APPLY" = 1 ] && [ "$CHECK" = 1 ] \
  && { warn "--check and --apply are exclusive"; exit 2; }

log "rollback plan compatible (no changes made)"
[ "$APPLY" = 0 ] && { [ "$CHECK" = 1 ] || log "dry-run: pass --apply to execute backend steps"; exit 0; }

confirm_live
[ "${RESTORE_FENCED:-0}" = "1" ] \
  || { warn "set RESTORE_FENCED=1 before --apply (operator-held dispatch first)"; exit 2; }
if [ "$COMPONENT" != "frontend" ]; then
  if [ -f "$TARGET" ]; then
    BACKUP_SNAPSHOT="$(dirname "$TARGET")" "$FF_ROOT/scripts/deploy/restore.sh" --apply
  else
    PREV_PAPERCLIP_IMAGE="$TARGET" "$FF_ROOT/scripts/deploy/rollback-private.sh" --apply
  fi
fi
if [ "$COMPONENT" != "backend" ]; then
  log "frontend: promote the previous Vercel deployment ONLY in Vercel (owner action);"
  log "frontend: then run verify-split.sh --live --api <url> --web <url> before resuming dispatch."
fi
log "rollback APPLY complete for $COMPONENT -> $TARGET. Reconcile, then re-enable dispatch manually."
