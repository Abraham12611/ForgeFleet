#!/usr/bin/env bash
# Snapshot the private stack's durable state (FF-005), with FF-022
# reproducibility manifest + fixture rehearsal mode.
# Default is dry-run. --apply writes to BACKUP_DIR with timestamped files.
# --fixture --out DIR writes a deterministic fixture snapshot (no Docker,
# no secrets, CI-safe) for restore rehearsals.
# Contents mirror exactly the volumes compose defines plus the native bridge
# state dir: pg_dump (db service) + context-store volume + bridge host state.
# Every snapshot carries manifest.json with sha256 per artifact, so restores
# are verifiably reproducible. Never prints secrets; never touches orca-serve.service.
set -euo pipefail
# shellcheck disable=SC1091
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

FIXTURE=0; OUT=""
while [ $# -gt 0 ]; do case "$1" in
  --fixture) FIXTURE=1; shift;;
  --out) OUT="$2"; shift 2;;
  *) break;;
esac; done

if want_apply --apply "$@"; then APPLY=1; else APPLY=0; fi
BACKUP_DIR="${BACKUP_DIR:-/var/backups/forgefleet}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"

sha() { shasum -a 256 "$1" | awk '{print $1}'; }

write_manifest() { # $1 = dest dir, $2 = true|false fixture
  dest="$1"; fixture="$2"
  {
    echo "{"
    echo "  \"ff_version\": \"v1.0/FF-022\","
    echo "  \"created_utc\": \"$stamp\","
    echo "  \"fixture\": $fixture,"
    echo "  \"api_contract_version\": \"${API_CONTRACT_VERSION:-0.1.0-draft}\","
    echo "  \"paperclip_git_sha\": \"${PAPERCLIP_GIT_SHA:-unknown}\","
    echo "  \"bridge_git_sha\": \"${BRIDGE_GIT_SHA:-unknown}\","
    echo "  \"artifacts\": {"
    first=1
    for f in "$dest"/*.dump "$dest"/*.tgz; do
      [ -f "$f" ] || continue
      [ "$first" -eq 1 ] || echo ","
      first=0
      printf '    "%s": {"path": "%s", "sha256": "%s"}' \
        "$(basename "$f")" "$(basename "$f")" "$(sha "$f")"
    done
    echo ""
    echo "  }"
    echo "}"
  } > "$dest/manifest.json"
}

if [ "$FIXTURE" = 1 ]; then
  [ -n "$OUT" ] || { warn "--fixture requires --out DIR"; exit 2; }
  mkdir -p "$OUT/$stamp/fixture-context"
  printf 'hello forgefleet\n' > "$OUT/$stamp/fixture-context/doc.txt"
  printf '[]\n' > "$OUT/$stamp/pg.dump"
  (cd "$OUT/$stamp" && tar -czf context.tgz fixture-context)
  write_manifest "$OUT/$stamp" true
  log "fixture snapshot: $OUT/$stamp/manifest.json (no Docker, no host data)"
  exit 0
fi

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
write_manifest "$BACKUP_DIR/$stamp" false
chmod 600 "$BACKUP_DIR/$stamp/manifest.json"
ls -l "$BACKUP_DIR/$stamp"
log "backup applied: $stamp (restore rehearsal: restore.sh --apply in staging first)"
