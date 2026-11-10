#!/usr/bin/env bash
# Executable proof for the bridge server contract (PR #63 shape, FF-005 scope).
# Spins a disposable loopback stub that mirrors the actual server's exact
# surface — `GET /v1/health/live` unauthenticated 200 {ok, contractVersion},
# Bearer token on every other route (401 otherwise), 404 on unknown paths —
# then drives the REAL scripts/deploy/healthcheck.sh bridge probe against it
# and asserts the auth positive/negative cases. No systemd, Docker, secrets,
# or VPS. Requires node (server runtime floor is >=24); skips when absent.
set -euo pipefail
# shellcheck disable=SC1091
. "$(cd "$(dirname "$0")/../" && pwd)/lib/common.sh"

need_cmd node >/dev/null 2>&1 || { echo "SKIP: node unavailable (server runtime floor is >=24)" >&2; exit 0; }

work="$(mktemp -d "${TMPDIR:-/tmp}/forge-contract-proof.XXXXXX")"
cleanup() { kill "$stub_pid" 2>/dev/null || true; wait "$stub_pid" 2>/dev/null || true; rm -rf "$work"; }
trap cleanup EXIT
export FORGEFLEET_BRIDGE_TOKEN="synthetic-fixture-token"

# Faithful stub of the #63 contract surface (server.ts handle() shape).
cat > "$work/stub.mjs" <<'EOF'
import { createServer } from "node:http";
const token = process.env.FORGEFLEET_BRIDGE_TOKEN ?? "";
const server = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  const json = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && path === "/v1/health/live") {
    json(200, { ok: true, contractVersion: "0.1.0" });
    return;
  }
  if (req.headers.authorization !== `Bearer ${token}`) {
    json(401, { error: { code: 401, message: "unauthorized" } });
    return;
  }
  if (req.method === "GET" && path === "/v1/runtime/sessions") {
    json(200, { sessions: [] });
    return;
  }
  json(404, { error: { code: 404, message: "not_found" } });
});
server.listen(0, "127.0.0.1", () => {
  const a = server.address();
  if (a && typeof a === "object") console.log(`PORT=${a.port}`);
});
EOF

node "$work/stub.mjs" > "$work/port" 2>"$work/err" &
stub_pid=$!
sleep 1
port="$(grep -oE '[0-9]+' "$work/port" 2>/dev/null | head -n 1)"
[ -n "${port:-}" ] || { warn "stub failed to bind: $(cat "$work/err")"; exit 1; }
base="http://127.0.0.1:$port"
log "contract stub on $base (pid $stub_pid, disposable)"

probe() { # $1 label, $2 path, $3 token-or-empty, $4 want-code, $5 want-substring
  out="$(node -e "
const [url, tok] = process.argv.slice(1);
const headers = tok ? { Authorization: 'Bearer ' + tok } : {};
fetch(url, { headers }).then(async (r) => {
  const body = await r.text();
  console.log(r.status + ' ' + body);
}).catch((e) => { console.error('FETCHFAIL ' + e.message); process.exit(2); });
" "$base$2" "${3:-}" 2>/dev/null)" || { warn "proof-FAIL: $1 (fetch failed)"; return 1; }
  code="${out%% *}"
  if [ "$code" = "$4" ] && printf '%s' "$out" | grep -qF "$5"; then
    log "proof-ok: $1"
  else
    warn "proof-FAIL: $1 (got: $out)"
    return 1
  fi
}

fail=0
probe "unauthenticated /v1/health/live 200 {ok, contractVersion}" \
  "/v1/health/live" "" "200" '"ok":true' || fail=1
probe "contractVersion advertised" \
  "/v1/health/live" "" "200" 'contractVersion' || fail=1
probe "guarded route without token -> 401" \
  "/v1/runtime/sessions" "" "401" 'unauthorized' || fail=1
probe "guarded route with wrong token -> 401" \
  "/v1/runtime/sessions" "wrong" "401" 'unauthorized' || fail=1
probe "guarded route with fixture token -> 200" \
  "/v1/runtime/sessions" "$FORGEFLEET_BRIDGE_TOKEN" "200" 'sessions' || fail=1
probe "unknown path with token -> 404" \
  "/nope" "$FORGEFLEET_BRIDGE_TOKEN" "404" 'not_found' || fail=1
[ "$fail" -eq 0 ] || exit 1

# The REAL healthcheck.sh bridge probe passes against the contract shape.
# (Paperclip vars point at the same stub: its probe only needs 'ok'.)
FORGEFLEET_BRIDGE_HOST=127.0.0.1 PORT="$port" BRIDGE_HEALTH_PATH=/v1/health/live \
  PAPERCLIP_PORT="$port" PAPERCLIP_HEALTH_PATH=/v1/health/live \
  bash "$(cd "$(dirname "$0")/../" && pwd)/healthcheck.sh" >/dev/null 2>&1 \
  && log "proof-ok: healthcheck.sh bridge probe passes on contract shape" \
  || { warn "proof-FAIL: healthcheck.sh bridge probe failed on contract shape"; exit 1; }

log "CONTRACT-PROOF OK (disposable stub, cleaned up)"
