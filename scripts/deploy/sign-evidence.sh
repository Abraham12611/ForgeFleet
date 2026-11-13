#!/usr/bin/env bash
# Mint server-authenticated signed live evidence for deploy-split --apply
# (E17/E21, PR #51 follow-up). OPERATOR/SERVER-SIDE tool: run it where the
# release authority holds the evidence key, never inside an agent worker.
# The key file holds raw shared-secret bytes; it is read, never printed.
# Output JSON carries the exact paperclip SHA + API contract authorized, the
# sha256 of the CURRENT split-compatibility-matrix.md (any later markdown
# edit invalidates the proof), a fresh owner approval timestamp, and an
# HMAC-SHA256 signature verified by verify_live_evidence on --apply.
# Usage:
#   sign-evidence.sh --key KEYFILE --owner NAME --paperclip-sha SHA
#     [--contract V] [--matrix FILE] [--statement TEXT] [--ttl-note] --out FILE
set -euo pipefail
# shellcheck disable=SC1091
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

KEY=""; OWNER=""; SHA=""; CONTRACT="${API_CONTRACT_VERSION:-0.1.0-draft}"
MATRIX="$FF_ROOT/infra/split-compatibility-matrix.md"
STATEMENT="deploy-split live apply"; OUT=""
args=("$@")
for ((i=0; i<${#args[@]}; i++)); do case "${args[$i]}" in
  --key) KEY="${args[$((i+1))]:-}";;
  --owner) OWNER="${args[$((i+1))]:-}";;
  --paperclip-sha) SHA="${args[$((i+1))]:-}";;
  --contract) CONTRACT="${args[$((i+1))]:-}";;
  --matrix) MATRIX="${args[$((i+1))]:-}";;
  --statement) STATEMENT="${args[$((i+1))]:-}";;
  --out) OUT="${args[$((i+1))]:-}";;
esac; done
forbid_orca_target "$@"

[ -n "$KEY" ] && [ -f "$KEY" ] || { warn "--key KEYFILE (existing secret file) is required"; exit 2; }
[ -n "$OWNER" ] || { warn "--owner NAME (explicit owner approver) is required"; exit 2; }
[ -n "$SHA" ] || { warn "--paperclip-sha SHA (pinned, never 'unknown') is required"; exit 2; }
[ "$SHA" != "unknown" ] || { warn "refusing to sign evidence for unpinned sha 'unknown'"; exit 2; }
[ -f "$MATRIX" ] || { warn "--matrix file not found: $MATRIX"; exit 2; }
[ -n "$OUT" ] || { warn "--out FILE is required"; exit 2; }
case "$OUT" in
  *.json) ;;
  *) warn "--out must be a .json file"; exit 2;;
esac

python3 - "$KEY" "$OWNER" "$SHA" "$CONTRACT" "$MATRIX" "$STATEMENT" "$OUT" <<'EOF'
import hashlib, hmac, json, sys
from datetime import datetime, timezone
keyfile, owner, sha, contract, matrix, statement, out = sys.argv[1:8]
matrix_sha = hashlib.sha256(open(matrix, "rb").read()).hexdigest()
approved = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
payload = "|".join((sha, contract, matrix_sha, owner, approved, statement))
key = open(keyfile, "rb").read()
sig = hmac.new(key, payload.encode(), hashlib.sha256).hexdigest()
doc = {"paperclip_git_sha": sha, "api_contract_version": contract,
       "matrix_sha256": matrix_sha, "owner": owner,
       "approved_at_utc": approved, "statement": statement,
       "hmac_sha256": sig}
with open(out, "w") as f:
    json.dump(doc, f, indent=2)
    f.write("\n")
print(f"signed live evidence: sha={sha[:12]} contract={contract} owner={owner} matrix={matrix_sha[:12]}")
EOF
chmod 600 "$OUT"
log "evidence minted: $OUT (approval fresh for ${OWNER_APPROVAL_TTL_HOURS:-24}h)"
