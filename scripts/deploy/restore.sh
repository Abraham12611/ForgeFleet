#!/usr/bin/env bash
# Restore a backup snapshot into the private stack (FF-005), with FF-022
# manifest verification + fixture rehearsal mode.
# Default is dry-run. --apply requires BACKUP_SNAPSHOT=<dir> and
# RESTORE_FENCED=1: the operator confirms dispatch is held (no new attempts
# will be submitted) until post-restore reconciliation passes. The server
# ignores dispatch-pause env vars and reconciles leases on restart instead
# (PR #63 reconcileAfterRestart), so after any restore the bridge MUST be
# restarted and /v1/attempts verified before dispatch resumes.
# Restores pg.dump + context.tgz (required) and bridge-state.tgz when the
# snapshot carries it, into exactly the volumes/dirs backup.sh snapshots.
# When manifest.json is present its sha256 is verified before anything is
# restored. Reproducible fixture rehearsal:
#   restore.sh --manifest <manifest.json> --target-dir <dir>
# stages a byte-identical copy with leases fenced (no Docker, CI-safe).
# Reconcile Orca/GitHub state before re-enabling dispatch. Never touches orca-serve.
set -euo pipefail
# shellcheck disable=SC1091
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

MANIFEST=""; TARGET_DIR=""
while [ $# -gt 0 ]; do case "$1" in
  --manifest) MANIFEST="$2"; shift 2;;
  --target-dir) TARGET_DIR="$2"; shift 2;;
  *) break;;
esac; done

if want_apply --apply "$@"; then APPLY=1; else APPLY=0; fi

# --- Fixture rehearsal mode (no Docker, no fence override needed) ---
if [ -n "$MANIFEST" ]; then
  [ -n "$TARGET_DIR" ] || { warn "--manifest requires --target-dir DIR"; exit 2; }
  [ -f "$MANIFEST" ] || { warn "manifest not found: $MANIFEST"; exit 2; }
  src="$(dirname "$MANIFEST")"
  python3 - "$MANIFEST" "$src" <<'EOF'
import hashlib, json, sys
manifest = json.load(open(sys.argv[1]))
src = sys.argv[2]
for label, art in manifest["artifacts"].items():
    p = f"{src}/{art['path']}"
    got = hashlib.sha256(open(p, "rb").read()).hexdigest()
    assert got == art["sha256"], f"{label} sha256 MISMATCH (want {art['sha256']} got {got})"
print("manifest sha256 OK")
EOF
  rm -rf "$TARGET_DIR"; mkdir -p "$TARGET_DIR/context"
  cp "$src"/*.dump "$TARGET_DIR/" 2>/dev/null || true
  for tgz in "$src"/*.tgz; do
    [ -f "$tgz" ] || continue
    case "$(basename "$tgz")" in
      context.tgz) tar -xzf "$tgz" -C "$TARGET_DIR/context";;
      *) cp "$tgz" "$TARGET_DIR/";;
    esac
  done
  cat > "$TARGET_DIR/LEASES_FENCED.json" <<'EOF'
{"leases": "unknown", "reason": "restored snapshot must reconcile before dispatch", "dispatch_allowed": false}
EOF
  cp "$MANIFEST" "$TARGET_DIR/manifest.json"
  log "fixture restore PASS: $TARGET_DIR (leases fenced to unknown; dispatch stays paused)"
  exit 0
fi

# --- Live path (canonical FF-005, plus manifest verification) ---
snap="${BACKUP_SNAPSHOT:-}"

log "restore plan: snapshot ${snap:-<unset>} -> db + context-store (+ bridge state when present)"
[ -n "$snap" ] || { warn "set BACKUP_SNAPSHOT=<timestamped dir>"; exit 2; }
[ -f "$snap/pg.dump" ] && [ -f "$snap/context.tgz" ] \
  || { warn "snapshot incomplete (need pg.dump + context.tgz)"; exit 2; }

if [ "${RESTORE_FENCED:-0}" != "1" ]; then
  warn "refusing restore: set RESTORE_FENCED=1 (operator-held dispatch) first"
  exit 2
fi

if [ -f "$snap/manifest.json" ]; then
  python3 - "$snap/manifest.json" "$snap" <<'EOF'
import hashlib, json, sys
manifest = json.load(open(sys.argv[1]))
src = sys.argv[2]
for label, art in manifest["artifacts"].items():
    p = f"{src}/{art['path']}"
    got = hashlib.sha256(open(p, "rb").read()).hexdigest()
    assert got == art["sha256"], f"{label} sha256 MISMATCH"
print("manifest sha256 OK")
EOF
else
  warn "snapshot has no manifest.json (pre-FF-022 backup) — proceeding on file presence only"
fi

[ "$APPLY" = 1 ] || { log "dry-run complete: nothing restored"; exit 0; }

docker compose -f "$COMPOSE_FILE" exec -T db \
  psql -U "${POSTGRES_USER:?}" -d "${POSTGRES_DB:?}" < "$snap/pg.dump"
docker run --rm -v forge-private_context-store:/dst -v "$snap:/src:ro" \
  busybox tar -xzf /src/context.tgz -C /dst
restore_bridge_state "$snap" || true
log "restore applied: reconcile Orca/GitHub state, then re-enable dispatch manually"
