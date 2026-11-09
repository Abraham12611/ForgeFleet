#!/usr/bin/env bash
# verify-restore: backup -> restore to throwaway -> byte-identical diff.
# Fixture-only: never needs Postgres or Vultr. This is the FF-022
# "reproducible restore" rehearsal until a live host rehearsal is approved.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/common.sh"
forbid_orca_target "$@"

WORK="$(mktemp -d /tmp/ff022-restore-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
log "workdir: $WORK"

"${SCRIPT_DIR}/backup.sh" --fixture --out "$WORK/snaps" >/dev/null
MANIFEST="$(ls "$WORK/snaps"/*/manifest.json | head -n1)"
[[ -n "$MANIFEST" ]] || die "no manifest produced"
log "snapshot: $MANIFEST"

"${SCRIPT_DIR}/restore.sh" --manifest "$MANIFEST" --target-dir "$WORK/r1" >/dev/null
"${SCRIPT_DIR}/restore.sh" --manifest "$MANIFEST" --target-dir "$WORK/r2" >/dev/null

diff -r "$WORK/r1/context" "$WORK/r2/context" >/dev/null || die "restore NOT reproducible (context differs)"
cmp "$WORK/r1/pg.dump" "$WORK/r2/pg.dump" >/dev/null || die "restore NOT reproducible (db differs)"
[[ -f "$WORK/r1/LEASES_FENCED.json" ]] || die "leases not fenced"
grep -q '"dispatch_allowed": false' "$WORK/r1/LEASES_FENCED.json" || die "dispatch not paused after restore"
log "restore is reproducible + leases fenced"
log "verify-restore PASS (fixture rehearsal)"
