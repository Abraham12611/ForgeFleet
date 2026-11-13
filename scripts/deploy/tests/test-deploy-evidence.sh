#!/usr/bin/env bash
# E17/E21 live-gate fixture (PR #51 follow-up): proves deploy-split --apply
# requires server-authenticated signed evidence (never a bare env flag or an
# editable-markdown row), and that live restore requires a SHA-verified
# manifest. Fail-closed on missing/forged/stale/expired proof. No Docker,
# no VPS, no live host changes (the only --apply invocation stops at the
# matrix OPEN gate AFTER passing the evidence gate).
set -uo pipefail
D="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
. "$D/lib/common.sh"

pass=0; failed=0
ok()   { pass=$((pass+1)); echo "PASS: $1"; }
bad()  { failed=$((failed+1)); echo "FAIL: $1" >&2; }

WORK="$(mktemp -d /tmp/ff022-live-evidence-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
MATRIX_SAVED="$WORK/matrix.saved.md"
cp "$FF_ROOT/infra/split-compatibility-matrix.md" "$MATRIX_SAVED"
trap 'cp "$MATRIX_SAVED" "$FF_ROOT/infra/split-compatibility-matrix.md"; rm -rf "$WORK"' EXIT

KEY="$WORK/key.bin"
python3 -c 'import os;open("'"$KEY"'","wb").write(os.urandom(32))'
chmod 600 "$KEY"
SHA="abc123def4567890abc123def4567890abc12345"

mint() { # $1=out, $2=extra sign-evidence args...
  out="$1"; shift
  "$D/sign-evidence.sh" --key "$KEY" --owner "test-owner" \
    --paperclip-sha "$SHA" "$@" --out "$out" >/dev/null 2>&1
}

# 1. Bare env flag without evidence: refused, and the refusal names evidence.
out="$WORK/t1.log"
if FORGEFLEET_LIVE_OK=1 "$D/deploy-split.sh" --apply >"$out" 2>&1; then
  bad "env-only live enable: --apply accepted without evidence"
elif grep -qi 'evidence' "$out"; then
  ok "env-only live enable refused (evidence required, FORGEFLEET_LIVE_OK insufficient)"
else
  bad "env-only live enable refused for the wrong reason"; cat "$out" >&2
fi

# 2. Missing evidence file: refused.
if "$D/deploy-split.sh" --apply --evidence "$WORK/nope.json" \
    --evidence-key "$KEY" >/dev/null 2>&1; then
  bad "missing evidence file accepted"
else
  ok "missing evidence file refused"
fi

mint "$WORK/good.json"
# 3. Unit-positive: a fresh proof verifies through the real verifier.
if ( . "$D/lib/common.sh"; verify_live_evidence "$WORK/good.json" "$KEY" ) \
    >/dev/null 2>&1; then
  ok "fresh signed evidence verifies"
else
  bad "fresh signed evidence rejected"
fi

# 4. End-to-end: --apply with good evidence passes the EVIDENCE gate and
# stops later at the matrix OPEN gate (S-01..S-07 are OPEN on purpose) —
# proving evidence (not env) is what the gate checks. No docker runs.
out="$WORK/t4.log"
if CADDY_IMAGE=x FORGEFLEET_LIVE_OK=1 "$D/deploy-split.sh" --apply \
    --evidence "$WORK/good.json" --evidence-key "$KEY" >"$out" 2>&1; then
  bad "apply unexpectedly proceeded past OPEN matrix gates"
elif grep -q 'still OPEN' "$out" && ! grep -qi 'evidence.*\(rejected\|invalid\|missing\|stale\|expired\)' "$out"; then
  ok "good evidence passes the evidence gate (stops at OPEN matrix, evidence unchallenged)"
else
  bad "good evidence did not pass the evidence gate"; cat "$out" >&2
fi

# 5. Forged proof (flipped signature hex): refused.
python3 - "$WORK/good.json" "$WORK/forged.json" <<'EOF'
import json,sys
doc=json.load(open(sys.argv[1])); doc["hmac_sha256"]="0"*64
json.dump(doc,open(sys.argv[2],"w"))
EOF
if ( . "$D/lib/common.sh"; verify_live_evidence "$WORK/forged.json" "$KEY" ) \
    >/dev/null 2>&1; then
  bad "forged evidence accepted"
else
  ok "forged evidence refused"
fi

# 6. Stale proof: editing the matrix after signing invalidates the evidence.
printf '\n<!-- probe -->\n' >> "$FF_ROOT/infra/split-compatibility-matrix.md"
if ( . "$D/lib/common.sh"; verify_live_evidence "$WORK/good.json" "$KEY" ) \
    >/dev/null 2>&1; then
  bad "stale evidence accepted after matrix edit"
else
  ok "stale evidence refused after matrix edit"
fi
cp "$MATRIX_SAVED" "$FF_ROOT/infra/split-compatibility-matrix.md"
mint "$WORK/good2.json"
if ( . "$D/lib/common.sh"; verify_live_evidence "$WORK/good2.json" "$KEY" ) \
    >/dev/null 2>&1; then
  ok "re-minted evidence verifies after matrix restore"
else
  bad "re-minted evidence rejected"
fi

# 7. Wrong contract: refused.
mint "$WORK/badcontract.json" --contract "9.9.9-nonce"
if ( . "$D/lib/common.sh"; verify_live_evidence "$WORK/badcontract.json" "$KEY" ) \
    >/dev/null 2>&1; then
  bad "wrong-contract evidence accepted"
else
  ok "wrong-contract evidence refused"
fi

# 8. Expired approval (TTL forced to zero): refused.
if ( . "$D/lib/common.sh"
     OWNER_APPROVAL_TTL_HOURS=0 verify_live_evidence "$WORK/good2.json" "$KEY" ) \
    >/dev/null 2>&1; then
  bad "expired approval accepted"
else
  ok "expired approval refused"
fi

# 9. Missing field (no owner): refused before signature math.
python3 - "$WORK/good2.json" "$WORK/noowner.json" <<'EOF'
import json,sys
doc=json.load(open(sys.argv[1])); del doc["owner"]
json.dump(doc,open(sys.argv[2],"w"))
EOF
if ( . "$D/lib/common.sh"; verify_live_evidence "$WORK/noowner.json" "$KEY" ) \
    >/dev/null 2>&1; then
  bad "owner-less evidence accepted"
else
  ok "owner-less evidence refused"
fi

# 10. Live restore without any manifest: refused even on dry-run (no docker).
SNAP="$WORK/snap-nomanifest"
mkdir -p "$SNAP"
echo "x" > "$SNAP/pg.dump"; echo "x" > "$SNAP/context.tgz"
if BACKUP_SNAPSHOT="$SNAP" RESTORE_FENCED=1 "$D/restore.sh" >/dev/null 2>&1; then
  bad "live restore without manifest accepted"
else
  ok "live restore without manifest refused"
fi

# 11. Live restore with a SHA-verified fixture manifest: passes the manifest
# gate on dry-run (proves mandatory-manifest accepts good proofs).
"$D/backup.sh" --fixture --out "$WORK/snaps" >/dev/null 2>&1
FIXSNAP="$(dirname "$(ls "$WORK/snaps"/*/manifest.json | head -n1)")"
if BACKUP_SNAPSHOT="$FIXSNAP" RESTORE_FENCED=1 "$D/restore.sh" >/dev/null 2>&1; then
  ok "live dry-run with SHA-verified manifest passes the manifest gate"
else
  bad "live dry-run with SHA-verified manifest refused"
fi

echo "---"
echo "deploy-evidence: $pass passed, $failed failed (fixture-only)"
[ "$failed" -eq 0 ]
