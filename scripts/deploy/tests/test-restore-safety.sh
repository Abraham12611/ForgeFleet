#!/usr/bin/env bash
# E17/E21 safe-restore gate fixture (PR #51 follow-up): proves restore.sh
# --manifest --target-dir confines writes to a FRESH leaf inside the
# allowlisted fixture root and NEVER deletes existing directories.
# Refusal cases: existing dir (P0 regression), home, repo, root, symlink
# leaf, symlink escape, cwd, relative path, outside-root path. Every refusal
# must exit non-zero AND leave sentinel files intact. No Docker, no VPS.
set -uo pipefail
D="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
. "$D/lib/common.sh"

pass=0; failed=0
ok()   { pass=$((pass+1)); echo "PASS: $1"; }
bad()  { failed=$((failed+1)); echo "FAIL: $1" >&2; }

WORK="$(mktemp -d /tmp/ff022-restore-safety-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

"$D/backup.sh" --fixture --out "$WORK/snaps" >/dev/null 2>&1 \
  || { bad "fixture snapshot setup failed"; echo "---"; echo "selftest: $pass passed, $failed failed"; exit 1; }
MANIFEST="$(ls "$WORK/snaps"/*/manifest.json | head -n1)"

# $1 = label; $2 = target; remaining = sentinel files that must survive.
expect_refusal() {
  label="$1"; target="$2"; shift 2
  if "$D/restore.sh" --manifest "$MANIFEST" --target-dir "$target" >/dev/null 2>&1; then
    bad "$label: restore accepted a forbidden target ($target)"
    return
  fi
  for s in "$@"; do
    [ -f "$s" ] || { bad "$label: sentinel lost: $s"; return; }
  done
  ok "$label refused, sentinels intact"
}

# 1. Happy path: fresh leaf under the disposable root restores, parent
# sentinel untouched.
echo "parent-precious" > "$WORK/parent-sentinel.txt"
"$D/restore.sh" --manifest "$MANIFEST" --target-dir "$WORK/r-happy" >/dev/null 2>&1 \
  && [ -f "$WORK/r-happy/LEASES_FENCED.json" ] \
  && [ -f "$WORK/parent-sentinel.txt" ] \
  && ok "fresh leaf restores, parent sentinel intact" \
  || bad "fresh leaf happy path failed"

# 2. P0 regression: an EXISTING dir is refused, never wiped.
mkdir -p "$WORK/victim"
echo "precious" > "$WORK/victim/sentinel.txt"
expect_refusal "existing dir" "$WORK/victim" "$WORK/victim/sentinel.txt"
[ -f "$WORK/r-happy/pg.dump" ] || bad "happy-path artifact missing after refusals"

# 3. Re-restore into the now-existing happy-path dir is refused too.
expect_refusal "re-restore into existing leaf" "$WORK/r-happy" \
  "$WORK/r-happy/LEASES_FENCED.json" "$WORK/parent-sentinel.txt"

# 4-7. Protected directories: home, repo, root, cwd.
expect_refusal "home" "$HOME/ff022-probe-should-not-exist"
expect_refusal "repo root" "$FF_ROOT/ff022-probe-should-not-exist"
expect_refusal "filesystem root child" "/ff022-probe-should-not-exist"
expect_refusal "cwd" "$PWD/ff022-probe-should-not-exist"

# 8. Symlink leaf pointing at a dir holding a sentinel: refused, sentinel
# survives, nothing written through the link.
mkdir -p "$WORK/outside"
echo "precious" > "$WORK/outside/sentinel.txt"
ln -s "$WORK/outside" "$WORK/link-leaf"
expect_refusal "symlink leaf" "$WORK/link-leaf" "$WORK/outside/sentinel.txt"

# 9. Symlink parent escaping the fixture root: refused.
ln -s / "$WORK/link-root"
expect_refusal "symlink-parent escape" "$WORK/link-root/tmp-ff022-probe" \
  "$WORK/parent-sentinel.txt"

# 10-11. Relative path and outside-root absolute path: refused.
expect_refusal "relative path" "relative/ff022-probe"
mkdir -p "$WORK/allowlisted"
OTHER="$(mktemp -d /tmp/ff022-other-XXXXXX)"
if FF_FIXTURE_ROOT="$WORK/allowlisted" \
    "$D/restore.sh" --manifest "$MANIFEST" --target-dir "$OTHER/r1" >/dev/null 2>&1; then
  bad "outside allowlisted root: restore escaped FF_FIXTURE_ROOT"
else
  [ -f "$WORK/parent-sentinel.txt" ] \
    && ok "outside allowlisted root refused, sentinels intact" \
    || bad "outside allowlisted root: sentinel lost"
fi
rm -rf "$OTHER"

# 12. Dangling symlink leaf: refused (no silent recreation through a link).
ln -s "$WORK/does-not-exist-target" "$WORK/dangling"
expect_refusal "dangling symlink leaf" "$WORK/dangling" "$WORK/parent-sentinel.txt"

# 13. Confinement proof: stage one fresh leaf and show the tree contains
# ONLY fresh restore outputs (byte-identical re-restore into a second leaf).
"$D/restore.sh" --manifest "$MANIFEST" --target-dir "$WORK/r-a" >/dev/null 2>&1 \
  && "$D/restore.sh" --manifest "$MANIFEST" --target-dir "$WORK/r-b" >/dev/null 2>&1 \
  && cmp "$WORK/r-a/pg.dump" "$WORK/r-b/pg.dump" >/dev/null 2>&1 \
  && diff -r "$WORK/r-a/context" "$WORK/r-b/context" >/dev/null 2>&1 \
  && ok "confined leaves are reproducible" \
  || bad "confined reproducibility failed"

echo "---"
echo "restore-safety: $pass passed, $failed failed (fixture-only)"
[ "$failed" -eq 0 ]
